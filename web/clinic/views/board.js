/**
 * Queue board — a deck of doctor columns paged with a thumb, the doctor strip
 * as the map, colour spent only on state, one filled button per column.
 *
 * Lifecycle: mount() builds the skeleton once; update() PATCHES. Columns are
 * keyed by session.id and cards by token.id (patchList), so scroll, focus and
 * in-flight transitions survive every poll and socket message. state.ui
 * (openCard, wide, awayCollapsed, pending, drag) outlives every patch.
 *
 * Motion rule (P5): a remote change — poll, projection, another desk, the
 * simulator — commits under a transition suppressor (.main[data-remote] + a
 * forced style flush) so nothing on the board moves by itself. Only cards this
 * desk is acting on (state.ui.pending, state.ui.drag) are marked data-local and
 * may animate: their colour transitions, and a FLIP for them and the siblings
 * they displace.
 *
 * Forgiveness (P2): every token action is optimistic — state.board changes
 * first, the POST (Idempotency-Key) confirms from its response, a failure
 * reverts the snapshot and shows the server's own sentence. Undo toasts carry
 * the reverse; the only confirmations are the four session ones (§10.3).
 */
import {
  h, api, hhmm, mvr, toast, busy, patchList, reducedMotion, latest, debounce,
  SPECIALTY_LABELS, SOURCE_LABELS, LANGUAGE_LABELS,
} from '/shared/core.js';
import { openSheet, confirmSheet, segmented, chipRow, sheetRow, sheetOpen, closeSheet } from '/shared/sheet.js';
import { state, setTab, stripSlot } from '/clinic/app.js';
import { attentionItems, isPaused, DOCTOR_REQUEST_TTL_MS, MOVE_BACK_SOON_MS } from '/clinic/views/attention.js';
import { createStrip } from '/clinic/views/strip.js';
import { createDrag } from '/clinic/drag.js';

// ------------------------------------------------------------------ constants
const OPEN = new Set(['scheduled', 'running', 'paused']);
const PRESENT = new Set(['arrived', 'called', 'penalised']);
const WAITING = new Set(['booked', 'arrived', 'called', 'penalised']);
const DONE = new Set(['completed', 'no_show', 'cancelled']);
const GLYPH = { arrived: '●', called: '◐', penalised: '↩', in_consult: '▶', completed: '✓', no_show: '∅', cancelled: '×' };
const CHAIR = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 14V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7"/><path d="M6 14h20v6H6z"/><path d="M8 20v7M24 20v7M11 14v-3M21 14v-3"/></svg>';
const EMPTY = new Set();
const STRIP_PAD = 16;
const EASE_MOVE = bezier(.77, 0, .175, 1);
const EASE_MOVE_CSS = 'cubic-bezier(.77, 0, .175, 1)';
const EASE_OUT_CSS = 'cubic-bezier(.23, 1, .32, 1)';
const PRIORITY_REASONS = [['clinical_urgency', 'Clinical urgency'], ['elderly', 'Elderly'], ['pregnant', 'Pregnant'], ['disability', 'Disability'], ['travel_constraint', 'Travel constraint'], ['staff_referral', 'Staff referral']];
const PAUSE_KINDS = [['break', 'Break'], ['prayer', 'Prayer'], ['emergency', 'Emergency'], ['admin', 'Admin'], ['other', 'Other']];

// Same-value writes still queue mutation records and style work: every patch writes only what changed.
const setText = (el, v) => { if (el && el.textContent !== v) el.textContent = v; };
const setAttr = (el, name, v) => { if (el.getAttribute(name) !== v) el.setAttribute(name, v); };
const setHidden = (el, v) => { if (el.hidden !== !!v) el.hidden = !!v; };
const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const specialtyLabel = (s) => SPECIALTY_LABELS[s] || titleCase(s);
const sourceLabel = (s) => SOURCE_LABELS[s] || titleCase(s);
const shortDoctor = (name) => String(name || '').replace(/^Dr\.?\s+/i, '');
const tierOf = (st) => (st === 'in_consult' ? 'hero' : PRESENT.has(st) ? 'present' : st === 'booked' ? 'away' : 'done');
const present = (tokens) => tokens.filter((t) => PRESENT.has(t.state));
const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0);
const ordinal = (n) => { const m = n % 100; const suf = m > 10 && m < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'; return `${n}${suf}`; };
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const canAct = () => ['receptionist', 'admin'].includes(state.staff?.role);
const graceMs = () => (state.penaltyPolicy?.gracePeriodMinutes ?? 5) * 60000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sessionOf = (id) => (state.board?.sessions ?? []).find((s) => s.id === id);
const tokenOf = (id) => { for (const s of state.board?.sessions ?? []) { const t = s.tokens.find((x) => x.id === id); if (t) return t; } return null; };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ------------------------------------------------------------------- state.ui
function freshUi() {
  return {
    openCard: null, wide: new Set(), awayCollapsed: {}, pending: new Map(), drag: null, requests: new Map(), day: null,
    soonToasted: new Set(), requestToasted: new Set(), doneSheet: null,
  };
}
const ui = () => (state.ui ||= freshUi());
const uiKey = () => `vaguthu-board-ui:${state.board?.day ?? 'x'}`;
function loadUi() {
  const u = ui();
  if (u.day === state.board?.day) return;
  u.day = state.board?.day ?? null;
  u.wide = new Set(); u.awayCollapsed = {}; u.openCard = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(uiKey()) || 'null');
    if (saved) { u.wide = new Set(saved.wide || []); u.awayCollapsed = saved.awayCollapsed || {}; }
  } catch { /* private mode */ }
}
function persistUi() {
  const u = ui();
  try { sessionStorage.setItem(uiKey(), JSON.stringify({ wide: [...u.wide], awayCollapsed: u.awayCollapsed })); } catch { /* private mode */ }
}
const isSlim = (s) => !OPEN.has(s.state) && !ui().wide.has(s.id);

/** Sign-out: nothing of the last clinic survives on a shared tablet. */
export function reset() {
  closeSheet();
  state.ui = freshUi();
  clock.offset = 0;
  lastHere = -1;
}

// --------------------------------------------------------------- client clock
// One offset from the server, re-anchored by every /board, projection and
// tick; one 1 s interval patches [data-tick] text only. Nothing waits for a tick.
const clock = { offset: 0 };
function anchor(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return;
  const skew = Math.abs(Date.now() + clock.offset - ms);
  clock.offset = ms - Date.now();
  if (skew > 5000 && board) tickNodes(); // a jump: repatch now so no countdown runs backwards for more than a second
}
/** Clinic time now. state.serverNow already advances at the demo clock's speed, so never fall behind it. */
export const now = () => Math.max(Date.now() + clock.offset, state.serverNow || 0);

// ------------------------------------------------------------- module state
let container = null;
let board = null;
let emptyEl = null;
let strip = null;
let drag = null;
let ro = null;
let clockTimer = null;
let tween = null;
let snapTimer = null;
let lastHere = -1;

// --------------------------------------------------------------- public API
export function mount(el) {
  container = el;
  loadUi();
  board = h('div.board', {
    onClick: (e) => { if (ui().openCard && !e.target.closest('.tok')) { const id = ui().openCard; ui().openCard = null; patch(new Set([id])); } },
  });
  board.addEventListener('pointerdown', () => cancelTween(), { capture: true, passive: true });
  // Press feedback lands on pointerdown (Safari delays :active on touch); cleared on up, cancel or leave.
  board.addEventListener('pointerdown', (e) => { const b = e.target.closest('.btn, .done-row'); if (b) b.dataset.pressed = ''; });
  for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, clearPressed, true);
  board.addEventListener('pointerleave', clearPressed);
  emptyEl = h('div.board-empty', { hidden: true },
    h('span.glyph', { 'aria-hidden': true, html: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="24" height="21" rx="3"/><path d="M4 13h24M10 4v6M22 4v6"/></svg>' }),
    h('div.t', {}, 'No sessions today'),
    h('div.help', {}, 'Sessions are set up under Settings.'),
    h('button.btn.ghost', { type: 'button', onClick: () => setTab('settings') }, 'Open Settings'));
  container.replaceChildren(board, emptyEl);
  const slot = stripSlot();
  strip = slot ? createStrip(slot, {
    board,
    onJump: (id, opts) => jumpTo(id, opts),
    onContext: (id, anchorEl) => { jumpTo(id, { instant: true }); openSessionSheet(id, anchorEl); },
    onNeeds: () => { const first = attention()[0]; if (first) jumpTo(first.sessionId, { tokenId: first.tokenId, expand: !!first.tokenId }); },
  }) : null;
  drag = createDrag(board, {
    canDrag: (tok) => canAct() && !ui().drag && (tok.classList.contains('present') || tok.classList.contains('away')),
    listOk: (list) => { const s = sessionOf(list.closest('.col')?.dataset.key); return !!s && OPEN.has(s.state); },
    groupOf: (list, tier) => list.querySelector(tier === 'away' ? '.group.away' : '.group.present-group'),
    page: (dir) => pageBy(dir),
    onLift: ({ tokenId, group, index }) => {
      const t = tokenOf(tokenId);
      const sibs = [...group.children].filter((c) => c.classList.contains('tok') && !c.dataset.exiting && c.dataset.key !== tokenId);
      // The lift-time neighbours are what Undo puts the card back between.
      ui().drag = { tokenId, fromSession: t?.session_id ?? null, fromIndex: index, group: group.classList.contains('away') ? 'away' : 'present', afterId: sibs[index - 1]?.dataset.key ?? null, beforeId: sibs[index]?.dataset.key ?? null };
      if (ui().openCard === tokenId) ui().openCard = null;
    },
    onDrop: onDrop,
  });
  ro = new ResizeObserver(() => { if (layout()) patch(); strip?.sync(); }); // a width crossing 340 px changes card wording
  ro.observe(board);
  patch(); // first paint: a hard cut, it is a working surface opened every shift
  requestAnimationFrame(() => { lastHere = -1; if (board) syncTitle(state.board?.sessions ?? []); }); // after the shell has set its own title
  startClock();
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);
}
function clearPressed() { for (const el of document.querySelectorAll('.board [data-pressed]')) delete el.dataset.pressed; }

export function update(reason, payload) {
  if (!board) return;
  switch (reason) {
    case 'board': loadUi(); anchor(state.board?.serverNow); patch(); break;
    case 'projection': anchor(payload?.computedAt); patch(); break;
    case 'tick': anchor(payload?.serverNow); tickNodes(); break;
    case 'doctor.request':
      if (payload?.sessionId) ui().requests.set(payload.sessionId, { ...payload, at: now() });
      patch();
      requestToast(payload);
      break;
    default: patch(); // 'render', 'token', 'session'
  }
}

export function unmount() {
  stopClock();
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('visibilitychange', onVisibility);
  for (const ev of ['pointerup', 'pointercancel']) document.removeEventListener(ev, clearPressed, true);
  cancelTween();
  closeSheet();
  drag?.destroy(); drag = null;
  ui().drag = null;
  ro?.disconnect(); ro = null;
  strip?.destroy(); strip = null;
  container?.replaceChildren();
  container = board = emptyEl = null;
}

/** The column's next thing. Mirrors the server's state machine so the filled button never 409s (P1). */
export function primaryOf(session, paused = isPaused(session)) {
  if (session.state === 'scheduled') return { kind: 'session', action: 'start', label: 'Start session' };
  if (paused) return { kind: 'session', action: 'resume', label: 'Resume' };
  if (!OPEN.has(session.state)) return null;
  const t = session.tokens ?? [];
  const hero = t.find((x) => x.state === 'in_consult');
  if (hero) return { kind: 'token', token: hero, action: 'end', label: 'End & next' };
  const called = present(t).find((x) => x.state === 'called');
  if (called) return { kind: 'token', token: called, action: 'start', label: 'Start' };
  const here = present(t).find((x) => x.state === 'arrived' || x.state === 'penalised');
  if (here) return { kind: 'token', token: here, action: 'call', label: 'Call' };
  return null;
}

const attention = () => attentionItems(state.board, now(), state.penaltyPolicy, [...ui().requests.values()]);

// ------------------------------------------------------------------ patching
/**
 * Every state → DOM pass. `local` = token ids this desk is acting on; only
 * their cards (and the siblings they displace) may move or recolour.
 * Everything else commits under the suppressor.
 */
function patch(local = EMPTY) {
  if (!board) return;
  const main = board.closest('.main') || container;
  const sessions = state.board?.sessions ?? [];
  setHidden(emptyEl, sessions.length > 0);
  setHidden(board, !sessions.length);
  const slot = stripSlot(); if (slot) setHidden(slot, !sessions.length);
  for (const [id, r] of ui().requests) if (now() - r.at > DOCTOR_REQUEST_TTL_MS) ui().requests.delete(id);

  main.dataset.remote = '';
  for (const el of board.querySelectorAll('[data-local]')) el.removeAttribute('data-local');
  for (const id of local) board.querySelector(`.tok[data-key="${CSS.escape(id)}"]`)?.setAttribute('data-local', '');
  const before = local.size && !reducedMotion() ? measure(local) : null;

  const items = columnItems(sessions);
  layout(items);
  patchList(board, items, {
    key: (s) => s.id,
    create: createColumn,
    update: (node, s) => updateColumn(node, s, local),
    enter: () => {},
    exit: () => Promise.resolve(),
  });
  void main.offsetWidth; // commit under transition:none, then re-enable for the next local change
  delete main.dataset.remote;
  if (before) flip(before, local);

  strip?.update(sessions, now(), attention());
  tickNodes();
  syncTitle(sessions);
  if (ui().doneSheet) patchDoneSheet();
}

