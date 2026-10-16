import type { Express } from 'express';
import { bus, AlertChannel } from '../events';
import { config } from '../config';
import { settings } from '../settings';
import { store } from '../store';
import { playWarning, hangUp, sendMessage } from '../call/twilio';
import { ensureWarningAudio, warningAudioFor } from './tts';
import { SCAM_TYPE_LABEL, ScamType } from '../detector/prompt';
import { log, maskNumber, shortSid } from '../privacy/log';

/** Smoothed risk above which the voice warning plays a second time. */
const REPLAY_RISK = 90;

const absolute = (p: string) => `${config.publicUrl || `http://localhost:${config.port}`}${p}`;

/** Per-call alert state; cleared when the call ends. */
const voiceState = new Map<string, { plays: number; hungUp: boolean }>();

/** Demo mode replays (DEMO- calls) and any call in PUBLIC_DEMO: Twilio is mocked, nothing is really sent. */
const isDemoCall = (callSid: string) => config.publicDemo.enabled || callSid.startsWith('DEMO-');
/** Fictional number (555 range) the demo's family alert is previewed to. */
const DEMO_FAMILY = '+15550100';

function record(callSid: string, channel: AlertChannel, message: string): void {
  bus.emit('alert:sent', { callSid, channel, message });
}

const WHO: Record<string, string> = {
  police: 'the police', government: 'a government agency', bank: 'a bank', tech_company: 'a tech company',
  delivery_company: 'a delivery company', utility: 'a utility company', relative: 'a family member', company: 'a company',
};
const ASKS: Record<string, string> = {
  gift_card_payment: 'is asking for gift cards', crypto_atm_payment: 'is asking for a crypto ATM deposit',
  remote_access_app: 'is asking to install a remote-access app',
};

/**
 * "Wessuwan ALERT: Mom may be on a scam call right now. Caller claims to be from the IRS and is
 * asking for gift cards. Risk 92/100. Call her now."
 */
export function smsText(opts: { name: string; score: number; scamType: string; impersonating: string; reason: string }): string {
  const claim = WHO[opts.impersonating] ? `Caller claims to be ${WHO[opts.impersonating]}` : `Looks like: ${SCAM_TYPE_LABEL[opts.scamType as ScamType] ?? opts.scamType}`;
  const asks = ASKS[opts.scamType] ? ` and ${ASKS[opts.scamType]}` : '';
  const why = opts.reason ? ` ${opts.reason.replace(/\s+/g, ' ').trim().slice(0, 160)}` : '';
  return `Wessuwan ALERT: ${opts.name} may be on a scam call right now. ${claim}${asks}.${why} Risk ${opts.score}/100. Call ${opts.name} now.`;
}

async function voiceWarning(callSid: string, score: number): Promise<void> {
  const s = voiceState.get(callSid) ?? { plays: 0, hungUp: false };
  voiceState.set(callSid, s);
  if (s.hungUp || s.plays >= 2 || (s.plays === 1 && score <= REPLAY_RISK)) return;
  // Demo calls are mocked, so a missing audio file must not stop the dashboard's "Voice warning played" tick.
  const audio = warningAudioFor(store.get(callSid)?.language) ?? (isDemoCall(callSid) ? '/audio/warning.mp3' : null);
  if (!audio) {
    log.error('alerts', `${shortSid(callSid)}: no voice warning, public/audio/warning.mp3 is missing (record it yourself)`);
    return;
  }
  s.plays++;
  try {
    await playWarning(callSid, absolute(audio));
    record(callSid, 'voice', `Voice warning played (${s.plays}x, risk ${score}/100)`);
  } catch (err: any) {
    log.error('alerts', `${shortSid(callSid)}: voice warning failed: ${err?.message ?? err}`);
  }
}

async function familyAlert(callSid: string, score: number, scamType: string, impersonating: string, reason: string): Promise<void> {
  const st = settings.get();
  // Demo calls without family numbers still preview the message (sendMessage only logs it there).
  const numbers = st.familyNumbers.length ? st.familyNumbers : isDemoCall(callSid) ? [DEMO_FAMILY] : [];
  if (!numbers.length) return log.warn('alerts', 'no FAMILY_PHONE_NUMBERS configured: family alert skipped');
  const text = smsText({ name: st.protectedName, score, scamType, impersonating, reason });
  const results = await Promise.allSettled(numbers.map((n) => sendMessage(n, text, st.alertChannel)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') log.error('alerts', `${shortSid(callSid)}: ${st.alertChannel} to ${maskNumber(numbers[i])} failed: ${r.reason?.message ?? r.reason}`);
  });
  if (results.some((r) => r.status === 'fulfilled')) record(callSid, st.alertChannel, text);
}

async function maybeHangUp(callSid: string, score: number): Promise<void> {
  const limit = settings.get().autoHangupThreshold;
  const s = voiceState.get(callSid);
  if (limit === null || score <= limit || s?.hungUp) return;
  if (s) s.hungUp = true;
  try {
    await hangUp(callSid);
    record(callSid, 'hangup', `Call hung up automatically (risk ${score}/100 > ${limit})`);
  } catch (err: any) {
    log.error('alerts', `${shortSid(callSid)}: auto hang-up failed: ${err?.message ?? err}`);
  }
}

/** Voice warning into the call, SMS/WhatsApp alert to the family, optional auto hang-up. */
export function setupAlerts(app: Express): void {
  const c = settings.country();
  ensureWarningAudio([c.defaultLanguage, ...c.sttLanguages]).catch((err) =>
    log.error('alerts', `Google TTS failed: ${err.message}. Record public/audio/warning.mp3 yourself instead.`));

  // "scam-detected": smoothed risk first crossed the threshold (once per call).
  bus.on('scam-detected', async ({ callSid, score, scamType, reason, impersonating }) => {
    await Promise.all([familyAlert(callSid, score, scamType, impersonating, reason), voiceWarning(callSid, score)]);
    await maybeHangUp(callSid, score);
  });

  // Later scores on an already-flagged call: replay above 90, hang up above the threshold.
  bus.on('risk-update', async ({ callSid, score }) => {
    if (!voiceState.has(callSid)) return;
    await voiceWarning(callSid, score);
    await maybeHangUp(callSid, score);
  });

  bus.on('call:ended', ({ callSid }) => voiceState.delete(callSid));

  /** Setup page "Send test alert": one SMS/WhatsApp to every family number (logged only in MOCK/PUBLIC_DEMO). */
  app.post('/api/test-alert', async (_req, res) => {
    const st = settings.get();
    if (config.publicDemo.enabled) {
      const preview = smsText({ name: 'Mom', score: 92, scamType: 'gift_card_payment', impersonating: 'government', reason: 'TEST ALERT from your Wessuwan setup. No action needed.' });
      return res.json({ ok: true, sent: 0, failed: 0, channel: 'sms', preview, mock: true });
    }
    if (!st.familyNumbers.length) return res.status(400).json({ error: 'Add at least one family phone number first.' });
    const text = smsText({ name: st.protectedName, score: 92, scamType: 'gift_card_payment', impersonating: 'government', reason: 'TEST ALERT from your Wessuwan setup. No action needed.' });
    const results = await Promise.allSettled(st.familyNumbers.map((n) => sendMessage(n, text, st.alertChannel)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    res.json({ ok: failed === 0, sent: results.length - failed, failed, channel: st.alertChannel, preview: text, mock: config.publicDemo.enabled || process.env.MOCK === 'true' });
  });
}
