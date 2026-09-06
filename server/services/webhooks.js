/**
 * Partner webhook delivery.
 *
 * At-least-once, HMAC-signed, retried with exponential backoff, dead-lettered
 * and replayable. Ordering is NOT guaranteed — every payload carries a
 * `sequence` that is monotonic per session so consumers can discard stale
 * events. queue.token.* events carry `expires_at`, because a "leave now"
 * delivered 40 minutes late is worse than useless.
 */
import { db } from '../db.js';
import { now, MINUTE } from '../lib/clock.js';
import { id, secret, hmacSignature, parse } from '../lib/util.js';
import { rfc3339 } from '../lib/mvtime.js';

export const API_VERSION = '2026-09-01';
const BACKOFF_MS = [30_000, 2 * MINUTE, 10 * MINUTE, 60 * MINUTE, 4 * 60 * MINUTE, 12 * 60 * MINUTE];
const MAX_ATTEMPTS = BACKOFF_MS.length;

export const EVENT_TYPES = [
  'slot.availability.changed', 'slot.session.published',
  'booking.confirmed', 'booking.rescheduled', 'booking.cancelled', 'booking.payment_required',
  'queue.session.started', 'queue.session.delayed', 'queue.session.paused',
  'queue.session.resumed', 'queue.session.cancelled',
  'queue.token.now_serving', 'queue.token.eta_changed', 'queue.token.leave_now',
  'queue.token.next', 'queue.token.called', 'queue.token.penalised',
  'queue.token.no_show', 'queue.token.completed', 'queue.token.at_risk',
  'payment.succeeded', 'payment.failed', 'payment.refunded',
  'insurance.eligibility.result', 'claim.status.changed',
];

/** TTL by event class — short for anything the patient acts on right now. */
const TTL_MS = {
  'queue.token.leave_now': 10 * MINUTE,
  'queue.token.next': 15 * MINUTE,
  'queue.token.called': 15 * MINUTE,
  'queue.token.eta_changed': 30 * MINUTE,
  'queue.token.now_serving': 10 * MINUTE,
};

export function createEndpoint({ partnerId, url, events, clinicIds = [] }) {
  const endpointId = id('whe');
  const signing = secret('whsec');
  db.prepare(`INSERT INTO webhook_endpoints (id, partner_id, url, events, clinic_ids, secret, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(endpointId, partnerId, url, JSON.stringify(events), JSON.stringify(clinicIds), signing, now());
  return { id: endpointId, url, events, clinic_ids: clinicIds, signing_secret: signing };
}

export function listEndpoints(partnerId) {
  return db.prepare('SELECT id, url, events, clinic_ids, state, failures, created_at FROM webhook_endpoints WHERE partner_id = ?')
    .all(partnerId)
    .map((r) => ({ ...r, events: parse(r.events, []), clinic_ids: parse(r.clinic_ids, []) }));
}

export function deleteEndpoint(partnerId, endpointId) {
  return db.prepare('DELETE FROM webhook_endpoints WHERE id = ? AND partner_id = ?').run(endpointId, partnerId).changes > 0;
}

export function rotateSecret(partnerId, endpointId) {
  const next = secret('whsec');
  const changed = db.prepare('UPDATE webhook_endpoints SET secret = ? WHERE id = ? AND partner_id = ?')
    .run(next, endpointId, partnerId).changes;
  return changed ? { id: endpointId, signing_secret: next } : null;
}

/** Fan an event out to every subscribed endpoint. Called by the outbox relay. */
export function emit({ type, clinicId, sessionId, sequence, data }) {
  if (!EVENT_TYPES.includes(type)) return 0;
  const at = now();
  const eventId = id('evt');
  const endpoints = db.prepare("SELECT * FROM webhook_endpoints WHERE state = 'active'").all();
  let queued = 0;

  for (const ep of endpoints) {
    const events = parse(ep.events, []);
    const clinics = parse(ep.clinic_ids, []);
    if (!events.includes(type)) continue;
    if (clinics.length && clinicId && !clinics.includes(clinicId)) continue;

    // Never leak identity across partners: a partner sees token-level detail
    // only for bookings it created.
    const scoped = scopeForPartner(ep.partner_id, data);
    if (!scoped) continue;

    const body = JSON.stringify({
      id: eventId, type, created_at: rfc3339(at),
      expires_at: TTL_MS[type] ? rfc3339(at + TTL_MS[type]) : null,
      api_version: API_VERSION, clinic_id: clinicId ?? null, session_id: sessionId ?? null,
      sequence: sequence ?? 0, data: scoped,
    });
    db.prepare(`INSERT INTO webhook_deliveries (id, endpoint_id, event_id, type, body, next_attempt_at, expires_at, created_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id('whd'), ep.id, eventId, type, body, at, TTL_MS[type] ? at + TTL_MS[type] : null, at);
    queued++;
  }
  return queued;
}

