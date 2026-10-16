import type { JevSignal, RiskStatus, Signals } from '../events';
import { config } from '../config';
import type { CountryProfile } from '../config/countries';
import { log } from '../privacy/log';
import { SCAM_TYPES } from './prompt';
import { buildReason, impersonatingFor } from './reason';

/**
 * Jev, TypeSafe's decision model, via Defapi's Decisions API (config.jev.url). One request per check returns
 * typed answers with probabilities: no free text, so the alert reason is built from templates.
 */

export const JEV_SIGNALS: JevSignal[] = ['urgency', 'threat', 'asks_for_codes_or_data', 'asks_for_money', 'impersonating_authority', 'asks_for_secrecy'];

export const LEVELS = [
  'Not a scam: normal conversation, no pressure, no requests for money or codes',
  'Unlikely: small oddities but no warning signs',
  'Possible: one warning sign such as urgency, a threat, or claiming to be an authority',
  'High chance: several warning signs together',
  'Definitely a scam: asks for money, codes, or personal data while pressuring or impersonating an authority',
];
export const LEVEL_NAMES = LEVELS.map((l) => l.split(':')[0]);

const SCAM_TYPE_CRITERIA: Record<(typeof SCAM_TYPES)[number], string> = {
  government_impersonation: 'Caller pretends to be a tax agency, social security, immigration, customs or another government office.',
  police_legal: 'Caller pretends to be police, a court or a lawyer: arrest warrant, investigation, legal threat.',
  bank_fraud_department: "Caller pretends to be the bank's or card's fraud team and says the account is compromised.",
  tech_support: 'Caller pretends to be Microsoft, Apple or internet-provider support: virus, hacked computer.',
  grandparent_family_emergency: 'Caller pretends to be a grandchild, child or relative in trouble who needs money now.',
  romance: 'An online relationship that turns into requests for money.',
  investment_crypto: 'Guaranteed high returns, crypto, forex or gold investment.',
  prize_lottery: 'Won a prize or lottery but must pay a fee or tax first.',
  delivery_parcel: 'Courier or postal service: missed delivery, customs fee, illegal parcel.',
  refund_overpayment: '"We refunded you too much", send the difference back.',
  utility_shutoff: 'Electricity, gas or water will be cut off unless paid now.',
  remote_access_app: 'Main story is getting the person to install a remote-control app.',
  gift_card_payment: 'Main story is paying with gift cards and reading out the numbers.',
  crypto_atm_payment: 'Main story is depositing cash into a crypto or Bitcoin ATM.',
  mule_account: 'Asks to receive and forward money, or to open or lend a bank account.',
  job_task: 'Online job or task that requires paying a deposit first.',
  donation_charity: 'Fake charity or disaster appeal pushing for immediate payment.',
  other: 'Clearly a scam, but none of the types above.',
  none: 'No scam: a normal call, or too little said to tell.',
};

const noul = (instructions: string, yes: string, no: string) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });

/** The question set. Identical on every request, so the payload stays small and stable. */
export const QUESTIONS = {
  scam_likelihood: {
    type: 'score',
    instructions: 'How likely is it that the caller in this phone call transcript is a scammer trying to take money or personal information from the protected person?',
    criteria: LEVELS,
  },
  urgency: noul('Does the caller pressure the protected person to act immediately?',
    'The caller demands action right now, today, or within a short deadline, or says there is no time to think or check.',
    'The caller does not push for immediate action; any timing mentioned is normal, like an appointment time.'),
  threat: noul('Does the caller threaten the protected person with arrest, legal action, account closure, or harm?',
    'The caller threatens arrest, a warrant, prosecution, fines, a frozen or closed account, losing money, a cut-off service, or other harm.',
    'The caller makes no threats.'),
  asks_for_codes_or_data: noul('Does the caller ask for codes, passwords or personal data, to install an app, or to click a link?',
    'The caller asks for a verification code, one-time passcode, PIN, password, ID or Social Security number, bank or card details, to install an app, or to click a link.',
    'The caller does not ask for any codes, credentials, personal numbers, app installs or links. Asking "was that you?" about a purchase is not a request for data.'),
  asks_for_money: noul('Does the caller ask the protected person to send, move or pay money?',
    'The caller asks to send or move money, transfer to a "safe account", buy gift cards, use crypto or a crypto ATM, wire money, hand cash to a courier, or pay a fee before receiving something.',
    'The caller does not ask for any payment or money movement. Paying a known bill the person expects is not this.'),
  impersonating_authority: noul('Does the caller claim to be police, government, a bank, a tech company, a delivery company, or a relative in trouble?',
    'The caller says they are police, a government agency, a bank or its fraud team, a tech company, a delivery company, or a relative in trouble.',
    'The caller does not claim any of these identities.'),
  asks_for_secrecy: noul('Does the caller tell the protected person to keep this secret, not tell anyone, or not hang up?',
    'The caller says not to tell family, the bank or anyone, not to hang up, to stay on the line, or that the matter is confidential.',
    'The caller does not ask for secrecy and does not insist on staying on the line.'),
  scam_type: {
    type: 'choice',
    instructions: 'Which kind of phone scam best describes what the caller is doing? Choose "none" for a normal call.',
    criteria: SCAM_TYPE_CRITERIA,
  },
};

