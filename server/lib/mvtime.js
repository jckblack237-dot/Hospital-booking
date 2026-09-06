/**
 * Maldives time helpers. The country is UTC+05:00 with no daylight saving,
 * which makes this pleasantly simple: a fixed offset, no tz database needed.
 *
 * The weekend is Friday-Saturday. Nothing in the codebase may assume Sat-Sun.
 */
export const MV_OFFSET_MS = 5 * 3_600_000;

export function mvParts(ms) {
  const d = new Date(ms + MV_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(), // 0 Sun .. 6 Sat
  };
}

export function isWeekend(ms) {
  const wd = mvParts(ms).weekday;
  return wd === 5 || wd === 6; // Friday, Saturday
}

/** Local Maldives wall-clock date+time -> epoch ms. */
export function mvTime(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) - MV_OFFSET_MS;
}

/** Start of the Maldives day containing `ms`. */
export function mvStartOfDay(ms) {
  const p = mvParts(ms);
  return mvTime(p.year, p.month, p.day, 0, 0);
}

export function hhmm(ms) {
  const p = mvParts(ms);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function isoDate(ms) {
  const p = mvParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** RFC 3339 with the +05:00 offset, as the Partner API promises. */
export function rfc3339(ms) {
  if (ms == null) return null;
  const d = new Date(ms + MV_OFFSET_MS);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+05:00`
  );
}

/**
 * Approximate prayer times for Male'. Real deployments read the published
 * daily timetable; these fixed times are close enough for scheduling blackouts
 * in a demo and keep the seed data free of an external dependency.
 */
export const PRAYER_TIMES = [
  { name: 'fajr', hour: 4, minute: 45, minutes: 20 },
  { name: 'dhuhr', hour: 12, minute: 15, minutes: 20 },
  { name: 'asr', hour: 15, minute: 30, minutes: 20 },
  { name: 'maghrib', hour: 18, minute: 15, minutes: 20 },
  { name: 'isha', hour: 19, minute: 30, minutes: 20 },
];

/** Prayer blackout intervals overlapping [from, to). */
export function prayerBlackouts(from, to) {
  const out = [];
  for (let day = mvStartOfDay(from); day < to + 86_400_000; day += 86_400_000) {
    const p = mvParts(day);
    for (const pr of PRAYER_TIMES) {
      const start = mvTime(p.year, p.month, p.day, pr.hour, pr.minute);
      const end = start + pr.minutes * 60_000;
      if (end > from && start < to) out.push({ kind: 'prayer', name: pr.name, startsAt: start, endsAt: end });
    }
  }
  return out.sort((a, b) => a.startsAt - b.startsAt);
}
