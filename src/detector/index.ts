import { z } from 'zod';
import { bus, Signals } from '../events';
import { config } from '../config';
import { getCountry, CountryProfile } from '../config/countries';
import { settings } from '../settings';
import { store } from '../store';
import { log, shortSid } from '../privacy/log';
import { complete, currentProvider, Tier } from './providers';
import { BASE_PROMPT, CATEGORIES, CATEGORY_TO_SCAMTYPE, countryPrompt, languageName, STAGES } from './prompt';
import { ACTION_RANK, ACTIONS, Action, capAction, FamilyContext, familyPrompt, getFamily } from '../config/family';
import type { Guardian, Stage } from '../events';
import { askJev, buildTranscript, codeRequest, codeRequestDecision, decide, JevAnswer, JevDecision, levelLabel, logCheck, statusOf } from './jev';

/** Only the last 2 minutes of transcript are sent; earlier parts become a one-line summary. */
const WINDOW_MS = 2 * 60 * 1000;
const MIN_WINDOW_LINES = 4;
/** Weight of the newest score in the smoothed risk. */
const SMOOTHING = 0.7;

/** What the model returns (Guardian trajectory schema). Numeric bounds are enforced in code, not in the schema. */
const ModelOutput = z.object({
  risk: z.number(),
  stage: z.enum(STAGES),
  category: z.enum(CATEGORIES),
  requestsOfSenior: z.array(z.string()),
  evidence: z.array(z.string()),
  seniorSignals: z.array(z.string()),
  action: z.enum(ACTIONS),
  summaryForChild: z.string(),
  whisperText: z.string(),
  reason: z.string(),
});
export type ModelOutput = z.infer<typeof ModelOutput>;

/** Model output plus the legacy Wessuwan fields (scamType / signals / impersonating) derived from it, so every existing consumer keeps working. */
export type Assessment = ModelOutput & { scamType: string; signals: Signals; impersonating: string };

export interface ScoreInput {
  /** "caller: ..." / "protected: ..." lines. */
  transcript: string;
  /** One-line summary of the call before the transcript window, if it was cut. */
  earlier?: string;
  /** BCP-47 language of the call; the reason is written in it. */
  language?: string;
  country?: CountryProfile;
  /** Household context (defaults to family.json). */
  family?: FamilyContext;
  /** The previous assessment of this call, for consistency. */
  prior?: Assessment | null;
}

export interface Score extends Assessment {
  tier: Tier;
  /** The fast model's risk, also when the precise model made the final call. */
  fastRisk: number;
  ms: number;
}

/** Pulls the JSON object out of a reply, tolerating ```json fences or chatter around it. */
function parseModelOutput(text: string): ModelOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`no JSON object in reply: ${text.slice(0, 120)}`);
  return ModelOutput.parse(JSON.parse(text.slice(start, end + 1)));
}

/** "Guardian, is this real?" said by the protected person mid-call. Loose on purpose: speech-to-text mangles names. */
export const WAKE_WORD = /\b(guardian|gardian|guardean|guard[iy]an)\b|小卫|守护|卫士/i;

const STAGE_RANK: Record<Stage, number> = { none: 0, rapport: 1, pressure: 2, isolation: 3, extraction: 4 };
/** Lowest risk each action implies; the model's action is treated as a hard-rule signal. */
const ACTION_FLOOR: Record<Action, number> = { none: 0, log: 0, notify_child_after_call: 46, notify_child_now: 71, whisper_senior: 85 };
const DATA_WORDS = /code|otp|pin\b|password|passcode|card number|account number|social security|ssn|id number|install|download|remote|anydesk|teamviewer|screen|link|verification|验证码|密码|卡号|账号|身份证|软件|链接|远程/i;
const MONEY_WORDS = /pay|transfer|wire|money|gift card|prepaid|crypto|bitcoin|atm|fee|deposit|bail|safe account|secure account|cash|bank|转账|汇款|打款|转到|礼品卡|押金|保证金|安全账户|取钱|银行|现金/i;
const AUTHORITY_CATS = new Set(['scam_authority']);

