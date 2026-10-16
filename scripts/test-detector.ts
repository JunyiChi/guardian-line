/**
 * Replays every transcript in data/test-scripts through the real detector, line by line, on a
 * realistic call clock, and prints a results table.
 *
 *   npm run test:detector -- [name-filter] [--detector=jev|llm] [--provider=gemini|anthropic] [--country=US] [--realtime]
 *
 * Timing: each line takes as long as it would to say it (~2.6 words/s) plus a 0.6s pause, like
 * final speech-to-text results arriving during a call. The detector runs exactly as live:
 *  - jev (default): every CHECK_INTERVAL_MS, only when a new final line arrived, never overlapping.
 *  - llm: the chat model every 8s with smoothing (the old detector).
 * The call clock is simulated (each check still takes its real response time) so a run doesn't take
 * 15 minutes; --realtime waits for real instead. Files named scam-* should warn; normal-* should not.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../src/config';
import { getCountry } from '../src/config/countries';
import { RiskTracker, scoreTranscript } from '../src/detector';
import { askJev, buildTranscript, decide, JEV_SIGNALS, JevLine, levelLabel } from '../src/detector/jev';
import { SCAM_TYPES } from '../src/detector/prompt';
import { currentModel, currentProvider } from '../src/detector/providers';

const DIR = path.join(__dirname, '..', 'data', 'test-scripts');
const WORDS_PER_SEC = 2.6;
const PAUSE_S = 0.6;
const LLM_INTERVAL_MS = 8000;

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Line extends JevLine { at: number }

function parse(file: string): Line[] {
  let t = 0;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const m = l.match(/^\s*(caller|protected)\s*:\s*(.*)$/i);
    const text = m ? m[2] : l;
    t += text.split(/\s+/).length / WORDS_PER_SEC + PAUSE_S;
    return { speaker: (m?.[1].toLowerCase() ?? 'caller') as 'caller' | 'protected', text, at: t * 1000 };
  });
}

interface Result {
  warnLine: number; warnAt: number; finalRisk: number; scamType: string; signals: string;
  checks: number; errors: number; ms: number[]; cost: number; rule: string;
}

async function runJev(lines: Line[], country: ReturnType<typeof getCountry>, realtime: boolean, verbose: boolean): Promise<Result> {
  const r: Result = { warnLine: -1, warnAt: -1, finalRisk: 0, scamType: '-', signals: '-', checks: 0, errors: 0, ms: [], cost: 0, rule: '' };
  const end = lines.at(-1)!.at + 3000;
  let clock = 0, checked = 0, prev: number | null = null, detected = false, busyUntil = 0, failures = 0, backoffUntil = 0;
  for (let tick = config.jev.checkIntervalMs; tick <= end + config.jev.checkIntervalMs; tick += config.jev.checkIntervalMs) {
    if (realtime) await sleep(Math.max(0, tick - clock));
    clock = tick;
    if (clock < busyUntil || clock < backoffUntil) continue; // previous check still running / backing off
    const n = lines.filter((l) => l.at <= clock).length;
    if (n === 0 || n === checked) continue; // nothing new
    try {
      r.checks++;
      const a = await askJev(buildTranscript(lines.slice(0, n)).text, country);
      busyUntil = clock + a.ms;
      checked = n;
      failures = 0;
      const d = decide(a, prev, detected);
      prev = a.score;
      r.ms.push(a.ms);
      r.cost += a.cost;
      r.finalRisk = d.risk;
      r.scamType = a.scamType;
      r.signals = [...d.detected].map((k) => SHORT[k]).join(',') || '-';
      if (verbose) {
        const probs = JEV_SIGNALS.map((k) => `${SHORT[k]} ${Math.round(a.probabilities[k] * 100)}`).join(' ');
        console.log(`  ${(clock / 1000).toFixed(1).padStart(5)}s lines 1-${String(n).padEnd(2)} score ${a.score.toFixed(2)} conf ${a.confidence.toFixed(2)} risk ${String(d.risk).padStart(3)} ${d.status.padEnd(8)} ${String(a.ms).padStart(4)}ms | ${probs} | ${a.scamType}${d.warn && !detected ? `  <-- WARN (${d.rule})` : ''}`);
      }
      if (d.warn && !detected) {
        detected = true;
        r.warnLine = n;
        r.warnAt = clock + a.ms;
        r.rule = d.rule;
        if (verbose) console.log(`         reason: ${d.reason}`);
      }
    } catch (err: any) {
      r.errors++;
      failures++;
      backoffUntil = clock + Math.min(15000, err?.retryAfterMs ?? 1000 * 2 ** (failures - 1));
      console.log(`  ${(clock / 1000).toFixed(1).padStart(5)}s ERROR (check skipped): ${err?.message ?? err}`);
    }
  }
  return r;
}

async function runLlm(lines: Line[], country: ReturnType<typeof getCountry>, verbose: boolean): Promise<Result> {
  const r: Result = { warnLine: -1, warnAt: -1, finalRisk: 0, scamType: '-', signals: '-', checks: 0, errors: 0, ms: [], cost: 0, rule: 'smoothed >= 70' };
  const tracker = new RiskTracker();
  const end = lines.at(-1)!.at + 3000;
  let checked = 0;
  for (let clock = LLM_INTERVAL_MS; clock <= end + LLM_INTERVAL_MS; clock += LLM_INTERVAL_MS) {
    const n = lines.filter((l) => l.at <= clock).length;
    if (n === 0 || n === checked) continue;
    checked = n;
    try {
      r.checks++;
      const a = await scoreTranscript({ transcript: lines.slice(0, n).map((l) => `${l.speaker}: ${l.text}`).join('\n'), country, language: 'en' });
      r.ms.push(a.ms);
      const { smoothed, crossed } = tracker.add(a.risk, 70);
      r.finalRisk = smoothed;
      r.scamType = a.scamType;
      r.signals = Object.entries(a.signals).filter(([, v]) => v).map(([k]) => k.replace('_request', '')).join(',') || '-';
      if (verbose) console.log(`  ${(clock / 1000).toFixed(1).padStart(5)}s lines 1-${String(n).padEnd(2)} raw ${String(a.risk).padStart(3)} smoothed ${String(smoothed).padStart(3)} ${String(a.ms).padStart(5)}ms ${a.scamType}${crossed ? '  <-- WARN' : ''}`);
      if (crossed) { r.warnLine = n; r.warnAt = clock + a.ms; }
    } catch (err: any) {
      r.errors++;
      console.log(`  ${(clock / 1000).toFixed(1).padStart(5)}s ERROR (check skipped): ${err?.message ?? err}`);
    }
  }
  return r;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const detector = (opt('detector') ?? 'jev').toLowerCase();
  if (detector !== 'jev' && detector !== 'llm') throw new Error('--detector must be jev or llm');
  if (opt('provider')) config.llm.provider = opt('provider')!.toLowerCase();
  const country = getCountry(opt('country') ?? config.country);
  const realtime = args.includes('--realtime');
  const verbose = !args.includes('--quiet');
  const filter = args.find((a) => !a.startsWith('--')) ?? '';

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.txt') && f.includes(filter)).sort();
  console.log(detector === 'jev'
    ? `detector=jev model=${config.jev.model} interval=${config.jev.checkIntervalMs}ms warn: score>=${config.jev.warnScore} & conf>=${config.jev.warnConfidence} | score>=${config.jev.highScore} twice | money/codes+authority (signal >= ${config.jev.signalThreshold}) country=${country.code}`
    : `detector=llm provider=${currentProvider()} ${currentModel('fast')} -> ${currentModel('precise')} country=${country.code}`);
  console.log(`clock: ${realtime ? 'real time' : 'simulated call time (real response times)'}\n`);

  const rows: string[][] = [];
  let failures = 0, falseAlarms = 0, missed = 0, totalCost = 0;
  const allMs: number[] = [];
  for (const file of files) {
    const id = file.replace('.txt', '');
    const lines = parse(path.join(DIR, file));
    console.log(`=== ${id} (${lines.length} lines, ${(lines.at(-1)!.at / 1000).toFixed(0)}s)`);
    const r = detector === 'jev' ? await runJev(lines, country, realtime, verbose) : await runLlm(lines, country, verbose);
    const scam = id.startsWith('scam');
    const warned = r.warnLine >= 0;
    if (!scam && warned) falseAlarms++;
    if (scam && !warned) missed++;
    const ok = !r.errors && scam === warned;
    if (!ok) failures++;
    totalCost += r.cost;
    allMs.push(...r.ms);
    const want = expectedTypes(id);
    const avg = r.ms.length ? Math.round(r.ms.reduce((a, b) => a + b, 0) / r.ms.length) : 0;
    rows.push([
      r.errors ? 'ERROR' : ok ? 'PASS' : scam ? 'MISSED' : 'FALSE ALARM',
      id,
      scam ? 'scam' : 'normal',
      String(r.finalRisk),
      `${r.scamType}${want.includes(r.scamType) ? '' : ' (?)'}`,
      r.signals,
      warned ? `line ${r.warnLine}/${lines.length} @ ${(r.warnAt / 1000).toFixed(1)}s` : '-',
      String(r.checks),
      avg ? `${avg} ms` : '-',
      detector === 'jev' ? `$${r.cost.toFixed(5)}` : '-',
    ]);
    console.log('');
  }

  const head = ['result', 'script', 'expected', 'final risk', 'scam type', 'detected signals', 'warning at', 'checks', 'avg time', 'cost'];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => '| ' + r.map((c, i) => c.padEnd(width[i])).join(' | ') + ' |';
  console.log('--- summary ---');
  console.log(fmt(head));
  console.log('|' + width.map((w) => '-'.repeat(w + 2)).join('|') + '|');
  rows.forEach((r) => console.log(fmt(r)));
  const avgAll = allMs.length ? Math.round(allMs.reduce((a, b) => a + b, 0) / allMs.length) : 0;
  console.log(`\n${rows.length - failures}/${rows.length} passed · false alarms ${falseAlarms} · missed scams ${missed} · avg response ${avgAll} ms over ${allMs.length} checks${detector === 'jev' ? ` · total cost $${totalCost.toFixed(5)} ($${(totalCost / Math.max(1, allMs.length)).toFixed(6)}/check)` : ''}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
