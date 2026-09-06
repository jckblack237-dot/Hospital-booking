/**
 * Admin analytics.
 *
 * Four questions, and every figure here earns its place by answering one:
 * are my doctors running on time, how much money did we make and from whom,
 * how many patients and what happened to them, and is the clinic getting better?
 *
 * Punctuality is deliberately shaped as a SCHEDULING input, not a performance
 * score, and never leaves the clinic. See docs/02 section 5.3 — the whole
 * engine depends on doctors pressing the buttons, and they will stop if this
 * becomes a leaderboard.
 */
import { db } from '../db.js';
import { now, MINUTE } from '../lib/clock.js';
import { mvStartOfDay } from '../lib/mvtime.js';
import { fit, lnQuantile } from '../engine/duration-model.js';

const dayRange = (dayMs) => [mvStartOfDay(dayMs), mvStartOfDay(dayMs) + 86_400_000];

export function today(clinicId, at = now()) {
  const [from, to] = dayRange(at);
  const seen = db.prepare(`SELECT COUNT(*) AS c FROM tokens t JOIN sessions s ON s.id = t.session_id
                           WHERE s.clinic_id = ? AND t.state = 'completed' AND t.ended_at BETWEEN ? AND ?`).get(clinicId, from, to).c;
  const waiting = db.prepare(`SELECT COUNT(*) AS c FROM tokens t JOIN sessions s ON s.id = t.session_id
                              WHERE s.clinic_id = ? AND t.state IN ('booked','arrived','called','penalised')
                              AND s.scheduled_start BETWEEN ? AND ?`).get(clinicId, from, to).c;
  const wait = db.prepare(`SELECT AVG(t.started_at - t.arrived_at) AS avg FROM tokens t JOIN sessions s ON s.id = t.session_id
                           WHERE s.clinic_id = ? AND t.started_at IS NOT NULL AND t.arrived_at IS NOT NULL
                           AND t.started_at BETWEEN ? AND ?`).get(clinicId, from, to).avg;
  const revenue = db.prepare(`SELECT COALESCE(SUM(total_minor),0) AS s FROM invoices
                              WHERE clinic_id = ? AND created_at BETWEEN ? AND ?`).get(clinicId, from, to).s;
  const collected = db.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS s FROM payments
                                WHERE clinic_id = ? AND state = 'succeeded' AND at BETWEEN ? AND ?`).get(clinicId, from, to).s;
  const late = db.prepare(`SELECT s.id, d.name, s.actual_start, s.scheduled_start FROM sessions s JOIN doctors d ON d.id = s.doctor_id
                           WHERE s.clinic_id = ? AND s.scheduled_start BETWEEN ? AND ? AND s.state IN ('running','paused')`).all(clinicId, from, to)
    .map((r) => ({ name: r.name, lateMinutes: Math.round(((r.actual_start ?? now()) - r.scheduled_start) / MINUTE) }))
    .filter((r) => r.lateMinutes > 5);

  return {
    seen, waiting,
    avgWaitMinutes: wait ? Math.round(wait / MINUTE) : null,
    revenueMinor: revenue, collectedMinor: collected,
    doctorsRunningLate: late,
  };
}

/** Q1: are my doctors running on time? */
export function punctuality(clinicId, fromMs, toMs) {
  const rows = db.prepare(`SELECT s.*, d.name, d.specialty, d.slot_minutes FROM sessions s JOIN doctors d ON d.id = s.doctor_id
                           WHERE s.clinic_id = ? AND s.scheduled_start BETWEEN ? AND ? AND s.actual_start IS NOT NULL`)
    .all(clinicId, fromMs, toMs);

  const byDoctor = new Map();
  for (const r of rows) {
    if (!byDoctor.has(r.doctor_id)) {
      byDoctor.set(r.doctor_id, {
        doctorId: r.doctor_id, name: r.name, specialty: r.specialty,
        scheduledSlotMinutes: r.slot_minutes, sessions: 0, startDeltas: [], overruns: [], pauseMs: 0, consultMs: 0, scheduledMs: 0,
      });
    }
    const d = byDoctor.get(r.doctor_id);
    d.sessions++;
    d.startDeltas.push(Math.round((r.actual_start - r.scheduled_start) / MINUTE));
    if (r.actual_end) d.overruns.push(Math.round((r.actual_end - r.scheduled_end) / MINUTE));
    d.scheduledMs += r.scheduled_end - r.scheduled_start;

    const consults = db.prepare(`SELECT started_at, ended_at, visit_type FROM tokens
                                 WHERE session_id = ? AND state = 'completed' AND started_at IS NOT NULL`).all(r.id);
    for (const c of consults) d.consultMs += c.ended_at - c.started_at;
    const pauses = db.prepare('SELECT starts_at, ends_at FROM blackouts WHERE session_id = ?').all(r.id);
    for (const p of pauses) if (p.ends_at) d.pauseMs += p.ends_at - p.starts_at;
  }

  return [...byDoctor.values()].map((d) => {
    const durations = db.prepare(`SELECT t.started_at, t.ended_at, t.visit_type FROM tokens t JOIN sessions s ON s.id = t.session_id
                                  WHERE s.doctor_id = ? AND t.state = 'completed' AND t.started_at IS NOT NULL
                                  AND t.started_at BETWEEN ? AND ?`).all(d.doctorId, fromMs, toMs)
      .map((t) => (t.ended_at - t.started_at) / MINUTE).sort((a, b) => a - b);
    const q = (p) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * p))] : null);
    const f = fit({ doctorId: d.doctorId, specialty: d.specialty, visitType: 'follow_up', isNewPatient: false });
    const suggested = Math.max(5, Math.round(lnQuantile(f.mu, f.sigma, 0.6)));

    return {
      doctorId: d.doctorId, name: d.name, specialty: d.specialty, sessions: d.sessions,
      medianStartDelayMinutes: median(d.startDeltas),
      p90StartDelayMinutes: percentile(d.startDeltas, 0.9),
      medianOverrunMinutes: median(d.overruns),
      pauseMinutes: Math.round(d.pauseMs / MINUTE),
      utilisation: d.scheduledMs ? Number((d.consultMs / d.scheduledMs).toFixed(2)) : null,
      consultationMinutes: { p50: round1(q(0.5)), p90: round1(q(0.9)), n: durations.length },
      scheduledSlotMinutes: d.scheduledSlotMinutes,
      suggestedSlotMinutes: suggested,
      // The output the owner actually wants is a sentence, not a chart.
      finding: durations.length >= 8 && Math.abs(suggested - d.scheduledSlotMinutes) >= 2
        ? `${d.name}'s median consultation is ${round1(q(0.5))} min but is scheduled at ${d.scheduledSlotMinutes}. `
          + `Moving to ${suggested}-minute slots would cut average patient wait and cost about `
          + `${Math.max(0, Math.round((suggested - d.scheduledSlotMinutes) * 10 / suggested))} slots per session.`
        : null,
    };
  });
}

