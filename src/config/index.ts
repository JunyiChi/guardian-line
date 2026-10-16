import 'dotenv/config';

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}
const list = (value: string | undefined) => (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const bool = (value: string | undefined) => value === 'true';

const autoHangup = process.env.AUTO_HANGUP_THRESHOLD || 'off';
const production = process.env.NODE_ENV === 'production';

/**
 * Values from .env. User-editable settings (protected person, contacts, threshold...) start from
 * these and can be changed on the setup page; see src/settings.ts.
 */
export const config = {
  production,
  port: num(process.env.PORT, 3000),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  /** ISO code of a profile in config/countries/ (US, UK, CA, AU, JP, SG, DE). */
  country: (process.env.COUNTRY || 'US').toUpperCase(),
  logLevel: (process.env.LOG_LEVEL || (production ? 'info' : 'debug')).toLowerCase() as 'debug' | 'info' | 'warn' | 'error',
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
    /** Sender for WhatsApp alerts, e.g. whatsapp:+14155238886 (Twilio sandbox). */
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM || '',
    /** Validate X-Twilio-Signature on webhooks (default on in production). */
    validateSignature: process.env.TWILIO_VALIDATE_SIGNATURE ? bool(process.env.TWILIO_VALIDATE_SIGNATURE) : production,
  },
  stt: {
    /** google | deepgram */
    provider: (process.env.STT_PROVIDER || 'google').toLowerCase(),
    /** Used when the provider can't detect the language; empty = the country's default language. */
    language: process.env.STT_LANGUAGE || '',
    deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
    deepgramModel: process.env.DEEPGRAM_MODEL || 'nova-3',
  },
  google: {
    credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  },
  /** jev (TypeSafe's decision model via Defapi, default) | llm (chat-model detector below) */
  detector: (process.env.DETECTOR || 'jev').toLowerCase() as 'jev' | 'llm',
  jev: {
    apiKey: process.env.JEV_API_KEY || '',
    /** Decisions API endpoint: Defapi by default; can point to another Jev provider such as OpenRouter. */
    url: process.env.JEV_URL || 'https://api.defapi.org/api/v1/decisions',
    /** Pinned so the thresholds below stay tuned to one model version. Never ~typesafe/jev-latest. */
    model: process.env.JEV_MODEL || 'typesafe/jev-1.13',
    checkIntervalMs: num(process.env.CHECK_INTERVAL_MS, 2500),
    timeoutMs: num(process.env.JEV_TIMEOUT_MS, 3000),
    /** Warn when scam_likelihood >= this (0-4 scale) with confidence >= JEV_WARN_CONFIDENCE. */
    warnScore: num(process.env.JEV_WARN_SCORE, 3.5),
    warnConfidence: num(process.env.JEV_WARN_CONFIDENCE, 0.7),
    /** Warn when scam_likelihood >= this on two checks in a row. */
    highScore: num(process.env.JEV_HIGH_SCORE, 2.5),
    /** A signal counts as detected at this probability. */
    signalThreshold: num(process.env.JEV_SIGNAL_THRESHOLD, 0.7),
    /** Stay under Jev's ~32 KB long-context cutoff (slower, less accurate). */
    maxTranscriptBytes: num(process.env.MAX_TRANSCRIPT_BYTES, 24000),
    /** none | llm: after 3 Jev failures in a row, switch that call to the chat-model detector. */
    fallback: (process.env.JEV_FALLBACK || 'none').toLowerCase() as 'none' | 'llm',
  },
  llm: {
    /** gemini | anthropic */
    provider: (process.env.LLM_PROVIDER || 'gemini').toLowerCase(),
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || '',
      fastModel: process.env.GEMINI_FAST_MODEL || process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
      preciseModel: process.env.GEMINI_PRECISE_MODEL || 'gemini-flash-latest',
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      fastModel: process.env.FAST_MODEL || 'claude-haiku-5-5',
      preciseModel: process.env.PRECISE_MODEL || 'claude-sonnet-5-5',
    },
    /** Fast-model risk at which the precise model confirms the score. */
    confirmAt: num(process.env.CONFIRM_THRESHOLD, 40),
  },
  alerts: {
    /** sms | whatsapp */
    channel: (process.env.ALERT_CHANNEL || 'sms').toLowerCase() as 'sms' | 'whatsapp',
    familyNumbers: list(process.env.FAMILY_PHONE_NUMBERS),
    ttsVoice: process.env.TTS_VOICE || '',
  },
  protectedPerson: {
    name: process.env.PROTECTED_PERSON_NAME || 'Mom',
    number: process.env.PROTECTED_PHONE_NUMBER || '',
  },
  /** Comma-separated numbers that are connected straight through and never processed. */
  trustedNumbers: list(process.env.TRUSTED_NUMBERS),
  riskThreshold: num(process.env.RISK_THRESHOLD, 70),
  /** null = auto hang-up disabled */
  autoHangupThreshold: autoHangup.toLowerCase() === 'off' ? null : num(autoHangup, 90),
  privacy: {
    /** 32-byte key, base64 or hex. Required to keep flagged-call summaries and settings on disk. */
    encryptionKey: process.env.ENCRYPTION_KEY || '',
    retentionDays: num(process.env.SUMMARY_RETENTION_DAYS, 30),
  },
  /** Public judge demo: no real SMS/calls, no STT, rate-limited /api/check, read-only settings. */
  publicDemo: {
    enabled: bool(process.env.PUBLIC_DEMO),
    ratePerHour: num(process.env.RATE_LIMIT_PER_HOUR, 20),
    links: {
      github: process.env.GITHUB_URL || '',
      pitchDeck: process.env.PITCH_DECK_URL || '',
    },
  },
};
