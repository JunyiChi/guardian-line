import crypto from 'crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'http';
import type { WebSocketServer } from 'ws';
import { bus } from '../events';
import { config } from '../config';
import { settings } from '../settings';
import { log, maskNumber, shortSid } from '../privacy/log';
import { callerLeft, createCall, dropBridge, endCall, ensureConferenceSid, getBridge, bridgeByName, kick, setBridge } from './twilio';
import { getFamily } from '../config/family';

/** Mandatory, always on, cannot be configured away. Spoken before any audio reaches the AI. */
export const ANNOUNCEMENT = 'This call is protected by Guardian, a family safety service.';
/** Repeated in the country's main language when it isn't English. */
const ANNOUNCEMENT_LOCAL: Record<string, { text: string; lang: string }> = {
  de: { text: 'Dieser Anruf wird von Wessuwan geschützt, einem KI-Dienst zum Schutz vor Betrug.', lang: 'de-DE' },
  ja: { text: 'この通話は、AI詐欺防止サービスのウェッスワンによって保護されています。', lang: 'ja-JP' },
  fr: { text: 'Cet appel est protégé par Wessuwan, un service de protection contre les arnaques par IA.', lang: 'fr-FR' },
  es: { text: 'Esta llamada está protegida por Wessuwan, un servicio de protección contra estafas con IA.', lang: 'es-US' },
};

