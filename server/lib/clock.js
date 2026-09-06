/**
 * Virtual clock.
 *
 * Everything in the platform reads time through here rather than Date.now().
 * In production `speed` is 1 and `offset` is 0, so this is Date.now() with an
 * extra function call. In demo mode the clock can run fast (30x) or be moved to
 * a specific point in a clinic day, which is what makes a queue observable in a
 * few minutes instead of a few hours. The engine, the penalty timers and the
 * notification debounce all work unchanged because none of them ever call
 * Date.now() directly.
 */

let speed = 1;
let anchorReal = Date.now();
let anchorVirtual = Date.now();

export function now() {
  return Math.round(anchorVirtual + (Date.now() - anchorReal) * speed);
}

/** Re-anchor so the current virtual instant is preserved across a speed change. */
function reanchor() {
  anchorVirtual = now();
  anchorReal = Date.now();
}

export function setSpeed(next) {
  const n = Number(next);
  if (!Number.isFinite(n) || n <= 0 || n > 600) throw new Error('speed must be in (0, 600]');
  reanchor();
  speed = n;
  return speed;
}

export function getSpeed() {
  return speed;
}

export function setTime(ms) {
  anchorVirtual = Number(ms);
  anchorReal = Date.now();
  return anchorVirtual;
}

export function reset() {
  speed = 1;
  anchorReal = Date.now();
  anchorVirtual = Date.now();
}

export function state() {
  return { now: now(), speed, real: Date.now() };
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
