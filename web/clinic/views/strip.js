/**
 * Doctor strip — the 48 px map above the board. One chip per session in column
 * order; the thumb under the chips marks which columns are on screen. This is
 * how paging the deck never means losing the clinic.
 *
 *   chipModel(session, now, attention)  pure: what a chip says
 *   createStrip(slot, hooks)            renders into the shell's <nav class="strip">
 *     .update(sessions, now, items)     patch chips, totals, needs-you count
 *     .sync()                           re-measure the thumb (resize, layout)
 *     .destroy()
 */
import { h, hhmm, patchList, SPECIALTY_LABELS } from '/shared/core.js';
import { isPaused, attentionSessions } from '/clinic/views/attention.js';

const OPEN = new Set(['scheduled', 'running', 'paused']);
const HERE = new Set(['arrived', 'called', 'penalised']);
const HOLD_MS = 350;
const HOLD_SLOP = 8;

const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const bareName = (name) => String(name || '').replace(/^Dr\.?\s+/i, '').trim();

/** Session state as the chip dot (mirrors the column pill's dot, §4.3). */
export function dotOf(session, now) {
  if (!OPEN.has(session.state)) return 'off';
  if (isPaused(session)) return 'called';
  if (session.state === 'scheduled') {
    const late = (now - ((session.scheduled_start ?? 0) + (session.delay_minutes || 0) * 60000)) / 60000;
    return late > 15 ? 'back' : late > 2 ? 'called' : 'hollow';
  }
  const late = session.projection?.runningLateMinutes ?? 0;
  return late > 15 ? 'back' : late > 5 ? 'called' : 'here';
}

function statusPhrase(session, now) {
  if (session.state === 'cancelled') return 'cancelled';
  if (session.state === 'ended') return 'finished';
  const pause = session.projection?.pause;
  if (isPaused(session)) return pause?.expectedResumeAt ? `paused until ${hhmm(pause.expectedResumeAt)}` : 'paused';
  const start = (session.scheduled_start ?? 0) + (session.delay_minutes || 0) * 60000;
  if (session.state === 'scheduled') {
    const late = Math.round((now - start) / 60000);
    return late > 2 ? `not started, ${late} minutes late` : `starts ${hhmm(start)}`;
  }
  const late = session.projection?.runningLateMinutes ?? 0;
  return late > 5 ? `running ${late} minutes late` : 'on time';
}

/**
 * chipModel(session, now, attention, { compactName }) — attention is a Set of
 * session ids with an item. compactName is resolved by chipModels() so two
 * doctors sharing a surname read "H. Waheed" / "A. Waheed".
 */
export function chipModel(session, now, attention, { compactName } = {}) {
  const tokens = session.tokens ?? [];
  const here = tokens.filter((t) => HERE.has(t.state)).length;
  const away = tokens.filter((t) => t.state === 'booked').length;
  const inRoom = tokens.filter((t) => t.state === 'in_consult').length;
  const seen = tokens.filter((t) => t.state === 'completed').length;
  const open = OPEN.has(session.state);
  const full = bareName(session.doctor_name);
  const words = full.split(/\s+/);
  const compact = compactName || words[words.length - 1] || full;
  const ns = session.projection?.nowServing;
  const pause = session.projection?.pause;
  let room = null;
  if (open && isPaused(session)) room = { kind: 'pause', glyph: '', text: pause?.expectedResumeAt ? hhmm(pause.expectedResumeAt) : '' }; // pause bars are drawn in CSS: no font has a reliable ⏸
  else if (open && ns) room = { kind: 'room', glyph: '▶', text: ns.display || '' };
  const cntFull = !open
    ? (session.state === 'cancelled' ? 'cancelled' : `${seen} seen`)
    : (here || away ? `${here} here · ${away} away` : 'nobody waiting');
  const parts = [session.doctor_name, statusPhrase(session, now)];
  if (open) { parts.push(`${here} here`, `${away} away`); if (ns) parts.push(`${ns.display} in the room`); } else parts.push(cntFull);
  return {
    id: session.id, dot: dotOf(session, now), name: full, compact, open, slim: !open,
    title: `${session.doctor_name} · ${SPECIALTY_LABELS[session.specialty] || titleCase(session.specialty)}`,
    here, away, inRoom, seen, cntFull, room, attn: !!attention?.has(session.id), label: parts.join(', '),
  };
}

/** All chips at once, with the compact-name collision rule applied. */
export function chipModels(sessions, now, attention) {
  const lastWords = new Map();
  for (const s of sessions) {
    const w = bareName(s.doctor_name).split(/\s+/);
    const last = w[w.length - 1];
    lastWords.set(last, (lastWords.get(last) || 0) + 1);
  }
  return sessions.map((s) => {
    const w = bareName(s.doctor_name).split(/\s+/);
    const last = w[w.length - 1];
    const compactName = lastWords.get(last) > 1 && w.length > 1 ? `${w[0][0]}. ${last}` : last;
    return chipModel(s, now, attention, { compactName });
  });
}

