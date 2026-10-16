# Security policy

Wessuwan handles phone calls of vulnerable people, so we take security reports seriously.

## Reporting a vulnerability

- **Please do not open a public GitHub issue for security problems.**
- Use GitHub's **private vulnerability reporting** (Security tab → "Report a vulnerability") or email `[security contact email]`.
- Include what you found, steps to reproduce, the affected version or commit, and the impact you expect.
- We aim to acknowledge reports within **3 business days** and to share a fix plan within **10 business days**.
- Please give us reasonable time to fix the issue before disclosing it. We are happy to credit you.
- Good-faith research that avoids privacy violations, data destruction and service disruption is welcome. Never use real people's calls or data in your testing; use the sample scripts and `PUBLIC_DEMO=true`.

## Supported versions

Only the latest commit on `main` receives security fixes.

## What Wessuwan does to stay secure

- No audio is ever written to disk or logs; transcripts live in memory only for the length of a call.
- Scam summaries and settings are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`) and auto-deleted after `SUMMARY_RETENTION_DAYS`.
- Phone numbers are masked in logs; transcripts are only logged at `LOG_LEVEL=debug`, which must never be used in production.
- HTTPS/WSS is enforced in production (`NODE_ENV=production`), with HSTS and helmet security headers.
- Twilio webhooks and media streams are rejected unless their `X-Twilio-Signature` is valid.
- The setup page needs `SETUP_PASSWORD` in production; the public demo is read-only and sends nothing.
- API keys stay on the server; the public Try it page is rate-limited per IP.

## Breach response plan

If personal data may have been exposed (for example a leaked `ENCRYPTION_KEY`, a compromised server, or a provider breach):

1. **Detect and record.** Write down what happened, when it was found, which systems and data are affected, and who is handling it. Keep a timeline from the first minute.
2. **Contain.** Take the affected server offline or switch protection off. Rotate every credential: `ENCRYPTION_KEY` (then delete the old summaries, they can't be re-encrypted without the old key), Twilio auth token, AI and speech-to-text API keys, `SETUP_PASSWORD`. Revoke attacker access and preserve logs for investigation.
3. **Assess.** Work out what data was involved (encrypted summaries? settings? logs?), how many people, and the likely harm. Encrypted data whose key was not exposed is usually low risk.
4. **Notify regulators within legal deadlines.** Under the GDPR and UK GDPR, notify the supervisory authority **within 72 hours** of becoming aware of a breach that risks people's rights and freedoms (Art. 33). Other laws have their own rules, e.g. Australia's Notifiable Data Breaches scheme ("as soon as practicable" after assessment, within 30 days), Singapore's PDPA (3 calendar days after assessment), Canada's PIPEDA ("as soon as feasible"), Japan's APPI (promptly, with a preliminary report). If you can't give full details in time, notify with what you know and follow up.
5. **Notify users.** Tell affected protected persons and families without undue delay when the risk is high (GDPR Art. 34), in plain language: what happened, what data, what we did, and what they should do (for example: be extra careful with calls claiming to be Wessuwan or their bank).
6. **Recover and learn.** Fix the root cause, restore service from a clean state, document the incident and the lessons learned, and update this plan.
