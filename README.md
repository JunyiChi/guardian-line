# Guardian Line

**A family member who lives in the phone line.** Older adults keep answering every call themselves. When a call turns into a scam, Guardian whispers to them privately, lets them ask it a question mid-call, and brings a family member into the call with one key press. No app, no screen, no new phone.

Built in one day at c0mpiled-16 (UC San Diego, 2026-10-24) for the **No App** and **AI consumer products for 1 billion people** tracks.

## The three interactions (all inside an ordinary phone call)

| Who → whom | What happens | What the person does |
|---|---|---|
| Guardian → the protected person | A private whisper only they hear: "Mom, this call is a scam. Hang up now, David is calling you." | Nothing. They are protected while talking normally. |
| The protected person → Guardian | "Guardian, is this person for real?" asked out loud, mid-call | Say a word. |
| The family → Guardian | Their phone rings: "Press 1 to join the call. Press 2 to disconnect the caller." | Press one key. |

Design principles: **no gatekeeping** (the protected person may talk to anyone, including salespeople; Guardian stays silent by default), **identity is free, requests are evidence** (anyone can claim to be the bank; what matters is what they ask the person to do), **graded intervention set by the family** (five levels, from nothing to whisper).

## How it works

```
unknown caller ─(carrier call forwarding)─▶ Twilio number ─▶ this server
   trusted numbers: bridged straight through, never processed
   others: one-sentence protection notice → media stream (both tracks) → <Conference>
           the protected person is dialed into the same conference
   Deepgram streams each speaker → detector on every sentence end (both speakers)
   detector (Claude): stage none/rapport/pressure/isolation/extraction, what the caller wants,
                      signals from the protected person, family context check, action level
   policy: log → summary after call → SMS + call the family (1/2 menu) → whisper + SMS banner (+ optional kick)
   wake word on the protected person's track → whisper the current assessment
   dashboard: live transcript, risk curve, trajectory, requests, intervention log
```

Deployment needs no app anywhere: the family fills in `family.json` once and sets unconditional call forwarding on the protected person's phone (one carrier code, e.g. `**21*<Guardian number>#`). Dial `##21#` to leave.

## Run it

```bash
npm install
cp .env.example .env          # or use the prepared .env: Twilio, Deepgram, Anthropic keys
npm run dev                   # http://localhost:3000/dashboard
npm run tunnel                # cloudflared quick tunnel → set PUBLIC_URL in .env, restart dev
npm run doctor -- --fix-webhook   # checks keys, trial account, verified numbers, tunnel; points the Twilio webhook at PUBLIC_URL
npm run test:detector -- --detector=llm --provider=anthropic   # replay all scripts through the real detector
npm run sim scam-13-grandson-bail                              # live simulation through the real detector (Twilio mocked)
```

**Web phone (no telephony account needed).** Open the tunnel URL on three phones, earbuds in:
`/phone?role=senior`, `/phone?role=caller`, `/phone?role=family`. Tap Start on each, then Call from the caller phone.
Audio is relayed as 8 kHz mu-law through the same speech-to-text, detector and intervention pipeline as a real call;
the whisper is spoken only on the senior phone (its microphone pauses meanwhile), the family phone rings with the 1/2 menu.
Production uses carrier call forwarding into the Twilio conference path in `src/call/`.

Debug without a model key: `POST /demo/action?callSid=<SIM-…>&action=whisper_senior` forces an intervention level.

## Test scripts

`data/test-scripts/`: 14 scam and 9 normal transcripts (English and Chinese). `scripts/test-detector.ts` replays them sentence by sentence on a simulated call clock and checks: every scam warns, no normal call warns, code requests warn before the person can answer, and checkpoint scripts (fake courier, grandson in jail) do **not** alarm early.

Results (2026-10-24, Claude Opus 5.5 single tier via an API proxy, sentence-by-sentence replay):

| Set | Result |
|---|---|
| 9 normal calls (bank purchase check, doctor, courier, grandchild, charity, two sales calls, Chinese supplement sales, sales + "Guardian?") | **0 false alarms**, peak risk 5-30 |
| 14 scam calls (IRS, SSA, bank "safe account", grandparent, tech support, gift cards, crypto ATM, investment, delivery fee, utility, lottery, fake courier customs fee, grandson bail, Chinese police impersonation) | **13 warned** (risk 93-99, typically by the 3rd-5th caller sentence); 1 replay aborted on a proxy timeout (scored 97 when re-run directly) |
| Checkpoints (fake courier must look like a courier for 4 lines; grandson scam must not alarm on line 2) | passed |
| Model latency per check | avg 5.1 s, max 6.1 s through the proxy (129 checks) |

## Built on Wessuwan (MIT)

This project is built on [Wessuwan](https://github.com/chenjunmingk-source/Wessuwan) (MIT, upstream commit `be8b4b0`). We kept its Twilio webhook and signature checks, Deepgram dual-track streaming, dashboard skeleton, SMS channel, privacy model and test harness.

New in this hackathon (`git log upstream/main..guardian`):
- conference-based bridging with a **private whisper** that keeps the caller connected (Wessuwan's warning disconnected the caller);
- a **trajectory detector** (stage model, hard rules, requests-of-the-person, signals from the protected person) replacing the four-signal count, analysing **both** sides of the call with **family context**;
- the **wake word** ("Guardian, …") answered privately mid-call;
- the **family keypad menu** (press 1 join / 2 drop the caller) and the **five-level intervention policy** capped by the family;
- SMS banner on the protected person's phone, end-of-call summaries, a **live simulation mode** through the real model, trajectory panel and intervention log on the dashboard, bilingual test scripts with checkpoints.

## Privacy

The caller hears a protection notice before any audio reaches the model (California is an all-party-consent state). Trusted numbers are never processed. No audio is stored; transcripts live in memory for the duration of the call; flagged calls leave only a short encrypted summary. The family receives summaries, not recordings.
