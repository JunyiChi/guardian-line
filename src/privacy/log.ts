import { config } from '../config';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

/** +14155551234 -> +1***-***-1234. Only the last 4 digits survive. */
export function maskNumber(n: string | undefined | null): string {
  if (!n) return 'unknown';
  const digits = n.replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `${n.trim().startsWith('+') ? '+' + digits.slice(0, digits.length > 10 ? digits.length - 10 : 1) : ''}***-***-${digits.slice(-4)}`;
}

/** Short call reference for logs; a call SID is not personal data but the full one is not needed either. */
export const shortSid = (callSid: string) => callSid.slice(-6);

/**
 * Logs one line with the [Wessuwan] prefix. Call content (transcripts, reasons) must only be passed
 * to `debug`, which LOG_LEVEL=info (the production default) suppresses.
 */
function emit(level: Level, step: string, msg: string): void {
  if (LEVELS[level] < threshold) return;
  const line = `[Wessuwan] [${step}] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (step: string, msg: string) => emit('debug', step, msg),
  info: (step: string, msg: string) => emit('info', step, msg),
  warn: (step: string, msg: string) => emit('warn', step, msg),
  error: (step: string, msg: string) => emit('error', step, msg),
};
