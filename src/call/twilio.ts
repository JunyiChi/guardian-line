import { config } from '../config';
import { log, maskNumber, shortSid } from '../privacy/log';

const API = 'https://api.twilio.com/2010-04-01';

/** MOCK=true or PUBLIC_DEMO=true: Twilio actions (calls, SMS) are only logged, never sent. */
export const isMock = () => process.env.MOCK === 'true' || config.publicDemo.enabled;

/** Without Twilio keys (or with MOCK/PUBLIC_DEMO) calls are only logged, so alerts can be tested offline. */
/** DEMO-/TEST- calls are fake, so they are always mocked. */
const mock = (callSid: string) =>
  isMock() || !config.twilio.accountSid || !config.twilio.authToken || /^(DEMO|TEST)-/.test(callSid);

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

export async function twilio(method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<any> {
  const { accountSid, authToken } = config.twilio;
  if (!accountSid || !authToken) throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set');
  const res = await fetch(`${API}/Accounts/${accountSid}${path}`, {
    method,
    headers: { Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64') },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${body.message ?? res.statusText}`);
  return body;
}

/** The leg Twilio <Dial>ed to the protected person (child of the inbound caller leg), if still in progress. */
async function protectedLeg(callSid: string): Promise<string | null> {
  const { calls } = await twilio('GET', `/Calls.json?ParentCallSid=${encodeURIComponent(callSid)}&Status=in-progress`);
  return calls?.[0]?.sid ?? null;
}

/**
 * Plays audio to the protected person. With the current <Dial> setup Twilio cannot inject audio into a live
 * bridge, so this redirects their leg to <Play>, which also disconnects the caller.
 * To keep both parties connected, move the call to <Dial><Conference> and use announceUrl.
 */
export async function playWarning(callSid: string, audioUrl: string): Promise<void> {
  if (mock(callSid)) return log.info('mock', `${shortSid(callSid)}: would play ${audioUrl} to the protected person`);
  const leg = (await protectedLeg(callSid)) ?? callSid;
  await twilio('POST', `/Calls/${leg}.json`, {
    Twiml: `<Response><Play>${escapeXml(audioUrl)}</Play><Play>${escapeXml(audioUrl)}</Play></Response>`,
  });
}

/** Ends the call (both legs). */
/** Sends one SMS or WhatsApp message. */
export async function sendMessage(to: string, body: string, channel: 'sms' | 'whatsapp'): Promise<void> {
  const from = channel === 'whatsapp' ? config.twilio.whatsappFrom : config.twilio.phoneNumber;
  if (isMock() || !config.twilio.accountSid || !config.twilio.authToken || !from) {
    log.info('mock', `${channel} to ${maskNumber(to)} (not sent): ${body}`);
    return;
  }
  const wa = (n: string) => (n.startsWith('whatsapp:') ? n : `whatsapp:${n}`);
  await twilio('POST', '/Messages.json', {
    From: channel === 'whatsapp' ? wa(from) : from,
    To: channel === 'whatsapp' ? wa(to) : to,
    Body: body,
  });
}

export async function hangUp(callSid: string): Promise<void> {
  if (mock(callSid)) return log.info('mock', `${shortSid(callSid)}: would hang up`);
  await twilio('POST', `/Calls/${callSid}.json`, { Status: 'completed' });
}
