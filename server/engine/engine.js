/**
 * The Dynamic Token Engine.
 *
 * Single writer per session: every mutation goes through queue.js, which
 * appends an event and calls recompute(). The projection is derived and
 * disposable — Redis in the reference architecture, the `projections` table
 * here — and can always be rebuilt from the event log.
 */
import { db } from '../db.js';
import { now as clockNow } from '../lib/clock.js';
import { id, parse } from '../lib/util.js';
import { project } from './projector.js';
import { evaluate } from './materiality.js';

const listeners = new Set();
/** @param {(payload: {projection: object, notifications: Array}) => void} fn */
export function onProjection(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const qSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
const qDoctor = db.prepare('SELECT * FROM doctors WHERE id = ?');
const qTokens = db.prepare('SELECT * FROM tokens WHERE session_id = ? ORDER BY seq');
const qBlackouts = db.prepare('SELECT * FROM blackouts WHERE session_id = ?');
const qProjection = db.prepare('SELECT * FROM projections WHERE session_id = ?');
const saveProjection = db.prepare(`
  INSERT INTO projections (session_id, version, computed_at, body)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    version = excluded.version, computed_at = excluded.computed_at, body = excluded.body
`);
const bumpVersion = db.prepare('UPDATE sessions SET version = version + 1 WHERE id = ?');

/** Why did this ETA move? Populated on every change so partners and the patient app can be honest. */
const REASON_BY_EVENT = {
  'consultation.ended': 'consultation_overrun',
  'consultation.started': 'consultation_overrun',
  'consultation.extended': 'consultation_overrun',
  'session.delayed': 'session_started_late',
  'session.started': 'session_started_late',
  'session.paused': 'session_paused',
  'session.resumed': 'session_resumed',
  'token.priority': 'priority_insertion',
  'token.walk_in': 'walk_in_inserted',
  'token.reordered': 'reorder',
  'token.no_show': 'no_show_ahead',
  'token.cancelled': 'no_show_ahead',
  'token.penalised': 'reorder',
  'blackout.changed': 'blackout_interval',
};

/**
 * Spread of this doctor's historical start delay. Used only while a session has
 * not started: it is what makes an early-evening estimate honest about the fact
 * that nobody has walked through the door yet.
 */
const qDelays = db.prepare(`SELECT actual_start - scheduled_start AS d FROM sessions
                            WHERE doctor_id = ? AND actual_start IS NOT NULL ORDER BY scheduled_start DESC LIMIT 40`);
export function startDelaySd(doctorId) {
  const rows = qDelays.all(doctorId).map((r) => r.d / 60000);
  if (rows.length < 4) return 12;
  const mean = rows.reduce((s, v) => s + v, 0) / rows.length;
  const variance = rows.reduce((s, v) => s + (v - mean) ** 2, 0) / rows.length;
  return Math.min(45, Math.max(4, Math.sqrt(variance)));
}

export function readProjection(sessionId) {
  const row = qProjection.get(sessionId);
  return row ? { ...parse(row.body), version: row.version } : null;
}

/**
 * Recompute one session's projection, diff it, and emit notifications for
 * material changes only.
 * @param {string} sessionId
 * @param {{trigger?: string, notify?: boolean}} opts
 */
export function recompute(sessionId, opts = {}) {
  const session = qSession.get(sessionId);
  if (!session) return null;
  const doctor = qDoctor.get(session.doctor_id);
  const tokens = qTokens.all(sessionId);
  const blackouts = qBlackouts.all(sessionId);
  const patients = new Map();
  for (const t of tokens) {
    if (!patients.has(t.patient_id)) {
      patients.set(t.patient_id, db.prepare('SELECT * FROM patients WHERE id = ?').get(t.patient_id));
    }
  }

  const at = clockNow();
  const previous = readProjection(sessionId);
  const projection = project({
    session, doctor, tokens, blackouts, patients, now: at,
    startDelaySdMinutes: startDelaySd(session.doctor_id),
  });

  const reason = REASON_BY_EVENT[opts.trigger] ?? null;
  const prevByToken = new Map((previous?.entries ?? []).map((e) => [e.tokenId, e]));
  for (const entry of projection.entries) {
    const prev = prevByToken.get(entry.tokenId);
    const moved = prev ? entry.predictedStart.p50 - prev.predictedStart.p50 : 0;
    entry.reason = Math.abs(moved) > 60_000 ? reason : prev?.reason ?? null;
    entry.deltaMinutes = Math.round(moved / 60_000);
  }

  snapshot(projection, at);

  bumpVersion.run(sessionId);
  const version = qSession.get(sessionId).version;
  projection.version = version;
  projection.doctorName = doctor.name;
  projection.clinicId = session.clinic_id;
  saveProjection.run(sessionId, version, at, JSON.stringify(projection));

  let notifications = [];
  if (opts.notify !== false) {
    for (const entry of projection.entries) {
      const decision = evaluate({ entry, previous: prevByToken.get(entry.tokenId), session, now: at });
      if (decision) notifications.push(decision);
    }
  }

  for (const fn of listeners) {
    try {
      fn({ projection, notifications, session, trigger: opts.trigger });
    } catch (err) {
      console.error('[engine] listener failed', err);
    }
  }
  return { projection, notifications };
}

const SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const lastSnapshot = db.prepare('SELECT MAX(at) AS at FROM eta_snapshots WHERE token_id = ?');
const putSnapshot = db.prepare(`INSERT OR IGNORE INTO eta_snapshots (token_id, at, from_ms, to_ms, p50)
                                VALUES (?,?,?,?,?)`);

/** Keep one published window per token per five minutes. */
function snapshot(projection, at) {
  for (const entry of projection.entries) {
    const prev = lastSnapshot.get(entry.tokenId)?.at;
    if (prev && at - prev < SNAPSHOT_INTERVAL_MS) continue;
    putSnapshot.run(entry.tokenId, at, entry.predictedStart.window.from, entry.predictedStart.window.to, entry.predictedStart.p50);
  }
}

/** Append to the event log. Callers must be inside the same transaction as the mutation. */
export function appendEvent({ sessionId, tokenId, clinicId, type, payload = {}, at }) {
  const eventId = id('evt');
  const info = db
    .prepare('INSERT INTO events (id, session_id, token_id, clinic_id, type, payload, at) VALUES (?,?,?,?,?,?,?)')
    .run(eventId, sessionId ?? null, tokenId ?? null, clinicId ?? null, type, JSON.stringify(payload), at ?? clockNow());
  db.prepare('INSERT INTO outbox (event_seq) VALUES (?)').run(info.lastInsertRowid);
  return { eventId, seq: info.lastInsertRowid };
}

/**
 * Watchdog: a session with live events but a stale projection is failure mode
 * #3 — everyone downstream is confidently wrong and nothing alerts. So we alert.
 */
export function stalenessReport(maxAgeMs = 120_000) {
  const at = clockNow();
  const rows = db
    .prepare(`SELECT s.id, s.state, p.computed_at FROM sessions s
              LEFT JOIN projections p ON p.session_id = s.id
              WHERE s.state IN ('running','paused')`)
    .all();
  return rows
    .filter((r) => !r.computed_at || at - r.computed_at > maxAgeMs)
    .map((r) => ({ sessionId: r.id, ageMs: r.computed_at ? at - r.computed_at : null }));
}
