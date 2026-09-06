/**
 * Tenant isolation and sign-in.
 *
 * Each clinic is a separate CRM with its own sign-in address. The rules, in
 * order of how much they matter:
 *
 *  1. The tenant comes from the signed-in session, never from the request.
 *  2. Every entity a clinic route touches is checked against that tenant
 *     BEFORE anything is read or changed — and a miss is a 404, not a 403,
 *     because confirming that another clinic's record exists is itself a leak.
 *  3. A clinic can only see patients recorded in `clinic_patients` for it.
 *  4. Nothing about a clinic — its existence, its staff — is enumerable
 *     before sign-in. A clinic's sign-in page is reached by its own address.
 *
 * The reference architecture puts rule 2 in Postgres row-level security as
 * well; here it is enforced in one place so that no route can forget it.
 */
import crypto from 'node:crypto';
import { db } from '../db.js';
import { now } from '../lib/clock.js';
import { id, HttpError } from '../lib/util.js';

const SESSION_TTL_MS = 14 * 60 * 60 * 1000; // one working day, with margin
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;            // real time, not the demo clock

// ------------------------------------------------------------------ passwords
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const candidate = crypto.scryptSync(String(password ?? ''), salt, 32);
  const stored = Buffer.from(hash, 'hex');
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

/** A readable, generated first password: three words and a number. */
export function generatePassword() {
  const words = ['lagoon', 'reef', 'dhoni', 'coral', 'atoll', 'island', 'tide', 'sail', 'palm', 'pearl', 'monsoon', 'sandbank'];
  const pick = () => words[crypto.randomInt(words.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(10, 99)}`;
}

export function slugify(name) {
  return String(name).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------- sign-in
export function clinicBySlug(slug) {
  return db.prepare('SELECT id, name, island, atoll, slug, settings FROM clinics WHERE slug = ?').get(slug);
}

function attemptKey(clinicId, username, ip) {
  return `${clinicId}:${username.toLowerCase()}:${ip || ''}`;
}

export function login({ slug, username, password, ip }) {
  const clinic = clinicBySlug(slug);
  // The same answer whether the clinic, the user or the password is wrong.
  const reject = () => HttpError.unauthorized('Wrong username or password');
  if (!clinic || !username) throw reject();

  const key = attemptKey(clinic.id, username, ip);
  const attempt = db.prepare('SELECT * FROM login_attempts WHERE key = ?').get(key);
  if (attempt?.locked_until && attempt.locked_until > Date.now()) {
    throw new HttpError(429, 'locked', 'Too many attempts', `Try again in ${Math.ceil((attempt.locked_until - Date.now()) / 60000)} minutes`);
  }

  const staff = db.prepare('SELECT * FROM staff WHERE clinic_id = ? AND LOWER(username) = LOWER(?)').get(clinic.id, username);
  const ok = staff && staff.active && verifyPassword(password, staff.password_hash, staff.password_salt);
  if (!ok) {
    const failures = (attempt?.failures ?? 0) + 1;
    db.prepare(`INSERT INTO login_attempts (key, failures, locked_until) VALUES (?,?,?)
                ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`)
      .run(key, failures, failures >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : null);
    throw reject();
  }
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);

  const token = crypto.randomBytes(24).toString('base64url');
  const at = now();
  db.prepare('INSERT INTO staff_sessions (token, staff_id, clinic_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?,?)')
    .run(token, staff.id, clinic.id, at, at + SESSION_TTL_MS, at);
  db.prepare('UPDATE staff SET last_login_at = ? WHERE id = ?').run(at, staff.id);
  return {
    token,
    staff: { id: staff.id, name: staff.name, role: staff.role, username: staff.username, mustChangePassword: !!staff.must_change_password },
    clinic: { id: clinic.id, name: clinic.name, island: clinic.island, atoll: clinic.atoll, slug: clinic.slug },
  };
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
    const staff = db.prepare('SELECT id, name, role, username, clinic_id, active FROM staff WHERE id = ?').get(session.staff_id);
    if (!staff || !staff.active || staff.clinic_id !== session.clinic_id) throw HttpError.unauthorized('Please sign in');
    db.prepare('UPDATE staff_sessions SET last_seen_at = ? WHERE token = ?').run(now(), token);
    req.tenant = { clinicId: session.clinic_id, staff, token };
    next();
  } catch (err) {
    next(err);
  }
}

export const requireAdmin = (req, res, next) => {
  if (req.tenant?.staff?.role !== 'admin') return next(HttpError.forbidden('Only a clinic admin can do this'));
  return next();
};

// ------------------------------------------------------------ staff accounts
const PUBLIC_STAFF = 'id, name, role, username, active, must_change_password, created_at, last_login_at';

export function listStaff(clinicId) {
  return db.prepare(`SELECT ${PUBLIC_STAFF} FROM staff WHERE clinic_id = ? ORDER BY rowid`).all(clinicId);
}

export function createStaff({ clinicId, name, role, username, password }) {
  if (!name || !username) throw HttpError.badRequest('name and username are required');
  if (!['receptionist', 'admin', 'billing', 'doctor'].includes(role)) throw HttpError.badRequest('role must be receptionist, admin, billing or doctor');
  if (!/^[a-z0-9._-]{3,32}$/i.test(username)) throw HttpError.badRequest('username: 3–32 letters, digits, dots, dashes or underscores');
  if (db.prepare('SELECT 1 FROM staff WHERE clinic_id = ? AND LOWER(username) = LOWER(?)').get(clinicId, username)) {
    throw HttpError.conflict('username_taken', 'That username is already used at this clinic');
  }
  const initial = password || generatePassword();
  const { hash, salt } = hashPassword(initial);
  const staffId = id('stf');
  db.prepare(`INSERT INTO staff (id, clinic_id, name, role, username, password_hash, password_salt, active, must_change_password, created_at)
              VALUES (?,?,?,?,?,?,?,1,?,?)`)
    .run(staffId, clinicId, name, role, username, hash, salt, password ? 0 : 1, now());
  // The generated password is returned exactly once, to the admin who created
  // the account. It is not stored anywhere in the clear.
  return { staff: db.prepare(`SELECT ${PUBLIC_STAFF} FROM staff WHERE id = ?`).get(staffId), password: password ? null : initial };
}

export function resetPassword(clinicId, staffId) {
  const staff = db.prepare('SELECT id FROM staff WHERE id = ? AND clinic_id = ?').get(staffId, clinicId);
  if (!staff) throw HttpError.notFound('Staff member');
  const password = generatePassword();
  const { hash, salt } = hashPassword(password);
  db.prepare('UPDATE staff SET password_hash = ?, password_salt = ?, must_change_password = 1 WHERE id = ?').run(hash, salt, staffId);
  db.prepare('DELETE FROM staff_sessions WHERE staff_id = ?').run(staffId);
  return { password };
}

export function changeOwnPassword(staffId, currentPassword, newPassword) {
  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(staffId);
  if (!verifyPassword(currentPassword, staff.password_hash, staff.password_salt)) throw HttpError.unauthorized('Current password is wrong');
  if (String(newPassword ?? '').length < 8) throw HttpError.badRequest('New password must be at least 8 characters');
  const { hash, salt } = hashPassword(newPassword);
  db.prepare('UPDATE staff SET password_hash = ?, password_salt = ?, must_change_password = 0 WHERE id = ?').run(hash, salt, staffId);
}

export function setStaffActive(clinicId, staffId, active, actingStaffId) {
  const staff = db.prepare('SELECT id, role FROM staff WHERE id = ? AND clinic_id = ?').get(staffId, clinicId);
  if (!staff) throw HttpError.notFound('Staff member');
  if (staffId === actingStaffId) throw HttpError.badRequest('You cannot deactivate your own account');
  if (!active && staff.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM staff WHERE clinic_id = ? AND role = 'admin' AND active = 1").get(clinicId).n;
    if (admins <= 1) throw HttpError.badRequest('A clinic must keep at least one active admin');
  }
  db.prepare('UPDATE staff SET active = ? WHERE id = ?').run(active ? 1 : 0, staffId);
  if (!active) db.prepare('DELETE FROM staff_sessions WHERE staff_id = ?').run(staffId);
}

// ------------------------------------------------------------- ownership
const ownership = {
  session: 'SELECT clinic_id FROM sessions WHERE id = ?',
  token: 'SELECT s.clinic_id FROM tokens t JOIN sessions s ON s.id = t.session_id WHERE t.id = ?',
  invoice: 'SELECT clinic_id FROM invoices WHERE id = ?',
  claim: 'SELECT clinic_id FROM claims WHERE id = ?',
  patient: 'SELECT clinic_id FROM clinic_patients WHERE patient_id = ? AND clinic_id = ?',
  doctor: 'SELECT clinic_id FROM doctors WHERE id = ?',
};

/** Assert the tenant owns an entity. Throws a 404 otherwise. */
export function own(kind, id, clinicId) {
  const sql = ownership[kind];
  if (!sql) throw new Error(`unknown entity kind: ${kind}`);
  const row = kind === 'patient' ? db.prepare(sql).get(id, clinicId) : db.prepare(sql).get(id);
  if (!row || row.clinic_id !== clinicId) throw HttpError.notFound(kind[0].toUpperCase() + kind.slice(1));
}

/** Record that a clinic now legitimately knows this patient. Idempotent. */
export function linkPatient(clinicId, patientId) {
  db.prepare('INSERT OR IGNORE INTO clinic_patients (clinic_id, patient_id, first_seen_at) VALUES (?,?,?)')
    .run(clinicId, patientId, now());
}

// ------------------------------------------------------------ provisioning
/**
 * How Vaguthu hands a clinic its sign-in: a clinic record, its own address,
 * and one admin account with a generated password shown once.
 */
export function provisionClinic({ name, island, atoll, address, phone, adminName, adminUsername, settings = {} }) {
  if (!name || !adminName || !adminUsername) throw HttpError.badRequest('name, adminName and adminUsername are required');
  let slug = slugify(name);
  let n = 2;
  while (db.prepare('SELECT 1 FROM clinics WHERE slug = ?').get(slug)) slug = `${slugify(name)}-${n++}`;
  const clinicId = id('cln');
  db.prepare('INSERT INTO clinics (id, name, atoll, island, address, phone, settings, slug) VALUES (?,?,?,?,?,?,?,?)')
    .run(clinicId, name, atoll ?? null, island ?? null, address ?? null, phone ?? null,
      JSON.stringify({ messagingWalletMinor: 0, ...settings }), slug);
  const admin = createStaff({ clinicId, name: adminName, role: 'admin', username: adminUsername });
  return { clinicId, slug, signInPath: `/clinic/${slug}/`, admin: admin.staff, password: admin.password };
}