/** Q2: how much money did we make, and from whom? */
export function revenue(clinicId, fromMs, toMs) {
  const byPayer = db.prepare(`SELECT payer_type, COUNT(*) AS visits, SUM(total_minor) AS billed,
                              SUM(covered_minor) AS covered, SUM(patient_minor) AS patient
                              FROM invoices WHERE clinic_id = ? AND created_at BETWEEN ? AND ?
                              GROUP BY payer_type`).all(clinicId, fromMs, toMs);
  const byMethod = db.prepare(`SELECT method, COUNT(*) AS n, SUM(amount_minor) AS total FROM payments
                               WHERE clinic_id = ? AND state = 'succeeded' AND at BETWEEN ? AND ?
                               GROUP BY method`).all(clinicId, fromMs, toMs);
  const byDoctor = db.prepare(`SELECT d.name, COUNT(*) AS visits, SUM(i.total_minor) AS billed
                               FROM invoices i JOIN tokens t ON t.id = i.token_id
                               JOIN sessions s ON s.id = t.session_id JOIN doctors d ON d.id = s.doctor_id
                               WHERE i.clinic_id = ? AND i.created_at BETWEEN ? AND ? GROUP BY d.id
                               ORDER BY billed DESC`).all(clinicId, fromMs, toMs);
  const claims = db.prepare(`SELECT state, COUNT(*) AS n, SUM(amount_minor) AS value FROM claims
                             WHERE clinic_id = ? GROUP BY state`).all(clinicId);
  const ageing = db.prepare(`SELECT COUNT(*) AS n, SUM(amount_minor) AS value FROM claims
                             WHERE clinic_id = ? AND state IN ('submitted','resubmitted') AND submitted_at < ?`)
    .get(clinicId, now() - 30 * 86_400_000);
  return { byPayer, byMethod, byDoctor, claims, ageingOver30Days: ageing };
}

