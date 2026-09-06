/** Patient app API (B2C). A thin client over the same engine the clinic uses. */
import express from 'express';
import { db } from '../db.js';
import { now, MINUTE } from '../lib/clock.js';
import { id, parse, asyncRoute, HttpError } from '../lib/util.js';
import { readProjection, recompute } from '../engine/engine.js';
import * as queue from '../services/queue.js';
import * as scheduling from '../services/scheduling.js';
import * as billing from '../services/billing.js';
import * as messaging from '../services/messaging.js';
import { route as routeSymptom, SPECIALTY_LABELS, LANGUAGE_LABELS } from '../services/symptom-router.js';

export const router = express.Router();

function patientOr404(patientId) {
  const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
  if (!p) throw HttpError.notFound('Patient');
  return p;
}

/** Demo identity. Real builds use eFaas OIDC (assumption A2) with phone-OTP fallback. */
router.get('/personas', asyncRoute((req, res) => {
  const rows = db.prepare(`SELECT * FROM patients WHERE name IN
      ('Aishath Shifa','Fathimath Rasheedha') ORDER BY name`).all();
  res.json({
    personas: rows.map((p) => ({
      id: p.id, name: p.name, travelIsland: p.travel_island, language: p.language,
      blurb: p.travel_island
        ? `From ${p.travel_island}, travelling for a paediatric appointment`
        : 'Office worker in Male\', lives in Hulhumale\'',
    })),
    note: 'Demo sign-in. Production uses eFaas (A2) with phone + OTP fallback.',
  });
}));

router.get('/me', asyncRoute((req, res) => {
  const p = patientOr404(req.query.patientId);
  res.json({
    patient: { ...p, notify_prefs: parse(p.notify_prefs, {}) },
    household: db.prepare('SELECT * FROM patients WHERE household_of = ?').all(p.id),
    unread: db.prepare('SELECT COUNT(*) AS c FROM messages WHERE patient_id = ? AND read_at IS NULL').get(p.id).c,
    serverNow: now(),
  });
}));

router.put('/preferences', asyncRoute((req, res) => {
  const p = patientOr404(req.body?.patientId);
  const prefs = { ...(parse(p.notify_prefs, {}) || {}), ...(req.body?.notifyPrefs || {}) };
  db.prepare('UPDATE patients SET notify_prefs = ?, wait_location = ?, travel_minutes = ?, language = ? WHERE id = ?')
    .run(JSON.stringify(prefs), req.body?.waitLocation ?? p.wait_location,
      Number(req.body?.travelMinutes ?? p.travel_minutes), req.body?.language ?? p.language, p.id);
  // Where the patient is waiting changes the leave-now threshold, so republish.
  const active = db.prepare(`SELECT DISTINCT session_id FROM tokens WHERE patient_id = ?
                             AND state IN ('booked','arrived','called','penalised')`).all(p.id);
  for (const a of active) recompute(a.session_id, { notify: false });
  res.json({ ok: true, notifyPrefs: prefs });
}));

// ----------------------------------------------------------------- discovery
router.get('/symptom', asyncRoute((req, res) => {
  const result = routeSymptom(req.query.q);
  res.json({ ...result, labels: SPECIALTY_LABELS, disclaimer: 'This suggests which kind of doctor treats this. It is not medical advice or a diagnosis.' });
}));

router.get('/search', asyncRoute((req, res) => {
  const { specialty, language, payer, gender, region, availability } = req.query;
  let sql = `SELECT d.*, c.name AS clinic_name, c.island, c.atoll, c.id AS clinic_id
             FROM doctors d JOIN clinics c ON c.id = d.clinic_id WHERE 1=1`;
  const args = [];
  if (specialty) { sql += ' AND d.specialty = ?'; args.push(specialty); }
  if (gender) { sql += ' AND d.gender = ?'; args.push(gender); }
  if (region === 'male') sql += " AND c.island IN ('Male','Hulhumale','Vilimale')";
  if (region === 'atoll') sql += " AND c.island NOT IN ('Male','Hulhumale','Vilimale')";

  let rows = db.prepare(sql).all(...args).map((d) => ({ ...d, languages: parse(d.languages, []), accepts_payers: parse(d.accepts_payers, []) }));
  if (language) rows = rows.filter((d) => d.languages.includes(language));
  if (payer) rows = rows.filter((d) => d.accepts_payers.includes(payer));

  const at = now();
  rows = rows.map((d) => ({ ...d, next_available: scheduling.nextAvailable(d.id, at) }));
  if (availability === 'today') {
    const endOfDay = at + 12 * 3_600_000;
    rows = rows.filter((d) => d.next_available && d.next_available.starts_at < endOfDay);
  }
  // Availability first, then proximity. No paid placement — in a market this
  // small a visible pay-to-play ranking would burn trust for rounding-error revenue.
  rows.sort((a, b) => (a.next_available?.starts_at ?? Infinity) - (b.next_available?.starts_at ?? Infinity));
  res.json({ doctors: rows, labels: { specialty: SPECIALTY_LABELS, language: LANGUAGE_LABELS } });
}));

