import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../server/db.js';
import * as clock from '../server/lib/clock.js';
import { mvTime, prayerBlackouts, isWeekend } from '../server/lib/mvtime.js';
import {
  fit, record, recordTurnover, residualMs, lnQuantile, lnMean, normalCdf, normalInv,
} from '../server/engine/duration-model.js';
import { project, advance, intradayFactor } from '../server/engine/projector.js';
import * as world from '../server/services/ground-truth.js';

const MIN = 60_000;
const DAY = mvTime(2026, 9, 7, 0, 0);
const doctor = { id: 'doc_test', specialty: 'internal_medicine', slot_minutes: 12 };

function makeSession(overrides = {}) {
  return {
    id: 'ses_test', clinic_id: 'cln_test', doctor_id: doctor.id,
    scheduled_start: DAY + 17 * 3600_000, scheduled_end: DAY + 20 * 3600_000,
    slot_minutes: 12, state: 'running', actual_start: DAY + 17 * 3600_000,
    actual_end: null, delay_minutes: 0, walkin_reserve_pct: 20, version: 1,
    ...overrides,
  };
}

function makeTokens(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `tok_${i}`, session_id: 'ses_test', patient_id: `pat_${i}`,
    display: `A-${String(i + 1).padStart(2, '0')}`, seq: (i + 1) * 1000,
    source: 'app', visit_type: 'follow_up', state: 'booked', flags: '[]',
    penalty_count: 0, extra_minutes: 0, started_at: null, ended_at: null,
    arrived_at: null, called_at: null, on_my_way: 0,
    ...overrides,
  }));
}

const patients = new Map(
  Array.from({ length: 40 }, (_, i) => [`pat_${i}`, { id: `pat_${i}`, travel_minutes: 10 }]),
);

// ------------------------------------------------------------------ statistics
test('normal CDF and its inverse round-trip', () => {
  for (const p of [0.1, 0.25, 0.5, 0.8, 0.9, 0.975]) {
    assert.ok(Math.abs(normalCdf(normalInv(p)) - p) < 1e-3, `p=${p}`);
  }
});

test('log-normal quantiles are ordered and the mean exceeds the median', () => {
  const mu = Math.log(12);
  const sigma = 0.45;
  assert.ok(lnQuantile(mu, sigma, 0.1) < lnQuantile(mu, sigma, 0.5));
  assert.ok(lnQuantile(mu, sigma, 0.5) < lnQuantile(mu, sigma, 0.9));
  // Right-skewed: this is precisely why modelling the mean makes the back of
  // the queue systematically late.
  assert.ok(lnMean(mu, sigma) > lnQuantile(mu, sigma, 0.5));
});

// ------------------------------------------------------------ the in-flight case
test('residual is never negative, however long a consultation has run', () => {
  const { mu, sigma } = fit({ doctorId: doctor.id, specialty: 'internal_medicine', visitType: 'follow_up' });
  for (const elapsedMin of [1, 5, 10, 20, 45, 90, 180]) {
    const r = residualMs(mu, sigma, elapsedMin * MIN);
    assert.ok(r > 0, `elapsed ${elapsedMin}min gave residual ${r}`);
  }
});

test('residual GROWS once a consultation is into its tail', () => {
  const { mu, sigma } = fit({ doctorId: doctor.id, specialty: 'internal_medicine', visitType: 'follow_up' });
  const median = Math.exp(mu);
  const atMedian = residualMs(mu, sigma, median * MIN);
  const wayOver = residualMs(mu, sigma, median * 4 * MIN);
  // A consultation already running four times the median is evidence of a
  // complex case; naive `expected - elapsed` would be deeply negative here.
  assert.ok(wayOver > atMedian, `${wayOver} should exceed ${atMedian}`);
  assert.ok(lnMean(mu, sigma) * MIN - median * 4 * MIN < 0, 'naive estimate would be negative');
});

// ------------------------------------------------------------------- shrinkage
test('a handful of observations does not move the estimate far from the prior', () => {
  const before = fit({ doctorId: 'doc_new', specialty: 'paediatrics', visitType: 'new' });
  for (let i = 0; i < 3; i++) {
    record({ doctorId: 'doc_new', specialty: 'paediatrics', visitType: 'new', isNewPatient: true, durationMs: 45 * MIN });
  }
  const after = fit({ doctorId: 'doc_new', specialty: 'paediatrics', visitType: 'new' });
  const shift = Math.exp(after.mu) - Math.exp(before.mu);
  assert.ok(shift > 0, 'should move toward the observations');
  assert.ok(shift < 8, `three 45-minute outliers moved the median by ${shift.toFixed(1)} min`);
});

test('many consistent observations do move the estimate', () => {
  for (let i = 0; i < 200; i++) {
    record({ doctorId: 'doc_slow', specialty: 'ent', visitType: 'follow_up', isNewPatient: false, durationMs: 24 * MIN });
  }
  const f = fit({ doctorId: 'doc_slow', specialty: 'ent', visitType: 'follow_up' });
  assert.ok(Math.exp(f.mu) > 18, `learned median was ${Math.exp(f.mu).toFixed(1)} min`);
});

