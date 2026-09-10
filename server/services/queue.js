/**
 * Queue Service — the ONLY writer of queue state.
 *
 * Every mutation: (1) checks the transition is legal for the token's or
 * session's current state, (2) writes the change and appends an event to the
 * log and the outbox in the SAME transaction, then (3) recomputes the
 * projection outside the transaction and announces the change on the clinic
 * channel. Losing an event silently corrupts every downstream ETA with no
 * self-healing path, so it must be atomic with the change that caused it.
 *
 * A mis-tap on a tablet must be refused with a sentence the receptionist can
 * act on, never accepted with a green toast. That is what the transition
 * tables below are for.
 */
import { db } from '../db.js';
import { now, MINUTE } from '../lib/clock.js';
import { id, parse, HttpError, num, oneOf } from '../lib/util.js';
import { appendEvent, recompute, readProjection } from '../engine/engine.js';
import { record as recordDuration, recordTurnover } from '../engine/duration-model.js';
import { clearLog, clearRule } from '../engine/materiality.js';
import { publish } from '../realtime.js';
import { linkPatient } from './tenancy.js';
import * as billing from './billing.js';
import * as messaging from './messaging.js';
import { tokenView, sessionView } from './board.js';

export const DEFAULT_PENALTY_POLICY = {
  gracePeriodMinutes: 5,
  penaltyMode: 'move_back_n', // move_back_n | move_to_end | hold_for_recall | none
  moveBackPositions: 2,
  maxPenaltiesBeforeNoShow: 2,
  noShowReleaseBehaviour: 'release',
  travelFlagExemption: true,
  lateArrivalPenalty: 1,
};

export const WAITING_STATES = ['booked', 'arrived', 'called', 'penalised'];
export const ACTIVE_STATES = [...WAITING_STATES, 'in_consult'];
export const PAUSE_KINDS = ['prayer', 'break', 'emergency', 'admin', 'other'];

export function clinicSettings(clinicId) {
  const row = db.prepare('SELECT settings FROM clinics WHERE id = ?').get(clinicId);
  const s = parse(row?.settings, {}) || {};
  return { ...s, penalty: { ...DEFAULT_PENALTY_POLICY, ...(s.penalty || {}) } };
}

const getSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
const getToken = db.prepare('SELECT * FROM tokens WHERE id = ?');
const getDoctor = db.prepare('SELECT * FROM doctors WHERE id = ?');
const inRoom = db.prepare("SELECT id, display FROM tokens WHERE session_id = ? AND state = 'in_consult'");

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

// -------------------------------------------------------------- transitions

/** Which actions a token accepts in each state. `checkin` on arrived/called and `end` on completed are no-ops. */
const TOKEN_TRANSITIONS = {
  booked: ['checkin', 'call', 'start', 'cancel', 'no-show', 'reorder', 'reassign', 'note'],
  arrived: ['checkin', 'call', 'start', 'cancel', 'no-show', 'penalty', 'reorder', 'reassign', 'note'],
  called: ['start', 'checkin', 'penalty', 'no-show', 'cancel', 'reorder', 'reassign', 'note'],
  penalised: ['call', 'start', 'cancel', 'no-show', 'revoke-penalty', 'reorder', 'reassign', 'note'],
  in_consult: ['end', 'extend', 'note'],
  completed: ['end', 'note'],
  no_show: ['reinstate', 'note'],
  cancelled: ['reinstate', 'note'],
};

const SESSION_TRANSITIONS = {
  scheduled: ['start', 'delay', 'cancel', 'simulate', 'broadcast'],
  running: ['pause', 'end', 'delay', 'cancel', 'simulate', 'broadcast'],
  paused: ['resume', 'end', 'cancel', 'simulate', 'broadcast'],
  ended: ['simulate'],
  cancelled: ['simulate'],
};

const ACTION_VERB = {
  checkin: 'check them in', call: 'call them', start: 'start the consultation', end: 'end the consultation',
  extend: 'extend the consultation', cancel: 'cancel the token', 'no-show': 'mark them as not attending',
  penalty: 'move them back', 'revoke-penalty': 'undo a penalty', reinstate: 'reinstate the token',
  reorder: 'move them in the queue', reassign: 'move them to another doctor', note: 'add a note',
};

