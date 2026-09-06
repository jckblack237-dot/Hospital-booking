import './setup.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '0';
const { server } = await import('../server/index.js');
const { db } = await import('../server/db.js');
await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const call = async (method, path, token, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
};

const DEMO = {
  "Male' Family Clinic": { slug: 'male-family-clinic', password: 'lagoon-2026', admin: 'ahmed.zahir', receptionist: 'shaira' },
  'Naifaru Health Centre': { slug: 'naifaru-health-centre', password: 'reef-2026', admin: 'mohamed.latheef', receptionist: 'hawwa' },
};
async function signIn(clinicName, role = 'admin') {
  const d = DEMO[clinicName];
  const { body } = await call('POST', '/api/auth/login', null, { username: d[role], password: d.password });
  return { clinic: body.clinic, token: body.token };
}

/** Two clinics. A is Malé, B is the island clinic. Nothing of B's may reach A. */
let A;
let B;
let bSession;
let bToken;
let bPatient;
let bInvoice;
let bClaim;

before(async () => {
  A = await signIn("Male' Family Clinic");
  B = await signIn('Naifaru Health Centre');
  bSession = db.prepare('SELECT id FROM sessions WHERE clinic_id = ? ORDER BY scheduled_start DESC LIMIT 1').get(B.clinic.id);
  bToken = db.prepare('SELECT id FROM tokens WHERE session_id = ?').get(bSession.id);
  bPatient = db.prepare('SELECT patient_id AS id FROM tokens WHERE session_id = ?').get(bSession.id);
  // Give B an invoice and a claim so those routes can be probed too.
  await call('POST', `/api/clinic/sessions/${bSession.id}/start`, B.token);
  await call('POST', `/api/clinic/tokens/${bToken.id}/start`, B.token);
  const ended = await call('POST', `/api/clinic/tokens/${bToken.id}/end`, B.token, { callNext: false });
  bInvoice = ended.body.invoice;
  bClaim = db.prepare('SELECT id FROM claims WHERE invoice_id = ?').get(bInvoice.id);
});

test('nothing on the clinic API works without signing in', async () => {
  for (const path of ['/api/clinic/board', '/api/clinic/patients', '/api/clinic/billing', '/api/clinic/analytics',
    '/api/clinic/messages', '/api/clinic/settings', '/api/clinic/audit']) {
    const { status } = await call('GET', path, null);
    assert.equal(status, 401, path);
  }
});

test('clinics and staff cannot be listed before signing in', async () => {
  assert.equal((await call('GET', '/api/auth/clinics')).status, 404);
  assert.equal((await call('GET', `/api/auth/clinics/${A.clinic.id}/staff`)).status, 404);
  const page = await call('GET', '/api/auth/clinic/male-family-clinic');
  assert.equal(page.status, 200);
  assert.ok(!('id' in page.body) && !('staff' in page.body), 'the sign-in page gets a name, not identities');
  const signIn = await call('GET', '/api/auth/sign-in');
  assert.equal(signIn.status, 200);
  assert.deepEqual(Object.keys(signIn.body), ['demo'], 'the sign-in page itself needs nothing but the demo list');
  assert.equal((await call('GET', '/api/auth/clinic/some-other-clinic')).status, 404);
});

test('a username alone says which clinic you belong to', async () => {
  const male = await call('POST', '/api/auth/login', null, { username: 'shaira', password: 'lagoon-2026' });
  assert.equal(male.status, 200);
  assert.equal(male.body.clinic.name, "Male' Family Clinic");
  const island = await call('POST', '/api/auth/login', null, { username: 'hawwa', password: 'reef-2026' });
  assert.equal(island.status, 200);
  assert.equal(island.body.clinic.name, 'Naifaru Health Centre');
  // Usernames are case-insensitive; the clinic never had to be chosen.
  assert.equal((await call('POST', '/api/auth/login', null, { username: 'SHAIRA', password: 'lagoon-2026' })).status, 200);
});

