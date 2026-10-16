# 🛡️ Wessuwan live demo runbook

Roles: **Presenter** (talks, drives the dashboard), **Scammer** (teammate who calls the Twilio number and reads the script), **Protected person** (teammate holding the phone set as `PROTECTED_PHONE_NUMBER`, ideally on speaker), **Family** (phone listed in `FAMILY_PHONE_NUMBERS`, held up to the audience to show the SMS).

## 1. Pre-demo checklist (30 minutes before)

- [ ] **Laptop:** on power, sleep and screen saver off, notifications muted, `http://localhost:3000/dashboard` on the big screen at full screen (F11).
- [ ] **ngrok running:** `ngrok http 3000`, and copy the `https://…ngrok-free.app` URL.
- [ ] **`.env` filled in:**
  - [ ] `PUBLIC_URL` = the ngrok URL from this session (no trailing slash)
  - [ ] `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
  - [ ] `STT_PROVIDER` + `GOOGLE_APPLICATION_CREDENTIALS` or `DEEPGRAM_API_KEY`
  - [ ] `JEV_API_KEY` (Jev detector; optional `JEV_FALLBACK=llm` + a Gemini or Claude key)
  - [ ] `ENCRYPTION_KEY`, `COUNTRY=US`, `MOCK=false`, `AUTO_HANGUP_THRESHOLD=off` (so the call isn't cut mid-demo)
- [ ] **Setup page** (`/setup`): protected person's name and number, consent recorded, Family phone in family numbers, Scammer's phone **not** in trusted contacts. Press **Send test alert**: the Family phone gets the SMS.
- [ ] **Server:** run `npm run dev` and read the startup lines. There should be **no** `PUBLIC_URL not set`, `protection inactive`, `speech-to-text disabled` or `no warning audio` messages.
- [ ] **Warning audio:** `public/audio/warning.mp3` exists. Open `PUBLIC_URL/audio/warning.mp3` and listen to it.
- [ ] **Twilio webhook updated:** Console → Phone Numbers → your number → *A call comes in* → `PUBLIC_URL/twilio/voice` (HTTP POST). Update it every time ngrok restarts.
- [ ] **Twilio trial accounts:** the Scammer's, Protected person's and Family numbers are all verified caller IDs.
- [ ] **Detector:** `npm run test:detector` shows PASS for all files and no false alarms.
- [ ] **Full rehearsal:** one call with the normal script, then one with the scam script.
- [ ] **Backup ready:** Demo mode tested once (section 4), and the public demo site (https://wessuwan-demo.onrender.com) open in a browser tab. Load it a few minutes early: the free server can take up to a minute to wake up.

> ⚠️ **Known limitation:** with the current `<Dial>` setup, the voice warning is played by moving the protected person's leg away from the caller, so **the warning ends the scammer's connection**. Present this as "Wessuwan warns her and cuts the scammer off."

## 2. Live scam call: fake bank fraud department (about 1 minute)

The Scammer calls the Twilio number from a phone that is **not** a trusted contact. Everyone hears the announcement first. Speak clearly and pause after each line so the Protected person can answer.

> **Caller:** Hello, this is James from the fraud department at your bank. Am I speaking with Margaret?
>
> **Protected person:** Yes, this is Margaret.
>
> **Caller:** Margaret, we've detected two suspicious transactions on your account in the last hour, nine hundred and eighty dollars in Miami. Did you make these?
>
> **Protected person:** No, I'm at home. I didn't buy anything.
>
> **Caller:** I thought so. Someone has access to your account right now and they're trying to withdraw your savings. We have to act immediately.
>
> **Protected person:** Oh no. What should I do?
>
> **Caller:** I'm sending you a verification code to confirm you're the account holder. Please read it back to me.
>
> **Protected person:** It says four, eight, two, nine, one, six.
>
> **Caller:** Thank you. Now, to protect your money, we need to move your balance to a secure safe account that the criminals can't touch. Stay on the line, and please don't tell the branch staff, some employees may be involved.

**What should happen:** the risk meter climbs: yellow at "someone is withdrawing your savings", red at the verification code and the "safe account". The **Urgency**, **Threat**, **Asks for codes/data** and **Asks for money** badges light up. The red banner appears, the Protected person hears the warning, and the Family phone gets *"Wessuwan ALERT: Mom may be on a scam call right now. Caller claims to be a bank… Call Mom now."* The Presenter holds the phone up and taps to call. The call then moves to history.

## 3. Normal call: no false alarm (about 30 seconds)

Do this **before** the scam call, from the same non-trusted phone.

> **Caller:** Hello, this is Jenny from Dr. Patel's office, calling for Margaret.
>
> **Protected person:** This is Margaret.
>
> **Caller:** Just a reminder of your appointment on Thursday at ten thirty for your blood pressure check. Please bring your medication list.
>
> **Protected person:** Thank you, I'll be there.
>
> **Caller:** Wonderful. See you Thursday.

**What should happen:** the meter stays green. After hang-up, history shows "Normal call, data deleted", and the terminal prints `[Wessuwan] [privacy] normal call, data deleted`.

Optional: call from a trusted contact. It rings straight through, nothing appears on the dashboard, and the terminal prints `trusted caller +1***-***-1234: connecting directly, not processed`.

## 4. Backup plan: if the live call fails

Signs: no `[call] announcement done` line in the terminal, the call doesn't connect, or ngrok or the Wi-Fi dies.

1. Presenter says: *"The venue network isn't cooperating, so let's replay a real call we recorded."*
2. Hang up the live call.
3. Click **▶ Demo mode** on the dashboard. It replays the fake-bank call in about a minute: transcript, rising risk meter, signal badges, red banner, voice and SMS ticks, then the history entry.
4. If even the laptop fails, open the **public demo site** (https://wessuwan-demo.onrender.com/try) on any phone, go to **Try it**, and press **Play it like a call** on "Fake bank fraud team". It shows the real AI scoring line by line, plus SMS and voice-warning previews.
5. Without internet: set `MOCK=true` and run `curl -X POST http://localhost:3000/demo/start`.

**If the server itself crashes,** run `npm run dev` again. It starts in a few seconds, and the dashboard reconnects on its own (the green dot top right).
