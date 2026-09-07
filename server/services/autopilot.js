/**
 * Demo autopilot.
 *
 * A queue product is judged by whether the queue moves. In demo mode nobody
 * should have to press anything to see it move: the evening starts by itself
 * when the server boots, runs at a watchable speed, and when every doctor has
 * finished, the demo rolls on to the next working day with a fresh evening.
 * A restart — a deploy, a sleeping host waking up — resumes rather than
 * leaving the board frozen at 16:40 with nothing happening.
 *
 * Nothing here runs when VAGUTHU_DEMO=false. Real clinics have real doctors.
 */
import { db } from '../db.js';
import * as clock from '../lib/clock.js';
import { MINUTE, DAY } from '../lib/clock.js';
import { mvStartOfDay, mvParts, mvTime, isWeekend } from '../lib/mvtime.js';
import * as simulator from './simulator.js';
import * as queue from './queue.js';
import { seedClinicEvening } from '../seed.js';

export const enabled = () => process.env.VAGUTHU_DEMO !== 'false' && process.env.VAGUTHU_AUTOPILOT !== 'false';
/** ×10: a twelve-minute consultation takes about a minute to watch. */
export const SPEED = Number(process.env.VAGUTHU_DEMO_SPEED) || 10;

let rollAt = null;
let lastRollover = null;

const demoClinics = () => db.prepare("SELECT * FROM clinics WHERE json_extract(settings, '$.demoCredentials') IS NOT NULL ORDER BY rowid").all();
const liveSessions = () => db.prepare("SELECT * FROM sessions WHERE state IN ('scheduled','running','paused')").all();
const sessionsOn = (day) => db.prepare('SELECT * FROM sessions WHERE scheduled_start >= ? AND scheduled_start < ?').all(day, day + DAY);

function workingDayOnOrAfter(ms) {
  let d = mvStartOfDay(ms);
  while (isWeekend(d)) d += DAY;
  return d;
}
const nextWorkingDay = (day) => workingDayOnOrAfter(day + DAY);
const preSession = (day) => { const p = mvParts(day); return mvTime(p.year, p.month, p.day, 16, 40); };

/** Put every live session under the simulator and make sure the clock is moving. */
export function run() {
  for (const s of liveSessions()) {
    if (!simulator.status().some((x) => x.sessionId === s.id)) simulator.enable(s.id);
  }
  if (clock.getSpeed() === 1) clock.setSpeed(SPEED);
}

/** The demo's messaging wallets would drain after enough evenings; a demo clinic keeps topping up. */
function topUpWallets() {
  db.prepare(`UPDATE clinics SET settings = json_set(settings, '$.messagingWalletMinor', 250000)
              WHERE json_extract(settings, '$.demoCredentials') IS NOT NULL
              AND COALESCE(json_extract(settings, '$.messagingWalletMinor'), 0) < 50000`).run();
}

function startEvening(day) {
  const p = mvParts(day);
  const demoNow = preSession(day);
  clock.setTime(demoNow);
  for (const clinic of demoClinics()) seedClinicEvening(clinic, p, demoNow);
  topUpWallets();
  lastRollover = { day, at: Date.now() };
  run();
  console.log(`[autopilot] evening ready for ${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}, clock ×${clock.getSpeed()}`);
}

/**
 * On boot: resume today's evening if it has not been touched, otherwise close
 * whatever was left mid-evening and start the next working day's.
 */
export function boot() {
  if (!enabled()) return;
  const latest = db.prepare('SELECT MAX(scheduled_start) AS t FROM sessions').get().t;
  if (!latest) return;
  const day = mvStartOfDay(latest);
  const today = workingDayOnOrAfter(Date.now());
  const onDay = sessionsOn(day);
  if (day >= today && onDay.every((s) => s.state === 'scheduled')) {
    clock.setTime(preSession(day));
    run();
    return;
  }
  clock.setTime(Math.max(...onDay.map((s) => s.scheduled_end)) + 5 * MINUTE);
  for (const s of onDay) {
    if (s.state !== 'ended' && s.state !== 'cancelled') queue.endSession(s.id);
  }
  startEvening(day >= today ? nextWorkingDay(day) : today);
}

/**
 * Every tick: once the whole evening is over, let the end state sit briefly,
 * then roll on. A clinic that is still "open" three quarters of an hour after
 * its last session was meant to end is closed for it — the demo never drifts
 * past midnight with one straggler in the room.
 */
export function tick() {
  if (!enabled()) return;
  const lastEnd = db.prepare('SELECT MAX(scheduled_end) AS t FROM sessions').get().t;
  if (!lastEnd) return;
  const at = clock.now();
  const live = liveSessions();
  if (live.length ? at < lastEnd + 45 * MINUTE : at < lastEnd) { rollAt = null; return; }
  rollAt ??= at + (live.length ? 0 : 5 * MINUTE);
  if (at < rollAt) return;
  rollAt = null;
  for (const s of live) {
    simulator.disable(s.id);
    queue.endSession(s.id);
  }
  startEvening(nextWorkingDay(mvStartOfDay(lastEnd)));
}

export function status() {
  return { enabled: enabled(), speed: SPEED, lastRollover };
}
