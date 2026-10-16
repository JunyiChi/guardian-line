/**
 * Replays every transcript in data/test-scripts through the real detector, line by line, on a
 * realistic call clock, and prints a timeline per script and a results table.
 *
 *   npm run test:detector -- [name-filter] [--detector=jev|llm] [--provider=gemini|anthropic] [--country=US] [--long-speech] [--quiet]
 *
 * Timing: each line takes as long as it would to say it (~2.6 words/s). Each caller line is a finished
 * sentence: its check starts when it ends, exactly as live. The protected person replies after a
 * short pause. The detector runs as in a live call:
 *  - the keyword fast path checks every caller sentence with zero delay (code requests);
 *  - one check at a time; a sentence that ends while a check runs is checked right after it, with the latest transcript;
 *  - --long-speech: a caller line longer than LONG_SPEECH_CHECK_MS also gets a check on its partial text every
 *    LONG_SPEECH_CHECK_MS, as if speech-to-text gave no final result until the line ended. Off by default:
 *    each script line is one finished sentence, and live speech-to-text finalizes long speech in pieces.
 * The call clock is simulated (each check still takes its real response time), so a run doesn't take
 * 15 minutes. Files named scam-* should warn; normal-* should not. A script where the caller asks for
 * a code must warn on that line, before the protected person answers.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../src/config';
import { getCountry } from '../src/config/countries';
import { RiskTracker, scoreTranscript } from '../src/detector';
import { askJev, buildTranscript, codeRequest, decide, JEV_SIGNALS, JevLine } from '../src/detector/jev';
import { SCAM_TYPES } from '../src/detector/prompt';
import { currentModel, currentProvider } from '../src/detector/providers';

const DIR = path.join(__dirname, '..', 'data', 'test-scripts');
const WORDS_PER_SEC = 2.6;
/** Pause before the caller's next sentence, and before the protected person's reply. */
const CALLER_PAUSE_S = 0.6;
const REPLY_PAUSE_S = 1.0;

/** Expected scamType(s) per script (soft check: shown, not failed). */
const EXPECTED: Record<string, string[]> = {
  'scam-01-fake-irs': ['government_impersonation', 'gift_card_payment'],
  'scam-02-fake-social-security': ['government_impersonation'],
  'scam-03-bank-fraud-department': ['bank_fraud_department'],
  'scam-04-grandparent-emergency': ['grandparent_family_emergency'],
  'scam-05-tech-support': ['tech_support', 'remote_access_app'],
  'scam-06-gift-card-payment': ['gift_card_payment', 'utility_shutoff'],
  'scam-07-crypto-atm': ['crypto_atm_payment', 'police_legal'],
  'scam-08-crypto-investment': ['investment_crypto', 'romance'],
  'scam-09-delivery-fee': ['delivery_parcel'],
  'scam-10-utility-shutoff': ['utility_shutoff'],
  'scam-11-prize-lottery': ['prize_lottery'],
};
const expectedTypes = (id: string) => (id.startsWith('normal') ? ['none'] : EXPECTED[id] ?? [SCAM_TYPES.find((t) => id.includes(t)) ?? '?']);
const SHORT: Record<string, string> = {
  urgency: 'urg', threat: 'thr', asks_for_codes_or_data: 'codes', asks_for_money: 'money', impersonating_authority: 'auth', asks_for_secrecy: 'secret',
};
const s1 = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

interface Line extends JevLine { start: number; end: number }

function parse(file: string): Line[] {
  let t = 0;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    const m = l.match(/^\s*(caller|protected)\s*:\s*(.*)$/i);
    const speaker = (m?.[1].toLowerCase() ?? 'caller') as 'caller' | 'protected';
    const text = m ? m[2] : l;
    if (i > 0) t += speaker === 'protected' ? REPLY_PAUSE_S : CALLER_PAUSE_S;
    const start = t * 1000;
    t += text.split(/\s+/).length / WORDS_PER_SEC;
    return { speaker, text, start, end: t * 1000 };
  });
}

