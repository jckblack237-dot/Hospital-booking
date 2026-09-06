/**
 * Pure projection: given the state of one session, produce a predicted start
 * window for every waiting token. No I/O, no side effects — which is what makes
 * the backtesting harness possible (replay any historical session against a
 * candidate estimator and measure P80 coverage before shipping it).
 *
 * See docs/04-dynamic-token-engine.md sections 3 and 4.
 */
import {
  fit, residualMs, isOverrunning, lnMean, lnVar, lnQuantile, normalInv, turnoverMs,
} from './duration-model.js';
import { clamp } from '../lib/util.js';

const MIN = 60_000;
const CHECK_IN_BUFFER_MS = 5 * MIN;
const WINDOW_Z = normalInv(0.9); // central 80% interval => [P10, P90]

export const WAITING_STATES = new Set(['booked', 'arrived', 'called', 'penalised']);

/**
 * Push a candidate start time past any blackout it lands inside.
 *
 * We move the START only. A doctor finishes the patient in front of them and
 * then breaks for prayer; they do not walk out mid-consultation. Modelling it
 * the other way rounds the wrong direction five times a day in this market.
 */
export function advance(t, blackouts) {
  let cursor = t;
  let moved = true;
  let guard = 0;
  while (moved && guard++ < 50) {
    moved = false;
    for (const b of blackouts) {
      const end = b.endsAt ?? b.expectedResumeAt ?? b.startsAt;
      if (cursor >= b.startsAt && cursor < end) {
        cursor = end;
        moved = true;
      }
    }
  }
  return cursor;
}

function normaliseBlackouts(session, blackouts, nowMs) {
  return blackouts
    .map((b) => {
      // An open-ended pause has no end yet. Treat it as running until the
      // expected resume time, or a rolling ten minutes if nobody said.
      if (b.open_ended || b.openEnded) {
        const resume = b.expected_resume_at ?? b.expectedResumeAt ?? nowMs + 10 * MIN;
        return { ...b, startsAt: b.starts_at ?? b.startsAt, endsAt: Math.max(resume, nowMs + MIN) };
      }
      return { ...b, startsAt: b.starts_at ?? b.startsAt, endsAt: b.ends_at ?? b.endsAt };
    })
    .filter((b) => b.endsAt > nowMs - 6 * 3_600_000)
    .sort((a, b) => a.startsAt - b.startsAt);
}

/**
 * Intraday correction. A doctor running long on every case this evening gets a
 * session-scoped multiplier within three or four patients, rather than waiting
 * for the nightly refit. Doctors have bad days, busy days, and Ramadan evenings.
 */
export function intradayFactor(completed) {
  if (!completed.length) return 1;
  let weight = 0;
  let acc = 0;
  const decay = 0.7;
  const recent = completed.slice(-8);
  for (let i = 0; i < recent.length; i++) {
    const w = decay ** (recent.length - 1 - i);
    acc += w * (recent[i].actualMinutes / Math.max(0.5, recent[i].expectedMinutes));
    weight += w;
  }
  return clamp(acc / weight, 0.7, 1.6);
}

function confidenceFor(sdMinutes, session, sampleSize) {
  if (session.state === 'scheduled') return sdMinutes < 10 ? 'medium' : 'low';
  if (sampleSize < 8) return sdMinutes < 8 ? 'medium' : 'low';
  if (sdMinutes <= 6) return 'high';
  if (sdMinutes <= 14) return 'medium';
  return 'low';
}

/**
 * @param {object} input
 * @param {object} input.session   session row
 * @param {object} input.doctor    doctor row
 * @param {Array}  input.tokens    all tokens of the session, any state
 * @param {Array}  input.blackouts blackout rows
 * @param {Map}    input.patients  patientId -> patient row (for travel time)
 * @param {number} input.now       virtual now
 * @param {number} [input.startDelaySdMinutes] spread of this doctor's historical
 *   start delay, used only while the session has not started yet
 */
