import fs from 'fs';
import path from 'path';
import { config } from './config';
import { getCountry, listCountries } from './config/countries';
import { decrypt, encrypt, encryptionKey } from './privacy/crypto';
import { log } from './privacy/log';

const FILE = path.join(__dirname, '..', 'data', 'settings.enc');

/** Everything the setup page edits. Contains phone numbers, so it is encrypted at rest. */
export interface Settings {
  /** Master switch. Off = calls ring straight through and nothing is processed. */
  protectionEnabled: boolean;
  protectedName: string;
  protectedNumber: string;
  /** Recorded when the protected person (or their legal representative) agrees on the consent screen. */
  consent: { acceptedAt: string; acceptedBy: string } | null;
  trustedNumbers: string[];
  familyNumbers: string[];
  alertChannel: 'sms' | 'whatsapp';
  country: string;
  riskThreshold: number;
  autoHangupThreshold: number | null;
}

function defaults(): Settings {
  return {
    protectionEnabled: true,
    protectedName: config.protectedPerson.name,
    protectedNumber: config.protectedPerson.number,
    consent: null,
    trustedNumbers: config.trustedNumbers,
    familyNumbers: config.alerts.familyNumbers,
    alertChannel: config.alerts.channel,
    country: config.country,
    riskThreshold: config.riskThreshold,
    autoHangupThreshold: config.autoHangupThreshold,
  };
}

let current: Settings = load();

function load(): Settings {
  const base = defaults();
  // Running only from .env (no setup page used): CONSENT_RECORDED=true documents that consent was collected offline.
  if (process.env.CONSENT_RECORDED === 'true') base.consent = { acceptedAt: 'recorded offline', acceptedBy: 'operator (.env)' };
  if (!fs.existsSync(FILE)) return base;
  try {
    return { ...base, ...JSON.parse(decrypt(fs.readFileSync(FILE, 'utf8'))) };
  } catch (err: any) {
    log.error('settings', `could not read saved settings (${err.message}); using .env defaults`);
    return base;
  }
}

function persist(): void {
  if (!encryptionKey()) {
    log.warn('settings', 'settings kept in memory only: set ENCRYPTION_KEY to save them (encrypted) across restarts');
    return;
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, encrypt(JSON.stringify(current)), { mode: 0o600 });
}

const PHONE = /^\+?[0-9 ()-]{6,20}$/;
const phones = (v: unknown): string[] =>
  (Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/)).map((s) => String(s).trim()).filter(Boolean).filter((s) => PHONE.test(s));

export const settings = {
  get: (): Readonly<Settings> => current,
  country: () => getCountry(current.country),
  /** Protection runs only when switched on AND consent has been recorded. */
  active: () => current.protectionEnabled && !!current.consent,

  update(patch: Partial<Record<keyof Settings, unknown>>): Settings {
    const next = { ...current };
    if (typeof patch.protectionEnabled === 'boolean') next.protectionEnabled = patch.protectionEnabled;
    if (typeof patch.protectedName === 'string') next.protectedName = patch.protectedName.trim().slice(0, 60) || 'Mom';
    if (typeof patch.protectedNumber === 'string') next.protectedNumber = PHONE.test(patch.protectedNumber.trim()) ? patch.protectedNumber.trim() : '';
    if (patch.trustedNumbers !== undefined) next.trustedNumbers = phones(patch.trustedNumbers);
    if (patch.familyNumbers !== undefined) next.familyNumbers = phones(patch.familyNumbers);
    if (patch.alertChannel === 'sms' || patch.alertChannel === 'whatsapp') next.alertChannel = patch.alertChannel;
    if (typeof patch.country === 'string' && listCountries().includes(patch.country.toUpperCase())) next.country = patch.country.toUpperCase();
    const t = Number(patch.riskThreshold);
    if (patch.riskThreshold !== undefined && Number.isFinite(t)) next.riskThreshold = Math.min(95, Math.max(30, Math.round(t)));
    if (patch.autoHangupThreshold !== undefined) {
      const h = Number(patch.autoHangupThreshold);
      next.autoHangupThreshold = patch.autoHangupThreshold === null || patch.autoHangupThreshold === 'off' || !Number.isFinite(h) ? null : Math.min(100, Math.max(50, Math.round(h)));
    }
    current = next;
    persist();
    return current;
  },

  recordConsent(acceptedBy: string): Settings {
    current = { ...current, consent: { acceptedAt: new Date().toISOString(), acceptedBy: acceptedBy.trim().slice(0, 80) || 'protected person' } };
    persist();
    return current;
  },

  /** "Delete all my data": consent, contacts and numbers go; protection is off until set up again. */
  deleteAll(): void {
    current = { ...defaults(), protectionEnabled: false, protectedNumber: '', trustedNumbers: [], familyNumbers: [], consent: null };
    try {
      fs.rmSync(FILE, { force: true });
    } catch (err: any) {
      log.error('settings', `could not delete settings file: ${err.message}`);
    }
    // Save the cleared state (it holds no personal data) so .env defaults don't silently come back on restart.
    persist();
  },
};
