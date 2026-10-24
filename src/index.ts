import { config } from './config';
import http from 'http';
import path from 'path';
import express from 'express';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import { Server as SocketIOServer } from 'socket.io';
import './store';
import { setupLogging } from './log';
import { mediaUpgradeAllowed, setupCall } from './call';
import { setupStt } from './stt';
import { setupDetector } from './detector';
import { setupAlerts } from './alerts';
import { setupDashboard } from './dashboard';
import { setupTryIt } from './tryit';
import { setupSetup } from './setup';
import { setupWebPhone } from './webphone';
import { settings } from './settings';
import { startRetention } from './privacy/summaries';
import { encryptionKey } from './privacy/crypto';
import { log, maskNumber } from './privacy/log';
import { currentModel, currentProvider } from './detector/providers';

const app = express();
// Render/Railway sit behind a proxy; needed for the real client IP (rate limiting) and protocol (HTTPS check).
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security headers. Pages use small inline scripts and Google Fonts.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'connect-src': ["'self'", 'ws:', 'wss:'],
      'media-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      // Locally the server runs on plain http; upgrading would break every request.
      'upgrade-insecure-requests': config.production ? [] : null,
    },
  },
  strictTransportSecurity: config.production ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

// Production: HTTPS only (health checks from the platform are exempt).
if (config.production) {
  app.use((req, res, next) => {
    if (req.secure || req.path === '/health') return next();
    res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
  });
}

app.use(express.urlencoded({ extended: false, limit: '50kb' })); // Twilio webhooks are form-encoded
app.use(express.json({ limit: '50kb' }));
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub, { extensions: ['html'] }));
app.use('/locales', express.static(path.join(__dirname, '..', 'locales')));
app.get('/health', (_req, res) => res.json({ ok: true, publicDemo: config.publicDemo.enabled }));

const server = http.createServer(app);

// Socket.IO (dashboard) attaches its own upgrade handler for /socket.io.
const io = new SocketIOServer(server);

// Raw WebSocket for Twilio media streams on /media (signature-checked like the webhooks).
const wss = new WebSocketServer({ noServer: true });
const webPhoneUpgrade = setupWebPhone();
server.on('upgrade', (req, socket, head) => {
  if (webPhoneUpgrade(req, socket, head)) return;
  if (!req.url?.startsWith('/media')) return;
  if (!mediaUpgradeAllowed(req)) {
    log.warn('security', 'rejected media stream: invalid Twilio signature');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

setupLogging();
setupCall(app, wss);
// The public demo has no phone calls, so it needs no speech-to-text.
if (!config.publicDemo.enabled) setupStt();
setupDetector();
setupAlerts(app);
setupDashboard(io, app);
setupTryIt(app);
setupSetup(app);
startRetention();

server.listen(config.port, () => {
  const st = settings.get();
  const c = settings.country();
  log.info('server', `listening on http://localhost:${config.port}`);
  log.info('server', `country ${c.code} (${c.name}), detector ${config.detector === 'jev' ? `Jev ${config.jev.model}${config.jev.fallback === 'llm' ? ` (fallback ${currentProvider()})` : ''}` : `chat model ${currentProvider()} ${currentModel('fast')} -> ${currentModel('precise')}`}, STT ${config.stt.provider}`);
  if (config.publicDemo.enabled) log.warn('server', `PUBLIC_DEMO=true: SMS/calls are previews only, STT off, ${config.publicDemo.ratePerHour} checks/hour per IP`);
  if (process.env.MOCK === 'true') log.warn('server', 'MOCK=true: Twilio actions are only logged');
  if (!config.publicDemo.enabled) {
    if (config.publicUrl) log.info('server', `Twilio voice webhook: ${config.publicUrl}/twilio/voice`);
    else log.warn('server', 'PUBLIC_URL not set: live calls will not work (Try it and Demo mode still do)');
    if (config.production && !config.publicUrl.startsWith('https://')) log.error('security', 'PUBLIC_URL must be https:// in production (Twilio media streams then use wss://)');
    if (!st.protectedNumber) log.warn('server', 'no protected phone number: open /setup');
    if (!settings.active()) log.warn('server', `protection inactive (${st.consent ? 'switched off' : 'no consent recorded'}): calls ring straight through. Complete /setup`);
    log.info('server', `protecting ${maskNumber(st.protectedNumber)}, ${st.trustedNumbers.length} trusted contacts, ${st.familyNumbers.length} family numbers, threshold ${st.riskThreshold}`);
    if (!encryptionKey()) log.warn('privacy', 'ENCRYPTION_KEY not set: settings stay in memory and no scam summaries are kept');
  }
  log.info('server', `log level ${config.logLevel}${config.logLevel === 'debug' ? ' (transcripts are printed: never use debug in production)' : ''}`);
});