/** FLIP, part 1: presentation rects (mid-flight transforms included) of every card, keyed by token, plus which columns hold the local cards. */
function measure(local) {
  const rects = new Map();
  const cols = new Set();
  for (const tok of board.querySelectorAll('.tok[data-key]')) {
    if (tok.dataset.exiting) continue;
    rects.set(tok.dataset.key, tok.getBoundingClientRect());
    if (local.has(tok.dataset.key)) cols.add(tok.closest('.col'));
  }
  for (const id of local) for (const a of board.querySelector(`.tok[data-key="${CSS.escape(id)}"]`)?.getAnimations() ?? []) a.cancel();
  return { rects, cols };
}

/** FLIP, part 2 (rows 5–7): only the columns this desk touched; moved cards glide 240 ms, new local cards enter 200 ms. */
function flip(before, local) {
  const cols = new Set(before.cols);
  for (const id of local) { const c = board.querySelector(`.tok[data-key="${CSS.escape(id)}"]`)?.closest('.col'); if (c) cols.add(c); }
  for (const col of cols) {
    if (!col?.isConnected) continue;
    for (const tok of col.querySelectorAll('.tok[data-key]')) {
      if (tok.dataset.exiting) continue;
      const prev = before.rects.get(tok.dataset.key);
      if (!prev) {
        if (!tok.hasAttribute('data-local')) continue;
        tok.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE_OUT_CSS });
        tok.animate([{ backgroundColor: 'var(--brand-soft)' }, { backgroundColor: getComputedStyle(tok).backgroundColor }], { duration: 300, easing: 'ease' });
        continue;
      }
      const nowR = tok.getBoundingClientRect();
      const dx = prev.left - nowR.left;
      const dy = prev.top - nowR.top;
      if (Math.abs(dx) > .5 || Math.abs(dy) > .5) tok.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 240, easing: EASE_MOVE_CSS });
    }
  }
}

/** Row 7: a local card leaving its list fades out of the flow so the siblings close up under the FLIP. */
function exitCard(node) {
  if (!node.hasAttribute('data-local') || reducedMotion()) return Promise.resolve();
  const group = node.parentElement;
  const top = node.offsetTop; const left = node.offsetLeft; const w = node.offsetWidth;
  Object.assign(node.style, { position: 'absolute', top: `${top}px`, left: `${left}px`, width: `${w}px`, pointerEvents: 'none', zIndex: '1' });
  if (group && !group.contains(node)) return Promise.resolve();
  const a = node.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }], { duration: 160, easing: EASE_OUT_CSS, fill: 'forwards' });
  return new Promise((r) => { a.onfinish = r; setTimeout(r, 200); });
}

/** Session rows in server order; finished ones beyond the first two are stacked when they would push a live doctor off-screen. */
function columnItems(sessions) {
  const slim = sessions.filter(isSlim);
  const open = sessions.filter((s) => OPEN.has(s.state)).length;
  const W = board.clientWidth || 0;
  const N = Math.max(1, Math.floor((W - slim.length * 68 - 32 - 28 + 12) / 284));
  if (!(N < 2 && slim.length > 2 && open >= 2)) return sessions;
  const stacked = new Set(slim.slice(2).map((s) => s.id));
  const out = [];
  let placed = false;
  for (const s of sessions) {
    if (!stacked.has(s.id)) { out.push(s); continue; }
    if (!placed) { placed = true; out.push({ id: '__stack', stack: sessions.filter((x) => stacked.has(x.id)) }); }
  }
  return out;
}

/** §3.2: N open columns of at least --col-min beside the slim ones, leaving a --peek of the next. Sets --col-w. */
function layout(items = null) {
  if (!board || board.hidden) return;
  const sessions = state.board?.sessions ?? [];
  const list = items || columnItems(sessions);
  const slimCount = list.filter((s) => s.stack || isSlim(s)).length;
  const open = list.filter((s) => !s.stack && OPEN.has(s.state)).length;
  const W = board.clientWidth;
  if (!W) return;
  const slimW = slimCount * (56 + 12);
  const N = Math.max(1, Math.floor((W - slimW - 32 - 28 + 12) / (272 + 12)));
  const count = Math.max(1, open || list.length - slimCount || 1);
  let colW;
  if (count <= N) colW = Math.min(400, Math.max(272, (W - slimW - 32 - 12 * (count - 1)) / count));
  else colW = Math.floor((W - slimW - 32 - 28 - 12 * (N - 1)) / N);
  colW = Math.round(colW);
  if (board._colW !== colW) { board._colW = colW; board.style.setProperty('--col-w', `${colW}px`); }
  const fits = count <= N;
  if (board._fits !== fits) { board._fits = fits; board.classList.toggle('fits', fits); }
  // Below 340 px a present card cannot hold "Here · 4 min · 2 ahead" beside its button: wording goes compact (§4.6).
  const narrow = colW < 340;
  const changed = board._narrow !== undefined && board._narrow !== narrow;
  board._narrow = narrow;
  return changed;
}

function syncTitle(sessions) {
  let here = 0;
  for (const s of sessions) if (OPEN.has(s.state)) for (const t of s.tokens ?? []) if (PRESENT.has(t.state)) here++;
  if (here === lastHere) return;
  lastHere = here;
  document.title = `Queue · ${here} here · ${state.clinic?.name || 'Vaguthu'}`;
}

// ------------------------------------------------------------------- columns
function createColumn(s) {
  const id = s.id;
  const r = {};
  const node = h('section.col', { dataset: { key: id }, 'aria-labelledby': s.stack ? null : `doc-${id}` });
  if (s.stack) {
    node.classList.add('slim', 'stack');
    node.append(r.slimBtn = h('button.slimbtn', { type: 'button', onClick: () => openStack(node._item) },
      r.slimName = h('span.name'), h('span.more', { 'aria-hidden': true }, '›')));
    node._r = r;
    return node;
  }
  // Slim form: the whole 56 × full-height column is one button — tap widens.
  r.slimBtn = h('button.slimbtn', { type: 'button', onClick: () => setWide(id, true) },
    r.slimName = h('span.name'), r.slimCnt = h('span.cnt'), h('span.more', { 'aria-hidden': true }, '›'));
  // Header: L1 name · specialty · ⋯ ; L2 status pill · count · the session button when it is the next thing.
  r.name = h('h2.name', { id: `doc-${id}` });
  r.spec = h('span.spec');
  r.more = h('button.more', { type: 'button', 'aria-label': 'Session actions', 'aria-haspopup': 'dialog', 'data-focus-key': `more-${id}`, onClick: (e) => openSessionSheet(id, e.currentTarget, { instant: e.detail === 0 }) }, h('span', { 'aria-hidden': true }, '⋯'));
  r.pillText = h('span.t');
  r.pill = h('span.pill.status', {}, h('i.dot', { 'aria-hidden': true }), r.pillText);
  r.cnt = h('span.cnt');
  r.sbtn = h('span.sbtn');
  r.head = h('header', {}, h('div.l1', {}, r.name, r.spec, r.more), h('div.l2', {}, r.pill, r.cnt, r.sbtn));
  // List well: hero → present → NOT HERE YET heading → away → quiet block → done footer.
  r.hero = h('div.group.hero-group', { role: 'list', 'aria-label': 'In the room' });
  r.present = h('div.group.present-group', { role: 'list', 'aria-label': 'Here' });
  r.awayText = h('span.t');
  r.awayHead = h('button.group-head', { type: 'button', hidden: true, 'aria-expanded': 'true', onClick: () => toggleAway(id) }, r.awayText, h('span.chev', { 'aria-hidden': true }, '›'));
  r.away = h('div.group.away', { role: 'list', 'aria-label': 'Not here yet' });
  r.quietText = h('span.txt');
  r.quietBtn = h('span.qbtn');
  r.quiet = h('div.quiet', { hidden: true }, h('span.glyph', { 'aria-hidden': true, html: CHAIR }), r.quietText, r.quietBtn);
  r.doneText = h('span.t');
  r.done = h('button.done-row', { type: 'button', hidden: true, 'data-focus-key': `done-${id}`, onClick: (e) => openDoneSheet(id, { instant: e.detail === 0 }) }, r.doneText, h('span.chev', { 'aria-hidden': true }, '›'));
  r.list = h('div.list', { dataset: { keepScroll: `list-${id}` } }, r.hero, r.present, r.awayHead, r.away, r.quiet, r.done);
  // Widened finished column: a summary card instead of the well.
  r.sumText = h('div.big');
  r.sumWhen = h('div.dim');
  r.sumDoneText = h('span.t');
  r.sumDone = h('button.done-row', { type: 'button', 'data-focus-key': `sdone-${id}`, onClick: (e) => openDoneSheet(id, { instant: e.detail === 0 }) }, r.sumDoneText, h('span.chev', { 'aria-hidden': true }, '›'));
  r.summary = h('div.summary', { hidden: true }, h('div.card.pad', {}, r.sumText, r.sumWhen), r.sumDone,
    h('button.btn.ghost', { type: 'button', onClick: () => setWide(id, false) }, 'Collapse column'));
  node.append(r.slimBtn, r.head, r.list, r.summary);
  node._r = r;
  return node;
}

/** §4.3 status pill, in precedence order. paused is the one variable behind pill, button and chip (D5). */
function pillOf(s, t) {
  const p = s.projection;
  const seen = (s.tokens ?? []).filter((x) => x.state === 'completed').length;
  let out;
  if (s.state === 'cancelled') out = { text: 'Cancelled', tone: '' };
  else if (s.state === 'ended') out = { text: `Finished · ${seen} seen`, tone: '' };
  else if (isPaused(s)) {
    const until = p?.pause?.expectedResumeAt;
    if (until && until < t) out = { text: `Break over · ${Math.round((t - until) / 60000)} min`, tone: 'danger' };
    else out = { text: until ? `Paused until ${hhmm(until)}` : 'Paused', tone: 'warn' };
  } else if (s.state === 'scheduled') {
    const start = (s.scheduled_start ?? 0) + (s.delay_minutes || 0) * 60000;
    const late = Math.round((t - start) / 60000);
    if (t - start > 120000) out = { text: `Not started · ${late} min late`, tone: late > 15 ? 'danger' : 'warn' };
    else out = { text: `Starts ${hhmm(start)}`, tone: '' };
  } else {
    const late = p?.runningLateMinutes ?? 0;
    if ((p?.overrunMinutes ?? 0) > 0 && (p?.tokensWaiting ?? 0) === 0 && !p?.nowServing) out = { text: `All seen · ends ${hhmm(p.projectedEnd)}`, tone: 'ok', allSeen: true };
    else if (late > 15) out = { text: `${late} min late${p?.projectedEnd ? ` · ends ~${hhmm(p.projectedEnd)}` : ''}`, tone: 'danger' };
    else if (late > 5) out = { text: `${late} min late`, tone: 'warn' };
    else out = { text: 'On time', tone: 'ok' };
  }
  const req = ui().requests.get(s.id);
  if (req && t - req.at < DOCTOR_REQUEST_TTL_MS && OPEN.has(s.state)) { out.text = `Doctor asks for next · ${out.text}`; out.tone = 'brand'; }
  if (s.simulating && OPEN.has(s.state)) out.text = `Simulated · ${out.text}`;
  return out;
}