export function bandAction(risk: number): Action {
  return risk >= 85 ? 'whisper_senior' : risk >= 71 ? 'notify_child_now' : risk >= 46 ? 'notify_child_after_call' : risk >= 21 ? 'log' : 'none';
}

/**
 * Enforces calibration in case the model drifts, then derives the legacy fields:
 * - an extraction-stage scam, or a whisper-level action from the model, floors the risk at 85;
 * - the final action is the band for the final risk, capped by the family's maxIntervention.
 */
export function applyRules(m: ModelOutput, family: FamilyContext = getFamily()): Assessment {
  let risk = Math.round(Math.min(100, Math.max(0, m.risk)));
  const scam = m.category.startsWith('scam');
  if (scam && m.stage === 'extraction') risk = Math.max(risk, 85);
  risk = Math.max(risk, ACTION_FLOOR[m.action]);
  if (!scam && m.category !== 'unclear' && m.stage !== 'extraction') risk = Math.min(risk, 70); // benign categories never reach the whisper band
  const action = capAction(bandAction(risk), family);

  const asks = m.requestsOfSenior.join(' | ');
  const extraction = m.stage === 'extraction';
  const data = extraction && DATA_WORDS.test(asks);
  const money = extraction && MONEY_WORDS.test(asks);
  const signals: Signals = {
    urgency: STAGE_RANK[m.stage] >= STAGE_RANK.pressure,
    threat: STAGE_RANK[m.stage] >= STAGE_RANK.pressure && (AUTHORITY_CATS.has(m.category) || m.category === 'scam_family_emergency' || m.category === 'scam_tech_support'),
    data_request: data || (extraction && !money),
    transfer_request: money,
  };
  const blob = `${m.reason} ${m.evidence.join(' ')}`;
  const impersonating =
    m.category === 'scam_authority' ? (/bank|银行/i.test(blob) ? 'bank' : /police|公安|警|prosecut|court|检察/i.test(blob) ? 'police' : 'government')
    : m.category === 'scam_tech_support' ? 'tech_company'
    : m.category === 'scam_delivery_fee' ? 'delivery_company'
    : m.category === 'scam_family_emergency' ? 'relative'
    : m.category === 'sales_marketing' ? 'company'
    : 'none';
  return { ...m, risk, action, whisperText: action === 'whisper_senior' ? m.whisperText : '', scamType: CATEGORY_TO_SCAMTYPE[m.category], signals, impersonating };
}

/** The Guardian fields of an assessment, for bus events. */
export function guardianOf(a: Assessment): Guardian {
  return {
    stage: a.stage, category: a.category, requests: a.requestsOfSenior, evidence: a.evidence, seniorSignals: a.seniorSignals,
    action: a.action, summaryForChild: a.summaryForChild, whisperText: a.whisperText, reason: a.reason,
  };
}

/** One model pass. Invalid JSON is retried once; after that it throws and the caller skips this check. */
async function assess(input: ScoreInput, tier: Tier): Promise<Assessment> {
  const country = input.country ?? settings.country();
  const lang = languageName(input.language ?? country.defaultLanguage);
  const family = input.family ?? getFamily();
  const user = [
    `Write "reason" in ${lang}. Write "summaryForChild" and "whisperText" in the family's language (${languageName(family.language)}).`,
    `## Family context\n${familyPrompt(family)}`,
    `## Previous assessment\n${input.prior ? JSON.stringify({ risk: input.prior.risk, stage: input.prior.stage, category: input.prior.category, requestsOfSenior: input.prior.requestsOfSenior, reason: input.prior.reason }) : 'null (first check of this call)'}`,
    input.earlier ? `Earlier in the call (summary): ${input.earlier}` : '',
    `## Transcript${input.earlier ? ' (last 2 minutes)' : ' so far'}\n${input.transcript}`,
    'Return the updated assessment as JSON.',
  ].filter(Boolean).join('\n\n');
  const req = { system: [BASE_PROMPT, countryPrompt(country)], user, tier, schema: ModelOutput };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await complete(req);
    try {
      return applyRules(parseModelOutput(text), family);
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
    // >= 85 means an extraction-stage ask or a hard rule: no smoothing, the whisper must land on that sentence.
    const smoothed = raw >= 85 ? Math.max(raw, prev) : Math.round(this.history.length ? SMOOTHING * raw + (1 - SMOOTHING) * prev : SMOOTHING * raw);
    this.history.push({ raw, smoothed, at: Date.now() });
    const crossed = !this.alerted && smoothed >= threshold;
    if (crossed) this.alerted = true;
    return { smoothed, crossed };
  }
}

