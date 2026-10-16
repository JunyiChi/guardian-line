import crypto from 'crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { getCountry, listCountries } from '../config/countries';
import { settings, Settings } from '../settings';
import { summaries } from '../privacy/summaries';
import { log } from '../privacy/log';

const SETUP_PASSWORD = process.env.SETUP_PASSWORD || '';

/** Sample data the public demo shows instead of anyone's real settings. */
const DEMO_SETTINGS: Settings = {
  protectionEnabled: true, protectedName: 'Mom', protectedNumber: '+1 555 010 0199',
  consent: { acceptedAt: '2026-10-01T09:00:00.000Z', acceptedBy: 'Margaret (protected person)' },
  trustedNumbers: ['+1 555 010 0111', '+1 555 010 0122'], familyNumbers: ['+1 555 010 0133'],
  alertChannel: 'sms', country: config.country, riskThreshold: 70, autoHangupThreshold: null,
};

/**
 * The setup page edits phone numbers and consent, so its API is protected:
 * - PUBLIC_DEMO: read-only sample data, nothing can be changed.
 * - SETUP_PASSWORD set: HTTP Basic auth (any user name).
 * - Neither, in production: disabled. Locally (development) it is open on your own machine.
 */
function guard(write: boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (config.publicDemo.enabled) {
      if (!write) return next();
      return res.status(403).json({ error: 'This is the public demo: settings are read-only. Run Wessuwan yourself to change them.' });
    }
    if (SETUP_PASSWORD) {
      const [, b64] = (req.get('authorization') ?? '').split(' ');
      const pass = Buffer.from(b64 ?? '', 'base64').toString().split(':').slice(1).join(':');
      const a = Buffer.from(pass), b = Buffer.from(SETUP_PASSWORD);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
      res.set('WWW-Authenticate', 'Basic realm="Wessuwan setup"');
      return res.status(401).json({ error: 'password required' });
    }
    if (config.production) return res.status(403).json({ error: 'Set SETUP_PASSWORD to use the setup page in production.' });
    next();
  };
}

function view(s: Settings) {
  const c = getCountry(s.country);
  return {
    ...s,
    active: config.publicDemo.enabled || settings.active(),
    demo: config.publicDemo.enabled,
    countryInfo: { code: c.code, name: c.name, reporting: c.reporting, allPartyConsent: c.allPartyConsent, consentNote: c.consentNote, privacyRegime: c.privacyRegime },
    countries: listCountries().map((code) => ({ code, name: getCountry(code).name })),
    twilioNumber: config.twilio.phoneNumber,
    retentionDays: config.privacy.retentionDays,
    summariesKept: config.publicDemo.enabled ? 0 : summaries.list().length,
  };
}

/** Setup page API: settings, consent, protection on/off, and "Delete all my data". */
export function setupSetup(app: Express): void {
  app.get('/api/settings', guard(false), (_req, res) => res.json(view(config.publicDemo.enabled ? DEMO_SETTINGS : settings.get())));

  app.post('/api/settings', guard(true), (req, res) => {
    const s = settings.update(req.body ?? {});
    log.info('settings', 'settings updated');
    res.json(view(s));
  });

  app.post('/api/consent', guard(true), (req, res) => {
    if (req.body?.agree !== true) return res.status(400).json({ error: 'Consent must be given explicitly.' });
    const s = settings.recordConsent(String(req.body?.name ?? ''));
    log.info('settings', 'consent recorded');
    res.json(view(s));
  });

  /** Turn protection on or off at any time. Off = calls ring straight through, nothing is processed. */
  app.post('/api/protection', guard(true), (req, res) => {
    const s = settings.update({ protectionEnabled: req.body?.enabled === true });
    log.info('settings', `protection switched ${s.protectionEnabled ? 'on' : 'off'}`);
    res.json(view(s));
  });

  /** "Delete all my data": summaries, contacts, numbers and the consent record. Protection is switched off. */
  app.post('/api/delete-my-data', guard(true), (req, res) => {
    if (req.body?.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });
    const n = summaries.deleteAll();
    settings.deleteAll();
    log.info('privacy', `user deleted all data (${n} summaries, settings, consent)`);
    res.json({ ok: true, deletedSummaries: n, settings: view(settings.get()) });
  });
}