function scopeForPartner(partnerId, data) {
  if (!data || !data.booking_id) return data; // session-level facts are shared
  const token = db.prepare('SELECT partner_id FROM tokens WHERE id = ?').get(data.token_id);
  if (token && token.partner_id && token.partner_id !== partnerId) return null;
  if (token && !token.partner_id && partnerId !== 'first_party') return null;
  return data;
}

/** Drain pending deliveries. Called by the ticker. */
export async function drain(limit = 25) {
  const at = now();
  const pending = db.prepare(`SELECT * FROM webhook_deliveries WHERE state = 'pending' AND next_attempt_at <= ?
                              ORDER BY next_attempt_at LIMIT ?`).all(at, limit);
  const results = [];
  for (const d of pending) {
    if (d.expires_at && d.expires_at < at) {
      db.prepare("UPDATE webhook_deliveries SET state = 'failed', last_error = 'expired' WHERE id = ?").run(d.id);
      continue;
    }
    const ep = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(d.endpoint_id);
    if (!ep || ep.state !== 'active') {
      db.prepare("UPDATE webhook_deliveries SET state = 'failed', last_error = 'endpoint inactive' WHERE id = ?").run(d.id);
      continue;
    }
    const ts = Math.floor(at / 1000);
    const signature = `t=${ts},v1=${hmacSignature(ep.secret, ts, d.body)}`;
    let status = 0;
    let error = null;
    try {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vaguthu-signature': signature,
          'vaguthu-version': API_VERSION,
        },
        body: d.body,
        signal: AbortSignal.timeout(5000),
      });
      status = res.status;
    } catch (err) {
      error = String(err?.message || err).slice(0, 200);
    }

    const attempts = d.attempts + 1;
    if (status >= 200 && status < 300) {
      db.prepare("UPDATE webhook_deliveries SET state = 'delivered', attempts = ?, last_status = ? WHERE id = ?")
        .run(attempts, status, d.id);
      db.prepare('UPDATE webhook_endpoints SET failures = 0 WHERE id = ?').run(ep.id);
      results.push({ id: d.id, ok: true });
    } else if (attempts >= MAX_ATTEMPTS) {
      db.prepare("UPDATE webhook_deliveries SET state = 'failed', attempts = ?, last_status = ?, last_error = ? WHERE id = ?")
        .run(attempts, status, error, d.id);
      bumpFailures(ep);
      results.push({ id: d.id, ok: false, dead: true });
    } else {
      db.prepare('UPDATE webhook_deliveries SET attempts = ?, next_attempt_at = ?, last_status = ?, last_error = ? WHERE id = ?')
        .run(attempts, at + BACKOFF_MS[attempts - 1] + Math.floor(Math.random() * 5000), status, error, d.id);
      bumpFailures(ep);
      results.push({ id: d.id, ok: false });
    }
  }
  return results;
}

/** An endpoint failing almost everything gets switched off. We do not spend a day retrying into a dead host. */
function bumpFailures(ep) {
  const failures = ep.failures + 1;
  const state = failures >= 40 ? 'disabled' : 'active';
  db.prepare('UPDATE webhook_endpoints SET failures = ?, state = ? WHERE id = ?').run(failures, state, ep.id);
}

export function failedEvents(partnerId, endpointId) {
  return db.prepare(`SELECT d.* FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
                     WHERE e.partner_id = ? AND d.endpoint_id = ? AND d.state = 'failed'
                     ORDER BY d.created_at DESC LIMIT 100`).all(partnerId, endpointId);
}

export function replay(partnerId, endpointId, { from, to, types }) {
  const rows = db.prepare(`SELECT d.* FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
                           WHERE e.partner_id = ? AND d.endpoint_id = ?`).all(partnerId, endpointId);
  const at = now();
  let n = 0;
  for (const d of rows) {
    if (from && d.created_at < from) continue;
    if (to && d.created_at > to) continue;
    if (types?.length && !types.includes(d.type)) continue;
    db.prepare(`INSERT INTO webhook_deliveries (id, endpoint_id, event_id, type, body, next_attempt_at, created_at)
                VALUES (?,?,?,?,?,?,?)`).run(id('whd'), endpointId, d.event_id, d.type, d.body, at, at);
    n++;
  }
  return n;
}

export function deliveryStats(partnerId) {
  return db.prepare(`SELECT d.state, COUNT(*) AS count FROM webhook_deliveries d
                     JOIN webhook_endpoints e ON e.id = d.endpoint_id
                     WHERE e.partner_id = ? GROUP BY d.state`).all(partnerId);
}
