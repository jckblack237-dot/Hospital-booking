/**
 * Queue board — a deck of doctor columns paged with a thumb, the doctor strip
 * as the map, colour spent only on state, one filled button per column.
 *
 * Lifecycle: mount() builds the skeleton once; update() PATCHES. Columns are
 * keyed by session.id and cards by token.id (patchList), so scroll, focus and
 * in-flight transitions survive every poll and socket message. state.ui
 * (openCard, openMenu, wide, awayCollapsed, pending) outlives every patch.
 *
 * Motion rule (P5): a remote change — poll, projection, another desk, the
 * simulator — commits under a transition suppressor (.main[data-remote] + a
 * forced style flush) so nothing on the board moves by itself. Only cards this
 * desk is acting on (state.ui.pending) are marked data-local and may animate.
 */
import {
  h, api, hhmm, mvr, toast, busy, ask, confirmDialog, sheet, patchList, reducedMotion, latest,
  SPECIALTY_LABELS, SOURCE_LABELS, $$,
} from '/shared/core.js';
import { state, setTab, stripSlot } from '/clinic/app.js';
import { attentionItems, isPaused, DOCTOR_REQUEST_TTL_MS } from '/clinic/views/attention.js';
import { createStrip } from '/clinic/views/strip.js';

// ------------------------------------------------------------------ constants
const OPEN = new Set(['scheduled', 'running', 'paused']);
const PRESENT = new Set(['arrived', 'called', 'penalised']);
const WAITING = new Set(['booked', 'arrived', 'called', 'penalised']);
const GLYPH = { arrived: '●', called: '◐', penalised: '↩', in_consult: '▶', completed: '✓', no_show: '∅', cancelled: '×' };
const CHAIR = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 14V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7"/><path d="M6 14h20v6H6z"/><path d="M8 20v7M24 20v7M11 14v-3M21 14v-3"/></svg>';
const EMPTY = new Set();
const STRIP_PAD = 16;
const EASE_MOVE = bezier(.77, 0, .175, 1);

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
const ordinal = (n) => { const m = n % 100; const suf = m > 10 && m < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'; return `${n}${suf}`; };
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const canAct = () => ['receptionist', 'admin'].includes(state.staff?.role);
const graceMs = () => (state.penaltyPolicy?.gracePeriodMinutes ?? 5) * 60000;

// ------------------------------------------------------------------- state.ui
function freshUi() {
  return { openCard: null, openMenu: null, wide: new Set(), awayCollapsed: {}, pending: new Map(), drag: null, requests: new Map(), day: null };
}
const ui = () => (state.ui ||= freshUi());
const uiKey = () => `vaguthu-board-ui:${state.board?.day ?? 'x'}`;
function loadUi() {
  const u = ui();
  if (u.day === state.board?.day) return;
  u.day = state.board?.day ?? null;
  u.wide = new Set(); u.awayCollapsed = {}; u.openCard = null; u.openMenu = null;
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
let ro = null;
let clockTimer = null;
let tween = null;
let snapTimer = null;
let lastHere = -1;
let menuClose = null;

// --------------------------------------------------------------- public API
export function mount(el) {
  container = el;
  loadUi();
  board = h('div.board', {
    onClick: (e) => { if (ui().openCard && !e.target.closest('.tok')) { const id = ui().openCard; ui().openCard = null; patch(new Set([id])); } },
  });
  board.addEventListener('pointerdown', () => cancelTween(), { capture: true, passive: true });
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
    onContext: (id, anchorEl) => { jumpTo(id, { instant: true }); openSessionMenu(id, anchorEl); },
    onNeeds: () => { const first = attention()[0]; if (first) jumpTo(first.sessionId, { tokenId: first.tokenId, expand: !!first.tokenId }); },
  }) : null;
  ro = new ResizeObserver(() => { if (layout()) patch(); strip?.sync(); }); // a width crossing 340 px changes card wording
  ro.observe(board);
  patch(); // first paint: a hard cut, it is a working surface opened every shift
  requestAnimationFrame(() => { lastHere = -1; if (board) syncTitle(state.board?.sessions ?? []); }); // after the shell has set its own title
  startClock();
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);
}