/** One check's outcome, whichever detector ran it. */
interface Check { ms: number; risk: number; status: string; warn: boolean; rule: string; scamType: string; signals: string; cost: number; detail: string; reason: string }
type CheckFn = (lines: JevLine[]) => Promise<Check>;

interface Result {
  warnLine: number; warnAt: number; finalRisk: number; scamType: string; signals: string;
  checks: number; errors: number; ms: number[]; cost: number; rule: string;
  /** The first caller line asking for a code (1-based), and whether the warning came before the reply to it. */
  codeLine: number; codeInTime: boolean;
}

/** A moment a check is wanted: a caller sentence ended, or the long-speech backup fired mid-sentence. */
interface Trigger { at: number; line: number; partial?: string }

/**
 * Simulates the live trigger rules on the call clock and prints the timeline. Each check really
 * calls the detector; its real response time moves the clock.
 */
async function simulate(lines: Line[], check: CheckFn, verbose: boolean, longSpeech: boolean): Promise<Result> {
  const r: Result = { warnLine: -1, warnAt: -1, finalRisk: 0, scamType: '-', signals: '-', checks: 0, errors: 0, ms: [], cost: 0, rule: '', codeLine: -1, codeInTime: true };
  const triggers: Trigger[] = [];
  lines.forEach((l, i) => {
    if (l.speaker !== 'caller') return;
    const words = l.text.split(/\s+/);
    for (let at = l.start + config.jev.longSpeechCheckMs; longSpeech && at < l.end; at += config.jev.longSpeechCheckMs) {
      const said = Math.floor(((at - l.start) / 1000) * WORDS_PER_SEC);
      triggers.push({ at, line: i, partial: words.slice(0, said).join(' ') });
    }
    triggers.push({ at: l.end, line: i });
  });
  triggers.sort((a, b) => a.at - b.at);

  const notes = new Map<number, string[]>(); // line index -> timeline notes, printed under the line
  const note = (i: number, s: string) => notes.set(i, [...(notes.get(i) ?? []), s]);
  const warn = (at: number, line: number, rule: string) => {
    if (r.warnAt >= 0 && r.warnAt <= at) return false;
    Object.assign(r, { warnAt: at, warnLine: line + 1, rule });
    return true;
  };

  let busyUntil = 0, failures = 0, backoffUntil = 0;
  let pending: number | null = null; // line of the newest sentence that ended while a check ran
  const run = async (t: Trigger) => {
    const at = Math.max(t.at, busyUntil, backoffUntil);
    const upTo = lines.filter((l) => l.end <= at && !(t.partial && l === lines[t.line]));
    const sent = t.partial ? [...upTo, { speaker: 'caller' as const, text: t.partial }] : upTo;
    r.checks++;
    try {
      const c = await check(sent);
      busyUntil = at + c.ms;
      failures = 0;
      r.ms.push(c.ms);
      r.cost += c.cost;
      Object.assign(r, { finalRisk: c.risk, scamType: c.scamType, signals: c.signals });
      const first = c.warn && warn(busyUntil, t.line, c.rule);
      note(t.line, `${t.partial ? 'partial check' : 'check'} ${s1(at)} → ${s1(busyUntil)}${at > t.at ? ` (waited ${s1(at - t.at)})` : ''}  risk ${String(c.risk).padStart(3)} ${c.status.padEnd(8)} | ${c.detail}${first ? `  <-- WARN (${c.rule})` : ''}`);
      if (first) note(t.line, `reason: ${c.reason}`);
    } catch (err: any) {
      r.errors++;
      failures++;
      backoffUntil = at + Math.min(15000, err?.retryAfterMs ?? 1000 * 2 ** (failures - 1));
      pending = t.line; // retried with the latest transcript after the backoff
      note(t.line, `check ${s1(at)} ERROR, retry after ${s1(backoffUntil)}: ${err?.message ?? err}`);
    }
  };

  for (const t of triggers) {
    // A pending sentence runs as soon as the current check finishes, before anything later.
    while (pending !== null && Math.max(busyUntil, backoffUntil) <= t.at) {
      const line = pending;
      pending = null;
      await run({ at: Math.max(busyUntil, backoffUntil), line });
    }
    if (!t.partial && lines[t.line].speaker === 'caller' && codeRequest(lines[t.line].text)) {
      if (r.codeLine < 0) r.codeLine = t.line + 1;
      if (warn(t.at, t.line, 'code request (keyword)')) note(t.line, `fast path ${s1(t.at)}: caller asks for a code  <-- WARN (code request (keyword))`);
    }
    if (t.at < busyUntil || t.at < backoffUntil) {
      if (t.partial) note(t.line, `partial check at ${s1(t.at)} skipped (a check is running)`);
      else pending = t.line;
      continue;
    }
    await run(t);
  }
  while (pending !== null) {
    const line = pending;
    pending = null;
    await run({ at: Math.max(busyUntil, backoffUntil), line });
  }

  if (r.codeLine > 0) {
    const reply = lines.slice(r.codeLine).find((l) => l.speaker === 'protected');
    r.codeInTime = r.warnAt >= 0 && r.warnLine <= r.codeLine && (!reply || r.warnAt <= reply.start);
  }
  if (verbose) {
    lines.forEach((l, i) => {
      console.log(`  ${s1(l.end).padStart(6)} L${String(i + 1).padEnd(2)} ${l.speaker === 'caller' ? 'caller' : 'me    '} ${l.text.length > 90 ? l.text.slice(0, 87) + '...' : l.text}`);
      for (const n of notes.get(i) ?? []) console.log(`               ${n}`);
    });
  }
  return r;
}