test("a clinic's own address, if used, accepts only its own accounts", async () => {
  const cross = await call('POST', '/api/auth/clinic/naifaru-health-centre/login', null, { username: 'shaira', password: 'lagoon-2026' });
  assert.equal(cross.status, 401);
  const wrong = await call('POST', '/api/auth/clinic/male-family-clinic/login', null, { username: 'shaira', password: 'reef-2026' });
  assert.equal(wrong.status, 401);
  assert.equal(cross.body.detail, wrong.body.detail, 'same answer whichever part was wrong');
  assert.equal((await call('POST', '/api/auth/clinic/male-family-clinic/login', null, { username: 'shaira', password: 'lagoon-2026' })).status, 200);
});

test('repeated failures lock the account for a while', async () => {
  for (let i = 0; i < 5; i++) {
    await call('POST', '/api/auth/login', null, { username: 'nazima', password: 'nope' });
  }
  const locked = await call('POST', '/api/auth/login', null, { username: 'nazima', password: 'lagoon-2026' });
  assert.equal(locked.status, 429, 'even the right password is refused while locked');
});

test('no response ever carries a password hash or salt', async () => {
  const settings = await call('GET', '/api/clinic/settings', A.token);
  const text = JSON.stringify(settings.body);
  assert.ok(!text.includes('password_hash') && !text.includes('password_salt') && !text.includes('lagoon-2026'));
});

test('an admin can issue a sign-in; the new person can use it; a receptionist cannot issue one', async () => {
  const denied = await call('POST', '/api/clinic/staff', (await signIn("Male' Family Clinic", 'receptionist')).token,
    { name: 'X', username: 'x.y', role: 'receptionist' });
  assert.equal(denied.status, 403);

  const created = await call('POST', '/api/clinic/staff', A.token, { name: 'Mariyam Waheeda', username: 'mariyam.w', role: 'receptionist' });
  assert.equal(created.status, 201);
  assert.match(created.body.password, /^[a-z]+-[a-z]+-\d\d$/, 'a readable generated password, shown once');
  assert.ok(!('password_hash' in created.body.staff));

  const first = await call('POST', '/api/auth/login', null, { username: 'mariyam.w', password: created.body.password });
  assert.equal(first.status, 200);
  assert.equal(first.body.staff.mustChangePassword, true);

  const changed = await call('POST', '/api/auth/change-password', first.body.token, { currentPassword: created.body.password, newPassword: 'my-own-password-1' });
  assert.equal(changed.status, 200);
  const again = await call('POST', '/api/auth/login', null, { username: 'mariyam.w', password: 'my-own-password-1' });
  assert.equal(again.status, 200);
  assert.equal(again.body.staff.mustChangePassword, false);

  // A username identifies one person on the whole platform, so the other
  // clinic cannot create it — and therefore never needs to be chosen at sign-in.
  const other = await call('POST', '/api/clinic/staff', B.token, { name: 'Someone Else', username: 'Mariyam.W', role: 'billing' });
  assert.equal(other.status, 409);
});

test('switching an account off ends its sessions immediately', async () => {
  const created = await call('POST', '/api/clinic/staff', A.token, { name: 'Temp Desk', username: 'temp.desk', role: 'receptionist' });
  const session = await call('POST', '/api/auth/login', null, { username: 'temp.desk', password: created.body.password });
  assert.equal((await call('GET', '/api/clinic/board', session.body.token)).status, 200);
  await call('POST', `/api/clinic/staff/${created.body.staff.id}/active`, A.token, { active: false });
  assert.equal((await call('GET', '/api/clinic/board', session.body.token)).status, 401);
  const relogin = await call('POST', '/api/auth/login', null, { username: 'temp.desk', password: created.body.password });
  assert.equal(relogin.status, 401);
});

test('a clinic cannot be left without an admin, and you cannot switch yourself off', async () => {
  const admins = db.prepare("SELECT id FROM staff WHERE clinic_id = ? AND role = 'admin' AND active = 1").all(A.clinic.id);
  const me = db.prepare("SELECT id FROM staff WHERE clinic_id = ? AND username = 'ahmed.zahir'").get(A.clinic.id);
  assert.equal((await call('POST', `/api/clinic/staff/${me.id}/active`, A.token, { active: false })).status, 400);
  if (admins.length === 1) {
    const created = await call('POST', '/api/clinic/staff', A.token, { name: 'Second Admin', username: 'second.admin', role: 'admin' });
    const second = await call('POST', '/api/auth/login', null, { username: 'second.admin', password: created.body.password });
    const r = await call('POST', `/api/clinic/staff/${created.body.staff.id}/active`, A.token, { active: false });
    assert.equal(r.status, 200, 'with two admins, one can be switched off');
    assert.equal((await call('GET', '/api/clinic/board', second.body.token)).status, 401);
  }
});

