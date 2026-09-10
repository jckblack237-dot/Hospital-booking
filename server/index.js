import express from 'express';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { recompute } from './engine/engine.js';
import { now } from './lib/clock.js';
import { HttpError } from './lib/util.js';
import { attach } from './realtime.js';
import { router as clinicRouter } from './routes/clinic.js';
import { router as authRouter } from './routes/auth.js';
import { router as patientRouter } from './routes/patient.js';
import { router as partnerRouter, oauth as oauthRouter } from './routes/partner.js';
import { router as demoRouter } from './routes/demo.js';
import { router as publicRouter } from './routes/public.js';
import * as notify from './services/notify.js';
import * as queueService from './services/queue.js';
import * as scheduling from './services/scheduling.js';
import * as simulator from './services/simulator.js';
import * as autopilot from './services/autopilot.js';
import * as webhooks from './services/webhooks.js';
import { sessionForToken } from './services/tenancy.js';
import { seed } from './seed.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

/**
 * gzip for API bodies over 1 KB. An island clinic on metered 4G polls a
 * 70 KB board; compressed it is under 10 KB. Node's zlib, no dependency.
 * The ETag is left as the route or Express set it, so 304s keep working.
 */
const GZIP_MIN_BYTES = 1024;
app.use('/api', (req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body) => {
    const accepts = /\bgzip\b/.test(req.get('accept-encoding') || '');
    if (accepts && typeof body === 'string' && Buffer.byteLength(body) > GZIP_MIN_BYTES && !res.get('content-encoding')) {
      res.set('Content-Encoding', 'gzip');
      res.set('Vary', 'Accept-Encoding');
      return send(zlib.gzipSync(body));
    }
    return send(body);
  };
  next();
});

app.use('/api/auth', authRouter);
app.use('/api/clinic', clinicRouter);
app.use('/api/patient', patientRouter);
app.use('/api/demo', demoRouter);
app.use('/api/public', publicRouter);
app.use('/oauth', oauthRouter);
app.use('/v1', partnerRouter);

app.get('/healthz', (req, res) => res.json({ ok: true, now: now() }));

// An unknown API route is a JSON problem, not an HTML page the client cannot parse.
app.use('/api', (req, res, next) => next(HttpError.notFound('Route')));

// Marketing site at /, apps at /clinic and /app.
app.use('/clinic', express.static(path.join(root, 'web', 'clinic')));
app.use('/app', express.static(path.join(root, 'web', 'app')));
app.use('/shared', express.static(path.join(root, 'web', 'shared')));
app.use('/docs', express.static(path.join(root, 'docs')));
app.use('/', express.static(path.join(root, 'web', 'site')));

// SPA fallbacks
app.get('/clinic/*splat', (req, res) => res.sendFile(path.join(root, 'web', 'clinic', 'index.html')));
app.get('/app/*splat', (req, res) => res.sendFile(path.join(root, 'web', 'app', 'index.html')));

// RFC 9457 problem details
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  // body-parser's own errors are client mistakes, not ours.
  if (err.type === 'entity.parse.failed') err = HttpError.badRequest('Request body is not valid JSON');
  else if (err.type === 'entity.too.large') err = new HttpError(413, 'too_large', 'Request too large', 'Request body is too large');
  const status = err.status ?? 500;
  const requestId = `req_${Math.random().toString(36).slice(2, 10)}`;
  if (status >= 500) console.error(`[error] ${requestId} ${req.method} ${req.originalUrl}`, err);
  res.status(status).type('application/problem+json').json({
    type: `https://docs.vaguthu.mv/errors/${err.type ?? 'internal'}`,
    title: err.title ?? 'Internal error',
    status,
    detail: err.detail ?? (status >= 500 ? 'Something went wrong' : err.message),
    instance: req.originalUrl,
    request_id: requestId,
    ...(err.extra ?? {}),
  });
});

/**
 * Socket subscriptions: clinic and session channels need a live staff
 * sign-in for THAT clinic. Patient channels stay open — the patient app has
 * no sign-in, and a patient id is the only thing the channel reveals.
 */
function authorizeChannel(channel, token) {
  let clinicId = null;
  if (channel.startsWith('clinic:')) clinicId = channel.slice('clinic:'.length);
  else if (channel.startsWith('session:')) clinicId = db.prepare('SELECT clinic_id FROM sessions WHERE id = ?').get(channel.slice('session:'.length))?.clinic_id ?? null;
  else return true;
  return !!clinicId && sessionForToken(token)?.clinicId === clinicId;
}

const server = http.createServer(app);
attach(server, { authorize: authorizeChannel });
notify.start();

if (!db.prepare('SELECT COUNT(*) AS c FROM clinics').get().c) {
  console.log('[boot] empty database — seeding demo data');
  seed({ force: true });
}
// In demo mode the evening runs by itself — nobody should open the board and
// find it frozen because a deploy dropped the simulator.
autopilot.boot();

/**
 * The ticker. Everything time-driven lives here so there is exactly one place
 * that advances the world: grace periods, hold expiry, the outbox relay,
 * webhook delivery, and the day simulator.
 */
const ticker = setInterval(async () => {
  try {
    autopilot.tick();
    simulator.tick();
    // Time-driven rules — "leave now", at-risk, and the staleness watchdog —
    // need a heartbeat. An event-only engine never tells anyone to leave.
    for (const row of db.prepare("SELECT id FROM sessions WHERE state IN ('running','paused','scheduled') AND scheduled_end > ? AND scheduled_start < ?")
      .all(now() - 3600_000, now() + 3600_000)) {
      recompute(row.id, { trigger: 'tick' });
    }
    notify.tick();
    queueService.sweepGracePeriods();
    scheduling.expireHolds();
    notify.relayOutbox();
    await webhooks.drain();
  } catch (err) {
    console.error('[ticker]', err);
  }
}, 1000);
ticker.unref?.();

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`\n  Vaguthu running on http://localhost:${port}`);
  console.log(`    site      http://localhost:${port}/`);
  console.log(`    clinic    http://localhost:${port}/clinic/`);
  console.log(`    patient   http://localhost:${port}/app/`);
  console.log(`    api docs  http://localhost:${port}/docs/05-partner-api-and-webhooks.md\n`);
});

export { app, server };
