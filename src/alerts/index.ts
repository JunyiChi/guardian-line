import type { Express } from 'express';
import { bus, AlertChannel, Guardian } from '../events';
import { config } from '../config';
import { settings } from '../settings';
import { store } from '../store';
import { createCall, ensureConferenceSid, getBridge, hangUp, isMockCall, kick, sendMessage, whisper } from '../call/twilio';
import { WARNING_TEXT, baseLang, ensureWarningAudio } from './tts';
import { SCAM_TYPE_LABEL, ScamType } from '../detector/prompt';
import { ACTION_RANK, Action, getFamily } from '../config/family';
import { log, maskNumber, shortSid } from '../privacy/log';

/**
 * Guardian intervention policy. Driven by the detector's `action` on every risk-update:
 *   log                      dashboard only
 *   notify_child_after_call  one summary SMS to the family when the call ends
 *   notify_child_now         + SMS now + a phone call to the family (press 1 to join, 2 to drop the caller)
 *   whisper_senior           + SMS banner on the protected person's phone + private whisper in the call
 *                            (+ drop the caller if the family allowed it)
 * The level only goes up during a call, and each level fires once.
 */

const absolute = (p: string) => `${config.publicUrl || `http://localhost:${config.port}`}${p}`;
/** Fictional number (555 range) the demo's family alert is previewed to. */
const DEMO_FAMILY = '+15550100';
const isDemoCall = (callSid: string) => config.publicDemo.enabled || /^(DEMO|SIM)-/.test(callSid);

interface CallAlerts {
  level: number;
  last: Guardian | null;
  summary: string;
  whispers: number;
  familyCalled: boolean;
  askedAt: number;
}
const state = new Map<string, CallAlerts>();
const stateOf = (callSid: string) => {
  let s = state.get(callSid);
  if (!s) state.set(callSid, (s = { level: 0, last: null, summary: '', whispers: 0, familyCalled: false, askedAt: 0 }));
  return s;
};

function record(callSid: string, channel: AlertChannel, message: string): void {
  bus.emit('alert:sent', { callSid, channel, message });
}

// ---- texts ---------------------------------------------------------------------------------

const WHO: Record<string, string> = {
  police: 'the police', government: 'a government agency', bank: 'a bank', tech_company: 'a tech company',
  delivery_company: 'a delivery company', utility: 'a utility company', relative: 'a family member', company: 'a company',
};
const ASKS: Record<string, string> = {
  gift_card_payment: 'is asking for gift cards', crypto_atm_payment: 'is asking for a crypto ATM deposit',
  remote_access_app: 'is asking to install a remote-access app',
};

/** Legacy alert text (setup page test alert, Try it preview). */
export function smsText(opts: { name: string; score: number; scamType: string; impersonating: string; reason: string }): string {
  const claim = WHO[opts.impersonating] ? `Caller claims to be ${WHO[opts.impersonating]}` : `Looks like: ${SCAM_TYPE_LABEL[opts.scamType as ScamType] ?? opts.scamType}`;
  const asks = ASKS[opts.scamType] ? ` and ${ASKS[opts.scamType]}` : '';
  const why = opts.reason ? ` ${opts.reason.replace(/\s+/g, ' ').trim().slice(0, 160)}` : '';
  return `Guardian ALERT: ${opts.name} may be on a scam call right now. ${claim}${asks}.${why} Risk ${opts.score}/100. Call ${opts.name} now.`;
}

