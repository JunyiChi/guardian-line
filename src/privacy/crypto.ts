import crypto from 'crypto';
import { config } from '../config';

/** AES-256-GCM with a random 12-byte IV per record. Output: base64(iv | tag | ciphertext). */

let key: Buffer | null | undefined;
export function encryptionKey(): Buffer | null {
  if (key !== undefined) return key;
  const raw = config.privacy.encryptionKey.trim();
  if (!raw) return (key = null);
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars or 44 base64 chars)');
  return (key = buf);
}

export function encrypt(plain: string): string {
  const k = encryptionKey();
  if (!k) throw new Error('ENCRYPTION_KEY not set');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decrypt(blob: string): string {
  const k = encryptionKey();
  if (!k) throw new Error('ENCRYPTION_KEY not set');
  const buf = Buffer.from(blob, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/** For .env setup: prints a fresh key. */
export const newKey = () => crypto.randomBytes(32).toString('base64');