/** A sentence a receptionist can act on, keyed by where the token is now. */
function tokenDetail(t, action) {
  const d = t.display;
  switch (t.state) {
    case 'in_consult':
      return `${d} is already in the room. End the consultation first.`;
    case 'completed':
      return `${d} has already been seen${action === 'reinstate' ? '' : ' — reinstate the token to bring them back'}.`;
    case 'no_show':
      return `${d} was marked as not attending. Reinstate the token first.`;
    case 'cancelled':
      return `${d} was cancelled. Reinstate the token first.`;
    case 'booked':
      if (action === 'penalty') return `${d} hasn't checked in yet, so there is nothing to penalise.`;
      if (action === 'end' || action === 'extend') return `${d} hasn't started with the doctor yet. Start the consultation first.`;
      break;
    case 'arrived':
      if (action === 'end' || action === 'extend') return `${d} hasn't started with the doctor yet. Start the consultation first.`;
      break;
    case 'called':
      if (action === 'call') return `${d} has already been called. Start the consultation when they come in.`;
      if (action === 'end' || action === 'extend') return `${d} has been called but not started. Start the consultation first.`;
      break;
    case 'penalised':
      if (action === 'checkin') return `${d} was moved back for not answering the call. Call them again or undo the penalty.`;
      if (action === 'penalty') return `${d} has already been moved back. Call them again first.`;
      break;
    default:
  }
  return `${d} is ${t.state.replace('_', ' ')} — you can't ${ACTION_VERB[action] ?? action} now.`;
}

function invalid(detail, state, action, extra = {}) {
  return new HttpError(409, 'invalid_transition', 'Invalid transition', detail, { code: 'invalid_transition', state, action, ...extra });
}

function assertToken(t, action) {
  if (!(TOKEN_TRANSITIONS[t.state] ?? []).includes(action)) throw invalid(tokenDetail(t, action), t.state, action, { tokenId: t.id, display: t.display });
}

function sessionDetail(s, action) {
  const who = `${getDoctor.get(s.doctor_id)?.name ?? 'This doctor'}'s session`;
  switch (s.state) {
    case 'ended': return `${who} has already finished.`;
    case 'cancelled': return `${who} was cancelled.`;
    case 'scheduled': return action === 'resume' ? `${who} isn't paused.` : `${who} hasn't started yet. Start it first.`;
    case 'running':
      if (action === 'start') return `${who} is already running.`;
      if (action === 'resume') return `${who} isn't paused.`;
      break;
    case 'paused':
      if (action === 'pause') return `${who} is already paused. Resume it before pausing again.`;
      if (action === 'start') return `${who} is paused — resume it instead.`;
      if (action === 'delay') return `${who} is paused. Resume it, or extend the pause.`;
      break;
    default:
  }
  return `${who} is ${s.state} — you can't ${action} it now.`;
}

export function assertSession(s, action) {
  if (!(SESSION_TRANSITIONS[s.state] ?? []).includes(action)) throw invalid(sessionDetail(s, action), s.state, action, { sessionId: s.id });
}

/** Ending or cancelling with someone in the room is refused unless the caller opts in to completing them. */
function settleRoom(s, action, completeCurrent) {
  const current = inRoom.get(s.id);
  if (!current) return null;
  if (!completeCurrent) {
    throw invalid(`${current.display} is still in the room. End the consultation first, or choose to finish and complete them.`,
      s.state, action, { sessionId: s.id, currentTokenId: current.id, currentDisplay: current.display });
  }
  return endConsult(current.id);
}

// ------------------------------------------------------------ announcements

/** The clinic channel hears about every mutation as the thing that changed, not as a whole-board diff. */
function announceToken(tokenId, action, previousState, sessionId, projection) {
  const token = tokenView(tokenId, projection);
  if (!token) return null;
  const s = getSession.get(sessionId ?? token.session_id);
  publish(`clinic:${s.clinic_id}`, {
    type: 'token.changed', clinicId: s.clinic_id, sessionId: sessionId ?? token.session_id, action, previousState, token,
  });
  return token;
}

function announceSession(sessionId, action) {
  const session = sessionView(sessionId);
  if (session) publish(`clinic:${session.clinic_id}`, { type: 'session.changed', clinicId: session.clinic_id, action, session });
  return session;
}

/** Standard result of a token action: the enriched row plus the fresh projection. */
function tokenResult(tokenId, action, previousState, computed, extra = {}) {
  const projection = computed?.projection ?? null;
  const token = announceToken(tokenId, action, previousState, projection?.sessionId, projection);
  return { token, projection, ...extra };
}

function sessionResult(sessionId, action, computed, extra = {}) {
  return { session: announceSession(sessionId, action), projection: computed?.projection ?? null, ...extra };
}

// ------------------------------------------------------------------ helpers