export interface JevLine { speaker: 'caller' | 'protected'; text: string }

/** "Caller: ..." / "Protected person: ..." lines, newest kept when over MAX_TRANSCRIPT_BYTES. */
export function buildTranscript(lines: JevLine[], maxBytes = config.jev.maxTranscriptBytes): { text: string; truncated: boolean } {
  const label = (l: JevLine) => `${l.speaker === 'caller' ? 'Caller' : 'Protected person'}: ${l.text}`;
  const out: string[] = [];
  const omitted = '(Earlier part of the call omitted)';
  let bytes = Buffer.byteLength(omitted) + 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = label(lines[i]);
    const b = Buffer.byteLength(s) + 1;
    if (bytes + b > maxBytes) return { text: [omitted, ...out.reverse()].join('\n'), truncated: true };
    out.push(s);
    bytes += b;
  }
  return { text: out.reverse().join('\n'), truncated: false };
}

export class JevError extends Error {
  constructor(message: string, public status?: number, public retryAfterMs?: number) {
    super(message);
  }
}

export interface JevAnswer {
  /** scam_likelihood: probability-weighted position 0-4. */
  score: number;
  confidence: number;
  levelProbabilities: number[];
  probabilities: Record<JevSignal, number>;
  scamType: string;
  scamTypeConfidence: number;
  ms: number;
  cost: number;
  model: string;
}

/** One Decisions API call. Throws JevError on timeout, HTTP errors and malformed answers. */
export async function askJev(transcript: string, country: CountryProfile): Promise<JevAnswer> {
  if (!config.jev.apiKey) throw new JevError('JEV_API_KEY not set');
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(config.jev.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.jev.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.jev.model, state: { transcript, country: country.name }, questions: QUESTIONS }),
      signal: AbortSignal.timeout(config.jev.timeoutMs),
    });
  } catch (err: any) {
    throw new JevError(err?.name === 'TimeoutError' ? `timeout after ${config.jev.timeoutMs}ms` : `network error: ${err?.message ?? err}`);
  }
  const ms = Math.round(performance.now() - t0);
  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    const ra = Number(res.headers.get('retry-after'));
    throw new JevError(`HTTP ${res.status}: ${String(body?.error?.message ?? res.statusText).slice(0, 200)}`, res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
  }
  const a = body?.answers;
  const s = a?.scam_likelihood;
  if (typeof s?.score !== 'number') throw new JevError('response has no scam_likelihood score');
  const probabilities = {} as Record<JevSignal, number>;
  for (const k of JEV_SIGNALS) {
    const p = a?.[k]?.noul;
    if (typeof p !== 'number') throw new JevError(`response has no ${k} answer`);
    probabilities[k] = p;
  }
  return {
    score: Math.min(4, Math.max(0, s.score)),
    confidence: typeof s.confidence === 'number' ? s.confidence : 0,
    levelProbabilities: LEVELS.map((_, i) => Number(s.probabilities?.[i] ?? s.probabilities?.[String(i)] ?? 0)),
    probabilities,
    scamType: SCAM_TYPES.includes(a?.scam_type?.choice) ? a.scam_type.choice : 'other',
    scamTypeConfidence: typeof a?.scam_type?.confidence === 'number' ? a.scam_type.confidence : 0,
    ms,
    cost: Number(body?.usage?.cost ?? 0),
    model: String(body?.model ?? config.jev.model),
  };
}

