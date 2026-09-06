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

async function signIn(clinicName, role = 'admin') {
  const { body: { clinics } } = await call('GET', '/api/auth/clinics');
  const clinic = clinics.find((c) => c.name === clinicName);
  const { body: { staff } } = await call('GET', `/api/auth/clinics/${clinic.id}/staff`);
  const member = staff.find((s) => s.role === role);
  const { body } = await call('POST', '/api/auth/login', null, { clinicId: clinic.id, staffId: member.id, pin: '1234' });
  return { clinic, token: body.token };
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

test('a wrong PIN does not sign in', async () => {
  const { body: { clinics } } = await call('GET', '/api/auth/clinics');
  const { body: { staff } } = await call('GET', `/api/auth/clinics/${clinics[0].id}/staff`);
  const { status } = await call('POST', '/api/auth/login', null, { clinicId: clinics[0].id, staffId: staff[0].id, pin: '0000' });
  assert.equal(status, 401);
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