/** Stable per-doctor queue letter within a clinic: A, B, C ... */
export function doctorLetter(clinicId, doctorId) {
  const rows = db.prepare('SELECT id FROM doctors WHERE clinic_id = ? ORDER BY rowid').all(clinicId);
  const idx = rows.findIndex((r) => r.id === doctorId);
  return String.fromCharCode(65 + (idx < 0 ? 0 : idx % 26));
}

/**
 * Per-session monotonic display number: MAX(existing suffix) + 1, never a
 * COUNT. A token that leaves for another doctor must not free its number,
 * or two people stand up when "F-18" is called.
 */
function nextDisplay(session) {
  // Tokens that were moved to another doctor keep their old number reserved
  // here: the reassign event remembers it after the token row has moved on.
  const row = db.prepare(`SELECT MAX(n) AS m FROM (
      SELECT CAST(substr(display, instr(display, '-') + 1) AS INTEGER) AS n FROM tokens WHERE session_id = ?
      UNION ALL
      SELECT CAST(substr(json_extract(payload, '$.previousDisplay'), instr(json_extract(payload, '$.previousDisplay'), '-') + 1) AS INTEGER)
        FROM events WHERE type = 'token.reassigned' AND json_extract(payload, '$.from') = ?)`).get(session.id, session.id);
  return `${doctorLetter(session.clinic_id, session.doctor_id)}-${String((row?.m ?? 0) + 1).padStart(2, '0')}`;
}

function tailSeq(sessionId) {
  const row = db.prepare('SELECT MAX(seq) AS m FROM tokens WHERE session_id = ?').get(sessionId);
  return (row?.m ?? 0) + 1000;
}

const waitingList = db.prepare(`SELECT id, seq, state FROM tokens WHERE session_id = ?
                                AND state IN ('booked','arrived','called','penalised') ORDER BY seq, rowid`);

function setFlag(t, flag, on) {
  const flags = new Set(parse(t.flags, []) || []);
  if (on) flags.add(flag); else flags.delete(flag);
  db.prepare('UPDATE tokens SET flags = ? WHERE id = ?').run(JSON.stringify([...flags]), t.id);
  return [...flags];
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
  assertSession(s, 'start');
  const at = now();
  db.transaction(() => {
    db.prepare("UPDATE sessions SET state = 'running', actual_start = COALESCE(actual_start, ?) WHERE id = ?").run(at, sessionId);
    appendEvent({ sessionId, clinicId: s.clinic_id, type: 'session.started', payload: { actor, at }, at });
  })();
  return sessionResult(sessionId, 'start', recompute(sessionId, { trigger: 'session.started' }));
}

/**
 * Close a session. `completeCurrent` ends (and invoices) whoever is in the
 * room; `system` is the platform closing the day, which may also end a
 * session nobody ever started.
 */
export function endSession(sessionId, { completeCurrent = false, system = false } = {}) {
  const s = requireSession(sessionId);
  if (!(system && s.state === 'scheduled')) assertSession(s, 'end');
  const completed = settleRoom(s, 'end', completeCurrent || system);
  const at = now();
  db.transaction(() => {
    db.prepare("UPDATE sessions SET state = 'ended', actual_end = ? WHERE id = ?").run(at, sessionId);
    db.prepare("UPDATE blackouts SET ends_at = ?, open_ended = 0 WHERE session_id = ? AND open_ended = 1").run(at, sessionId);
    appendEvent({ sessionId, clinicId: s.clinic_id, type: 'session.ended', payload: { at }, at });
  })();
  renormalise(sessionId);
  return sessionResult(sessionId, 'end', recompute(sessionId, { trigger: 'session.ended' }),
    { completedToken: completed?.token ?? null, invoice: completed?.invoice ?? null });
}

export function pauseSession(sessionId, { kind = 'break', expectedMinutes = 15 } = {}) {
  const s = requireSession(sessionId);
  kind = oneOf(kind, 'kind', PAUSE_KINDS);
  expectedMinutes = num(expectedMinutes, 'expectedMinutes', { min: 1, max: 120 });
  assertSession(s, 'pause');
  const at = now();
  db.transaction(() => {
    db.prepare(
      'INSERT INTO blackouts (id, session_id, kind, starts_at, expected_resume_at, open_ended) VALUES (?,?,?,?,?,1)',
    ).run(id('blk'), sessionId, kind, at, at + expectedMinutes * MINUTE);
    db.prepare("UPDATE sessions SET state = 'paused' WHERE id = ?").run(sessionId);
    appendEvent({ sessionId, clinicId: s.clinic_id, type: 'session.paused', payload: { kind, expectedMinutes }, at });
  })();
  return sessionResult(sessionId, 'pause', recompute(sessionId, { trigger: 'session.paused' }));
}

