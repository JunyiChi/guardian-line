import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { decrypt, encrypt, encryptionKey } from './crypto';
import { log } from './log';

const FILE = path.join(__dirname, '..', '..', 'data', 'summaries.enc.jsonl');
const DAY_MS = 24 * 60 * 60 * 1000;

/** What we keep about a flagged call: a few fields, never the transcript or audio. */
export interface ScamSummary {
  startedAt: string;
  endedAt: string;
  caller: string;
  scamType: string;
  impersonating: string;
  maxRisk: number;
  reason: string;
  alerts: string[];
}

/** One line per summary. Only `id` and `createdAt` are plaintext (needed for retention); the rest is AES-256-GCM. */
interface Row { id: string; createdAt: number; data: string }

function readRows(): Row[] {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
  } catch {
    return [];
  }
}

function writeRows(rows: Row[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export const summaries = {
  /** Saves an encrypted summary. Without ENCRYPTION_KEY nothing is kept at all. */
  save(s: ScamSummary): boolean {
    if (!encryptionKey()) {
      log.warn('privacy', 'flagged-call summary not kept: set ENCRYPTION_KEY to keep encrypted summaries');
      return false;
    }
    const row: Row = { id: crypto.randomUUID(), createdAt: Date.now(), data: encrypt(JSON.stringify(s)) };
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(row) + '\n', { mode: 0o600 });
    return true;
  },

  list(): (ScamSummary & { id: string })[] {
    if (!encryptionKey()) return [];
    const out: (ScamSummary & { id: string })[] = [];
    for (const r of readRows()) {
      try {
        out.push({ id: r.id, ...(JSON.parse(decrypt(r.data)) as ScamSummary) });
      } catch {
        log.warn('privacy', `summary ${r.id.slice(0, 8)} could not be decrypted (key changed?), skipped`);
      }
    }
    return out.reverse();
  },

  /** Deletes summaries older than SUMMARY_RETENTION_DAYS. Returns how many were removed. */
  purgeExpired(): number {
    const rows = readRows();
    const cutoff = Date.now() - config.privacy.retentionDays * DAY_MS;
    const keep = rows.filter((r) => r.createdAt >= cutoff);
    if (keep.length !== rows.length) writeRows(keep);
    return rows.length - keep.length;
  },

  deleteAll(): number {
    const n = readRows().length;
    try {
      fs.rmSync(FILE, { force: true });
    } catch (err: any) {
      log.error('privacy', `could not delete summaries: ${err.message}`);
    }
    return n;
  },
};

/** Purges expired summaries now and then every hour. */
export function startRetention(): void {
  const run = () => {
    const n = summaries.purgeExpired();
    if (n) log.info('privacy', `deleted ${n} summaries older than ${config.privacy.retentionDays} days`);
  };
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}