function doneParts(tokens) {
  const seen = tokens.filter((x) => x.state === 'completed').length;
  const noShow = tokens.filter((x) => x.state === 'no_show').length;
  const cancelled = tokens.filter((x) => x.state === 'cancelled').length;
  const parts = [];
  if (seen) parts.push(`${seen} seen`);
  if (noShow) parts.push(`${noShow} did not attend`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  return { seen, noShow, cancelled, text: parts.join(' · ') };
}

function updateColumn(node, s, local) {
  const r = node._r;
  node._item = s;
  if (s.stack) {
    setText(r.slimName, `+${s.stack.length} finished`);
    setAttr(r.slimBtn, 'aria-label', `${s.stack.length} finished sessions: ${s.stack.map((x) => x.doctor_name).join(', ')}. Show them`);
    return;
  }
  const t = now();
  const tokens = s.tokens ?? [];
  const slim = isSlim(s);
  const closed = !OPEN.has(s.state);
  const paused = isPaused(s);
  const viewOnly = !canAct();
  node.classList.toggle('slim', slim);
  node.classList.toggle('closed', closed);
  node.classList.toggle('paused', paused && !closed);
  node.classList.toggle('view-only', viewOnly);

  const done = doneParts(tokens);
  const { seen, noShow, cancelled } = done;

  // Slim button (only visible while slim; patched regardless so widening is a class flip).
  setText(r.slimName, shortDoctor(s.doctor_name));
  setText(r.slimCnt, `${seen} ✓ · ${noShow + cancelled} ✕`);
  setAttr(r.slimBtn, 'aria-label', `${s.doctor_name}, ${s.state === 'cancelled' ? 'cancelled' : 'finished'}, ${seen} seen, ${noShow} did not attend. Widen column`);

  // Header.
  setText(r.name, s.doctor_name);
  setText(r.spec, specialtyLabel(s.specialty));
  const pill = pillOf(s, t);
  const pillCls = `pill status ${pill.tone}`.trim();
  if (r.pill.className !== pillCls) r.pill.className = pillCls;
  setText(r.pillText, pill.text);
  const here = present(tokens).length;
  const away = tokens.filter((x) => x.state === 'booked').length;
  setText(r.cnt, closed ? '' : here ? `· ${here} here, ${away} away` : `· ${away} waiting`);
  setHidden(r.more, viewOnly);

  const primary = viewOnly ? null : primaryOf(s, paused);
  const sbtn = primary?.kind === 'session' ? primary : null;
  const cur = r.sbtn.firstElementChild;
  if (!sbtn) { if (cur) r.sbtn.replaceChildren(); } else if (!cur || cur.dataset.action !== sbtn.action) {
    r.sbtn.replaceChildren(h('button.btn.primary', { type: 'button', dataset: { action: sbtn.action }, onClick: (e) => sessionAct(e.currentTarget, s, sbtn.action) }, sbtn.label));
  }

  // Tiers. A card that changed tier is MOVED to its new group first, so the
  // same node (focus, expansion, in-flight button) survives the crossing.
  const dragging = ui().drag?.tokenId ?? null; // the lifted card is in the drag layer: its slot stays, its patch waits (§8.1)
  const hero = tokens.filter((x) => x.state === 'in_consult' && x.id !== dragging);
  const pres = present(tokens).filter((x) => x.id !== dragging);
  const booked = tokens.filter((x) => x.state === 'booked' && x.id !== dragging);
  const groups = { hero: r.hero, present: r.present, away: r.away };
  for (const x of tokens) {
    if (x.id === dragging) continue;
    const target = groups[tierOf(x.state)];
    const existing = node.querySelector(`.tok[data-key="${CSS.escape(x.id)}"]`);
    if (existing && target && existing.parentElement !== target) { delete existing.dataset.exiting; existing.style.cssText = ''; target.append(existing); }
  }
  const primaryId = primary?.kind === 'token' ? primary.token.id : null;
  const ctx = { session: s, primaryId, local, now: t, viewOnly, completed: seen, narrow: !!board._narrow };
  const opts = {
    key: (x) => x.id,
    create: (x) => createCard(x, ctx),
    update: (cardEl, x) => updateCard(cardEl, x, ctx),
    enter: () => {},
    exit: exitCard,
  };
  patchList(r.hero, hero, opts);
  patchList(r.present, pres, opts);
  patchList(r.away, booked, opts);

  // Away heading (toggle; a patch never changes its collapsed state).
  const collapsed = !!ui().awayCollapsed[s.id];
  const awayCount = booked.length + (dragging && r.away.querySelector('.slot') ? 1 : 0);
  setHidden(r.awayHead, !awayCount);
  setText(r.awayText, `${awayCount} not here yet`);
  setAttr(r.awayHead, 'aria-expanded', String(!collapsed));
  setHidden(r.away, !awayCount || collapsed);
  node.classList.toggle('away-collapsed', collapsed);

  // Quiet block: an idle running column, or a scheduled one with no bookings.
  let quiet = null;
  if (!closed && !hero.length && !pres.length && !(dragging && node.querySelector('.slot'))) {
    if (s.state === 'scheduled' && !tokens.length) quiet = `No bookings yet · starts ${hhmm((s.scheduled_start ?? 0) + (s.delay_minutes || 0) * 60000)}`;
    else if (s.state !== 'scheduled') {
      const next = booked.find((x) => x.projection?.predictedStart?.window?.from);
      quiet = next ? `Nobody waiting · next booked ${hhmm(next.projection.predictedStart.window.from)}` : 'Nobody waiting · no more bookings today';
    }
  }
  setHidden(r.quiet, !quiet);
  setText(r.quietText, quiet || '');
  const finishHere = !!quiet && s.state === 'running' && !viewOnly && (pill.allSeen || t > (s.scheduled_end ?? Infinity));
  if (finishHere && !r.quietBtn.firstElementChild) {
    r.quietBtn.append(h('button.btn.ghost', { type: 'button', onClick: (e) => finishSession(s, e.currentTarget) }, 'Finish session'));
  } else if (!finishHere && r.quietBtn.firstElementChild) r.quietBtn.replaceChildren();

  // Done footer → the done sheet.
  const doneN = seen + noShow + cancelled;
  setHidden(r.done, !doneN);
  setText(r.doneText, done.text);
  setText(r.sumDoneText, done.text || 'Nobody seen');

  // Widened finished column.
  const wideClosed = closed && !slim;
  setHidden(r.list, wideClosed);
  setHidden(r.summary, !wideClosed);
  if (wideClosed) {
    setText(r.sumText, summaryText(tokens));
    setText(r.sumWhen, s.state === 'cancelled' ? 'Cancelled' : `Finished ${hhmm(s.actual_end ?? s.scheduled_end)}`);
  }
}

function summaryText(tokens) {
  const { seen, noShow } = doneParts(tokens);
  const durations = tokens.filter((x) => x.state === 'completed' && x.started_at && x.ended_at).map((x) => x.ended_at - x.started_at);
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60000) : null;
  return [`${seen} seen`, `${noShow} did not attend`, avg != null ? `avg ${avg} min in room` : null].filter(Boolean).join(' · ');
}

function setWide(id, wide) {
  const u = ui();
  if (wide) u.wide.add(id); else u.wide.delete(id);
  persistUi();
  withColumnFlip(patch);
}

/** Row 12: a column changes width because this desk pressed Finish / Cancel / Collapse / Widen — it and every column to its right glide 240 ms, its content fades in. Remote closes stay a hard cut. */
function withColumnFlip(fn) {
  if (!board || reducedMotion()) { fn(); return; }
  const before = new Map([...board.querySelectorAll(':scope > .col')].map((c) => [c, c.getBoundingClientRect()]));
  fn();
  for (const [c, r] of before) {
    if (!c.isConnected) continue;
    const n = c.getBoundingClientRect();
    const dx = r.left - n.left;
    if (Math.abs(dx) > .5) c.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 240, easing: EASE_MOVE_CSS });
    if (Math.abs(r.width - n.width) > .5) c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: EASE_OUT_CSS });
  }
}
function toggleAway(id) {
  const u = ui();
  u.awayCollapsed[id] = !u.awayCollapsed[id];
  persistUi();
  patch();
}
function openStack(item) {
  const rows = (item?.stack ?? []).map((s) => ({
    label: s.doctor_name, hint: `${hhmm(s.actual_end ?? s.scheduled_end)} · ${(s.tokens ?? []).filter((x) => x.state === 'completed').length} seen`,
    onClick: () => setWide(s.id, true),
  }));
  openSheet({ title: 'Finished sessions', rows });
}

// --------------------------------------------------------------------- cards
function createCard(t, ctx) {
  const node = h('div.tok', {
    role: 'listitem', tabindex: 0, 'aria-expanded': 'false', dataset: { key: t.id, tokenId: t.id },
    onClick: (e) => { if (node.dataset.dragged !== undefined || e.target.closest('button, select, a, input, textarea')) return; toggleCard(t.id); },
    onKeydown: (e) => {
      if (e.target !== node || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCard(t.id); }
    },
    onPointerdown: (e) => { if (!e.target.closest('button, select, a')) node.dataset.pressed = ''; },
    onPointerup: () => delete node.dataset.pressed,
    onPointercancel: () => delete node.dataset.pressed,
    onPointerleave: () => delete node.dataset.pressed,
  });
  if (ctx.local.has(t.id)) node.setAttribute('data-local', '');
  node._tier = null;
  return node;
}

/** Card anatomy per tier. Rebuilt only when the tier changes; everything else is patched in place. */
function buildTier(node, tier) {
  const r = {};
  r.badge = h('span.badge.num');
  r.name = h('bdi.name', { dir: 'auto' });
  r.flags = h('span.flags');
  r.action = h('span.action');
  r.expandInner = h('div.inner');
  r.expand = h('div.expand', {}, r.expandInner);
  let row;
  if (tier === 'hero') {
    r.timer = h('span.timer.num', { dataset: { tick: '', mode: 'elapsed' } });
    r.status = h('span.status');
    row = h('div.row', {}, h('i.stripe', { 'aria-hidden': true }), h('span.glyph', { 'aria-hidden': true }, GLYPH.in_consult),
      r.badge, h('span.nm', {}, r.name, r.flags), r.timer, r.status, r.action);
  } else if (tier === 'present') {
    r.glyph = h('span.glyph', { 'aria-hidden': true });
    r.status = h('span.status');
    row = h('div.row', {}, h('i.stripe', { 'aria-hidden': true }), r.glyph, r.badge,
      h('span.txt', {}, h('span.nm', {}, r.name, r.flags), r.status), r.action);
  } else {
    r.eta = h('span.eta.num');
    row = h('div.row', {}, r.badge, h('span.nm', {}, r.name, r.flags), r.eta, r.action);
  }
  node.replaceChildren(row, r.expand);
  node._r = r;
  node._tier = tier;
  node._sig = null;
  node._flagSig = null;
  node._actionKey = null;
  node._expanded = false;
}

function flagPills(t, compact) {
  const flags = t.flags || [];
  const out = [];
  if (flags.includes('travel')) out.push(h('span.flag.violet', { title: `Travelling from ${t.travel_island || 'another island'}` }, compact ? '✈' : `✈ ${t.travel_island || ''}`.trim()));
  if (flags.includes('needs_decision')) out.push(h('span.flag.warn', { title: 'Travel-flagged: penalty held for your decision' }, compact ? '⚑' : '⚑ Your call'));
  if (flags.includes('doctor_requested')) out.push(h('span.flag.brand', { title: 'The doctor asked for this patient next' }, compact ? '☆' : '☆ Doctor asked'));
  if (flags.includes('priority') && !flags.includes('travel')) out.push(h('span.flag.violet', { title: t.priority_reason ? titleCase(t.priority_reason) : 'Priority' }, '★'));
  if (t.on_my_way && !flags.includes('travel')) out.push(h('span.flag.plain', { title: 'On their way' }, '🚶'));
  if (out.length > 2) { const extra = out.length - 2; out.length = 2; out.push(h('span.flag.plain', {}, `+${extra}`)); }
  return out;
}

function cardAction(t) {
  switch (t.state) {
    case 'booked': return { action: 'checkin', label: 'Check in', body: {} };
    case 'arrived': case 'penalised': return { action: 'call', label: 'Call', body: {} };
    case 'called': return { action: 'start', label: 'Start', body: {} };
    case 'in_consult': return { action: 'end', label: 'End & next', body: { callNext: true } };
    default: return null;
  }
}

