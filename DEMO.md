# Guardian Line · Demo runbook

## Fixed facts

| Item | Value |
|---|---|
| Guardian number (the scammer dials this) | **+1 619 765 1019** (SignalWire) |
| Protected person's phone | +1 619 555 0101 (save the Guardian number in its contacts as "Guardian") |
| Family phone | +1 619 555 0102 |
| Scammer phone | +1 619 555 0103 |
| Dashboard | `PUBLIC_URL/dashboard` |
| Server | laptop, `npm run dev`; tunnel already running (do **not** restart `npm run tunnel`, the URL changes) |

## Ten minutes before going on

```
cd guardian
npm run doctor        # everything ✔
```
- Dashboard open and "online".
- Phones at full volume, silent switch off. Keep the three phones at least a metre apart (a phone picking up another phone's audio confuses the transcript).
- One rehearsal call: scammer dials, protected person answers, one sentence each, both sides appear on the dashboard, hang up.

## Act 1 · Sales call + "Guardian?" (about 60 s)

1. Scammer dials the Guardian number; the protected person answers. The scammer hears "This call is protected by Guardian."
2. Scammer: "Hi Margaret, this is Tyler from SunBright Solar. We're doing free home energy assessments in your neighborhood this month."
3. Protected person: "Oh… what is this about?"
4. Scammer: "Homeowners are saving forty percent on their electric bills. The assessment is free, no obligation. Can I book you for Friday?"
5. Protected person, after a beat, clearly: **"Guardian, is this person for real?"**
6. 2–5 s later she steps out of the call for a moment and hears, alone: "Solar sales call offering a free assessment; no money or information has been asked of you. Your call." Then she is back in the call. The scammer hears a few seconds of silence.
7. Protected person: "I'll think about it and talk to my son." Scammer: "Of course, I'll follow up next week." Hang up.
8. Dashboard: green throughout, trajectory at most *rapport*, action "no action" / "logged only", a log line `Answered "Guardian?"`.

Line: **"We don't decide who she talks to. She can buy solar panels. But she can always ask."**

## Act 2 · Bank "safe account" (about 90 s)

1. Scammer dials again; the protected person answers.
2. Scammer: "This is the Chase fraud department. Am I speaking with Margaret?"  — "Yes."
3. Scammer: "We detected a 2,400 dollar charge in Texas. Did you authorize that?"  — "No!"
4. Scammer: "Your account is compromised. **Do not hang up and do not tell anyone**, they may be monitoring your phone."
   → dashboard turns yellow, trajectory reaches *isolation*.
5. Scammer: "**Open your Chase app and move your savings to the secure account I'm giving you now.**"  — "Okay, what do I do?"
   → within 3–6 s: the whisper in her ear ("Margaret, this call is a scam. Please hang up now. David is calling you right away.") and the family phone rings.
6. Family answers, hears the summary and the menu, **presses 1**: "Mom, hang up, it's me." (Or presses 2: the scammer is disconnected and mother and son keep talking.)
7. The scammer's phone never hears the whisper.

Line: **"Scams run on isolation. We break the isolation: her son is in the call in ten seconds."**

## Fallbacks

- No phone line / bad network: dashboard → **Live sim** → `scam-03-bank-fraud-department` → ▶. Same script through the real model; telephony actions show as mock in the action log.
- Tunnel down (dashboard offline): `npm run tunnel`, put the new URL into `.env` as `PUBLIC_URL`, restart `npm run dev`, `npm run doctor -- --fix-webhook`.
- Whisper not audible but the dashboard reached *whisper*: say "the whisper fired, phone network latency", go on with the family keypad.

## Judges' questions

- **Why not an app?** iOS gives no third party access to call audio, nor the right to end a carrier call. An app could only show a pop-up, which is what a text does, with an install step on top.
- **Pixel does this.** Pixel only, warning on a screen while the phone is on her ear, no family loop.
- **False positives?** Five intervention levels; a sales call is at most a summary after the call. 9 normal calls replayed: zero alarms.
- **Privacy?** A protection notice before any audio reaches the model, trusted numbers never processed, no audio stored, transcript in memory only.
- **Latency?** About 5 s per sentence (Opus through a proxy); say the real number.
- **Built on open source?** Wessuwan's MIT telephony pipeline; the detector, whisper, keypad, policy and wake word were written today. The README has the diff.
