# c0mpiled-16 submission · Guardian Line

Copy-paste material for the submission form. Repo freeze: 18:45.

## Project name
Guardian Line

## One-liner
A family member who lives in the phone line: older adults keep answering their own calls; when a call turns into a scam, Guardian whispers to them privately, answers when they ask it, and brings their family into the call with one key press. No app, no screen, any phone.

## Form field 5 · "2 Sentence Description of the Project"
Guardian Line is a family member who lives in the phone line: older adults keep answering their own calls, and when a call turns into a scam, Guardian whispers to them privately, answers when they ask "Guardian, is this real?", and rings their family, who press 1 to join the call. No app and no screen on any phone: calls are forwarded through a Guardian number, both sides are transcribed live, and Claude scores the conversation as a scam trajectory against family context, so sales calls stay green while "move your savings to a safe account" triggers the whisper within seconds.

## Form field 4 · Track
No App  (single choice; the 1-billion-people track is the secondary story, mention it in the video)

## Form field 8 · Hosted Project Link (optional)
https://builders-composer-hiv-uniform.trycloudflare.com/dashboard  — judges can press "Live sim" and watch a scripted scam run through the real model. Only works while the laptop and tunnel are up.

## Long description (README / backup)
Phone scams are the #1 fraud channel for people over 75, and every existing defense either puts a warning on a screen (Pixel), answers the phone for them (gatekeeper apps), or silently cuts them off (carrier models). Grandma's phone is on her ear, and her son is 2,000 miles away.

Guardian Line sits on the phone line itself. The family forwards the protected person's calls through a Guardian number; she answers every call exactly as before. Both sides of the call are transcribed live, and Claude scores the conversation as a trajectory (rapport → pressure → isolation → extraction), looking at what the caller is asking her to DO rather than who they claim to be, checked against family context (the real grandson's age, the pharmacy she uses, the parcel she is expecting).

Three interactions, none of them on a screen:
- Guardian → her: a private whisper only she hears ("Mom, this call is a scam. Hang up. David is calling you now."). The caller hears a few seconds of silence.
- Her → Guardian: she says "Guardian, is this person for real?" mid-call and gets a private answer.
- Her family → Guardian: their phone rings with the summary; press 1 to join the call, press 2 to disconnect the caller.

Five intervention levels set by the family, from "do nothing" (sales calls stay green) to whisper. On 23 replayed calls: 9 normal calls, 0 false alarms; 14 scams, 13 caught by the 3rd-5th caller sentence. Live demo runs on real phones over SignalWire.

Built on Wessuwan's MIT telephony pipeline (declared in the README); the trajectory detector, private whisper, wake word, family keypad, graded policy and live-model simulation were built today.

## Tracks
No App (primary) · AI-powered consumer products for 1 billion people

## Links
- GitHub: https://github.com/JunyiChi/guardian-line
- Video: _fill after upload_
- Live dashboard (while the laptop is up): https://builders-composer-hiv-uniform.trycloudflare.com/dashboard

## Video script (≤ 2:00)
**0:00–0:25 Problem.** Three phones on the table: Mom, a scammer, her son. "Phone scams are the number one fraud channel for people over 75. Every defense today puts a warning on a screen. Her phone is on her ear. Her son is two thousand miles away."
**0:25–1:15 Product.** Act 1 (sales call, all green, "Guardian, is this person for real?" → private answer). Act 2 (bank "safe account": trajectory lights up, whisper in her ear, son's phone rings, press 1, "Mom, hang up, it's me"). Point at the dashboard once: stage strip, "what the caller wants her to do".
**1:15–1:45 Impact.** "No app, no screen, any phone — a landline works. Zero false alarms on nine normal calls, thirteen of fourteen scams caught before the money moves. Sales calls stay green: we protect her from fraud, not from salesmen." Close card: Guardian Line · a family member who lives in the phone line.
