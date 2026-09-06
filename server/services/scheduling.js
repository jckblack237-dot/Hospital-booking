/**
 * Scheduling: sessions, slots, availability.
 *
 * Sessions, not "9-to-5 with lunch". Maldivian clinics commonly run split
 * sessions (09:00-12:00, 16:00-18:00, 20:00-22:00) with the evening busiest,
 * and the weekend is Friday-Saturday. Nothing here assumes otherwise.
 */
import { db } from '../db.js';
import { now, MINUTE } from '../lib/clock.js';
import { id, parse } from '../lib/util.js';
import { mvStartOfDay, prayerBlackouts, isWeekend } from '../lib/mvtime.js';

export function createSession({ clinicId, doctorId, start, end, slotMinutes = 12, walkinReservePct = 20 }) {
  const sessionId = id('ses');
  db.prepare(`INSERT INTO sessions (id, clinic_id, doctor_id, scheduled_start, scheduled_end, slot_minutes, walkin_reserve_pct)
              VALUES (?,?,?,?,?,?,?)`)
    .run(sessionId, clinicId, doctorId, start, end, slotMinutes, walkinReservePct);
  // Prayer pauses are first-class blackout intervals, seeded with the session.
  // An engine that models a session as a continuous block is visibly wrong five
  // times a day in this market.
  for (const b of prayerBlackouts(start, end)) {
    db.prepare('INSERT INTO blackouts (id, session_id, kind, starts_at, ends_at) VALUES (?,?,?,?,?)')
      .run(id('blk'), sessionId, 'prayer', b.startsAt, b.endsAt);
  }
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
}

export function sessionsForDay(clinicId, dayMs) {
  const from = mvStartOfDay(dayMs);
  return db.prepare(`SELECT s.*, d.name AS doctor_name, d.specialty, d.fee_minor, d.languages
                     FROM sessions s JOIN doctors d ON d.id = s.doctor_id
                     WHERE s.clinic_id = ? AND s.scheduled_start >= ? AND s.scheduled_start < ?
                     ORDER BY s.scheduled_start`)
    .all(clinicId, from, from + 86_400_000)
    .map((r) => ({ ...r, languages: parse(r.languages, []) }));
}

export function sessionsForDoctor(doctorId, from, to) {
  // Only sessions that can still be booked into: not cancelled, not closed.
  return db.prepare(`SELECT * FROM sessions WHERE doctor_id = ? AND scheduled_end > ? AND scheduled_start < ?
                     AND state NOT IN ('cancelled','ended') ORDER BY scheduled_start`).all(doctorId, from, to);
}

/**
 * Slots for a session. Capacity is the session length minus blackouts divided
 * by the slot length, less the walk-in reserve — some clinics genuinely hold
 * every fourth slot for people who turn up at the door, and the engine honours
 * that rather than overselling the session.
 */
export function slotsForSession(session, { partnerId = null } = {}) {
  const blackouts = db.prepare('SELECT * FROM blackouts WHERE session_id = ?').all(session.id);
  const taken = db.prepare(`SELECT COUNT(*) AS c FROM tokens WHERE session_id = ?
                            AND state NOT IN ('cancelled','no_show')`).get(session.id).c;
  const holds = db.prepare('SELECT slot_index FROM holds WHERE session_id = ? AND consumed = 0 AND expires_at > ?')
    .all(session.id, now()).map((h) => h.slot_index);

  const slots = [];
  const slotMs = session.slot_minutes * MINUTE;
  let cursor = session.scheduled_start;
  let index = 0;
  while (cursor + slotMs <= session.scheduled_end && index < 200) {
    const inBlackout = blackouts.some((b) => cursor >= b.starts_at && cursor < (b.ends_at ?? b.expected_resume_at ?? b.starts_at));
    if (!inBlackout) {
      slots.push({
        slot_id: `${session.id}:${index}`,
        index,
        starts_at: cursor,
        duration_minutes: session.slot_minutes,
        status: index < taken ? 'booked' : holds.includes(index) ? 'held' : 'available',
      });
      index++;
    }
    cursor += slotMs;
  }

  const reserve = Math.floor(slots.length * (session.walkin_reserve_pct / 100));
  const bookable = slots.slice(0, Math.max(0, slots.length - reserve));

  let allocation = null;
  if (partnerId) {
    const link = db.prepare('SELECT * FROM partner_clinic WHERE partner_id = ? AND clinic_id = ?')
      .get(partnerId, session.clinic_id);
    const pct = link?.allocation_pct ?? 0;
    const total = Math.floor(bookable.length * (pct / 100));
    const used = db.prepare('SELECT COUNT(*) AS c FROM tokens WHERE session_id = ? AND partner_id = ?')
      .get(session.id, partnerId).c;
    allocation = { total, used, remaining: Math.max(0, total - used) };
  }

  return { slots: bookable, allocation, reservedForWalkIns: reserve };
}

export function availability(doctorId, fromMs, toMs, { partnerId = null } = {}) {
  const sessions = sessionsForDoctor(doctorId, fromMs, toMs);
  return sessions.map((s) => {
    const { slots, allocation, reservedForWalkIns } = slotsForSession(s, { partnerId });
    return {
      session_id: s.id, clinic_id: s.clinic_id, state: s.state,
      starts_at: s.scheduled_start, ends_at: s.scheduled_end,
      slots, partner_allocation: allocation, reserved_for_walk_ins: reservedForWalkIns,
    };
  });
}

export function nextAvailable(doctorId, fromMs = now()) {
  const sessions = sessionsForDoctor(doctorId, fromMs, fromMs + 21 * 86_400_000);
  for (const s of sessions) {
    const { slots } = slotsForSession(s);
    const free = slots.find((sl) => sl.status === 'available' && sl.starts_at > fromMs);
    if (free) return { session_id: s.id, starts_at: free.starts_at, slot_id: free.slot_id };
  }
  return null;
}

export function createHold({ sessionId, slotIndex, partnerId = null, ttlMs = 120_000 }) {
  const existing = db.prepare('SELECT * FROM holds WHERE session_id = ? AND slot_index = ? AND consumed = 0 AND expires_at > ?')
    .get(sessionId, slotIndex, now());
  if (existing) return null;
  const holdId = id('hld');
  db.prepare('INSERT INTO holds (id, session_id, slot_index, partner_id, expires_at) VALUES (?,?,?,?,?)')
    .run(holdId, sessionId, slotIndex, partnerId, now() + ttlMs);
  return { hold_id: holdId, expires_at: now() + ttlMs };
}

export function consumeHold(holdId) {
  const hold = db.prepare('SELECT * FROM holds WHERE id = ?').get(holdId);
  if (!hold || hold.consumed || hold.expires_at < now()) return null;
  db.prepare('UPDATE holds SET consumed = 1 WHERE id = ?').run(holdId);
  return hold;
}

export function expireHolds() {
  return db.prepare('DELETE FROM holds WHERE consumed = 0 AND expires_at < ?').run(now() - 60_000).changes;
}

export { isWeekend };