router.get('/doctors/:id', asyncRoute((req, res) => {
  const d = db.prepare(`SELECT d.*, c.name AS clinic_name, c.island, c.atoll, c.address, c.id AS clinic_id
                        FROM doctors d JOIN clinics c ON c.id = d.clinic_id WHERE d.id = ?`).get(req.params.id);
  if (!d) throw HttpError.notFound('Doctor');
  const at = now();
  const stats = db.prepare(`SELECT AVG(ended_at - started_at) AS avg FROM tokens t JOIN sessions s ON s.id = t.session_id
                            WHERE s.doctor_id = ? AND t.state = 'completed'`).get(d.id);
  res.json({
    doctor: {
      ...d, languages: parse(d.languages, []), accepts_payers: parse(d.accepts_payers, []),
      // Rounded, low-resolution, and NEVER punctuality. A commitment made to
      // doctors in the clinic product; if it leaks here it is worthless.
      typical_consultation_minutes: stats.avg ? Math.round(stats.avg / MINUTE) : d.slot_minutes,
    },
    availability: scheduling.availability(d.id, at, at + 14 * 86_400_000),
  });
}));

// ------------------------------------------------------------------- booking
router.post('/holds', asyncRoute((req, res) => {
  const { sessionId, slotIndex } = req.body || {};
  const hold = scheduling.createHold({ sessionId, slotIndex: Number(slotIndex) });
  if (!hold) {
    throw HttpError.conflict('slot_unavailable', 'That slot was just taken', {
      alternatives: scheduling.slotsForSession(db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId))
        .slots.filter((s) => s.status === 'available').slice(0, 3),
    });
  }
  res.status(201).json(hold);
}));

router.post('/bookings', asyncRoute((req, res) => {
  const { holdId, patientId, forPatientId, visitType = 'new', referralId = null, waitLocation, travelMinutes } = req.body || {};
  const hold = scheduling.consumeHold(holdId);
  if (!hold) throw HttpError.conflict('hold_expired', 'That hold has expired. Please pick a slot again.');
  const subject = patientOr404(forPatientId || patientId);
  if (waitLocation) {
    db.prepare('UPDATE patients SET wait_location = ?, travel_minutes = ? WHERE id = ?')
      .run(waitLocation, Number(travelMinutes ?? subject.travel_minutes), subject.id);
  }
  const token = queue.addToken({
    sessionId: hold.session_id, patientId: subject.id, source: 'app', visitType,
  });
  if (referralId) db.prepare('UPDATE referrals SET used_token_id = ? WHERE id = ?').run(token.id, referralId);
  const eligibility = billing.checkEligibility(subject.id);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(hold.session_id);
  const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(session.doctor_id);
  messaging.send({
    patient: subject, clinicId: session.clinic_id, tokenId: token.id, template: 'token_confirmed',
    vars: { doctor: doctor.name, when: new Date(session.scheduled_start + 5 * 3_600_000).toISOString().slice(11, 16) },
  });
  res.status(201).json({ booking: token, eligibility, feeMinor: doctor.fee_minor });
}));

router.get('/bookings', asyncRoute((req, res) => {
  const p = patientOr404(req.query.patientId);
  const household = db.prepare('SELECT id FROM patients WHERE household_of = ?').all(p.id).map((r) => r.id);
  const ids = [p.id, ...household];
  const rows = db.prepare(`SELECT t.*, s.scheduled_start, s.state AS session_state, s.id AS session_id,
      d.name AS doctor_name, d.specialty, c.name AS clinic_name, c.address, pa.name AS patient_name
      FROM tokens t JOIN sessions s ON s.id = t.session_id JOIN doctors d ON d.id = s.doctor_id
      JOIN clinics c ON c.id = s.clinic_id JOIN patients pa ON pa.id = t.patient_id
      WHERE t.patient_id IN (${ids.map(() => '?').join(',')})
      ORDER BY s.scheduled_start DESC LIMIT 40`).all(...ids);
  const active = rows.filter((r) => ['booked', 'arrived', 'called', 'in_consult', 'penalised'].includes(r.state));
  const past = rows.filter((r) => !['booked', 'arrived', 'called', 'in_consult', 'penalised'].includes(r.state));
  res.json({ active, past, serverNow: now() });
}));

