import { bus, Speaker } from './events';
import { summaries } from './privacy/summaries';
import { log, shortSid } from './privacy/log';

export type CallStatus = 'active' | 'flagged' | 'ended';

export interface TranscriptLine { speaker: Speaker; text: string; at: number }
export interface RiskPoint { score: number; reason: string; scamType: string; impersonating: string; at: number }

export interface CallRecord {
  callSid: string;
  from: string;
  startedAt: number;
  status: CallStatus;
  scamType: string;
  /** Most recent language reported by speech-to-text (BCP-47), if any. */
  language?: string;
  transcript: TranscriptLine[];
  risk: RiskPoint[];
  alerts: string[];
}

/**
 * Active calls, in memory only. Nothing here is ever written to disk: when a call ends its
 * record is deleted, and only a flagged call leaves a short encrypted summary behind.
 */
const calls = new Map<string, CallRecord>();

export const store = {
  get: (callSid: string) => calls.get(callSid),
  all: () => [...calls.values()],
  create(callSid: string, from: string): CallRecord {
    const rec: CallRecord = {
      callSid, from, startedAt: Date.now(), status: 'active', scamType: 'none',
      transcript: [], risk: [], alerts: [],
    };
    calls.set(callSid, rec);
    return rec;
  },
  remove: (callSid: string) => calls.delete(callSid),
  fullText: (callSid: string) => calls.get(callSid)?.transcript.map((t) => `${t.speaker}: ${t.text}`).join('\n') ?? '',
};

// Keep the store in sync with the bus
bus.on('call:started', ({ callSid, from }) => void (store.get(callSid) ?? store.create(callSid, from)));
bus.on('transcript-update', ({ callSid, speaker, text, isFinal, language }) => {
  const rec = store.get(callSid);
  if (!rec) return;
  if (language) rec.language = language;
  if (isFinal) rec.transcript.push({ speaker, text, at: Date.now() });
});
bus.on('risk-update', ({ callSid, score, reason, scamType, impersonating }) => {
  store.get(callSid)?.risk.push({ score, reason, scamType, impersonating, at: Date.now() });
});
bus.on('scam-detected', ({ callSid, scamType }) => {
  const rec = store.get(callSid);
  if (rec) Object.assign(rec, { status: 'flagged', scamType });
});
bus.on('alert:sent', ({ callSid, channel }) => {
  store.get(callSid)?.alerts.push(channel);
});
bus.on('call:ended', ({ callSid }) => {
  const rec = store.get(callSid);
  if (!rec) return;
  if (rec.status === 'flagged' && !/^(DEMO|TEST|SIM)-/.test(callSid)) {
    const top = rec.risk.reduce((a, b) => (b.score > a.score ? b : a), rec.risk[0]);
    try {
      const kept = summaries.save({
        startedAt: new Date(rec.startedAt).toISOString(), endedAt: new Date().toISOString(),
        caller: rec.from, scamType: rec.scamType, impersonating: top?.impersonating ?? 'none',
        maxRisk: top?.score ?? 0, reason: top?.reason ?? '', alerts: [...new Set(rec.alerts)],
      });
      log.info('privacy', `${shortSid(callSid)} flagged call: ${kept ? 'encrypted summary kept' : 'nothing kept'}, transcript deleted`);
    } catch (err: any) {
      log.error('privacy', `${shortSid(callSid)} could not save summary: ${err.message}`);
    }
  } else if (rec.status !== 'flagged') {
    log.info('privacy', 'normal call, data deleted');
  }
  rec.transcript.length = 0;
  store.remove(callSid);
});
