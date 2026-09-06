/**
 * Consultation duration model.
 *
 * Durations are log-normal: a hard floor of a few minutes, a dense mode, and a
 * long right tail of genuinely complex cases. Modelling the mean is the mistake
 * that produces optimistic drift, because the mean of a right-skewed
 * distribution understates how bad the tail is for the people at the back of
 * the queue.
 *
 * See docs/04-dynamic-token-engine.md section 3.
 */
import { db } from '../db.js';
import { now } from '../lib/clock.js';
import { clamp } from '../lib/util.js';

const MIN_MINUTES = 3;
const SHRINK_K = 20; // observations of the parent bucket the child must outweigh

/** Cold-start priors: median minutes and sigma of ln(duration), per specialty. */
export const SPECIALTY_PRIORS = {
  general_practice: { median: 9, sigma: 0.42 },
  internal_medicine: { median: 12, sigma: 0.46 },
  paediatrics: { median: 12, sigma: 0.44 },
  obgyn: { median: 15, sigma: 0.48 },
  cardiology: { median: 18, sigma: 0.5 },
  dermatology: { median: 10, sigma: 0.4 },
  ent: { median: 10, sigma: 0.42 },
  ophthalmology: { median: 11, sigma: 0.4 },
  orthopaedics: { median: 14, sigma: 0.46 },
  dental: { median: 20, sigma: 0.5 },
  psychiatry: { median: 25, sigma: 0.45 },
  physiotherapy: { median: 25, sigma: 0.35 },
  _default: { median: 12, sigma: 0.45 },
};

const VISIT_FACTOR = { new: 1.25, follow_up: 0.85, review: 0.8, procedure: 1.5 };

// ---------------------------------------------------------------- statistics

export function erf(x) {
  // Abramowitz & Stegun 7.1.26 — max absolute error 1.5e-7, ample here.
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}

export const normalCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/** Inverse normal CDF (Acklam's rational approximation). */
export function normalInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Moments of a log-normal, in the same unit as the fit (minutes). */
export const lnMean = (mu, sigma) => Math.exp(mu + (sigma * sigma) / 2);
export const lnVar = (mu, sigma) => (Math.exp(sigma * sigma) - 1) * Math.exp(2 * mu + sigma * sigma);
export const lnQuantile = (mu, sigma, p) => Math.exp(mu + sigma * normalInv(p));

// ------------------------------------------------------------------ buckets

export function bucketChain({ doctorId, specialty, visitType, isNewPatient }) {
  const spec = specialty || 'general_practice';
  const vt = visitType || 'new';
  return [
    'global',
    `s:${spec}`,
    `s:${spec}|v:${vt}`,
    `d:${doctorId}`,
    `d:${doctorId}|v:${vt}`,
    `d:${doctorId}|v:${vt}|n:${isNewPatient ? 1 : 0}`,
  ];
}

const readStat = db.prepare('SELECT n, sum_ln, sum_ln2 FROM duration_stats WHERE bucket = ?');
const upsertStat = db.prepare(`
  INSERT INTO duration_stats (bucket, n, sum_ln, sum_ln2, updated_at)
  VALUES (@bucket, 1, @ln, @ln2, @at)
  ON CONFLICT(bucket) DO UPDATE SET
    n = n + 1, sum_ln = sum_ln + @ln, sum_ln2 = sum_ln2 + @ln2, updated_at = @at
`);

function statFor(bucket) {
  const row = readStat.get(bucket);
  if (!row || row.n < 1) return null;
  const mu = row.sum_ln / row.n;
  const variance = Math.max(0.02 ** 2, row.sum_ln2 / row.n - mu * mu);
  return { n: row.n, mu, sigma: Math.sqrt(variance) };
}

/**
 * Hierarchical shrinkage. Walk the chain from least to most specific, blending
 * each level toward the prior accumulated so far. A doctor's third-ever
 * consultation must not move their estimate by ten minutes.
 */
