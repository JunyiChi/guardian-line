import { bus, Speaker } from '../events';
import { config } from '../config';
import { log } from '../privacy/log';
import { googleReady, TrackRecognizer } from './google';
import { DeepgramTrack, deepgramReady } from './deepgram';

interface Track {
  write(chunk: Buffer): void;
  close(): void;
}

let ready = false;

/** One track per speaker, so the caller and the protected person stay separate. */
function openTrack(callSid: string, speaker: Speaker): Track | null {
  if (!ready) return null;
  return config.stt.provider === 'deepgram' ? new DeepgramTrack(callSid, speaker) : new TrackRecognizer(callSid, speaker);
}

/** callSid -> speaker -> track (null = STT not configured; audio is dropped) */
const sessions = new Map<string, Map<Speaker, Track | null>>();

/**
 * Streams call:audio to the provider in STT_PROVIDER and emits transcript-update.
 * Audio is only ever held in memory; nothing is written to disk.
 */
export async function setupStt(): Promise<boolean> {
  if (config.stt.provider !== 'google' && config.stt.provider !== 'deepgram') {
    log.error('stt', `unknown STT_PROVIDER "${config.stt.provider}" (use google or deepgram), using google`);
    config.stt.provider = 'google';
  }

  bus.on('call:audio', ({ callSid, speaker, payload }) => {
    if (!callSid) return;
    let tracks = sessions.get(callSid);
    if (!tracks) sessions.set(callSid, (tracks = new Map()));
    if (!tracks.has(speaker)) tracks.set(speaker, openTrack(callSid, speaker));
    tracks.get(speaker)?.write(payload);
  });

  bus.on('call:ended', ({ callSid }) => {
    const tracks = sessions.get(callSid);
    if (!tracks) return;
    for (const t of tracks.values()) t?.close();
    sessions.delete(callSid);
  });

  ready = config.stt.provider === 'deepgram' ? deepgramReady() : await googleReady();
  if (ready) log.info('stt', `${config.stt.provider} speech-to-text ready`);
  else log.error('stt', config.stt.provider === 'deepgram'
    ? 'DEEPGRAM_API_KEY not set: speech-to-text disabled'
    : 'GOOGLE_APPLICATION_CREDENTIALS not set or not usable: speech-to-text disabled');
  return ready;
}
