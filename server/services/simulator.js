/**
 * Clinic day simulator.
 *
 * A queue product is unobservable without a queue moving through it. This
 * drives doctors through their sessions — starting late, running over, pausing
 * for prayer, occasionally losing a patient to a no-show — so the board, the
 * tracker and the notification cascade can be watched end to end.
 *
 * It only ever calls the same public queue-service functions the real Doctor
 * Module calls. There is no privileged path into the engine.
 */
import { db } from '../db.js';
import { now, MINUTE, getSpeed } from '../lib/clock.js';
import * as queue from './queue.js';
import * as world from './ground-truth.js';

const running = new Map(); // sessionId -> config

export function enable(sessionId, config = {}) {
  running.set(sessionId, {
    startLateMinutes: config.startLateMinutes ?? world.startLatenessMinutes(),
    noShowChance: config.noShowChance ?? 0.06,
    pauseChance: config.pauseChance ?? 0.02,
    nextActionAt: null,
    phase: 'waiting',
  });
  return { sessionId, ...running.get(sessionId) };
}

export function disable(sessionId) {
  running.delete(sessionId);
}

export function status() {
  return [...running.entries()].map(([sessionId, c]) => ({ sessionId, ...c }));
}

/**
 * Draw from the GROUND TRUTH, never from the engine's own fitted model.
 *
 * Sampling the estimator and then adding an extra overrun multiplier on top —
 * which an earlier version of this file did — makes live durations
 * systematically longer than anything the model could have predicted, and the
 * optimism-bias metric then reports a simulator bug as an engine bug.
 */
function drawDuration(doctor, token) {
  return world.durationMinutes(doctor.specialty, token.visit_type) * MINUTE;
}

export function tick() {
  const at = now();
  for (const [sessionId, cfg] of running) {
    // A refused transition on one doctor's session must not stall the others.
    try {
      step(sessionId, cfg, at);
    } catch (err) {
      console.error(`[simulator] ${sessionId}`, err.detail ?? err.message);
    }
  }
  return { sessions: running.size, speed: getSpeed(), at };
}

function step(sessionId, cfg, at) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session || session.state === 'ended' || session.state === 'cancelled') {
    running.delete(sessionId);
    return;
  }
  const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(session.doctor_id);

  if (session.state === 'scheduled') {
    if (at >= session.scheduled_start + cfg.startLateMinutes * MINUTE) {
      if (cfg.startLateMinutes > 5) queue.delaySession(sessionId, cfg.startLateMinutes);
      queue.startSession(sessionId, 'simulator');
    }
    return;
  }

  if (session.state === 'paused') {
    const pause = db.prepare('SELECT * FROM blackouts WHERE session_id = ? AND open_ended = 1 ORDER BY starts_at DESC LIMIT 1').get(sessionId);
    if (!pause || at >= (pause.expected_resume_at ?? at)) queue.resumeSession(sessionId);
    return;
  }

  const inConsult = db.prepare("SELECT * FROM tokens WHERE session_id = ? AND state = 'in_consult'").get(sessionId);

  if (inConsult) {
    if (cfg.endAt == null) {
      cfg.endAt = (inConsult.started_at ?? at) + drawDuration(doctor, inConsult);
    }
    if (at >= cfg.endAt) {
      queue.endConsult(inConsult.id);
      cfg.endAt = null;
      cfg.freeUntil = at + world.turnoverMs();
    }
    return;
  }

  if (cfg.freeUntil && at < cfg.freeUntil) return;

  // Prayer blackouts are honoured by the projector; the simulated doctor
  // honours them too, otherwise the board and reality diverge.
  const blocked = db.prepare(`SELECT 1 FROM blackouts WHERE session_id = ? AND starts_at <= ?
                              AND COALESCE(ends_at, expected_resume_at) > ?`).get(sessionId, at, at);
  if (blocked) return;

  // Patients drift in ahead of their turn, which is what makes arrival-to-seen
  // wait times measurable at all.
  for (const waiting of db.prepare(`SELECT t.id, t.arrived_at FROM tokens t WHERE t.session_id = ?
                                    AND t.state = 'booked' AND t.arrived_at IS NULL ORDER BY t.seq LIMIT 3`).all(sessionId)) {
    if (Math.random() < 0.35) queue.checkIn(waiting.id);
  }

  const next = db.prepare(`SELECT * FROM tokens WHERE session_id = ?
                           AND state IN ('booked','arrived','called','penalised') ORDER BY seq LIMIT 1`).get(sessionId);
  if (!next) {
    if (at > session.scheduled_end) queue.endSession(sessionId);
    return;
  }

  if (Math.random() < cfg.pauseChance) {
    queue.pauseSession(sessionId, { kind: 'emergency', expectedMinutes: 8 + Math.round(Math.random() * 12) });
    return;
  }

  if (next.state !== 'called') {
    queue.callToken(next.id);
    cfg.calledAt = at;
    // A patient who is not in the building yet stays called, so the real
    // grace-period and penalty path gets exercised. Everyone else walks
    // straight in — splitting call and start across ticks would add a
    // per-patient delay the estimator cannot see, and the optimism-bias
    // metric would report that artefact as a model defect.
    cfg.absent = Math.random() < cfg.noShowChance && !next.arrived_at && !next.on_my_way;
    if (cfg.absent) return;
  } else if (cfg.absent && !next.arrived_at && !next.on_my_way) {
    return;
  }

  queue.startConsult(next.id);
  cfg.absent = false;
  cfg.endAt = null;
}
