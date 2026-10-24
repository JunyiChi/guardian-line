/**
 * Pre-flight check for a live demo. Read-only unless --fix-webhook is passed.
 *
 *   npm run doctor                 # check everything
 *   npm run doctor -- --fix-webhook   # also point the Twilio number's voice webhook at PUBLIC_URL/twilio/voice
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../src/config';
import { getFamily } from '../src/config/family';

const fix = process.argv.includes('--fix-webhook');
let failures = 0;
const ok = (m: string) => console.log(`  ✔ ${m}`);
const bad = (m: string) => { failures++; console.log(`  ✘ ${m}`); };
const warn = (m: string) => console.log(`  ! ${m}`);
const E164 = /^\+[1-9]\d{6,14}$/;

async function twilio(method: string, path: string, form?: Record<string, string>): Promise<any> {
  const { accountSid, authToken } = config.twilio;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}${path}`, {
    method,
    headers: { Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64') },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${body.message ?? res.statusText}`);
  return body;
}

async function main() {
  console.log('\n[1] .env');
  const need: [string, string][] = [
    ['ANTHROPIC_API_KEY', config.llm.anthropic.apiKey], ['DEEPGRAM_API_KEY', config.stt.deepgramApiKey],
    ['TWILIO_ACCOUNT_SID', config.twilio.accountSid], ['TWILIO_AUTH_TOKEN', config.twilio.authToken],
    ['TWILIO_PHONE_NUMBER', config.twilio.phoneNumber], ['PROTECTED_PHONE_NUMBER', config.protectedPerson.number],
    ['FAMILY_PHONE_NUMBERS', config.alerts.familyNumbers.join(',')], ['PUBLIC_URL', config.publicUrl],
  ];
  for (const [k, v] of need) (v ? ok : bad)(`${k} ${v ? 'set' : 'is empty'}`);
  for (const [k, v] of [['TWILIO_PHONE_NUMBER', config.twilio.phoneNumber], ['PROTECTED_PHONE_NUMBER', config.protectedPerson.number], ...config.alerts.familyNumbers.map((n) => ['FAMILY_PHONE_NUMBERS', n])] as [string, string][]) {
    if (v && !E164.test(v)) bad(`${k} "${v}" is not E.164 (+18585550123)`);
  }
  if (config.detector !== 'llm' || config.llm.provider !== 'anthropic') bad(`DETECTOR=llm and LLM_PROVIDER=anthropic expected (got ${config.detector}/${config.llm.provider})`);
  if (config.stt.provider !== 'deepgram') warn(`STT_PROVIDER=${config.stt.provider} (deepgram recommended)`);
  if (process.env.MOCK === 'true') bad('MOCK=true: no real calls or SMS will be made');
  if (config.autoHangupThreshold !== null) warn(`AUTO_HANGUP_THRESHOLD=${config.autoHangupThreshold}: calls may be cut during rehearsal`);
  if (process.env.CONSENT_RECORDED !== 'true') warn('CONSENT_RECORDED is not true: calls ring straight through until /setup records consent');
  const f = getFamily();
  ok(`family.json: ${f.seniorName} (${f.language}), child ${f.childName}, max ${f.maxIntervention}, kick ${f.allowKick}`);

  console.log('\n[2] Anthropic');
  if (config.llm.anthropic.apiKey) {
    try {
      const client = new Anthropic({ apiKey: config.llm.anthropic.apiKey });
      for (const model of [config.llm.anthropic.fastModel, config.llm.anthropic.preciseModel]) {
        const t0 = Date.now();
        await client.messages.create({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }] });
        ok(`${model} answers (${Date.now() - t0} ms)`);
      }
    } catch (err: any) {
      bad(`Anthropic call failed: ${err?.message ?? err}`);
    }
  }

  console.log('\n[3] Deepgram');
  if (config.stt.deepgramApiKey) {
    const res = await fetch('https://api.deepgram.com/v1/projects', { headers: { Authorization: `Token ${config.stt.deepgramApiKey}` } }).catch((e) => e);
    if (res instanceof Error) bad(`Deepgram unreachable: ${res.message}`);
    else (res.ok ? ok : bad)(`Deepgram key ${res.ok ? 'valid' : `rejected (${res.status})`}`);
  }

  console.log('\n[4] Twilio');
  if (config.twilio.accountSid && config.twilio.authToken) {
    try {
      const acct = await twilio('GET', '.json');
      if (acct.type === 'Trial') bad('Twilio account is a TRIAL: outbound calls start with a "trial account" message. Upgrade before the demo.');
      else ok(`account ${acct.friendly_name} (${acct.type}, ${acct.status})`);

      const nums = await twilio('GET', `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(config.twilio.phoneNumber)}`);
      const n = nums.incoming_phone_numbers?.[0];
      if (!n) bad(`${config.twilio.phoneNumber} is not a number on this account`);
      else {
        const want = `${config.publicUrl}/twilio/voice`;
        if (n.voice_url === want && (n.voice_method ?? 'POST') === 'POST') ok(`voice webhook = ${want}`);
        else if (fix && config.publicUrl) {
          await twilio('POST', `/IncomingPhoneNumbers/${n.sid}.json`, { VoiceUrl: want, VoiceMethod: 'POST' });
          ok(`voice webhook updated: ${n.voice_url || '(none)'} -> ${want}`);
        } else bad(`voice webhook is "${n.voice_url || '(none)'}", expected ${want}  (run: npm run doctor -- --fix-webhook)`);
        if (!n.capabilities?.sms) warn('this number has no SMS capability: family and banner SMS will fail');
      }

      if (acct.type === 'Trial') {
        const ids = await twilio('GET', '/OutgoingCallerIds.json?PageSize=100');
        const verified = new Set((ids.outgoing_caller_ids ?? []).map((c: any) => c.phone_number));
        for (const p of [config.protectedPerson.number, ...config.alerts.familyNumbers].filter(Boolean)) {
          (verified.has(p) ? ok : bad)(`${p} ${verified.has(p) ? 'is a verified caller ID' : 'is NOT verified (trial accounts can only call verified numbers)'}`);
        }
      }
    } catch (err: any) {
      bad(`Twilio API failed: ${err?.message ?? err}`);
    }
  }

  console.log('\n[5] Public URL');
  if (config.publicUrl) {
    if (!config.publicUrl.startsWith('https://')) bad('PUBLIC_URL must be https:// (Twilio media streams need wss://)');
    const res = await fetch(`${config.publicUrl}/health`).catch((e) => e);
    if (res instanceof Error) bad(`${config.publicUrl}/health unreachable (${res.message}). Is "npm run dev" running and the tunnel up?`);
    else (res.ok ? ok : bad)(`${config.publicUrl}/health -> ${res.status}`);
  }

  console.log(failures ? `\n${failures} problem(s) to fix before calling.\n` : '\nAll good. Call the Twilio number from a phone that is NOT in TRUSTED_NUMBERS.\n');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
