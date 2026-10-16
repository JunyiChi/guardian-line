import { v1p1beta1 } from '@google-cloud/speech';
import { bus, Speaker } from '../events';
import { config } from '../config';
import { settings } from '../settings';
import { log, shortSid } from '../privacy/log';

type SpeechClient = v1p1beta1.SpeechClient;

/** Google cuts streaming sessions at ~305s; restart comfortably before that. */
const STREAM_LIMIT_MS = 280_000;
/** mu-law 8kHz = 1 byte per sample = 8 bytes per ms. */
const BYTES_PER_MS = 8;
/** Never replay more than this much unfinalized audio into a new stream (memory only). */
const MAX_PENDING_BYTES = 30_000 * BYTES_PER_MS;
const MAX_RETRY_DELAY_MS = 10_000;

let client: SpeechClient | null = null;
function speech(): SpeechClient {
  return (client ??= new v1p1beta1.SpeechClient());
}

/**
 * STT_LANGUAGE (or the country's default) as the primary language; the country's other languages
 * (up to 3) as alternatives, so Google picks whichever is spoken and reports it in languageCode.
 */
function languages(): { languageCode: string; alternativeLanguageCodes?: string[] } {
  const c = settings.country();
  const primary = config.stt.language || c.defaultLanguage;
  const alts = [...new Set([...c.sttLanguages, 'en-US'])].filter((l) => l !== primary).slice(0, 3);
  return { languageCode: primary, ...(alts.length ? { alternativeLanguageCodes: alts } : {}) };
}

function durationMs(d: { seconds?: unknown; nanos?: number | null } | null | undefined): number {
  if (!d) return 0;
  return Number(d.seconds ?? 0) * 1000 + Math.round((d.nanos ?? 0) / 1e6);
}

/**
 * One continuous recognition session for one speaker of one call. Transparently rolls over
 * to a fresh Google stream before the time limit (or after an error), replaying the audio
 * that had not yet produced a final result so nothing is lost across the seam.
 * Audio lives only in memory and is dropped as soon as it is finalized.
 */
export class TrackRecognizer {
  private stream: ReturnType<SpeechClient['streamingRecognize']> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  /** Audio written to the current stream that has not been covered by a final result yet. */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** Byte offset (within the current stream) of the first byte in `pending`. */
  private pendingStart = 0;
  private retryDelay = 500;
  private closed = false;

  constructor(private callSid: string, private speaker: Speaker) {
    this.open();
  }

  write(chunk: Buffer): void {
    if (this.closed) return;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    this.trimPending();
    this.stream?.write(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    // Half-close so Google flushes the last final result; the stream then ends on its own.
    this.stream?.on('error', () => {}).end();
    this.pending = [];
    this.pendingBytes = 0;
  }

  private open(): void {
    const stream = speech()
      .streamingRecognize({
        config: {
          // Twilio media streams: 8kHz mu-law, mono.
          encoding: 'MULAW',
          sampleRateHertz: 8000,
          audioChannelCount: 1,
          ...languages(),
          enableAutomaticPunctuation: true,
        },
        interimResults: true,
      })
      .on('data', (res) => this.onData(stream, res))
      .on('error', (err: any) => this.onError(stream, err))
      .on('end', () => {
        if (stream === this.stream) this.scheduleRestart(0);
      });

    this.stream = stream;
    this.pendingStart = 0;
    // Replay audio the previous stream never finalized.
    for (const chunk of this.pending) stream.write(chunk);
    this.restartTimer = setTimeout(() => this.restart(), STREAM_LIMIT_MS);
  }

  private onData(stream: unknown, res: any): void {
    if (stream !== this.stream) return; // late results from a stream we already rolled over
    this.retryDelay = 500;
    const result = res.results?.[0];
    const text: string = result?.alternatives?.[0]?.transcript?.trim() ?? '';
    if (!result || !text) return;

    const isFinal = !!result.isFinal;
    if (isFinal) this.dropFinalized(durationMs(result.resultEndTime));
    bus.emit('transcript-update', {
      callSid: this.callSid, speaker: this.speaker, text, isFinal, language: result.languageCode || undefined,
    });
  }

  private onError(stream: unknown, err: any): void {
    if (stream !== this.stream || this.closed) return;
    // 11 = OUT_OF_RANGE: stream duration limit hit; just roll over.
    if (err?.code !== 11) {
      log.error('stt', `google ${shortSid(this.callSid)}/${this.speaker}: ${err?.message ?? err}`);
    }
    this.scheduleRestart(err?.code === 11 ? 0 : this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY_MS);
  }

  private scheduleRestart(delay: number): void {
    if (this.closed) return;
    this.teardown();
    this.restartTimer = setTimeout(() => this.open(), delay);
  }

  private restart(): void {
    if (this.closed) return;
    this.teardown();
    this.open();
  }

  private teardown(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const old = this.stream;
    this.stream = null;
    if (old) {
      old.removeAllListeners('data');
      old.on('error', () => {}); // swallow errors from a stream we're abandoning
      old.end();
    }
  }

  /** Forget audio up to `endMs` (relative to the current stream's start). */
  private dropFinalized(endMs: number): void {
    let drop = endMs * BYTES_PER_MS - this.pendingStart;
    while (drop > 0 && this.pending.length) {
      const head = this.pending[0];
      if (head.length <= drop) {
        this.pending.shift();
        drop -= head.length;
        this.pendingBytes -= head.length;
        this.pendingStart += head.length;
      } else {
        this.pending[0] = head.subarray(drop);
        this.pendingBytes -= drop;
        this.pendingStart += drop;
        drop = 0;
      }
    }
  }

  private trimPending(): void {
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 1) {
      const head = this.pending.shift()!;
      this.pendingBytes -= head.length;
      this.pendingStart += head.length;
    }
  }
}

let ready: Promise<boolean> | null = null;
/** Resolves true once Google credentials are usable. Only checks when GOOGLE_APPLICATION_CREDENTIALS is set. */
export function googleReady(): Promise<boolean> {
  return (ready ??= !config.google.credentials
    ? Promise.resolve(false)
    : // Missing credentials otherwise surface as an unhandled rejection deep in the Google client.
      speech().auth.getClient().then(
        () => true,
        (err) => {
          log.error('stt', `Google credentials not usable: ${err.message}`);
          return false;
        },
      ));
}