export function resumeSession(sessionId) {
  const s = requireSession(sessionId);
  assertSession(s, 'resume');
  const at = now();
  db.transaction(() => {
    db.prepare('UPDATE blackouts SET ends_at = ?, open_ended = 0 WHERE session_id = ? AND open_ended = 1').run(at, sessionId);
    db.prepare("UPDATE sessions SET state = 'running', actual_start = COALESCE(actual_start, ?) WHERE id = ?").run(at, sessionId);
    appendEvent({ sessionId, clinicId: s.clinic_id, type: 'session.resumed', payload: {}, at });
  })();
  return sessionResult(sessionId, 'resume', recompute(sessionId, { trigger: 'session.resumed' }));
}

export function delaySession(sessionId, minutes) {
  const s = requireSession(sessionId);
  minutes = num(minutes, 'minutes', { min: 1, max: 240 });
  assertSession(s, 'delay');
  const at = now();
  db.transaction(() => {
    db.prepare('UPDATE sessions SET delay_minutes = ? WHERE id = ?').run(Math.round(minutes), sessionId);
    appendEvent({ sessionId, clinicId: s.clinic_id, type: 'session.delayed', payload: { minutes }, at });
  })();
  return sessionResult(sessionId, 'delay', recompute(sessionId, { trigger: 'session.delayed' }));
}

export function cancelSession(sessionId, reason = 'unspecified', { completeCurrent = false } = {}) {
  const s = requireSession(sessionId);
  assertSession(s, 'cancel');
  const completed = settleRoom(s, 'cancel', completeCurrent);
  const at = now();
  db.transaction(() => {
    db.prepare("UPDATE sessions SET state = 'cancelled' WHERE id = ?").run(sessionId);
    db.prepare("UPDATE tokens SET state = 'cancelled' WHERE session_id = ? AND state IN ('booked','arrived','called','penalised')").run(sessionId);
    appendEvent({ sessionId, clinicId: s.clinic_id, type: 'session.cancelled', payload: { reason }, at });
  })();
  return sessionResult(sessionId, 'cancel', recompute(sessionId, { trigger: 'session.cancelled' }),
    { completedToken: completed?.token ?? null, invoice: completed?.invoice ?? null });
}

// -------------------------------------------------------------------- tokens

export function addToken({
  sessionId, patientId, source = 'walk_in', visitType = 'new', partnerId = null,
  partnerReference = null, flags = [], priorityReason = null, notifyViaPartnerOnly = false,
  state = 'booked', allowDuplicate = false,
}) {
  const s = requireSession(sessionId);
  if (s.state === 'ended' || s.state === 'cancelled') {
    throw HttpError.conflict('session_closed', 'This session is closed to new tokens');
  }
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
  if (!patient) throw HttpError.notFound('Patient');

  // A second receptionist re-registering the same person gives them two
  // places, two sets of messages, and everyone else a wrong ETA.
  const dup = db.prepare(`SELECT id, display FROM tokens WHERE session_id = ? AND patient_id = ?
                          AND state IN ('booked','arrived','called','penalised','in_consult') LIMIT 1`).get(sessionId, patientId);
  if (dup && !allowDuplicate) {
    throw HttpError.conflict('duplicate_token', `${patient.name} already holds token ${dup.display} in this session.`,
      { code: 'duplicate_token', existingTokenId: dup.id, display: dup.display });
  }

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
  const type = priorityReason ? 'token.priority' : source === 'walk_in' ? 'token.walk_in' : 'token.created';
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
    appendEvent({ sessionId, tokenId, clinicId: s.clinic_id, type, payload: { source, visitType, display }, at });
  })();
  return tokenResult(tokenId, 'create', null, recompute(sessionId, { trigger: type })).token;
}

/**
 * Check in. Idempotent: a second tap on an arrived or called token is a
 * 200 with nothing changed. A late arrival may be penalised in the same
 * call — the response says so, because the receptionist has to explain
 * it to the person standing at the desk.
 */
