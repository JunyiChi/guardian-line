/**
 * Standalone Jev smoke test (not used by the app): one Decisions API request per transcript.
 *
 *   npx tsx scripts/jev-test.ts
 *
 * Needs JEV_API_KEY in .env. The key is never printed.
 */
import 'dotenv/config';

const URL = process.env.JEV_URL || 'https://api.defapi.org/api/v1/decisions';
const MODEL = process.env.JEV_MODEL || 'typesafe/jev-1.13';

const noul = (instructions: string, yes: string, no: string) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });

const QUESTIONS = {
  scam_likelihood: {
    type: 'score',
    instructions: 'How likely is it that the caller in this phone call transcript is a scammer?',
    criteria: [
      'Not a scam: normal conversation, no pressure, no requests for money or codes',
      'Unlikely: small oddities but no warning signs',
      'Possible: one warning sign such as urgency, a threat, or claiming to be an authority',
      'High chance: several warning signs together',
      'Definitely a scam: asks for money, codes, or personal data while pressuring or impersonating an authority',
    ],
  },
  urgency: noul('Does the caller pressure the protected person to act immediately?',
    'The caller demands action right now, today, or within a short deadline, or says there is no time.',
    'The caller does not push for immediate action; any timing mentioned is normal and relaxed.'),
  threat: noul('Does the caller threaten the protected person?',
    'The caller threatens arrest, legal action, fines, account closure, losing money, or other harm.',
    'The caller makes no threats.'),
  asks_for_codes_or_data: noul('Does the caller ask for codes or personal data?',
    'The caller asks for a verification code, PIN, password, ID or Social Security number, bank or card details, to install an app, or to click a link.',
    'The caller does not ask for any codes, credentials, personal numbers, app installs or links.'),
  asks_for_money: noul('Does the caller ask the protected person to send or move money?',
    'The caller asks to send or move money, buy gift cards, use crypto or a crypto ATM, wire money, or pay a fee before receiving something.',
    'The caller does not ask for any payment or money movement.'),
  impersonating_authority: noul('Does the caller claim to be an authority or a relative in trouble?',
    'The caller claims to be police, government, a bank, a tech company, a delivery company, or a relative in trouble.',
    'The caller does not claim to be any of these.'),
  asks_for_secrecy: noul('Does the caller ask for secrecy or to stay on the line?',
    'The caller says not to tell anyone, not to hang up, or to keep the matter confidential.',
    'The caller does not ask for secrecy and does not insist on staying on the line.'),
};

const TRANSCRIPTS = {
  scam: [
    'Caller: Hello, this is the fraud department at your bank. We detected suspicious activity on your account.',
    'Protected person: Oh no, what should I do?',
    "Caller: You must act now. Move your savings to a safe account we'll give you, and don't tell anyone, this is a confidential investigation.",
  ].join('\n'),
  normal: [
    'Caller: Hi, this is your bank calling to confirm a purchase of $45 at a grocery store yesterday. Was that you?',
    'Protected person: Yes, that was me.',
    'Caller: Great, thank you. No action is needed. Have a nice day.',
  ].join('\n'),
};

async function main() {
  const key = process.env.JEV_API_KEY;
  if (!key) {
    console.error('JEV_API_KEY is not set in .env');
    process.exit(1);
  }
  for (const [name, transcript] of Object.entries(TRANSCRIPTS)) {
    const body = { model: MODEL, state: { transcript, country: 'US' }, questions: QUESTIONS };
    const t0 = performance.now();
    const res = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ms = Math.round(performance.now() - t0);
    const text = await res.text();
    console.log(`\n=== ${name}: HTTP ${res.status} in ${ms} ms (${Buffer.byteLength(JSON.stringify(body))} bytes sent)`);
    let json: any;
    try { json = JSON.parse(text); } catch { console.log(text); continue; }
    console.log(JSON.stringify(json, null, 2));
    if (json.usage) console.log(`cost: $${json.usage.cost}  (input ${json.usage.input_tokens} tokens, output ${json.usage.output_tokens})`);
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