export function fit({ doctorId, specialty, visitType, isNewPatient, fallbackMinutes }) {
  const prior = SPECIALTY_PRIORS[specialty] || SPECIALTY_PRIORS._default;
  const seedMedian = (fallbackMinutes || prior.median) * (VISIT_FACTOR[visitType] ?? 1);
  let mu = Math.log(Math.max(MIN_MINUTES, seedMedian));
  let sigma = prior.sigma;
  let n = 0;
  let parentN = 0;

  for (const bucket of bucketChain({ doctorId, specialty, visitType, isNewPatient })) {
    const s = statFor(bucket);
    if (!s) continue;
    // A level whose count equals its parent's holds exactly the same
    // observations — it adds no information, and blending again would count
    // the same evidence twice. This is the common case early on, when a
    // doctor's few consultations are also the entire specialty bucket.
    if (s.n === parentN) continue;
    const w = s.n / (s.n + SHRINK_K);
    mu = w * s.mu + (1 - w) * mu;
    sigma = Math.sqrt(w * s.sigma * s.sigma + (1 - w) * sigma * sigma);
    parentN = s.n;
    n = Math.max(n, s.n);
  }
  return { mu, sigma: clamp(sigma, 0.15, 0.9), n };
}

/** Record an observed consultation. Called once, on consultation end. */
export function record({ doctorId, specialty, visitType, isNewPatient, durationMs }) {
  const minutes = durationMs / 60000;
  if (!(minutes > 0.5) || minutes > 240) return; // ignore mis-clicks and forgotten sessions
  const ln = Math.log(minutes);
  const at = now();
  for (const bucket of bucketChain({ doctorId, specialty, visitType, isNewPatient })) {
    upsertStat.run({ bucket, ln, ln2: ln * ln, at });
  }
}

// ----------------------------------------------------------- in-flight case

const residualMemo = new Map();

/**
 * Conditional expected residual, E[D - e | D > e], in ms.
 *
 * The naive estimate is `expected - elapsed`, which goes negative the moment a
 * consultation overruns — and negative remaining time is exactly how a board
 * ends up saying "next patient at 18:40" at 18:52. For a log-normal this
 * residual INCREASES with elapsed time: a consultation already running 20
 * minutes is evidence of a complex case, and complex cases run longer still.
 */
export function residualMs(mu, sigma, elapsedMs) {
  const elapsedMin = Math.max(0.25, elapsedMs / 60000);
  const key = `${mu.toFixed(3)}|${sigma.toFixed(3)}|${Math.round(elapsedMin * 2)}`;
  const hit = residualMemo.get(key);
  if (hit !== undefined) return hit;

  const z = (Math.log(elapsedMin) - mu) / sigma;
  const tail = 1 - normalCdf(z);
  let expected;
  if (tail < 1e-6) {
    // Deep in the tail the ratio is numerically unstable; fall back to the
    // asymptotic hazard of the log-normal, which grows slowly.
    expected = elapsedMin * (1 + sigma * sigma);
  } else {
    expected = (lnMean(mu, sigma) * normalCdf(sigma - z)) / tail;
  }
  const p99 = lnQuantile(mu, sigma, 0.99);
  // Cap at the bucket's 99th percentile so a single pathological case cannot
  // send the whole queue's projection to infinity. The board raises an
  // operational flag when this cap binds (see isOverrunning).
  const residual = clamp(expected - elapsedMin, 0.5, Math.max(1, p99));
  const ms = residual * 60000;
  if (residualMemo.size < 20000) residualMemo.set(key, ms);
  return ms;
}

/** True when the current consultation has run past its own 95th percentile. */
export function isOverrunning(mu, sigma, elapsedMs) {
  return elapsedMs / 60000 > lnQuantile(mu, sigma, 0.95);
}

// ------------------------------------------------------------------ turnover

const readTurnover = db.prepare('SELECT n, sum_ms FROM turnover_stats WHERE doctor_id = ?');
const upsertTurnover = db.prepare(`
  INSERT INTO turnover_stats (doctor_id, n, sum_ms) VALUES (?, 1, ?)
  ON CONFLICT(doctor_id) DO UPDATE SET n = n + 1, sum_ms = sum_ms + excluded.sum_ms
`);

export const DEFAULT_TURNOVER_MS = 120_000;

export function turnoverMs(doctorId) {
  const row = readTurnover.get(doctorId);
  if (!row || row.n < 3) return DEFAULT_TURNOVER_MS;
  return clamp(row.sum_ms / row.n, 15_000, 600_000);
}

export function recordTurnover(doctorId, gapMs) {
  if (gapMs > 5_000 && gapMs < 900_000) upsertTurnover.run(doctorId, gapMs);
}

export function resetMemo() {
  residualMemo.clear();
}
