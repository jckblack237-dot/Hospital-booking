/** Clinic dashboard API — receptionist board, doctor module, billing, admin. */
import express from 'express';
import { db } from '../db.js';
import { now, MINUTE } from '../lib/clock.js';
import { id, parse, asyncRoute, HttpError } from '../lib/util.js';
import { mvStartOfDay } from '../lib/mvtime.js';
import { readProjection, recompute } from '../engine/engine.js';
import * as queue from '../services/queue.js';
import * as scheduling from '../services/scheduling.js';
import * as billing from '../services/billing.js';
import * as messaging from '../services/messaging.js';
import * as analytics from '../services/analytics.js';
import * as simulator from '../services/simulator.js';

export const router = express.Router();

function audit(clinicId, actor, action, entity, after) {
  db.prepare('INSERT INTO audit (id, clinic_id, actor, action, entity, after, at) VALUES (?,?,?,?,?,?,?)')
    .run(id('aud'), clinicId, actor || 'receptionist', action, entity ?? null,
      after ? JSON.stringify(after).slice(0, 2000) : null, now());
}

const defaultClinic = () => db.prepare('SELECT * FROM clinics ORDER BY rowid LIMIT 1').get();

router.get('/bootstrap', asyncRoute((req, res) => {
  const clinic = req.query.clinicId ? db.prepare('SELECT * FROM clinics WHERE id = ?').get(req.query.clinicId) : defaultClinic();
  if (!clinic) throw HttpError.notFound('Clinic');
  res.json({
    clinic: { ...clinic, settings: parse(clinic.settings, {}) },
    clinics: db.prepare('SELECT id, name, island FROM clinics').all(),
    doctors: db.prepare('SELECT * FROM doctors WHERE clinic_id = ? ORDER BY rowid').all(clinic.id)
      .map((d) => ({ ...d, languages: parse(d.languages, []) })),
    staff: db.prepare('SELECT * FROM staff WHERE clinic_id = ?').all(clinic.id),
    penaltyPolicy: queue.clinicSettings(clinic.id).penalty,
    serverNow: now(),
  });
}));

/** The board: every doctor column, every token, with the live projection merged in. */
router.get('/board', asyncRoute((req, res) => {
  const clinicId = req.query.clinicId || defaultClinic()?.id;
  const day = req.query.day ? Number(req.query.day) : now();
  const sessions = scheduling.sessionsForDay(clinicId, day);
  const out = sessions.map((s) => {
    let projection = readProjection(s.id);
    if (!projection || projection.computedAt < now() - 30_000) {
      projection = recompute(s.id, { notify: false })?.projection ?? projection;
    }
    const tokens = db.prepare(`SELECT t.*, p.name AS patient_name, p.phone, p.language, p.payer_type,
        p.insurer, p.travel_island, p.travel_atoll, p.national_id, p.dob
        FROM tokens t JOIN patients p ON p.id = t.patient_id
        WHERE t.session_id = ? ORDER BY t.seq`).all(s.id).map((t) => {
      const entry = projection?.entries?.find((e) => e.tokenId === t.id) ?? null;
      const eligibility = billing.latestEligibility(t.patient_id);
      return {
        ...t,
        flags: parse(t.flags, []),
        projection: entry,
        eligibility: eligibility ? { result: eligibility.result, detail: eligibility.detail } : null,
        invoice: billing.invoiceForTokenIfAny(t.id),
      };
    });
    return {
      ...s,
      blackouts: db.prepare('SELECT * FROM blackouts WHERE session_id = ? ORDER BY starts_at').all(s.id),
      projection,
      tokens,
      simulating: simulator.status().some((x) => x.sessionId === s.id),
    };
  });
  res.json({ day: mvStartOfDay(day), serverNow: now(), sessions: out });
}));

// ------------------------------------------------------------------ sessions
const sessionAction = (fn) => asyncRoute((req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) throw HttpError.notFound('Session');
  const result = fn(req, session);
  audit(session.clinic_id, req.body?.actor, req.path.split('/').pop(), session.id, req.body);
  res.json({ ok: true, ...(result || {}) });
});