function updateCard(node, t, ctx) {
  if (node.classList.contains('slot')) return; // the drag placeholder keeps the token's key; it is never a card
  const tier = tierOf(t.state);
  if (node._tier !== tier) buildTier(node, tier);
  const r = node._r;
  const p = t.projection;
  const cls = `tok ${tier} s-${t.state}`;
  if (node.className !== cls) node.className = cls;
  if (ctx.local.has(t.id)) node.setAttribute('data-local', '');
  const pending = ui().pending.has(t.id);
  if (pending !== node.hasAttribute('data-pending')) { if (pending) node.setAttribute('data-pending', ''); else node.removeAttribute('data-pending'); }
  setAttr(node, 'aria-label', `${t.display} ${t.patient_name}`);

  setText(r.badge, t.display);
  setText(r.name, t.patient_name);
  if (r.name.title !== t.patient_name) r.name.title = t.patient_name;

  const flagSig = `${(t.flags || []).join(',')}|${t.on_my_way ? 1 : 0}|${t.travel_island || ''}|${tier}|${ctx.narrow ? 1 : 0}`;
  if (node._flagSig !== flagSig) { node._flagSig = flagSig; r.flags.replaceChildren(...flagPills(t, tier === 'away' || ctx.narrow)); }

  const ahead = p?.tokensAhead ?? null;
  const aheadText = ahead == null ? '' : ahead > 0 ? `${ahead} ahead` : 'Next';
  const risk = !!p?.atRisk && WAITING.has(t.state);
  if (tier === 'hero') {
    const ns = ctx.session.projection?.nowServing;
    const mine = ns?.tokenId === t.id;
    const startedAt = (mine ? ns.startedAt : null) ?? t.started_at ?? now();
    if (r.timer.dataset.from !== String(startedAt)) r.timer.dataset.from = String(startedAt);
    const over = mine && ns.overrunning;
    r.timer.classList.toggle('over', !!over);
    const sig = `${ctx.completed}|${over ? 1 : 0}|${ctx.narrow ? 1 : 0}`;
    if (node._sig !== sig) {
      node._sig = sig;
      // replaceChildren() stringifies a null argument into a "null" text node: filter, never pass nulls.
      r.status.replaceChildren(...[h('span.meta', {}, ctx.narrow ? `${ordinal(ctx.completed + 1)} today` : `In the room · ${ordinal(ctx.completed + 1)} today`),
        over ? h('span.over', {}, ' · over by ', h('span.num', { dataset: { tick: '', mode: 'over', from: String(startedAt + Math.max(0, ns?.residualMinutes ?? 0) * 60000) } })) : null].filter(Boolean));
    }
  } else if (tier === 'present') {
    setText(r.glyph, GLYPH[t.state] || '');
    const sig = `${t.state}|${t.called_at}|${t.arrived_at}|${t.penalty_count}|${aheadText}|${risk ? 1 : 0}|${ctx.narrow ? 1 : 0}`;
    if (node._sig !== sig) {
      node._sig = sig;
      let word; let meta;
      const since = () => h('span', { dataset: { tick: '', mode: 'since', from: String(t.arrived_at ?? now()) } });
      // Narrow columns keep the queue truth (N ahead) and drop the minutes; the expanded detail has the rest.
      if (t.state === 'arrived') {
        word = 'Here';
        meta = ctx.narrow ? [aheadText ? ` · ${aheadText}` : ''] : [' · ', since(), aheadText ? ` · ${aheadText}` : ''];
      } else if (t.state === 'called') {
        word = `Called ${hhmm(t.called_at)}`;
        meta = [' · ', h('span', { dataset: { tick: '', mode: 'countdown', from: String((t.called_at ?? now()) + graceMs()), short: ctx.narrow ? '' : null } })];
      } else {
        word = ctx.narrow ? `Back ×${t.penalty_count || 1}` : `Moved back ×${t.penalty_count || 1}`;
        meta = ctx.narrow ? [aheadText ? ` · ${aheadText}` : ''] : [' · ', since(), aheadText ? ` · ${aheadText}` : ''];
      }
      r.status.replaceChildren(h('b', {}, word), h('span.meta', {}, ...meta, risk ? h('span.risk', { title: 'May not be reached today' }, ' · at risk') : null));
    }
  } else {
    const from = p?.predictedStart?.window?.from;
    setText(r.eta, from ? hhmm(from) : '');
    r.eta.classList.toggle('risk', risk);
    const title = risk ? 'May not be reached today' : '';
    if (r.eta.title !== title) r.eta.title = title;
  }

  // The one action on the row: filled only when it is the column's next thing.
  const act = ctx.viewOnly ? null : cardAction(t);
  const isPrimary = !!act && ctx.primaryId === t.id;
  const key = act ? `${act.action}|${act.label}` : '';
  if (node._actionKey !== key) {
    node._actionKey = key;
    if (!act) r.action.replaceChildren();
    else r.action.replaceChildren(h(`button.btn${tier === 'away' ? '.sm' : ''}`, {
      type: 'button', dataset: { action: act.action },
      onClick: (e) => { e.stopPropagation(); tokenAct(e.currentTarget, e.currentTarget._token || t, act.action, act.body); },
    }, act.label));
  }
  const btn = r.action.firstElementChild;
  if (btn) { btn.classList.toggle('primary', isPrimary); btn.classList.toggle('ghost', !isPrimary); btn._token = t; }

  // Expansion: state.ui.openCard survives patches; content is rebuilt while open.
  const open = ui().openCard === t.id;
  setAttr(node, 'aria-expanded', String(open));
  if (open) r.expandInner.replaceChildren(...expandedContent(t, ctx));
  else if (node._expanded) setTimeout(() => { if (ui().openCard !== t.id) r.expandInner.replaceChildren(); }, 200);
  node._expanded = open;
}