export function checkIn(tokenId) {
  const t = requireToken(tokenId);
  assertToken(t, 'checkin');
  if (t.state !== 'booked') {
    return { token: tokenView(tokenId), projection: readProjection(t.session_id), noop: true, penalised: false };
  }
  const s = requireSession(t.session_id);
  const at = now();
  const policy = clinicSettings(s.clinic_id).penalty;

  db.transaction(() => {
    db.prepare("UPDATE tokens SET state = 'arrived', arrived_at = COALESCE(arrived_at, ?) WHERE id = ?").run(at, tokenId);
    appendEvent({ sessionId: t.session_id, tokenId, clinicId: s.clinic_id, type: 'token.arrived', payload: {}, at });
  })();

  // Late arrival: the patient checked in after their window closed.
  const computed = recompute(t.session_id, { trigger: 'token.arrived' });
  const flags = parse(t.flags, []) || [];
  const exempt = policy.travelFlagExemption && flags.includes('travel');
  if (!exempt && policy.lateArrivalPenalty > 0) {
    const entry = computed?.projection.entries.find((e) => e.tokenId === tokenId);
    if (entry && entry.predictedStart.window.to < at) {
      const penalty = applyPenalty(tokenId, 'late_arrival');
      return {
        ...penalty,
        penalised: penalty.token.state === 'penalised',
        cause: 'late_arrival',
        newPosition: penalty.token.projection?.position ?? null,
      };
    }
  }
  return tokenResult(tokenId, 'checkin', 'booked', computed, { penalised: false });
}

export function onMyWay(tokenId) {
  const t = requireToken(tokenId);
  db.prepare('UPDATE tokens SET on_my_way = 1 WHERE id = ?').run(tokenId);
  appendEvent({ sessionId: t.session_id, tokenId, type: 'token.on_my_way', payload: {} });
  return tokenResult(tokenId, 'on_my_way', t.state, recompute(t.session_id, { trigger: 'token.on_my_way', notify: false }));
}

export function callToken(tokenId) {
  const t = requireToken(tokenId);
  assertToken(t, 'call');
  const at = now();
  db.transaction(() => {
    db.prepare("UPDATE tokens SET state = 'called', called_at = ? WHERE id = ?").run(at, tokenId);
    setFlag(t, 'doctor_requested', false);
    appendEvent({ sessionId: t.session_id, tokenId, type: 'token.called', payload: {}, at });
  })();
  return tokenResult(tokenId, 'call', t.state, recompute(t.session_id, { trigger: 'token.called' }));
}

/** The first patient who is actually here, in queue order. Never someone still on the way. */
export function nextPresent(sessionId) {
  return db.prepare(`SELECT * FROM tokens WHERE session_id = ? AND state IN ('arrived','penalised')
                     ORDER BY seq, rowid LIMIT 1`).get(sessionId);
}

/**
 * Start a consultation. Refuses while another patient is in the room unless
 * the caller asks to end (and invoice) them first — a silent auto-end is how
 * patients got completed with no bill.
 */
export function startConsult(tokenId, { endCurrent = false } = {}) {
  const t = requireToken(tokenId);
  assertToken(t, 'start');
  const s = requireSession(t.session_id);
  const at = now();
  const open = inRoom.get(t.session_id);
  let ended = null;
  if (open && open.id !== tokenId) {
    if (!endCurrent) {
      throw invalid(`${open.display} is already in the room. End the consultation first.`, t.state, 'start',
        { tokenId, display: t.display, currentTokenId: open.id, currentDisplay: open.display });
    }
    ended = endConsult(open.id);
  }

  const lastEnd = db
    .prepare("SELECT MAX(ended_at) AS m FROM tokens WHERE session_id = ? AND state = 'completed'")
    .get(t.session_id).m;

  // Record what we promised against what happened, BEFORE the state change
  // invalidates the projection. Without this the P80-coverage metric — the one
  // number that says whether patients should believe us — cannot be computed.
  recordAccuracy(t, at);

  const sessionStarted = s.state === 'scheduled';
  db.transaction(() => {
    db.prepare("UPDATE tokens SET state = 'in_consult', started_at = ?, called_at = COALESCE(called_at, ?), arrived_at = COALESCE(arrived_at, ?) WHERE id = ?").run(at, at, at, tokenId);
    setFlag(t, 'doctor_requested', false);
    if (sessionStarted) {
      db.prepare("UPDATE sessions SET state = 'running', actual_start = COALESCE(actual_start, ?) WHERE id = ?").run(at, t.session_id);
      appendEvent({ sessionId: t.session_id, clinicId: s.clinic_id, type: 'session.started', payload: { actor: 'first_consultation', at }, at });
    }
    appendEvent({ sessionId: t.session_id, tokenId, clinicId: s.clinic_id, type: 'consultation.started', payload: {}, at });
  })();

  if (lastEnd) recordTurnover(s.doctor_id, at - lastEnd);
  const computed = recompute(t.session_id, { trigger: 'consultation.started' });
  if (sessionStarted) announceSession(t.session_id, 'start');
  return tokenResult(tokenId, 'start', t.state, computed, { endedToken: ended?.token ?? null, endedInvoice: ended?.invoice ?? null });
}