test('provisioning gives a new clinic its own address and a first admin', async () => {
  const { provisionClinic } = await import('../server/services/tenancy.js');
  const out = provisionClinic({ name: 'Hulhumalé Medical', island: 'Hulhumale', atoll: 'K', adminName: 'Aishath Nadha', adminUsername: 'aishath.nadha' });
  assert.equal(out.slug, 'hulhumal-medical', 'slug is derived from the name');
  assert.ok(out.signInPath.startsWith('/clinic/'));
  const login = await call('POST', '/api/auth/login', null, { username: 'aishath.nadha', password: out.password });
  assert.equal(login.status, 200);
  assert.equal(login.body.clinic.name, 'Hulhumalé Medical');
  const board = await call('GET', '/api/clinic/board', login.body.token);
  assert.equal(board.status, 200);
  assert.equal(board.body.sessions.length, 0, 'a brand-new clinic has nothing in it — least of all anyone else\'s data');
});

test('the board shows only the signed-in clinic', async () => {
  const a = await call('GET', '/api/clinic/board', A.token);
  const b = await call('GET', '/api/clinic/board', B.token);
  assert.ok(a.body.sessions.length > 0 && b.body.sessions.length > 0);
  assert.ok(a.body.sessions.every((s) => s.clinic_id === A.clinic.id));
  assert.ok(b.body.sessions.every((s) => s.clinic_id === B.clinic.id));
  const aIds = new Set(a.body.sessions.map((s) => s.id));
  assert.ok(!b.body.sessions.some((s) => aIds.has(s.id)), 'no session appears on both boards');
});

test('the clinic id in a query string or body is ignored', async () => {
  const { body } = await call('GET', `/api/clinic/board?clinicId=${B.clinic.id}`, A.token);
  assert.ok(body.sessions.every((s) => s.clinic_id === A.clinic.id), 'the tenant comes from the session, full stop');
});

test("clinic A cannot act on clinic B's sessions", async () => {
  for (const action of ['start', 'pause', 'resume', 'delay', 'cancel', 'broadcast', 'simulate']) {
    const { status } = await call('POST', `/api/clinic/sessions/${bSession.id}/${action}`, A.token, { minutes: 5, text: 'x' });
    assert.equal(status, 404, `sessions/${action} must look non-existent, not forbidden`);
  }
  const { status } = await call('GET', `/api/clinic/sessions/${bSession.id}/broadcast-estimate`, A.token);
  assert.equal(status, 404);
  const doctor = await call('GET', `/api/clinic/doctor/${bSession.id}`, A.token);
  assert.equal(doctor.status, 404);
});

test("clinic A cannot touch clinic B's tokens", async () => {
  const waiting = db.prepare("SELECT id FROM tokens WHERE session_id = ? AND state IN ('booked','arrived') LIMIT 1").get(bSession.id);
  for (const action of ['checkin', 'call', 'start', 'end', 'extend', 'no-show', 'cancel', 'penalty',
    'revoke-penalty', 'reinstate', 'reorder', 'reassign', 'note']) {
    const { status } = await call('POST', `/api/clinic/tokens/${waiting.id}/${action}`, A.token, { note: 'x' });
    assert.equal(status, 404, `tokens/${action}`);
  }
});

test("clinic A cannot book into clinic B's session, even with its own patient", async () => {
  const aPatient = db.prepare('SELECT patient_id AS id FROM clinic_patients WHERE clinic_id = ? LIMIT 1').get(A.clinic.id);
  const { status } = await call('POST', '/api/clinic/tokens', A.token, { sessionId: bSession.id, patientId: aPatient.id });
  assert.equal(status, 404);
});

