import WebSocket from 'ws';
import { bus, Speaker } from '../events';
import { config } from '../config';
import { settings } from '../settings';
import { log, shortSid } from '../privacy/log';

const URL = 'wss://api.deepgram.com/v1/listen';
/** Languages Deepgram's nova-3 "multi" mode detects and code-switches between. */
const MULTI = ['en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl'];
const KEEPALIVE_MS = 8_000;
const MAX_RETRY_MS = 10_000;

/** Deepgram language: "multi" (auto-detect) when every language of the country is covered, else the primary one. */
function language(): string {
  if (config.stt.language) return config.stt.language;
  const langs = settings.country().sttLanguages.map((l) => l.split('-')[0].toLowerCase());
  return langs.every((l) => MULTI.includes(l)) ? 'multi' : settings.country().defaultLanguage;
}

/**
 * One Deepgram streaming session for one speaker of one call. Audio (8kHz mu-law) is forwarded as-is
 * and kept only in this process's memory while the socket connects. Reconnects with backoff on errors.
 */
export class DeepgramTrack {
  private ws: WebSocket | null = null;
  private queue: Buffer[] = [];
  private closed = false;
  private retry = 500;
  private keepAlive: NodeJS.Timeout;
  private lastAudio = Date.now();

  constructor(private callSid: string, private speaker: Speaker) {
    this.open();
    this.keepAlive = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastAudio > KEEPALIVE_MS) {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, KEEPALIVE_MS);
  }

  write(chunk: Buffer): void {
    if (this.closed) return;
    this.lastAudio = Date.now();
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(chunk);
    else if (this.queue.push(chunk) > 250) this.queue.shift(); // ~5s while (re)connecting
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    this.queue = [];
    // CloseStream makes Deepgram flush the last final result before it closes the socket.
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    const ws = this.ws;
    setTimeout(() => ws?.terminate(), 5_000).unref();
  }

  private open(): void {
    const params = new URLSearchParams({
      model: config.stt.deepgramModel,
      encoding: 'mulaw',
      sample_rate: '8000',
      channels: '1',
      language: language(),
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      // Sentence end after this much silence; UtteranceEnd backs it up when background noise keeps endpointing from firing.
      endpointing: String(config.stt.endpointingMs),
      utterance_end_ms: '1000',
      vad_events: 'true',
    });
    const ws = new WebSocket(`${URL}?${params}`, { headers: { Authorization: `Token ${config.stt.deepgramApiKey}` } });
    this.ws = ws;
    ws.on('open', () => {
      log.info('stt', `deepgram ${shortSid(this.callSid)}/${this.speaker}: connected (${language()})`);
      this.retry = 500;
      for (const c of this.queue) ws.send(c);
      this.queue = [];
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'UtteranceEnd') return void bus.emit('utterance-end', { callSid: this.callSid, speaker: this.speaker });
      if (msg.type === 'Metadata' || msg.type === 'Error') return void log.debug('stt', `deepgram ${shortSid(this.callSid)}/${this.speaker}: ${msg.type} ${JSON.stringify(msg).slice(0, 160)}`);
      if (msg.type !== 'Results') return;
      const alt = msg.channel?.alternatives?.[0];
      const text: string = alt?.transcript?.trim() ?? '';
      if (!text) return;
      const detected: string | undefined = alt.languages?.[0] ?? msg.metadata?.language ?? undefined;
      bus.emit('transcript-update', {
        callSid: this.callSid, speaker: this.speaker, text, isFinal: !!msg.is_final, endOfSpeech: !!msg.is_final && !!msg.speech_final,
        language: detected ?? (language() === 'multi' ? undefined : language()),
      });
    });
    ws.on('error', (err) => {
      if (!this.closed) log.error('stt', `deepgram ${shortSid(this.callSid)}/${this.speaker}: ${err.message}`);
    });
    ws.on('close', () => {
      if (this.closed || ws !== this.ws) return;
      setTimeout(() => !this.closed && this.open(), this.retry);
      this.retry = Math.min(this.retry * 2, MAX_RETRY_MS);
    });
  }
}

export const deepgramReady = () => !!config.stt.deepgramApiKey;
