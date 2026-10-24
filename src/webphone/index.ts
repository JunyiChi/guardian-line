import type { IncomingMessage } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { bus } from '../events';
import { settings } from '../settings';
import { getFamily } from '../config/family';
import { log } from '../privacy/log';

/**
 * Web phone: a carrier-free stand-in for the phone network, for demos without a telephony account.
 * Three browsers (usually three phones) open /phone?role=caller|senior|family. Audio is 8 kHz mu-law
 * (exactly what a Twilio media stream carries), so the speech-to-text, detector and alert pipeline run
 * unchanged. The only differences from a real call: the "network" is this relay, and the whisper is
 * spoken by the protected person's browser (sent only to their socket, so the caller never hears it).
 *
 * Wire format
 *   client -> server  text: {type: hello|dial|answer|hangup|family, role?, choice?}   binary: mu-law 8k audio
 *   server -> client  text: {type: state|incoming|connected|ended|whisper|notice|ring|joined}
 *                     binary: [1 byte source: 0 caller, 1 senior, 2 family] + mu-law 8k audio
 */

type Role = 'caller' | 'senior' | 'family';
const SOURCE: Record<Role, number> = { caller: 0, senior: 1, family: 2 };

interface WebCall {
  callSid: string;
  state: 'ringing' | 'connected';
  familyJoined: boolean;
  callerDropped: boolean;
}

const sockets: Partial<Record<Role, WebSocket>> = {};
let call: WebCall | null = null;

const send = (role: Role, msg: object) => {
  const ws = sockets[role];
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};
const sendAudio = (role: Role, source: Role, payload: Buffer) => {
  const ws = sockets[role];
  if (ws?.readyState !== WebSocket.OPEN) return;
  const frame = Buffer.allocUnsafe(payload.length + 1);
  frame[0] = SOURCE[source];
  payload.copy(frame, 1);
  ws.send(frame);
};

function broadcastState(): void {
  const st = {
    type: 'state',
    online: { caller: !!sockets.caller, senior: !!sockets.senior, family: !!sockets.family },
    call: call ? { state: call.state, familyJoined: call.familyJoined, callerDropped: call.callerDropped } : null,
    seniorName: settings.get().protectedName,
    childName: getFamily().childName,
  };
  for (const r of Object.keys(sockets) as Role[]) send(r, st);
}

function endCall(reason: string): void {
  if (!call) return;
  const c = call;
  call = null;
  for (const r of ['caller', 'senior', 'family'] as Role[]) {
    if (r === 'caller' && c.callerDropped) continue; // already told it was disconnected
    send(r, { type: 'ended', reason });
  }
  if (c.state === 'connected' || c.state === 'ringing') bus.emit('call:ended', { callSid: c.callSid });
  log.info('webphone', `${c.callSid} ended (${reason})`);
  broadcastState();
}

/** True for calls carried by the web phone (callSid WEB-...). */
export const isWebCall = (callSid: string) => callSid.startsWith('WEB-');

/** Whisper: only the protected person's browser receives it and speaks it. */
export function webWhisper(callSid: string, text: string, lang: string): boolean {
  if (call?.callSid !== callSid || !sockets.senior) return false;
  send('senior', { type: 'whisper', text, lang });
  log.info('webphone', `${callSid} whisper -> senior: ${text}`);
  return true;
}

/** Family alert call: the family browser rings, speaks the summary, and offers 1 join / 2 drop caller. */
export function webRingFamily(callSid: string, summary: string): boolean {
  if (call?.callSid !== callSid || !sockets.family) return false;
  send('family', { type: 'ring', summary, seniorName: settings.get().protectedName, lang: getFamily().language });
  return true;
}

/** Removes the caller; the protected person stays on the line (with the family, if they joined). */
export function webDropCaller(callSid: string): boolean {
  if (call?.callSid !== callSid) return false;
  call.callerDropped = true;
  send('caller', { type: 'ended', reason: 'disconnected' });
  bus.emit('alert:sent', { callSid, channel: 'kick', message: 'Caller removed from the call' });
  if (!call.familyJoined) send('senior', { type: 'notice', text: 'caller-dropped' });
  broadcastState();
  return true;
}