/** Per-call detector state. Jev and the chat model share it, so a call can fall back mid-call. */
interface CallState {
  mode: 'jev' | 'llm';
  /** One check at a time; a caller sentence that ends meanwhile sets pending, so it's checked right after. */
  inFlight: boolean;
  pending: boolean;
  /** Final transcript lines already checked; a check is skipped until a new one arrives. */
  checkedLines: number;
  /** Caller words heard since the last final result, and the long-speech backup timer. */
  partial: string;
  longSpeech: NodeJS.Timeout | null;
  /** Caller final segments since the last sentence end (Deepgram can finalize a sentence in pieces). */
  sentence: string[];
  retry: NodeJS.Timeout | null;
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
    earlier = `${first} earlier lines. Stage reached: ${state.last.stage}. Requests so far: ${state.last.requestsOfSenior.join('; ') || 'none'}. Previous assessment: ${state.last.reason}`;
  }
  return {
    transcript: lines.map((l) => `${l.speaker}: ${l.text}`).join('\n'),
    earlier,
    language: rec.language,
    country: getCountry(settings.get().country),
    prior: state.last,
  };
}

/** Chat-model check (two-tier, smoothed). Used for DETECTOR=llm and as the Jev fallback. */
async function llmCheck(callSid: string, state: CallState): Promise<void> {
  const input = window(callSid, state);
  if (!input) return;
  const a = await scoreTranscript(input);
  if (calls.get(callSid) !== state) return; // call ended while we waited
  for (const k of Object.keys(state.signalsSoFar) as (keyof Signals)[]) state.signalsSoFar[k] ||= a.signals[k];
  const { smoothed, crossed } = state.tracker.add(a.risk);
  if (crossed) state.detected = true;
  // The intervention level never goes back down during a call.
  const prevAction = state.last?.action ?? 'none';
  const action: Action = ACTION_RANK[a.action] >= ACTION_RANK[prevAction] ? a.action : prevAction;
  state.last = { ...a, action };
  const guardian = guardianOf(state.last);
  bus.emit('risk-update', {
    callSid, score: smoothed, rawScore: a.risk, scamType: a.scamType, reason: a.reason,
    signals: a.signals, impersonating: a.impersonating, tier: a.tier, detector: 'llm',
    status: state.detected ? 'scam' : statusOf(smoothed), ms: a.ms, guardian,
  });
  if (crossed) {
    bus.emit('scam-detected', {
      callSid, score: smoothed, scamType: a.scamType, reason: a.reason, signals: a.signals, impersonating: a.impersonating, detector: 'llm', guardian,
    });
  }
}

/** Jev check: one Decisions API request, decision rules, template reason. */
async function jevCheck(callSid: string, state: CallState, partial: string): Promise<void> {
  const rec = store.get(callSid);
  if (!rec?.transcript.length && !partial) return;
  // Long-speech backup: the caller's unfinished sentence goes in as the last line.
  const lines = partial ? [...(rec?.transcript ?? []), { speaker: 'caller' as const, text: partial }] : rec!.transcript;
  const { text } = buildTranscript(lines);
  const a = await askJev(text, getCountry(settings.get().country));
  if (calls.get(callSid) !== state) return;
  const d = decide(a, state.prevScore, state.detected);
  state.prevScore = a.score;
  logCheck(a, d, `${shortSid(callSid)}${partial ? ' (partial)' : ''}`);
  emitJev(callSid, state, d, a);
}

