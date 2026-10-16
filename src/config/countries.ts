import fs from 'fs';
import path from 'path';
import { config } from './index';

const DIR = path.join(__dirname, '..', '..', 'config', 'countries');

export type Signal = 'urgency' | 'threat' | 'data_request' | 'transfer_request';

export interface CountryProfile {
  code: string;
  name: string;
  /** BCP-47 code; STT fallback language and default warning/reason language. */
  defaultLanguage: string;
  /** Languages the STT provider may auto-detect between (first = primary). */
  sttLanguages: string[];
  /** Privacy law shown on the privacy notice, e.g. "GDPR". */
  privacyRegime: string;
  /** True where every party must know about the listening. Wessuwan announces itself in every country anyway. */
  allPartyConsent: boolean;
  consentNote: string;
  reporting: { name: string; phone: string; url: string };
  /** Local scam patterns, each mapped onto one of the global scam types. */
  localScams: { type: string; description: string; phrases: string[] }[];
  examplePhrases: Record<Signal, string[]>;
}

const cache = new Map<string, CountryProfile>();

export function listCountries(): string[] {
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).sort();
  } catch {
    return [];
  }
}

/** Loads config/countries/<CODE>.json, falling back to US if the code is unknown. */
export function getCountry(code: string = config.country): CountryProfile {
  const key = code.toUpperCase();
  let p = cache.get(key);
  if (p) return p;
  const file = path.join(DIR, `${key}.json`);
  if (!fs.existsSync(file)) {
    if (key !== 'US') {
      console.error(`[Wessuwan] [config] no country profile ${key}, using US (available: ${listCountries().join(', ')})`);
      return getCountry('US');
    }
    throw new Error(`missing ${file}`);
  }
  p = JSON.parse(fs.readFileSync(file, 'utf8')) as CountryProfile;
  cache.set(key, p);
  return p;
}