/** Clinic totals for the strip head: "14 here · 41 away · 3 in room", or the evening summary. */
export function totalsText(models) {
  const open = models.filter((m) => m.open);
  if (!models.length) return '';
  if (!open.length) {
    const seen = models.reduce((n, m) => n + m.seen, 0);
    return `Evening finished · ${seen} seen`;
  }
  const here = open.reduce((n, m) => n + m.here, 0);
  const away = open.reduce((n, m) => n + m.away, 0);
  const inRoom = open.reduce((n, m) => n + m.inRoom, 0);
  return `${here} here · ${away} away · ${inRoom} in room`;
}

// -------------------------------------------------------------------- render
function createChip(m, hooks) {
  const chip = h('button.chip', { type: 'button', tabindex: -1, dataset: { key: m.id, sessionId: m.id } },
    h('i.dot', { 'aria-hidden': true }),
    h('span.name.full'),
    h('span.name.compact', { 'aria-hidden': true }),
    h('span.cnt.full'),
    h('span.cnt.compact', { 'aria-hidden': true }, h('i.h'), h('b.hn'), h('i.a'), h('b.an')),
    h('span.room', { hidden: true }, h('span.g', { 'aria-hidden': true }), h('span.n.num')),
    h('i.attn', { hidden: true, 'aria-hidden': true }));

  // Press feedback on pointer-down (Safari delays :active on touch); a 350 ms
  // hold on a coarse pointer, or a right-click, opens the session menu.
  let hold = null; let held = false; let downAt = null;
  const clearHold = () => { clearTimeout(hold); hold = null; };
  chip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    chip.dataset.pressed = '';
    held = false; downAt = { x: e.clientX, y: e.clientY };
    if (e.pointerType !== 'mouse') {
      clearHold();
      hold = setTimeout(() => { held = true; delete chip.dataset.pressed; hooks.onContext?.(m.id, chip); }, HOLD_MS);
    }
  });
  chip.addEventListener('pointermove', (e) => {
    if (!downAt || !hold) return;
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > HOLD_SLOP) { clearHold(); delete chip.dataset.pressed; }
  });
  const release = () => { clearHold(); delete chip.dataset.pressed; };
  chip.addEventListener('pointerup', release);
  chip.addEventListener('pointercancel', release);
  chip.addEventListener('pointerleave', release);
  chip.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!held) hooks.onContext?.(m.id, chip); });
  chip.addEventListener('click', (e) => {
    if (held) { held = false; return; }
    hooks.onJump?.(m.id, { instant: e.detail === 0 }); // detail 0 = keyboard: no tween (P5)
  });
  return chip;
}

function updateChip(chip, m) {
  const r = chip._r || (chip._r = {
    dot: chip.querySelector('.dot'), name: chip.querySelector('.name.full'), short: chip.querySelector('.name.compact'), full: chip.querySelector('.cnt.full'),
    hn: chip.querySelector('.hn'), an: chip.querySelector('.an'), compact: chip.querySelector('.cnt.compact'),
    room: chip.querySelector('.room'), g: chip.querySelector('.room .g'), n: chip.querySelector('.room .n'), attn: chip.querySelector('.attn'),
  });
  const dotCls = `dot ${m.dot}`;
  if (r.dot.className !== dotCls) r.dot.className = dotCls;
  chip.classList.toggle('slim', m.slim);
  setText(r.name, m.name);
  setText(r.short, m.compact);
  if (chip.title !== m.title) chip.title = m.title;
  setText(r.full, m.cntFull);
  if (m.open) { setText(r.hn, String(m.here)); setText(r.an, String(m.away)); }
  if (r.compact.hidden !== !m.open) r.compact.hidden = !m.open;
  chip.classList.toggle('closed-cnt', !m.open);
  if (m.room) {
    if (r.room.hidden) r.room.hidden = false;
    const cls = `room ${m.room.kind}`;
    if (r.room.className !== cls) r.room.className = cls;
    setText(r.g, m.room.glyph); setText(r.n, m.room.text);
  } else if (!r.room.hidden) r.room.hidden = true;
  if (r.attn.hidden !== !m.attn) r.attn.hidden = !m.attn;
  if (chip.getAttribute('aria-label') !== m.label) chip.setAttribute('aria-label', m.label);
}

/**
 * createStrip(slot, { board, onJump(sessionId, {instant}), onContext(sessionId, chipEl), onNeeds() })
 */
