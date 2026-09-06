/**
 * Partner API (public, /v1) — the contract in docs/05-partner-api-and-webhooks.md
 * and docs/api/openapi.yaml.
 *
 * Published openly, including to competitors of our own patient app: it removes
 * the strongest objection in the B2B sale, and rails outlast destinations.
 */
import express from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { now } from '../lib/clock.js';
import { id, parse, asyncRoute, HttpError } from '../lib/util.js';
import { rfc3339 } from '../lib/mvtime.js';
import { readProjection, recompute } from '../engine/engine.js';
import * as queue from '../services/queue.js';
import * as scheduling from '../services/scheduling.js';
import * as webhooks from '../services/webhooks.js';
import { addSse } from '../realtime.js';

export const router = express.Router();

const TOKEN_TTL_MS = 3_600_000;
const tokens = new Map(); // access_token -> { partnerId, scopes, expiresAt }
const rateBuckets = new Map();

// ---------------------------------------------------------------------- auth
export const oauth = express.Router();
oauth.post('/token', express.urlencoded({ extended: false }), asyncRoute((req, res) => {
  const { grant_type: grant, client_id: clientId, client_secret: clientSecret, scope } = req.body || {};
  if (grant !== 'client_credentials') throw HttpError.badRequest('grant_type must be client_credentials');
  const partner = db.prepare('SELECT * FROM partners WHERE client_id = ?').get(clientId);
  if (!partner || partner.client_secret !== clientSecret) throw HttpError.unauthorized('Unknown client');
  const granted = parse(partner.scopes, []);
  const requested = scope ? scope.split(/\s+/).filter((s) => granted.includes(s)) : granted;
  const accessToken = crypto.randomBytes(24).toString('base64url');
  tokens.set(accessToken, { partnerId: partner.id, scopes: requested, expiresAt: Date.now() + TOKEN_TTL_MS });
  res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: TOKEN_TTL_MS / 1000, scope: requested.join(' ') });
}));

function authenticate(req) {
  const header = req.get('authorization') || '';
  const value = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = value ? tokens.get(value) : null;
  if (!session || session.expiresAt < Date.now()) throw HttpError.unauthorized('Invalid or expired access token');
  return session;
}

const requireScope = (scope) => (req, res, next) => {
  try {
    const session = authenticate(req);
    if (!session.scopes.includes(scope)) throw HttpError.forbidden(`Missing scope: ${scope}`);
    req.partner = session;
    next();
  } catch (err) { next(err); }
};

/** 600 req/min sustained. Streaming and webhooks are outside the limit — we want partners on push. */
router.use((req, res, next) => {
  try {
    const session = authenticate(req);
    const key = session.partnerId;
    const bucket = rateBuckets.get(key) ?? { count: 0, resetAt: Date.now() + 60_000 };
    if (Date.now() > bucket.resetAt) { bucket.count = 0; bucket.resetAt = Date.now() + 60_000; }
    bucket.count++;
    rateBuckets.set(key, bucket);
    res.set('X-RateLimit-Limit', '600');
    res.set('X-RateLimit-Remaining', String(Math.max(0, 600 - bucket.count)));
    res.set('X-RateLimit-Reset', String(Math.floor(bucket.resetAt / 1000)));
    res.set('Vaguthu-Version', webhooks.API_VERSION);
    if (bucket.count > 600) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - Date.now()) / 1000)));
      throw new HttpError(429, 'rate_limited', 'Too many requests', 'Sustained limit is 600 req/min');
    }
    next();
  } catch (err) { next(err); }
});

/** Which clinics has this partner actually been granted by the clinic itself? */
function allowedClinics(partnerId) {
  return db.prepare('SELECT clinic_id FROM partner_clinic WHERE partner_id = ? AND enabled = 1')
    .all(partnerId).map((r) => r.clinic_id);
}