/**
 * End a consultation. This is THE completion path — the simulator, the
 * session close and "End & next" all come through here — so the invoice is
 * raised here, exactly once. A second call is a 200 with the same invoice
 * and no new events: the most-pressed button on the board gets double-tapped.
 */
export function endConsult(tokenId, { extraLines = [] } = {}) {
  const t = requireToken(tokenId);
  assertToken(t, 'end');
  if (t.state === 'completed') {
    return { token: tokenView(tokenId), projection: readProjection(t.session_id), invoice: billing.invoiceForToken(tokenId, extraLines), noop: true };
  }
  const s = requireSession(t.session_id);
  const doctor = getDoctor.get(s.doctor_id);
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
  const invoice = billing.invoiceForToken(tokenId, extraLines);
  return tokenResult(tokenId, 'end', t.state, recompute(t.session_id, { trigger: 'consultation.ended' }), { invoice });
}

export function extendConsult(tokenId, minutes = 10) {
  const t = requireToken(tokenId);
  minutes = num(minutes, 'minutes', { min: 1, max: 120 });
  assertToken(t, 'extend');
  db.prepare('UPDATE tokens SET extra_minutes = extra_minutes + ? WHERE id = ?').run(Math.round(minutes), tokenId);
  appendEvent({ sessionId: t.session_id, tokenId, type: 'consultation.extended', payload: { minutes } });
  return tokenResult(tokenId, 'extend', t.state, recompute(t.session_id, { trigger: 'consultation.extended' }));
}

export function setNote(tokenId, note) {
  const t = requireToken(tokenId);
  assertToken(t, 'note');
  db.prepare('UPDATE tokens SET note = ? WHERE id = ?').run(note, tokenId);
  return { token: announceToken(tokenId, 'note', t.state), projection: readProjection(t.session_id) };
}

export function markNoShow(tokenId) {
  const t = requireToken(tokenId);
  assertToken(t, 'no-show');
  const at = now();
  db.transaction(() => {
    db.prepare("UPDATE tokens SET state = 'no_show' WHERE id = ?").run(tokenId);
    appendEvent({ sessionId: t.session_id, tokenId, type: 'token.no_show', payload: {}, at });
  })();
  return tokenResult(tokenId, 'no-show', t.state, recompute(t.session_id, { trigger: 'token.no_show' }));
}

export function cancelToken(tokenId, by = 'patient') {
  const t = requireToken(tokenId);
  assertToken(t, 'cancel');
  db.transaction(() => {
    db.prepare("UPDATE tokens SET state = 'cancelled' WHERE id = ?").run(tokenId);
    appendEvent({ sessionId: t.session_id, tokenId, type: 'token.cancelled', payload: { by } });
  })();
  return tokenResult(tokenId, 'cancel', t.state, recompute(t.session_id, { trigger: 'token.cancelled' }));
}

export function reinstate(tokenId) {
  const t = requireToken(tokenId);
  assertToken(t, 'reinstate');
  const s = requireSession(t.session_id);
  if (s.state === 'ended' || s.state === 'cancelled') {
    throw HttpError.conflict('session_closed', `${t.display} cannot be reinstated: the session has finished. Book them into another session.`);
  }
  db.transaction(() => {
    db.prepare("UPDATE tokens SET state = 'arrived', seq = ?, penalty_count = 0, arrived_at = COALESCE(arrived_at, ?) WHERE id = ?")
      .run(tailSeq(t.session_id), now(), tokenId);
    appendEvent({ sessionId: t.session_id, tokenId, type: 'token.reinstated', payload: {} });
  })();
  return tokenResult(tokenId, 'reinstate', t.state, recompute(t.session_id, { trigger: 'token.reordered' }));
}

/**
 * Delay penalty. Configurable per clinic because clinic cultures genuinely
 * differ. Always reversible, always logged, and always explained to the patient
 * — a silent demotion is worse than no system at all.
 */