function toggleCard(id) {
  const u = ui();
  const prev = u.openCard;
  u.openCard = prev === id ? null : id;
  const local = new Set([id]); if (prev) local.add(prev);
  patch(local);
  board?.querySelector(`.tok[data-key="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

function payerText(t) {
  const label = t.payer_type === 'aasandha' ? 'Aasandha' : t.payer_type === 'private' ? (t.insurer || 'Insured') : t.payer_type === 'corporate' ? 'Corporate' : 'Self-pay';
  if (t.payer_type === 'self_pay') return h('span', {}, label);
  const r = t.eligibility?.result;
  if (r === 'covered') return h('span', {}, `${label} `, h('span.ok', {}, '✓'));
  if (r === 'not_covered') return h('span.unv', {}, `${label} not covered`);
  return h('span.unv', { title: t.eligibility?.detail || 'Not checked yet' }, `${label} — check`);
}

function confidence(level) {
  const on = { high: 3, medium: 2, low: 1 }[level] ?? 0;
  return h('span.conf', { title: `Estimate confidence: ${level}` }, [0, 1, 2].map((i) => h('i', { class: i < on ? 'on' : '' })));
}

/** §6.1 detail line + action row: at most three secondary actions, then More ⋯ (the card sheet). */
function expandedContent(t, ctx) {
  const p = t.projection;
  const dot = () => h('span.sep', { 'aria-hidden': true }, '·');
  const detail = h('div.detail', {});
  const bits = [];
  if (p?.predictedStart && WAITING.has(t.state)) {
    bits.push(h('span.num', {}, `${hhmm(p.predictedStart.window.from)}–${hhmm(p.predictedStart.window.to)}`), confidence(p.predictedStart.confidence));
    bits.push(h('span', {}, p.tokensAhead > 0 ? `${p.tokensAhead} ahead` : 'Next'));
  }
  bits.push(h('span', {}, sourceLabel(t.source)), payerText(t));
  if (t.visit_type === 'new') bits.push(h('span', {}, 'New patient'));
  if (p?.atRisk) bits.push(h('span.risk', {}, 'May not be reached today'));
  if (t.invoice?.state === 'open') bits.push(h('span.risk', {}, `${mvr(t.invoice.total_minor)} due`));
  if ((t.flags || []).includes('travel') && t.travel_island) bits.push(h('span', {}, `✈ from ${t.travel_island}`));
  if (t.priority_reason) bits.push(h('span', {}, `★ ${titleCase(t.priority_reason)}`));
  if ((t.flags || []).includes('needs_decision')) bits.push(h('span.unv', {}, 'Penalty held for your decision'));
  if (t.note) bits.push(h('span', {}, t.note));
  bits.forEach((b, i) => { if (i) detail.append(dot()); detail.append(b); });

  if (ctx.viewOnly) return [detail];
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e.currentTarget, e); };
  const b = (label, fn, cls = '') => h(`button.btn.sm.ghost${cls}`, { type: 'button', onClick: stop(fn) }, label);
  const row = [];
  switch (t.state) {
    case 'booked': row.push(b('Call', (el) => tokenAct(el, t, 'call')), b('Did not attend', (el) => tokenAct(el, t, 'no-show'))); break;
    case 'arrived': row.push(b('Start', (el) => tokenAct(el, t, 'start')), b('Move back', (el) => tokenAct(el, t, 'penalty'))); break;
    case 'called': row.push(b('Move back', (el) => tokenAct(el, t, 'penalty')), b('Did not attend', (el) => tokenAct(el, t, 'no-show'))); break; // Start is the row's own button; the server has no re-call
    case 'penalised': row.push(b('Undo move-back', (el) => tokenAct(el, t, 'revoke-penalty')), b('Did not attend', (el) => tokenAct(el, t, 'no-show'))); break;
    case 'in_consult': row.push(b('+10 min', (el) => tokenAct(el, t, 'extend', { minutes: 10 })), b('Note…', (el, e) => openCardSheet(t.id, el, 'note', { instant: e.detail === 0 }))); break;
    default: break;
  }
  // detail 0 = keyboard: the sheet opens with no motion (§9.3).
  row.push(h('button.btn.sm.ghost', { type: 'button', 'aria-haspopup': 'dialog', 'data-focus-key': `more-tok-${t.id}`, onClick: stop((el, e) => openCardSheet(t.id, el, null, { instant: e.detail === 0 })) }, 'More ⋯'));
  return [detail, h('div.actions', {}, row)];
}

// ------------------------------------------------------------ optimistic model
const tailSeq = (s) => Math.max(0, ...(s.tokens ?? []).filter((x) => WAITING.has(x.state)).map((x) => x.seq ?? 0)) + 1000;
const headSeq = (s) => Math.min(1000, ...(s.tokens ?? []).filter((x) => WAITING.has(x.state)).map((x) => x.seq ?? 0)) - 500;
function placeBetween(s, tok, afterId, beforeId) {
  const a = afterId ? s.tokens.find((x) => x.id === afterId) : null;
  const b = beforeId ? s.tokens.find((x) => x.id === beforeId) : null;
  if (a && b) tok.seq = (a.seq + b.seq) / 2;
  else if (a) tok.seq = a.seq + 1000;
  else if (b) tok.seq = b.seq - 1000;
  else tok.seq = tailSeq(s);
}

/**
 * Apply an action to state.board before the server answers (P2). Returns the
 * snapshot revert() needs. Mirrors queue.js closely enough that the confirm
 * patch rarely has anything to move.
 */
function applyLocal(t, action, body = {}) {
  const s = sessionOf(t.session_id);
  const tok = s?.tokens.find((x) => x.id === t.id);
  if (!s || !tok) return null;
  const snap = { sessionId: s.id, token: clone(tok), next: null };
  const T = now();
  const policy = state.penaltyPolicy || {};
  switch (action) {
    case 'checkin': if (tok.state === 'booked') { tok.state = 'arrived'; tok.arrived_at = T; } break;
    case 'call': tok.state = 'called'; tok.called_at = T; if (!tok.arrived_at) tok.arrived_at = T; break;
    case 'start': tok.state = 'in_consult'; tok.started_at = T; break;
    case 'end': {
      if (tok.state !== 'in_consult') break;
      tok.state = 'completed'; tok.ended_at = T;
      if (body.callNext) {
        const nxt = present(s.tokens).filter((x) => x.state !== 'called').sort(bySeq)[0];
        if (nxt) { snap.next = clone(nxt); nxt.state = 'called'; nxt.called_at = T; }
      }
      break;
    }
    case 'no-show': tok.state = 'no_show'; break;
    case 'cancel': tok.state = 'cancelled'; break;
    case 'penalty': {
      const flags = tok.flags || [];
      if (policy.travelFlagExemption !== false && flags.includes('travel')) { tok.flags = [...new Set([...flags, 'needs_decision'])]; break; }
      const count = (tok.penalty_count || 0) + 1;
      if (count > (policy.maxPenaltiesBeforeNoShow ?? 2)) { tok.state = 'no_show'; break; }
      tok.state = 'penalised'; tok.penalty_count = count; tok.called_at = null;
      const waiting = s.tokens.filter((x) => WAITING.has(x.state)).sort(bySeq);
      const idx = waiting.findIndex((x) => x.id === tok.id);
      if (policy.penaltyMode === 'move_to_end' || idx < 0) tok.seq = tailSeq(s);
      else {
        const target = Math.min(waiting.length - 1, idx + (policy.moveBackPositions ?? 2));
        const before = waiting[target]; const after = waiting[target + 1];
        tok.seq = after ? (before.seq + after.seq) / 2 : before.seq + 1000;
      }
      break;
    }
    case 'revoke-penalty':
      if ((tok.flags || []).includes('needs_decision') && tok.state !== 'penalised') { tok.flags = tok.flags.filter((f) => f !== 'needs_decision'); break; }
      tok.state = 'arrived'; tok.penalty_count = Math.max(0, (tok.penalty_count || 0) - 1); tok.seq = headSeq(s); if (!tok.arrived_at) tok.arrived_at = T;
      break;
    case 'reinstate': tok.state = 'arrived'; tok.penalty_count = 0; tok.seq = tailSeq(s); if (!tok.arrived_at) tok.arrived_at = T; break;
    case 'reorder': placeBetween(s, tok, body.afterTokenId, body.beforeTokenId); break;
    case 'reassign': {
      const target = sessionOf(body.sessionId);
      if (!target) break;
      s.tokens.splice(s.tokens.indexOf(tok), 1);
      tok.session_id = target.id;
      if (tok.state === 'called') { tok.state = 'arrived'; tok.called_at = null; }
      tok.seq = tailSeq(target);
      tok.projection = null;
      target.tokens.push(tok);
      target.tokens.sort(bySeq);
      break;
    }
    case 'note': tok.note = body.note ?? tok.note; break;
    default: break;
  }
  s.tokens.sort(bySeq);
  return snap;
}

function revert(snap) {
  if (!snap) return;
  for (const s of state.board?.sessions ?? []) {
    const i = s.tokens.findIndex((x) => x.id === snap.token.id);
    if (i >= 0) s.tokens.splice(i, 1);
  }
  const home = sessionOf(snap.sessionId);
  if (!home) return;
  home.tokens.push(snap.token);
  if (snap.next) { const i = home.tokens.findIndex((x) => x.id === snap.next.id); if (i >= 0) home.tokens[i] = snap.next; }
  home.tokens.sort(bySeq);
}

// ------------------------------------------------------------------- actions
/** Merge an action response ({token, projection, next?}) into state.board. */
function applyTokenResponse(r) {
  const sessions = state.board?.sessions ?? [];
  const put = (tok) => {
    if (!tok) return;
    for (const s of sessions) {
      const i = s.tokens.findIndex((x) => x.id === tok.id);
      if (i >= 0 && s.id !== tok.session_id) s.tokens.splice(i, 1);
    }
    const target = sessions.find((s) => s.id === tok.session_id);
    if (!target) return;
    const i = target.tokens.findIndex((x) => x.id === tok.id);
    if (i >= 0) target.tokens[i] = tok; else target.tokens.push(tok);
    target.tokens.sort(bySeq);
  };
  put(r.token);
  put(r.next);
  if (r.projection) applyProjection(r.projection);
}
function applyProjection(p) {
  const s = sessionOf(p.sessionId);
  if (!s) return;
  s.projection = p;
  if (p.state) s.state = p.state;
  for (const tok of s.tokens) tok.projection = p.entries?.find((e) => e.tokenId === tok.id) ?? null;
  anchor(p.computedAt);
}
function applySessionResponse(id, r) {
  const s = sessionOf(id);
  if (!s) return;
  if (r.session) Object.assign(s, r.session, { tokens: r.session.tokens ?? s.tokens, projection: r.projection ?? r.session.projection ?? s.projection });
  if (r.projection) applyProjection(r.projection);
}
/** The board was behind (409): fetch that session and patch without motion. */
async function reconcile(sessionId) {
  try {
    const r = await api(`/api/clinic/sessions/${sessionId}`);
    const s = sessionOf(sessionId);
    if (!s) return;
    Object.assign(s, r.session, { tokens: r.tokens ?? s.tokens, projection: r.projection ?? s.projection });
    if (r.projection) applyProjection(r.projection);
    patch();
  } catch { /* the poll reconciles */ }
}

const undoToast = (message, label, onClick) => toast(message, { action: { label, onClick } });
const withTimeout = (ms = 8000) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return { signal: c.signal, clear: () => clearTimeout(t) }; };

/**
 * A token action, optimistic (§10): mutate → pending → patch(local) → POST
 * with an Idempotency-Key → confirm patch (token still pending) → clear.
 * A 409 detail is shown verbatim and the card reverts (row 21).
 * opts.undo: this is the reverse of an earlier action — no second Undo toast.
 * opts.instant: keyboard-initiated — the DOM moves with no motion.
 */
async function tokenAct(button, t, action, body = {}, opts = {}) {
  if (!canAct()) return;
  const u = ui();
  if (u.pending.has(t.id) || u.drag?.tokenId === t.id) return; // a second tap while in flight is a no-op
  if (u.openCard === t.id && action !== 'note' && action !== 'extend') u.openCard = null;
  const fromSessionId = t.session_id;
  const snap = applyLocal(t, action, body);
  u.pending.set(t.id, { action, at: Date.now(), snapshot: snap });
  const local = new Set([t.id]);
  if (snap?.next) local.add(snap.next.id);
  patch(opts.instant ? EMPTY : local);
  const timer = withTimeout();
  try {
    const req = api(`/api/clinic/tokens/${t.id}/${action}`, { method: 'POST', body, idempotent: true, signal: timer.signal });
    const r = await (button?.isConnected ? busy(button, req) : req);
    applyTokenResponse(r);
    if (r.next) local.add(r.next.id);
    patch(opts.instant ? EMPTY : local);          // confirm: the one difference the server may add transitions once
    u.pending.delete(t.id);
    board?.querySelector(`.tok[data-key="${CSS.escape(t.id)}"]`)?.removeAttribute('data-pending');
    if (!opts.undo) feedback(t, action, r, fromSessionId, body);
    return r;
  } catch (err) {
    u.pending.delete(t.id);
    revert(snap);
    patch(local);
    if (err?.name === 'AbortError') { toast("Couldn't reach the server — nothing was changed", 'err'); return null; }
    toast(err.message || 'Something went wrong', 'err');
    if (err.status === 409) reconcile(fromSessionId);
    return null;
  } finally {
    timer.clear();
  }
}

/** The forgiveness table (§10.2): Undo where it exists, silence where colour is the feedback. */
function feedback(t, action, r, fromSessionId, body) {
  const d = r.token?.display ?? t.display;
  const live = () => tokenOf(t.id) || r.token || t;
  const undo = (act, undoBody) => () => tokenAct(null, live(), act, undoBody, { undo: true });
  switch (action) {
    case 'checkin':
      if (r.penalised) undoToast(`${d} checked in · moved back (late)`, 'Undo penalty', undo('revoke-penalty'));
      break;
    case 'end':
      if (r.token?.invoice?.state === 'open') undoToast(`${d} seen · ${mvr(r.token.invoice.total_minor)} due`, 'Take payment', () => { state.selectedInvoice = r.token.invoice.id; setTab('billing'); });
      break;
    case 'penalty':
      if (r.needsDecision) toast(`${d} is travel-flagged · your call on the penalty`, 'warn');
      else if (r.token?.state === 'no_show') undoToast(`${d} did not attend (too many move-backs)`, 'Undo', undo('reinstate'));
      else undoToast(`${d} moved back`, 'Undo', undo('revoke-penalty'));
      break;
    case 'no-show': undoToast(`${d} did not attend`, 'Undo', undo('reinstate')); break;
    case 'cancel': undoToast(`${d} cancelled`, 'Undo', undo('reinstate')); break;
    case 'reassign': {
      const to = sessionOf(r.token?.session_id);
      undoToast(`${r.previousDisplay ?? t.display} moved to ${to?.doctor_name ?? 'another doctor'} as ${d}`, 'Undo', undo('reassign', { sessionId: fromSessionId }));
      break;
    }
    case 'reorder': undoToast('Queue reordered', 'Undo', undo('reorder', body.undoWith || {})); break;
    case 'extend': toast(`${body.minutes ?? 10} min added for ${d}`); break;
    case 'reinstate': toast(`${d} back in the queue`); break;
    default: break; // Call, Start, revoke-penalty, note: the card is the feedback
  }
}

/** Session actions: state changes optimistically for start/pause/resume; the response is the truth. */
async function sessionAct(button, s, action, body = {}, okMessage = null) {
  if (!canAct()) return null;
  const snap = { state: s.state, projection: s.projection, delay_minutes: s.delay_minutes };
  if (action === 'start') s.state = 'running';
  else if (action === 'pause') { s.state = 'paused'; s.projection = { ...(s.projection || {}), pause: { kind: body.kind, expectedResumeAt: now() + (body.expectedMinutes ?? 15) * 60000 } }; }
  else if (action === 'resume') { s.state = 'running'; s.projection = { ...(s.projection || {}), pause: null }; }
  else if (action === 'delay') s.delay_minutes = body.minutes ?? s.delay_minutes;
  patch();
  const timer = withTimeout();
  try {
    const req = api(`/api/clinic/sessions/${s.id}/${action}`, { method: 'POST', body, idempotent: true, signal: timer.signal });
    const r = await (button?.isConnected ? busy(button, req) : req);
    applySessionResponse(s.id, r);
    if (action === 'end' || action === 'cancel') withColumnFlip(patch); else patch(); // row 12: this desk closed the column
    const m = typeof okMessage === 'function' ? okMessage(r) : okMessage;
    if (m) toast(typeof m === 'string' ? m : m.text, typeof m === 'string' ? {} : m);
    return r;
  } catch (err) {
    Object.assign(s, snap);
    patch();
    if (err?.name === 'AbortError') { toast("Couldn't reach the server — nothing was changed", 'err'); return null; }
    toast(err.message || 'Something went wrong', 'err');
    if (err.status === 409) reconcile(s.id);
    return null;
  } finally {
    timer.clear();
  }
}

// ---------------------------------------------------------------------- drag
/** Drop → optimistic reorder or reassign with the lift-time neighbours as the Undo (§8.3). */
function onDrop({ tokenId, fromGroup, toGroup, afterId, beforeId, moved, cancelled }) {
  const d = ui().drag;
  ui().drag = null;
  const t = tokenOf(tokenId);
  if (!t || !d) { patch(); return; }
  if (cancelled || !moved) { patch(new Set([tokenId])); return; } // remote patches deferred during the drag land now
  const toCol = toGroup?.closest('.col');
  const toSession = toCol ? sessionOf(toCol.dataset.key) : null;
  if (!toSession) { patch(); return; }
  if (toSession.id !== t.session_id) {
    tokenAct(null, t, 'reassign', { sessionId: toSession.id });
    return;
  }
  const undoWith = { afterTokenId: d.afterId, beforeTokenId: d.beforeId };
  tokenAct(null, t, 'reorder', { afterTokenId: afterId, beforeTokenId: beforeId, undoWith });
  void fromGroup;
}

/** Keyboard reorder (Alt+↑/↓) and reassign (Alt+←/→): instant, same optimistic commit, same Undo (§8.6). */
function keyboardMove(card, key) {
  const t = tokenOf(card.dataset.key);
  if (!t || !canAct() || !WAITING.has(t.state) || ui().pending.has(t.id)) return;
  const group = card.parentElement;
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const sibs = [...group.children].filter((c) => c.classList.contains('tok') && !c.dataset.exiting);
    const i = sibs.indexOf(card);
    const j = key === 'ArrowUp' ? i - 1 : i + 1;
    if (j < 0 || j >= sibs.length) return;
    const afterTokenId = key === 'ArrowUp' ? sibs[j - 1]?.dataset.key ?? null : sibs[j].dataset.key;
    const beforeTokenId = key === 'ArrowUp' ? sibs[j].dataset.key : sibs[j + 1]?.dataset.key ?? null;
    const undoWith = { afterTokenId: sibs[i - 1]?.dataset.key ?? null, beforeTokenId: sibs[i + 1]?.dataset.key ?? null };
    tokenAct(null, t, 'reorder', { afterTokenId, beforeTokenId, undoWith }, { instant: true }).then(() => refocus(t.id));
    return;
  }
  const open = (state.board?.sessions ?? []).filter((s) => OPEN.has(s.state));
  const i = open.findIndex((s) => s.id === t.session_id);
  const target = open[i + (key === 'ArrowRight' ? 1 : -1)];
  if (!target) return;
  tokenAct(null, t, 'reassign', { sessionId: target.id }, { instant: true }).then(() => { jumpTo(target.id, { tokenId: t.id, instant: true }); refocus(t.id); });
}
const refocus = (id) => board?.querySelector(`.tok[data-key="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });

function pageBy(dir) {
  const cols = [...board.querySelectorAll(':scope > .col[data-key]')];
  const L = board.scrollLeft + STRIP_PAD;
  let i = cols.findIndex((c) => c.offsetLeft >= L - 1);
  if (i < 0) i = cols.length - 1;
  const next = cols[Math.max(0, Math.min(cols.length - 1, i + dir))];
  if (next) jumpTo(next.dataset.key);
}

// -------------------------------------------------------------------- sheets
const sessionHint = (s, t = now()) => {
  const p = s.projection;
  const waiting = p?.tokensWaiting ?? (s.tokens ?? []).filter((x) => WAITING.has(x.state)).length;
  return `${hhmm(s.scheduled_start)} · ${plural(waiting, 'waiting', 'waiting')}${p?.projectedEnd ? ` · ends ~${hhmm(p.projectedEnd)}` : ''}`.replace('1 waiting', '1 waiting');
};

/** §6.5 the card sheet (More ⋯): every secondary action for this token, none of them confirmed — all undoable. */
function openCardSheet(tokenId, anchorEl = null, sub = null, { instant = false } = {}) {
  const t = tokenOf(tokenId);
  if (!t || !canAct()) return;
  const p = t.projection;
  const eta = p?.predictedStart ? ` · ${hhmm(p.predictedStart.window.from)}–${hhmm(p.predictedStart.window.to)}` : '';
  const stateWord = { booked: 'Not here yet', arrived: 'Here', called: `Called ${hhmm(t.called_at)}`, penalised: 'Moved back', in_consult: 'In the room', completed: 'Seen', no_show: 'Did not attend', cancelled: 'Cancelled' }[t.state] || titleCase(t.state);
  const act = (action, body) => () => tokenAct(null, tokenOf(t.id) || t, action, body);
  const rows = [];
  const movable = (state.board?.sessions ?? []).filter((x) => x.id !== t.session_id && OPEN.has(x.state));
  const moveRow = movable.length ? { label: 'Move to doctor…', icon: '→', keep: true, onClick: () => sheet.push({
    title: 'Move to which doctor?', subtitle: `${t.display} joins the end of that queue`,
    rows: movable.map((x) => ({ label: x.doctor_name, hint: sessionHint(x), icon: '', onClick: () => { sheet.close(); tokenAct(null, tokenOf(t.id) || t, 'reassign', { sessionId: x.id }); } })),
  }) } : null;
  const editRow = { label: 'Edit details', icon: '✎', keep: true, onClick: () => editDetails(sheet, t) };
  const noteRow = { label: 'Note…', icon: '✎', keep: true, onClick: () => noteSheet(sheet, t) };
  const cancelRow = { label: 'Cancel token', icon: '×', danger: true, onClick: act('cancel') };
  const noShowRow = { label: 'Did not attend', icon: '∅', onClick: act('no-show') };
  switch (t.state) {
    case 'booked': rows.push({ label: 'Check in', icon: '●', onClick: act('checkin') }, { label: 'Call', icon: '◐', onClick: act('call') }, { label: 'Start', icon: '▶', onClick: act('start') }, moveRow, editRow, noShowRow, cancelRow); break;
    case 'arrived': rows.push({ label: 'Start', icon: '▶', onClick: act('start') }, { label: 'Move back', icon: '↩', onClick: act('penalty') }, moveRow, editRow, noShowRow, cancelRow); break;
    case 'penalised': rows.push({ label: 'Start', icon: '▶', onClick: act('start') }, { label: 'Undo move-back', icon: '↩', onClick: act('revoke-penalty') }, moveRow, editRow, noShowRow, cancelRow); break;
    case 'called': rows.push({ label: 'Start', icon: '▶', onClick: act('start') }, { label: 'Move back', icon: '↩', onClick: act('penalty') }, moveRow, editRow, noShowRow, cancelRow); break;
    case 'in_consult': rows.push({ label: '+10 min', icon: '+', onClick: act('extend', { minutes: 10 }) }, noteRow, { label: 'End without calling next', icon: '■', onClick: act('end', { callNext: false }) }, editRow); break;
    default: rows.push({ label: 'Reinstate', icon: '↺', onClick: act('reinstate') }, editRow); break;
  }
  if ((t.flags || []).includes('needs_decision') && t.state !== 'penalised') rows.splice(1, 0, { label: 'No penalty', hint: 'travel-flagged', icon: '⚑', onClick: act('revoke-penalty') });
  if (t.state !== 'in_consult' && !DONE.has(t.state)) rows.splice(rows.length - 2, 0, noteRow);
  const sheet = openSheet({ title: `${t.display} · ${t.patient_name}`, subtitle: `${stateWord}${eta}`, rows, anchor: anchorEl, focusKey: `more-tok-${t.id}`, instant });
  if (sub === 'note') noteSheet(sheet, t);
}

function noteSheet(sheet, t) {
  const input = h('textarea.input', { rows: 4, placeholder: 'Operational note (not a clinical record)', value: t.note || '', maxlength: 500 });
  sheet.push({
    title: `Note for ${t.display}`, body: h('label.field', {}, h('span', {}, 'Operational note (not a clinical record)'), input), initialFocus: input,
    footer: [{ label: 'Cancel', onClick: () => { sheet.back(); return false; } }, { label: 'Save', primary: true, onClick: () => { tokenAct(null, tokenOf(t.id) || t, 'note', { note: input.value.trim() }); } }],
  });
}

/** Edit details sub-sheet → PUT /patients/:id; inline field errors, never a toast. The record is fetched first: the card carries no national_id or dob, and a blank must never overwrite them. */
async function editDetails(sheet, t) {
  let p = null;
  try { ({ patient: p } = await api(`/api/clinic/patients/${t.patient_id}`)); } catch (err) { toast(err.message, 'err'); return; }
  if (!sheet.isOpen || !p) return;
  const name = h('input.input', { value: p.name || t.patient_name || '', dir: 'auto', autocomplete: 'off' });
  const phone = h('input.input', { value: p.phone || t.phone || '', inputmode: 'tel', autocomplete: 'off' });
  const nid = h('input.input', { value: p.national_id || '', autocomplete: 'off' });
  const dob = h('input.input', { type: 'date', value: p.dob || '', autocomplete: 'off', max: new Date().toISOString().slice(0, 10) });
  const lang = h('select.input', {}, [['dv', 'Dhivehi'], ['en', 'English'], ['hi', 'Hindi/Urdu'], ['bn', 'Bengali'], ['si', 'Sinhala'], ['ta', 'Tamil'], ['ml', 'Malayalam']].map(([v, l]) => h('option', { value: v, selected: (p.language || t.language || 'dv') === v }, l)));
  const errs = { name: h('div.field-help.err'), phone: h('div.field-help.err'), dob: h('div.field-help.err') };
  const formErr = h('div.sheet-error', { role: 'alert' });
  const field = (label, input, err) => h('label.field', {}, h('span', {}, label), input, err || null);
  const validate = () => {
    let ok = true;
    errs.name.textContent = name.value.trim() ? '' : 'Name is needed';
    name.setAttribute('aria-invalid', String(!name.value.trim()));
    if (!name.value.trim()) ok = false;
    const digits = phone.value.replace(/\D/g, '');
    const bad = digits.length < 7;
    errs.phone.textContent = bad ? 'A 7-digit number, or a full international one' : '';
    phone.setAttribute('aria-invalid', String(bad));
    return ok && !bad;
  };
  phone.addEventListener('blur', () => { phone.value = normalisePhone(phone.value); });
  let saveBtn = null;
  const form = h('form', {
    id: 'edit-details-form',
    onSubmit: async (e) => {
      e.preventDefault();
      formErr.textContent = '';
      if (!validate()) return;
      try {
        const body = { name: name.value.trim(), phone: phone.value.trim(), national_id: nid.value.trim(), language: lang.value, ...(dob.value ? { dob: dob.value } : {}) };
        const r = await busy(saveBtn, api(`/api/clinic/patients/${t.patient_id}`, { method: 'PUT', body, idempotent: true }), 'Saving…');
        for (const s of state.board?.sessions ?? []) for (const x of s.tokens) if (x.patient_id === t.patient_id) Object.assign(x, { patient_name: r.patient.name, phone: r.patient.phone, language: r.patient.language, dob: r.patient.dob });
        sheet.close();
        patch();
      } catch (err) {
        const f = err.problem?.field;
        if (f && errs[f]) errs[f].textContent = err.message; else formErr.textContent = err.message || 'Could not save.';
      }
    },
  }, field('Name', name, errs.name), field('Phone', phone, errs.phone), field('ID / passport', nid), field('Date of birth', dob, errs.dob), field('Language', lang), formErr);
  sheet.push({
    title: 'Edit details', subtitle: t.display, body: form, initialFocus: name,
    footer: [{ label: 'Cancel', onClick: () => { sheet.back(); return false; } }, { label: 'Save', primary: true, submit: true, form: 'edit-details-form', ref: (b) => { saveBtn = b; } }],
  });
}

/** §6.3 the session sheet (column ⋯, chip long-press / right-click). Replaces the old popover and every prompt(). */
function openSessionSheet(id, anchorEl = null, { instant = false } = {}) {
  const s = sessionOf(id);
  if (!s || !canAct()) return;
  const u = ui();
  const open = OPEN.has(s.state);
  const paused = isPaused(s);
  const waiting = (s.tokens ?? []).filter((t) => WAITING.has(t.state)).length;
  const rows = [];
  if (open && s.state === 'running' && !paused) rows.push({ label: 'Pause…', icon: '❚❚', keep: true, onClick: () => pauseSheet(sheet, s) });
  if (open && paused) rows.push({ label: 'Resume', icon: '▶', onClick: () => sessionAct(null, s, 'resume') });
  if (open) rows.push({ label: 'Doctor is running late…', icon: '◷', hint: s.delay_minutes ? `${s.delay_minutes} min` : '', keep: true, onClick: () => delaySheet(sheet, s) });
  if (open) rows.push({ label: 'Message everyone waiting…', icon: '✉', hint: waiting ? `${waiting}` : '', keep: true, onClick: () => broadcastSheet(sheet, s) });
  if (!open) rows.push({ label: u.wide.has(id) ? 'Collapse column' : 'Widen column', icon: '↔', onClick: () => setWide(id, !u.wide.has(id)) });
  if (!open) rows.push({ label: 'Seen or gone', icon: '✓', onClick: () => openDoneSheet(id) });
  if (open && state.demo_enabled !== false) rows.push({ label: s.simulating ? 'Stop simulating this doctor' : 'Simulate this doctor', icon: '⚙', hint: 'demo', onClick: () => simulate(s) });
  if (open) rows.push(h('div.sheet-row.sep', { role: 'presentation', style: { minHeight: '0', padding: '0' } }));
  if (open) rows.push({ label: 'Finish session', icon: '■', onClick: () => finishSession(s) });
  if (open) rows.push({ label: 'Cancel session', icon: '×', danger: true, onClick: () => cancelSession(s) });
  const sheet = openSheet({ title: s.doctor_name, subtitle: pillOf(s, now()).text, rows, anchor: anchorEl, focusKey: `more-${id}`, instant });
}

function pauseSheet(sheet, s) {
  let kind = 'break'; let minutes = 15;
  const line = h('p.sheet-note');
  const say = () => { line.textContent = `Paused until ${hhmm(now() + minutes * 60000)} · ${plural((s.tokens ?? []).filter((t) => WAITING.has(t.state)).length, 'person', 'people')} waiting will be told`; };
  say();
  sheet.push({
    title: `Pause ${s.doctor_name}`,
    body: [h('label.field', {}, h('span', {}, 'Reason'), chipRow({ label: 'Reason', options: PAUSE_KINDS, value: kind, onChange: (v) => { kind = v; } })),
      h('label.field', {}, h('span', {}, 'For how long'), chipRow({ label: 'Minutes', options: [[10, '10 min'], [15, '15 min'], [20, '20 min'], [30, '30 min'], [45, '45 min']], value: minutes, onChange: (v) => { minutes = Number(v); say(); } })), line],
    footer: [{ label: 'Cancel', onClick: () => { sheet.back(); return false; } }, { label: 'Pause', primary: true, onClick: () => { sessionAct(null, s, 'pause', { kind, expectedMinutes: minutes }); } }],
  });
}

/** "Doctor is running late…": chips, a live "N people will be told" line; Set delay is the commit. */
function delaySheet(sheet, s) {
  const start = s.scheduled_start ?? now();
  const current = s.delay_minutes || 0;
  let minutes = current || 25;
  const waiting = (s.tokens ?? []).filter((t) => WAITING.has(t.state)).length;
  const line = h('p.sheet-note');
  const say = () => { line.textContent = `${hhmm(start + current * 60000)} → ${hhmm(start + minutes * 60000)} · ${plural(waiting, 'person', 'people')} will be told`; };
  say();
  const options = [...(current ? [[0, 'Back on time']] : []), [10, '+10 min'], [15, '+15 min'], [25, '+25 min'], [45, '+45 min']];
  sheet.push({
    title: `How late will ${shortDoctor(s.doctor_name)} be?`, subtitle: current ? `Currently ${current} min late` : `Starts ${hhmm(start)}`,
    body: [chipRow({ label: 'Delay', options, value: minutes, onChange: (v) => { minutes = Number(v); say(); } }), line],
    footer: [{ label: 'Cancel', onClick: () => { sheet.back(); return false; } }, { label: minutes === 0 ? 'Back on time' : 'Set delay', primary: true, onClick: () => {
      sessionAct(null, s, 'delay', { minutes }, minutes === 0 ? 'Back on time · everyone waiting has been told' : `Delay set · ${plural(waiting, 'person', 'people')} told`);
    } }],
  });
}

/** Cost is shown before sending: messaging is the biggest variable cost in the system. Send · MVR is the confirmation. */
async function broadcastSheet(sheet, s) {
  let estimate = { recipients: 0, estimatedCostMinor: 0 };
  try { estimate = await api(`/api/clinic/sessions/${s.id}/broadcast-estimate`); } catch (err) { toast(err.message, 'err'); return; }
  if (!sheet.isOpen) return;
  const text = h('textarea.input', { rows: 4, maxlength: 400, value: `${s.doctor_name} is running late this evening. We will message you with your new time.` });
  const line = h('p.sheet-note', {}, `${mvr(estimate.estimatedCostMinor)} · ${plural(estimate.recipients, 'recipient')}`);
  let send = null;
  const gate = () => { if (send) send.disabled = !text.value.trim() || estimate.recipients === 0; };
  text.addEventListener('input', gate);
  sheet.push({
    title: 'Message everyone waiting', subtitle: s.doctor_name, initialFocus: text,
    body: [h('label.field', {}, h('span', {}, 'Message'), text), line],
    footer: [{ label: 'Cancel', onClick: () => { sheet.back(); return false; } }, {
      label: `Send · ${mvr(estimate.estimatedCostMinor)}`, primary: true, disabled: !text.value.trim() || estimate.recipients === 0, ref: (b) => { send = b; },
      onClick: () => { sessionAct(null, s, 'broadcast', { text: text.value.trim() }, `Sent to ${estimate.recipients} · ${mvr(estimate.estimatedCostMinor)}`); },
    }],
  });
}

/** Finish: immediate when nobody waits and the room is empty; otherwise one of the four confirmations (§10.3). */
async function finishSession(s, button = null) {
  const hero = (s.tokens ?? []).find((t) => t.state === 'in_consult');
  const waiting = (s.tokens ?? []).filter((t) => WAITING.has(t.state)).length;
  let completeCurrent = false;
  if (hero) {
    if (!(await confirmSheet({ title: `${hero.display} is still in the room`, body: `Finish anyway? ${hero.patient_name}'s consultation will be marked as seen${waiting ? `, and the ${plural(waiting, 'person', 'people')} still waiting will be told the doctor has finished` : ''}.`, confirm: 'Finish', cancel: 'Keep going' }))) return;
    completeCurrent = true;
  } else if (waiting > 0) {
    if (!(await confirmSheet({ title: 'Finish anyway?', body: `${plural(waiting, 'person is', 'people are')} still waiting. They will be told the doctor has finished.`, confirm: 'Finish', cancel: 'Keep going' }))) return;
  }
  const seen = (s.tokens ?? []).filter((t) => t.state === 'completed').length;
  await sessionAct(button, s, 'end', { completeCurrent }, (r) => `${s.doctor_name} finished · ${(r?.session?.tokens ?? s.tokens ?? []).filter((t) => t.state === 'completed').length || seen} seen`);
}

async function cancelSession(s) {
  const waiting = (s.tokens ?? []).filter((t) => WAITING.has(t.state)).length;
  if (!(await confirmSheet({ title: `Cancel ${s.doctor_name}'s session?`, body: `${plural(waiting, 'person', 'people')} waiting will be told and refunded.`, confirm: 'Cancel session', cancel: 'Keep session', danger: true }))) return;
  await sessionAct(null, s, 'cancel', { reason: 'clinic' }, { text: `Session cancelled · ${plural(waiting, 'person', 'people')} told and refunded`, duration: 5000 });
}

async function simulate(s) {
  if (!s.simulating && !(await confirmSheet({ title: `Let the simulator run ${s.doctor_name}'s queue?`, body: 'It will start and end consultations and message patients.', confirm: 'Simulate', cancel: 'Not now' }))) return;
  try {
    const r = await api(`/api/clinic/sessions/${s.id}/simulate`, { method: 'POST', body: { enabled: !s.simulating } });
    applySessionResponse(s.id, r);
    patch();
  } catch (err) { toast(err.message, 'err'); }
}

/** §6.6 the done sheet: everyone seen or gone, with Take payment / Reinstate; patched in place while open. */
function openDoneSheet(sessionId, { instant = false } = {}) {
  const s = sessionOf(sessionId);
  if (!s) return;
  const list = h('div.done-list');
  const summary = h('p.sheet-note');
  const sheet = openSheet({ title: `${s.doctor_name} · seen or gone`, body: [summary, list], focusKey: `done-${sessionId}`, instant, onClose: () => { if (ui().doneSheet?.sheet === sheet) ui().doneSheet = null; } });
  ui().doneSheet = { sessionId, sheet, list, summary };
  patchDoneSheet();
}
function patchDoneSheet() {
  const d = ui().doneSheet;
  const s = d && sessionOf(d.sessionId);
  if (!s) return;
  setText(d.summary, summaryText(s.tokens ?? []) || 'Nobody seen yet');
  const done = (s.tokens ?? []).filter((t) => DONE.has(t.state)).sort((a, b) => (b.ended_at ?? b.updated_at ?? 0) - (a.ended_at ?? a.updated_at ?? 0));
  const closed = !OPEN.has(s.state);
  patchList(d.list, done, {
    key: (t) => t.id,
    create: () => h('div.done-item'),
    update: (node, t) => {
      const outcome = t.state === 'completed' ? `Seen ${hhmm(t.ended_at)}` : t.state === 'no_show' ? 'Did not attend' : 'Cancelled';
      const inv = t.invoice;
      const chip = inv?.state === 'open' ? h('span.pill.warn', {}, `${mvr(inv.total_minor)} due`) : inv?.state === 'paid' ? h('span.pill', {}, 'Paid') : t.payer_type === 'aasandha' && t.eligibility?.result === 'covered' ? h('span.pill.ok', {}, 'Aasandha ✓') : null;
      const action = inv?.state === 'open'
        ? h('button.btn.sm.ghost', { type: 'button', onClick: () => { closeSheet(); state.selectedInvoice = inv.id; setTab('billing'); } }, 'Take payment')
        : (t.state !== 'completed' && !closed && canAct() ? h('button.btn.sm.ghost', { type: 'button', onClick: (e) => tokenAct(e.currentTarget, t, 'reinstate') }, 'Reinstate') : null);
      const sig = `${t.state}|${t.ended_at}|${inv?.state}|${closed}`;
      if (node._sig === sig) return;
      node._sig = sig;
      node.replaceChildren(...[h('span.glyph', { 'aria-hidden': true }, GLYPH[t.state] || ''), h('span.badge.num', {}, t.display),
        h('span.txt', {}, h('bdi.name', { dir: 'auto' }, t.patient_name), h('span.sub', {}, outcome)), chip, action].filter(Boolean));
    },
    enter: () => {},
    exit: () => Promise.resolve(),
  });
  if (!done.length) d.list.replaceChildren(h('p.sheet-note', {}, 'Nobody has been seen yet.'));
}

// ------------------------------------------------------------ attention toasts
/** doctor.request for a column the desk cannot see: one toast with Call next; the shell's plain toast for it is replaced. */
function requestToast(msg) {
  if (!msg?.sessionId || !canAct()) return;
  const key = `${msg.sessionId}:${msg.tokenId ?? msg.at ?? ''}:${msg.display ?? ''}`;
  if (ui().requestToasted.has(key)) return;
  const onScreen = strip?.current?.().includes(msg.sessionId);
  if (onScreen) return;
  ui().requestToasted.add(key);
  const s = sessionOf(msg.sessionId);
  const host = document.querySelector('.toast-host');
  const dup = host && [...host.children].reverse().find((el) => el.textContent.includes(msg.patientName || msg.display || ' ') && el.textContent.includes('next'));
  dup?.remove();
  toast(`${msg.doctorName || s?.doctor_name || 'The doctor'} asked for the next patient`, {
    action: { label: 'Call next', onClick: () => {
      const ss = sessionOf(msg.sessionId);
      if (!ss) return;
      jumpTo(ss.id);
      // The doctor asked for a particular patient: call them while they are still waiting, else the column's next thing.
      const asked = msg.tokenId ? tokenOf(msg.tokenId) : null;
      const p = primaryOf(ss);
      if (asked && WAITING.has(asked.state) && asked.state !== 'called') tokenAct(null, asked, 'call');
      else if (p?.kind === 'token' && p.action === 'call') tokenAct(null, p.token, 'call');
    } },
  });
}

/** A called patient within 60 s of the automatic move-back: one toast per token that lives as long as the countdown. */
function soonToasts(t) {
  const u = ui();
  const live = new Set();
  for (const s of state.board?.sessions ?? []) {
    if (!OPEN.has(s.state)) continue;
    for (const tok of s.tokens ?? []) {
      if (tok.state !== 'called' || !tok.called_at) continue;
      live.add(tok.id);
      const left = tok.called_at + graceMs() - t;
      if (left <= 0 || left >= MOVE_BACK_SOON_MS || u.soonToasted.has(tok.id) || !canAct()) continue;
      u.soonToasted.add(tok.id);
      // The server refuses a second call on a called token and a Start while someone is in the room, so the one tap
      // is Start when the room is free and Show (the card, expanded: Move back / Did not attend) when it is not.
      const roomFree = () => !(sessionOf(tok.session_id)?.tokens ?? []).some((x) => x.state === 'in_consult');
      const show = () => jumpTo(tok.session_id, { tokenId: tok.id, expand: true });
      toast(`${tok.display} still not in the room · moves back in ${mmss(left)}`, {
        kind: 'warn', duration: Math.max(1500, left),
        action: { label: roomFree() ? 'Start' : 'Show', onClick: () => { const x = tokenOf(tok.id); if (x && x.state === 'called' && roomFree()) tokenAct(null, x, 'start'); else show(); } },
      });
    }
  }
  for (const id of u.soonToasted) if (!live.has(id)) u.soonToasted.delete(id);
}

// -------------------------------------------------------------------- jumpTo
function bezier(x1, y1, x2, y2) {
  const A = (a1, a2) => 1 - 3 * a2 + 3 * a1;
  const B = (a1, a2) => 3 * a2 - 6 * a1;
  const C = (a1) => 3 * a1;
  const calc = (t, a1, a2) => ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
  const slope = (t, a1, a2) => 3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1);
  return (x) => {
    let t = x;
    for (let i = 0; i < 8; i++) { const s = slope(t, x1, x2); if (Math.abs(s) < 1e-6) break; t -= (calc(t, x1, x2) - x) / s; }
    return calc(t, y1, y2);
  };
}

function cancelTween() {
  if (!tween) return;
  cancelAnimationFrame(tween.raf);
  tween = null;
  restoreSnap();
}
function restoreSnap() {
  clearTimeout(snapTimer);
  const done = () => { clearTimeout(snapTimer); board?.classList.remove('tweening'); board?.removeEventListener('scrollend', done); };
  board?.addEventListener('scrollend', done, { once: true });
  snapTimer = setTimeout(done, 300); // Safari has no scrollend
}
function tweenScroll(el, prop, to, onDone) {
  cancelTween();
  const from = el[prop];
  if (Math.abs(to - from) < 1) { onDone?.(); return; }
  board.classList.add('tweening');
  const t0 = performance.now();
  const ms = 240;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    el[prop] = from + (to - from) * EASE_MOVE(k);
    if (k < 1) tween.raf = requestAnimationFrame(step);
    else { tween = null; restoreSnap(); onDone?.(); }
  };
  tween = { raf: requestAnimationFrame(step) };
}

/** Bring a column (and optionally a card) on screen. Keyboard, palette and reduced motion are instant (P5). */
export function jumpTo(sessionId, { tokenId = null, expand = false, instant = false } = {}) {
  if (!board) return;
  const s = sessionOf(sessionId);
  if (!s) return;
  if (tokenId && isSlim(s)) setWide(sessionId, true); // a slim column is widened first
  let col = board.querySelector(`.col[data-key="${CSS.escape(sessionId)}"]`);
  if (!col && !OPEN.has(s.state)) { setWide(sessionId, true); col = board.querySelector(`.col[data-key="${CSS.escape(sessionId)}"]`); }
  if (!col) return;
  const fast = instant || reducedMotion();
  const target = Math.max(0, Math.min(col.offsetLeft - STRIP_PAD, board.scrollWidth - board.clientWidth));
  const moved = Math.abs(board.scrollLeft - target) >= 1;
  const after = () => {
    if (tokenId) {
      const card = col.querySelector(`.tok[data-key="${CSS.escape(tokenId)}"]`);
      const list = col._r?.list;
      if (card && list) {
        const top = card.offsetTop - list.offsetTop;
        const want = top < list.scrollTop ? top - 6 : top + card.offsetHeight > list.scrollTop + list.clientHeight ? top + card.offsetHeight - list.clientHeight + 6 : list.scrollTop;
        if (fast || moved) list.scrollTop = want; else tweenScroll(list, 'scrollTop', want);
      }
    }
    if (expand && tokenId) { ui().openCard = tokenId; patch(new Set([tokenId])); }
  };
  if (fast || !moved) { cancelTween(); board.scrollLeft = target; after(); } else tweenScroll(board, 'scrollLeft', target, after);
}

// --------------------------------------------------------------------- clock
function startClock() {
  stopClock();
  if (document.hidden) return;
  clockTimer = setInterval(tickNodes, 1000);
}
function stopClock() { clearInterval(clockTimer); clockTimer = null; }
function onVisibility() {
  if (document.hidden) stopClock();
  else { tickNodes(); startClock(); }
}

/** Patch every [data-tick] node's text — never a transition, never a colour tween (§9.4). */
function tickNodes() {
  if (!board) return;
  const t = now();
  for (const el of board.querySelectorAll('[data-tick]')) {
    const from = Number(el.dataset.from);
    if (Number.isNaN(from)) continue;
    let text = '';
    switch (el.dataset.mode) {
      case 'elapsed': text = mmss(t - from); break;
      case 'over': text = `${Math.max(0, Math.round((t - from) / 60000))} min`; break;
      case 'since': { const m = Math.floor((t - from) / 60000); text = m < 1 ? 'just now' : `${m} min`; break; }
      case 'countdown': {
        const left = from - t;
        text = left > 0 ? (el.dataset.short !== undefined ? mmss(left) : `moves back in ${mmss(left)}`) : 'moving back…';
        el.closest('.status')?.classList.toggle('soon', left < 60000);
        break;
      }
      default: break;
    }
    setText(el, text);
  }
  // Attention is time-based (called ≥2 min): the chip dots and the count follow the clock.
  const sessions = state.board?.sessions ?? [];
  if (strip && sessions.length) strip.update(sessions, t, attention());
  soonToasts(t);
}

// ------------------------------------------------------------------ keyboard
function onKey(e) {
  if (!board || e.metaKey || e.ctrlKey) return;
  if (sheetOpen() || document.querySelector('dialog[open], .palette-wrap')) return;
  const a = document.activeElement;
  if (e.altKey) {
    // Alt+↑/↓ reorder within the tier group, Alt+←/→ reassign to the neighbouring open column — instant, undoable.
    if (a?.classList?.contains('tok') && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !ui().drag) { e.preventDefault(); keyboardMove(a, e.key); }
    return;
  }
  const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
  if (e.key === 'Escape') {
    if (ui().drag) return; // drag.js springs the card home
    if (ui().openCard) { const id = ui().openCard; ui().openCard = null; patch(new Set([id])); }
    return;
  }
  if (typing) return;
  if (e.key === '[' || e.key === ']') {
    e.preventDefault();
    const cols = [...board.querySelectorAll(':scope > .col[data-key]')];
    const L = board.scrollLeft + STRIP_PAD;
    let i = cols.findIndex((c) => c.offsetLeft >= L - 1);
    if (i < 0) i = cols.length - 1;
    const next = cols[Math.max(0, Math.min(cols.length - 1, i + (e.key === ']' ? 1 : -1)))];
    if (next) jumpTo(next.dataset.key, { instant: true });
  }
}

// -------------------------------------------------------------- walk-in sheet
/** Client-side shape of the server's normalisePhone: 7 local digits → +960 XXX XXXX; anything longer keeps its country code. */
function normalisePhone(raw) {
  let digits = String(raw ?? '').replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  const plus = digits.startsWith('+');
  digits = digits.replace(/\D/g, '');
  if (!plus && digits.length === 7) digits = `960${digits}`;
  if (digits.startsWith('960') && digits.length === 10) return `+960 ${digits.slice(3, 6)} ${digits.slice(6)}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return raw;
}

/** §7: a bottom sheet on every device; the body is a <form> so Enter submits; the lookup offers, never overwrites (F05). */
export function openWalkIn(source = 'walk_in', { instant = null } = {}) {
  const sessions = (state.board?.sessions ?? []).filter((s) => OPEN.has(s.state));
  if (!sessions.length) return toast('No open sessions to add to', 'err');
  if (document.querySelector('.sheet-wrap .walkin')) return; // a second W while open is ignored (F28)
  // The shell's W hotkey calls this with no flag: a keyboard-caused open never animates (§9.3).
  instant ??= typeof KeyboardEvent !== 'undefined' && window.event instanceof KeyboardEvent;
  let src = source;
  let patientId = null;
  let priority = null;
  let visit = 'new';
  let issue = null;
  const lookupSeq = latest();

  const phone = h('input.input', { placeholder: '777 1234', inputmode: 'tel', autocomplete: 'tel', name: 'phone', 'aria-label': 'Phone' });
  const lookupSpin = h('span.spinner.lookup', { hidden: true, 'aria-hidden': true });
  const found = h('div.field-help.found', { 'aria-live': 'polite' });
  const name = h('input.input', { placeholder: 'Patient name', dir: 'auto', name: 'name', autocomplete: 'off' });
  const nameErr = h('div.field-help.err');
  const nationalId = h('input.input', { placeholder: 'A123456', name: 'nationalId', autocomplete: 'off' });
  const inView = strip?.current?.() ?? [];
  const preferred = sessions.find((s) => inView.includes(s.id))?.id
    ?? [...sessions].filter((s) => s.state === 'running').sort((a, b) => (a.projection?.projectedEnd ?? Infinity) - (b.projection?.projectedEnd ?? Infinity))[0]?.id
    ?? sessions[0].id;
  const doctorErr = h('div.field-help.err', { role: 'alert' });
  const doctors = h('div.sheet-radios', { role: 'radiogroup', 'aria-label': 'Doctor' }, sessions.map((s) => {
    const paused = isPaused(s);
    return h('label.sheet-radio', {},
      h('input', { type: 'radio', name: 'doctor', value: s.id, checked: s.id === preferred }),
      h('i.st', { class: paused ? 'pause' : s.state === 'running' ? 'on' : '', 'aria-hidden': true }),
      h('span.lbl', {}, s.doctor_name), h('span.hint', {}, sessionHint(s)));
  }));
  const doctorValue = () => doctors.querySelector('input:checked')?.value;
  const prioSummary = h('span.lbl', {}, 'Normal place in the queue');
  const prioChips = h('div.prio-body', { hidden: true },
    chipRow({ label: 'Priority reason', options: [['', 'Normal'], ...PRIORITY_REASONS], value: '', onChange: (v) => { priority = v || null; prioSummary.textContent = v ? PRIORITY_REASONS.find(([k]) => k === v)?.[1] : 'Normal place in the queue'; prioNote.hidden = !v; } }),
    h('p.sheet-note.prio-note', {}, 'Priority insertions are logged and reported to the clinic.'));
  const prioNote = prioChips.querySelector('.prio-note');
  prioNote.hidden = true;
  const prioHead = h('button.sheet-row.prio', { type: 'button', 'aria-expanded': 'false', onClick: () => { const open = prioChips.hidden; prioChips.hidden = !open; prioHead.setAttribute('aria-expanded', String(open)); } }, prioSummary, h('span.hint', {}, '›'));
  const formErr = h('div.sheet-error', { role: 'alert' });
  const dupRow = h('div.dup', { hidden: true });

  const digits = () => phone.value.replace(/\D/g, '');
  const gate = () => { if (issue) issue.disabled = digits().length < 7 || !name.value.trim(); };
  const lookup = debounce(async () => {
    const q = phone.value.trim();
    if (digits().length < 6) { found.replaceChildren(); found.className = 'field-help found'; patientId = null; return; }
    const tkt = lookupSeq();
    lookupSpin.hidden = false;
    let patients = [];
    try { ({ patients } = await api(`/api/clinic/patients?q=${encodeURIComponent(q)}`, { signal: tkt.signal })); } catch { return; } finally { if (tkt.current()) lookupSpin.hidden = true; }
    if (!tkt.current()) return;
    const norm = normalisePhone(q).replace(/\D/g, '');
    const match = patients.find((p) => String(p.phone || '').replace(/\D/g, '') === norm) || (digits().length >= 7 ? null : patients[0]);
    if (match) {
      found.className = 'field-help found ok';
      found.replaceChildren(`Known here: ${match.name}${match.travel_island ? ` · from ${match.travel_island}` : ''} `,
        h('button.btn.sm.ghost', { type: 'button', onClick: () => {
          patientId = match.id; name.value = match.name; nationalId.value = match.national_id || '';
          found.className = 'field-help found ok'; found.textContent = `Using ${match.name}'s record`; gate();
        } }, 'Use'));
    } else {
      patientId = null;
      found.className = 'field-help found';
      found.textContent = 'New to this clinic — a record will be created';
    }
  }, 150);
  phone.addEventListener('input', () => { patientId = null; gate(); lookup(); });
  phone.addEventListener('blur', () => { if (digits().length >= 7) phone.value = normalisePhone(phone.value); });
  name.addEventListener('input', () => { nameErr.textContent = ''; name.removeAttribute('aria-invalid'); gate(); });
  name.addEventListener('blur', () => { if (!name.value.trim()) { nameErr.textContent = 'Name is needed'; name.setAttribute('aria-invalid', 'true'); } });

  const form = h('form.walkin', {
    id: 'walkin-form', novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      formErr.textContent = ''; dupRow.hidden = true; doctorErr.textContent = '';
      if (!name.value.trim()) { nameErr.textContent = 'Name is needed'; name.setAttribute('aria-invalid', 'true'); name.focus(); return; }
      if (digits().length < 7) { found.className = 'field-help found err'; found.textContent = 'A 7-digit number, or a full international one'; phone.focus(); return; }
      const sessionId = doctorValue();
      if (!sessionId) { doctorErr.textContent = 'Pick a doctor'; return; }
      try {
        const r = await busy(issue, api('/api/clinic/tokens', {
          method: 'POST', idempotent: true,
          body: { sessionId, patientId, source: src, name: name.value.trim(), phone: phone.value.trim(), nationalId: nationalId.value.trim(), visitType: visit, priorityReason: priority },
        }), 'Issuing…');
        sheet.close();
        if (r?.token) {
          ui().pending.set(r.token.id, { action: 'create', at: Date.now() });
          applyTokenResponse(r);
          ui().pending.delete(r.token.id);
          patch(new Set([r.token.id]));
          jumpTo(r.token.session_id, { tokenId: r.token.id });
          toast(`${r.token.display} issued · ${r.token.patient_name}`);
        }
      } catch (err) {
        if (err.status === 409 && err.code === 'duplicate_token' && err.problem?.existingTokenId) {
          const ex = err.problem;
          dupRow.hidden = false;
          dupRow.replaceChildren(h('span', {}, `Already in this queue as ${ex.display}`),
            h('button.btn.sm.ghost', { type: 'button', onClick: () => { sheet.close(); jumpTo(sessionId, { tokenId: ex.existingTokenId, expand: true, instant }); } }, `Show ${ex.display}`));
        } else formErr.textContent = err.message || 'Could not issue the token.';
      }
    },
  },
  segmented({ label: 'Source', options: [['walk_in', 'Walk-in'], ['phone', 'Phone']], value: src, onChange: (v) => { src = v; sheet.setTitle(v === 'phone' ? 'Phone booking' : 'Add a walk-in'); } }),
  h('label.field', {}, h('span', {}, 'Phone'), h('div.input-wrap', {}, phone, lookupSpin), found),
  h('label.field', {}, h('span', {}, 'Name'), name, nameErr),
  h('label.field', {}, h('span', {}, 'ID / passport'), nationalId),
  h('div.field', {}, h('span', {}, 'Doctor'), doctors, dupRow, doctorErr),
  h('label.field', {}, h('span', {}, 'Visit'), segmented({ label: 'Visit', options: [['new', 'New'], ['follow_up', 'Follow-up']], value: visit, onChange: (v) => { visit = v; } })),
  h('div.field.prio-field', {}, prioHead, prioChips),
  formErr);

  const sheet = openSheet({
    title: src === 'phone' ? 'Phone booking' : 'Add a walk-in', body: form, className: 'walkin', instant, initialFocus: phone,
    footer: [{ label: 'Cancel' }, { label: 'Issue token', primary: true, submit: true, form: 'walkin-form', disabled: true, ref: (b) => { issue = b; } }],
  });
}