function assertClinicAllowed(partnerId, clinicId) {
  if (!allowedClinics(partnerId).includes(clinicId)) {
    throw HttpError.forbidden('This clinic has not enabled your integration');
  }
}

// ----------------------------------------------------------------- discovery
router.get('/clinics', requireScope('clinics:read'), asyncRoute((req, res) => {
  const allowed = allowedClinics(req.partner.partnerId);
  if (!allowed.length) return res.json({ data: [], next_cursor: null });
  let rows = db.prepare(`SELECT * FROM clinics WHERE id IN (${allowed.map(() => '?').join(',')})`).all(...allowed);
  if (req.query.atoll) rows = rows.filter((c) => c.atoll === req.query.atoll);
  if (req.query.island) rows = rows.filter((c) => c.island === req.query.island);
  res.json({
    data: rows.map((c) => ({ id: c.id, name: c.name, atoll: c.atoll, island: c.island, address: c.address })),
    next_cursor: null,
  });
}));

router.get('/clinics/:id/doctors', requireScope('clinics:read'), asyncRoute((req, res) => {
  assertClinicAllowed(req.partner.partnerId, req.params.id);
  res.json({ data: db.prepare('SELECT * FROM doctors WHERE clinic_id = ?').all(req.params.id).map(serialiseDoctor) });
}));

function serialiseDoctor(d) {
  const clinic = db.prepare('SELECT id, name, atoll, island FROM clinics WHERE id = ?').get(d.clinic_id);
  const stats = db.prepare(`SELECT AVG(ended_at - started_at) AS avg FROM tokens t JOIN sessions s ON s.id = t.session_id
                            WHERE s.doctor_id = ? AND t.state = 'completed'`).get(d.id);
  const next = scheduling.nextAvailable(d.id, now());
  return {
    id: d.id, name: d.name, specialties: [d.specialty], languages: parse(d.languages, []), gender: d.gender,
    qualifications: d.qualifications,
    clinics: [clinic],
    consultation_fee: { amount: d.fee_minor, currency: 'MVR' },
    accepts_payers: parse(d.accepts_payers, []),
    next_available: next ? rfc3339(next.starts_at) : null,
    // Deliberately low-resolution, and never punctuality: partners cannot build
    // a "which doctors run late" leaderboard from our data.
    typical_consultation_minutes: stats.avg ? Math.round(stats.avg / 60000) : d.slot_minutes,
  };
}

router.get('/doctors/:id', requireScope('clinics:read'), asyncRoute((req, res) => {
  const d = db.prepare('SELECT * FROM doctors WHERE id = ?').get(req.params.id);
  if (!d) throw HttpError.notFound('Doctor');
  assertClinicAllowed(req.partner.partnerId, d.clinic_id);
  res.json(serialiseDoctor(d));
}));

router.get('/doctors/:id/availability', requireScope('slots:read'), asyncRoute((req, res) => {
  const d = db.prepare('SELECT * FROM doctors WHERE id = ?').get(req.params.id);
  if (!d) throw HttpError.notFound('Doctor');
  assertClinicAllowed(req.partner.partnerId, d.clinic_id);
  // Availability is forward-looking by definition; a partner asking for last
  // week gets nothing bookable, not a list of full sessions.
  const from = Math.max(now(), req.query.from ? Date.parse(req.query.from) : now());
  const to = req.query.to ? Date.parse(req.query.to) + 86_400_000 : from + 7 * 86_400_000;
  const sessions = scheduling.availability(d.id, from, to, { partnerId: req.partner.partnerId }).map((s) => ({
    ...s,
    starts_at: rfc3339(s.starts_at),
    ends_at: rfc3339(s.ends_at),
    slots: s.slots.map((sl) => ({ ...sl, starts_at: rfc3339(sl.starts_at) })),
  }));
  res.set('Cache-Control', 'max-age=30');
  res.set('ETag', `"v-${sessions.reduce((a, s) => a + s.slots.length, 0)}-${Math.floor(now() / 30000)}"`);
  res.json({ doctor_id: d.id, sessions });
}));

