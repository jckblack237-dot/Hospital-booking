/**
 * Tenant isolation.
 *
 * Each clinic is a separate CRM. The rules, in order of how much they matter:
 *
 *  1. The tenant comes from the signed-in session, never from the request.
 *  2. Every entity a clinic route touches is checked against that tenant
 *     BEFORE anything is read or changed — and a miss is a 404, not a 403,
 *     because confirming that another clinic's record exists is itself a leak.
 *  3. A clinic can only see patients recorded in `clinic_patients` for it.
 *
 * The reference architecture puts rule 2 in Postgres row-level security as
 * well; here it is enforced in one place so that no route can forget it.
 */
import crypto from 'node:crypto';
import { db } from '../db.js';
import { now } from '../lib/clock.js';
import { HttpError } from '../lib/util.js';

const SESSION_TTL_MS = 14 * 60 * 60 * 1000; // one working day, with margin

export function login({ clinicId, staffId, pin }) {
  const staff = db.prepare('SELECT * FROM staff WHERE id = ? AND clinic_id = ?').get(staffId, clinicId);
  if (!staff || staff.pin !== String(pin ?? '')) throw HttpError.unauthorized('Wrong PIN');
  const token = crypto.randomBytes(24).toString('base64url');
  const at = now();
  db.prepare('INSERT INTO staff_sessions (token, staff_id, clinic_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?,?)')
    .run(token, staff.id, clinicId, at, at + SESSION_TTL_MS, at);
  const clinic = db.prepare('SELECT id, name, island, atoll FROM clinics WHERE id = ?').get(clinicId);
  return { token, staff: { id: staff.id, name: staff.name, role: staff.role }, clinic };
}

export function logout(token) {
  db.prepare('DELETE FROM staff_sessions WHERE token = ?').run(token);
}

/** Express middleware: attaches req.tenant or rejects. */
export function requireStaff(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const session = token ? db.prepare('SELECT * FROM staff_sessions WHERE token = ?').get(token) : null;
    if (!session || session.expires_at < now()) throw HttpError.unauthorized('Please sign in');
    const staff = db.prepare('SELECT id, name, role, clinic_id FROM staff WHERE id = ?').get(session.staff_id);
    if (!staff || staff.clinic_id !== session.clinic_id) throw HttpError.unauthorized('Please sign in');
    db.prepare('UPDATE staff_sessions SET last_seen_at = ? WHERE token = ?').run(now(), token);
    req.tenant = { clinicId: session.clinic_id, staff, token };
    next();
  } catch (err) {
    next(err);
  }
}

const ownership = {
  session: 'SELECT clinic_id FROM sessions WHERE id = ?',
  token: 'SELECT s.clinic_id FROM tokens t JOIN sessions s ON s.id = t.session_id WHERE t.id = ?',
  invoice: 'SELECT clinic_id FROM invoices WHERE id = ?',
  claim: 'SELECT clinic_id FROM claims WHERE id = ?',
  patient: 'SELECT clinic_id FROM clinic_patients WHERE patient_id = ? AND clinic_id = ?',
  doctor: 'SELECT clinic_id FROM doctors WHERE id = ?',
};

/**
 * Assert the tenant owns an entity. Returns nothing; throws a 404 otherwise.
 * Used at the top of every entity route, before any read.
 */
export function own(kind, id, clinicId) {
  const sql = ownership[kind];
  if (!sql) throw new Error(`unknown entity kind: ${kind}`);
  const row = kind === 'patient'
    ? db.prepare(sql).get(id, clinicId)
    : db.prepare(sql).get(id);
  if (!row || row.clinic_id !== clinicId) {
    throw HttpError.notFound(kind[0].toUpperCase() + kind.slice(1));
  }
}

/** Record that a clinic now legitimately knows this patient. Idempotent. */
export function linkPatient(clinicId, patientId) {
  db.prepare('INSERT OR IGNORE INTO clinic_patients (clinic_id, patient_id, first_seen_at) VALUES (?,?,?)')
    .run(clinicId, patientId, now());
}

export function clinicsForLogin() {
  return db.prepare('SELECT id, name, island, atoll FROM clinics ORDER BY rowid').all();
}

export function staffForClinic(clinicId) {
  return db.prepare('SELECT id, name, role FROM staff WHERE clinic_id = ? ORDER BY rowid').all(clinicId);
}