const T = {
  en: {
    familyNow: (name: string, summary: string, score: number) => `Guardian ALERT: ${name} is on a call that looks like a scam. ${summary} Risk ${score}/100. We are calling you now.`,
    familyAfter: (name: string, summary: string) => `Guardian note: ${name} had a call worth knowing about. ${summary} No alert was needed during the call.`,
    familyEnd: (name: string, score: number, summary: string) => `Guardian: ${name}'s call has ended. Peak risk ${score}/100. ${summary}`,
    seniorBanner: (child: string) => `Guardian: this call may be a scam. Do not share any codes and do not send money. ${child} has been told and will call you.`,
    whisperDefault: (name: string, child: string) => `${name}, this call is a scam. Please hang up now. ${child} is calling you right away.`,
    askNone: (child: string) => `I haven't heard anything wrong yet. Keep talking, I'm here. Just say my name again if you want me to check.`,
    askLow: (reason: string) => `${reason} They haven't asked you for money or any information. It's your call.`,
    askMid: (reason: string, asks: string) => `Be careful. ${reason} They want you to ${asks}. You don't have to decide anything on this call.`,
    familyCall: (name: string, summary: string) => `Guardian alert. ${name} is on a call that looks like a scam. ${summary} Press 1 to join the call now. Press 2 to disconnect the caller and talk to ${name}.`,
  },
  zh: {
    familyNow: (name: string, summary: string, score: number) => `Guardian 警报：${name}正在接一通疑似诈骗电话。${summary} 风险 ${score}/100。我们正在给您打电话。`,
    familyAfter: (name: string, summary: string) => `Guardian 提示：${name}刚接了一通值得留意的电话。${summary} 通话中未触发警报。`,
    familyEnd: (name: string, score: number, summary: string) => `Guardian：${name}的通话已结束。最高风险 ${score}/100。${summary}`,
    seniorBanner: (child: string) => `Guardian：这通电话可能是诈骗。不要给任何验证码，不要转账。${child}已经收到通知，马上会打给您。`,
    whisperDefault: (name: string, child: string) => `${name}，这个电话是骗子，先挂掉。${child}马上打给你。`,
    askNone: (_child: string) => `我还没听到问题，你继续聊，我在。想让我再看一眼就再叫我一声。`,
    askLow: (reason: string) => `${reason} 对方没有要你付钱或给信息，你自己决定。`,
    askMid: (reason: string, asks: string) => `小心。${reason} 对方想让你${asks}。这通电话里你不需要做任何决定。`,
    familyCall: (name: string, summary: string) => `Guardian 警报。${name}正在接一通疑似诈骗电话。${summary} 按 1 立即加入通话。按 2 断开对方并和${name}通话。`,
  },
};
const texts = () => (baseLang(getFamily().language) === 'zh' ? T.zh : T.en);

// ---- actions -------------------------------------------------------------------------------

async function familySms(callSid: string, text: string): Promise<void> {
  const st = settings.get();
  const numbers = st.familyNumbers.length ? st.familyNumbers : isDemoCall(callSid) ? [DEMO_FAMILY] : [];
  if (!numbers.length) return log.warn('alerts', 'no FAMILY_PHONE_NUMBERS configured: family alert skipped');
  const results = await Promise.allSettled(numbers.map((n) => sendMessage(n, text, st.alertChannel, callSid)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') log.error('alerts', `${shortSid(callSid)}: ${st.alertChannel} to ${maskNumber(numbers[i])} failed: ${r.reason?.message ?? r.reason}`);
  });
  if (results.some((r) => r.status === 'fulfilled')) record(callSid, st.alertChannel, text);
}

async function familyCall(callSid: string, s: CallAlerts, summary: string): Promise<void> {
  if (s.familyCalled) return;
  s.familyCalled = true;
  const st = settings.get();
  const to = st.familyNumbers[0];
  const msg = `Family call placed (press 1 join / 2 drop caller)`;
  if (!to || isMockCall(callSid)) {
    log.info('mock', `${shortSid(callSid)}: would call family ${to ? maskNumber(to) : '(none set)'} with the 1/2 menu`);
    record(callSid, 'family-call', msg);
    return;
  }
  try {
    const q = new URLSearchParams({ caller: callSid, summary: summary.slice(0, 300) });
    await createCall({ to, url: absolute(`/twilio/family-call?${q}`), timeoutSec: 25 });
    record(callSid, 'family-call', msg);
  } catch (err: any) {
    log.error('alerts', `${shortSid(callSid)}: family call failed: ${err?.message ?? err}`);
  }
}

async function seniorBanner(callSid: string): Promise<void> {
  const st = settings.get();
  const text = texts().seniorBanner(getFamily().childName);
  if (!st.protectedNumber && !isDemoCall(callSid)) return;
  try {
    await sendMessage(st.protectedNumber || '+15550100', text, 'sms', callSid);
    record(callSid, 'senior-sms', text);
  } catch (err: any) {
    log.error('alerts', `${shortSid(callSid)}: SMS to the protected person failed: ${err?.message ?? err}`);
  }
}

