import { z } from 'zod';
import { bus, Signals } from '../events';
import { config } from '../config';
import { getCountry, CountryProfile } from '../config/countries';
import { settings } from '../settings';
import { store } from '../store';
import { log, shortSid } from '../privacy/log';
import { complete, currentProvider, Tier } from './providers';
import { AUTHORITIES, BASE_PROMPT, countryPrompt, IMPERSONATING, languageName, SCAM_TYPES } from './prompt';
import { askJev, buildTranscript, decide, levelLabel, logCheck, statusOf } from './jev';

const SCORE_INTERVAL_MS = 8_000;
/** Only the last 2 minutes of transcript are sent; earlier parts become a one-line summary. */
const WINDOW_MS = 2 * 60 * 1000;
const MIN_WINDOW_LINES = 4;
/** Weight of the newest score in the smoothed risk. */
const SMOOTHING = 0.6;

const Assessment = z.object({
  risk: z.number().min(0).max(100),
  scamType: z.enum(SCAM_TYPES),
  signals: z.object({
    urgency: z.boolean(),
    threat: z.boolean(),
    data_request: z.boolean(),
    transfer_request: z.boolean(),
  }),
  impersonating: z.enum(IMPERSONATING),
  reason: z.string(),
});
export type Assessment = z.infer<typeof Assessment>;

export interface ScoreInput {
  /** "caller: ..." / "protected: ..." lines. */
  transcript: string;
  /** One-line summary of the call before the transcript window, if it was cut. */
  earlier?: string;
  /** BCP-47 language of the call; the reason is written in it. */
  language?: string;
  country?: CountryProfile;
}

export interface Score extends Assessment {
  tier: Tier;
  /** The fast model's risk, also when the precise model made the final call. */
  fastRisk: number;
  ms: number;
}

/** Pulls the JSON object out of a reply, tolerating ```json fences or chatter around it. */
function parseAssessment(text: string): Assessment {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`no JSON object in reply: ${text.slice(0, 120)}`);
  return Assessment.parse(JSON.parse(text.slice(start, end + 1)));
}

/** Enforces the hard scoring rules from the prompt in case the model drifts. */
export function applyRules(a: Assessment): Assessment {
  const s = a.signals;
  let risk = Math.round(Math.min(100, Math.max(0, a.risk)));
  const count = [s.urgency, s.threat, s.data_request, s.transfer_request].filter(Boolean).length;
  if (count === 0) risk = Math.min(risk, 20);
  if ((s.data_request || s.transfer_request) && AUTHORITIES.includes(a.impersonating)) risk = Math.max(risk, 80);
  return { ...a, risk };
}

/** One model pass. Invalid JSON is retried once; after that it throws and the caller skips this check. */
async function assess(input: ScoreInput, tier: Tier): Promise<Assessment> {
  const country = input.country ?? settings.country();
  const lang = languageName(input.language ?? country.defaultLanguage);
  const user = [
    `Write "reason" in ${lang}.`,
    input.earlier ? `Earlier in the call (summary): ${input.earlier}` : '',
    `Transcript${input.earlier ? ' (last 2 minutes)' : ' so far'}:\n\n${input.transcript}`,
  ].filter(Boolean).join('\n\n');
  const req = { system: [BASE_PROMPT, countryPrompt(country)], user, tier, schema: Assessment };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await complete(req);
    try {
      return applyRules(parseAssessment(text));
    } catch (err: any) {
      lastErr = err;
      log.warn('detector', `${currentProvider()}/${tier} returned invalid JSON (attempt ${attempt}/2): ${err?.message?.slice(0, 200) ?? err}`);
    }
  }
  throw new Error(`invalid JSON from ${currentProvider()}/${tier} after retry: ${(lastErr as any)?.message?.slice(0, 200) ?? lastErr}`);
}

/**
 * Two-tier check: the fast model scores every time; at risk >= CONFIRM_THRESHOLD (default 40) the
 * precise model re-checks and its result is final. If the precise model fails, the fast result stands.
 */
export async function scoreTranscript(input: ScoreInput): Promise<Score> {
  const t0 = Date.now();
  const fast = await assess(input, 'fast');
  if (fast.risk < config.llm.confirmAt) return { ...fast, tier: 'fast', fastRisk: fast.risk, ms: Date.now() - t0 };
  try {
    const precise = await assess(input, 'precise');
    return { ...precise, tier: 'precise', fastRisk: fast.risk, ms: Date.now() - t0 };
  } catch (err: any) {
    log.warn('detector', `precise check failed, using fast result: ${err?.message ?? err}`);
    return { ...fast, tier: 'fast', fastRisk: fast.risk, ms: Date.now() - t0 };
  }
}