// ------------------------------------------------------------------- blackouts
test('advance() steps over a blackout interval', () => {
  const blackouts = [{ startsAt: 1000, endsAt: 5000 }];
  assert.equal(advance(500, blackouts), 500);
  assert.equal(advance(2000, blackouts), 5000);
  assert.equal(advance(6000, blackouts), 6000);
});

test('advance() steps over back-to-back blackouts', () => {
  const blackouts = [{ startsAt: 1000, endsAt: 5000 }, { startsAt: 5000, endsAt: 9000 }];
  assert.equal(advance(2000, blackouts), 9000);
});

test('prayer pauses land inside an evening session and are modelled', () => {
  const from = DAY + 18 * 3600_000;
  const to = DAY + 20 * 3600_000;
  const b = prayerBlackouts(from, to);
  assert.ok(b.length >= 2, 'maghrib and isha should both fall in an 18:00-20:00 session');
  assert.ok(b.every((x) => x.endsAt > x.startsAt));
});

test('the weekend is Friday and Saturday, never Saturday and Sunday', () => {
  assert.equal(isWeekend(mvTime(2026, 9, 4, 12, 0)), true, 'Friday');
  assert.equal(isWeekend(mvTime(2026, 9, 5, 12, 0)), true, 'Saturday');
  assert.equal(isWeekend(mvTime(2026, 9, 6, 12, 0)), false, 'Sunday is a working day');
});

// ------------------------------------------------------------------ projection
test('queue projection is ordered and windows widen further back', () => {
  const now = DAY + 17 * 3600_000 + 5 * MIN;
  const p = project({
    session: makeSession(), doctor, tokens: makeTokens(8), blackouts: [], patients, now,
  });
  assert.equal(p.entries.length, 8);
  for (let i = 1; i < p.entries.length; i++) {
    assert.ok(p.entries[i].predictedStart.p50 >= p.entries[i - 1].predictedStart.p50, 'starts must be ordered');
  }
  const first = p.entries[0].predictedStart;
  const last = p.entries[7].predictedStart;
  const width = (w) => w.window.to - w.window.from;
  // Uncertainty compounds down the queue, and the published window must say so.
  assert.ok(width(last) > width(first), 'the eighth token is less certain than the first');
  assert.ok(last.confidence !== 'high');
});

test('an in-flight consultation pushes the whole queue, and never into the past', () => {
  const now = DAY + 17 * 3600_000 + 40 * MIN;
  const tokens = makeTokens(5);
  tokens[0] = { ...tokens[0], state: 'in_consult', started_at: now - 38 * MIN };
  const p = project({ session: makeSession(), doctor, tokens, blackouts: [], patients, now });
  assert.ok(p.nowServing, 'the patient in the room is reported');
  assert.equal(p.nowServing.elapsedMinutes, 38);
  assert.ok(p.nowServing.overrunning, 'a 38-minute consultation is past its 95th percentile');
  for (const e of p.entries) {
    assert.ok(e.predictedStart.window.from >= now, 'no window may open in the past');
  }
});

test('a session that has not started publishes a wide, low-confidence window', () => {
  const now = DAY + 16 * 3600_000 + 40 * MIN;
  const p = project({
    session: makeSession({ state: 'scheduled', actual_start: null }),
    doctor, tokens: makeTokens(4), blackouts: [], patients, now, startDelaySdMinutes: 14,
  });
  const first = p.entries[0].predictedStart;
  // Publishing a one-minute window twenty minutes before the doctor has even
  // arrived would be a confident lie.
  assert.ok(first.window.to - first.window.from > 10 * MIN);
  assert.notEqual(first.confidence, 'high');
});

test('a scheduled pause is walked around, not through', () => {
  const now = DAY + 17 * 3600_000;
  const pause = { starts_at: now + 10 * MIN, ends_at: now + 30 * MIN, kind: 'prayer' };
  const withPause = project({ session: makeSession(), doctor, tokens: makeTokens(6), blackouts: [pause], patients, now });
  const without = project({ session: makeSession(), doctor, tokens: makeTokens(6), blackouts: [], patients, now });
  const last = (p) => p.entries[p.entries.length - 1].predictedStart.p50;
  assert.ok(last(withPause) > last(without), 'the prayer pause must push the tail of the queue back');
  for (const e of withPause.entries) {
    const inside = e.predictedStart.p50 > pause.starts_at && e.predictedStart.p50 < pause.ends_at;
    assert.ok(!inside, 'nobody may be predicted to start during the pause');
  }
});