export function createStrip(slot, hooks) {
  const totals = h('span.totals', { 'aria-hidden': true });
  const needs = h('button.needs', { type: 'button', hidden: true, role: 'status', onClick: () => hooks.onNeeds?.() },
    h('span', { 'aria-hidden': true }, '⚑ '), h('span.n'));
  const chips = h('div.chips');
  const thumb = h('i.thumb', { 'aria-hidden': true });
  slot.replaceChildren(totals, needs, chips, thumb);

  let board = hooks.board;
  let inView = new Set();
  let io = null;
  const observed = new WeakSet();
  let raf = 0;

  const chipOf = (id) => chips.querySelector(`.chip[data-session-id="${CSS.escape(id)}"]`);

  // Thumb: spans the chips of the columns on screen, fractional at both ends
  // so it tracks the finger continuously. Transform on the node only.
  function measure() {
    if (!board || !board.isConnected) return;
    const overflow = board.scrollWidth > board.clientWidth + 1;
    if (!overflow) { thumb.style.width = '0px'; return; }
    const L = board.scrollLeft; const R = L + board.clientWidth;
    let first = null; let last = null;
    for (const col of board.querySelectorAll(':scope > .col[data-key]')) {
      const chip = chipOf(col.dataset.key);
      if (!chip) continue;
      const left = col.offsetLeft; const width = col.offsetWidth || 1; const right = left + width;
      const a = Math.max(L, left); const b = Math.min(R, right);
      if (b - a <= 0) continue;
      const x1 = chip.offsetLeft + chip.offsetWidth * ((a - left) / width);
      const x2 = chip.offsetLeft + chip.offsetWidth * ((b - left) / width);
      if (first === null) first = x1;
      last = x2;
    }
    if (first === null) { thumb.style.width = '0px'; return; }
    const w = Math.max(0, last - first);
    const x = first - chips.scrollLeft + chips.offsetLeft;
    if (thumb._w !== w) { thumb.style.width = `${w}px`; thumb._w = w; }
    thumb.style.transform = `translateX(${x}px)`;
  }
  const schedule = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; measure(); }); };

  function applyCurrent() {
    let firstCurrent = null;
    for (const chip of chips.querySelectorAll('.chip')) {
      const cur = inView.has(chip.dataset.sessionId);
      if (cur) { chip.setAttribute('aria-current', 'true'); firstCurrent ||= chip; } else chip.removeAttribute('aria-current');
    }
    // Follow the desk's own paging: the current chip stays visible, instantly.
    firstCurrent?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'instant' });
  }

  function watch() {
    if (!board) return;
    if (!io) {
      io = new IntersectionObserver((entries) => {
        let changed = false;
        for (const e of entries) {
          const id = e.target.dataset.key;
          if (!id) continue;
          const on = e.isIntersecting && e.intersectionRatio >= 0.5;
          if (on && !inView.has(id)) { inView.add(id); changed = true; }
          if (!on && inView.has(id)) { inView.delete(id); changed = true; }
        }
        if (changed) { applyCurrent(); schedule(); }
      }, { root: board, threshold: [0.5] });
    }
    for (const col of board.querySelectorAll(':scope > .col[data-key]')) {
      if (observed.has(col)) continue;
      observed.add(col); io.observe(col);
    }
  }

  const onScroll = () => schedule();
  board?.addEventListener('scroll', onScroll, { passive: true });
  chips.addEventListener('scroll', onScroll, { passive: true });

  // Keyboard: one Tab stop; ←/→ move between chips; Enter/Space jump instantly.
  chips.addEventListener('keydown', (e) => {
    const list = [...chips.querySelectorAll('.chip')];
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = list[(i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
      for (const c of list) c.tabIndex = c === next ? 0 : -1;
      next.focus();
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault(); hooks.onContext?.(list[i].dataset.sessionId, list[i]);
    }
  });

  return {
    update(sessions, now, items) {
      const attention = attentionSessions(items || []);
      const models = chipModels(sessions, now, attention);
      setText(totals, totalsText(models));
      const label = `Doctors · ${totalsText(models)}`;
      if (slot.getAttribute('aria-label') !== label) slot.setAttribute('aria-label', label);
      const n = (items || []).length;
      if (needs.hidden !== !n) needs.hidden = !n;
      setText(needs.querySelector('.n'), n ? `${n} need${n === 1 ? 's' : ''} you` : '');
      patchList(chips, models, {
        key: (m) => m.id,
        create: (m) => createChip(m, hooks),
        update: (chip, m) => updateChip(chip, m),
        enter: () => {},
        exit: () => Promise.resolve(),
      });
      // Roving tabindex: exactly one chip is reachable by Tab.
      const list = chips.querySelectorAll('.chip');
      if (list.length && ![...list].some((c) => c.tabIndex === 0)) list[0].tabIndex = 0;
      watch();
      applyCurrent();
      schedule();
    },
    sync() { watch(); schedule(); },
    setBoard(el) {
      board?.removeEventListener('scroll', onScroll);
      board = el; io?.disconnect(); io = null; inView = new Set();
      board?.addEventListener('scroll', onScroll, { passive: true });
      watch(); schedule();
    },
    current: () => [...inView],
    destroy() {
      io?.disconnect(); io = null;
      board?.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf); raf = 0;
      slot.replaceChildren();
    },
  };
}
