import './setup.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '0';
const { server } = await import('../server/index.js');
const { db } = await import('../server/db.js');

await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
const base = `http://127.0.0.1:${server.address().port}`;

after(() => server.close());

const get = async (path, headers) => {
  const res = await fetch(base + path, { headers });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null), res };
};
const post = async (path, body, headers = {}) => {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null), res };
};

async function partnerToken(clientId, clientSecret) {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  const body = await res.json();
  return body.access_token;
}

let clinicId;
let token;

async function setAllocation(pct) {
  const partner = db.prepare("SELECT id FROM partners WHERE client_id = 'pk_demo_dhoni'").get();
  await fetch(`${base}/api/clinic/partners/${partner.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clinicId, enabled: true, allocationPct: pct }),
  });
}

before(async () => {
  clinicId = (await get('/api/demo/state')).body.clinicId;
  token = await partnerToken('pk_demo_dhoni', 'sk_demo_dhoni_secret');
  assert.ok(token, 'partner should authenticate');
  // Give the partner headroom up front so only the dedicated cap test depends
  // on the allocation value, whatever order the tests run in.
  await setAllocation(60);
});

// ------------------------------------------------------------------- clinic
test('the board merges every booking source into one ordered queue', async () => {
  const { body } = await get(`/api/clinic/board?clinicId=${clinicId}`);
  assert.ok(body.sessions.length > 0);
  const session = body.sessions[0];
  const sources = new Set(session.tokens.map((t) => t.source));
  assert.ok(sources.size >= 2, `expected a mix of sources, saw ${[...sources]}`);
  const seqs = session.tokens.map((t) => t.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'tokens come back in queue order');
});

test('a walk-in is issued a token and joins the queue', async () => {
  const { body: board } = await get(`/api/clinic/board?clinicId=${clinicId}`);
  const session = board.sessions[0];
  const before = session.tokens.length;
  const { status, body } = await post('/api/clinic/tokens', {
    sessionId: session.id, source: 'walk_in', name: 'Test Walkin', phone: '+9607779999', visitType: 'new',
  });
  assert.equal(status, 201);
  assert.match(body.token.display, /^[A-Z]-\d\d$/);
  const { body: after } = await get(`/api/clinic/board?clinicId=${clinicId}`);
  assert.equal(after.sessions[0].tokens.length, before + 1);
});

test('drag-and-drop reordering is a single-row fractional-rank update', async () => {
  const { body: board } = await get(`/api/clinic/board?clinicId=${clinicId}`);
  const session = board.sessions[0];
  const waiting = session.tokens.filter((t) => ['booked', 'arrived'].includes(t.state));
  const moved = waiting[3];
  const target = waiting[0];
  const seqsBefore = new Map(session.tokens.map((t) => [t.id, t.seq]));

  const { status } = await post(`/api/clinic/tokens/${moved.id}/reorder`, { beforeTokenId: target.id });
  assert.equal(status, 200);

  const { body: after } = await get(`/api/clinic/board?clinicId=${clinicId}`);
  const rows = after.sessions[0].tokens;
  const changed = rows.filter((t) => seqsBefore.get(t.id) !== t.seq);
  assert.equal(changed.length, 1, 'exactly one row may change, whatever the queue length');
  assert.equal(changed[0].id, moved.id);
  const order = rows.filter((t) => ['booked', 'arrived'].includes(t.state)).map((t) => t.id);
  assert.ok(order.indexOf(moved.id) < order.indexOf(target.id), 'moved token now sits ahead');
});

test('a travel-flagged patient is never silently demoted', async () => {
  const { body: board } = await get(`/api/clinic/board?clinicId=${clinicId}`);
  const session = board.sessions.find((s) => s.tokens.some((t) => t.flags.includes('travel')));
  if (!session) return; // seed randomness: no traveller in today's queue
  const traveller = session.tokens.find((t) => t.flags.includes('travel') && t.state !== 'completed');
  const seqBefore = traveller.seq;
  await post(`/api/clinic/tokens/${traveller.id}/penalty`, { cause: 'not_present' });
  const { body: after } = await get(`/api/clinic/board?clinicId=${clinicId}`);
  const now = after.sessions.flatMap((s) => s.tokens).find((t) => t.id === traveller.id);
  assert.equal(now.seq, seqBefore, 'position must not change');
  assert.notEqual(now.state, 'penalised');
  assert.ok(now.flags.includes('needs_decision'), 'it is escalated to a human instead');
});

test('starting a consultation produces a live projection with a window', async () => {
  const { body: board } = await get(`/api/clinic/board?clinicId=${clinicId}`);
  const session = board.sessions[1];
  await post(`/api/clinic/sessions/${session.id}/start`, {});
  const next = session.tokens.find((t) => ['booked', 'arrived'].includes(t.state));
  await post(`/api/clinic/tokens/${next.id}/start`, {});

  const { body: after } = await get(`/api/clinic/board?clinicId=${clinicId}`);
  const s = after.sessions.find((x) => x.id === session.id);
  assert.equal(s.projection.nowServing.display, next.display);
  for (const entry of s.projection.entries) {
    const w = entry.predictedStart.window;
    assert.ok(w.to >= w.from, 'window must not be inverted');
    assert.ok(['high', 'medium', 'low'].includes(entry.predictedStart.confidence));
  }
});

test('ending a consultation raises an invoice with the payer split applied', async () => {
  const { body: board } = await get(`/api/clinic/board?clinicId=${clinicId}`);
  const s = board.sessions.find((x) => x.tokens.some((t) => t.state === 'in_consult'));
  const current = s.tokens.find((t) => t.state === 'in_consult');
  const { body } = await post(`/api/clinic/tokens/${current.id}/end`, { callNext: false });
  assert.ok(body.invoice, 'an invoice is raised');
  assert.equal(body.invoice.total_minor, body.invoice.covered_minor + body.invoice.patient_minor - body.invoice.gst_minor);
});

// ------------------------------------------------------------------ partner
test('partner discovery is limited to clinics that enabled the integration', async () => {
  const { body } = await get('/v1/clinics', { authorization: `Bearer ${token}` });
  assert.ok(body.data.length >= 1);
  assert.ok(body.data.every((c) => c.id === clinicId));
});

test('the doctor resource never exposes punctuality', async () => {
  const { body: doctors } = await get(`/v1/clinics/${clinicId}/doctors`, { authorization: `Bearer ${token}` });
  const d = doctors.data[0];
  const serialised = JSON.stringify(d).toLowerCase();
  for (const leak of ['late', 'punctual', 'delay', 'overrun', 'start_delay']) {
    assert.ok(!serialised.includes(leak), `partner payload leaked "${leak}"`);
  }
  assert.ok(typeof d.typical_consultation_minutes === 'number');
});

/** Find any doctor with a genuinely free slot; seeded queues fill some sessions. */
async function findFreeSlot(skip = 0) {
  const { body: doctors } = await get(`/v1/clinics/${clinicId}/doctors`, { authorization: `Bearer ${token}` });
  let seen = 0;
  for (const d of doctors.data) {
    const { body: avail } = await get(`/v1/doctors/${d.id}/availability?from=2026-01-01&to=2030-01-01`,
      { authorization: `Bearer ${token}` });
    for (const session of avail.sessions ?? []) {
      for (const slot of session.slots) {
        if (slot.status !== 'available') continue;
        if (seen++ < skip) continue;
        return { doctor: d, session, slot };
      }
    }
  }
  throw new Error('no bookable slot in the seeded schedule');
}

test('two-phase booking prevents a double-book and offers alternatives', async () => {
  const { slot } = await findFreeSlot();
  assert.ok(slot, 'the seeded schedule must leave bookable headroom');

  const first = await post('/v1/holds', { slot_id: slot.slot_id },
    { authorization: `Bearer ${token}`, 'idempotency-key': `k-${Date.now()}` });
  assert.equal(first.status, 201);

  const second = await post('/v1/holds', { slot_id: slot.slot_id },
    { authorization: `Bearer ${token}`, 'idempotency-key': `k2-${Date.now()}` });
  assert.equal(second.status, 409);
  assert.equal(second.body.type, 'https://docs.vaguthu.mv/errors/slot_unavailable');
  assert.ok(Array.isArray(second.body.alternatives), 'a 409 must offer the next slots');

  const booking = await post('/v1/bookings', {
    hold_id: first.body.hold_id,
    patient: { name: 'API Patient', phone: `+96077${Math.floor(Math.random() * 100000)}`, national_id: 'A555001' },
    visit_type: 'new', payer: { type: 'aasandha' },
  }, { authorization: `Bearer ${token}`, 'idempotency-key': `b-${Date.now()}` });
  assert.equal(booking.status, 201);
  assert.equal(booking.body.status, 'confirmed');
  assert.ok(booking.body.predicted_start.p80_window.from);
  assert.match(booking.body.predicted_start.p50, /\+05:00$/, 'timestamps carry the Maldives offset');
});

test('the clinic can cap how much of a session a partner may sell', async () => {
  await setAllocation(5);
  const { slot } = await findFreeSlot();
  // Five per cent of a three-hour session is one or two slots, and the seeded
  // partner bookings have already used them.
  const { status, body } = await post('/v1/holds', { slot_id: slot.slot_id },
    { authorization: `Bearer ${token}`, 'idempotency-key': `cap-${Date.now()}` });
  assert.equal(status, 409);
  assert.equal(body.type, 'https://docs.vaguthu.mv/errors/allocation_exhausted');
  await setAllocation(60);
});

test('idempotency replays the original response instead of double-booking', async () => {
  await setAllocation(60);
  const { slot } = await findFreeSlot(3);
  const key = `idem-${Date.now()}`;
  const a = await post('/v1/holds', { slot_id: slot.slot_id }, { authorization: `Bearer ${token}`, 'idempotency-key': key });
  const b = await post('/v1/holds', { slot_id: slot.slot_id }, { authorization: `Bearer ${token}`, 'idempotency-key': key });
  assert.equal(a.body.hold_id, b.body.hold_id);
  assert.equal(b.status, 200, 'a replay is not a new creation');
});

test('queue state is positional for everyone and detailed only for your own bookings', async () => {
  const row = db.prepare("SELECT session_id, id FROM tokens WHERE partner_id IS NOT NULL LIMIT 1").get();
  const { body } = await get(`/v1/sessions/${row.session_id}/queue`, { authorization: `Bearer ${token}` });
  assert.ok('tokens_waiting' in body);
  assert.ok(body.your_bookings.every((b) => b.booking_id));
  const total = db.prepare('SELECT COUNT(*) AS c FROM tokens WHERE session_id = ?').get(row.session_id).c;
  assert.ok(body.your_bookings.length < total, 'a partner never sees every patient in the session');
  if (body.now_serving) {
    assert.deepEqual(Object.keys(body.now_serving).sort(), ['display', 'started_at'],
      'now_serving is a token code, never an identity');
  }
});

test("a partner cannot read another partner's booking", async () => {
  const other = db.prepare("SELECT id FROM tokens WHERE partner_id IS NULL LIMIT 1").get();
  const { status } = await get(`/v1/bookings/${other.id}`, { authorization: `Bearer ${token}` });
  assert.equal(status, 404);
});

test('an unauthenticated call is rejected', async () => {
  const { status } = await get('/v1/clinics');
  assert.equal(status, 401);
});

test('revoking a partner takes effect immediately', async () => {
  const partner = db.prepare("SELECT id FROM partners WHERE client_id = 'pk_demo_dhoni'").get();
  await fetch(`${base}/api/clinic/partners/${partner.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clinicId, enabled: false }),
  });
  const { body } = await get('/v1/clinics', { authorization: `Bearer ${token}` });
  assert.equal(body.data.length, 0, 'the clinic disappears from the partner the moment it is revoked');

  await fetch(`${base}/api/clinic/partners/${partner.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clinicId, enabled: true, allocationPct: 20 }),
  });
});

test('webhook subscription returns a signing secret exactly once', async () => {
  const { status, body } = await post('/v1/webhook_endpoints',
    { url: 'https://partner.example/hooks', events: ['queue.token.leave_now', 'queue.session.delayed'] },
    { authorization: `Bearer ${token}` });
  assert.equal(status, 201);
  assert.match(body.signing_secret, /^whsec_/);
  const list = await get('/v1/webhook_endpoints', { authorization: `Bearer ${token}` });
  assert.ok(list.body.data.every((e) => !('secret' in e) && !('signing_secret' in e)));
});

test('an unknown webhook event type is rejected rather than silently ignored', async () => {
  const { status } = await post('/v1/webhook_endpoints',
    { url: 'https://partner.example/hooks', events: ['queue.token.made_up'] },
    { authorization: `Bearer ${token}` });
  assert.equal(status, 422);
});

// ------------------------------------------------------------------ patient
test('the symptom router intercepts red flags before offering a booking', async () => {
  const { body } = await get('/api/patient/symptom?q=severe%20chest%20pain');
  assert.ok(body.emergency, 'chest pain must surface emergency guidance');
  assert.ok(body.emergency.number);
  const serialised = JSON.stringify(body).toLowerCase();
  // It routes to a kind of doctor. It never names a condition.
  for (const word in { 'heart attack': 1, angina: 1, 'you may have': 1 }) {
    assert.ok(!serialised.includes(word), `router named a condition: ${word}`);
  }
});

test('the symptom router fails to breadth, never to a guess', async () => {
  const { body } = await get('/api/patient/symptom?q=zzzz%20nonsense%20qqq');
  assert.equal(body.matched, false);
  assert.deepEqual(body.specialties, ['general_practice']);
});

test('discovery filters by language, which is load-bearing in this market', async () => {
  const { body } = await get('/api/patient/search?language=bn');
  assert.ok(body.doctors.length >= 1);
  assert.ok(body.doctors.every((d) => d.languages.includes('bn')));
});

test('the tracker publishes a window, a confidence and a leave-by time', async () => {
  const { body: personas } = await get('/api/patient/personas');
  const patientId = personas.personas[0].id;
  const { body: bookings } = await get(`/api/patient/bookings?patientId=${patientId}`);
  if (!bookings.active.length) return;
  const { body } = await get(`/api/patient/bookings/${bookings.active[0].id}/track`);
  assert.ok(body.entry.predictedStart.window.from < body.entry.predictedStart.window.to);
  assert.ok(body.entry.leaveAt <= body.entry.predictedStart.window.from);
  assert.ok(['high', 'medium', 'low'].includes(body.entry.predictedStart.confidence));
});

test('the wallet exposes household, cover and referrals without other patients', async () => {
  const { body: personas } = await get('/api/patient/personas');
  const traveller = personas.personas.find((p) => p.travelIsland);
  const { body } = await get(`/api/patient/wallet?patientId=${traveller.id}`);
  assert.ok(body.identity.name);
  assert.ok(body.household.length >= 1, 'the atoll parent manages a child');
  assert.ok(body.referrals.length >= 1, 'and carries a GP referral letter');
});