async function whisperSenior(callSid: string, s: CallAlerts, text: string): Promise<void> {
  if (s.whispers >= 2) return;
  s.whispers++;
  const lang = baseLang(getFamily().language);
  try {
    const how = await whisper(callSid, { text, lang });
    record(callSid, 'voice', `Whisper to ${settings.get().protectedName} (${how}): ${text}`);
  } catch (err: any) {
    log.error('alerts', `${shortSid(callSid)}: whisper failed: ${err?.message ?? err}`);
  }
}

async function dropCaller(callSid: string): Promise<void> {
  const b = getBridge(callSid);
  if (isMockCall(callSid)) {
    log.info('mock', `${shortSid(callSid)}: would remove the caller from the conference`);
    record(callSid, 'kick', 'Caller removed from the call');
    return;
  }
  const conf = b ? await ensureConferenceSid(b).catch(() => null) : null;
  if (!b || !conf) return log.warn('alerts', `${shortSid(callSid)}: cannot kick, conference unknown`);
  try {
    await kick(conf, b.callerCallSid);
    record(callSid, 'kick', 'Caller removed from the call');
  } catch (err: any) {
    log.error('alerts', `${shortSid(callSid)}: kick failed: ${err?.message ?? err}`);
  }
}

/** Applies every level between the call's current level and the new one, once each. */
async function escalate(callSid: string, g: Guardian, score: number): Promise<void> {
  const s = stateOf(callSid);
  s.last = g;
  if (g.summaryForChild) s.summary = g.summaryForChild;
  const target = ACTION_RANK[g.action as Action] ?? 0;
  if (target <= s.level) return;
  const from = s.level;
  s.level = target;
  const name = settings.get().protectedName;
  const t = texts();
  const summary = s.summary || g.reason;
  log.info('alerts', `${shortSid(callSid)}: intervention ${from} -> ${target} (${g.action}), stage ${g.stage}`);

  if (target >= 3 && from < 3) {
    await Promise.all([familySms(callSid, t.familyNow(name, summary, score)), familyCall(callSid, s, summary)]);
  }
  if (target >= 4 && from < 4) {
    const text = g.whisperText || t.whisperDefault(name, getFamily().childName);
    await Promise.all([seniorBanner(callSid), whisperSenior(callSid, s, text)]);
    if (getFamily().allowKick) await dropCaller(callSid);
  }
}

/** "Guardian, is this real?" -> whisper the current assessment to the protected person only. */
async function answerAsk(callSid: string, s: CallAlerts): Promise<void> {
  const now = Date.now();
  if (now - s.askedAt < 10_000) return;
  s.askedAt = now;
  const t = texts();
  const g = s.last;
  let text: string;
  if (!g) text = t.askNone(getFamily().childName);
  else if (s.level >= 4) text = g.whisperText || t.whisperDefault(settings.get().protectedName, getFamily().childName);
  else if (s.level >= 2 || g.requests.length) text = t.askMid(g.reason ?? '', g.requests.join(', ') || '…');
  else text = t.askLow(g.reason ?? '');
  const lang = baseLang(getFamily().language);
  try {
    const how = await whisper(callSid, { text, lang });
    record(callSid, 'voice', `Answered "Guardian?" (${how}): ${text}`);
  } catch (err: any) {
    log.error('alerts', `${shortSid(callSid)}: could not answer the wake word: ${err?.message ?? err}`);
  }
}

async function maybeHangUp(callSid: string, score: number): Promise<void> {
  const limit = settings.get().autoHangupThreshold;
  if (limit === null || score <= limit) return;
  try {
    await hangUp(callSid);
    record(callSid, 'hangup', `Call hung up automatically (risk ${score}/100 > ${limit})`);
  } catch (err: any) {
    log.error('alerts', `${shortSid(callSid)}: auto hang-up failed: ${err?.message ?? err}`);
  }
}