export function project({ session, doctor, tokens, blackouts, patients, now, startDelaySdMinutes = 12 }) {
  const bl = normaliseBlackouts(session, blackouts, now);
  const turnover = turnoverMs(doctor.id);
  const specialty = doctor.specialty;

  const ordered = [...tokens].sort((a, b) => a.seq - b.seq);
  const inConsult = ordered.find((t) => t.state === 'in_consult') || null;
  const completed = ordered
    .filter((t) => t.state === 'completed' && t.started_at && t.ended_at)
    .map((t) => ({
      actualMinutes: (t.ended_at - t.started_at) / MIN,
      expectedMinutes: Math.exp(
        fit({ doctorId: doctor.id, specialty, visitType: t.visit_type, isNewPatient: t.visit_type === 'new' }).mu,
      ),
    }));
  const alpha = intradayFactor(completed);

  // ---- where the doctor becomes free -------------------------------------
  let freeAt;
  let inConsultInfo = null;
  if (session.state === 'ended' || session.state === 'cancelled') {
    freeAt = session.actual_end ?? session.scheduled_end;
  } else if (inConsult && inConsult.started_at) {
    const f = fit({
      doctorId: doctor.id, specialty, visitType: inConsult.visit_type,
      isNewPatient: inConsult.visit_type === 'new',
    });
    const elapsed = now - inConsult.started_at;
    const extra = (inConsult.extra_minutes || 0) * MIN;
    const residual = Math.max(residualMs(f.mu, f.sigma, elapsed) * alpha, extra ? extra - elapsed : 0);
    freeAt = now + residual;
    inConsultInfo = {
      tokenId: inConsult.id,
      display: inConsult.display,
      startedAt: inConsult.started_at,
      elapsedMinutes: Math.round(elapsed / MIN),
      residualMinutes: Math.round(residual / MIN),
      overrunning: isOverrunning(f.mu, f.sigma, elapsed),
    };
  } else if (session.state === 'running' || session.state === 'paused') {
    freeAt = Math.max(now, session.actual_start ?? session.scheduled_start);
  } else {
    freeAt = Math.max(now, session.scheduled_start + (session.delay_minutes || 0) * MIN);
  }

  // Variance already accumulated before the first waiting token: the in-flight
  // consultation is itself uncertain, and pretending otherwise is why queues
  // look precise and behave badly.
  let cumVar = 0;
  const contributions = [];

  // Before the doctor arrives, the dominant uncertainty is not the queue — it
  // is whether they start on time. Publishing a one-minute window at 16:40 for
  // a 17:00 session would be a confident lie.
  if (session.state === 'scheduled') {
    cumVar += startDelaySdMinutes * startDelaySdMinutes;
    contributions.push({ mu: Math.log(Math.max(1, startDelaySdMinutes)), sigma: 0.6, synthetic: true });
  }
  if (inConsultInfo) {
    const f = fit({
      doctorId: doctor.id, specialty, visitType: inConsult.visit_type,
      isNewPatient: inConsult.visit_type === 'new',
    });
    const sd = Math.min(inConsultInfo.residualMinutes * 0.6, Math.sqrt(lnVar(f.mu, f.sigma)));
    cumVar += sd * sd;
    contributions.push({ mu: f.mu, sigma: f.sigma });
  }

  const waiting = ordered.filter((t) => WAITING_STATES.has(t.state));
  const entries = [];
  const sessionEnd = session.scheduled_end;

  for (let i = 0; i < waiting.length; i++) {
    const t = waiting[i];
    const f = fit({
      doctorId: doctor.id, specialty, visitType: t.visit_type,
      isNewPatient: t.visit_type === 'new',
    });
    const meanMin = lnMean(f.mu, f.sigma) * alpha;
    const varMin = lnVar(f.mu, f.sigma) * alpha * alpha;

    const start = advance(Math.max(freeAt, now), bl);
    const startMean = start;
    const sdMinutes = Math.sqrt(cumVar);
    const half = WINDOW_Z * sdMinutes * MIN;

    let from;
    let to;
    let p50;
    if (contributions.length === 1 && !contributions[0].synthetic) {
      // A single uncertain duration ahead: use exact log-normal quantiles
      // rather than a normal approximation of one skewed variable.
      const base = start - lnMean(contributions[0].mu, contributions[0].sigma) * alpha * MIN;
      const q = (p) => base + lnQuantile(contributions[0].mu, contributions[0].sigma, p) * alpha * MIN;
      from = q(0.1); to = q(0.9); p50 = q(0.5);
    } else if (contributions.length === 0) {
      from = start; to = start; p50 = start;
    } else {
      from = startMean - half; to = startMean + half; p50 = startMean;
    }
    // No start time may fall inside a pause — the published quantiles have to
    // walk around a blackout exactly as the recurrence cursor does, or the app
    // shows a patient a time when the doctor is demonstrably not in the room.
    from = advance(Math.max(now, Math.min(from, startMean)), bl);
    p50 = advance(Math.max(p50, from), bl);
    to = advance(Math.max(to, p50), bl);
    to = Math.max(to, from + MIN);

    const patient = patients?.get(t.patient_id);
    const travelMs = (patient?.travel_minutes ?? 10) * MIN;
    // Arrive by the EARLY edge of the window. Leaving 10 minutes too early
    // costs a waiting room; leaving 10 minutes too late can forfeit the turn,
    // and for someone who took a ferry it can cost the whole day. Buy the
    // cheap error. (docs/04-dynamic-token-engine.md section 3.4)
    const leaveAt = from - travelMs - CHECK_IN_BUFFER_MS;

    entries.push({
      tokenId: t.id,
      display: t.display,
      patientId: t.patient_id,
      state: t.state,
      source: t.source,
      partnerId: t.partner_id,
      position: i + 1,
      tokensAhead: i + (inConsult ? 1 : 0),
      predictedStart: {
        p50: Math.round(p50),
        window: { from: Math.round(from), to: Math.round(to) },
        confidence: confidenceFor(sdMinutes, session, f.n),
        sdMinutes: Number(sdMinutes.toFixed(1)),
      },
      leaveAt: Math.round(leaveAt),
      leaveNow: now >= leaveAt && t.state !== 'called',
      atRisk: startMean > sessionEnd,
      expectedMinutes: Number(meanMin.toFixed(1)),
    });

    cumVar += varMin;
    contributions.push({ mu: f.mu, sigma: f.sigma });
    freeAt = start + meanMin * MIN + turnover;
  }

  const runningLate = session.actual_start
    ? Math.round((session.actual_start - session.scheduled_start) / MIN)
    : Math.round(((session.delay_minutes || 0) * MIN) / MIN);

  const activePause = bl.find((b) => b.startsAt <= now && b.endsAt > now) || null;

  return {
    sessionId: session.id,
    doctorId: doctor.id,
    state: session.state,
    computedAt: now,
    runningLateMinutes: runningLate,
    intradayFactor: Number(alpha.toFixed(2)),
    turnoverSeconds: Math.round(turnover / 1000),
    nowServing: inConsultInfo,
    pause: activePause
      ? { kind: activePause.kind, from: activePause.startsAt, expectedResumeAt: activePause.endsAt }
      : null,
    tokensWaiting: waiting.length,
    projectedEnd: Math.round(freeAt),
    overrunMinutes: Math.max(0, Math.round((freeAt - sessionEnd) / MIN)),
    entries,
  };
}
