/**
 * Clinic dashboard API — receptionist board, doctor module, billing, admin.
 *
 * Every route runs behind `requireStaff`, so `req.tenant.clinicId` is the only
 * clinic any query may touch. Entity routes call `own()` first. There is no
 * `clinicId` parameter anywhere in this file, on purpose.
 */
import express from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { now, MINUTE } from '../lib/clock.js';
import { id, parse, asyncRoute, HttpError, num, oneOf, text, normalisePhone } from '../lib/util.js';
import { mvStartOfDay } from '../lib/mvtime.js';
import { readProjection, recompute } from '../engine/engine.js';
import * as queue from '../services/queue.js';
import { tokenView, tokensView, sessionView } from '../services/board.js';
import * as scheduling from '../services/scheduling.js';
import * as billing from '../services/billing.js';
import * as messaging from '../services/messaging.js';
import * as analytics from '../services/analytics.js';
import * as simulator from '../services/simulator.js';
import { requireStaff, requireAdmin, own, linkPatient, listStaff, createStaff, resetPassword, setStaffActive } from '../services/tenancy.js';
import { publish } from '../realtime.js';

export const router = express.Router();
router.use(requireStaff);

/**
 * Idempotency-Key: a double-tap on a tablet replays the first answer instead
 * of acting twice. Keyed per sign-in so one desk's key cannot replay another's.
 * In memory with a short TTL — the second tap arrives within seconds.
 */
const IDEMPOTENCY_TTL_MS = 60_000;
const replays = new Map(); // key -> {at, status, type, body}
router.use((req, res, next) => {
  if (req.method !== 'POST' && req.method !== 'PUT') return next();
  const key = req.get('idempotency-key');
  if (!key) return next();
  const at = Date.now();
  for (const [k, v] of replays) if (at - v.at > IDEMPOTENCY_TTL_MS) replays.delete(k);
  const k = `${req.tenant.token}:${req.method}:${req.originalUrl}:${key}`;
  const hit = replays.get(k);
  if (hit) {
    res.set('Idempotent-Replayed', 'true');
    return res.status(hit.status).type(hit.type).send(hit.body);
  }
  const send = res.send.bind(res);
  res.send = (body) => {
    if (typeof body === 'string') replays.set(k, { at, status: res.statusCode, type: res.get('content-type') || 'application/json', body });
    return send(body);
  };
  return next();
});

const SOURCES = ['walk_in', 'phone', 'app', 'partner'];
const VISIT_TYPES = ['new', 'follow_up'];
const LANGUAGES = ['dv', 'en', 'bn', 'hi', 'ta', 'si', 'ml'];
const PAYERS = ['aasandha', 'private', 'corporate', 'self_pay'];

/** Clinic settings as the dashboard may see them. Demo credentials never leave the sign-in page. */
function publicSettings(clinic) {
  const settings = parse(clinic.settings, {}) || {};
  delete settings.demoCredentials;
  return settings;
}

function audit(req, action, entity, after) {
  db.prepare('INSERT INTO audit (id, clinic_id, actor, action, entity, after, at) VALUES (?,?,?,?,?,?,?)')
    .run(id('aud'), req.tenant.clinicId, req.tenant.staff.name, action, entity ?? null,
      after ? JSON.stringify(after).slice(0, 2000) : null, now());
}

router.get('/bootstrap', asyncRoute((req, res) => {
  const { clinicId, staff } = req.tenant;
  const clinic = db.prepare('SELECT * FROM clinics WHERE id = ?').get(clinicId);
  res.json({
    clinic: { ...clinic, settings: publicSettings(clinic) },
    staff,
    doctors: db.prepare('SELECT * FROM doctors WHERE clinic_id = ? ORDER BY rowid').all(clinicId)
      .map((d) => ({ ...d, languages: parse(d.languages, []) })),
    penaltyPolicy: queue.clinicSettings(clinicId).penalty,
    // The demo panel (simulated doctors, reseed) exists only for evaluation.
    // A real clinic never sees it.
    demo: process.env.VAGUTHU_DEMO !== 'false',
    serverNow: now(),
  });
}));