export function update(reason, payload) {
  if (!board) return;
  switch (reason) {
    case 'board': loadUi(); anchor(state.board?.serverNow); patch(); break;
    case 'projection': anchor(payload?.computedAt); patch(); break;
    case 'tick': anchor(payload?.serverNow); tickNodes(); break;
    case 'doctor.request':
      if (payload?.sessionId) ui().requests.set(payload.sessionId, { ...payload, at: now() });
      patch();
      break;
    default: patch(); // 'render', 'token', 'session'
  }
}

export function unmount() {
  stopClock();
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('visibilitychange', onVisibility);
  cancelTween();
  closeMenu();
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
 * their cards may transition. Everything else commits under the suppressor.
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

  strip?.update(sessions, now(), attention());
  tickNodes();
  syncTitle(sessions);
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
  r.more = h('button.more', { type: 'button', 'aria-label': 'Session actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onClick: (e) => toggleMenu(id, e.currentTarget) }, h('span', { 'aria-hidden': true }, '⋯'));
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
  r.done = h('div.done-row', { hidden: true }, r.doneText, h('span.chev', { 'aria-hidden': true }, '›'));
  r.list = h('div.list', { dataset: { keepScroll: `list-${id}` } }, r.hero, r.present, r.awayHead, r.away, r.quiet, r.done);
  // Widened finished column: a summary card instead of the well.
  r.sumText = h('div.big');
  r.sumWhen = h('div.dim');
  r.summary = h('div.summary', { hidden: true }, h('div.card.pad', {}, r.sumText, r.sumWhen),
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

  const seen = tokens.filter((x) => x.state === 'completed').length;
  const noShow = tokens.filter((x) => x.state === 'no_show').length;
  const cancelled = tokens.filter((x) => x.state === 'cancelled').length;

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
  const hero = tokens.filter((x) => x.state === 'in_consult');
  const pres = present(tokens);
  const booked = tokens.filter((x) => x.state === 'booked');
  const groups = { hero: r.hero, present: r.present, away: r.away };
  for (const x of tokens) {
    const target = groups[tierOf(x.state)];
    const existing = node.querySelector(`.tok[data-key="${CSS.escape(x.id)}"]`);
    if (existing && target && existing.parentElement !== target) { delete existing.dataset.exiting; target.append(existing); }
  }
  const primaryId = primary?.kind === 'token' ? primary.token.id : null;
  const ctx = { session: s, primaryId, local, now: t, viewOnly, completed: seen, narrow: !!board._narrow };
  const opts = {
    key: (x) => x.id,
    create: (x) => createCard(x, ctx),
    update: (cardEl, x) => updateCard(cardEl, x, ctx),
    enter: () => {},
    exit: () => Promise.resolve(),
  };
  patchList(r.hero, hero, opts);
  patchList(r.present, pres, opts);
  patchList(r.away, booked, opts);

  // Away heading (toggle; a patch never changes its collapsed state).
  const collapsed = !!ui().awayCollapsed[s.id];
  setHidden(r.awayHead, !booked.length);
  setText(r.awayText, `${booked.length} not here yet`);
  setAttr(r.awayHead, 'aria-expanded', String(!collapsed));
  setHidden(r.away, !booked.length || collapsed);
  node.classList.toggle('away-collapsed', collapsed);

  // Quiet block: an idle running column, or a scheduled one with no bookings.
  let quiet = null;
  if (!closed && !hero.length && !pres.length) {
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
    r.quietBtn.append(h('button.btn.ghost', { type: 'button', onClick: (e) => sessionAct(e.currentTarget, s, 'end', {}, `${s.doctor_name} finished · ${seen} seen`) }, 'Finish session'));
  } else if (!finishHere && r.quietBtn.firstElementChild) r.quietBtn.replaceChildren();

  // Done footer (static count for now; the done sheet is part 2).
  const doneN = seen + noShow + cancelled;
  setHidden(r.done, !doneN);
  const parts = [];
  if (seen) parts.push(`${seen} seen`);
  if (noShow) parts.push(`${noShow} did not attend`);
  if (cancelled) parts.push(`${cancelled} cancelled`);
  setText(r.doneText, parts.join(' · '));

  // Widened finished column.
  const wideClosed = closed && !slim;
  setHidden(r.list, wideClosed);
  setHidden(r.summary, !wideClosed);
  if (wideClosed) {
    const durations = tokens.filter((x) => x.state === 'completed' && x.started_at && x.ended_at).map((x) => x.ended_at - x.started_at);
    const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60000) : null;
    setText(r.sumText, [`${seen} seen`, `${noShow} did not attend`, avg != null ? `avg ${avg} min in room` : null].filter(Boolean).join(' · '));
    setText(r.sumWhen, s.state === 'cancelled' ? 'Cancelled' : `Finished ${hhmm(s.actual_end ?? s.scheduled_end)}`);
  }
}

function setWide(id, wide) {
  const u = ui();
  if (wide) u.wide.add(id); else u.wide.delete(id);
  persistUi();
  patch();
}
function toggleAway(id) {
  const u = ui();
  u.awayCollapsed[id] = !u.awayCollapsed[id];
  persistUi();
  patch();
}
function openStack(item) {
  let p = null;
  const rows = (item?.stack ?? []).map((s) => {
    const seen = (s.tokens ?? []).filter((x) => x.state === 'completed').length;
    return h('button.btn.ghost.block', { type: 'button', style: { justifyContent: 'space-between', marginBottom: '8px' }, onClick: () => { p?.close(); setWide(s.id, true); } },
      h('span', {}, s.doctor_name), h('span.dim', {}, `${hhmm(s.actual_end ?? s.scheduled_end)} · ${seen} seen`));
  });
  p = sheet({ title: 'Finished sessions', body: h('div', {}, rows) });
}

// --------------------------------------------------------------------- cards
function createCard(t, ctx) {
  const node = h('div.tok', {
    role: 'listitem', tabindex: 0, 'aria-expanded': 'false', dataset: { key: t.id, tokenId: t.id },
    onClick: (e) => { if (e.target.closest('button, select, a, input, textarea')) return; toggleCard(t.id); },
    onKeydown: (e) => {
      if (e.target !== node) return;
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
      r.status.replaceChildren(h('span.meta', {}, ctx.narrow ? `${ordinal(ctx.completed + 1)} today` : `In the room · ${ordinal(ctx.completed + 1)} today`),
        over ? h('span.over', {}, ' · over by ', h('span.num', { dataset: { tick: '', mode: 'over', from: String(startedAt + Math.max(0, ns?.residualMinutes ?? 0) * 60000) } })) : null);
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
    r.action.replaceChildren(act ? h(`button.btn${tier === 'away' ? '.sm' : ''}`, {
      type: 'button', dataset: { action: act.action },
      onClick: (e) => { e.stopPropagation(); tokenAct(e.currentTarget, e.currentTarget._token || t, act.action, act.body); },
    }, act.label) : null);
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

/** §6.1 detail line + action row; the remaining secondary actions stay reachable here until the card sheet lands. */
function expandedContent(t, ctx) {
  const p = t.projection;
  const s = ctx.session;
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
  if (t.note) bits.push(h('span', {}, t.note));
  bits.forEach((b, i) => { if (i) detail.append(dot()); detail.append(b); });

  if (ctx.viewOnly) return [detail];
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e.currentTarget); };
  const b = (label, fn, cls = '') => h(`button.btn.sm.ghost${cls}`, { type: 'button', onClick: stop(fn) }, label);
  const row = [];
  const flags = t.flags || [];
  const movable = state.board.sessions.filter((x) => x.id !== s.id && OPEN.has(x.state));
  const moveTo = movable.length && t.state !== 'in_consult' ? h('select.input.sm', {
    'aria-label': 'Move to another doctor',
    onClick: (e) => e.stopPropagation(),
    onChange: (e) => { const to = e.target.value; if (to) tokenAct(null, t, 'reassign', { sessionId: to }); },
  }, h('option', { value: '' }, 'Move to…'), movable.map((x) => h('option', { value: x.id }, x.doctor_name))) : null;
  switch (t.state) {
    case 'booked':
      row.push(b('Call', (el) => tokenAct(el, t, 'call')), b('Did not attend', (el) => tokenAct(el, t, 'no-show')));
      break;
    case 'arrived':
      row.push(b('Start', (el) => tokenAct(el, t, 'start')), b('Move back', (el) => tokenAct(el, t, 'penalty')), b('Did not attend', (el) => tokenAct(el, t, 'no-show')));
      break;
    case 'called':
      row.push(b('Still here', (el) => tokenAct(el, t, 'call')), b('Move back', (el) => tokenAct(el, t, 'penalty')), b('Did not attend', (el) => tokenAct(el, t, 'no-show')));
      break;
    case 'penalised':
      row.push(b('Undo move-back', (el) => tokenAct(el, t, 'revoke-penalty')), b('Did not attend', (el) => tokenAct(el, t, 'no-show')));
      break;
    case 'in_consult':
      row.push(b('+10 min', (el) => tokenAct(el, t, 'extend', { minutes: 10 })), b('Note…', () => noteFor(t)), b('End, call nobody', (el) => tokenAct(el, t, 'end', { callNext: false })));
      break;
    default: break;
  }
  if (flags.includes('needs_decision') && t.state !== 'penalised') row.push(b('No penalty', (el) => tokenAct(el, t, 'revoke-penalty')));
  if (moveTo) row.push(moveTo);
  if (t.state !== 'in_consult') row.push(b('Cancel', (el) => tokenAct(el, t, 'cancel'), '.danger'));
  return [detail, h('div.actions', {}, row)];
}

async function noteFor(t) {
  const note = await ask({ title: `Note for ${t.display}`, label: 'Operational note (not a clinical record)', initial: t.note || '', multiline: true, confirm: 'Save' });
  if (note === null) return;
  await tokenAct(null, t, 'note', { note });
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
    target.tokens.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  };
  put(r.token);
  put(r.next);
  if (r.projection) applyProjection(r.projection);
}
function applyProjection(p) {
  const s = (state.board?.sessions ?? []).find((x) => x.id === p.sessionId);
  if (!s) return;
  s.projection = p;
  if (p.state) s.state = p.state;
  for (const tok of s.tokens) tok.projection = p.entries?.find((e) => e.tokenId === tok.id) ?? null;
  anchor(p.computedAt);
}
function applySessionResponse(id, r) {
  const s = (state.board?.sessions ?? []).find((x) => x.id === id);
  if (!s) return;
  if (r.session) Object.assign(s, r.session, { tokens: r.session.tokens ?? s.tokens, projection: r.projection ?? r.session.projection ?? s.projection });
  if (r.projection) applyProjection(r.projection);
}
/** The board was behind (409): fetch that session and patch without motion. */
async function reconcile(sessionId) {
  try {
    const r = await api(`/api/clinic/sessions/${sessionId}`);
    const s = (state.board?.sessions ?? []).find((x) => x.id === sessionId);
    if (!s) return;
    Object.assign(s, r.session, { tokens: r.tokens ?? s.tokens, projection: r.projection ?? s.projection });
    if (r.projection) applyProjection(r.projection);
    patch();
  } catch { /* the poll reconciles */ }
}

const undoToast = (message, label, onClick) => toast(message, { action: { label, onClick } });

/** POST a token action with the button locked; a 409 detail is shown verbatim, never a generic error (§10.4). */
async function tokenAct(button, t, action, body = {}) {
  if (!canAct()) return;
  const u = ui();
  if (u.pending.has(t.id)) return; // a second tap while in flight is a no-op
  if (u.openCard === t.id && action !== 'note' && action !== 'extend') u.openCard = null;
  u.pending.set(t.id, { action, at: Date.now() });
  const from = state.board.sessions.find((s) => s.id === t.session_id);
  board?.querySelector(`.tok[data-key="${CSS.escape(t.id)}"]`)?.setAttribute('data-pending', '');
  const local = new Set([t.id]);
  try {
    const req = api(`/api/clinic/tokens/${t.id}/${action}`, { method: 'POST', body, idempotent: true });
    const r = await (button ? busy(button, req) : req);
    applyTokenResponse(r);
    if (r.next) local.add(r.next.id);
    u.pending.delete(t.id);
    patch(local);
    feedback(t, action, r, from?.id);
  } catch (err) {
    u.pending.delete(t.id);
    patch();
    if (err?.name === 'AbortError') return;
    toast(err.message || 'Something went wrong', 'err');
    if (err.status === 409) reconcile(t.session_id);
  }
}

/** The forgiveness table (§10.2): Undo where it exists, silence where colour is the feedback. */
function feedback(t, action, r, fromSessionId) {
  const d = r.token?.display ?? t.display;
  const undo = (act, body) => async () => {
    try { const rr = await api(`/api/clinic/tokens/${t.id}/${act}`, { method: 'POST', body, idempotent: true }); applyTokenResponse(rr); patch(new Set([t.id])); }
    catch (err) { toast(err.message || 'Could not undo', 'err'); }
  };
  switch (action) {
    case 'checkin':
      if (r.penalised) undoToast(`${d} checked in · moved back (late)`, 'Undo penalty', undo('revoke-penalty'));
      break;
    case 'end':
      if (r.token?.invoice?.state === 'open') undoToast(`${d} seen · ${mvr(r.token.invoice.total_minor)} due`, 'Take payment', () => setTab('billing'));
      break;
    case 'penalty': undoToast(`${d} moved back`, 'Undo', undo('revoke-penalty')); break;
    case 'no-show': undoToast(`${d} did not attend`, 'Undo', undo('reinstate')); break;
    case 'cancel': undoToast(`${d} cancelled`, 'Undo', undo('reinstate')); break;
    case 'reassign': {
      const to = state.board.sessions.find((s) => s.id === r.token?.session_id);
      undoToast(`${r.previousDisplay ?? t.display} moved to ${to?.doctor_name ?? 'another doctor'} as ${d}`, 'Undo', undo('reassign', { sessionId: fromSessionId }));
      if (to) jumpTo(to.id, { tokenId: t.id });
      break;
    }
    case 'extend': toast(`10 min added for ${d}`); break;
    case 'reinstate': toast(`${d} back in the queue`); break;
    default: break; // Call, Start, Still here, revoke-penalty, note: the card is the feedback
  }
}

async function sessionAct(button, s, action, body = {}, okMessage = null) {
  if (!canAct()) return;
  closeMenu();
  try {
    const req = api(`/api/clinic/sessions/${s.id}/${action}`, { method: 'POST', body, idempotent: true });
    const r = await (button ? busy(button, req) : req);
    applySessionResponse(s.id, r);
    patch();
    if (okMessage) toast(okMessage);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    toast(err.message || 'Something went wrong', 'err');
    if (err.status === 409) reconcile(s.id);
  }
}

// -------------------------------------------------------------- session menu
// Placeholder for the session sheet (part 2): the ⋯ popover with every session action.
function toggleMenu(id, trigger) {
  if (ui().openMenu === id) closeMenu(); else openSessionMenu(id, trigger);
}
function closeMenu() { menuClose?.(); }

function openSessionMenu(id, trigger) {
  closeMenu();
  const s = state.board.sessions.find((x) => x.id === id);
  const col = board?.querySelector(`.col[data-key="${CSS.escape(id)}"]`);
  if (!s || !col || !col._r?.head || !canAct()) return;
  const r = col._r;
  const u = ui();
  u.openMenu = id;
  const item = (label, onClick, cls = '') => h(`button${cls}`, { type: 'button', role: 'menuitem', onClick: () => { closeMenu(); onClick(); } }, label);
  const waiting = (s.tokens ?? []).filter((t) => WAITING.has(t.state)).length;
  const open = OPEN.has(s.state);
  const paused = isPaused(s);
  const menu = h('div.menu', { role: 'menu', 'aria-label': `${s.doctor_name} session` },
    open && s.state === 'running' && !paused ? item('Pause 15 min', () => sessionAct(null, s, 'pause', { kind: 'break', expectedMinutes: 15 })) : null,
    open && paused ? item('Resume', () => sessionAct(null, s, 'resume')) : null,
    open ? item('Doctor is running late…', () => delaySession(s)) : null,
    open ? item('Message everyone waiting…', () => broadcast(s)) : null,
    !open ? item(u.wide.has(id) ? 'Collapse column' : 'Widen column', () => setWide(id, !u.wide.has(id))) : null,
    open && state.demo_enabled !== false ? item(s.simulating ? 'Stop simulating this doctor' : 'Simulate this doctor', () => simulate(s)) : null,
    open ? h('hr') : null,
    open ? item('Finish session', async () => {
      if (waiting > 0 && !(await confirmDialog({ title: 'Finish anyway?', body: `${waiting} ${waiting === 1 ? 'person is' : 'people are'} still waiting. They will be told the doctor has finished.`, confirm: 'Finish', cancel: 'Keep going' }))) return;
      const seen = (s.tokens ?? []).filter((t) => t.state === 'completed').length;
      sessionAct(null, s, 'end', {}, `${s.doctor_name} finished · ${seen} seen`);
    }) : null,
    open ? item('Cancel session', async () => {
      if (!(await confirmDialog({ title: `Cancel ${s.doctor_name}'s session?`, body: `${waiting} ${waiting === 1 ? 'person' : 'people'} waiting will be told and refunded.`, confirm: 'Cancel session', cancel: 'Keep session', danger: true }))) return;
      sessionAct(null, s, 'cancel', { reason: 'clinic' }, 'Session cancelled · everyone waiting has been told and refunded');
    }, '.danger') : null);
  if (!menu.querySelector('[role="menuitem"]')) { u.openMenu = null; return; }
  r.head.append(menu);
  r.more.setAttribute('aria-expanded', 'true');
  const outside = (e) => { if (!menu.contains(e.target) && e.target !== trigger && !trigger?.contains(e.target)) closeMenu(); };
  const keys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    const items = $$('[role="menuitem"]', menu);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keys, true);
  menuClose = () => {
    menuClose = null;
    if (u.openMenu === id) u.openMenu = null;
    menu.remove();
    r.more.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keys, true);
    if (trigger?.isConnected && trigger.matches('.more')) trigger.focus({ preventScroll: true });
  };
  $$('[role="menuitem"]', menu)[0]?.focus();
}

async function delaySession(s) {
  const v = await ask({
    title: `How late will ${s.doctor_name} be?`, label: 'Minutes', initial: String(s.delay_minutes || 25), type: 'number', inputmode: 'numeric', min: 0, max: 240,
    hint: 'Everyone waiting will be told their new time. 0 means back on time.', confirm: 'Set delay',
    validate: (x) => (x.trim() === '' || Number.isNaN(Number(x)) || Number(x) < 0 ? 'Enter a number of minutes' : ''),
  });
  if (v === null) return;
  await sessionAct(null, s, 'delay', { minutes: Number(v) }, 'Delay set — everyone waiting has been told');
}

/** Cost is shown before sending: messaging is the biggest variable cost in the system. */
async function broadcast(s) {
  let estimate;
  try { estimate = await api(`/api/clinic/sessions/${s.id}/broadcast-estimate`); } catch (err) { toast(err.message, 'err'); return; }
  const text = await ask({
    title: 'Message everyone waiting', label: `${estimate.recipients} recipients · ${mvr(estimate.estimatedCostMinor)}`, multiline: true,
    initial: `${s.doctor_name} is running late this evening. We will message you with your new time.`,
    confirm: `Send · ${mvr(estimate.estimatedCostMinor)}`,
    validate: (x) => (!x.trim() ? 'Write a message' : estimate.recipients === 0 ? 'Nobody is waiting' : ''),
  });
  if (!text) return;
  await sessionAct(null, s, 'broadcast', { text }, `Sent to ${estimate.recipients} · ${mvr(estimate.estimatedCostMinor)}`);
}

async function simulate(s) {
  if (!s.simulating && !(await confirmDialog({ title: `Let the simulator run ${s.doctor_name}'s queue?`, body: 'It will start and end consultations and message patients.', confirm: 'Simulate', cancel: 'Not now' }))) return;
  try {
    const r = await api(`/api/clinic/sessions/${s.id}/simulate`, { method: 'POST', body: { enabled: !s.simulating } });
    applySessionResponse(s.id, r);
    patch();
  } catch (err) { toast(err.message, 'err'); }
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
  const s = state.board.sessions.find((x) => x.id === sessionId);
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
}

// ------------------------------------------------------------------ keyboard
function onKey(e) {
  if (!board || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open], .palette-wrap')) return;
  const a = document.activeElement;
  const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
  if (e.key === 'Escape') {
    if (menuClose) { closeMenu(); return; }
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

// -------------------------------------------------------------- walk-in modal
export function openWalkIn(source = 'walk_in') {
  const sessions = (state.board?.sessions ?? []).filter((s) => OPEN.has(s.state));
  if (!sessions.length) return toast('No open sessions to add to', 'err');
  if (document.querySelector('dialog.walkin[open]')) return; // a second W while open is ignored

  const phone = h('input.input', { placeholder: '+960 777 1234', inputmode: 'tel', autocomplete: 'tel', name: 'phone' });
  const name = h('input.input', { placeholder: 'Patient name', dir: 'auto', name: 'name' });
  const nationalId = h('input.input', { placeholder: 'A123456', name: 'nationalId' });
  const preferred = strip?.current()?.[0];
  const doctor = h('select.input', {}, sessions.map((s) => h('option', { value: s.id, selected: s.id === preferred }, `${s.doctor_name} — ${hhmm(s.scheduled_start)}`)));
  const visit = h('select.input', {}, [['new', 'New patient'], ['follow_up', 'Follow-up']].map(([v, l]) => h('option', { value: v }, l)));
  const priority = h('select.input', {}, [['', 'Normal place in the queue'], ['clinical_urgency', 'Clinical urgency'], ['elderly', 'Elderly'],
    ['pregnant', 'Pregnant'], ['disability', 'Disability'], ['travel_constraint', 'Travel constraint'], ['staff_referral', 'Staff referral']]
    .map(([v, l]) => h('option', { value: v }, l)));
  const found = h('div.help.found');
  const error = h('div.form-error', { role: 'alert' });
  let matchedId = null;
  let match = null;
  const seq = latest();

  // Lookup never overwrites what was typed: it offers "Use" (F05).
  phone.addEventListener('input', async () => {
    const q = phone.value.trim();
    matchedId = null; match = null;
    if (q.replace(/\D/g, '').length < 6) { found.replaceChildren(); return; }
    const tkt = seq();
    let patients = [];
    try { ({ patients } = await api(`/api/clinic/patients?q=${encodeURIComponent(q)}`, { signal: tkt.signal })); } catch { return; }
    if (!tkt.current()) return;
    if (patients.length) {
      match = patients[0];
      found.replaceChildren(`Known here: ${match.name}${match.travel_island ? ` · from ${match.travel_island}` : ''} `,
        h('button.btn.sm.ghost', { type: 'button', onClick: () => { matchedId = match.id; name.value = match.name; nationalId.value = match.national_id || ''; found.textContent = `Using ${match.name}'s record`; } }, 'Use'));
    } else found.textContent = 'New to this clinic — a record will be created.';
  });

  const submitBtn = h('button.btn.primary', { type: 'submit', form: 'walkin-form' }, 'Issue token');
  const form = h('form.body', {
    id: 'walkin-form', novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (!name.value.trim() || !phone.value.trim()) { error.textContent = 'Name and phone are required.'; (name.value.trim() ? phone : name).focus(); return; }
      try {
        const r = await busy(submitBtn, api('/api/clinic/tokens', {
          method: 'POST', idempotent: true,
          body: {
            sessionId: doctor.value, patientId: matchedId, source,
            name: name.value.trim(), phone: phone.value.trim(), nationalId: nationalId.value.trim(),
            visitType: visit.value, priorityReason: priority.value || null,
          },
        }), 'Issuing…');
        dialog.close();
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
          const existing = err.problem;
          error.textContent = `Already in this queue as ${existing.display}.`;
          toast(`Already in this queue as ${existing.display}`, { kind: 'warn', action: { label: `Show ${existing.display}`, onClick: () => { dialog.close(); jumpTo(doctor.value, { tokenId: existing.existingTokenId, expand: true }); } } });
        } else error.textContent = err.message || 'Could not issue the token.';
      }
    },
  },
  h('label.field', {}, h('span', {}, 'Phone'), phone, found),
  h('label.field', {}, h('span', {}, 'Name'), name),
  h('label.field', {}, h('span', {}, 'National ID or passport'), nationalId),
  h('label.field', {}, h('span', {}, 'Doctor'), doctor),
  h('label.field', {}, h('span', {}, 'Visit'), visit),
  h('label.field', {}, h('span', {}, 'Priority'), priority),
  h('div.help', {}, 'Priority insertions are logged and reported.'),
  error);

  const dialog = h('dialog.modal.walkin', { onCancel: (e) => { e.preventDefault(); dialog.close(); }, onClick: (e) => { if (e.target === dialog) dialog.close(); } },
    h('div.panel', {},
      h('header', {}, source === 'phone' ? 'Phone booking' : 'Add a walk-in'),
      form,
      h('footer', {},
        h('button.btn', { type: 'button', onClick: () => dialog.close() }, 'Cancel'),
        submitBtn)));
  const opener = document.activeElement;
  dialog.addEventListener('close', () => { dialog.remove(); if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true }); });
  document.body.append(dialog);
  dialog.showModal();
  phone.focus();
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
    { label: 'Add a walk-in', hint: 'W', run: () => openWalkIn() },
    { label: 'Add a phone booking', run: () => openWalkIn('phone') },
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
