/**
 * Attention model — everything in the clinic that needs a human, most urgent
 * first. Pure: no DOM, no clock of its own. One shape drives the strip chip
 * dots, the "needs you" count and (part 2) the two time-critical toasts, so
 * the three surfaces can never disagree about what is urgent.
 */
export const CALLED_AFTER_MS = 120000;        // called ≥2 min without Start
export const MOVE_BACK_SOON_MS = 60000;       // toast when the automatic move-back is <60 s away
export const SESSION_LATE_AFTER_MS = 120000;  // scheduled and >2 min past start+delay
export const DOCTOR_REQUEST_TTL_MS = 60000;

const LIVE = new Set(['booked', 'arrived', 'called', 'penalised']);
const OPEN = new Set(['scheduled', 'running', 'paused']);

/** A session is paused when either the row or the projection says so — one variable for pill, button and chip. */
export const isPaused = (session) => session.state === 'paused' || !!session.projection?.pause;

/**
 * attentionItems(board, now, policy, requests) →
 *   [{ kind, sessionId, tokenId?, display?, deadlineAt?, primary: { label, action }, secondary? }]
 * Kinds in order: called, doctor-request, session-late, break-over, overrun, at-risk.
 * A token appears in at most one item. `requests` = recent doctor.request messages [{ sessionId, tokenId, display, at }].
 */
export function attentionItems(board, now, policy, requests = []) {
  const items = [];
  const taken = new Set();
  const sessions = (board?.sessions ?? []).filter((s) => OPEN.has(s.state));
  const graceMs = (policy?.gracePeriodMinutes ?? 5) * 60000;

  // 1. Called and still not in the room.
  for (const s of sessions) {
    for (const t of s.tokens ?? []) {
      if (t.state !== 'called' || !t.called_at || now - t.called_at < CALLED_AFTER_MS) continue;
      taken.add(t.id);
      items.push({
        kind: 'called', sessionId: s.id, tokenId: t.id, display: t.display, deadlineAt: t.called_at + graceMs,
        primary: { label: 'Start', action: 'start' }, secondary: { label: 'Move back', action: 'penalty' },
      });
    }
  }
  // 2. A doctor asked for someone, within the last minute.
  for (const r of requests) {
    if (!r || now - r.at >= DOCTOR_REQUEST_TTL_MS) continue;
    if (!sessions.some((s) => s.id === r.sessionId)) continue;
    if (r.tokenId && taken.has(r.tokenId)) continue;
    if (r.tokenId) taken.add(r.tokenId);
    items.push({ kind: 'doctor-request', sessionId: r.sessionId, tokenId: r.tokenId ?? null, display: r.display ?? null, primary: { label: 'Call next', action: 'call' } });
  }
  // 3–5. Session-level: late start, break overran, consultation overrunning.
  for (const s of sessions) {
    const start = (s.scheduled_start ?? 0) + (s.delay_minutes || 0) * 60000;
    if (s.state === 'scheduled' && now - start > SESSION_LATE_AFTER_MS) {
      items.push({ kind: 'session-late', sessionId: s.id, primary: { label: 'Start session', action: 'start' }, secondary: { label: 'Running late…', action: 'delay' } });
    }
  }
  for (const s of sessions) {
    const pause = s.projection?.pause;
    if (isPaused(s) && pause?.expectedResumeAt && pause.expectedResumeAt < now) {
      items.push({ kind: 'break-over', sessionId: s.id, deadlineAt: pause.expectedResumeAt, primary: { label: 'Resume', action: 'resume' } });
    }
  }
  for (const s of sessions) {
    const ns = s.projection?.nowServing;
    if (ns?.overrunning && !taken.has(ns.tokenId)) {
      taken.add(ns.tokenId);
      items.push({ kind: 'overrun', sessionId: s.id, tokenId: ns.tokenId, display: ns.display, primary: { label: 'End & next', action: 'end' }, secondary: { label: '+10 min', action: 'extend' } });
    }
  }
  // 6. Live tokens the engine says may not be reached today.
  for (const s of sessions) {
    for (const t of s.tokens ?? []) {
      if (!LIVE.has(t.state) || !t.projection?.atRisk || taken.has(t.id)) continue;
      taken.add(t.id);
      items.push({ kind: 'at-risk', sessionId: s.id, tokenId: t.id, display: t.display, primary: { label: 'Move to…', action: 'reassign' }, secondary: { label: 'Open', action: 'open' } });
    }
  }
  return items;
}

/** Session ids that own at least one item — what the chip dots read. */
export function attentionSessions(items) {
  return new Set(items.map((i) => i.sessionId));
}