router.post('/sessions/:id/start', sessionAction((req, s) => queue.startSession(s.id, req.body?.actor)));
router.post('/sessions/:id/end', sessionAction((req, s) => { queue.endSession(s.id); queue.renormalise(s.id); }));
router.post('/sessions/:id/pause', sessionAction((req, s) => queue.pauseSession(s.id, {
  kind: req.body?.kind ?? 'break', expectedMinutes: Number(req.body?.expectedMinutes ?? 15),
})));
router.post('/sessions/:id/resume', sessionAction((req, s) => queue.resumeSession(s.id)));
router.post('/sessions/:id/delay', sessionAction((req, s) => queue.delaySession(s.id, Number(req.body?.minutes ?? 15))));
router.post('/sessions/:id/cancel', sessionAction((req, s) => queue.cancelSession(s.id, req.body?.reason)));

router.get('/sessions/:id/broadcast-estimate', asyncRoute((req, res) => {
  res.json(messaging.estimateBroadcast(req.params.id));
}));
router.post('/sessions/:id/broadcast', sessionAction((req, s) =>
  messaging.broadcast({ sessionId: s.id, clinicId: s.clinic_id, text: String(req.body?.text || '').slice(0, 400) })));

router.post('/sessions/:id/simulate', asyncRoute((req, res) => {
  const on = req.body?.enabled !== false;
  if (on) simulator.enable(req.params.id, req.body ?? {});
  else simulator.disable(req.params.id);
  res.json({ ok: true, simulating: on });
}));