// -------------------------------------------------------- two-phase booking
function idempotent(req, res, scope, produce) {
  const key = req.get('idempotency-key');
  if (!key) throw HttpError.badRequest('Idempotency-Key header is required');
  const existing = db.prepare('SELECT * FROM idempotency WHERE key = ? AND scope = ?').get(key, scope);
  if (existing) return res.status(200).json(parse(existing.response));
  const body = produce();
  db.prepare('INSERT INTO idempotency (key, scope, response, at) VALUES (?,?,?,?)')
    .run(key, scope, JSON.stringify(body), now());
  return res.status(201).json(body);
}

router.post('/holds', requireScope('bookings:write'), asyncRoute((req, res) => {
  const [sessionId, index] = String(req.body?.slot_id || '').split(':');
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw HttpError.notFound('Slot');
  assertClinicAllowed(req.partner.partnerId, session.clinic_id);

  const { allocation } = scheduling.slotsForSession(session, { partnerId: req.partner.partnerId });
  if (allocation && allocation.remaining <= 0) {
    throw HttpError.conflict('allocation_exhausted',
      `Your allocation for this session is used (${allocation.used}/${allocation.total})`);
  }
  return idempotent(req, res, 'holds', () => {
    const hold = scheduling.createHold({ sessionId, slotIndex: Number(index), partnerId: req.partner.partnerId });
    if (!hold) {
      const alternatives = scheduling.slotsForSession(session).slots
        .filter((s) => s.status === 'available').slice(0, 3)
        .map((s) => ({ slot_id: s.slot_id, starts_at: rfc3339(s.starts_at) }));
      // A booking failure that immediately offers the next slot is a
      // recoverable moment rather than an abandoned one.
      throw HttpError.conflict('slot_unavailable', `Slot ${req.body.slot_id} was just taken`, { alternatives });
    }
    return { hold_id: hold.hold_id, expires_at: rfc3339(hold.expires_at) };
  });
}));

router.post('/bookings', requireScope('bookings:write'), asyncRoute((req, res) => {
  const { hold_id: holdId, patient, visit_type: visitType = 'new', payer, notify_via_partner_only: partnerOnly } = req.body || {};
  if (!patient?.name || !patient?.phone) throw HttpError.unprocessable('patient.name and patient.phone are required');
  return idempotent(req, res, 'bookings', () => {
    const hold = scheduling.consumeHold(holdId);
    if (!hold) throw HttpError.conflict('hold_expired', 'Hold not found or expired');
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(hold.session_id);
    assertClinicAllowed(req.partner.partnerId, session.clinic_id);

    let existing = db.prepare('SELECT * FROM patients WHERE phone = ?').get(patient.phone);
    if (!existing) {
      const patientId = id('pat');
      db.prepare(`INSERT INTO patients (id, name, phone, national_id, dob, language, payer_type, insurer,
                  policy_no, travel_atoll, travel_island, travel_minutes, wait_location, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(patientId, patient.name, patient.phone, patient.national_id ?? null, patient.date_of_birth ?? null,
          patient.language ?? 'dv', payer?.type ?? 'self_pay', payer?.insurer ?? null, payer?.policy_no ?? null,
          patient.travel_origin?.atoll ?? null, patient.travel_origin?.island ?? null,
          patient.travel_origin ? 0 : 10, patient.travel_origin ? 'clinic' : 'nearby', now());
      existing = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
    }

    const token = queue.addToken({
      sessionId: hold.session_id, patientId: existing.id, source: 'partner',
      partnerId: req.partner.partnerId, partnerReference: req.body?.partner_reference ?? null,
      visitType, notifyViaPartnerOnly: !!partnerOnly,
    });
    const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(session.doctor_id);
    const projection = readProjection(hold.session_id);
    const entry = projection?.entries?.find((e) => e.tokenId === token.id);
    return {
      booking_id: token.id,
      status: 'confirmed',
      token: { id: token.id, display: token.display, session_id: hold.session_id },
      predicted_start: entry ? serialisePrediction(entry) : null,
      queue: { position: entry?.position ?? null, tokens_ahead: entry?.tokensAhead ?? null },
      payment: {
        required: true,
        amount: { amount: doctor.fee_minor, currency: 'MVR' },
        payment_link: `${req.protocol}://${req.get('host')}/pay/${token.id}`,
      },
      cancellation_policy: { free_until: rfc3339(session.scheduled_start - 3 * 3_600_000) },
    };
  });
}));

