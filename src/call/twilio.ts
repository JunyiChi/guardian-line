import { config } from '../config';
import { log, maskNumber, shortSid } from '../privacy/log';

const API = () => config.twilio.apiBase;

/** MOCK=true or PUBLIC_DEMO=true: Twilio actions (calls, SMS) are only logged, never sent. */
export const isMock = () => process.env.MOCK === 'true' || config.publicDemo.enabled;

/** Without Twilio keys (or with MOCK/PUBLIC_DEMO) calls are only logged, so alerts can be tested offline. */
/** DEMO-/TEST- calls are fake, so they are always mocked. */
const mock = (callSid: string) =>
  isMock() || !config.twilio.accountSid || !config.twilio.authToken || /^(DEMO|TEST|SIM)-/.test(callSid);
export const isMockCall = mock;

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

export async function twilio(method: 'GET' | 'POST' | 'DELETE', path: string, form?: Record<string, string>): Promise<any> {
  const { accountSid, authToken } = config.twilio;
  if (!accountSid || !authToken) throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set');
  const res = await fetch(`${API()}/Accounts/${accountSid}${path}`, {
    method,
    headers: { Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64') },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${body.message ?? res.statusText}`);
  return body;
}

// ---------------------------------------------------------------------------------------------
// Guardian: conference-based bridging. The caller sits in a <Conference>; we dial the protected
// person into it. Twilio can then play audio to ONE participant (AnnounceUrl), which is the whisper
// the caller never hears, and remove one participant (kick) without ending the call.
// ---------------------------------------------------------------------------------------------

export interface Bridge {
  /** Conference friendly name, guard-<caller CallSid>. */
  name: string;
  /** Known once Twilio sends the first conference status callback. */
  conferenceSid: string | null;
  callerCallSid: string;
  seniorCallSid: string | null;
  seniorJoined: boolean;
  from: string;
  /** Set before we remove the caller on purpose, so their leaving doesn't end the protected person's call. */
  kicked?: boolean;
}
/** Keyed by the caller's CallSid, which is also the CallSid of the media stream / transcript / detector. */
const bridges = new Map<string, Bridge>();
export const getBridge = (callerCallSid: string) => bridges.get(callerCallSid);
export const setBridge = (b: Bridge) => bridges.set(b.callerCallSid, b);
export const dropBridge = (callerCallSid: string) => bridges.delete(callerCallSid);
export const bridgeByConference = (conferenceSid: string) => [...bridges.values()].find((b) => b.conferenceSid === conferenceSid);
export const bridgeByName = (name: string) => [...bridges.values()].find((b) => b.name === name);

/** Outbound call (REST). From must be a Twilio number or a verified caller ID. Returns the new call's SID. */
export async function createCall(params: { to: string; url: string; statusCallback?: string; statusCallbackEvent?: string; timeoutSec?: number; from?: string }): Promise<string> {
  const form: Record<string, string> = {
    To: params.to,
    From: params.from ?? config.twilio.phoneNumber,
    Url: params.url,
    Timeout: String(params.timeoutSec ?? 20),
  };
  if (params.statusCallback) {
    form.StatusCallback = params.statusCallback;
    form.StatusCallbackEvent = params.statusCallbackEvent ?? 'answered completed';
  }
  const r = await twilio('POST', '/Calls.json', form);
  return r.sid as string;
}

/** Plays the TwiML at announceUrl to one conference participant only (the whisper). */
export async function announce(conferenceSid: string, participantCallSid: string, announceUrl: string): Promise<void> {
  await twilio('POST', `/Conferences/${conferenceSid}/Participants/${participantCallSid}.json`, { AnnounceUrl: announceUrl, AnnounceMethod: 'GET' });
}

/** Removes one participant (the caller) from the conference; the protected person stays connected. */
export async function kick(conferenceSid: string, participantCallSid: string): Promise<void> {
  const b = [...bridges.values()].find((x) => x.callerCallSid === participantCallSid);
  if (b) b.kicked = true;
  // The caller's leg has endConferenceOnExit=true; clear it first or removing the caller ends the call for everyone.
  await twilio('POST', `/Conferences/${conferenceSid}/Participants/${participantCallSid}.json`, { EndConferenceOnExit: 'false' }).catch(() => undefined);
  await twilio('DELETE', `/Conferences/${conferenceSid}/Participants/${participantCallSid}.json`);
}

/** ConferenceSid for a bridge, looked up by friendly name if no status callback has delivered it yet. */
export async function ensureConferenceSid(b: Bridge): Promise<string | null> {
  if (b.conferenceSid) return b.conferenceSid;
  const r = await twilio('GET', `/Conferences.json?FriendlyName=${encodeURIComponent(b.name)}&Status=in-progress`);
  b.conferenceSid = r?.conferences?.[0]?.sid ?? null;
  return b.conferenceSid;
}

/** Ends one call leg (a leg that is still ringing has to be canceled instead). */
export async function endCall(callSid: string): Promise<void> {
  try {
    await twilio('POST', `/Calls/${callSid}.json`, { Status: 'completed' });
  } catch {
    await twilio('POST', `/Calls/${callSid}.json`, { Status: 'canceled' }).catch(() => undefined);
  }
}

/**
 * The caller left the conference. Unless we removed them on purpose (kick), end the protected person's
 * leg too, so nobody is left alone in a silent call. Safe to call more than once.
 */
export function callerLeft(callerCallSid: string): void {
  const b = getBridge(callerCallSid);
  if (!b || b.kicked || !b.seniorCallSid || mock(callerCallSid)) return;
  const leg = b.seniorCallSid;
  b.seniorCallSid = null;
  endCall(leg).catch(() => undefined);
}

/**
 * Whisper to the protected person: text (spoken by <Say>) or a pre-recorded audio URL (<Play>), via the
 * conference announcement. Falls back to Wessuwan's leg redirect (which disconnects the caller) when the
 * conference isn't known, e.g. a trusted-caller call that was dialed straight through.
 */
export async function whisper(callSid: string, opts: { text?: string; play?: string; lang?: string }): Promise<'announce' | 'redirect'> {
  const q = new URLSearchParams();
  if (opts.text) q.set('text', opts.text);
  if (opts.play) q.set('play', opts.play);
  if (opts.lang) q.set('lang', opts.lang);
  const url = `${config.publicUrl}/twilio/whisper?${q}`;
  if (mock(callSid)) {
    log.info('mock', `${shortSid(callSid)}: would whisper to the protected person: ${opts.text ?? opts.play}`);
    return 'announce';
  }
  const b = getBridge(callSid);
  if (b && b.seniorCallSid && (await ensureConferenceSid(b).catch(() => null))) {
    await announce(b.conferenceSid!, b.seniorCallSid, url);
    return 'announce';
  }
  const leg = (await protectedLeg(callSid)) ?? callSid;
  await twilio('POST', `/Calls/${leg}.json`, { Twiml: `<Response><Redirect method="GET">${escapeXml(url)}</Redirect></Response>` });
  return 'redirect';
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
  const how = await whisper(callSid, { play: audioUrl });
  if (how === 'redirect') log.warn('call', `${shortSid(callSid)}: no conference for this call, warning played by redirecting the protected leg (caller disconnected)`);
}

/** Ends the call (both legs). */
/** Sends one SMS or WhatsApp message. */
/** Pass the call's callSid so alerts for DEMO-/TEST- calls are only logged, like the voice warning. */
export async function sendMessage(to: string, body: string, channel: 'sms' | 'whatsapp', callSid?: string): Promise<void> {
  if (channel === 'sms' && !config.twilio.smsEnabled) {
    log.info('sms', `SMS disabled (SMS_ENABLED=false), not sent to ${maskNumber(to)}: ${body.slice(0, 80)}`);
    throw new Error('SMS disabled');
  }
  const from = channel === 'whatsapp' ? config.twilio.whatsappFrom : config.twilio.phoneNumber;
  if (isMock() || !config.twilio.accountSid || !config.twilio.authToken || !from || (callSid && /^(DEMO|TEST|SIM)-/.test(callSid))) {
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