/** Q3: how many patients, and what happened to them? */
export function volume(clinicId, fromMs, toMs) {
  const bySource = db.prepare(`SELECT t.source, COUNT(*) AS n,
                               SUM(CASE WHEN t.state = 'no_show' THEN 1 ELSE 0 END) AS no_shows,
                               SUM(CASE WHEN t.state = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
                               FROM tokens t JOIN sessions s ON s.id = t.session_id
                               WHERE s.clinic_id = ? AND t.booked_at BETWEEN ? AND ? GROUP BY t.source`)
    .all(clinicId, fromMs, toMs);
  const byDay = db.prepare(`SELECT DATE(t.booked_at/1000 + 18000, 'unixepoch') AS day, COUNT(*) AS n
                            FROM tokens t JOIN sessions s ON s.id = t.session_id
                            WHERE s.clinic_id = ? AND t.booked_at BETWEEN ? AND ? GROUP BY day ORDER BY day`)
    .all(clinicId, fromMs, toMs);
  const byHour = db.prepare(`SELECT CAST(strftime('%H', t.booked_at/1000 + 18000, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS n
                             FROM tokens t JOIN sessions s ON s.id = t.session_id
                             WHERE s.clinic_id = ? AND t.booked_at BETWEEN ? AND ? GROUP BY hour ORDER BY hour`)
    .all(clinicId, fromMs, toMs);
  const waits = db.prepare(`SELECT (t.started_at - t.arrived_at) AS w FROM tokens t JOIN sessions s ON s.id = t.session_id
                            WHERE s.clinic_id = ? AND t.started_at IS NOT NULL AND t.arrived_at IS NOT NULL
                            AND t.started_at BETWEEN ? AND ?`).all(clinicId, fromMs, toMs).map((r) => r.w / MINUTE);
  const priority = db.prepare(`SELECT COUNT(*) AS n FROM tokens t JOIN sessions s ON s.id = t.session_id
                               WHERE s.clinic_id = ? AND t.priority_reason IS NOT NULL AND t.booked_at BETWEEN ? AND ?`)
    .get(clinicId, fromMs, toMs).n;
  const total = bySource.reduce((s, r) => s + r.n, 0);
  return {
    bySource, byDay, byHour, total,
    medianWaitMinutes: median(waits), p90WaitMinutes: percentile(waits, 0.9),
    priorityInsertions: priority,
    priorityRate: total ? Number((priority / total).toFixed(3)) : 0,
  };
}

/** Q4: is the clinic getting better? The row that matters most is P80 coverage. */
export function quality(clinicId, fromMs, toMs) {
  const rows = db.prepare(`SELECT a.* FROM eta_accuracy a JOIN sessions s ON s.id = a.session_id
                           WHERE s.clinic_id = ? AND a.actual_start BETWEEN ? AND ?`).all(clinicId, fromMs, toMs);
  const n = rows.length;
  const inside = rows.filter((r) => r.inside).length;
  const errors = rows.map((r) => r.error_ms / MINUTE);
  const messages = db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT token_id) AS tokens,
                               COALESCE(SUM(cost_minor),0) AS cost FROM messages
                               WHERE clinic_id = ? AND state = 'delivered' AND at BETWEEN ? AND ?`)
    .get(clinicId, fromMs, toMs);
  const tokens = db.prepare(`SELECT COUNT(*) AS n FROM tokens t JOIN sessions s ON s.id = t.session_id
                             WHERE s.clinic_id = ? AND t.state = 'completed' AND t.ended_at BETWEEN ? AND ?`)
    .get(clinicId, fromMs, toMs).n;
  const completeness = db.prepare(`SELECT
      SUM(CASE WHEN started_at IS NOT NULL AND ended_at IS NOT NULL THEN 1 ELSE 0 END) AS complete,
      COUNT(*) AS total FROM tokens t JOIN sessions s ON s.id = t.session_id
      WHERE s.clinic_id = ? AND t.state = 'completed' AND t.ended_at BETWEEN ? AND ?`).get(clinicId, fromMs, toMs);

  return {
    sample: n,
    p80Coverage: n ? Number((inside / n).toFixed(3)) : null,
    medianAbsErrorMinutes: median(errors.map(Math.abs)),
    // Positive bias means we are systematically optimistic. That is a bug, not
    // a tuning preference: it is the failure mode that destroys trust fastest.
    optimismBiasMinutes: n ? round1(errors.reduce((s, e) => s + e, 0) / n) : null,
    messagesPerToken: messages.tokens ? Number((messages.n / messages.tokens).toFixed(2)) : null,
    messagingCostMinor: messages.cost,
    eventCompleteness: completeness.total ? Number((completeness.complete / completeness.total).toFixed(3)) : null,
  };
}

export function weeklyDigest(clinicId, at = now()) {
  const to = at;
  const from = at - 7 * 86_400_000;
  const p = punctuality(clinicId, from, to);
  const v = volume(clinicId, from, to);
  const q = quality(clinicId, from, to);
  const r = revenue(clinicId, from, to);
  const findings = [];
  for (const d of p) if (d.finding) findings.push(d.finding);
  if (v.priorityRate > 0.2) {
    findings.push(`${Math.round(v.priorityRate * 100)}% of tokens were priority insertions this week. That is a scheduling problem, not a compassion problem.`);
  }
  if (q.optimismBiasMinutes != null && q.optimismBiasMinutes > 3) {
    findings.push(`Estimates ran ${q.optimismBiasMinutes} min optimistic on average. Patients are arriving before they are needed.`);
  }
  const rejected = r.claims.find((c) => c.state === 'rejected');
  if (rejected?.n) findings.push(`${rejected.n} claims worth MVR ${(rejected.value / 100).toFixed(0)} are sitting rejected.`);
  return { from, to, findings, punctuality: p, volume: v, quality: q, revenue: r };
}

// -------------------------------------------------------------------- helpers
function median(arr) {
  if (!arr?.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round1(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}
function percentile(arr, p) {
  if (!arr?.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return round1(s[Math.min(s.length - 1, Math.floor(s.length * p))]);
}
function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}
