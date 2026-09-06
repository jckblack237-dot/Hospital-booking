/**
 * Queue Service — the ONLY writer of queue state.
 *
 * Every mutation: (1) writes the token/session change, (2) appends an event to
 * the log and the outbox, in the SAME transaction, then (3) triggers a
 * recompute outside the transaction. Losing an event silently corrupts every
 * downstream ETA with no self-healing path, so it must be atomic with the
 * change that caused it.
 */
import { db } from '../db.js';
import { now, MINUTE } from '../lib/clock.js';
import { id, parse, HttpError } from '../lib/util.js';
import { appendEvent, recompute, readProjection } from '../engine/engine.js';
import { record as recordDuration, recordTurnover } from '../engine/duration-model.js';
import { clearLog } from '../engine/materiality.js';
import { linkPatient } from './tenancy.js';

export const DEFAULT_PENALTY_POLICY = {
  gracePeriodMinutes: 5,
  penaltyMode: 'move_back_n', // move_back_n | move_to_end | hold_for_recall | none
  moveBackPositions: 2,
  maxPenaltiesBeforeNoShow: 2,
  noShowReleaseBehaviour: 'release',
  travelFlagExemption: true,
  lateArrivalPenalty: 1,
};

export function clinicSettings(clinicId) {
  const row = db.prepare('SELECT settings FROM clinics WHERE id = ?').get(clinicId);
  const s = parse(row?.settings, {}) || {};
  return { ...s, penalty: { ...DEFAULT_PENALTY_POLICY, ...(s.penalty || {}) } };
}

const getSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
const getToken = db.prepare('SELECT * FROM tokens WHERE id = ?');

function requireSession(sessionId) {
  const s = getSession.get(sessionId);
  if (!s) throw HttpError.notFound('Session');
  return s;
}
function requireToken(tokenId) {
  const t = getToken.get(tokenId);
  if (!t) throw HttpError.notFound('Token');
  return t;
}

/** Stable per-doctor queue letter within a clinic: A, B, C ... */
export function doctorLetter(clinicId, doctorId) {
  const rows = db.prepare('SELECT id FROM doctors WHERE clinic_id = ? ORDER BY rowid').all(clinicId);
  const idx = rows.findIndex((r) => r.id === doctorId);
  return String.fromCharCode(65 + (idx < 0 ? 0 : idx % 26));
}

function nextDisplay(session) {
  const n = db.prepare('SELECT COUNT(*) AS c FROM tokens WHERE session_id = ?').get(session.id).c;
  return `${doctorLetter(session.clinic_id, session.doctor_id)}-${String(n + 1).padStart(2, '0')}`;
}

function tailSeq(sessionId) {
  const row = db.prepare('SELECT MAX(seq) AS m FROM tokens WHERE session_id = ?').get(sessionId);
  return (row?.m ?? 0) + 1000;
}

const CALIBRATION_LEAD_MS = 15 * MINUTE;

/**
 * Calibration: was the window we PUBLISHED, at a useful lead time, right?
 *
 * Measured against the newest snapshot taken at least 15 minutes before the
 * consultation actually started — falling back to the oldest we have for
 * short-notice tokens. Scoring the window published one second beforehand
 * would report ~100% coverage and mean nothing.
 */
function recordAccuracy(token, actualStart) {
  const projection = readProjection(token.session_id);
  const snap = db.prepare(`SELECT * FROM eta_snapshots WHERE token_id = ? AND at <= ?
                           ORDER BY at DESC LIMIT 1`).get(token.id, actualStart - CALIBRATION_LEAD_MS)
    ?? db.prepare('SELECT * FROM eta_snapshots WHERE token_id = ? ORDER BY at LIMIT 1').get(token.id);
  if (!snap) return;
  db.prepare(`INSERT INTO eta_accuracy
      (token_id, session_id, doctor_id, predicted_from, predicted_to, predicted_p50, actual_start, inside, error_ms, lead_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(token_id) DO NOTHING`)
    .run(token.id, token.session_id, projection?.doctorId ?? null, snap.from_ms, snap.to_ms, snap.p50,
      actualStart, actualStart >= snap.from_ms && actualStart <= snap.to_ms ? 1 : 0,
      actualStart - snap.p50, actualStart - snap.at);
}

// ------------------------------------------------------------------ sessions

