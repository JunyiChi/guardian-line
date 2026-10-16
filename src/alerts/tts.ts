import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { config } from '../config';
import { log } from '../privacy/log';

/** Voice warning text per language (ISO 639-1). English is the default and fallback. */
export const WARNING_TEXT: Record<string, string> = {
  en: 'Warning from Wessuwan: this call may be a scam. Do not send money or share any codes. Hang up and call your family.',
  es: 'Aviso de Wessuwan: esta llamada puede ser una estafa. No envíe dinero ni comparta ningún código. Cuelgue y llame a su familia.',
  fr: "Avertissement de Wessuwan : cet appel est peut-être une arnaque. N'envoyez pas d'argent et ne donnez aucun code. Raccrochez et appelez votre famille.",
  de: 'Warnung von Wessuwan: Dieser Anruf könnte Betrug sein. Senden Sie kein Geld und geben Sie keine Codes weiter. Legen Sie auf und rufen Sie Ihre Familie an.',
  ja: 'ウェッスワンからの警告です。この電話は詐欺の可能性があります。お金を送ったり、暗証番号やコードを教えたりしないでください。電話を切って、ご家族に連絡してください。',
  zh: 'Wessuwan 提醒您：这通电话可能是诈骗。不要转账，也不要透露任何验证码。请挂断电话并联系您的家人。',
  ms: 'Amaran daripada Wessuwan: panggilan ini mungkin penipuan. Jangan hantar wang atau kongsi sebarang kod. Letakkan telefon dan hubungi keluarga anda.',
};

const AUDIO_DIR = path.join(__dirname, '..', '..', 'public', 'audio');
/** English lives at warning.mp3; other languages at warning-<lang>.mp3. */
export const warningFile = (lang = 'en') => path.join(AUDIO_DIR, lang === 'en' ? 'warning.mp3' : `warning-${lang}.mp3`);
export const warningPath = (lang = 'en') => `/audio/${path.basename(warningFile(lang))}`;
export const baseLang = (code?: string) => (code ?? 'en').split('-')[0].toLowerCase();

/** The warning language for a call: its detected language if we have a text for it, else English. */
export function warningLang(callLanguage?: string): string {
  const l = baseLang(callLanguage);
  return WARNING_TEXT[l] ? l : 'en';
}

/** Best available audio for a language: its own file, else the English one, else null. */
export function warningAudioFor(callLanguage?: string): string | null {
  const l = warningLang(callLanguage);
  if (existsSync(warningFile(l))) return warningPath(l);
  return existsSync(warningFile('en')) ? warningPath('en') : null;
}

const TTS_VOICES: Record<string, string> = {
  en: 'en-US', es: 'es-US', fr: 'fr-FR', de: 'de-DE', ja: 'ja-JP', zh: 'cmn-CN', ms: 'ms-MY',
};

/**
 * Makes sure the warning audio exists for each language. An existing file (e.g. one you recorded)
 * is always used as is. Missing files are generated with Google TTS only when credentials are set.
 */
export async function ensureWarningAudio(langs: string[]): Promise<void> {
  const missing = [...new Set(['en', ...langs.map(warningLang)])].filter((l) => !existsSync(warningFile(l)));
  if (!missing.length) return log.info('alerts', 'warning audio found');
  if (process.env.MOCK === 'true' || config.publicDemo.enabled || !config.google.credentials) {
    log.warn('alerts', `no warning audio for ${missing.join(', ')}: record ${missing.map((l) => path.relative(process.cwd(), warningFile(l))).join(', ')} ` +
      'yourself, or set GOOGLE_APPLICATION_CREDENTIALS to generate it with Google TTS. Without it the family SMS still works.');
    return;
  }
  const client = new TextToSpeechClient();
  await client.auth.getClient(); // missing credentials otherwise surface as an unhandled rejection
  await fs.mkdir(AUDIO_DIR, { recursive: true });
  for (const l of missing) {
    // Slow, slightly lower-pitched voice for older listeners.
    const [res] = await client.synthesizeSpeech({
      input: { text: WARNING_TEXT[l] },
      voice: { languageCode: TTS_VOICES[l] ?? 'en-US', ...(l === 'en' && config.alerts.ttsVoice ? { name: config.alerts.ttsVoice } : {}) },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 0.8, pitch: -2, volumeGainDb: 3 },
    });
    if (!res.audioContent) throw new Error(`empty TTS response for ${l}`);
    await fs.writeFile(warningFile(l), res.audioContent as Uint8Array);
    log.info('alerts', `generated ${path.basename(warningFile(l))} with Google TTS`);
  }
}
