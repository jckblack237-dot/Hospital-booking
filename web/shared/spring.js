/**
 * One critically damped spring per axis (damping 1.0, response 0.3 s): a
 * release carries the finger's velocity into the animation, so there is no
 * seam between dragging and settling, and nothing ever bounces.
 *
 *   spring({ from, to, velocity, onUpdate, onSettle }) → { retarget(to), cancel(), value, velocity }
 *
 * velocity is px/s. Semi-implicit Euler at rAF with dt clamped to 1/30 s so a
 * dropped frame never overshoots. Settles at |x − to| < 0.5 px and |v| < 10 px/s.
 */
const RESPONSE = 0.3;
export const K = (2 * Math.PI / RESPONSE) ** 2;   // 438.65
export const C = 2 * Math.sqrt(K);                // 41.89

export function spring({ from = 0, to = 0, velocity = 0, onUpdate, onSettle } = {}) {
  const s = { value: from, velocity, target: to, done: false };
  let raf = 0;
  let last = 0;
  const step = (t) => {
    raf = 0;
    if (s.done) return;
    const dt = last ? Math.min(1 / 30, (t - last) / 1000) : 1 / 60;
    last = t;
    // Sub-step at 240 Hz: stable for k ≈ 440 even when a frame is late.
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -K * (s.value - s.target) - C * s.velocity;
      s.velocity += a * h;
      s.value += s.velocity * h;
    }
    if (Math.abs(s.value - s.target) < 0.5 && Math.abs(s.velocity) < 10) {
      s.value = s.target; s.velocity = 0; s.done = true;
      onUpdate?.(s.value);
      onSettle?.();
      return;
    }
    onUpdate?.(s.value);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return {
    get value() { return s.value; },
    get velocity() { return s.velocity; },
    get done() { return s.done; },
    /** Keeps the current value and velocity: an interrupted spring never jumps. */
    retarget(to) { s.target = to; if (s.done) { s.done = false; last = 0; raf = requestAnimationFrame(step); } },
    cancel() { s.done = true; cancelAnimationFrame(raf); raf = 0; },
  };
}

/** Apple's momentum projection: where a flick would come to rest (d = 0.998). */
export const project = (velocity, d = 0.998) => (velocity / 1000) * d / (1 - d);

/** Soft boundary: the further past the edge, the less the element follows. */
export const rubberband = (overshoot, dimension, constant = 0.55) => (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));

/** Release velocity (px/s) from the last few samples [{x, y, t}] within `window` ms. */
export function releaseVelocity(samples, window = 100) {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const last = samples[samples.length - 1];
  let first = samples[0];
  for (const s of samples) { if (last.t - s.t <= window) { first = s; break; } }
  const dt = last.t - first.t;
  if (dt <= 0) return { vx: 0, vy: 0 };
  return { vx: ((last.x - first.x) / dt) * 1000, vy: ((last.y - first.y) / dt) * 1000 };
}