export function applyPenalty(tokenId, cause = 'not_present') {
  const t = requireToken(tokenId);
  assertToken(t, 'penalty');
  const s = requireSession(t.session_id);
  const policy = clinicSettings(s.clinic_id).penalty;
  const flags = parse(t.flags, []) || [];

  if (policy.travelFlagExemption && flags.includes('travel')) {
    // Flag for a human decision instead of applying the rule. A patient who
    // took a 3-hour ferry and got demoted for being 6 minutes late will never
    // come back — and will tell the island.
    setFlag(t, 'needs_decision', true);
    appendEvent({ sessionId: t.session_id, tokenId, type: 'token.penalty_deferred', payload: { cause } });
    return tokenResult(tokenId, 'penalty_deferred', t.state, recompute(t.session_id, { trigger: 'token.reordered' }), { needsDecision: true });
  }

  const count = t.penalty_count + 1;
  if (policy.penaltyMode === 'none') {
    return { token: tokenView(tokenId), projection: readProjection(t.session_id), noop: true };
  }
  if (count > policy.maxPenaltiesBeforeNoShow) return markNoShow(tokenId);

  const waiting = waitingList.all(t.session_id);
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
    // Where they were, so "undo" can put them back there — not at the front.
    appendEvent({
      sessionId: t.session_id, tokenId, type: 'token.penalised',
      payload: { cause, count, mode: policy.penaltyMode, previousSeq: t.seq, previousState: t.state },
    });
  })();
  // A fresh call after the penalty must reach the patient again.
  clearRule(tokenId, 'called');
  return tokenResult(tokenId, 'penalty', t.state, recompute(t.session_id, { trigger: 'token.penalised' }));
}