test("clinic A cannot see clinic B's patients — not by id, not by search", async () => {
  const detail = await call('GET', `/api/clinic/patients/${bPatient.id}`, A.token);
  assert.equal(detail.status, 404);
  const elig = await call('POST', `/api/clinic/patients/${bPatient.id}/eligibility`, A.token);
  assert.equal(elig.status, 404);

  const name = db.prepare('SELECT name, phone FROM patients WHERE id = ?').get(bPatient.id);
  const byName = await call('GET', `/api/clinic/patients?q=${encodeURIComponent(name.name)}`, A.token);
  assert.ok(!byName.body.patients.some((p) => p.id === bPatient.id), 'search must not surface another clinic\'s patient');
  const byPhone = await call('GET', `/api/clinic/patients?q=${encodeURIComponent(name.phone)}`, A.token);
  assert.ok(!byPhone.body.patients.some((p) => p.id === bPatient.id));
});

test('a patient known to both clinics shows each clinic only its own visits', async () => {
  // Fathimath's child was referred from the island clinic and booked in Malé.
  const shared = db.prepare(`SELECT patient_id FROM clinic_patients WHERE clinic_id = ?
                             INTERSECT SELECT patient_id FROM clinic_patients WHERE clinic_id = ?`).get(A.clinic.id, B.clinic.id);
  assert.ok(shared, 'the seed creates at least one patient both clinics know');
  const a = await call('GET', `/api/clinic/patients/${shared.patient_id}`, A.token);
  const b = await call('GET', `/api/clinic/patients/${shared.patient_id}`, B.token);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const aVisitIds = new Set(a.body.visits.map((v) => v.id));
  assert.ok(!b.body.visits.some((v) => aVisitIds.has(v.id)), 'no visit is listed by both clinics');
  assert.ok(a.body.invoices.every((i) => i.clinic_id === A.clinic.id));
  assert.ok(a.body.messages.every((m) => m.clinic_id === A.clinic.id));
});

test("clinic A cannot read or change clinic B's billing", async () => {
  const billing = await call('GET', '/api/clinic/billing', A.token);
  assert.ok(!billing.body.invoices.some((i) => i.id === bInvoice.id));
  assert.ok(!billing.body.worklist.some((c) => c.invoice_id === bInvoice.id));
  const pay = await call('POST', '/api/clinic/billing/payments', A.token, { invoiceId: bInvoice.id, method: 'cash', amountMinor: 1 });
  assert.equal(pay.status, 404);
  if (bClaim) {
    const resubmit = await call('POST', `/api/clinic/billing/claims/${bClaim.id}/resubmit`, A.token);
    assert.equal(resubmit.status, 404);
  }
});

test("clinic A's analytics, messages, settings and audit contain nothing of B's", async () => {
  const analytics = await call('GET', '/api/clinic/analytics', A.token);
  const bDoctors = new Set(db.prepare('SELECT name FROM doctors WHERE clinic_id = ?').all(B.clinic.id).map((d) => d.name));
  assert.ok(!analytics.body.punctuality.some((d) => bDoctors.has(d.name)));
  assert.ok(!analytics.body.today.doctorsRunningLate.some((d) => bDoctors.has(d.name)));

  const messages = await call('GET', '/api/clinic/messages', A.token);
  assert.ok(messages.body.messages.every((m) => m.clinic_id === A.clinic.id));

  const settings = await call('GET', '/api/clinic/settings', A.token);
  assert.equal(settings.body.clinic.id, A.clinic.id);
  assert.ok(settings.body.staff.every((s) => !db.prepare('SELECT 1 FROM staff WHERE id = ? AND clinic_id = ?').get(s.id, B.clinic.id)));

  const audit = await call('GET', '/api/clinic/audit', A.token);
  assert.ok(audit.body.audit.every((a) => a.clinic_id === A.clinic.id));
});

test('a receptionist cannot change clinic settings or partner access; an admin can', async () => {
  const reception = await signIn("Male' Family Clinic", 'receptionist');
  const denied = await call('PUT', '/api/clinic/settings', reception.token, { settings: { tier: 'x' } });
  assert.equal(denied.status, 403);
  const allowed = await call('PUT', '/api/clinic/settings', A.token, { settings: { note: 'ok' } });
  assert.equal(allowed.status, 200);
});

test('signing out invalidates the session immediately', async () => {
  const fresh = await signIn('Naifaru Health Centre', 'receptionist');
  assert.equal((await call('GET', '/api/clinic/board', fresh.token)).status, 200);
  await call('POST', '/api/auth/logout', fresh.token);
  assert.equal((await call('GET', '/api/clinic/board', fresh.token)).status, 401);
});