/** Amazon Polly neural voices for the whisper, by language. */
const VOICES: Record<string, { voice: string; language: string }> = {
  en: { voice: 'Polly.Joanna-Neural', language: 'en-US' },
  zh: { voice: 'Polly.Zhiyu-Neural', language: 'cmn-CN' },
  es: { voice: 'Polly.Lupe-Neural', language: 'es-US' },
  ja: { voice: 'Polly.Kazuha-Neural', language: 'ja-JP' },
};
/** Text for <Say>: no entity escapes beyond & < > (SignalWire's parser chokes on &apos;), no quotes, one line. */
function spoken(text: string): string {
  return text.replace(/["\u201c\u201d]/g, '').replace(/['\u2018\u2019]/g, '\u2019').replace(/\s+/g, ' ').trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function sayTwiml(text: string, lang?: string): string {
  const v = VOICES[(lang ?? getFamily().language).split('-')[0]] ?? VOICES.en;
  return `<Say voice="${v.voice}" language="${v.language}">${spoken(text)}</Say>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/** Compares the last 9 digits, so "+1 415 555 0123" and "4155550123" match. */
const digits = (n: string) => n.replace(/\D/g, '').slice(-9);
export const isTrusted = (from: string) => !!from && settings.get().trustedNumbers.some((t) => digits(t) === digits(from));

/** Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted POST params)). */
export function twilioSignature(url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', config.twilio.authToken).update(data, 'utf8').digest('base64');
}
function signatureOk(signature: string | undefined, url: string, params: Record<string, string>): boolean {
  if (!signature || !config.twilio.authToken) return false;
  const expected = Buffer.from(twilioSignature(url, params));
  const got = Buffer.from(signature);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

/** Rejects webhooks that don't carry a valid X-Twilio-Signature (TWILIO_VALIDATE_SIGNATURE, default on in production). */
function requireTwilio(req: Request, res: Response, next: NextFunction): void {
  if (!config.twilio.validateSignature) return next();
  const url = `${config.publicUrl}${req.originalUrl}`;
  if (signatureOk(req.get('x-twilio-signature'), url, req.body ?? {})) return next();
  log.warn('security', `rejected ${req.path}: invalid Twilio signature`);
  res.status(403).send('invalid signature');
}

/** For the media WebSocket upgrade (Twilio signs it with the wss:// URL and no params). */
export function mediaUpgradeAllowed(req: IncomingMessage): boolean {
  if (!config.twilio.validateSignature) return true;
  const url = config.publicUrl.replace(/^http/, 'ws') + (req.url ?? '');
  const sig = req.headers['x-twilio-signature'];
  return signatureOk(Array.isArray(sig) ? sig[0] : sig, url, {});
}

/** Both legs end the conference when they leave, so neither party is ever left alone with silence. */
function conferenceTwiml(name: string, _caller: boolean): string {
  const cb = config.publicUrl ? ` statusCallback="${escapeXml(config.publicUrl)}/twilio/conference-status" statusCallbackEvent="start end join leave"` : '';
  // waitUrl -> our own silent TwiML: no hold music while the caller waits for the protected person
  // (waitUrl="" works on Twilio but is undocumented on SignalWire).
  const wait = config.publicUrl ? `${escapeXml(config.publicUrl)}/twilio/wait` : '';
  // Neither leg ends the conference by itself: the caller can be removed while the protected person stays
  // with their family, and the protected leg can step out for a whisper and rejoin. conference-status ends
  // the other leg when someone really hangs up.
  return `<Dial><Conference beep="false" waitUrl="${wait}" startConferenceOnEnter="true" endConferenceOnExit="false"${cb}>${escapeXml(name)}</Conference></Dial>`;
}

/** Dials the protected person into the caller's conference. Runs right after the webhook response is sent. */
async function dialSenior(callerCallSid: string, conf: string, protectedNumber: string): Promise<void> {
  const b = getBridge(callerCallSid);
  if (!b) return;
  if (!protectedNumber) return log.error('call', `${shortSid(callerCallSid)}: no protected phone number, nobody to bridge`);
  if (!config.twilio.accountSid || !config.twilio.authToken || process.env.MOCK === 'true' || config.publicDemo.enabled) {
    return log.info('mock', `${shortSid(callerCallSid)}: would dial ${maskNumber(protectedNumber)} into conference ${conf}`);
  }
  try {
    const q = encodeURIComponent(conf);
    b.seniorCallSid = await createCall({
      to: protectedNumber,
      url: `${config.publicUrl}/twilio/join?conf=${q}`,
      statusCallback: `${config.publicUrl}/twilio/join-status?caller=${encodeURIComponent(callerCallSid)}`,
      timeoutSec: 20,
    });
    log.info('call', `${shortSid(callerCallSid)}: dialing protected person (${shortSid(b.seniorCallSid)}) into ${conf}`);
  } catch (err: any) {
    log.error('call', `${shortSid(callerCallSid)}: could not dial the protected person: ${err?.message ?? err}; ending the call`);
    endCall(callerCallSid).catch(() => undefined);
  }
}

/**
 * Twilio voice webhook + media stream.
 * - Protection off (or no consent recorded) and trusted contacts: dialed straight through, never processed.
 * - Everyone else hears the announcement first. <Say> finishes before <Start><Stream> runs, so
 *   no audio reaches speech-to-text or the AI until the announcement has played in full.
 */
export function setupCall(app: Express, wss: WebSocketServer): void {
  app.post('/twilio/voice', requireTwilio, (req, res) => {
    const from: string = req.body?.From ?? 'unknown';
    const callSid: string = req.body?.CallSid ?? '';
    const st = settings.get();
    // Trusted / unprotected calls: plain bridge, caller ID passed through (allowed for the inbound From).
    const dial = `<Dial callerId="${escapeXml(from)}">${escapeXml(st.protectedNumber)}</Dial>`;
    if (!st.protectedNumber) log.error('call', 'no protected phone number set: complete the setup page');

    if (!settings.active()) {
      log.info('call', `protection is ${st.consent ? 'switched off' : 'not set up (no consent recorded)'}: connecting directly, not processed`);
      res.type('text/xml').send(`<Response>${dial}</Response>`);
      return;
    }
    if (isTrusted(from)) {
      log.info('call', `trusted caller ${maskNumber(from)}: connecting directly, not processed`);
      res.type('text/xml').send(`<Response>${dial}</Response>`);
      return;
    }
    if (!config.publicUrl) log.error('call', 'PUBLIC_URL not set: Twilio cannot reach the media stream');

    bus.emit('call:ringing', { callSid, from });
    const wsUrl = config.publicUrl.replace(/^http/, 'ws') + '/media';
    const local = ANNOUNCEMENT_LOCAL[settings.country().defaultLanguage.split('-')[0]];
    // Guardian: the caller waits in a conference; the protected person is dialed into it (see dialSenior).
    // A conference is the only Twilio topology where audio can be played to one participant only (the whisper).
    const conf = `guard-${callSid}`;
    setBridge({ name: conf, conferenceSid: null, callerCallSid: callSid, seniorCallSid: null, seniorJoined: false, from });
    res.type('text/xml').send(
      '<Response>' +
        `<Say language="en-US">${ANNOUNCEMENT}</Say>` +
        (local ? `<Say language="${local.lang}">${escapeXml(local.text)}</Say>` : '') +
        `<Start><Stream url="${escapeXml(wsUrl)}" track="both_tracks">` +
        `<Parameter name="from" value="${escapeXml(from)}"/></Stream></Start>` +
        conferenceTwiml(conf, true) +
      '</Response>',
    );
    void dialSenior(callSid, conf, st.protectedNumber);
  });

  /** The protected person answered our outbound call: join the caller's conference. */
  app.all('/twilio/join', requireTwilio, (req, res) => {
    const conf = String(req.query.conf ?? '');
    const b = bridgeByName(conf);
    if (!b) {
      log.warn('call', `join for unknown conference ${conf}: hanging up`);
      res.type('text/xml').send('<Response><Hangup/></Response>');
      return;
    }
    res.type('text/xml').send(`<Response>${conferenceTwiml(conf, false)}</Response>`);
  });

  /** Status of the outbound leg to the protected person: not answered -> release the caller. */
  app.post('/twilio/join-status', requireTwilio, (req, res) => {
    res.sendStatus(204);
    const caller = String(req.query.caller ?? '');
    const status = String(req.body?.CallStatus ?? '');
    const b = getBridge(caller);
    if (!b) return;
    if (status === 'in-progress' || status === 'answered') {
      b.seniorJoined = true;
      log.info('call', `${shortSid(caller)}: protected person answered, bridged in conference`);
      return;
    }
    if (['no-answer', 'busy', 'failed', 'canceled'].includes(status) || (status === 'completed' && !b.seniorJoined)) {
      log.warn('call', `${shortSid(caller)}: protected person did not answer (${status}); ending the caller's call`);
      endCall(caller).catch((err) => log.error('call', `could not end caller ${shortSid(caller)}: ${err.message}`));
    }
  });

  /** Conference events: learn the ConferenceSid (needed for announce/kick) and clean up at the end. */
  app.post('/twilio/conference-status', requireTwilio, (req, res) => {
    res.sendStatus(204);
    const name = String(req.body?.FriendlyName ?? '');
    const event = String(req.body?.StatusCallbackEvent ?? '');
    const b = bridgeByName(name);
    if (!b) return;
    if (req.body?.ConferenceSid) b.conferenceSid = String(req.body.ConferenceSid);
    const leg = req.body?.CallSid ? String(req.body.CallSid) : '';
    if (event === 'participant-join' && leg && leg !== b.callerCallSid && (!b.seniorCallSid || b.seniorCallSid === leg)) {
      b.seniorCallSid = leg;
      b.seniorJoined = true;
    }
    log.debug('call', `${shortSid(b.callerCallSid)}: conference ${event}${req.body?.CallSid ? ` (${shortSid(String(req.body.CallSid))})` : ''}`);
    if (event === 'participant-leave' && leg === b.callerCallSid) callerLeft(b.callerCallSid);
    if (event === 'participant-leave' && leg && leg === b.seniorCallSid && !b.whispering && !b.kicked) {
      log.info('call', `${shortSid(b.callerCallSid)}: protected person hung up, ending the caller's leg`);
      endCall(b.callerCallSid).catch(() => undefined);
    }
    if (event === 'participant-join' && leg && leg === b.seniorCallSid && b.whispering) {
      b.whispering = false;
      log.info('call', `${shortSid(b.callerCallSid)}: protected person rejoined after the whisper`);
    }
    if (event === 'conference-end') dropBridge(b.callerCallSid);
  });

  /**
   * Whisper on providers without a working single-participant announce: the protected leg is redirected
   * here, hears the text alone, and dials straight back into the conference.
   */
  app.all('/twilio/whisper-rejoin', requireTwilio, (req, res) => {
    const text = String(req.query.text ?? '').slice(0, 400);
    const conf = String(req.query.conf ?? '');
    const lang = req.query.lang ? String(req.query.lang) : undefined;
    const wait = config.publicUrl ? `${escapeXml(config.publicUrl)}/twilio/wait` : '';
    log.info('whisper', `protected leg stepped out for the whisper (${req.method}): ${text.slice(0, 80)}`);
    res.type('text/xml').send(
      `<Response>${text ? sayTwiml(text, lang) : ''}` +
      `<Dial><Conference beep="false" waitUrl="${wait}" startConferenceOnEnter="true" endConferenceOnExit="false">${escapeXml(conf)}</Conference></Dial></Response>`,
    );
  });

  /** Conference wait music: silence. */
  app.all('/twilio/wait', (_req, res) => {
    res.type('text/xml').send('<Response><Pause length="20"/><Redirect>' + escapeXml(`${config.publicUrl}/twilio/wait`) + '</Redirect></Response>');
  });

  /** The family member answered our alert call: summary + keypad menu. */
  app.all('/twilio/family-call', requireTwilio, (req, res) => {
    const caller = String(req.query.caller ?? '');
    const st = settings.get();
    const name = st.protectedName;
    const summary = String(req.query.summary ?? '');
    const lang = getFamily().language;
    const line = lang.startsWith('zh')
      ? `Guardian 警报。${name}正在接一通疑似诈骗电话。${summary} 按 1 立即加入通话。按 2 断开对方并和${name}通话。`
      : `Guardian alert. ${name} is on a call that looks like a scam. ${summary} Press 1 to join the call now. Press 2 to disconnect the caller and talk to ${name}.`;
    const action = `${config.publicUrl}/twilio/family-choice?caller=${encodeURIComponent(caller)}`;
    res.type('text/xml').send(
      `<Response><Gather numDigits="1" timeout="8" action="${escapeXml(action)}" method="POST">${sayTwiml(line, lang)}</Gather>` +
      `<Gather numDigits="1" timeout="8" action="${escapeXml(action)}" method="POST">${sayTwiml(line, lang)}</Gather>` +
      `${sayTwiml(lang.startsWith('zh') ? '没有收到按键，再见。' : 'No key pressed. Goodbye.', lang)}</Response>`,
    );
  });

  /** 1 = join the conference, 2 = remove the caller, then join and talk to the protected person. */
  app.post('/twilio/family-choice', requireTwilio, async (req, res) => {
    const caller = String(req.query.caller ?? '');
    const digit = String(req.body?.Digits ?? '');
    const b = getBridge(caller);
    const lang = getFamily().language;
    const zh = lang.startsWith('zh');
    if (!b) {
      res.type('text/xml').send(`<Response>${sayTwiml(zh ? '通话已经结束了。' : 'That call has already ended.', lang)}</Response>`);
      return;
    }
    // Family leg never ends the conference when it leaves.
    const wait = config.publicUrl ? `${escapeXml(config.publicUrl)}/twilio/wait` : '';
    const join = `<Dial><Conference beep="false" waitUrl="${wait}" startConferenceOnEnter="true" endConferenceOnExit="false">${escapeXml(b.name)}</Conference></Dial>`;
    if (digit === '2') {
      const conf = await ensureConferenceSid(b).catch(() => null);
      if (conf) {
        try {
          await kick(conf, b.callerCallSid);
          bus.emit('alert:sent', { callSid: caller, channel: 'kick', message: 'Caller removed by the family (pressed 2)' });
        } catch (err: any) {
          log.error('call', `${shortSid(caller)}: family kick failed: ${err?.message ?? err}`);
        }
      }
      res.type('text/xml').send(`<Response>${sayTwiml(zh ? '已断开对方。正在为您接通。' : 'The caller has been disconnected. Connecting you now.', lang)}${join}</Response>`);
      return;
    }
    bus.emit('alert:sent', { callSid: caller, channel: 'family-call', message: 'Family joined the call (pressed 1)' });
    res.type('text/xml').send(`<Response>${sayTwiml(zh ? '正在加入通话。' : 'Joining the call now.', lang)}${join}</Response>`);
  });

  /**
   * TwiML for an announcement to one participant (AnnounceUrl, GET) or a redirected leg:
   *   /twilio/whisper?text=...&lang=zh   spoken with a neural voice
   *   /twilio/whisper?play=<mp3 url>     pre-recorded warning
   */
  app.all('/twilio/whisper', requireTwilio, (req, res) => {
    const text = String(req.query.text ?? '').slice(0, 400);
    const play = String(req.query.play ?? '');
    const lang = req.query.lang ? String(req.query.lang) : undefined;
    const body = play ? `<Play>${escapeXml(play)}</Play>` : text ? sayTwiml(text, lang) : '';
    log.info('whisper', `provider fetched whisper TwiML (${req.method}): ${play || text.slice(0, 80)}`);
    res.type('text/xml').send(`<Response>${body}</Response>`);
  });

  wss.on('connection', (ws) => {
    let callSid = '';
    let ended = false;
    let frames = 0;
    log.info('media', 'media stream socket connected');
    const stats = setInterval(() => { if (callSid) log.debug('media', `${shortSid(callSid)}: ${frames} audio frames in the last 5s`); frames = 0; }, 5000);
    ws.on('close', () => clearInterval(stats));
    const end = () => {
      if (!callSid || ended) return;
      ended = true;
      bus.emit('call:ended', { callSid });
    };
    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.event === 'connected') return log.info('media', `stream protocol ${msg.protocol ?? '?'} ${msg.version ?? ''}`);
      if (msg.event === 'start') {
        callSid = msg.start?.callSid ?? msg.start?.call_sid ?? '';
        log.info('media', `${shortSid(callSid)}: stream started, tracks ${JSON.stringify(msg.start?.tracks ?? '?')}, format ${JSON.stringify(msg.start?.mediaFormat ?? '?')}`);
        if (!callSid) log.error('media', `stream start without callSid: ${JSON.stringify(msg).slice(0, 300)}`);
        bus.emit('call:started', { callSid, from: msg.start.customParameters?.from ?? 'unknown' });
      } else if (msg.event === 'media' && callSid) {
        frames++;
        // With <Stream track="both_tracks">: inbound = the caller, outbound = what Twilio plays back
        // to the caller, i.e. the protected person's voice from the <Dial> leg.
        // Audio is passed along in memory only; it is never written to disk or logged.
        const speaker = msg.media.track === 'outbound' ? 'protected' : 'caller';
        bus.emit('call:audio', { callSid, speaker, payload: Buffer.from(msg.media.payload, 'base64') });
      } else if (msg.event === 'stop') {
        log.info('media', `${shortSid(callSid)}: stream stopped`);
        end();
        callerLeft(callSid);
        setTimeout(() => dropBridge(callSid), 60_000).unref();
      }
    });
    // A dropped socket without "stop" must still end the call, or its transcript would stay in memory.
    ws.on('close', end);
    ws.on('error', (err) => log.error('call', `media socket error${callSid ? ` (${shortSid(callSid)})` : ''}: ${err.message}`));
  });
}