/** Undo the most recent penalty: back to where they were. The receptionist is the authority; we are the memory. */
export function revokePenalty(tokenId) {
  const t = requireToken(tokenId);
  const flags = parse(t.flags, []) || [];
  if (flags.includes('needs_decision') && t.state !== 'penalised') {
    // The deferred decision is "no penalty": clear the flag, keep the place.
    assertToken(t, 'note');
    setFlag(t, 'needs_decision', false);
    appendEvent({ sessionId: t.session_id, tokenId, type: 'token.penalty_waived', payload: {} });
    return tokenResult(tokenId, 'revoke-penalty', t.state, recompute(t.session_id, { trigger: 'token.reordered' }));
  }
  if (t.penalty_count === 0) {
    throw HttpError.conflict('no_penalty', `${t.display} has no penalty to undo.`, { code: 'no_penalty', tokenId, state: t.state });
  }
  assertToken(t, 'revoke-penalty');
  const last = db.prepare(`SELECT payload FROM events WHERE token_id = ? AND type = 'token.penalised'
                           ORDER BY seq DESC LIMIT 1`).get(tokenId);
  const payload = parse(last?.payload, {}) || {};
  let seq = payload.previousSeq;
  if (!Number.isFinite(seq)) {
    // Penalty recorded before we kept the old place: the least-wrong guess is the front.
    const head = db.prepare("SELECT MIN(seq) AS m FROM tokens WHERE session_id = ? AND state IN ('booked','arrived','called','penalised')")
      .get(t.session_id).m;
    seq = (head ?? 1000) - 250;
  }
  db.transaction(() => {
    db.prepare("UPDATE tokens SET state = 'arrived', seq = ?, penalty_count = MAX(0, penalty_count - 1), arrived_at = COALESCE(arrived_at, ?) WHERE id = ?")
      .run(seq, now(), tokenId);
    appendEvent({ sessionId: t.session_id, tokenId, type: 'token.penalty_revoked', payload: { restoredSeq: seq } });
  })();
  return tokenResult(tokenId, 'revoke-penalty', t.state, recompute(t.session_id, { trigger: 'token.reordered' }));
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
 *
 * A neighbour that is not a waiting token of the same session is refused: the
 * card above the drop target may have been called during the drag, and a
 * stale reference must not land the late-comer at the head of the queue.
 * `position` (0-based among waiting tokens) expresses the intent directly.
 */
export function reorder(tokenId, { afterTokenId = null, beforeTokenId = null, position = null } = {}) {
  const t = requireToken(tokenId);
  assertToken(t, 'reorder');
  const list = waitingList.all(t.session_id).filter((x) => x.id !== tokenId);
  const at = (ref, name) => {
    const i = list.findIndex((x) => x.id === ref);
    if (i < 0) {
      throw HttpError.conflict('invalid_reorder', 'The queue changed while you were dragging. Please try again.',
        { code: 'invalid_reorder', field: name, tokenId: ref });
    }
    return i;
  };

  let prev = null;
  let next = null;
  if (position != null) {
    const p = Math.min(list.length, num(position, 'position', { min: 0, int: true }));
    prev = p > 0 ? list[p - 1] : null;
    next = p < list.length ? list[p] : null;
  } else if (afterTokenId == null && beforeTokenId == null) {
    prev = list[list.length - 1] ?? null;
  } else {
    if (afterTokenId === tokenId || beforeTokenId === tokenId) {
      throw HttpError.conflict('invalid_reorder', `${t.display} cannot be placed next to itself.`, { code: 'invalid_reorder' });
    }
    const afterIdx = afterTokenId ? at(afterTokenId, 'afterTokenId') : -1;
    const beforeIdx = beforeTokenId ? at(beforeTokenId, 'beforeTokenId') : -1;
    prev = afterIdx >= 0 ? list[afterIdx] : (beforeIdx > 0 ? list[beforeIdx - 1] : null);
    next = beforeIdx >= 0 ? list[beforeIdx] : (afterIdx >= 0 && afterIdx + 1 < list.length ? list[afterIdx + 1] : null);
  }

  let seq;
  if (prev && next) seq = (prev.seq + next.seq) / 2;
  else if (prev) seq = prev.seq + 1000;
  else if (next) seq = next.seq - 1000;
  else seq = 1000;

  db.transaction(() => {
    db.prepare('UPDATE tokens SET seq = ? WHERE id = ?').run(seq, tokenId);
    appendEvent({ sessionId: t.session_id, tokenId, type: 'token.reordered', payload: { seq } });
  })();
  const computed = recompute(t.session_id, { trigger: 'token.reordered' });
  return tokenResult(tokenId, 'reorder', t.state, computed, { order: waitingList.all(t.session_id).map((x) => x.id) });
}

/** Move a token to a different doctor's session entirely. The patient is told; the old number is never reused. */
export function reassign(tokenId, targetSessionId) {
  const t = requireToken(tokenId);
  assertToken(t, 'reassign');
  const target = requireSession(targetSessionId);
  const from = t.session_id;
  if (targetSessionId === from) throw HttpError.conflict('same_session', `${t.display} is already with this doctor.`, { code: 'same_session' });
  if (target.state === 'ended' || target.state === 'cancelled') {
    throw HttpError.conflict('session_closed', `${getDoctor.get(target.doctor_id)?.name ?? 'That doctor'}'s session is closed to new tokens.`);
  }
  const previousDisplay = t.display;
  const display = nextDisplay(target);
  // A "called" token has not been called by the NEW doctor; everyone else keeps their state.
  const state = t.state === 'called' ? 'arrived' : t.state;
  db.transaction(() => {
    db.prepare('UPDATE tokens SET session_id = ?, seq = ?, display = ?, state = ?, called_at = NULL WHERE id = ?')
      .run(targetSessionId, tailSeq(targetSessionId), display, state, tokenId);
    appendEvent({ sessionId: targetSessionId, tokenId, type: 'token.reassigned', payload: { from, previousDisplay, display } });
  })();
  // New queue, new baseline: nothing said in the old one applies.
  clearLog(tokenId);

  const outgoing = recompute(from, { trigger: 'token.reordered' });
  announceToken(tokenId, 'reassigned_out', t.state, from, outgoing?.projection ?? null);
  const incoming = recompute(targetSessionId, { trigger: 'token.walk_in' });

  const token = getToken.get(tokenId);
  if (!token.notify_via_partner_only) {
    const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(t.patient_id);
    const entry = incoming?.projection.entries.find((e) => e.tokenId === tokenId);
    messaging.send({
      patient, clinicId: target.clinic_id, tokenId, template: 'reassigned', urgent: true,
      vars: {
        doctor: getDoctor.get(target.doctor_id)?.name ?? 'another doctor', token: display, previous: previousDisplay,
        window: entry ? messaging.windowText(entry) : 'soon',
      },
    });
  }
  return tokenResult(tokenId, 'reassign', t.state, incoming, { previousDisplay, fromSessionId: from });
}

/** Renormalise fractional ranks to integers. Runs at session close. */
export function renormalise(sessionId) {
  const rows = db.prepare('SELECT id FROM tokens WHERE session_id = ? ORDER BY seq, rowid').all(sessionId);
  const stmt = db.prepare('UPDATE tokens SET seq = ? WHERE id = ?');
  db.transaction(() => rows.forEach((r, i) => stmt.run((i + 1) * 1000, r.id)))();
}

/** The doctor asks for a specific patient next. Reception stays the queue authority; the board just shows the ask. */
export function requestNext(tokenId) {
  const t = requireToken(tokenId);
  if (!WAITING_STATES.includes(t.state)) throw invalid(tokenDetail(t, 'call'), t.state, 'request-next', { tokenId, display: t.display });
  setFlag(t, 'doctor_requested', true);
  appendEvent({ sessionId: t.session_id, tokenId, type: 'doctor.request_next', payload: {} });
  return { token: announceToken(tokenId, 'doctor_requested', t.state), projection: readProjection(t.session_id) };
}