// -------------------------------------------------------------------- tokens
router.post('/tokens', asyncRoute((req, res) => {
  const { sessionId, patientId, source = 'walk_in', visitType = 'new', priorityReason = null } = req.body || {};
  if (!sessionId) throw HttpError.badRequest('sessionId is required');
  let pid = patientId;
  if (!pid) {
    const { name, phone, nationalId, language = 'dv', payerType = 'aasandha', travelIsland, travelAtoll } = req.body || {};
    if (!name || !phone) throw HttpError.badRequest('name and phone are required to create a patient');
    const existing = db.prepare('SELECT * FROM patients WHERE phone = ?').get(phone);
    if (existing) {
      pid = existing.id;
    } else {
      pid = id('pat');
      db.prepare(`INSERT INTO patients (id, name, phone, national_id, language, payer_type, travel_island, travel_atoll, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(pid, name, phone, nationalId ?? null, language, payerType, travelIsland ?? null, travelAtoll ?? null, now());
    }
  }
  const token = queue.addToken({ sessionId, patientId: pid, source, visitType, priorityReason });
  billing.checkEligibility(pid);
  const session = db.prepare('SELECT clinic_id FROM sessions WHERE id = ?').get(sessionId);
  audit(session.clinic_id, req.body?.actor, 'token.create', token.id, { source, priorityReason });
  res.status(201).json({ token });
}));

const tokenAction = (fn) => asyncRoute((req, res) => {
  const token = db.prepare('SELECT * FROM tokens WHERE id = ?').get(req.params.id);
  if (!token) throw HttpError.notFound('Token');
  const result = fn(req, token);
  const session = db.prepare('SELECT clinic_id FROM sessions WHERE id = ?').get(token.session_id);
  audit(session?.clinic_id, req.body?.actor, req.path.split('/').pop(), token.id, req.body);
  res.json({ ok: true, ...(result && typeof result === 'object' && !result.projection ? result : {}) });
});

router.post('/tokens/:id/checkin', tokenAction((req, t) => queue.checkIn(t.id)));
router.post('/tokens/:id/call', tokenAction((req, t) => queue.callToken(t.id)));
router.post('/tokens/:id/start', tokenAction((req, t) => queue.startConsult(t.id)));
router.post('/tokens/:id/extend', tokenAction((req, t) => queue.extendConsult(t.id, Number(req.body?.minutes ?? 10))));
router.post('/tokens/:id/no-show', tokenAction((req, t) => queue.markNoShow(t.id)));
router.post('/tokens/:id/cancel', tokenAction((req, t) => queue.cancelToken(t.id, req.body?.by ?? 'clinic')));
router.post('/tokens/:id/penalty', tokenAction((req, t) => queue.applyPenalty(t.id, req.body?.cause ?? 'not_present')));
router.post('/tokens/:id/revoke-penalty', tokenAction((req, t) => queue.revokePenalty(t.id)));
router.post('/tokens/:id/reinstate', tokenAction((req, t) => queue.reinstate(t.id)));
router.post('/tokens/:id/reorder', tokenAction((req, t) => queue.reorder(t.id, {
  afterTokenId: req.body?.afterTokenId ?? null, beforeTokenId: req.body?.beforeTokenId ?? null,
})));
router.post('/tokens/:id/reassign', tokenAction((req, t) => queue.reassign(t.id, req.body?.sessionId)));

router.post('/tokens/:id/end', asyncRoute((req, res) => {
  const token = db.prepare('SELECT * FROM tokens WHERE id = ?').get(req.params.id);
  if (!token) throw HttpError.notFound('Token');
  queue.endConsult(token.id);
  const invoice = billing.invoiceForToken(token.id, req.body?.extraLines ?? []);
  if (req.body?.callNext) {
    const next = db.prepare(`SELECT * FROM tokens WHERE session_id = ?
                             AND state IN ('booked','arrived','called','penalised') ORDER BY seq LIMIT 1`).get(token.session_id);
    if (next) queue.startConsult(next.id);
  }
  res.json({ ok: true, invoice });
}));

router.post('/tokens/:id/note', tokenAction((req, t) => {
  db.prepare('UPDATE tokens SET note = ? WHERE id = ?').run(String(req.body?.note || '').slice(0, 500), t.id);
}));

// ------------------------------------------------------------------ patients
router.get('/patients', asyncRoute((req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const rows = db.prepare(`SELECT * FROM patients WHERE name LIKE ? OR phone LIKE ? OR national_id LIKE ?
                           ORDER BY created_at DESC LIMIT 25`).all(q, q, q);
  res.json({ patients: rows });
}));

router.get('/patients/:id', asyncRoute((req, res) => {
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
  if (!patient) throw HttpError.notFound('Patient');
  res.json({
    patient: { ...patient, notify_prefs: parse(patient.notify_prefs, {}) },
    household: db.prepare('SELECT * FROM patients WHERE household_of = ?').all(patient.id),
    visits: db.prepare(`SELECT t.*, s.scheduled_start, d.name AS doctor_name FROM tokens t
                        JOIN sessions s ON s.id = t.session_id JOIN doctors d ON d.id = s.doctor_id
                        WHERE t.patient_id = ? ORDER BY s.scheduled_start DESC LIMIT 30`).all(patient.id),
    invoices: billing.invoicesForPatient(patient.id),
    messages: messaging.ledgerForPatient(patient.id, 30),
    eligibility: billing.latestEligibility(patient.id),
    referrals: db.prepare('SELECT * FROM referrals WHERE patient_id = ? ORDER BY issued_at DESC').all(patient.id),
  });
}));

router.post('/patients/:id/eligibility', asyncRoute((req, res) => {
  res.json(billing.checkEligibility(req.params.id));
}));

// ------------------------------------------------------------------- billing
router.get('/billing', asyncRoute((req, res) => {
  const clinicId = req.query.clinicId || defaultClinic()?.id;
  const from = req.query.from ? Number(req.query.from) : now() - 30 * 86_400_000;
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
  const clinicId = req.body?.clinicId || defaultClinic()?.id;
  res.json(billing.submitClaims(clinicId));
}));
router.post('/billing/claims/adjudicate', asyncRoute((req, res) => {
  const clinicId = req.body?.clinicId || defaultClinic()?.id;
  res.json(billing.adjudicate(clinicId, Number(req.body?.rejectionRate ?? 0.18)));
}));
router.post('/billing/claims/:id/resubmit', asyncRoute((req, res) => {
  res.json({ claim: billing.resubmitClaim(req.params.id) });
}));
router.post('/billing/payments', asyncRoute((req, res) => {
  const { invoiceId, method, amountMinor } = req.body || {};
  if (!invoiceId || !method) throw HttpError.badRequest('invoiceId and method are required');
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  const payment = billing.takePayment({ invoiceId, method, amountMinor: Number(amountMinor ?? invoice?.patient_minor ?? 0) });
  res.json({ payment });
}));

// ----------------------------------------------------------------- analytics
router.get('/analytics', asyncRoute((req, res) => {
  const clinicId = req.query.clinicId || defaultClinic()?.id;
  const days = Number(req.query.days ?? 30);
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
  const clinicId = req.query.clinicId || defaultClinic()?.id;
  const clinic = db.prepare('SELECT settings FROM clinics WHERE id = ?').get(clinicId);
  res.json({
    messages: messaging.ledgerForClinic(clinicId, 150),
    walletMinor: (parse(clinic?.settings, {}) || {}).messagingWalletMinor ?? 0,
    costs: messaging.CHANNEL_COST_MINOR,
  });
}));

// ------------------------------------------------------------------ settings
router.get('/settings', asyncRoute((req, res) => {
  const clinicId = req.query.clinicId || defaultClinic()?.id;
  const clinic = db.prepare('SELECT * FROM clinics WHERE id = ?').get(clinicId);
  res.json({
    clinic: { ...clinic, settings: parse(clinic.settings, {}) },
    penalty: queue.clinicSettings(clinicId).penalty,
    partners: db.prepare(`SELECT p.id, p.name, pc.enabled, pc.allocation_pct, pc.can_cancel, pc.horizon_days,
                          (SELECT COUNT(*) FROM tokens t WHERE t.partner_id = p.id) AS bookings
                          FROM partners p LEFT JOIN partner_clinic pc ON pc.partner_id = p.id AND pc.clinic_id = ?`)
      .all(clinicId),
  });
}));

router.put('/settings', asyncRoute((req, res) => {
  const clinicId = req.body?.clinicId || defaultClinic()?.id;
  const clinic = db.prepare('SELECT * FROM clinics WHERE id = ?').get(clinicId);
  const settings = { ...(parse(clinic.settings, {}) || {}), ...(req.body?.settings || {}) };
  db.prepare('UPDATE clinics SET settings = ? WHERE id = ?').run(JSON.stringify(settings), clinicId);
  audit(clinicId, req.body?.actor, 'settings.update', clinicId, req.body?.settings);
  res.json({ ok: true, settings });
}));

/**
 * Per-partner control surface. The clinic — not us, and not the partner —
 * grants, caps and revokes access, and revocation takes effect immediately.
 * Without this, no clinic enables the API and the platform strategy stalls.
 */
router.put('/partners/:id', asyncRoute((req, res) => {
  const clinicId = req.body?.clinicId || defaultClinic()?.id;
  const { enabled = false, allocationPct = 20, canCancel = true, horizonDays = 14 } = req.body || {};
  db.prepare(`INSERT INTO partner_clinic (partner_id, clinic_id, enabled, allocation_pct, can_cancel, horizon_days)
              VALUES (?,?,?,?,?,?)
              ON CONFLICT(partner_id, clinic_id) DO UPDATE SET
                enabled = excluded.enabled, allocation_pct = excluded.allocation_pct,
                can_cancel = excluded.can_cancel, horizon_days = excluded.horizon_days`)
    .run(req.params.id, clinicId, enabled ? 1 : 0, allocationPct, canCancel ? 1 : 0, horizonDays);
  audit(clinicId, req.body?.actor, 'partner.update', req.params.id, req.body);
  res.json({ ok: true });
}));

router.get('/audit', asyncRoute((req, res) => {
  const clinicId = req.query.clinicId || defaultClinic()?.id;
  res.json({ audit: db.prepare('SELECT * FROM audit WHERE clinic_id = ? ORDER BY at DESC LIMIT 100').all(clinicId) });
}));

// ------------------------------------------------------------- doctor module
router.get('/doctor/:sessionId', asyncRoute((req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.sessionId);
  if (!session) throw HttpError.notFound('Session');
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
  const lastNote = current ? db.prepare(`SELECT t.note, s.scheduled_start FROM tokens t JOIN sessions s ON s.id = t.session_id
                          WHERE t.patient_id = ? AND t.note IS NOT NULL AND t.id != ? ORDER BY s.scheduled_start DESC LIMIT 1`)
    .get(current.patient_id, current.id) : null;
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
  const token = db.prepare('SELECT * FROM tokens WHERE id = ?').get(req.body?.tokenId);
  if (!token) throw HttpError.notFound('Token');
  const session = db.prepare('SELECT clinic_id FROM sessions WHERE id = ?').get(token.session_id);
  audit(session.clinic_id, 'doctor', 'doctor.request_next', token.id, {});
  res.json({ ok: true, requested: token.display, note: 'Sent to reception for action.' });
}));
