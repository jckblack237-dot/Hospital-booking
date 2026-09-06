/**
 * DEMO ONLY — "the world", not the model.
 *
 * The seed and the live simulator both draw consultation durations from here.
 * The engine's estimator (server/engine/duration-model.js) never sees this file;
 * it has to learn the same distribution from observed events.
 *
 * Keeping one definition matters: if the seeded history and the live simulator
 * disagree, the P80-coverage metric measures the disagreement rather than the
 * quality of the estimator, and we would "fix" the engine to chase an artefact.
 */
export const SPECIALTY_MEDIAN_MINUTES = {
  internal_medicine: 12, paediatrics: 12, ent: 10, obgyn: 15,
  general_practice: 9, dermatology: 10, cardiology: 18, ophthalmology: 11,
  orthopaedics: 14, dental: 20, psychiatry: 25,
};

export const SIGMA = 0.45;
export const VISIT_FACTOR = { new: 1.25, follow_up: 0.85, review: 0.8, procedure: 1.5 };

/** ~18% of consultations genuinely run long — the right tail the model must learn. */
export const OVERRUN_CHANCE = 0.18;

/**
 * Optional deterministic source, so the calibration harness is reproducible.
 * Unseeded (the demo) it is just Math.random.
 *
 * This matters more than it looks: with only a few hundred historical
 * consultations the FITTED model is itself the dominant source of error — the
 * measured bias moved by several minutes run to run purely because the
 * estimator had learned a slightly different distribution. A flaky calibration
 * test is worse than none, because it teaches you to ignore the one number
 * that says whether patients should believe the estimate.
 */
let rngState = null;

export function seed(value) {
  rngState = value === null ? null : (value >>> 0);
}

export function random() {
  if (rngState === null) return Math.random();
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function normalSample() {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Minutes. */
export function durationMinutes(specialty, visitType) {
  const median = (SPECIALTY_MEDIAN_MINUTES[specialty] ?? 12) * (VISIT_FACTOR[visitType] ?? 1);
  const overrun = random() < OVERRUN_CHANCE ? 1.8 + random() * 0.8 : 1;
  return Math.max(2, Math.exp(Math.log(median) + SIGMA * normalSample()) * overrun);
}

/** Between-patient turnover, in ms. */
export function turnoverMs() {
  return (45 + random() * 165) * 1000;
}

/** How late a doctor starts a session, in minutes. */
export function startLatenessMinutes() {
  return Math.max(0, Math.round(normalSample() * 12 + 8));
}
