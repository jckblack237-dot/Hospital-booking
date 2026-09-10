/**
 * Queue guards, invoicing, realtime contract.
 *
 * What a receptionist's mis-tap must NOT do (corrupt the board, bill nobody,
 * message a patient 111 times) and what every action must return so the
 * board can update one card in place.
 */
import './setup.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

process.env.PORT = '0';
const { server } = await import('../server/index.js');
const { db } = await import('../server/db.js');
const clock = await import('../server/lib/clock.js');
const { recompute } = await import('../server/engine/engine.js');
const scheduling = await import('../server/services/scheduling.js');

await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

let auth = {};
let staffToken;
let clinicId;
const api = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...auth, ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 || res.status === 304 ? null : await res.json().catch(() => null), res };
};
const post = (path, body = {}, headers) => api('POST', path, body, headers);
const get = (path, headers) => api('GET', path, undefined, headers);

let phoneSeq = 100;
const newPhone = () => `+960 79${String(phoneSeq++).padStart(5, '0')}`;

/** A brand-new session of our own with `n` fresh walk-ins, so no test depends on seed randomness or on another test. */
let doctorCursor = 0;
async function freshSession(n, { start = true } = {}) {
  const doctors = db.prepare('SELECT id FROM doctors WHERE clinic_id = ? ORDER BY rowid').all(clinicId);
  const doctorId = doctors[doctorCursor++ % doctors.length].id;
  const at = clock.now();
  const session = scheduling.createSession({ clinicId, doctorId, start: at - 30 * 60_000, end: at + 150 * 60_000 });
  if (start) await post(`/api/clinic/sessions/${session.id}/start`);
  const tokens = [];
  for (let i = 0; i < n; i++) {
    const { status, body } = await post('/api/clinic/tokens', { sessionId: session.id, name: `Guard ${i} ${phoneSeq}`, phone: newPhone() });
    assert.equal(status, 201);
    tokens.push(body.token);
  }
  return { session, tokens };
}

const tokenRow = (id) => db.prepare('SELECT * FROM tokens WHERE id = ?').get(id);
const events = (tokenId, type) => db.prepare('SELECT COUNT(*) AS n FROM events WHERE token_id = ? AND type = ?').get(tokenId, type).n;

before(async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ahmed.zahir', password: 'lagoon-2026' }),
  });
  const body = await res.json();
  staffToken = body.token;
  clinicId = body.clinic.id;
  auth = { authorization: `Bearer ${staffToken}` };
});