function serialisePrediction(entry) {
  return {
    p50: rfc3339(entry.predictedStart.p50),
    p80_window: { from: rfc3339(entry.predictedStart.window.from), to: rfc3339(entry.predictedStart.window.to) },
    confidence: entry.predictedStart.confidence,
  };
}

function partnerToken(partnerId, bookingId) {
  const token = db.prepare('SELECT * FROM tokens WHERE id = ?').get(bookingId);
  // Partners may only read, modify or cancel bookings they created.
  if (!token || token.partner_id !== partnerId) throw HttpError.notFound('Booking');
  return token;
}

router.get('/bookings/:id', requireScope('bookings:read'), asyncRoute((req, res) => {
  const token = partnerToken(req.partner.partnerId, req.params.id);
  const projection = readProjection(token.session_id);
  const entry = projection?.entries?.find((e) => e.tokenId === token.id);
  res.json({
    booking_id: token.id, status: token.state,
    token: { id: token.id, display: token.display, session_id: token.session_id },
    predicted_start: entry ? serialisePrediction(entry) : null,
    queue: { position: entry?.position ?? null, tokens_ahead: entry?.tokensAhead ?? null },
  });
}));

router.delete('/bookings/:id', requireScope('bookings:write'), asyncRoute((req, res) => {
  const token = partnerToken(req.partner.partnerId, req.params.id);
  const session = db.prepare('SELECT clinic_id FROM sessions WHERE id = ?').get(token.session_id);
  const link = db.prepare('SELECT can_cancel FROM partner_clinic WHERE partner_id = ? AND clinic_id = ?')
    .get(req.partner.partnerId, session.clinic_id);
  if (!link?.can_cancel) throw HttpError.forbidden('This clinic has not granted cancellation rights');
  queue.cancelToken(token.id, 'partner');
  res.status(204).end();
}));

// ---------------------------------------------------------------- queue read
router.get('/sessions/:id/queue', requireScope('queue:read'), asyncRoute((req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) throw HttpError.notFound('Session');
  assertClinicAllowed(req.partner.partnerId, session.clinic_id);
  let projection = readProjection(session.id);
  if (!projection || projection.computedAt < now() - 20_000) {
    projection = recompute(session.id, { notify: false })?.projection ?? projection;
  }
  const etag = `"v-${projection?.version ?? 0}"`;
  if (req.get('if-none-match') === etag) return res.status(304).end();

  const mine = db.prepare('SELECT id FROM tokens WHERE session_id = ? AND partner_id = ?')
    .all(session.id, req.partner.partnerId).map((t) => t.id);

  res.set('ETag', etag);
  res.json({
    session_id: session.id,
    version: projection?.version ?? 0,
    computed_at: rfc3339(projection?.computedAt ?? now()),
    state: session.state,
    running_late_minutes: projection?.runningLateMinutes ?? 0,
    pause: projection?.pause ? {
      reason: projection.pause.kind,
      expected_resume_at: rfc3339(projection.pause.expectedResumeAt),
    } : null,
    // Aggregate facts are shared; per-token detail exists only for this
    // partner's own bookings. `now_serving` is a display code, never an identity.
    now_serving: projection?.nowServing
      ? { display: projection.nowServing.display, started_at: rfc3339(projection.nowServing.startedAt) }
      : null,
    tokens_waiting: projection?.tokensWaiting ?? 0,
    your_bookings: (projection?.entries ?? []).filter((e) => mine.includes(e.tokenId)).map((e) => ({
      booking_id: e.tokenId, token_display: e.display, state: e.state,
      tokens_ahead: e.tokensAhead, predicted_start: serialisePrediction(e), leave_now: e.leaveNow,
    })),
  });
}));