/** Where the score sits between two levels, e.g. "High chance → Definitely a scam". */
export function levelLabel(score: number): string {
  const lo = Math.floor(score), hi = Math.ceil(score);
  if (hi === lo || score - lo < 0.15) return LEVEL_NAMES[lo];
  if (hi - score < 0.15) return LEVEL_NAMES[hi];
  return `${LEVEL_NAMES[lo]} → ${LEVEL_NAMES[hi]}`;
}

export const riskOf = (score: number) => Math.round((score / 4) * 100);
export const statusOf = (risk: number): RiskStatus => (risk >= 70 ? 'scam' : risk >= 40 ? 'watching' : 'safe');

export interface JevDecision {
  risk: number;
  status: RiskStatus;
  /** True when a warning rule fired on this check. */
  warn: boolean;
  rule: string;
  detected: Set<JevSignal>;
  signals: Signals;
  impersonating: string;
  reason: string;
}

/**
 * Decision rules. Warn when:
 *  1. score >= JEV_WARN_SCORE and confidence >= JEV_WARN_CONFIDENCE, or
 *  2. score >= JEV_HIGH_SCORE on this check and the previous one, or
 *  3. (asks_for_money or asks_for_codes_or_data) together with impersonating_authority.
 * `alreadyDetected` keeps the status at 'scam' for the rest of the call.
 */
export function decide(a: JevAnswer, prevScore: number | null, alreadyDetected: boolean): JevDecision {
  const th = config.jev.signalThreshold;
  const detected = new Set(JEV_SIGNALS.filter((k) => a.probabilities[k] >= th));
  const risk = riskOf(a.score);
  let rule = '';
  if (a.score >= config.jev.warnScore && a.confidence >= config.jev.warnConfidence) rule = 'high score + confidence';
  else if (a.score >= config.jev.highScore && prevScore !== null && prevScore >= config.jev.highScore) rule = 'high score twice in a row';
  else if ((detected.has('asks_for_money') || detected.has('asks_for_codes_or_data')) && detected.has('impersonating_authority')) rule = 'money/codes request + authority';
  const status: RiskStatus = alreadyDetected || rule ? 'scam' : statusOf(risk);
  const impersonating = impersonatingFor(a.scamType, detected.has('impersonating_authority'));
  return {
    risk,
    status,
    warn: !!rule,
    rule,
    detected,
    signals: {
      urgency: detected.has('urgency'),
      threat: detected.has('threat'),
      data_request: detected.has('asks_for_codes_or_data'),
      transfer_request: detected.has('asks_for_money'),
    },
    impersonating,
    reason: buildReason({ detected, scamType: a.scamType, impersonating, status, probabilities: a.probabilities }),
  };
}

const SHORT: Record<JevSignal, string> = {
  urgency: 'urgency', threat: 'threat', asks_for_codes_or_data: 'codes', asks_for_money: 'money',
  impersonating_authority: 'authority', asks_for_secrecy: 'secrecy',
};
/** "[Wessuwan] [jev] 0.4s $0.00002 → score 3.8 (High chance → Definitely a scam), conf 0.92, signals: money, authority, secrecy" */
export function logCheck(a: JevAnswer, d: JevDecision, ref: string): void {
  const sigs = [...d.detected].map((k) => SHORT[k]).join(', ') || 'none';
  log.info('jev', `${ref ? ref + ' ' : ''}${(a.ms / 1000).toFixed(1)}s $${a.cost.toFixed(5)} → score ${a.score.toFixed(1)} (${levelLabel(a.score)}), conf ${a.confidence.toFixed(2)}, signals: ${sigs}${d.warn ? `  WARN (${d.rule})` : ''}`);
}
