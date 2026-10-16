import fs from 'fs';
import path from 'path';
import type { Express, Request, Response } from 'express';
import { config } from '../config';
import { getCountry, listCountries } from '../config/countries';
import { settings } from '../settings';
import { scoreTranscript } from '../detector';
import { applyCodeRequest, askJev, buildTranscript, decide, levelLabel, logCheck } from '../detector/jev';
import { SCAM_TYPE_LABEL } from '../detector/prompt';
import { currentModel, currentProvider } from '../detector/providers';
import { smsText } from '../alerts';
import { WARNING_TEXT, warningAudioFor, warningLang } from '../alerts/tts';
import { log } from '../privacy/log';

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'data', 'test-scripts');
const MAX_CHARS = 6_000;
const MAX_LINES = 80;
const WINDOW_MS = 60 * 60 * 1000;

/** Display titles for the sample picker, keyed by file name. */
const TITLES: Record<string, string> = {
  'scam-01-fake-irs': 'Fake IRS agent threatens arrest',
  'scam-02-fake-social-security': 'Fake Social Security suspension',
  'scam-03-bank-fraud-department': 'Fake bank fraud team, "safe account"',
  'scam-04-grandparent-emergency': 'Grandchild in jail (AI voice story)',
  'scam-05-tech-support': 'Tech support remote access',
  'scam-06-gift-card-payment': 'Power bill paid in gift cards',
  'scam-07-crypto-atm': 'Fake detective, Bitcoin ATM',
  'scam-08-crypto-investment': 'Crypto investment "friend"',
  'scam-09-delivery-fee': 'Parcel delivery fee',
  'scam-10-utility-shutoff': 'Utility shut-off threat',
  'scam-11-prize-lottery': 'Sweepstakes prize, pay taxes first',
  'normal-01-bank-card-check': 'Real bank checks a purchase (normal)',
  'normal-02-doctor-appointment': "Doctor's appointment reminder (normal)",
  'normal-03-delivery-directions': 'Driver asks for directions (normal)',
  'normal-04-grandchild-chat': 'Grandchild calls to chat (normal)',
  'normal-05-charity-no-payment': 'Charity says thank you (normal)',
};

interface Sample { id: string; title: string; kind: 'scam' | 'normal'; lines: string[] }

function loadSamples(): Sample[] {
  try {
    return fs.readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.txt')).sort().map((f) => {
      const id = f.replace(/\.txt$/, '');
      const lines = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return { id, title: TITLES[id] ?? id, kind: id.startsWith('scam') ? 'scam' : 'normal', lines } as Sample;
    });
  } catch {
    return [];
  }
}

/** Fixed-window limiter per client IP; memory only, so it resets on restart (fine for a demo). */
const hits = new Map<string, { count: number; resetAt: number }>();
function takeToken(ip: string): { ok: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || h.resetAt <= now) hits.set(ip, (h = { count: 0, resetAt: now + WINDOW_MS }));
  if (h.count >= config.publicDemo.ratePerHour) return { ok: false, remaining: 0, resetAt: h.resetAt };
  h.count++;
  return { ok: true, remaining: config.publicDemo.ratePerHour - h.count, resetAt: h.resetAt };
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
}, WINDOW_MS).unref();

/** Detects the language of pasted text cheaply from its script; the model writes the reason in it. */
function guessLanguage(text: string, fallback: string): string {
  if (/[぀-ヿ]/.test(text)) return 'ja';
  if (/[一-鿿]/.test(text)) return 'zh';
  if (/\b(der|die|und|nicht|Sie|ich)\b/.test(text) && /[äöüß]/i.test(text)) return 'de';
  if (/\b(usted|dinero|llamada|cuenta|señora)\b/i.test(text)) return 'es';
  if (/\b(vous|votre|argent|appel|compte)\b/i.test(text)) return 'fr';
  return /^[\x00-\x7f\s]*$/.test(text) ? 'en' : fallback;
}