/** The live tracker. Everything the app's main screen renders. */
router.get('/bookings/:id/track', asyncRoute((req, res) => {
  const token = db.prepare(`SELECT t.*, s.id AS session_id, s.state AS session_state, s.scheduled_start, s.scheduled_end,
      d.name AS doctor_name, d.specialty, c.name AS clinic_name, c.address, c.phone AS clinic_phone
      FROM tokens t JOIN sessions s ON s.id = t.session_id JOIN doctors d ON d.id = s.doctor_id
      JOIN clinics c ON c.id = s.clinic_id WHERE t.id = ?`).get(req.params.id);
  if (!token) throw HttpError.notFound('Booking');
  let projection = readProjection(token.session_id);
  if (!projection || projection.computedAt < now() - 20_000) {
    projection = recompute(token.session_id, { notify: false })?.projection ?? projection;
  }
  const entry = projection?.entries?.find((e) => e.tokenId === token.id) ?? null;
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(token.patient_id);
  res.json({
    token: { ...token, flags: parse(token.flags, []) },
    patient: { id: patient.id, name: patient.name, waitLocation: patient.wait_location, travelMinutes: patient.travel_minutes },
    entry,
    nowServing: projection?.nowServing ?? null,
    sessionState: projection?.state ?? token.session_state,
    pause: projection?.pause ?? null,
    runningLateMinutes: projection?.runningLateMinutes ?? 0,
    invoice: billing.invoiceForTokenIfAny(token.id),
    serverNow: now(),
    version: projection?.version ?? 0,
  });
}));

router.post('/bookings/:id/on-my-way', asyncRoute((req, res) => {
  queue.onMyWay(req.params.id);
  res.json({ ok: true });
}));
router.post('/bookings/:id/check-in', asyncRoute((req, res) => {
  queue.checkIn(req.params.id);
  res.json({ ok: true });
}));
router.post('/bookings/:id/cancel', asyncRoute((req, res) => {
  queue.cancelToken(req.params.id, 'patient');
  res.json({ ok: true });
}));

// -------------------------------------------------------------------- wallet
router.get('/wallet', asyncRoute((req, res) => {
  const p = patientOr404(req.query.patientId);
  const household = db.prepare('SELECT * FROM patients WHERE household_of = ?').all(p.id);
  const ids = [p.id, ...household.map((h) => h.id)];
  res.json({
    identity: {
      name: p.name, nationalId: p.national_id, dob: p.dob,
      efaasVerified: !!p.efaas_verified,
      note: p.efaas_verified ? 'Verified via eFaas' : 'Not verified — reception will check at your next visit',
    },
    cover: {
      payer: p.payer_type, insurer: p.insurer, policyNo: p.policy_no,
      latest: billing.latestEligibility(p.id),
    },
    household: household.map((h) => ({ id: h.id, name: h.name, relation: h.relation, dob: h.dob, payer: h.payer_type })),
    referrals: db.prepare(`SELECT * FROM referrals WHERE patient_id IN (${ids.map(() => '?').join(',')})
                           ORDER BY issued_at DESC`).all(...ids),
    invoices: ids.flatMap((pid) => billing.invoicesForPatient(pid)).slice(0, 20),
    claims: db.prepare(`SELECT c.* FROM claims c JOIN invoices i ON i.id = c.invoice_id
                        WHERE i.patient_id IN (${ids.map(() => '?').join(',')}) ORDER BY c.submitted_at DESC LIMIT 20`).all(...ids),
  });
}));

// -------------------------------------------------------------- notifications
router.get('/messages', asyncRoute((req, res) => {
  const p = patientOr404(req.query.patientId);
  res.json({ messages: messaging.ledgerForPatient(p.id, 60).filter((m) => m.state === 'delivered') });
}));

router.post('/messages/read', asyncRoute((req, res) => {
  db.prepare('UPDATE messages SET read_at = ? WHERE patient_id = ? AND read_at IS NULL').run(now(), req.body?.patientId);
  res.json({ ok: true });
}));