function onMessage(role: Role, raw: WebSocket.RawData, isBinary: boolean): void {
  if (isBinary) {
    if (!call || call.state !== 'connected') return;
    const payload = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    if (role === 'caller' && call.callerDropped) return;
    if (role === 'family' && !call.familyJoined) return;
    for (const other of ['caller', 'senior', 'family'] as Role[]) {
      if (other === role) continue;
      if (other === 'caller' && call.callerDropped) continue;
      if (other === 'family' && !call.familyJoined) continue;
      sendAudio(other, role, payload);
    }
    // Speech-to-text: caller and protected person only (the family joining is not analysed).
    if (role === 'caller') bus.emit('call:audio', { callSid: call.callSid, speaker: 'caller', payload });
    if (role === 'senior') bus.emit('call:audio', { callSid: call.callSid, speaker: 'protected', payload });
    return;
  }
  let msg: any;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  switch (msg.type) {
    case 'dial': {
      if (role !== 'caller') return;
      if (call) return send('caller', { type: 'ended', reason: 'busy' });
      if (!sockets.senior) return send('caller', { type: 'ended', reason: 'unreachable' });
      call = { callSid: `WEB-${Date.now()}`, state: 'ringing', familyJoined: false, callerDropped: false };
      bus.emit('call:ringing', { callSid: call.callSid, from: 'Web caller' });
      send('senior', { type: 'incoming', from: 'Unknown number' });
      send('caller', { type: 'ringing' });
      log.info('webphone', `${call.callSid} ringing`);
      broadcastState();
      return;
    }
    case 'answer': {
      if (role !== 'senior' || !call || call.state !== 'ringing') return;
      call.state = 'connected';
      // The caller hears the protection notice before any audio reaches speech-to-text (all-party consent).
      send('caller', { type: 'connected', notice: 'This call is protected by Guardian, a family safety service.' });
      send('senior', { type: 'connected' });
      bus.emit('call:started', { callSid: call.callSid, from: 'Web caller' });
      broadcastState();
      return;
    }
    case 'hangup': {
      if (!call) return;
      if (role === 'family' && call.familyJoined) {
        call.familyJoined = false;
        send('family', { type: 'ended', reason: 'left' });
        broadcastState();
        return;
      }
      if (role === 'caller' && call.callerDropped) return;
      endCall(`${role} hung up`);
      return;
    }
    case 'family': {
      if (role !== 'family' || !call) return;
      if (msg.choice === '2') webDropCaller(call.callSid);
      call.familyJoined = true;
      send('family', { type: 'joined' });
      send('senior', { type: 'notice', text: 'family-joined' });
      bus.emit('alert:sent', { callSid: call.callSid, channel: 'family-call', message: msg.choice === '2' ? 'Family pressed 2: caller removed, family joined' : 'Family pressed 1: joined the call' });
      broadcastState();
      return;
    }
  }
}

/** Handles WebSocket upgrades on /webphone. */
export function setupWebPhone(): (req: IncomingMessage, socket: any, head: Buffer) => boolean {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    const role = new URL(req.url ?? '', 'http://x').searchParams.get('role') as Role;
    if (!['caller', 'senior', 'family'].includes(role)) return ws.close();
    sockets[role]?.close();
    sockets[role] = ws;
    log.info('webphone', `${role} phone online`);
    broadcastState();
    ws.on('message', (raw, isBinary) => onMessage(role, raw, isBinary));
    ws.on('close', () => {
      if (sockets[role] !== ws) return;
      delete sockets[role];
      log.info('webphone', `${role} phone offline`);
      if (call && (role === 'senior' || (role === 'caller' && !call.callerDropped))) endCall(`${role} disconnected`);
      broadcastState();
    });
  });
  return (req, socket, head) => {
    if (!req.url?.startsWith('/webphone')) return false;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return true;
  };
}
