import type { Express } from 'express';
import type { Server } from 'socket.io';
import { bus, BusEvents, Signals, Speaker } from '../events';
import { SCAM_TYPE_LABEL } from '../detector/prompt';
import { settings } from '../settings';
import { maskNumber } from '../privacy/log';
import { setupDemo } from './demo';

const forwarded: (keyof BusEvents)[] = [
  'call:ringing', 'call:started', 'call:ended', 'transcript-update', 'risk-update', 'scam-detected', 'alert:sent',
];

/** Everything the dashboard needs to redraw a call after a page reload. Dropped when the call ends. */
interface LiveCall {
  callSid: string;
  from: string;
  status: 'ringing' | 'in-call';
  startedAt: number;
  transcript: { speaker: Speaker; text: string }[];
  risk: number;
  maxRisk: number;
  scamType: string;
  reason: string;
  signals: Signals;
  flagged: boolean;
  voice: boolean;
  family: boolean;
  impersonating: string;
  /** Latest check details for the badges (Jev: probabilities, level, confidence, timing). */
  check: Partial<BusEvents['risk-update']> | null;
}

/** Short record kept after a call ends. Normal calls keep no content at all. */
export interface HistoryEntry {
  callSid: string;
  from: string;
  startedAt: number;
  endedAt: number;
  maxRisk: number;
  scamType: string;
  summary: string;
  flagged: boolean;
}

const HISTORY_LIMIT = 50;
/** Demo calls show their made-up number; real numbers are masked before they reach a browser. */
const mask = (from: string) => (from.startsWith('+1 555') ? from : maskNumber(from));
const live = new Map<string, LiveCall>();
const history: HistoryEntry[] = [];

function liveCall(callSid: string, from = 'unknown'): LiveCall {
  let c = live.get(callSid);
  if (!c) {
    c = {
      callSid, from, status: 'ringing', startedAt: Date.now(), transcript: [],
      risk: 0, maxRisk: 0, scamType: 'none', reason: '',
      signals: { urgency: false, threat: false, data_request: false, transfer_request: false }, flagged: false, voice: false, family: false, impersonating: 'none', check: null,
    };
    live.set(callSid, c);
  }
  return c;
}

/** Forwards bus events to every connected dashboard browser and keeps call history. */
export function setupDashboard(io: Server, app: Express): void {
  bus.on('call:ringing', ({ callSid, from }) => void liveCall(callSid, from));
  bus.on('call:started', ({ callSid, from }) => {
    const c = liveCall(callSid, from);
    c.status = 'in-call';
    if (from !== 'unknown') c.from = from;
  });
  bus.on('transcript-update', ({ callSid, speaker, text, isFinal }) => {
    if (isFinal) live.get(callSid)?.transcript.push({ speaker, text });
  });
  bus.on('risk-update', (u) => {
    const { callSid, score, scamType, reason, signals, impersonating } = u;
    const c = live.get(callSid);
    if (!c) return;
    c.check = { ...u };
    c.risk = score;
    c.signals = signals;
    if (score >= c.maxRisk) Object.assign(c, { maxRisk: score, scamType, reason, impersonating });
  });
  bus.on('scam-detected', ({ callSid, score, scamType, reason }) => {
    const c = live.get(callSid);
    if (c) Object.assign(c, { flagged: true, maxRisk: Math.max(c.maxRisk, score), scamType, reason });
  });
  bus.on('alert:sent', ({ callSid, channel }) => {
    const c = live.get(callSid);
    if (!c) return;
    if (channel === 'voice') c.voice = true;
    if (channel === 'sms' || channel === 'whatsapp') c.family = true;
  });

  for (const event of forwarded) bus.on(event, (data: any) => io.emit(event, 'from' in data ? { ...data, from: mask(data.from) } : data));

  // Registered after the forwarders so browsers get call:ended before the history update.
  bus.on('call:ended', ({ callSid }) => {
    const c = live.get(callSid);
    if (!c) return;
    live.delete(callSid);
    const entry: HistoryEntry = {
      callSid, from: c.from, startedAt: c.startedAt, endedAt: Date.now(), maxRisk: c.maxRisk, flagged: c.flagged,
      scamType: c.flagged ? c.scamType : 'none',
      summary: c.flagged ? c.reason : 'Normal call, data deleted',
    };
    history.unshift(entry);
    history.length = Math.min(history.length, HISTORY_LIMIT);
    io.emit('history:added', { ...entry, from: mask(entry.from) });
  });

  // The browser only ever sees masked caller numbers.
  io.on('connection', (socket) => {
    const country = settings.country();
    socket.emit('snapshot', {
      live: [...live.values()].map((c) => ({ ...c, from: mask(c.from) })),
      history: history.map((h) => ({ ...h, from: mask(h.from) })),
      scamTypes: SCAM_TYPE_LABEL,
      country: { code: country.code, name: country.name, reporting: country.reporting },
      protectedName: settings.get().protectedName,
      riskThreshold: settings.get().riskThreshold,
    });
  });

  setupDemo(app);
}