/** "Try it" API: sample scripts + one detector check per request. API keys never leave the server. */
export function setupTryIt(app: Express): void {
  const samples = loadSamples();

  app.get('/api/demo-config', (_req, res) => {
    const country = settings.country();
    res.json({
      publicDemo: config.publicDemo.enabled,
      detector: config.detector,
      jevModel: config.jev.model,
      provider: currentProvider(),
      models: { fast: currentModel('fast'), precise: currentModel('precise') },
      confirmAt: config.llm.confirmAt,
      ratePerHour: config.publicDemo.ratePerHour,
      retentionDays: config.privacy.retentionDays,
      riskThreshold: settings.get().riskThreshold,
      protectedName: settings.get().protectedName,
      country: { code: country.code, name: country.name, reporting: country.reporting, privacyRegime: country.privacyRegime, allPartyConsent: country.allPartyConsent },
      countries: listCountries().map((c) => ({ code: c, name: getCountry(c).name })),
      warning: Object.fromEntries(Object.keys(WARNING_TEXT).map((l) => [l, { text: WARNING_TEXT[l], audio: warningAudioFor(l) }])),
      scamTypes: SCAM_TYPE_LABEL,
      links: config.publicDemo.links,
    });
  });

  app.get('/api/samples', (_req, res) => res.json(samples));

  app.post('/api/check', async (req: Request, res: Response) => {
    const transcript = typeof req.body?.transcript === 'string' ? req.body.transcript.trim() : '';
    if (!transcript) return res.status(400).json({ error: 'empty', message: 'Please pick a sample or type a conversation first.' });
    if (transcript.length > MAX_CHARS || transcript.split('\n').length > MAX_LINES) {
      return res.status(413).json({ error: 'too_long', message: `That conversation is too long (max ${MAX_CHARS} characters / ${MAX_LINES} lines).` });
    }
    const code = typeof req.body?.country === 'string' && listCountries().includes(req.body.country.toUpperCase()) ? req.body.country.toUpperCase() : settings.get().country;
    const country = getCountry(code);

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const quota = takeToken(ip);
    res.setHeader('X-RateLimit-Remaining', String(quota.remaining));
    if (!quota.ok) {
      const mins = Math.max(1, Math.ceil((quota.resetAt - Date.now()) / 60_000));
      res.setHeader('Retry-After', String(mins * 60));
      return res.status(429).json({
        error: 'rate_limited',
        resetInMinutes: mins,
        // The page rewrites this with the visitor's local clock time; this text is the fallback.
        resetAt: new Date(quota.resetAt).toISOString(),
        message: `Thanks so much for trying Wessuwan! You've used all ${config.publicDemo.ratePerHour} free checks for this hour, which keeps the demo free for everyone. You can try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
      });
    }

    const language = guessLanguage(transcript, country.defaultLanguage.split('-')[0]);
    const lang = warningLang(language);
    const extras = (risk: number, scamType: string, impersonating: string, reason: string) => ({
      scamTypeLabel: SCAM_TYPE_LABEL[scamType as keyof typeof SCAM_TYPE_LABEL] ?? scamType,
      language,
      remaining: quota.remaining,
      smsPreview: smsText({ name: settings.get().protectedName, score: risk, scamType, impersonating, reason }),
      warning: { lang, text: WARNING_TEXT[lang], audio: warningAudioFor(lang) },
      reporting: country.reporting,
    });
    try {
      if (config.detector === 'jev') {
        // Same rules as a live call. "Play it like a call" sends the previous score and detection state.
        const prev = typeof req.body?.prevScore === 'number' ? req.body.prevScore : null;
        const lines = transcript.split('\n').map((l: string) => {
          const m = l.match(/^\s*(caller|protected)\s*:\s*(.*)$/i);
          return m ? { speaker: m[1].toLowerCase() as 'caller' | 'protected', text: m[2] } : { speaker: 'caller' as const, text: l };
        });
        const a = await askJev(buildTranscript(lines).text, country);
        const d = applyCodeRequest(decide(a, prev, req.body?.detected === true), lines, req.body?.detected === true);
        logCheck(a, d, 'tryit');
        return res.json({
          detector: 'jev', tier: 'jev', risk: d.risk, status: d.status, warn: d.warn, rule: d.rule,
          jevScore: a.score, confidence: a.confidence, level: levelLabel(a.score), probabilities: a.probabilities,
          signals: d.signals, scamType: a.scamType, impersonating: d.impersonating, reason: d.reason, ms: a.ms, cost: a.cost,
          ...extras(d.risk, a.scamType, d.impersonating, d.reason),
        });
      }
      const a = await scoreTranscript({ transcript, language, country });
      res.json({ ...a, detector: 'llm', status: a.risk >= 70 ? 'scam' : a.risk >= 40 ? 'watching' : 'safe', warn: a.risk >= settings.get().riskThreshold, ...extras(a.risk, a.scamType, a.impersonating, a.reason) });
    } catch (err: any) {
      log.error('tryit', `check failed: ${err?.message ?? err}`);
      res.status(502).json({ error: 'detector_failed', message: 'The AI detector did not answer. Please try again in a moment.', remaining: quota.remaining });
    }
  });
}