export function startSession(sessionId, actor = 'doctor') {
  const s = requireSession(sessionId);
  const at = now();
  db.transaction(() => {
    db.prepare("UPDATE sessions SET state = 'running', actual_start = COALESCE(actual_start, ?) WHERE id = ?").run(at, sessionId);
    appendEvent({ sessionId, clinicId: s.clinic_id, type: 'session.started', payload: { actor, at }, at });
  })();
  return recompute(sessionId, { trigger: 'session.started' });
}

export function endSession(sessionId) {
  const s = requireSession(sessionId);
  const at = now();
  db.transaction(() => {
    db.prepare("UPDATE sessions SET state = 'ended', actual_end = ? WHERE id = ?").run(at, sessionId);
    db.prepare("UPDATE blackouts SET ends_at = ?, open_ended = 0 WHERE session_id = ? AND open_ended = 1").run(at, sessionId);
    appendEvent({ sessionId, clinicId: s.clinic_id, type: 'session.ended', payload: { at }, at });
  })();
  return recompute(sessionId, { trigger: 'session.ended' });
}

export function pauseSession(sessionId, { kind = 'break', expectedMinutes = 15 } = {}) {
  const s = requireSession(sessionId);
  const at = now();
  db.transaction(() => {
    db.prepare(
      'INSERT INTO blackouts (id, session_id, kind, starts_at, expected_resume_at, open_ended) VALUES (?,?,?,?,?,1)',
    ).run(id('blk'), sessionId, kind, at, at + expectedMinutes * MINUTE);
    db.prepare("UPDATE sessions SET state = 'paused' WHERE id = ?").run(sessionId);
    appendEvent({ sessionId, clinicId: s.clinic_id, type: 'session.paused', payload: { kind, expectedMinutes }, at });
  })();
  return recompute(sessionId, { trigger: 'session.paused' });
}

export function resumeSession(sessionId) {
  const s = requireSession(sessionId);
  const at = now();
  db.transaction(() => {
    db.prepare('UPDATE blackouts SET ends_at = ?, open_ended = 0 WHERE session_id = ? AND open_ended = 1').run(at, sessionId);
    db.prepare("UPDATE sessions SET state = 'running', actual_start = COALESCE(actual_start, ?) WHERE id = ?").run(at, sessionId);
    appendEvent({ sessionId, clinicId: s.clinic_id, type: 'session.resumed', payload: {}, at });
  })();
  return recompute(sessionId, { trigger: 'session.resumed' });
}

export function delaySession(sessionId, minutes) {
  const s = requireSession(sessionId);
  const at = now();
  db.transaction(() => {
    db.prepare('UPDATE sessions SET delay_minutes = ? WHERE id = ?').run(Math.max(0, Math.round(minutes)), sessionId);
    appendEvent({ sessionId, clinicId: s.clinic_id, type: 'session.delayed', payload: { minutes }, at });
  })();
  return recompute(sessionId, { trigger: 'session.delayed' });
}

export function cancelSession(sessionId, reason = 'unspecified') {
  const s = requireSession(sessionId);
  const at = now();
  db.transaction(() => {
    db.prepare("UPDATE sessions SET state = 'cancelled' WHERE id = ?").run(sessionId);
    db.prepare("UPDATE tokens SET state = 'cancelled' WHERE session_id = ? AND state IN ('booked','arrived','called','penalised')").run(sessionId);
    appendEvent({ sessionId, clinicId: s.clinic_id, type: 'session.cancelled', payload: { reason }, at });
  })();
  return recompute(sessionId, { trigger: 'session.cancelled' });
}

// -------------------------------------------------------------------- tokens

