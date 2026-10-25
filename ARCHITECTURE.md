# Guardian Line · Architecture and design decisions

> c0mpiled-16 · UC San Diego · 2026-10-24 · Tracks: No App (primary), AI consumer products for 1 billion people.
> Built on Wessuwan (MIT, upstream commit `be8b4b0`). See the README for what is inherited and what is new.

## 1. One sentence

Guardian is a family member who lives in the phone line. Older adults keep answering every call themselves; when a call turns into a scam, Guardian whispers to them privately, answers when they ask it, and brings their family into the call with one key press. No app, no screen, no new phone.

## 2. Three design principles

1. **No gatekeeping.** The protected person may talk to anyone, including salespeople. Guardian is silent by default; silence is a feature.
2. **Identity is free, requests are evidence.** Anyone can claim to be the bank, the courier or the police. Guardian scores what the caller asks the person to *do* and where the conversation is going.
3. **Graded intervention, set by the family.** Five levels from "nothing" to "whisper"; the family caps the strongest action Guardian may take.

## 3. System

```
unknown caller ──(carrier unconditional call forwarding)──▶ Guardian number ──▶ POST /twilio/voice
   trusted numbers: <Dial callerId=original>protected</Dial>          bridged straight through, never processed
   everyone else:   <Say>one-sentence protection notice</Say>
                    <Start><Stream track="both_tracks" url=wss://…/media/></Start>
                    <Dial><Conference endConferenceOnExit=false>guard-{CallSid}</Conference></Dial>
                    + REST Calls.create(To=protected person, Url=/twilio/join?conf=…)
                                        │
   media stream: inbound track = caller, outbound track = conference mix = protected person
                                        │
   Deepgram ×2 (one streaming session per speaker, nova-3) ──▶ transcript-update(speaker, text, isFinal)
                                        │
   sentence end (speech_final, or a final result with no follow-up within 900 ms) ──▶ one check at a time per call
        ├─ regex fast path: verification-code / gift-card requests → red instantly, no model
        └─ Claude: system prompt (trajectory model, hard rules, calibration; prompt-cached)
                   + family.json + previous assessment + last 2 minutes of transcript
                   → JSON (schema-enforced): risk, stage, category, requestsOfSenior, evidence,
                     seniorSignals, action, summaryForChild, whisperText, reason
                                        │
   rules layer: scam + extraction ⇒ risk ≥ 85; benign categories ≤ 70; action = risk band capped by the
                family's maxIntervention; no smoothing at ≥ 85; the level only goes up within a call
                                        │
   policy (src/alerts):
     log                       dashboard only
     notify_child_after_call   summary to the family when the call ends
     notify_child_now          call the family: press 1 to join, press 2 to disconnect the caller
     whisper_senior            + private whisper to the protected person (+ optional caller removal)
   wake word on the protected person's track ("Guardian, …") ──▶ whisper the current assessment
                                        │
   dashboard (Socket.IO): transcript, risk, trajectory strip, "what the caller wants her to do", action log
   /demo/live?script=…: the same pipeline driven by a script, real model, telephony mocked
```

## 4. Key decisions

| Decision | Why | Cost / fallback |
|---|---|---|
| Conference instead of a direct bridge | The protected leg can step out, hear a whisper alone and rejoin; the caller can be removed while the family stays | The outbound leg's caller ID is the Guardian number (carrier-level deployment passes the original through) |
| Whisper = protected leg leaves, listens, rejoins | SignalWire accepts a per-participant `AnnounceUrl` but never fetches it; the redirect path is documented and works | The caller hears 3–5 s of silence; on Twilio the per-participant announce is used instead |
| Unconditional call forwarding | "Forward when unanswered" only catches calls nobody picked up; the ones we care about are answered | Family calls also pass through: whitelisted and bridged without transcription |
| Both sides are analysed | "I'll go to the bank now" or a card number read aloud is the strongest escalation signal; Wessuwan and similar projects only analysed the caller | Twice the checks; coalesced so only one runs at a time |
| Trajectory, not keyword counting | Sales calls are pushy but never reach extraction; scams always do | Needs a capable model: Claude Opus 5.5, ~5 s per sentence through a proxy |
| No smoothing at ≥ 85 | The whisper must land on the sentence that earned it | Below 85 an EWMA still damps single odd sentences |
| Voice only, no SMS | US A2P 10DLC registration takes days; a phone call with a keypad menu needs no registration | Re-enable with `SMS_ENABLED=true` once registered |
| No audio stored | California is an all-party-consent state; a protection notice plays before any audio reaches the model | Transcripts live in memory for the call; flagged calls leave a short summary |

## 5. What the family configures (`family.json`)

Protected person's name and language, the child's name, real family members with ages, bank, clinics, pharmacy, property, expected deliveries, whitelisted organisations, the maximum intervention level, and whether Guardian may remove a caller. The detector uses it to check a caller's story against reality; the policy uses it to cap what Guardian may do.

## 6. Deployment without an app

The family fills in `family.json` once and sets unconditional forwarding on the protected person's phone (one carrier code, e.g. `**21*<Guardian number>#`; iPhone Settings → Phone → Call Forwarding on GSM carriers; `*72` on Verizon). Outgoing calls are untouched. Dialing `##21#` leaves the service. Twilio's `ForwardedFrom` parameter lets one Guardian number serve many households; carrier integration removes the forwarding step entirely.

## 7. Repository map

| Path | Role | Origin |
|---|---|---|
| `src/call/index.ts` | webhook, conference bridging, join/status callbacks, whisper and family-menu TwiML | Wessuwan webhook; conference, whisper, menu new |
| `src/call/twilio.ts` | REST helpers: outbound calls, whisper, kick, bridge state, provider base URL | Wessuwan helpers; rest new |
| `src/stt/deepgram.ts` | per-speaker streaming transcription | Wessuwan |
| `src/detector/prompt.ts`, `index.ts` | trajectory prompt, schema, rules layer, triggers | rewritten |
| `src/config/family.ts`, `family.json` | household context and intervention cap | new |
| `src/alerts/index.ts` | five-level policy, wake-word answers, family call | rewritten |
| `src/dashboard/demo.ts` | live simulation through the real model | new |
| `public/dashboard.html` | dashboard; trajectory strip and action log added | Wessuwan + additions |
| `scripts/doctor.ts` | pre-flight check (keys, account, webhook, tunnel) | new |
| `scripts/test-detector.ts`, `data/test-scripts/` | replay harness with checkpoints; 23 scripts | Wessuwan harness + 7 scripts and checkpoints |
| `src/webphone/`, `public/phone.html` | browser phones for environments without telephony (not used in the demo) | new |