/** The board: every doctor column, every token, with the live projection merged in. */
router.get('/board', asyncRoute((req, res) => {
  const { clinicId } = req.tenant;
  const day = num(req.query.day, 'day', { fallback: now() });
  const sessions = scheduling.sessionsForDay(clinicId, day).map((s) => {
    let projection = readProjection(s.id);
    if (!projection || projection.computedAt < now() - 30_000) {
      projection = recompute(s.id, { notify: false })?.projection ?? projection;
    }
    return { ...sessionView(s.id), projection, tokens: tokensView(s.id, projection) };
  });
  // The ETag covers the board, not the clock: a poll that finds nothing
  // changed costs a 304, not 70 KB. Ticks carry the clock.
  const board = JSON.stringify({ day: mvStartOfDay(day), sessions });
  const etag = `W/"${crypto.createHash('sha1').update(board).digest('base64url')}"`;
  res.set('ETag', etag);
  if (req.get('if-none-match') === etag) return res.status(304).end();
  return res.type('application/json').send(`{"day":${mvStartOfDay(day)},"serverNow":${now()},"sessions":${JSON.stringify(sessions)}}`);
}));

// ------------------------------------------------------------------ sessions
/** Every session action answers {ok, session, projection, ...extras}. */
const sessionAction = (fn) => asyncRoute((req, res) => {
  own('session', req.params.id, req.tenant.clinicId);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  const result = fn(req, session) ?? {};
  audit(req, `session.${req.path.split('/').pop()}`, session.id, req.body);
  res.json({
    ok: true,
    session: result.session ?? sessionView(session.id),
    projection: result.projection ?? readProjection(session.id),
    ...result,
  });
});

router.get('/sessions/:id', asyncRoute((req, res) => {
  own('session', req.params.id, req.tenant.clinicId);
  const projection = readProjection(req.params.id);
  res.json({ session: sessionView(req.params.id), tokens: tokensView(req.params.id, projection), projection });
}));

router.post('/sessions/:id/start', sessionAction((req, s) => queue.startSession(s.id, req.tenant.staff.name)));
router.post('/sessions/:id/end', sessionAction((req, s) => queue.endSession(s.id, { completeCurrent: req.body?.completeCurrent === true })));
router.post('/sessions/:id/pause', sessionAction((req, s) => queue.pauseSession(s.id, {
  kind: req.body?.kind ?? 'break', expectedMinutes: req.body?.expectedMinutes ?? 15,
})));
router.post('/sessions/:id/resume', sessionAction((req, s) => queue.resumeSession(s.id)));
router.post('/sessions/:id/delay', sessionAction((req, s) => queue.delaySession(s.id, req.body?.minutes ?? 15)));
router.post('/sessions/:id/cancel', sessionAction((req, s) => queue.cancelSession(s.id, text(req.body?.reason, 'reason', { max: 200, fallback: 'unspecified' }),
  { completeCurrent: req.body?.completeCurrent === true })));

router.get('/sessions/:id/broadcast-estimate', asyncRoute((req, res) => {
  own('session', req.params.id, req.tenant.clinicId);
  res.json(messaging.estimateBroadcast(req.params.id));
}));
router.post('/sessions/:id/broadcast', sessionAction((req, s) => {
  queue.assertSession(s, 'broadcast');
  const body = text(req.body?.text, 'text', { max: 400, required: true });
  return messaging.broadcast({ sessionId: s.id, clinicId: s.clinic_id, text: body });
}));

router.post('/sessions/:id/simulate', asyncRoute((req, res) => {
  own('session', req.params.id, req.tenant.clinicId);
  const on = req.body?.enabled !== false;
  if (on) simulator.enable(req.params.id, req.body ?? {});
  else simulator.disable(req.params.id);
  res.json({ ok: true, simulating: on, session: sessionView(req.params.id), projection: readProjection(req.params.id) });
}));

