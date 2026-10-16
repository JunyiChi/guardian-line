import { bus } from './events';
import { log, maskNumber, shortSid } from './privacy/log';

/**
 * One readable terminal line per pipeline step: call → stt → detector → alerts → end.
 * Phone numbers are always masked. Transcript text and reasons are call content, so they are
 * only printed at LOG_LEVEL=debug (never the production default).
 */
export function setupLogging(): void {
  bus.on('call:ringing', ({ callSid, from }) => log.info('call', `ringing from ${maskNumber(from)} (${shortSid(callSid)})`));
  bus.on('call:started', ({ callSid, from }) => log.info('call', `announcement done, protecting call from ${maskNumber(from)} (${shortSid(callSid)})`));
  bus.on('transcript-update', ({ callSid, speaker, text, isFinal, language }) => {
    if (isFinal) log.debug('stt', `${shortSid(callSid)} ${speaker}${language ? ` [${language}]` : ''}: ${text}`);
  });
  bus.on('risk-update', ({ callSid, score, rawScore, scamType, reason, signals, impersonating, tier, detector }) => {
    if (detector === 'jev') return log.debug('detector', `${shortSid(callSid)} reason: ${reason}`); // jev.ts logs its own line
    const on = Object.entries(signals).filter(([, v]) => v).map(([k]) => k).join('+') || 'no signals';
    log.info('detector', `${shortSid(callSid)} risk ${score}/100 (raw ${rawScore} ${tier}, ${scamType}, as ${impersonating}, ${on})`);
    log.debug('detector', `${shortSid(callSid)} reason: ${reason}`);
  });
  bus.on('scam-detected', ({ callSid, score, scamType }) =>
    log.warn('detector', `${shortSid(callSid)} !!! SCAM DETECTED risk ${score} type ${scamType}`));
  bus.on('alert:sent', ({ callSid, channel }) => log.info('alerts', `${shortSid(callSid)} ${channel} alert sent`));
  bus.on('call:ended', ({ callSid }) => log.info('call', `${shortSid(callSid)} ended`));

  // Last line of defence: log and keep serving calls.
  process.on('unhandledRejection', (err: any) => log.error('error', `unhandled rejection: ${err?.message ?? err}`));
  process.on('uncaughtException', (err) => log.error('error', `uncaught exception: ${err.stack ?? err.message}`));
}