/**
 * Smooths raw scores so one odd sentence can't trigger an alert on its own:
 * a single jump from 10 to 90 gives ~58, a second high score pushes it over ~80.
 */
export class RiskTracker {
  history: { raw: number; smoothed: number; at: number }[] = [];
  alerted = false;

  /** Returns the smoothed score, and whether this update is the first threshold crossing. */
  add(raw: number, threshold = settings.get().riskThreshold): { smoothed: number; crossed: boolean } {
    const prev = this.history.at(-1)?.smoothed ?? 0;
    const smoothed = Math.round(this.history.length ? SMOOTHING * raw + (1 - SMOOTHING) * prev : SMOOTHING * raw);
    this.history.push({ raw, smoothed, at: Date.now() });
    const crossed = !this.alerted && smoothed >= threshold;
    if (crossed) this.alerted = true;
    return { smoothed, crossed };
  }
}

/** Per-call detector state. Jev and the chat model share it, so a call can fall back mid-call. */
interface CallState {
  mode: 'jev' | 'llm';
  timer: NodeJS.Timeout;
  inFlight: boolean;
  /** Final transcript lines already checked; a check is skipped until a new one arrives. */
  checkedLines: number;
  /** Once "scam-detected" fired, the call's status never goes back down. */
  detected: boolean;
  // ---- Jev
  prevScore: number | null;
  warnReason: string;
  failures: number;
  backoffUntil: number;
  // ---- chat model (DETECTOR=llm, or the JEV_FALLBACK=llm fallback)
  tracker: RiskTracker;
  signalsSoFar: Signals;
  last: Assessment | null;
}
const calls = new Map<string, CallState>();

/** Last 2 minutes of the transcript (at least a few lines), plus a one-line summary of what came before. */
function window(callSid: string, state: CallState): ScoreInput | null {
  const rec = store.get(callSid);
  if (!rec || !rec.transcript.length) return null;
  const cutoff = Date.now() - WINDOW_MS;
  let first = rec.transcript.findIndex((l) => l.at >= cutoff);
  if (first < 0) first = rec.transcript.length;
  first = Math.min(first, Math.max(0, rec.transcript.length - MIN_WINDOW_LINES));
  const lines = rec.transcript.slice(first);
  let earlier: string | undefined;
  if (first > 0 && state.last) {
    const sigs = Object.entries(state.signalsSoFar).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none';
    earlier = `${first} earlier lines. Caller claimed to be: ${state.last.impersonating}. Signals already seen: ${sigs}. Previous assessment: ${state.last.reason}`;
  }
  return {
    transcript: lines.map((l) => `${l.speaker}: ${l.text}`).join('\n'),
    earlier,
    language: rec.language,
    country: getCountry(settings.get().country),
  };
}

/** Chat-model check (two-tier, smoothed). Used for DETECTOR=llm and as the Jev fallback. */
async function llmCheck(callSid: string, state: CallState): Promise<void> {
  const input = window(callSid, state);
  if (!input) return;
  const a = await scoreTranscript(input);
  if (calls.get(callSid) !== state) return; // call ended while we waited
  state.last = a;
  for (const k of Object.keys(state.signalsSoFar) as (keyof Signals)[]) state.signalsSoFar[k] ||= a.signals[k];
  const { smoothed, crossed } = state.tracker.add(a.risk);
  if (crossed) state.detected = true;
  bus.emit('risk-update', {
    callSid, score: smoothed, rawScore: a.risk, scamType: a.scamType, reason: a.reason,
    signals: a.signals, impersonating: a.impersonating, tier: a.tier, detector: 'llm',
    status: state.detected ? 'scam' : statusOf(smoothed), ms: a.ms,
  });
  if (crossed) {
    bus.emit('scam-detected', {
      callSid, score: smoothed, scamType: a.scamType, reason: a.reason, signals: a.signals, impersonating: a.impersonating, detector: 'llm',
    });
  }
}

