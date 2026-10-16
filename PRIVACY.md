# Wessuwan privacy notice

**Our promise: we can't leak what we don't keep.**

This notice explains, in plain language, what Wessuwan checks, what it keeps, for how long, who processes the data, how consent works, and how to delete everything. It is written to meet GDPR-style transparency requirements (GDPR Articles 13-14 and similar laws such as UK GDPR, PIPEDA, Australia's Privacy Act, Japan's APPI and Singapore's PDPA). The live version is at `/privacy` on every Wessuwan server.

> Wessuwan is open-source software. Whoever runs a Wessuwan server (a family member, a care organisation, a company) is the **data controller** for that server and must fill in their contact details below.

**Controller:** `[name, address, email of whoever runs this Wessuwan server]`
**Contact for privacy questions:** `[email]`

## 1. What Wessuwan does

Wessuwan protects one person (the "protected person") from phone scams. It answers calls first, listens to calls from numbers that are **not** on the trusted list, and warns the protected person and their family if the caller uses scam tactics.

## 2. What is checked

| Data | When | Why |
|---|---|---|
| The caller's phone number | Every incoming call | To decide if the caller is a trusted contact (trusted calls are never processed) |
| Call audio (both sides) | Only calls from non-trusted numbers, only **after** the announcement has finished | Turned into text in real time |
| The text of the conversation (transcript) | During the call | Checked by an AI for the 4 warning signals: urgency, threats, requests for codes or data, requests for money |

Before anything is processed, every caller hears: *"This call is protected by Wessuwan, an AI scam protection service."* This announcement is mandatory and cannot be turned off. Countries where all parties must consent (e.g. Germany, Australia) are flagged in the country profiles.

## 3. What is kept, and for how long

| Data | Kept? | How long |
|---|---|---|
| Call audio | **Never stored.** Passed in memory to the speech-to-text service and discarded. Never written to disk or logs. | 0 |
| Transcript of a **normal call** | **Deleted the moment the call ends.** | Only while the call lasts |
| Transcript of a **scam call** | Deleted the moment the call ends. | Only while the call lasts |
| Scam summary (date, caller number, scam type, risk score, one-sentence reason, which alerts were sent) | Kept, **encrypted with AES-256-GCM**, so the family can review and report it | `SUMMARY_RETENTION_DAYS`, default **30 days**, then deleted automatically |
| Settings (protected person's name and number, trusted contacts, family numbers, consent record) | Kept, encrypted, until you change or delete them | Until deleted |
| Server logs | Phone numbers are always masked (e.g. `+1***-***-1234`). In production (`LOG_LEVEL=info`), transcripts and AI reasons are never logged. | As long as your hosting keeps logs |

If the server has no encryption key (`ENCRYPTION_KEY`), **no summaries are kept at all** and settings stay in memory only.

## 4. Who processes the data (processors)

| Provider | What it receives | Purpose |
|---|---|---|
| **Twilio** | The call itself, phone numbers, SMS/WhatsApp alert text | Phone calls, call audio streaming, family alerts |
| **Google Cloud Speech-to-Text** or **Deepgram** (one, chosen by the operator) | Call audio, live | Speech-to-text |
| **Defapi** and **TypeSafe** (Jev decision model) | The transcript of the current call (most recent ~24 KB) and the country, at the end of each caller sentence | Scam detection |
| **Google Gemini API** or **Anthropic Claude API** (only if the operator enables the chat-model fallback) | The transcript of the last 2 minutes plus a one-line summary of earlier parts | Scam detection fallback |
| **Google Cloud Text-to-Speech** (optional) | Only the fixed warning sentence, never call content | Generating the warning audio once |

**Important:** free AI tiers may use submitted data to improve their models. Wessuwan servers that protect real people **must** use paid tiers configured for no training and zero or minimal data retention, under a data processing agreement with each provider. Free tiers may only be used with test data such as the sample scripts.

Providers may process data outside your country. The operator is responsible for an appropriate transfer mechanism (for example the EU Standard Contractual Clauses).

## 5. Legal basis and consent

- **Consent** of the protected person (or their legal representative), recorded on the setup page with date and name before protection can be switched on (GDPR Art. 6(1)(a)).
- **Legitimate interest** in protecting the protected person from fraud, for processing the caller's voice and number (GDPR Art. 6(1)(f)), with the mandatory announcement as transparency, minimal processing, and immediate deletion of normal calls.
- Consent can be withdrawn at any time by switching protection off or deleting all data. Withdrawal does not affect earlier processing.

## 6. Your rights

You can ask for access, correction, deletion, restriction, objection and portability, and you can complain to your data protection authority. Callers who were checked by Wessuwan can contact the controller above.

**To delete everything yourself:** open `/setup` → **Delete all my data**, type `DELETE`, and confirm. This removes all scam summaries, trusted contacts, family numbers and the consent record, and switches protection off. To pause protection without deleting anything, use **Turn protection off** on the same page. Calls then ring straight through and nothing is processed.

## 7. Security

AES-256-GCM encryption at rest, HTTPS/WSS only in production, Twilio webhook signature validation, security headers, masked logs, and a password-protected setup page. See [SECURITY.md](SECURITY.md) for how to report a vulnerability and how breaches are handled.

## 8. Changes

We will update this notice when the data we process changes, and show the date below.

*Last updated: 2026-10-16*