// -------------------------------------------------------------------- tokens
router.post('/tokens', asyncRoute((req, res) => {
  const { clinicId } = req.tenant;
  const body = req.body || {};
  const { sessionId, patientId } = body;
  if (!sessionId) throw HttpError.badRequest('sessionId is required', { field: 'sessionId' });
  own('session', sessionId, clinicId);
  const source = oneOf(body.source, 'source', SOURCES, 'walk_in');
  const visitType = oneOf(body.visitType, 'visitType', VISIT_TYPES, 'new');
  const priorityReason = text(body.priorityReason, 'priorityReason', { max: 200 });

  let pid = patientId;
  if (pid) {
    own('patient', pid, clinicId);
  } else {
    const name = text(body.name, 'name', { max: 120, required: true });
    const phone = normalisePhone(body.phone);
    if (!phone) throw HttpError.badRequest('phone must be a 7-digit Maldivian number (or a full international number)', { field: 'phone' });
    const nationalId = text(body.nationalId, 'nationalId', { max: 32 });
    const language = oneOf(body.language, 'language', LANGUAGES, 'dv');
    const payerType = oneOf(body.payerType, 'payerType', PAYERS, 'aasandha');
    const travelIsland = text(body.travelIsland, 'travelIsland', { max: 80 });
    const travelAtoll = text(body.travelAtoll, 'travelAtoll', { max: 40 });
    // Look for the person among THIS clinic's patients only. A phone number
    // known to another clinic is not this clinic's business.
    const existing = db.prepare(`SELECT p.* FROM patients p JOIN clinic_patients cp ON cp.patient_id = p.id
                                 WHERE cp.clinic_id = ? AND p.phone = ?`).get(clinicId, phone);
    if (existing) {
      pid = existing.id;
    } else {
      // The platform identity may already exist (the person has an app account
      // or has visited elsewhere). We link to it so their own app keeps working,
      // but nothing from other clinics becomes visible here.
      const identity = db.prepare('SELECT id FROM patients WHERE phone = ?').get(phone);
      if (identity) {
        pid = identity.id;
      } else {
        pid = id('pat');
        db.prepare(`INSERT INTO patients (id, name, phone, national_id, language, payer_type, travel_island, travel_atoll, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(pid, name, phone, nationalId, language, payerType, travelIsland, travelAtoll, now());
      }
      linkPatient(clinicId, pid);
    }
  }
  const token = queue.addToken({ sessionId, patientId: pid, source, visitType, priorityReason, allowDuplicate: body.allowDuplicate === true });
  billing.checkEligibility(pid);
  audit(req, 'token.create', token.id, { source, priorityReason });
  res.status(201).json({ token: tokenView(token.id), projection: readProjection(sessionId) });
}));

router.get('/tokens/:id', asyncRoute((req, res) => {
  own('token', req.params.id, req.tenant.clinicId);
  res.json({ token: tokenView(req.params.id) });
}));

/** Every token action answers {ok, token, projection, ...extras}; a refused transition is a 409 the UI can read out. */
const tokenAction = (fn) => asyncRoute((req, res) => {
  own('token', req.params.id, req.tenant.clinicId);
  const token = db.prepare('SELECT * FROM tokens WHERE id = ?').get(req.params.id);
  const result = fn(req, token) ?? {};
  audit(req, `token.${req.path.split('/').pop()}`, token.id, req.body);
  res.json({ ok: true, token: result.token ?? tokenView(token.id), projection: result.projection ?? readProjection(token.session_id), ...result });
});

router.post('/tokens/:id/checkin', tokenAction((req, t) => queue.checkIn(t.id)));
router.post('/tokens/:id/call', tokenAction((req, t) => queue.callToken(t.id)));
router.post('/tokens/:id/start', tokenAction((req, t) => queue.startConsult(t.id, { endCurrent: req.body?.endCurrent === true })));
router.post('/tokens/:id/extend', tokenAction((req, t) => queue.extendConsult(t.id, req.body?.minutes ?? 10)));
router.post('/tokens/:id/no-show', tokenAction((req, t) => queue.markNoShow(t.id)));
router.post('/tokens/:id/cancel', tokenAction((req, t) => queue.cancelToken(t.id, oneOf(req.body?.by, 'by', ['clinic', 'patient'], 'clinic'))));
router.post('/tokens/:id/penalty', tokenAction((req, t) => queue.applyPenalty(t.id, oneOf(req.body?.cause, 'cause', ['not_present', 'late_arrival'], 'not_present'))));
router.post('/tokens/:id/revoke-penalty', tokenAction((req, t) => queue.revokePenalty(t.id)));
router.post('/tokens/:id/reinstate', tokenAction((req, t) => queue.reinstate(t.id)));
router.post('/tokens/:id/reorder', tokenAction((req, t) => {
  const { afterTokenId = null, beforeTokenId = null, position = null } = req.body || {};
  if (afterTokenId) own('token', afterTokenId, req.tenant.clinicId);
  if (beforeTokenId) own('token', beforeTokenId, req.tenant.clinicId);
  return queue.reorder(t.id, { afterTokenId, beforeTokenId, position });
}));
router.post('/tokens/:id/reassign', tokenAction((req, t) => {
  own('session', req.body?.sessionId, req.tenant.clinicId);
  return queue.reassign(t.id, req.body.sessionId);
}));

/**
 * End & next. The next patient is CALLED, never started: nobody is "in the
 * room" until reception has seen them walk in. Idempotent — a second tap
 * gets the same invoice and calls nobody.
 */
router.post('/tokens/:id/end', tokenAction((req, t) => {
  const extraLines = Array.isArray(req.body?.extraLines) ? req.body.extraLines.slice(0, 20).map((l) => ({
    description: text(l?.description, 'extraLines.description', { max: 120, required: true }),
    category: oneOf(l?.category, 'extraLines.category', ['consultation', 'procedure', 'certificate', 'report', 'supplies', 'other'], 'other'),
    amountMinor: num(l?.amountMinor, 'extraLines.amountMinor', { min: 0, max: 10_000_000, int: true }),
    taxable: l?.taxable === true,
  })) : [];
  const result = queue.endConsult(t.id, { extraLines });
  let next = null;
  if (req.body?.callNext && !result.noop) {
    const candidate = queue.nextPresent(t.session_id);
    if (candidate) next = queue.callToken(candidate.id).token;
  }
  return { ...result, next };
}));

router.post('/tokens/:id/note', tokenAction((req, t) => queue.setNote(t.id, text(req.body?.note, 'note', { max: 500 }))));

// ------------------------------------------------------------------ patients
/** Only patients this clinic has actually seen or registered. */
router.get('/patients', asyncRoute((req, res) => {
  const raw = String(req.query.q || '').trim();
  const q = `%${raw}%`;
  // Digits match the phone with spaces and '+' removed, so "7000031" finds
  // '+960 700 0031' — a miss here is how duplicate patients get created.
  const digits = raw.replace(/\D/g, '');
  const rows = db.prepare(`SELECT p.* FROM patients p JOIN clinic_patients cp ON cp.patient_id = p.id
                           WHERE cp.clinic_id = ? AND (p.name LIKE ? OR p.phone LIKE ? OR p.national_id LIKE ?
                             OR (? != '' AND REPLACE(REPLACE(p.phone, ' ', ''), '+', '') LIKE ?))
                           ORDER BY CASE WHEN p.name LIKE ? THEN 0 ELSE 1 END, cp.first_seen_at DESC LIMIT 25`)
    .all(req.tenant.clinicId, q, q, q, digits, `%${digits}%`, `${raw}%`);
  res.json({ patients: rows });
}));

/** Edit the details a receptionist is asked to correct at the desk. Audited; phone stored in one canonical shape. */
router.put('/patients/:id', asyncRoute((req, res) => {
  const { clinicId } = req.tenant;
  own('patient', req.params.id, clinicId);
  const body = req.body || {};
  const patch = {};
  if ('name' in body) patch.name = text(body.name, 'name', { max: 120, required: true });
  if ('phone' in body) {
    patch.phone = normalisePhone(body.phone);
    if (!patch.phone) throw HttpError.badRequest('phone must be a 7-digit Maldivian number (or a full international number)', { field: 'phone' });
  }
  if ('national_id' in body) patch.national_id = text(body.national_id, 'national_id', { max: 32 });
  if ('dob' in body) {
    patch.dob = text(body.dob, 'dob', { max: 10 });
    if (patch.dob && !/^\d{4}-\d{2}-\d{2}$/.test(patch.dob)) throw HttpError.badRequest('dob must be YYYY-MM-DD', { field: 'dob' });
  }
  if ('language' in body) patch.language = oneOf(body.language, 'language', LANGUAGES);
  if ('payer_type' in body) patch.payer_type = oneOf(body.payer_type, 'payer_type', PAYERS);
  if ('travel_island' in body) patch.travel_island = text(body.travel_island, 'travel_island', { max: 80 });
  if ('travel_atoll' in body) patch.travel_atoll = text(body.travel_atoll, 'travel_atoll', { max: 40 });
  const keys = Object.keys(patch);
  if (!keys.length) throw HttpError.badRequest('nothing to update: send name, phone, national_id, dob, language, payer_type, travel_island or travel_atoll');
  db.prepare(`UPDATE patients SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), req.params.id);
  audit(req, 'patient.update', req.params.id, patch);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
  res.json({ patient: { ...patient, notify_prefs: parse(patient.notify_prefs, {}) } });
}));

router.get('/patients/:id', asyncRoute((req, res) => {
  const { clinicId } = req.tenant;
  own('patient', req.params.id, clinicId);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
  // Household members are shown only if this clinic knows them too.
  const household = db.prepare(`SELECT p.* FROM patients p JOIN clinic_patients cp ON cp.patient_id = p.id
                                WHERE p.household_of = ? AND cp.clinic_id = ?`).all(patient.id, clinicId);
  res.json({
    patient: { ...patient, notify_prefs: parse(patient.notify_prefs, {}) },
    household,
    // Visits, invoices and messages at THIS clinic. What happened elsewhere is
    // the patient's own record, not this clinic's.
    visits: db.prepare(`SELECT t.*, s.scheduled_start, d.name AS doctor_name FROM tokens t
                        JOIN sessions s ON s.id = t.session_id JOIN doctors d ON d.id = s.doctor_id
                        WHERE t.patient_id = ? AND s.clinic_id = ? ORDER BY s.scheduled_start DESC LIMIT 30`).all(patient.id, clinicId),
    invoices: db.prepare('SELECT * FROM invoices WHERE patient_id = ? AND clinic_id = ? ORDER BY created_at DESC').all(patient.id, clinicId)
      .map((r) => ({ ...r, lines: parse(r.lines, []) })),
    messages: db.prepare('SELECT * FROM messages WHERE patient_id = ? AND clinic_id = ? ORDER BY at DESC LIMIT 30').all(patient.id, clinicId),
    eligibility: billing.latestEligibility(patient.id),
    referrals: db.prepare(`SELECT r.* FROM referrals r LEFT JOIN tokens t ON t.id = r.used_token_id
                           LEFT JOIN sessions s ON s.id = t.session_id
                           WHERE r.patient_id = ? AND (s.clinic_id = ? OR r.used_token_id IS NULL)
                           ORDER BY r.issued_at DESC`).all(patient.id, clinicId),
  });
}));

router.post('/patients/:id/eligibility', asyncRoute((req, res) => {
  own('patient', req.params.id, req.tenant.clinicId);
  res.json(billing.checkEligibility(req.params.id));
}));

// ------------------------------------------------------------------- billing
router.get('/billing', asyncRoute((req, res) => {
  const { clinicId } = req.tenant;
  const from = num(req.query.from, 'from', { fallback: now() - 30 * 86_400_000 });
  res.json({
    invoices: db.prepare(`SELECT i.*, p.name AS patient_name FROM invoices i JOIN patients p ON p.id = i.patient_id
                          WHERE i.clinic_id = ? AND i.created_at >= ? ORDER BY i.created_at DESC LIMIT 100`)
      .all(clinicId, from).map((r) => ({ ...r, lines: parse(r.lines, []) })),
    claims: db.prepare(`SELECT state, COUNT(*) AS n, SUM(amount_minor) AS value FROM claims
                        WHERE clinic_id = ? GROUP BY state`).all(clinicId),
    worklist: billing.rejectionWorklist(clinicId),
    rejectionAnalytics: billing.rejectionAnalytics(clinicId),
    aasandhaMode: process.env.AASANDHA_MODE === 'api' ? 'api' : 'degraded',
  });
}));

router.post('/billing/claims/submit', asyncRoute((req, res) => {
  res.json(billing.submitClaims(req.tenant.clinicId));
}));
router.post('/billing/claims/adjudicate', asyncRoute((req, res) => {
  res.json(billing.adjudicate(req.tenant.clinicId, num(req.body?.rejectionRate, 'rejectionRate', { min: 0, max: 1, fallback: 0.18 })));
}));
router.post('/billing/claims/:id/resubmit', asyncRoute((req, res) => {
  own('claim', req.params.id, req.tenant.clinicId);
  res.json({ claim: billing.resubmitClaim(req.params.id) });
}));
router.post('/billing/payments', asyncRoute((req, res) => {
  const { invoiceId, amountMinor } = req.body || {};
  if (!invoiceId) throw HttpError.badRequest('invoiceId is required', { field: 'invoiceId' });
  own('invoice', invoiceId, req.tenant.clinicId);
  const method = oneOf(req.body?.method, 'method', billing.PAYMENT_METHODS);
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  const payment = billing.takePayment({ invoiceId, method, amountMinor: num(amountMinor, 'amountMinor', { min: 1, int: true, fallback: invoice?.patient_minor ?? 0 }) });
  audit(req, 'payment.take', invoiceId, { method });
  res.json({ payment });
}));

// ----------------------------------------------------------------- analytics
router.get('/analytics', asyncRoute((req, res) => {
  const { clinicId } = req.tenant;
  const days = num(req.query.days, 'days', { min: 1, max: 365, fallback: 30 });
  const to = now();
  const from = to - days * 86_400_000;
  res.json({
    today: analytics.today(clinicId, to),
    punctuality: analytics.punctuality(clinicId, from, to),
    revenue: analytics.revenue(clinicId, from, to),
    volume: analytics.volume(clinicId, from, to),
    quality: analytics.quality(clinicId, from, to),
    digest: analytics.weeklyDigest(clinicId, to),
    range: { from, to, days },
  });
}));

// ------------------------------------------------------------------ messages
router.get('/messages', asyncRoute((req, res) => {
  const { clinicId } = req.tenant;
  const clinic = db.prepare('SELECT settings FROM clinics WHERE id = ?').get(clinicId);
  res.json({
    messages: messaging.ledgerForClinic(clinicId, 150),
    walletMinor: (parse(clinic?.settings, {}) || {}).messagingWalletMinor ?? 0,
    costs: messaging.CHANNEL_COST_MINOR,
  });
}));

// ------------------------------------------------------------------ settings
router.get('/settings', asyncRoute((req, res) => {
  const { clinicId } = req.tenant;
  const clinic = db.prepare('SELECT * FROM clinics WHERE id = ?').get(clinicId);
  res.json({
    clinic: { ...clinic, settings: publicSettings(clinic) },
    penalty: queue.clinicSettings(clinicId).penalty,
    staff: listStaff(clinicId),
    signInPath: `/clinic/${clinic.slug}/`,
    partners: db.prepare(`SELECT p.id, p.name, pc.enabled, pc.allocation_pct, pc.can_cancel, pc.horizon_days,
                          (SELECT COUNT(*) FROM tokens t JOIN sessions s ON s.id = t.session_id
                           WHERE t.partner_id = p.id AND s.clinic_id = ?) AS bookings
                          FROM partners p LEFT JOIN partner_clinic pc ON pc.partner_id = p.id AND pc.clinic_id = ?`)
      .all(clinicId, clinicId),
  });
}));

// ---------------------------------------------------------------- team
// Admins issue sign-ins to their own team. A generated password is returned
// once, to the admin who created it, and is stored only as a hash.
router.get('/staff', asyncRoute((req, res) => {
  res.json({ staff: listStaff(req.tenant.clinicId) });
}));
router.post('/staff', requireAdmin, asyncRoute((req, res) => {
  const { name, role = 'receptionist', username, password } = req.body || {};
  const out = createStaff({ clinicId: req.tenant.clinicId, name, role, username, password });
  audit(req, 'staff.create', out.staff.id, { name, role, username });
  res.status(201).json(out);
}));
router.post('/staff/:id/reset-password', requireAdmin, asyncRoute((req, res) => {
  const out = resetPassword(req.tenant.clinicId, req.params.id);
  audit(req, 'staff.reset_password', req.params.id, {});
  res.json(out);
}));
router.post('/staff/:id/active', requireAdmin, asyncRoute((req, res) => {
  setStaffActive(req.tenant.clinicId, req.params.id, !!req.body?.active, req.tenant.staff.id);
  audit(req, req.body?.active ? 'staff.activate' : 'staff.deactivate', req.params.id, {});
  res.json({ ok: true });
}));

router.put('/settings', requireAdmin, asyncRoute((req, res) => {
  const { clinicId } = req.tenant;
  const clinic = db.prepare('SELECT * FROM clinics WHERE id = ?').get(clinicId);
  const incoming = { ...(req.body?.settings || {}) };
  delete incoming.demoCredentials;
  const settings = { ...(parse(clinic.settings, {}) || {}), ...incoming };
  db.prepare('UPDATE clinics SET settings = ? WHERE id = ?').run(JSON.stringify(settings), clinicId);
  audit(req, 'settings.update', clinicId, req.body?.settings);
  res.json({ ok: true, settings });
}));

/**
 * Per-partner control surface. The clinic — not us, and not the partner —
 * grants, caps and revokes access, and revocation takes effect immediately.
 */
router.put('/partners/:id', requireAdmin, asyncRoute((req, res) => {
  const { clinicId } = req.tenant;
  if (!db.prepare('SELECT 1 FROM partners WHERE id = ?').get(req.params.id)) throw HttpError.notFound('Partner');
  const { enabled = false, allocationPct = 20, canCancel = true, horizonDays = 14 } = req.body || {};
  db.prepare(`INSERT INTO partner_clinic (partner_id, clinic_id, enabled, allocation_pct, can_cancel, horizon_days)
              VALUES (?,?,?,?,?,?)
              ON CONFLICT(partner_id, clinic_id) DO UPDATE SET
                enabled = excluded.enabled, allocation_pct = excluded.allocation_pct,
                can_cancel = excluded.can_cancel, horizon_days = excluded.horizon_days`)
    .run(req.params.id, clinicId, enabled ? 1 : 0, allocationPct, canCancel ? 1 : 0, horizonDays);
  audit(req, 'partner.update', req.params.id, req.body);
  res.json({ ok: true });
}));

router.get('/audit', asyncRoute((req, res) => {
  res.json({ audit: db.prepare('SELECT * FROM audit WHERE clinic_id = ? ORDER BY at DESC LIMIT 100').all(req.tenant.clinicId) });
}));

// ------------------------------------------------------------- doctor module
router.get('/doctor/:sessionId', asyncRoute((req, res) => {
  own('session', req.params.sessionId, req.tenant.clinicId);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.sessionId);
  const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(session.doctor_id);
  const projection = readProjection(session.id) ?? recompute(session.id, { notify: false })?.projection;
  const current = db.prepare(`SELECT t.*, p.name AS patient_name, p.dob, p.gender, p.payer_type
                              FROM tokens t JOIN patients p ON p.id = t.patient_id
                              WHERE t.session_id = ? AND t.state = 'in_consult'`).get(session.id);
  const upcoming = db.prepare(`SELECT t.*, p.name AS patient_name, p.travel_island, p.dob
                               FROM tokens t JOIN patients p ON p.id = t.patient_id
                               WHERE t.session_id = ? AND t.state IN ('booked','arrived','called','penalised')
                               ORDER BY t.seq LIMIT 6`).all(session.id).map((t) => ({ ...t, flags: parse(t.flags, []) }));
  const done = db.prepare(`SELECT COUNT(*) AS n, AVG(ended_at - started_at) AS avg FROM tokens
                           WHERE session_id = ? AND state = 'completed'`).get(session.id);
  const lastNote = current ? db.prepare(`SELECT t.note FROM tokens t JOIN sessions s ON s.id = t.session_id
                          WHERE t.patient_id = ? AND s.clinic_id = ? AND t.note IS NOT NULL AND t.id != ?
                          ORDER BY s.scheduled_start DESC LIMIT 1`).get(current.patient_id, req.tenant.clinicId, current.id) : null;
  res.json({
    session, doctor: { ...doctor, languages: parse(doctor.languages, []) },
    projection, current, upcoming, lastNote,
    stats: { seen: done.n, medianMinutes: done.avg ? Math.round(done.avg / MINUTE) : null },
    runningLateMinutes: projection?.runningLateMinutes ?? 0,
    serverNow: now(),
  });
}));

/** Doctor asks for a specific patient next; reception decides. One queue authority. */
router.post('/doctor/request-next', asyncRoute((req, res) => {
  own('token', req.body?.tokenId, req.tenant.clinicId);
  const { token } = queue.requestNext(req.body.tokenId);
  const doctor = db.prepare('SELECT d.name FROM doctors d JOIN sessions s ON s.doctor_id = d.id WHERE s.id = ?').get(token.session_id);
  publish(`clinic:${req.tenant.clinicId}`, {
    type: 'doctor.request', clinicId: req.tenant.clinicId, sessionId: token.session_id, tokenId: token.id,
    display: token.display, doctorName: doctor?.name ?? req.tenant.staff.name, patientName: token.patient_name,
  });
  audit(req, 'doctor.request_next', token.id, {});
  res.json({ ok: true, requested: token.display, token, note: 'Reception can see the request on the board.' });
}));

/** Demo: drive this clinic's evening. Scoped to the tenant like everything else. */
router.post('/demo/run-day', asyncRoute((req, res) => {
  const sessions = db.prepare("SELECT id FROM sessions WHERE clinic_id = ? AND state IN ('scheduled','running','paused')")
    .all(req.tenant.clinicId);
  for (const s of sessions) simulator.enable(s.id, req.body?.config ?? {});
  res.json({ started: sessions.length });
}));
router.post('/demo/stop-day', asyncRoute((req, res) => {
  const mine = new Set(db.prepare('SELECT id FROM sessions WHERE clinic_id = ?').all(req.tenant.clinicId).map((s) => s.id));
  for (const s of simulator.status()) if (mine.has(s.sessionId)) simulator.disable(s.sessionId);
  res.json({ ok: true });
}));