/** Guardian policy: whisper, family SMS/call, banner, wake-word answers, end-of-call summaries. */
export function setupAlerts(app: Express): void {
  const c = settings.country();
  ensureWarningAudio([c.defaultLanguage, ...c.sttLanguages]).catch((err) =>
    log.error('alerts', `Google TTS failed: ${err.message}. Record public/audio/warning.mp3 yourself instead.`));

  bus.on('risk-update', async (u) => {
    if (u.guardian) await escalate(u.callSid, u.guardian, u.score);
    else if (u.status === 'scam' && stateOf(u.callSid).level < 4) {
      // Jev / scripted demo path (no guardian fields): treat a detected scam as whisper level.
      await escalate(u.callSid, {
        stage: 'extraction', category: 'scam_other', requests: [], evidence: [], seniorSignals: [], action: 'whisper_senior',
        summaryForChild: u.reason, whisperText: WARNING_TEXT[baseLang(getFamily().language)] ?? WARNING_TEXT.en, reason: u.reason,
      }, u.score);
    }
    await maybeHangUp(u.callSid, u.score);
  });

  bus.on('guardian:ask', ({ callSid }) => answerAsk(callSid, stateOf(callSid)));

  bus.on('call:ended', async ({ callSid }) => {
    const s = state.get(callSid);
    state.delete(callSid);
    if (!s || s.level < 2) return;
    const name = settings.get().protectedName;
    const peak = store.get(callSid)?.risk.reduce((m, r) => Math.max(m, r.score), 0) ?? 0;
    const t = texts();
    await familySms(callSid, s.level >= 3 ? t.familyEnd(name, peak, s.summary) : t.familyAfter(name, s.summary));
  });

  /** Setup page "Send test alert": one SMS/WhatsApp to every family number (logged only in MOCK/PUBLIC_DEMO). */
  app.post('/api/test-alert', async (_req, res) => {
    const st = settings.get();
    if (config.publicDemo.enabled) {
      const preview = smsText({ name: 'Mom', score: 92, scamType: 'gift_card_payment', impersonating: 'government', reason: 'TEST ALERT from your Guardian setup. No action needed.' });
      return res.json({ ok: true, sent: 0, failed: 0, channel: 'sms', preview, mock: true });
    }
    if (!st.familyNumbers.length) return res.status(400).json({ error: 'Add at least one family phone number first.' });
    const text = smsText({ name: st.protectedName, score: 92, scamType: 'gift_card_payment', impersonating: 'government', reason: 'TEST ALERT from your Guardian setup. No action needed.' });
    const results = await Promise.allSettled(st.familyNumbers.map((n) => sendMessage(n, text, st.alertChannel)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    res.json({ ok: failed === 0, sent: results.length - failed, failed, channel: st.alertChannel, preview: text, mock: config.publicDemo.enabled || process.env.MOCK === 'true' });
  });

  /**
   * Debug/demo: force an intervention level on a live or SIM call without the model, e.g.
   *   POST /demo/action?callSid=SIM-123&action=whisper_senior
   */
  app.post('/demo/action', async (req, res) => {
    const callSid = String(req.query.callSid ?? req.body?.callSid ?? '');
    const action = String(req.query.action ?? req.body?.action ?? 'whisper_senior') as Action;
    if (!callSid || !(action in ACTION_RANK)) return res.status(400).json({ ok: false, error: 'callSid and a valid action are required' });
    const g: Guardian = {
      stage: action === 'whisper_senior' ? 'extraction' : action === 'notify_child_now' ? 'isolation' : 'pressure',
      category: 'scam_authority', requests: ['move money to a safe account'], evidence: ['caller: move it to the secure account now'],
      seniorSignals: [], action, summaryForChild: 'Test: a caller posing as the bank asked for a transfer to a "safe account".',
      whisperText: '', reason: 'The caller claims to be the bank and wants money moved to a "safe account".',
    };
    const score = ACTION_RANK[action] >= 4 ? 90 : ACTION_RANK[action] >= 3 ? 75 : 50;
    bus.emit('risk-update', {
      callSid, score, rawScore: score, scamType: 'bank_fraud_department', reason: g.summaryForChild, signals: { urgency: true, threat: true, data_request: false, transfer_request: true },
      impersonating: 'bank', tier: 'precise', detector: 'llm', status: score >= 70 ? 'scam' : 'watching', guardian: g,
    });
    res.json({ ok: true, callSid, action, score });
  });
}
