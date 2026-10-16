/**
 * Streams local WAV files through the real STT pipeline (bus -> stt -> store) without a phone call.
 *
 *   npm run test:stt -- caller.wav [protected.wav] [--fast] [--provider=google|deepgram]
 *
 * Accepts 8kHz mu-law WAV (what Twilio sends) or PCM 16-bit WAV at any rate/channels,
 * which is converted to 8kHz mu-law in memory. Audio is fed in 20ms frames in real time
 * (like Twilio); --fast sends it 10x faster. Nothing is written to disk. --provider overrides
 * STT_PROVIDER (google needs GOOGLE_APPLICATION_CREDENTIALS, deepgram needs DEEPGRAM_API_KEY). Prints the transcript
 * and how long it took, including the time from the end of the audio to the last final result.
 */
import fs from 'fs';
import { config } from '../src/config';
import { bus, Speaker } from '../src/events';
import '../src/store';
import { setupStt } from '../src/stt';

const FRAME = 160; // 20ms of 8kHz mu-law, same as Twilio media frames

function readWav(file: string): Buffer {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file}: not a WAV file`);
  }
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') {
      let format = body.readUInt16LE(0);
      if (format === 0xfffe) format = body.readUInt16LE(24); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === 'data') {
      data = body;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${file}: missing fmt or data chunk`);

  if (fmt.format === 7 && fmt.rate === 8000 && fmt.channels === 1) return data; // already mu-law 8k
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`${file}: need 16-bit PCM or 8kHz mono mu-law (got format ${fmt.format}, ${fmt.bits}-bit)`);
  }

  // Downmix to mono, resample to 8kHz (linear), encode mu-law.
  const frames = data.length / (2 * fmt.channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2);
    mono[i] = sum / fmt.channels;
  }
  const ratio = fmt.rate / 8000;
  const out = Buffer.alloc(Math.floor(frames / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const s = mono[j] + ((mono[j + 1] ?? mono[j]) - mono[j]) * (pos - j);
    out[i] = linearToMulaw(s);
  }
  return out;
}

function linearToMulaw(sample: number): number {
  const BIAS = 0x84, CLIP = 32635;
  let s = Math.max(-CLIP, Math.min(CLIP, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

async function main() {
  const args = process.argv.slice(2);
  const fast = args.includes('--fast');
  const files = args.filter((a) => !a.startsWith('--'));
  const provider = args.find((a) => a.startsWith('--provider='))?.split('=')[1];
  if (provider) config.stt.provider = provider.toLowerCase();
  // A test run is not a real call, so it does not need recorded consent.
  if (!files.length) {
    console.error('usage: npm run test:stt -- caller.wav [protected.wav] [--fast] [--provider=google|deepgram]');
    process.exit(1);
  }
  const tracks: [Speaker, Buffer][] = [['caller', readWav(files[0])]];
  if (files[1]) tracks.push(['protected', readWav(files[1])]);

  console.log(`provider=${config.stt.provider}${config.stt.provider === 'deepgram' ? ` model=${config.stt.deepgramModel}` : ''}`);
  if (!(await setupStt())) process.exit(1);
  const audioMs = Math.max(...tracks.map(([, b]) => b.length / 8));
  const callSid = `TEST-${Date.now()}`;
  const finals: { speaker: Speaker; text: string; at: number }[] = [];
  bus.on('transcript-update', ({ callSid: sid, speaker, text, isFinal, language }) => {
    if (sid !== callSid) return;
    if (isFinal) {
      finals.push({ speaker, text, at: Date.now() });
      console.log(`\n✔ [${speaker}] ${text}`);
    } else process.stdout.write(`… [${speaker}] ${text}`.slice(0, 120));
  });
  bus.emit('call:started', { callSid, from: 'test-wav' });

  const frameMs = fast ? 2 : 20;
  const t0 = Date.now();
  const longest = Math.max(...tracks.map(([, b]) => b.length));
  for (let off = 0; off < longest; off += FRAME) {
    for (const [speaker, audio] of tracks) {
      if (off < audio.length) bus.emit('call:audio', { callSid, speaker, payload: audio.subarray(off, off + FRAME) });
    }
    await new Promise((r) => setTimeout(r, frameMs));
  }
  const audioDoneAt = Date.now();

  // Ending the call closes the STT streams, which flushes the last final result.
  bus.emit('call:ended', { callSid });
  await new Promise((r) => setTimeout(r, 5000));

  console.log('\n--- transcript ---');
  for (const f of finals) console.log(`${f.speaker}: ${f.text}`);
  if (!finals.length) console.log('(nothing recognized)');
  const lastAt = finals.at(-1)?.at;
  console.log('\n--- timing ---');
  console.log(`audio length          ${(audioMs / 1000).toFixed(1)}s (fed ${fast ? '10x fast' : 'in real time'} in ${((audioDoneAt - t0) / 1000).toFixed(1)}s)`);
  if (lastAt) {
    console.log(`total, start to final ${((lastAt - t0) / 1000).toFixed(1)}s`);
    console.log(`last final after audio ${((lastAt - audioDoneAt) / 1000).toFixed(2)}s`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
