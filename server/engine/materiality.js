/**
 * Notification materiality.
 *
 * The engine recomputes on every event. It must NOT notify on every recompute.
 * A patient should get 4-6 messages for a visit and every one should be worth
 * reading. Failure mode #2 in docs/04-dynamic-token-engine.md is notification
 * fatigue, and it is the one that quietly kills the product: they mute us, then
 * they miss the message that mattered.
 */
import { db } from '../db.js';
import { MINUTE } from '../lib/clock.js';

const POSITION_THRESHOLDS = [5, 3, 1];
const ETA_SHIFT_MS = 15 * MINUTE;
const DEBOUNCE_MS = 10 * MINUTE;
const PATIENT_CAP_MS = 5 * MINUTE;

/** Both ETA-movement rules read and write this one baseline. */
const ETA_BASELINE = 'eta_notified';

/** Urgent classes bypass debounce and the per-patient cap. */
export const URGENT = new Set(['called', 'penalised', 'session_cancelled', 'at_risk', 'leave_now']);

const PRIORITY = [
  'session_cancelled', 'called', 'penalised', 'at_risk', 'leave_now',
  'next', 'position', 'eta_changed', 'improved', 'paused', 'delayed',
];

const getLog = db.prepare('SELECT rule, at, value FROM notification_log WHERE token_id = ?');
const putLog = db.prepare(`
  INSERT INTO notification_log (token_id, rule, at, value) VALUES (?, ?, ?, ?)
  ON CONFLICT(token_id, rule) DO UPDATE SET at = excluded.at, value = excluded.value
`);
const lastForPatient = db.prepare(
  'SELECT MAX(at) AS at FROM messages WHERE patient_id = ? AND urgent = 0',
);

function logFor(tokenId) {
  const out = new Map();
  for (const row of getLog.all(tokenId)) out.set(row.rule, row);
  return out;
}

/**
 * Decide what, if anything, to tell the holder of one token.
 * @param {object} input
 * @param {string[]|null} [input.only] restrict to these rules (the ticker may
 *   only fire time-driven ones; an event recompute may fire any)
 * @returns {null | {rule: string, urgent: boolean, data: object}}
 */
export function evaluate({ entry, previous, session, now, only = null }) {
  if (!entry) return null;
  const log = logFor(entry.tokenId);
  let candidates = [];

  // Once per call. The engine recomputes every second while a patient walks
  // from the pharmacy; without this guard each recompute is another SMS.
  if (entry.state === 'called' && !log.has('called')) {
    candidates.push({ rule: 'called', data: {} });
  }
  if (entry.state === 'penalised' && previous?.state !== 'penalised') {
    candidates.push({ rule: 'penalised', data: { newWindow: entry.predictedStart.window } });
  }
  if (entry.atRisk && !log.has('at_risk')) {
    candidates.push({ rule: 'at_risk', data: {} });
  }
  if (entry.leaveNow && !log.has('leave_now') && entry.state !== 'called') {
    candidates.push({ rule: 'leave_now', data: { tokensAhead: entry.tokensAhead } });
  }
  if (entry.tokensAhead === 0 && !log.has('next') && entry.state !== 'called') {
    candidates.push({ rule: 'next', data: {} });
  }

  // Position thresholds fire on the DOWNWARD crossing only. A queue that
  // oscillates between 4 and 3 ahead sends one message, not six.
  const lowestFired = Number(log.get('position')?.value ?? Infinity);
  for (const threshold of POSITION_THRESHOLDS) {
    if (entry.tokensAhead <= threshold && threshold < lowestFired) {
      candidates.push({ rule: 'position', data: { threshold, tokensAhead: entry.tokensAhead }, value: String(threshold) });
      break;
    }
  }

  if (previous) {
    // ONE baseline for both directions: the last time we actually told this
    // patient a time. Keeping separate baselines lets an oscillating estimate
    // re-notify against a reference from moments ago, which is how a queue
    // that wobbles by a quarter of an hour sends fifty messages.
    const lastNotified = Number(log.get(ETA_BASELINE)?.value ?? previous.predictedStart.p50);
    const delta = entry.predictedStart.p50 - lastNotified;
    if (delta >= ETA_SHIFT_MS) {
      candidates.push({
        rule: 'eta_changed',
        data: { deltaMinutes: Math.round(delta / MINUTE), reason: entry.reason },
        value: String(entry.predictedStart.p50),
      });
    } else if (delta <= -ETA_SHIFT_MS) {
      // Improvements are notified too. They change behaviour, and they are how
      // a patient learns the estimate is worth believing.
      candidates.push({
        rule: 'improved',
        data: { deltaMinutes: Math.round(-delta / MINUTE) },
        value: String(entry.predictedStart.p50),
      });
    }
  }

  if (session.state === 'paused' && !log.has('paused')) {
    candidates.push({ rule: 'paused', data: {} });
  }
  if (session.state !== 'paused' && log.has('paused')) {
    db.prepare('DELETE FROM notification_log WHERE token_id = ? AND rule = ?').run(entry.tokenId, 'paused');
  }

  if (only) candidates = candidates.filter((c) => only.includes(c.rule));
  if (!candidates.length) return null;

  // Coalesce: if several rules fire inside one window, send the most important.
  candidates.sort((a, b) => PRIORITY.indexOf(a.rule) - PRIORITY.indexOf(b.rule));
  const chosen = candidates[0];
  const urgent = URGENT.has(chosen.rule);

  if (!urgent) {
    const recent = [...log.values()].some((r) => now - r.at < DEBOUNCE_MS);
    if (recent) return null;
    const patientLast = lastForPatient.get(entry.patientId)?.at;
    if (patientLast && now - patientLast < PATIENT_CAP_MS) return null;
  }

  putLog.run(entry.tokenId, chosen.rule, now, chosen.value ?? '1');
  if (chosen.rule === 'eta_changed' || chosen.rule === 'improved') {
    putLog.run(entry.tokenId, ETA_BASELINE, now, chosen.value);
  }
  // Any message that quotes a time resets the baseline too — the patient has
  // just been told a window, so that is what the next change is measured from.
  if (['leave_now', 'position', 'next', 'penalised'].includes(chosen.rule)) {
    putLog.run(entry.tokenId, ETA_BASELINE, now, String(entry.predictedStart.p50));
  }
  return { rule: chosen.rule, urgent, data: chosen.data, entry };
}

export function clearLog(tokenId) {
  db.prepare('DELETE FROM notification_log WHERE token_id = ?').run(tokenId);
}

/** Forget one rule so it may fire again — a re-call after a penalty must reach the patient. */
export function clearRule(tokenId, rule) {
  db.prepare('DELETE FROM notification_log WHERE token_id = ? AND rule = ?').run(tokenId, rule);
}