router.get('/stream/sessions/:id', requireScope('queue:subscribe'), asyncRoute((req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) throw HttpError.notFound('Session');
  assertClinicAllowed(req.partner.partnerId, session.clinic_id);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders?.();
  res.write(`event: queue.updated\ndata: ${JSON.stringify(readProjection(session.id) ?? {})}\n\n`);
  addSse(`session:${session.id}`, res);
}));

// ------------------------------------------------------------------ webhooks
router.post('/webhook_endpoints', requireScope('queue:subscribe'), asyncRoute((req, res) => {
  const { url, events, clinic_ids: clinicIds = [] } = req.body || {};
  if (!url || !Array.isArray(events)) throw HttpError.unprocessable('url and events are required');
  const bad = events.filter((e) => !webhooks.EVENT_TYPES.includes(e));
  if (bad.length) throw HttpError.unprocessable(`Unknown event types: ${bad.join(', ')}`);
  res.status(201).json(webhooks.createEndpoint({ partnerId: req.partner.partnerId, url, events, clinicIds }));
}));

router.get('/webhook_endpoints', requireScope('queue:subscribe'), asyncRoute((req, res) => {
  res.json({ data: webhooks.listEndpoints(req.partner.partnerId), stats: webhooks.deliveryStats(req.partner.partnerId) });
}));

router.delete('/webhook_endpoints/:id', requireScope('queue:subscribe'), asyncRoute((req, res) => {
  if (!webhooks.deleteEndpoint(req.partner.partnerId, req.params.id)) throw HttpError.notFound('Endpoint');
  res.status(204).end();
}));

router.post('/webhook_endpoints/:id/rotate_secret', requireScope('queue:subscribe'), asyncRoute((req, res) => {
  const out = webhooks.rotateSecret(req.partner.partnerId, req.params.id);
  if (!out) throw HttpError.notFound('Endpoint');
  res.json(out);
}));

router.get('/webhook_endpoints/:id/failed_events', requireScope('queue:subscribe'), asyncRoute((req, res) => {
  res.json({ data: webhooks.failedEvents(req.partner.partnerId, req.params.id) });
}));

router.post('/webhook_endpoints/:id/replay', requireScope('queue:subscribe'), asyncRoute((req, res) => {
  const n = webhooks.replay(req.partner.partnerId, req.params.id, {
    from: req.body?.from ? Date.parse(req.body.from) : null,
    to: req.body?.to ? Date.parse(req.body.to) : null,
    types: req.body?.types ?? [],
  });
  res.status(202).json({ replayed: n });
}));

/**
 * Sandbox: force a delay, pause, overrun or no-show on demand. A partner must
 * be able to test their "session delayed" handler without waiting for a real
 * doctor to be late.
 */
router.post('/sandbox/simulate', requireScope('queue:subscribe'), asyncRoute((req, res) => {
  const { session_id: sessionId, event } = req.body || {};
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw HttpError.notFound('Session');
  assertClinicAllowed(req.partner.partnerId, session.clinic_id);
  switch (event) {
    case 'delay': queue.delaySession(sessionId, Number(req.body.minutes ?? 25)); break;
    case 'pause': queue.pauseSession(sessionId, { kind: 'emergency', expectedMinutes: Number(req.body.minutes ?? 15) }); break;
    case 'resume': queue.resumeSession(sessionId); break;
    case 'cancel': queue.cancelSession(sessionId, 'sandbox'); break;
    default: throw HttpError.badRequest('event must be one of: delay, pause, resume, cancel');
  }
  res.json({ ok: true, event });
}));