// ------------------------------------------------------------ command palette
/** Opened by ⌘K a hundred times a day: no animation, results jump instantly. */
export function openPalette() {
  if (document.querySelector('.palette-wrap')) return;
  let results = [];
  let cursor = 0;
  const input = h('input', { placeholder: 'Find a patient, or jump somewhere…', 'aria-label': 'Search' });
  const list = h('div.results', { role: 'listbox' });
  const commands = [
    { label: 'Add a walk-in', hint: 'W', run: () => openWalkIn('walk_in', { instant: true }) },
    { label: 'Add a phone booking', run: () => openWalkIn('phone', { instant: true }) },
    ...[['board', 'Queue board'], ['doctor', 'Doctor'], ['patients', 'Patients'], ['billing', 'Billing'],
      ['analytics', 'Insights'], ['messages', 'Messages'], ['settings', 'Settings']]
      .map(([tab, label], i) => ({ label: `Go to ${label}`, hint: String(i + 1), run: () => setTab(tab) })),
    ...(state.board?.sessions ?? []).map((s) => ({ label: `Show ${s.doctor_name}`, sub: specialtyLabel(s.specialty), run: () => { setTab('board'); jumpTo(s.id, { instant: true }); } })),
  ];
  const draw = () => list.replaceChildren(...results.map((r, i) =>
    h('div.res', { role: 'option', 'aria-selected': i === cursor, onClick: () => choose(i) },
      h('span.grow', {}, r.label), r.hint ? h('kbd', {}, r.hint) : null, r.sub ? h('span.dim.sm', {}, r.sub) : null)));
  const seq = latest();
  const search = async () => {
    const q = input.value.trim().toLowerCase();
    const cmd = commands.filter((c) => c.label.toLowerCase().includes(q));
    let patients = [];
    if (q.length >= 2) {
      const tkt = seq();
      try {
        const data = await api(`/api/clinic/patients?q=${encodeURIComponent(q)}`, { signal: tkt.signal });
        if (!tkt.current()) return;
        patients = data.patients.map((p) => ({
          label: p.name, sub: `${p.phone || ''}${p.travel_island ? ` · ${p.travel_island}` : ''}`,
          run: () => { state.selectedPatient = p.id; setTab('patients'); },
        }));
      } catch (err) { if (err?.name === 'AbortError') return; }
    }
    results = [...patients, ...cmd].slice(0, 12);
    cursor = 0;
    draw();
  };
  const opener = document.activeElement;
  const close = () => { wrap.remove(); if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true }); };
  const choose = (i) => { close(); results[i]?.run(); };
  input.addEventListener('input', search);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { cursor = Math.min(cursor + 1, results.length - 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { cursor = Math.max(cursor - 1, 0); draw(); e.preventDefault(); }
    if (e.key === 'Enter') { e.preventDefault(); choose(cursor); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  const wrap = h('div.palette-wrap', { onClick: (e) => { if (e.target === wrap) close(); } },
    h('div.palette', { role: 'dialog', 'aria-label': 'Search' }, input, list,
      h('footer', {}, h('span', {}, h('kbd', {}, '↑↓'), ' move'), h('span', {}, h('kbd', {}, '↵'), ' open'), h('span', {}, h('kbd', {}, 'esc'), ' close'))));
  document.body.append(wrap);
  input.focus();
  search();
}
