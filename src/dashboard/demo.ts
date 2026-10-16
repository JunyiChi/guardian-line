import fs from 'fs';
import path from 'path';
import type { Express } from 'express';
import { bus, Signals, Speaker } from '../events';
import { log } from '../privacy/log';
import { levelLabel } from '../detector/jev';

const SCRIPT = path.join(__dirname, '..', '..', 'data', 'test-scripts', 'scam-03-bank-fraud-department.txt');
/** Scripted smoothed risk and signals after each line, so the demo is the same every time without an LLM. */
const RISK = [10, 12, 38, 40, 55, 60, 84, 86, 93, 96];
const NO: Signals = { urgency: false, threat: false, data_request: false, transfer_request: false };
const T: Signals = { ...NO, threat: true };
const TU: Signals = { ...T, urgency: true };
const TUD: Signals = { ...TU, data_request: true };
const ALL: Signals = { ...TUD, transfer_request: true };
const SIGNALS: Signals[] = [NO, NO, T, T, TU, TU, TUD, TUD, ALL, ALL];
const REASONS: [number, string][] = [
  [70, 'The caller says he is from your bank, got your verification code, and wants you to move your money to a "safe account". Banks never do this.'],
  [40, 'The caller claims to be from your bank fraud team and says someone is stealing your money. Watching closely.'],
  [0, 'Nothing unusual yet.'],
];
const DEMO_FROM = '+1 555 019 4471';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let running = false;

/** Replays a saved scam call through the real bus: dashboard + alerts (mocked Twilio for DEMO- calls). */
async function runDemo(): Promise<void> {
  const lines = fs.readFileSync(SCRIPT, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const i = l.indexOf(':');
      return { speaker: l.slice(0, i).trim() as Speaker, text: l.slice(i + 1).trim() };
    });
  const callSid = `DEMO-${Date.now()}`;

  bus.emit('call:ringing', { callSid, from: DEMO_FROM });
  await sleep(2500);
  bus.emit('call:started', { callSid, from: DEMO_FROM });
  await sleep(1200);

  let flagged = false;
  let flaggedBefore = false;
  let announced = false;
  for (const [i, { speaker, text }] of lines.entries()) {
    // Interim results word by word, like live speech-to-text, then the final line.
    const words = text.split(' ');
    for (let w = 1; w < words.length; w++) {
      bus.emit('transcript-update', { callSid, speaker, text: words.slice(0, w).join(' '), isFinal: false });
      await sleep(450);
    }
    bus.emit('transcript-update', { callSid, speaker, text, isFinal: true, endOfSpeech: true });
    // Like a live call: only the end of a caller sentence triggers a check; the reply comes after a short pause.
    if (speaker !== 'caller') {
      await sleep(1500);
      continue;
    }
    const checkMs = 380 + ((i * 37) % 90);
    await sleep(checkMs);

    const score = RISK[Math.min(i, RISK.length - 1)];
    const signals = SIGNALS[Math.min(i, SIGNALS.length - 1)];
    const scamType = score >= 40 ? 'bank_fraud_department' : 'none';
    const impersonating = i === 0 ? 'none' : 'bank';
    const reason = REASONS.find(([min]) => score >= min)![1];
    // Looks exactly like a Jev check on the dashboard: signal probabilities, level, confidence, timing.
    const p = (on: boolean, hi = 0.95) => (on ? hi : 0.04);
    const probabilities = {
      urgency: p(signals.urgency, 0.91), threat: p(signals.threat, 0.88), asks_for_codes_or_data: p(signals.data_request, 0.97),
      asks_for_money: p(signals.transfer_request, 0.96), impersonating_authority: p(i > 0, 0.94), asks_for_secrecy: p(i >= 9, 0.9),
    };
    const jevScore = (score / 100) * 4;
    if (score >= 70) flagged = true;
    bus.emit('risk-update', {
      callSid, score, rawScore: score, scamType, reason, signals, impersonating, tier: 'jev', detector: 'jev',
      status: flagged ? 'scam' : score >= 40 ? 'watching' : 'safe', confidence: Math.min(0.97, 0.55 + score / 250),
      probabilities, level: levelLabel(jevScore), ms: checkMs, cost: 0.00002,
    });
    if (score >= 70 && !announced) {
      announced = true;
      bus.emit('scam-detected', { callSid, score, scamType, reason, signals, impersonating, detector: 'jev' });
    }
    log.info('demo', `line ${i + 1}: caller sentence ended, checked in ${checkMs}ms, risk ${score}${score >= 70 && !flaggedBefore ? '  WARN' : ''}`);
    flaggedBefore = flagged;
    await sleep(lines[i + 1]?.speaker === 'protected' ? 900 : 1500);
  }

  await sleep(6000);
  bus.emit('call:ended', { callSid });
}

export function setupDemo(app: Express): void {
  app.post('/demo/start', (_req, res) => {
    if (running) {
      res.status(409).json({ ok: false, error: 'demo already running' });
      return;
    }
    running = true;
    runDemo()
      .catch((err) => log.error('demo', err?.message ?? String(err)))
      .finally(() => (running = false));
    res.json({ ok: true });
  });
}