/** Jev check: one Decisions API request, decision rules, template reason. */
async function jevCheck(callSid: string, state: CallState): Promise<void> {
  const rec = store.get(callSid);
  if (!rec?.transcript.length) return;
  const { text } = buildTranscript(rec.transcript);
  const a = await askJev(text, getCountry(settings.get().country));
  if (calls.get(callSid) !== state) return;
  const d = decide(a, state.prevScore, state.detected);
  state.prevScore = a.score;
  logCheck(a, d, shortSid(callSid));
  const firstWarning = d.warn && !state.detected;
  if (d.warn) state.detected = true;
  // After a warning the status stays red; keep the warning's explanation unless this check names signals too.
  if (firstWarning || (d.warn && d.detected.size)) state.warnReason = d.reason;
  else if (state.detected && state.warnReason) d.reason = state.warnReason;
  bus.emit('risk-update', {
    callSid, score: d.risk, rawScore: d.risk, scamType: a.scamType, reason: d.reason, signals: d.signals,
    impersonating: d.impersonating, tier: 'jev', detector: 'jev', status: d.status,
    confidence: a.confidence, probabilities: a.probabilities, level: levelLabel(a.score), ms: a.ms, cost: a.cost,
  });
  if (firstWarning) {
    bus.emit('scam-detected', {
      callSid, score: d.risk, scamType: a.scamType, reason: d.reason, signals: d.signals, impersonating: d.impersonating, detector: 'jev',
    });
  }
}

const JEV_MAX_BACKOFF_MS = 15_000;

async function tick(callSid: string, state: CallState): Promise<void> {
  if (state.inFlight) return; // never overlap requests
  const lines = store.get(callSid)?.transcript.length ?? 0;
  if (lines === 0 || lines === state.checkedLines) return; // nothing new since the last check
  if (state.mode === 'jev' && Date.now() < state.backoffUntil) return;
  state.inFlight = true;
  const checked = lines;
  try {
    if (state.mode === 'jev') {
      await jevCheck(callSid, state);
      state.failures = 0;
    } else {
      await llmCheck(callSid, state);
    }
    state.checkedLines = checked;
  } catch (err: any) {
    // Never let scoring problems touch the call: log, back off, skip this check, retry later.
    if (state.mode === 'jev') {
      state.failures++;
      const wait = Math.min(JEV_MAX_BACKOFF_MS, err?.retryAfterMs ?? 1000 * 2 ** (state.failures - 1));
      state.backoffUntil = Date.now() + wait;
      log.error('jev', `${shortSid(callSid)}: check failed (${state.failures} in a row), skipped, retry in ${Math.round(wait / 1000)}s: ${err?.message ?? err}`);
      if (state.failures >= 3 && config.jev.fallback === 'llm') {
        state.mode = 'llm';
        log.warn('jev', `${shortSid(callSid)}: 3 failures in a row, switching this call to the chat-model detector (JEV_FALLBACK=llm)`);
      }
    } else {
      log.error('detector', `${shortSid(callSid)}: scoring failed, check skipped: ${err?.message ?? err}`);
    }
  } finally {
    state.inFlight = false;
  }
}

/**
 * Checks every active call's transcript and emits risk-update / scam-detected.
 * DETECTOR=jev (default): Jev every CHECK_INTERVAL_MS. DETECTOR=llm: the chat model every 8s.
 */
export function setupDetector(): void {
  const mode = config.detector === 'llm' ? 'llm' : 'jev';
  if (mode === 'jev' && !config.jev.apiKey) log.error('jev', 'JEV_API_KEY not set: scam detection will fail until it is');
  log.info('detector', mode === 'jev'
    ? `Jev ${config.jev.model} every ${config.jev.checkIntervalMs}ms (warn: score >= ${config.jev.warnScore} & conf >= ${config.jev.warnConfidence}, or >= ${config.jev.highScore} twice, or money/codes + authority; fallback ${config.jev.fallback})`
    : `chat model ${currentProvider()} every ${SCORE_INTERVAL_MS}ms`);

  bus.on('transcript-update', ({ callSid, isFinal }) => {
    if (!isFinal) return; // only final lines change the stored transcript
    if (callSid.startsWith('DEMO-')) return; // demo replays carry their own scripted scores
    if (calls.has(callSid)) return;
    const s: CallState = {
      mode, timer: undefined!, inFlight: false, checkedLines: 0, detected: false,
      prevScore: null, warnReason: '', failures: 0, backoffUntil: 0,
      tracker: new RiskTracker(), last: null,
      signalsSoFar: { urgency: false, threat: false, data_request: false, transfer_request: false },
    };
    s.timer = setInterval(() => void tick(callSid, s), mode === 'jev' ? config.jev.checkIntervalMs : SCORE_INTERVAL_MS);
    calls.set(callSid, s);
  });

  bus.on('call:ended', ({ callSid }) => {
    const state = calls.get(callSid);
    if (state) clearInterval(state.timer);
    calls.delete(callSid);
  });
}
