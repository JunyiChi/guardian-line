import fs from 'fs';
import path from 'path';
import type { JevSignal } from '../events';

/** Reason templates from locales/en.json (no chat model needed to explain a warning). */
const T = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'locales', 'en.json'), 'utf8')).reasons as {
  claims: Record<string, string>;
  stories: Record<string, string>;
  noClaim: string;
  actions: Record<string, string>;
  and: string;
  normal: string;
  watching: string;
  scamTail: string;
};

/** Who the caller pretends to be, from the scam type (Jev's authority signal alone doesn't say which). */
const CLAIM_BY_TYPE: Record<string, string> = {
  bank_fraud_department: 'bank', police_legal: 'police', government_impersonation: 'government',
  tech_support: 'tech_company', remote_access_app: 'tech_company', delivery_parcel: 'delivery_company',
  utility_shutoff: 'utility', grandparent_family_emergency: 'relative',
};
export function impersonatingFor(scamType: string, authority: boolean): string {
  return CLAIM_BY_TYPE[scamType] ?? (authority ? 'authority' : 'none');
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} ${T.and} ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, ${T.and} ${parts.at(-1)}`;
}

/**
 * "Caller claims to be from your bank, asks you to move money, and says to keep it secret."
 * Order: claim, the most dangerous requests first, then pressure tactics.
 */
/** A signal this likely is named in a warning when nothing reached the detection threshold. */
const LEANING = 0.3;

export function buildReason(opts: {
  detected: Set<JevSignal>; scamType: string; impersonating: string; status: 'safe' | 'watching' | 'scam';
  probabilities?: Partial<Record<JevSignal, number>>;
}): string {
  const { scamType } = opts;
  if (opts.status === 'safe') return T.normal;
  let d = opts.detected;
  // A score rule can warn before any single signal is clear: name the two strongest leaning ones.
  const leaning = !d.size && !!opts.probabilities;
  if (leaning) {
    d = new Set((Object.entries(opts.probabilities!) as [JevSignal, number][])
      .filter(([, p]) => p >= LEANING).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k));
  }
  const actions: string[] = [];
  if (d.has('asks_for_money')) actions.push(T.actions[scamType === 'gift_card_payment' || scamType === 'crypto_atm_payment' ? scamType : 'asks_for_money']);
  if (d.has('asks_for_codes_or_data')) actions.push(T.actions[scamType === 'remote_access_app' || scamType === 'tech_support' ? 'remote_access_app' : 'asks_for_codes_or_data']);
  if (d.has('threat')) actions.push(T.actions.threat);
  if (d.has('urgency')) actions.push(T.actions.urgency);
  if (d.has('asks_for_secrecy')) actions.push(T.actions.asks_for_secrecy);

  // Leaning: a scam-type story ("claims you won a prize") beats a vague "official organization".
  const story = leaning ? T.stories[scamType] : undefined;
  const who = leaning && story && !CLAIM_BY_TYPE[scamType] ? 'none' : opts.impersonating;
  const claim = who !== 'none' && (d.has('impersonating_authority') || CLAIM_BY_TYPE[scamType]) ? T.claims[who] : story ?? '';
  if (!claim && !actions.length) return T.watching.replace('{what}', 'the caller shows a warning sign');

  const sentence = claim
    ? `${list([claim, ...actions])}.`
    : `${T.noClaim} ${list(actions)}.`;
  if (opts.status === 'scam') return opts.impersonating === 'relative' || opts.impersonating === 'none' ? sentence : `${sentence} ${T.scamTail}`;
  if (opts.status === 'watching') return T.watching.replace('{what}', sentence.replace(/\.$/, '').replace(/^Caller/, 'the caller'));
  return sentence;
}
