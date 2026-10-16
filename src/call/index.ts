import crypto from 'crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'http';
import type { WebSocketServer } from 'ws';
import { bus } from '../events';
import { config } from '../config';
import { settings } from '../settings';
import { log, maskNumber, shortSid } from '../privacy/log';

/** Mandatory, always on, cannot be configured away. Spoken before any audio reaches the AI. */
export const ANNOUNCEMENT = 'This call is protected by Wessuwan, an AI scam protection service.';
/** Repeated in the country's main language when it isn't English. */
const ANNOUNCEMENT_LOCAL: Record<string, { text: string; lang: string }> = {
  de: { text: 'Dieser Anruf wird von Wessuwan geschützt, einem KI-Dienst zum Schutz vor Betrug.', lang: 'de-DE' },
  ja: { text: 'この通話は、AI詐欺防止サービスのウェッスワンによって保護されています。', lang: 'ja-JP' },
  fr: { text: 'Cet appel est protégé par Wessuwan, un service de protection contre les arnaques par IA.', lang: 'fr-FR' },
  es: { text: 'Esta llamada está protegida por Wessuwan, un servicio de protección contra estafas con IA.', lang: 'es-US' },
};

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
    const dial = `<Dial>${escapeXml(st.protectedNumber)}</Dial>`;
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
    res.type('text/xml').send(
      '<Response>' +
        `<Say language="en-US">${ANNOUNCEMENT}</Say>` +
        (local ? `<Say language="${local.lang}">${escapeXml(local.text)}</Say>` : '') +
        `<Start><Stream url="${escapeXml(wsUrl)}" track="both_tracks">` +
        `<Parameter name="from" value="${escapeXml(from)}"/></Stream></Start>` +
        dial +
      '</Response>',
    );
  });

  wss.on('connection', (ws) => {
    let callSid = '';
    let ended = false;
    const end = () => {
      if (!callSid || ended) return;
      ended = true;
      bus.emit('call:ended', { callSid });
    };
    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.event === 'start') {
        callSid = msg.start.callSid;
        bus.emit('call:started', { callSid, from: msg.start.customParameters?.from ?? 'unknown' });
      } else if (msg.event === 'media' && callSid) {
        // With <Stream track="both_tracks">: inbound = the caller, outbound = what Twilio plays back
        // to the caller, i.e. the protected person's voice from the <Dial> leg.
        // Audio is passed along in memory only; it is never written to disk or logged.
        const speaker = msg.media.track === 'outbound' ? 'protected' : 'caller';
        bus.emit('call:audio', { callSid, speaker, payload: Buffer.from(msg.media.payload, 'base64') });
      } else if (msg.event === 'stop') {
        end();
      }
    });
    // A dropped socket without "stop" must still end the call, or its transcript would stay in memory.
    ws.on('close', end);
    ws.on('error', (err) => log.error('call', `media socket error${callSid ? ` (${shortSid(callSid)})` : ''}: ${err.message}`));
  });
}