// ------------------------------------------------------------ BE-01 flood
test('a called patient is messaged once, however many times the ticker recomputes', async () => {
  const { session, tokens } = await freshSession(3);
  const [a] = tokens;
  await post(`/api/clinic/tokens/${a.id}/checkin`);
  const called = await post(`/api/clinic/tokens/${a.id}/call`);
  assert.equal(called.status, 200);
  assert.equal(called.body.token.state, 'called');

  const calledMessages = () => db.prepare(`SELECT COUNT(DISTINCT at) AS n FROM messages
                                           WHERE token_id = ? AND template = 'called' AND state = 'delivered'`).get(a.id).n;
  assert.equal(calledMessages(), 1, 'the call itself sends one message');

  for (let i = 0; i < 10; i++) {
    clock.setTime(clock.now() + 1000);
    const { notifications } = recompute(session.id, { trigger: 'tick' });
    assert.ok(!notifications.some((d) => d.rule === 'called'), `tick ${i} must not decide "called" again`);
  }
  assert.equal(calledMessages(), 1, 'ten ticks later the patient still has exactly one "called" message');
  // The clinic pays for at most the primary channel plus the compulsory SMS.
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE token_id = ? AND template = 'called' AND state = 'delivered'`).get(a.id).n;
  assert.ok(rows <= 2, `expected at most 2 delivered rows, saw ${rows}`);
});

test('messaging refuses a repeat of the same template to the same token inside the window', async () => {
  const messaging = await import('../server/services/messaging.js');
  const { tokens } = await freshSession(1);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(tokens[0].patient_id);
  const first = messaging.send({ patient, clinicId, tokenId: tokens[0].id, template: 'next', vars: {} });
  const second = messaging.send({ patient, clinicId, tokenId: tokens[0].id, template: 'next', vars: {} });
  assert.ok(first, 'first send is delivered');
  assert.equal(second, null, 'the repeat is dropped before it costs anything');
});

// ------------------------------------------------- BE-02 token transitions
test('a completed token cannot be called, and the 409 says what to do instead', async () => {
  const { tokens } = await freshSession(2);
  const [a] = tokens;
  await post(`/api/clinic/tokens/${a.id}/checkin`);
  await post(`/api/clinic/tokens/${a.id}/start`);
  const ended = await post(`/api/clinic/tokens/${a.id}/end`, { callNext: false });
  assert.equal(ended.status, 200);
  const { status, body, res } = await post(`/api/clinic/tokens/${a.id}/call`);
  assert.equal(status, 409);
  assert.match(res.headers.get('content-type'), /problem\+json/);
  assert.equal(body.title, 'Invalid transition');
  assert.equal(body.code, 'invalid_transition');
  assert.equal(body.state, 'completed');
  assert.equal(body.action, 'call');
  assert.ok(body.detail.includes(a.display), 'the sentence names the token');
  assert.equal(tokenRow(a.id).state, 'completed', 'nothing changed');
});

test('end on a token that never started is refused; no invoice is raised', async () => {
  const { tokens } = await freshSession(1);
  const [a] = tokens;
  await post(`/api/clinic/tokens/${a.id}/checkin`);
  const { status, body } = await post(`/api/clinic/tokens/${a.id}/end`);
  assert.equal(status, 409);
  assert.match(body.detail, /Start the consultation first/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE token_id = ?').get(a.id).n, 0);
});

test('checking in twice is a 200 no-op with one arrival event', async () => {
  const { tokens } = await freshSession(1);
  const [a] = tokens;
  const first = await post(`/api/clinic/tokens/${a.id}/checkin`);
  assert.equal(first.status, 200);
  assert.equal(first.body.token.state, 'arrived');
  assert.equal(first.body.penalised, false);
  const again = await post(`/api/clinic/tokens/${a.id}/checkin`);
  assert.equal(again.status, 200);
  assert.equal(again.body.noop, true);
  assert.equal(again.body.token.state, 'arrived');
  assert.equal(events(a.id, 'token.arrived'), 1);
});

test('a penalty needs an arrived or called token; a no-show needs reinstating first', async () => {
  const { tokens } = await freshSession(2);
  const [a, b] = tokens;
  assert.equal((await post(`/api/clinic/tokens/${a.id}/penalty`)).status, 409, 'booked cannot be penalised');
  await post(`/api/clinic/tokens/${b.id}/no-show`);
  assert.equal((await post(`/api/clinic/tokens/${b.id}/call`)).status, 409, 'no-show cannot be called');
  const back = await post(`/api/clinic/tokens/${b.id}/reinstate`);
  assert.equal(back.status, 200);
  assert.equal(back.body.token.state, 'arrived');
});

// ----------------------------------------------- BE-12 session transitions
test('session guards: double start, stacked pause, bad kind, end with a patient in the room', async () => {
  const { session, tokens } = await freshSession(1);
  const [a] = tokens;
  assert.equal((await post(`/api/clinic/sessions/${session.id}/start`)).status, 409, 'already running');

  const paused = await post(`/api/clinic/sessions/${session.id}/pause`, { kind: 'prayer', expectedMinutes: 10 });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.session.state, 'paused');
  const twice = await post(`/api/clinic/sessions/${session.id}/pause`, { kind: 'break', expectedMinutes: 5 });
  assert.equal(twice.status, 409);
  assert.match(twice.body.detail, /already paused/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blackouts WHERE session_id = ? AND open_ended = 1').get(session.id).n, 1);
  assert.equal((await post(`/api/clinic/sessions/${session.id}/resume`)).status, 200);

  const badKind = await post(`/api/clinic/sessions/${session.id}/pause`, { kind: '<script>', expectedMinutes: 5 });
  assert.equal(badKind.status, 400);
  assert.equal(badKind.body.field, 'kind');
  const badMinutes = await post(`/api/clinic/sessions/${session.id}/pause`, { kind: 'break', expectedMinutes: -5 });
  assert.equal(badMinutes.status, 400);
  assert.equal((await post(`/api/clinic/sessions/${session.id}/delay`, { minutes: 'abc' })).status, 400);
  assert.equal(db.prepare('SELECT state FROM sessions WHERE id = ?').get(session.id).state, 'running');

  await post(`/api/clinic/tokens/${a.id}/checkin`);
  await post(`/api/clinic/tokens/${a.id}/start`);
  const refused = await post(`/api/clinic/sessions/${session.id}/end`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.currentTokenId, a.id);
  const ended = await post(`/api/clinic/sessions/${session.id}/end`, { completeCurrent: true });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.session.state, 'ended');
  assert.equal(tokenRow(a.id).state, 'completed');
  assert.ok(ended.body.invoice, 'the patient in the room was invoiced');
  assert.equal((await post(`/api/clinic/sessions/${session.id}/start`)).status, 409, 'a finished session stays finished');
  assert.equal((await post(`/api/clinic/sessions/${session.id}/broadcast`, { text: 'hi' })).status, 409);
});

// ------------------------------------------------------ BE-03 invoicing
test('board → checkin → call → start → end produces exactly one invoice; a second end is idempotent', async () => {
  const { tokens } = await freshSession(2);
  const [a] = tokens;
  assert.equal((await post(`/api/clinic/tokens/${a.id}/checkin`)).body.token.state, 'arrived');
  assert.equal((await post(`/api/clinic/tokens/${a.id}/call`)).body.token.state, 'called');
  assert.equal((await post(`/api/clinic/tokens/${a.id}/start`)).body.token.state, 'in_consult');
  const first = await post(`/api/clinic/tokens/${a.id}/end`);
  assert.equal(first.status, 200);
  assert.ok(first.body.invoice?.id);
  assert.equal(first.body.token.state, 'completed');
  assert.ok(first.body.token.invoice, 'the token view carries its invoice');
  const eventsBefore = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;

  const second = await post(`/api/clinic/tokens/${a.id}/end`, { callNext: true });
  assert.equal(second.status, 200);
  assert.equal(second.body.noop, true);
  assert.equal(second.body.invoice.id, first.body.invoice.id, 'same invoice, not a new one');
  assert.equal(second.body.next, null, 'a replayed end calls nobody');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, eventsBefore, 'no new events');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE token_id = ?').get(a.id).n, 1);
});

test('start refuses while another patient is in the room; endCurrent completes and invoices them', async () => {
  const { tokens } = await freshSession(2);
  const [a, b] = tokens;
  await post(`/api/clinic/tokens/${a.id}/checkin`);
  await post(`/api/clinic/tokens/${a.id}/start`);
  const startedAt = tokenRow(a.id).started_at;
  await post(`/api/clinic/tokens/${b.id}/checkin`);
  const refused = await post(`/api/clinic/tokens/${b.id}/start`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.currentDisplay, a.display);
  assert.equal(tokenRow(a.id).started_at, startedAt, 'the timer of the patient in the room did not reset');
  const forced = await post(`/api/clinic/tokens/${b.id}/start`, { endCurrent: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.token.state, 'in_consult');
  assert.equal(forced.body.endedToken.id, a.id);
  assert.ok(forced.body.endedInvoice?.id, 'the auto-ended patient was invoiced');
});

test('the simulator path (queue.endConsult) invoices too', async () => {
  const queue = await import('../server/services/queue.js');
  const { tokens } = await freshSession(1);
  const [a] = tokens;
  queue.checkIn(a.id);
  queue.startConsult(a.id);
  const out = queue.endConsult(a.id);
  assert.ok(out.invoice?.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE token_id = ?').get(a.id).n, 1);
});

test('End & next CALLS the first patient who is present — never starts one still on the way', async () => {
  const { tokens } = await freshSession(3);
  const [a, b, c] = tokens;
  await post(`/api/clinic/tokens/${a.id}/checkin`);
  await post(`/api/clinic/tokens/${a.id}/start`);
  await post(`/api/clinic/tokens/${c.id}/checkin`); // b is still booked, c is here
  const { status, body } = await post(`/api/clinic/tokens/${a.id}/end`, { callNext: true });
  assert.equal(status, 200);
  assert.equal(body.next.id, c.id, 'skips the booked token ahead of them');
  assert.equal(body.next.state, 'called');
  assert.equal(tokenRow(b.id).state, 'booked');
  assert.equal(tokenRow(c.id).state, 'called');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE session_id = ? AND state = 'in_consult'").get(a.session_id).n, 0);
});

// ----------------------------------------------------- BE-05 reassign
test('reassign never reuses a display number, returns the old one and tells the patient', async () => {
  const { session: s1, tokens: t1 } = await freshSession(2);
  const { session: s2, tokens: t2 } = await freshSession(1);
  const moved = t1[1];
  const { status, body } = await post(`/api/clinic/tokens/${moved.id}/reassign`, { sessionId: s2.id });
  assert.equal(status, 200);
  assert.equal(body.previousDisplay, moved.display);
  assert.equal(body.token.session_id, s2.id);
  const maxBefore = Number(t2[0].display.split('-')[1]);
  assert.equal(Number(body.token.display.split('-')[1]), maxBefore + 1, 'display is MAX + 1 in the target session');

  // A new token in the old session must not take the vacated number.
  const { body: added } = await post('/api/clinic/tokens', { sessionId: s1.id, name: 'After Move', phone: newPhone() });
  assert.notEqual(added.token.display, moved.display);
  const displays = db.prepare('SELECT display, COUNT(*) AS n FROM tokens WHERE session_id = ? GROUP BY display HAVING n > 1').all(s1.id);
  assert.deepEqual(displays, [], 'no duplicate display numbers');

  const told = db.prepare("SELECT body FROM messages WHERE token_id = ? AND template = 'reassigned' AND state = 'delivered'").get(moved.id);
  assert.ok(told, 'the patient was messaged');
  assert.ok(told.body.includes(body.token.display) && told.body.includes(moved.display));
});

// ------------------------------------------------------- BE-06 reorder
test('reorder refuses a stale or foreign neighbour and accepts a position', async () => {
  const { tokens } = await freshSession(4);
  const { tokens: other } = await freshSession(1);
  const [a, b, c, d] = tokens;
  const foreign = await post(`/api/clinic/tokens/${d.id}/reorder`, { afterTokenId: other[0].id });
  assert.equal(foreign.status, 409);
  assert.equal(foreign.body.code, 'invalid_reorder');
  await post(`/api/clinic/tokens/${a.id}/checkin`);
  await post(`/api/clinic/tokens/${a.id}/start`);
  const stale = await post(`/api/clinic/tokens/${d.id}/reorder`, { afterTokenId: a.id });
  assert.equal(stale.status, 409, 'the card above was started during the drag');
  assert.equal((await post(`/api/clinic/tokens/${d.id}/reorder`, { afterTokenId: d.id })).status, 409);
  const order = () => db.prepare("SELECT id FROM tokens WHERE session_id = ? AND state IN ('booked','arrived','called','penalised') ORDER BY seq").all(a.session_id).map((r) => r.id);
  assert.deepEqual(order(), [b.id, c.id, d.id], 'refused reorders changed nothing');

  const byPosition = await post(`/api/clinic/tokens/${d.id}/reorder`, { position: 1 });
  assert.equal(byPosition.status, 200);
  assert.deepEqual(byPosition.body.order, [b.id, d.id, c.id]);
  assert.deepEqual(order(), [b.id, d.id, c.id]);
  assert.equal((await post(`/api/clinic/tokens/${d.id}/reorder`, { position: 'x' })).status, 400);
});

// --------------------------------------------------- BE-07 revoke penalty
test('undoing a penalty puts the patient back where they were, and a second undo is refused', async () => {
  const { tokens } = await freshSession(4);
  const [a, b, c] = tokens;
  for (const t of [a, b, c]) await post(`/api/clinic/tokens/${t.id}/checkin`);
  const seqBefore = tokenRow(a.id).seq;
  const penalised = await post(`/api/clinic/tokens/${a.id}/penalty`, { cause: 'not_present' });
  assert.equal(penalised.status, 200);
  assert.equal(penalised.body.token.state, 'penalised');
  assert.ok(tokenRow(a.id).seq > seqBefore, 'moved back');

  const revoked = await post(`/api/clinic/tokens/${a.id}/revoke-penalty`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.token.state, 'arrived');
  assert.equal(tokenRow(a.id).seq, seqBefore, 'restored to the pre-penalty place, not the front');
  assert.equal(tokenRow(a.id).penalty_count, 0);

  const again = await post(`/api/clinic/tokens/${a.id}/revoke-penalty`);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'no_penalty');
});

// ------------------------------------------------- BE-13 / BE-14 create
test('the same patient cannot hold two active tokens in one session unless allowed', async () => {
  const { session } = await freshSession(0);
  const phone = newPhone();
  const first = await post('/api/clinic/tokens', { sessionId: session.id, name: 'Twice Booked', phone });
  assert.equal(first.status, 201);
  assert.deepEqual(first.body.token.flags, [], 'flags come back parsed');
  assert.equal(first.body.token.patient_name, 'Twice Booked');
  const dup = await post('/api/clinic/tokens', { sessionId: session.id, name: 'Twice Booked', phone });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'duplicate_token');
  assert.equal(dup.body.existingTokenId, first.body.token.id);
  assert.equal(dup.body.display, first.body.token.display);
  const allowed = await post('/api/clinic/tokens', { sessionId: session.id, name: 'Twice Booked', phone, allowDuplicate: true });
  assert.equal(allowed.status, 201);
  assert.equal((await post('/api/clinic/tokens', { sessionId: session.id, name: 'X', phone: newPhone(), source: 'carrier_pigeon' })).status, 400);
});

// ------------------------------------------------- BE-15 reads and patients
test('single-token and single-session GETs, and patient edits with a normalised phone', async () => {
  const { session, tokens } = await freshSession(2);
  const one = await get(`/api/clinic/tokens/${tokens[0].id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.token.id, tokens[0].id);
  assert.ok(Array.isArray(one.body.token.flags));
  assert.ok('projection' in one.body.token && 'invoice' in one.body.token && 'eligibility' in one.body.token);

  const s = await get(`/api/clinic/sessions/${session.id}`);
  assert.equal(s.status, 200);
  assert.equal(s.body.session.id, session.id);
  assert.ok(s.body.session.doctor_name);
  assert.equal(typeof s.body.session.simulating, 'boolean');
  assert.ok(s.body.tokens.some((t) => t.id === tokens[1].id));
  assert.equal(s.body.projection.sessionId, session.id);

  const pid = tokens[0].patient_id;
  const edited = await api('PUT', `/api/clinic/patients/${pid}`, { name: 'Aminath Edited', phone: '7770123', language: 'en' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.patient.phone, '+960 777 0123');
  assert.equal(edited.body.patient.name, 'Aminath Edited');
  assert.equal((await api('PUT', `/api/clinic/patients/${pid}`, { phone: '12' })).status, 400);
  assert.equal((await api('PUT', `/api/clinic/patients/${pid}`, { language: 'klingon' })).status, 400);

  const found = await get('/api/clinic/patients?q=7770123');
  assert.ok(found.body.patients.some((p) => p.id === pid), 'digits without spaces find the patient');
  assert.equal((await get('/api/clinic/nope')).status, 404);
  assert.equal((await get('/api/clinic/nope')).body.title, 'Resource not found'.replace('Resource', 'Route'));
});

test('an Idempotency-Key replays the first answer and acts once', async () => {
  const { tokens } = await freshSession(1);
  const [a] = tokens;
  const key = `k-${Date.now()}`;
  const first = await post(`/api/clinic/tokens/${a.id}/checkin`, {}, { 'idempotency-key': key });
  const replay = await post(`/api/clinic/tokens/${a.id}/checkin`, {}, { 'idempotency-key': key });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(replay.res.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(replay.body, first.body);
  assert.equal(events(a.id, 'token.arrived'), 1);
});

test('the board is gzipped and answers 304 to a matching If-None-Match', async () => {
  const res = await fetch(`${base}/api/clinic/board`, { headers: { ...auth, 'accept-encoding': 'gzip' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  const etag = res.headers.get('etag');
  assert.ok(etag, 'an ETag is set');
  const body = await res.json();
  assert.ok(body.sessions.length > 0, 'and the gzipped body decodes');
  const again = await fetch(`${base}/api/clinic/board`, { headers: { ...auth, 'if-none-match': etag } });
  assert.equal(again.status, 304);
});

// --------------------------------------------------------- BE-04 / BE-08 realtime
function connect(channels, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
    const received = [];
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', channels, token }));
      const wait = () => {
        const ack = received.find((m) => m.type === 'subscribed');
        if (ack) resolve({ ws, received, ack });
        else setTimeout(wait, 10);
      };
      wait();
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('clinic channels need a staff token; patient channels do not', async () => {
  const anon = await connect([`clinic:${clinicId}`, 'patient:pat_x'], null);
  assert.deepEqual(anon.ack.channels, ['patient:pat_x']);
  assert.deepEqual(anon.ack.rejected, [`clinic:${clinicId}`]);
  anon.ws.close();
  const other = await connect([`clinic:${clinicId}`], 'not-a-token');
  assert.deepEqual(other.ack.rejected, [`clinic:${clinicId}`]);
  other.ws.close();
  const ok = await connect([`clinic:${clinicId}`], staffToken);
  assert.deepEqual(ok.ack.channels, [`clinic:${clinicId}`]);
  ok.ws.close();
});

test('token.changed on a checkin; ticks but no projection while nothing changes', async () => {
  const { session, tokens } = await freshSession(3);
  const [a] = tokens;
  // Put the clock inside the session so the ticker treats it as live, and
  // nearly freeze it so that no start window crosses a minute boundary.
  clock.setTime(session.scheduled_start + 30 * 60_000);
  clock.setSpeed(0.001);
  try {
    await post(`/api/clinic/tokens/${tokens[1].id}/checkin`);
    await post(`/api/clinic/tokens/${tokens[1].id}/start`);
    const { ws, received } = await connect([`clinic:${clinicId}`], staffToken);

    const before = received.length;
    const res = await post(`/api/clinic/tokens/${a.id}/checkin`);
    assert.equal(res.status, 200);
    await sleep(100);
    const changed = received.slice(before).find((m) => m.type === 'token.changed' && m.token.id === a.id);
    assert.ok(changed, 'the board hears token.changed');
    assert.equal(changed.action, 'checkin');
    assert.equal(changed.previousState, 'booked');
    assert.equal(changed.token.state, 'arrived');
    assert.equal(changed.sessionId, session.id);
    assert.ok(Array.isArray(changed.token.flags));
    const projection = received.slice(before).find((m) => m.type === 'projection' && m.sessionId === session.id);
    assert.ok(projection, 'a state change is material');
    assert.equal(projection.trigger, 'token.arrived');
    assert.ok(projection.changedTokenIds.includes(a.id));
    assert.equal(typeof projection.previousVersion, 'number');
    assert.ok(projection.version > projection.previousVersion);

    const quietFrom = received.length;
    await sleep(5000);
    const quiet = received.slice(quietFrom);
    const ticks = quiet.filter((m) => m.type === 'tick');
    assert.ok(ticks.length >= 3, `expected ticks while the session is live, saw ${ticks.length}`);
    assert.ok(ticks.every((m) => m.clinicId === clinicId && typeof m.serverNow === 'number'));
    assert.deepEqual(quiet.filter((m) => m.type === 'projection'), [], 'no projection while nothing changes');
    const versionBefore = db.prepare('SELECT version FROM sessions WHERE id = ?').get(session.id).version;
    await sleep(1100);
    assert.equal(db.prepare('SELECT version FROM sessions WHERE id = ?').get(session.id).version, versionBefore, 'version does not bump on ticks');
    ws.close();
  } finally {
    clock.setSpeed(1);
    clock.setTime(Date.now());
  }
});

test('session.changed and doctor.request reach the board', async () => {
  const { session, tokens } = await freshSession(1, { start: false });
  const { ws, received } = await connect([`clinic:${clinicId}`], staffToken);
  await post(`/api/clinic/sessions/${session.id}/start`);
  await post(`/api/clinic/tokens/${tokens[0].id}/checkin`);
  const asked = await post('/api/clinic/doctor/request-next', { tokenId: tokens[0].id });
  assert.equal(asked.status, 200);
  await sleep(100);
  const started = received.find((m) => m.type === 'session.changed' && m.session.id === session.id);
  assert.ok(started, 'session.changed arrives');
  assert.equal(started.action, 'start');
  assert.equal(started.session.state, 'running');
  assert.ok(started.session.doctor_name);
  const request = received.find((m) => m.type === 'doctor.request');
  assert.ok(request, 'doctor.request arrives');
  assert.equal(request.tokenId, tokens[0].id);
  assert.equal(request.display, tokens[0].display);
  assert.ok(request.doctorName && request.patientName);
  assert.ok(asked.body.token.flags.includes('doctor_requested'));
  const called = await post(`/api/clinic/tokens/${tokens[0].id}/call`);
  assert.ok(!called.body.token.flags.includes('doctor_requested'), 'the flag clears once acted on');
  ws.close();
});