const jevCheck = (country: ReturnType<typeof getCountry>) => {
  let prev: number | null = null, detected = false;
  return async (lines: JevLine[]): Promise<Check> => {
    const a = await askJev(buildTranscript(lines).text, country);
    const d = decide(a, prev, detected);
    prev = a.score;
    const first = d.warn && !detected;
    if (d.warn) detected = true;
    return {
      ms: a.ms, risk: d.risk, status: d.status, warn: first, rule: d.rule, scamType: a.scamType, cost: a.cost, reason: d.reason,
      signals: [...d.detected].map((k) => SHORT[k]).join(',') || '-',
      detail: `score ${a.score.toFixed(2)} conf ${a.confidence.toFixed(2)} ${a.ms}ms | ${JEV_SIGNALS.map((k) => `${SHORT[k]} ${Math.round(a.probabilities[k] * 100)}`).join(' ')} | ${a.scamType}`,
    };
  };
};

const llmCheck = (country: ReturnType<typeof getCountry>) => {
  const tracker = new RiskTracker();
  return async (lines: JevLine[]): Promise<Check> => {
    const a = await scoreTranscript({ transcript: lines.map((l) => `${l.speaker}: ${l.text}`).join('\n'), country, language: 'en' });
    const { smoothed, crossed } = tracker.add(a.risk, 70);
    return {
      ms: a.ms, risk: smoothed, status: smoothed >= 70 ? 'scam' : smoothed >= 40 ? 'watching' : 'safe', warn: crossed, rule: 'smoothed >= 70',
      scamType: a.scamType, cost: 0, reason: a.reason,
      signals: Object.entries(a.signals).filter(([, v]) => v).map(([k]) => k.replace('_request', '')).join(',') || '-',
      detail: `raw ${a.risk} ${a.ms}ms ${a.tier} | ${a.scamType}`,
    };
  };
};

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const detector = (opt('detector') ?? 'jev').toLowerCase();
  if (detector !== 'jev' && detector !== 'llm') throw new Error('--detector must be jev or llm');
  if (opt('provider')) config.llm.provider = opt('provider')!.toLowerCase();
  const country = getCountry(opt('country') ?? config.country);
  const verbose = !args.includes('--quiet');
  const longSpeech = args.includes('--long-speech');
  const filter = args.find((a) => !a.startsWith('--')) ?? '';

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.txt') && f.includes(filter)).sort();
  console.log(detector === 'jev'
    ? `detector=jev model=${config.jev.model} trigger=end of each caller sentence${longSpeech ? `, long-speech check every ${config.jev.longSpeechCheckMs}ms` : ''}, keyword fast path for code requests | warn: score>=${config.jev.warnScore} & conf>=${config.jev.warnConfidence} | score>=${config.jev.highScore} twice | money/codes+authority (signal >= ${config.jev.signalThreshold}) country=${country.code}`
    : `detector=llm provider=${currentProvider()} ${currentModel('fast')} -> ${currentModel('precise')} trigger=end of each caller sentence country=${country.code}`);
  console.log('clock: simulated call time (real response times); timeline times are when each line ends\n');

  const rows: string[][] = [];
  let failures = 0, falseAlarms = 0, missed = 0, late = 0, totalCost = 0;
  const allMs: number[] = [];
  for (const file of files) {
    const id = file.replace('.txt', '');
    const lines = parse(path.join(DIR, file));
    console.log(`=== ${id} (${lines.length} lines, ${(lines.at(-1)!.end / 1000).toFixed(0)}s)`);
    const r = await simulate(lines, detector === 'jev' ? jevCheck(country) : llmCheck(country), verbose, longSpeech);
    const scam = id.startsWith('scam');
    const warned = r.warnLine >= 0;
    if (!scam && warned) falseAlarms++;
    if (scam && !warned) missed++;
    if (!r.codeInTime) late++;
    const ok = !r.errors && scam === warned && r.codeInTime;
    if (!ok) failures++;
    totalCost += r.cost;
    allMs.push(...r.ms);
    const want = expectedTypes(id);
    const avg = r.ms.length ? Math.round(r.ms.reduce((a, b) => a + b, 0) / r.ms.length) : 0;
    rows.push([
      r.errors ? 'ERROR' : !r.codeInTime ? 'LATE' : ok ? 'PASS' : scam ? 'MISSED' : 'FALSE ALARM',
      id,
      scam ? 'scam' : 'normal',
      String(r.finalRisk),
      `${r.scamType}${want.includes(r.scamType) ? '' : ' (?)'}`,
      r.signals,
      warned ? `line ${r.warnLine}/${lines.length} @ ${(r.warnAt / 1000).toFixed(1)}s` : '-',
      warned ? r.rule : '-',
      r.codeLine > 0 ? `line ${r.codeLine}: ${r.codeInTime ? 'warned before reply' : 'TOO LATE'}` : '-',
      String(r.checks),
      avg ? `${avg} ms` : '-',
      detector === 'jev' ? `$${r.cost.toFixed(5)}` : '-',
    ]);
    console.log('');
  }

  const head = ['result', 'script', 'expected', 'final risk', 'scam type', 'detected signals', 'warning at', 'rule', 'code request', 'checks', 'avg time', 'cost'];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => '| ' + r.map((c, i) => c.padEnd(width[i])).join(' | ') + ' |';
  console.log('--- summary ---');
  console.log(fmt(head));
  console.log('|' + width.map((w) => '-'.repeat(w + 2)).join('|') + '|');
  rows.forEach((r) => console.log(fmt(r)));
  const avgAll = allMs.length ? Math.round(allMs.reduce((a, b) => a + b, 0) / allMs.length) : 0;
  console.log(`\n${rows.length - failures}/${rows.length} passed · false alarms ${falseAlarms} · missed scams ${missed} · late code warnings ${late} · avg response ${avgAll} ms over ${allMs.length} checks${detector === 'jev' ? ` · total cost $${totalCost.toFixed(5)} ($${(totalCost / Math.max(1, allMs.length)).toFixed(6)}/check)` : ''}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