export function addToken({
  sessionId, patientId, source = 'walk_in', visitType = 'new', partnerId = null,
  partnerReference = null, flags = [], priorityReason = null, notifyViaPartnerOnly = false,
  state = 'booked',
}) {
  const s = requireSession(sessionId);
  if (s.state === 'ended' || s.state === 'cancelled') {
    throw HttpError.conflict('session_closed', 'This session is closed to new tokens');
  }
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
  if (!patient) throw HttpError.notFound('Patient');

  const at = now();
  const tokenId = id('tok');
  const allFlags = new Set(flags);
  if (patient.travel_island) allFlags.add('travel');
  if (priorityReason) allFlags.add('priority');

  let seq;
  if (priorityReason) {
    // Priority insertion goes ahead of everyone still waiting, but never
    // interrupts the patient already in the room.
    const head = db
      .prepare("SELECT MIN(seq) AS m FROM tokens WHERE session_id = ? AND state IN ('booked','arrived','called','penalised')")
      .get(sessionId).m;
    seq = head == null ? tailSeq(sessionId) : head - 500;
  } else {
    seq = tailSeq(sessionId);
  }

  const display = nextDisplay(s);
  db.transaction(() => {
    // A booking is how a clinic comes to know a patient exists.
    linkPatient(s.clinic_id, patientId);
    db.prepare(`INSERT INTO tokens
      (id, session_id, patient_id, display, seq, source, partner_id, partner_reference, visit_type,
       state, flags, priority_reason, booked_at, notify_via_partner_only)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      tokenId, sessionId, patientId, display, seq, source, partnerId, partnerReference, visitType,
      state, JSON.stringify([...allFlags]), priorityReason, at, notifyViaPartnerOnly ? 1 : 0,
    );
    appendEvent({
      sessionId, tokenId, clinicId: s.clinic_id,
      type: priorityReason ? 'token.priority' : source === 'walk_in' ? 'token.walk_in' : 'token.created',
      payload: { source, visitType, display }, at,
    });
  })();
  recompute(sessionId, { trigger: priorityReason ? 'token.priority' : source === 'walk_in' ? 'token.walk_in' : 'token.created' });
  return getToken.get(tokenId);
}

export function checkIn(tokenId) {
  const t = requireToken(tokenId);
  const s = requireSession(t.session_id);
  const at = now();
  const policy = clinicSettings(s.clinic_id).penalty;

  db.transaction(() => {
    db.prepare("UPDATE tokens SET state = CASE WHEN state = 'booked' THEN 'arrived' ELSE state END, arrived_at = COALESCE(arrived_at, ?) WHERE id = ?").run(at, tokenId);
    appendEvent({ sessionId: t.session_id, tokenId, clinicId: s.clinic_id, type: 'token.arrived', payload: {}, at });
  })();

  // Late arrival: the patient checked in after their window closed.
  const projection = recompute(t.session_id, { trigger: 'token.arrived' });
  const flags = parse(t.flags, []) || [];
  const exempt = policy.travelFlagExemption && flags.includes('travel');
  if (!exempt && policy.lateArrivalPenalty > 0) {
    const entry = projection?.projection.entries.find((e) => e.tokenId === tokenId);
    if (entry && entry.predictedStart.window.to < at) {
      return applyPenalty(tokenId, 'late_arrival');
    }
  }
  return projection;
}

export function onMyWay(tokenId) {
  const t = requireToken(tokenId);
  db.prepare('UPDATE tokens SET on_my_way = 1 WHERE id = ?').run(tokenId);
  appendEvent({ sessionId: t.session_id, tokenId, type: 'token.on_my_way', payload: {} });
  return recompute(t.session_id, { trigger: 'token.on_my_way', notify: false });
}

export function callToken(tokenId) {
  const t = requireToken(tokenId);
  const at = now();
  db.transaction(() => {
    db.prepare("UPDATE tokens SET state = 'called', called_at = ? WHERE id = ?").run(at, tokenId);
    appendEvent({ sessionId: t.session_id, tokenId, type: 'token.called', payload: {}, at });
  })();
  return recompute(t.session_id, { trigger: 'token.called' });
}

export function startConsult(tokenId) {
  const t = requireToken(tokenId);
  const s = requireSession(t.session_id);
  const at = now();
  const open = db.prepare("SELECT id FROM tokens WHERE session_id = ? AND state = 'in_consult'").get(t.session_id);
  if (open && open.id !== tokenId) endConsult(open.id);

  const lastEnd = db
    .prepare("SELECT MAX(ended_at) AS m FROM tokens WHERE session_id = ? AND state = 'completed'")
    .get(t.session_id).m;

  // Record what we promised against what happened, BEFORE the state change
  // invalidates the projection. Without this the P80-coverage metric — the one
  // number that says whether patients should believe us — cannot be computed.
  recordAccuracy(t, at);

  db.transaction(() => {
    db.prepare("UPDATE tokens SET state = 'in_consult', started_at = ?, called_at = COALESCE(called_at, ?), arrived_at = COALESCE(arrived_at, ?) WHERE id = ?").run(at, at, at, tokenId);
    if (s.state === 'scheduled') {
      db.prepare("UPDATE sessions SET state = 'running', actual_start = COALESCE(actual_start, ?) WHERE id = ?").run(at, t.session_id);
    }
    appendEvent({ sessionId: t.session_id, tokenId, clinicId: s.clinic_id, type: 'consultation.started', payload: {}, at });
  })();

  if (lastEnd) recordTurnover(s.doctor_id, at - lastEnd);
  return recompute(t.session_id, { trigger: 'consultation.started' });
}

export function endConsult(tokenId) {
  const t = requireToken(tokenId);
  const s = requireSession(t.session_id);
  const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(s.doctor_id);
  const at = now();
  const startedAt = t.started_at ?? at;

  db.transaction(() => {
    db.prepare("UPDATE tokens SET state = 'completed', ended_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?").run(at, at, tokenId);
    appendEvent({
      sessionId: t.session_id, tokenId, clinicId: s.clinic_id, type: 'consultation.ended',
      payload: { durationMs: at - startedAt }, at,
    });
  })();

  recordDuration({
    doctorId: doctor.id, specialty: doctor.specialty, visitType: t.visit_type,
    isNewPatient: t.visit_type === 'new', durationMs: at - startedAt,
  });
  clearLog(tokenId);
  return recompute(t.session_id, { trigger: 'consultation.ended' });
}

export function extendConsult(tokenId, minutes = 10) {
  const t = requireToken(tokenId);
  db.prepare('UPDATE tokens SET extra_minutes = extra_minutes + ? WHERE id = ?').run(minutes, tokenId);
  appendEvent({ sessionId: t.session_id, tokenId, type: 'consultation.extended', payload: { minutes } });
  return recompute(t.session_id, { trigger: 'consultation.extended' });
}

export function markNoShow(tokenId) {
  const t = requireToken(tokenId);
  const at = now();
  db.transaction(() => {
    db.prepare("UPDATE tokens SET state = 'no_show' WHERE id = ?").run(tokenId);
    appendEvent({ sessionId: t.session_id, tokenId, type: 'token.no_show', payload: {}, at });
  })();
  return recompute(t.session_id, { trigger: 'token.no_show' });
}

export function cancelToken(tokenId, by = 'patient') {
  const t = requireToken(tokenId);
  db.transaction(() => {
    db.prepare("UPDATE tokens SET state = 'cancelled' WHERE id = ?").run(tokenId);
    appendEvent({ sessionId: t.session_id, tokenId, type: 'token.cancelled', payload: { by } });
  })();
  return recompute(t.session_id, { trigger: 'token.cancelled' });
}

export function reinstate(tokenId) {
  const t = requireToken(tokenId);
  db.prepare("UPDATE tokens SET state = 'arrived', seq = ?, penalty_count = 0 WHERE id = ?").run(tailSeq(t.session_id), tokenId);
  appendEvent({ sessionId: t.session_id, tokenId, type: 'token.reinstated', payload: {} });
  return recompute(t.session_id, { trigger: 'token.reordered' });
}

/**
 * Delay penalty. Configurable per clinic because clinic cultures genuinely
 * differ. Always reversible, always logged, and always explained to the patient
 * — a silent demotion is worse than no system at all.
 */
export function applyPenalty(tokenId, cause = 'not_present') {
  const t = requireToken(tokenId);
  const s = requireSession(t.session_id);
  const policy = clinicSettings(s.clinic_id).penalty;
  const flags = parse(t.flags, []) || [];

  if (policy.travelFlagExemption && flags.includes('travel')) {
    // Flag for a human decision instead of applying the rule. A patient who
    // took a 3-hour ferry and got demoted for being 6 minutes late will never
    // come back — and will tell the island.
    db.prepare('UPDATE tokens SET flags = ? WHERE id = ?').run(
      JSON.stringify([...new Set([...flags, 'needs_decision'])]), tokenId,
    );
    appendEvent({ sessionId: t.session_id, tokenId, type: 'token.penalty_deferred', payload: { cause } });
    return recompute(t.session_id, { trigger: 'token.reordered' });
  }

  const count = t.penalty_count + 1;
  if (policy.penaltyMode === 'none') return recompute(t.session_id, { trigger: 'token.reordered' });
  if (count > policy.maxPenaltiesBeforeNoShow) return markNoShow(tokenId);

  const waiting = db
    .prepare("SELECT id, seq FROM tokens WHERE session_id = ? AND state IN ('booked','arrived','called','penalised') ORDER BY seq")
    .all(t.session_id);
  const idx = waiting.findIndex((w) => w.id === tokenId);
  let newSeq;
  if (policy.penaltyMode === 'move_to_end' || idx < 0) {
    newSeq = tailSeq(t.session_id);
  } else {
    const target = Math.min(waiting.length - 1, idx + policy.moveBackPositions);
    const before = waiting[target];
    const after = waiting[target + 1];
    newSeq = after ? (before.seq + after.seq) / 2 : before.seq + 1000;
  }

  db.transaction(() => {
    db.prepare("UPDATE tokens SET state = 'penalised', seq = ?, penalty_count = ?, called_at = NULL WHERE id = ?").run(newSeq, count, tokenId);
    appendEvent({ sessionId: t.session_id, tokenId, type: 'token.penalised', payload: { cause, count, mode: policy.penaltyMode } });
  })();
  return recompute(t.session_id, { trigger: 'token.penalised' });
}

/** Undo the most recent penalty. The receptionist is the authority; we are the memory. */
export function revokePenalty(tokenId) {
  const t = requireToken(tokenId);
  const head = db
    .prepare("SELECT MIN(seq) AS m FROM tokens WHERE session_id = ? AND state IN ('booked','arrived','called','penalised')")
    .get(t.session_id).m;
  db.prepare("UPDATE tokens SET state = 'arrived', seq = ?, penalty_count = MAX(0, penalty_count - 1) WHERE id = ?")
    .run((head ?? 1000) - 250, tokenId);
  appendEvent({ sessionId: t.session_id, tokenId, type: 'token.penalty_revoked', payload: {} });
  return recompute(t.session_id, { trigger: 'token.reordered' });
}

/** Grace-period sweep, run by the ticker. */
export function sweepGracePeriods() {
  const at = now();
  const rows = db.prepare("SELECT t.*, s.clinic_id FROM tokens t JOIN sessions s ON s.id = t.session_id WHERE t.state = 'called'").all();
  const touched = [];
  for (const t of rows) {
    const policy = clinicSettings(t.clinic_id).penalty;
    if (!t.called_at) continue;
    if (at - t.called_at > policy.gracePeriodMinutes * MINUTE) {
      applyPenalty(t.id, 'not_present');
      touched.push(t.id);
    }
  }
  return touched;
}

/**
 * Drag-and-drop reorder using fractional ranks: a single-row update regardless
 * of queue length. No renumbering, no write amplification, no lock contention
 * on a busy board.
 */
export function reorder(tokenId, { afterTokenId = null, beforeTokenId = null } = {}) {
  const t = requireToken(tokenId);
  const list = db
    .prepare("SELECT id, seq FROM tokens WHERE session_id = ? AND state IN ('booked','arrived','called','penalised') AND id != ? ORDER BY seq")
    .all(t.session_id, tokenId);

  let seq;
  if (!list.length) {
    seq = 1000;
  } else if (afterTokenId === null && beforeTokenId === null) {
    seq = list[list.length - 1].seq + 1000;
  } else {
    const afterIdx = afterTokenId ? list.findIndex((x) => x.id === afterTokenId) : -1;
    const prev = afterIdx >= 0 ? list[afterIdx] : null;
    const nextIdx = beforeTokenId ? list.findIndex((x) => x.id === beforeTokenId) : afterIdx + 1;
    const next = nextIdx >= 0 && nextIdx < list.length ? list[nextIdx] : null;
    if (prev && next) seq = (prev.seq + next.seq) / 2;
    else if (prev) seq = prev.seq + 1000;
    else if (next) seq = next.seq - 1000;
    else seq = 1000;
  }

  db.transaction(() => {
    db.prepare('UPDATE tokens SET seq = ? WHERE id = ?').run(seq, tokenId);
    appendEvent({ sessionId: t.session_id, tokenId, type: 'token.reordered', payload: { seq } });
  })();
  return recompute(t.session_id, { trigger: 'token.reordered' });
}

/** Move a token to a different doctor's session entirely. */
export function reassign(tokenId, targetSessionId) {
  const t = requireToken(tokenId);
  const target = requireSession(targetSessionId);
  const from = t.session_id;
  db.transaction(() => {
    db.prepare('UPDATE tokens SET session_id = ?, seq = ?, display = ? WHERE id = ?')
      .run(targetSessionId, tailSeq(targetSessionId), nextDisplay(target), tokenId);
    appendEvent({ sessionId: targetSessionId, tokenId, type: 'token.reassigned', payload: { from } });
  })();
  recompute(from, { trigger: 'token.reordered' });
  return recompute(targetSessionId, { trigger: 'token.reordered' });
}

/** Renormalise fractional ranks to integers. Runs at session close. */
export function renormalise(sessionId) {
  const rows = db.prepare('SELECT id FROM tokens WHERE session_id = ? ORDER BY seq').all(sessionId);
  const stmt = db.prepare('UPDATE tokens SET seq = ? WHERE id = ?');
  db.transaction(() => rows.forEach((r, i) => stmt.run((i + 1) * 1000, r.id)))();
}