/** risk-update for a Jev decision (or the keyword fast path, a = undefined), plus scam-detected on the first warning. */
function emitJev(callSid: string, state: CallState, d: JevDecision, a?: JevAnswer): void {
  const firstWarning = d.warn && !state.detected;
  if (d.warn) state.detected = true;
  // After a warning the status stays red; keep the warning's explanation unless this check names signals too.
  if (firstWarning || (d.warn && d.detected.size)) state.warnReason = d.reason;
  else if (state.detected && state.warnReason) d.reason = state.warnReason;
  bus.emit('risk-update', {
    callSid, score: d.risk, rawScore: d.risk, scamType: a?.scamType ?? 'other', reason: d.reason, signals: d.signals,
    impersonating: d.impersonating, tier: 'jev', detector: 'jev', status: d.status,
    ...(a && { confidence: a.confidence, probabilities: a.probabilities, level: levelLabel(a.score), ms: a.ms, cost: a.cost }),
  });
  if (firstWarning) {
    bus.emit('scam-detected', {
      callSid, score: d.risk, scamType: a?.scamType ?? 'other', reason: d.reason, signals: d.signals, impersonating: d.impersonating, detector: 'jev',
    });
  }
}

const JEV_MAX_BACKOFF_MS = 15_000;

/**
 * Runs a check now, or marks one pending if a check is already running: then exactly one more check
 * runs with the latest transcript as soon as it finishes. Never overlaps, never skips the latest sentence.
 */