test('leave-now targets the EARLY edge of the window, minus travel', () => {
  const now = DAY + 17 * 3600_000;
  const travellers = new Map([...patients].map(([k]) => [k, { id: k, travel_minutes: 35 }]));
  const p = project({ session: makeSession(), doctor, tokens: makeTokens(6), blackouts: [], patients: travellers, now });
  for (const e of p.entries) {
    // Ten minutes early costs a waiting room; ten minutes late can cost the
    // turn. We buy the cheap error deliberately.
    assert.ok(e.leaveAt < e.predictedStart.window.from, 'must leave before the window opens');
    assert.ok(e.predictedStart.window.from - e.leaveAt >= 35 * MIN, 'travel time must be subtracted in full');
  }
});

test('tokens beyond the session end are flagged at risk', () => {
  const now = DAY + 19 * 3600_000 + 30 * MIN;
  const p = project({ session: makeSession(), doctor, tokens: makeTokens(20), blackouts: [], patients, now });
  assert.ok(p.entries.some((e) => e.atRisk), 'a 20-deep queue at 19:30 cannot finish by 20:00');
  assert.ok(p.overrunMinutes > 0);
});

test('intraday factor tracks a doctor running long today, and is bounded', () => {
  assert.equal(intradayFactor([]), 1);
  const slow = intradayFactor(Array.from({ length: 6 }, () => ({ actualMinutes: 20, expectedMinutes: 10 })));
  assert.ok(slow > 1.2 && slow <= 1.6, `got ${slow}`);
  const fast = intradayFactor(Array.from({ length: 6 }, () => ({ actualMinutes: 3, expectedMinutes: 12 })));
  assert.ok(fast >= 0.7 && fast < 1, `got ${fast}`);
});

// -------------------------------------------------------- calibration harness
/**
 * The estimator is a claim about the world: 80% of actual starts should fall
 * inside the published 80% window. This replays synthetic sessions whose
 * durations come from the same ground truth the seed and simulator use, and
 * measures coverage directly — no HTTP, no ticker, no simulator granularity.
 *
 * This is the check that gates any change to the estimator.
 */
test('published P80 windows cover ~80% of actual starts', () => {
  clock.setTime(DAY + 17 * 3600_000);
  world.seed(20260906);
  const specialty = 'internal_medicine';
  const calDoctor = { id: 'doc_cal', specialty, slot_minutes: 12 };

  // Teach the model the world, the way three weeks of real sessions would —
  // including the between-patient turnover, which is a real and learnable part
  // of how fast a queue actually moves.
  // Months of history, not weeks: with only a few hundred observations the fit
  // is noisy enough to move the measured bias by several minutes on its own.
  for (let i = 0; i < 5000; i++) {
    const visitType = world.random() < 0.45 ? 'new' : 'follow_up';
    record({
      doctorId: calDoctor.id, specialty, visitType, isNewPatient: visitType === 'new',
      durationMs: world.durationMinutes(specialty, visitType) * MIN,
    });
    recordTurnover(calDoctor.id, world.turnoverMs());
  }

  const TRIALS = Number(process.env.CALIBRATION_TRIALS ?? 1500);
  let inside = 0;
  let total = 0;
  let signedError = 0;
  const LEAD = 15 * MIN;

  for (let trial = 0; trial < TRIALS; trial++) {
    const start = DAY + 17 * 3600_000;
    const tokens = makeTokens(10).map((t) => ({
      ...t, visit_type: world.random() < 0.45 ? 'new' : 'follow_up',
    }));
    const session = makeSession({ actual_start: start });

    // Publish windows at T0, then play the session forward for real.
    const published = project({ session, doctor: calDoctor, tokens, blackouts: [], patients, now: start });
    let cursor = start;
    for (let i = 0; i < tokens.length; i++) {
      const actualStart = cursor;
      const entry = published.entries[i];
      // Only score tokens whose window was published at a useful lead time.
      if (entry && actualStart - start >= LEAD) {
        total++;
        if (actualStart >= entry.predictedStart.window.from && actualStart <= entry.predictedStart.window.to) inside++;
        signedError += (actualStart - entry.predictedStart.p50) / MIN;
      }
      cursor += world.durationMinutes(specialty, tokens[i].visit_type) * MIN + world.turnoverMs();
    }
  }

  const coverage = inside / total;
  const bias = signedError / total;
  console.log(`      calibration: n=${total} coverage=${(coverage * 100).toFixed(1)}% bias=${bias.toFixed(1)} min`);
  assert.ok(total > 500, 'need a meaningful sample');
  assert.ok(coverage >= 0.7, `P80 coverage was ${(coverage * 100).toFixed(1)}% — the published window is too narrow`);
  assert.ok(coverage <= 0.97, `P80 coverage was ${(coverage * 100).toFixed(1)}% — the window is so wide it is useless`);
  // Positive bias means systematically optimistic, which is the failure that
  // destroys trust fastest. It is a bug, not a tuning preference.
  assert.ok(Math.abs(bias) < 2, `optimism bias was ${bias.toFixed(1)} min`);
  world.seed(null);
});