async function requestCheck(callSid: string, state: CallState, partial = ''): Promise<void> {
  if (state.inFlight) {
    if (!partial) state.pending = true;
    return;
  }
  if (state.mode === 'jev' && Date.now() < state.backoffUntil) {
    // Backing off after errors: check once the wait is over instead of dropping this sentence.
    if (!state.retry) state.retry = setTimeout(() => { state.retry = null; void requestCheck(callSid, state); }, state.backoffUntil - Date.now());
    return;
  }
  const lines = store.get(callSid)?.transcript.length ?? 0;
  if (!partial && (lines === 0 || lines === state.checkedLines)) return; // nothing new since the last check
  state.inFlight = true;
  state.pending = false;
  try {
    if (state.mode === 'jev') {
      await jevCheck(callSid, state, partial);
      state.failures = 0;
    } else {
      await llmCheck(callSid, state);
    }
    if (!partial) state.checkedLines = lines;
  } catch (err: any) {
    // Never let scoring problems touch the call: log, back off, then retry with the latest transcript.
    if (state.mode === 'jev') {
      state.failures++;
      const wait = Math.min(JEV_MAX_BACKOFF_MS, err?.retryAfterMs ?? 1000 * 2 ** (state.failures - 1));
      state.backoffUntil = Date.now() + wait;
      if (!partial) state.pending = true;
      log.error('jev', `${shortSid(callSid)}: check failed (${state.failures} in a row), retry in ${Math.round(wait / 1000)}s: ${err?.message ?? err}`);
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
  if (state.pending && calls.get(callSid) === state) void requestCheck(callSid, state);
}

/** A caller sentence ended: zero-delay keyword fast path, then a check on the latest transcript. */
function sentenceEnded(callSid: string, state: CallState): void {
  const sentence = state.sentence.join(' ');
  state.sentence = [];
  if (state.longSpeech) clearTimeout(state.longSpeech);
  state.longSpeech = null;
  state.partial = '';
  if (sentence && !state.detected && codeRequest(sentence)) {
    const d = codeRequestDecision(false);
    log.info('jev', `${shortSid(callSid)} fast path: caller asks for a code  WARN (${d.rule})`);
    emitJev(callSid, state, d);
  }
  void requestCheck(callSid, state);
}

function newState(mode: 'jev' | 'llm'): CallState {
  return {
    mode, inFlight: false, pending: false, checkedLines: 0, partial: '', longSpeech: null, sentence: [], retry: null, detected: false,
    prevScore: null, warnReason: '', failures: 0, backoffUntil: 0,
    tracker: new RiskTracker(), last: null,
    signalsSoFar: { urgency: false, threat: false, data_request: false, transfer_request: false },
  };
}

/**
 * Checks each call when a caller sentence ends (speech-to-text end of utterance) and emits
 * risk-update / scam-detected. Protected-person lines are part of the transcript but don't trigger
 * a check. If the caller talks for LONG_SPEECH_CHECK_MS without a final result, the partial text is checked.
 */
export function setupDetector(): void {
  const mode = config.detector === 'llm' ? 'llm' : 'jev';
  if (mode === 'jev' && !config.jev.apiKey) log.error('jev', 'JEV_API_KEY not set: scam detection will fail until it is');
  log.info('detector', `${mode === 'jev'
    ? `Jev ${config.jev.model} at the end of each caller sentence (warn: score >= ${config.jev.warnScore} & conf >= ${config.jev.warnConfidence}, or >= ${config.jev.highScore} twice, or money/codes + authority, or a code request; fallback ${config.jev.fallback})`
    : `chat model ${currentProvider()} at the end of each caller sentence`}, long-speech check after ${config.jev.longSpeechCheckMs}ms`);

  const stateOf = (callSid: string) => {
    let s = calls.get(callSid);
    if (!s) calls.set(callSid, (s = newState(mode)));
    return s;
  };

  bus.on('transcript-update', ({ callSid, speaker, text, isFinal, endOfSpeech }) => {
    if (callSid.startsWith('DEMO-')) return; // scripted demo replays carry their own scores (SIM- calls run the real detector)
    const s = stateOf(callSid);
    if (speaker !== 'caller') {
      // Guardian: what the protected person says (reading a code, "I'll go to the bank now") is the strongest
      // escalation signal, so the end of their sentence triggers a check too.
      if (isFinal && WAKE_WORD.test(text)) bus.emit('guardian:ask', { callSid, text });
      if (isFinal && endOfSpeech) void requestCheck(callSid, s);
      return;
    }
    if (!isFinal) {
      s.partial = text;
      // Backup for long speech: no final result for LONG_SPEECH_CHECK_MS, check what was said so far.
      if (!s.longSpeech) {
        let checked = '';
        const fire = () => {
          if (calls.get(callSid) !== s || !s.partial) { s.longSpeech = null; return; }
          // Final segments of this sentence are already in the transcript; only the unfinished words are added.
          if (s.partial !== checked) void requestCheck(callSid, s, (checked = s.partial));
          s.longSpeech = setTimeout(fire, config.jev.longSpeechCheckMs);
        };
        s.longSpeech = setTimeout(fire, config.jev.longSpeechCheckMs);
      }
      return;
    }
    // A final result restarts the long-speech clock (it measures time without one).
    s.partial = '';
    if (s.longSpeech) clearTimeout(s.longSpeech);
    s.longSpeech = null;
    s.sentence.push(text);
    if (endOfSpeech) sentenceEnded(callSid, s);
  });

  // Deepgram UtteranceEnd: the sentence ended even though endpointing never marked it (background noise).
  bus.on('utterance-end', ({ callSid, speaker }) => {
    const s = calls.get(callSid);
    if (speaker === 'caller' && s?.sentence.length) sentenceEnded(callSid, s);
    else if (speaker !== 'caller' && s) void requestCheck(callSid, s);
  });

  bus.on('call:ended', ({ callSid }) => {
    const state = calls.get(callSid);
    if (state?.longSpeech) clearTimeout(state.longSpeech);
    if (state?.retry) clearTimeout(state.retry);
    calls.delete(callSid);
  });
}
