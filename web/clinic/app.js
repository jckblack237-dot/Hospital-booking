import {
  h, mount, api, setAuth, setUnauthorizedHandler, bus, connect, hhmm, toast, initTheme, guard, busy,
  preserve, confirmDialog, $$,
} from '/shared/core.js';
import * as boardMod from '/clinic/views/board.js';
import * as doctorMod from '/clinic/views/doctor.js';
import * as patientsMod from '/clinic/views/patients.js';
import * as billingMod from '/clinic/views/billing.js';
import * as analyticsMod from '/clinic/views/analytics.js';
import * as messagesMod from '/clinic/views/messages.js';
import * as settingsMod from '/clinic/views/settings.js';

/*
 * Lifecycle.
 *
 * The shell (rail + header + view container) is built ONCE per sign-in and
 * patched in place; switching tabs swaps only the view container's child.
 * Nothing here ever rebuilds the tree on a poll tick or a socket message.
 *
 * A view is a module exporting any of:
 *   mount(container)          put your DOM into container (once per tab visit)
 *   update(reason, payload)   something changed; patch in place. reasons:
 *                             'render'      the view itself asked (called render())
 *                             'board'       state.board was refetched (/board)
 *                             'projection'  a projection message was applied to state.board (payload = message)
 *                             'token'       a token.changed message was applied (payload = message)
 *                             'session'     a session.changed message was applied (payload = message)
 *                             'tick'        once a second while a session is live (state.serverNow updated)
 *                             'doctor.request'  a doctor pressed "See next" (payload = message)
 *   unmount()                 leaving the tab; drop listeners/timers
 *   reset()                   sign-out; clear every module-level cache (CP-02)
 * Modules that still export only renderX() are wrapped by adapt(): mount renders
 * into the container; update re-renders (inside preserve(), coalesced per frame)
 * only for the reasons listed for that view; other reasons are ignored.
 * Upgrade path: export mount/update/unmount from the view and the adapter steps aside.
 */

export const state = {
  session: null, clinic: null, staff: null, doctors: [], penaltyPolicy: null,
  board: { sessions: [], day: null },
  serverNow: Date.now(), connection: 'connecting', tab: 'board',
  doctorSessionId: null, demo: null, selectedPatient: null, demo_enabled: true, demoOpen: false,
};

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  board: svg('<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/>'),
  doctor: svg('<path d="M12 5v14M5 12h14"/>'),
  patients: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15 20h6.5a5 5 0 0 0-4-4.9"/>'),
  billing: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 14h3"/>'),
  analytics: svg('<path d="M4 19V11M10 19V5M16 19v-8M22 19H2"/>'),
  messages: svg('<path d="M4 6h16v10H8l-4 3z"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>'),
  pin: svg('<path d="M9 6l6 6-6 6"/>'),
  play: svg('<path d="M7 5v14l11-7z"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>'),
  power: svg('<path d="M12 3v8M6.3 7.3a8 8 0 1 0 11.4 0"/>'),
  theme: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>'),
};
const TABS = [
  ['board', 'Queue board', 'board', 'Everyone in the building, and everyone on their way.'],
  ['doctor', 'Doctor', 'doctor', 'One patient. Two buttons.'],
  ['patients', 'Patients', 'patients', 'People this clinic has seen.'],
  ['billing', 'Billing', 'billing', 'Invoices, claims, and what is stuck.'],
  ['analytics', 'Insights', 'analytics', 'How the clinic is doing, in plain words.'],
  ['messages', 'Messages', 'messages', 'What patients were told, and how.'],
  ['settings', 'Settings', 'settings', 'Queue rules, partner access, your team.'],
];
const TAB_KEYS = TABS.map(([k]) => k);
const LANDING = { doctor: 'doctor', billing: 'billing' };

const theme = initTheme();

// ------------------------------------------------------------------- views
function adapt(key, mod, spec) {
  if (typeof mod.mount === 'function') {
    return { key, mount: mod.mount, update: mod.update ?? (() => {}), unmount: mod.unmount ?? (() => {}), reset: mod.reset ?? (() => {}) };
  }
  const on = new Set(spec.on);
  let container = null;
  let queued = false;
  const draw = () => {
    try {
      preserve(() => container.replaceChildren(spec.render()), { root: container });
    } catch (err) {
      console.error(`[${key}] render failed`, err);
      container.replaceChildren(h('div.fail', {},
        h('div', {}, 'This tab could not be drawn.'),
        h('button.btn', { onClick: draw }, 'Try again')));
    }
  };
  // One re-render per frame at most; held while a card is mid-drag.
  const schedule = () => {
    if (queued || !container) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!container) return;
      if (container.querySelector('.dragging, [data-hold-render]')) { setTimeout(schedule, 250); return; }
      draw();
    });
  };
  return {
    key,
    dumb: true,
    mount(el) { container = el; draw(); },
    update(reason) { if (on.has(reason)) schedule(); },
    unmount() { container?.replaceChildren(); container = null; },
    reset() { mod.reset?.(); },
  };
}

const LIVE = ['render', 'board', 'projection', 'token', 'session'];
const VIEWS = {
  board: adapt('board', boardMod, { render: () => boardMod.renderBoard(), on: [...LIVE, 'doctor.request'] }),
  doctor: adapt('doctor', doctorMod, { render: () => doctorMod.renderDoctor(), on: [...LIVE, 'tick'] }),
  patients: adapt('patients', patientsMod, { render: () => patientsMod.renderPatients(), on: ['render'] }),
  billing: adapt('billing', billingMod, { render: () => billingMod.renderBilling(), on: ['render'] }),
  analytics: adapt('analytics', analyticsMod, { render: () => analyticsMod.renderAnalytics(), on: ['render'] }),
  messages: adapt('messages', messagesMod, { render: () => messagesMod.renderMessages(), on: ['render'] }),
  settings: adapt('settings', settingsMod, { render: () => settingsMod.renderSettings(), on: ['render'] }),
};

// ----------------------------------------------------------------- session
/** Optional: a clinic's own address, /clinic/<slug>/, brands the sign-in page and accepts only its accounts. */
export const slug = (location.pathname.match(/^\/clinic\/([a-z0-9-]+)\/?$/) || [])[1] || null;
const SESSION_KEY = 'vaguthu-clinic-session';
const RAIL_KEY = 'vaguthu-rail';

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function saveSession(s) {
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
}

let socket = null;
let poll = null;
let heartbeat = null;
let ticker = null;
let shell = null;          // { root, rail, head, view, banner, refs }
let screen = null;         // 'login' | 'password' | 'retry' | 'shell'
let mountedTab = null;
let activeView = null;
let signingOut = false;

export const isBoardTab = () => state.tab === 'board' || state.tab === 'doctor';

async function signOut({ server = true } = {}) {
  if (signingOut) return;
  signingOut = true;
  if (server) { try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* already gone */ } }
  stopLive();
  setAuth(null);
  saveSession(null);
  Object.assign(state, {
    session: null, clinic: null, staff: null, doctors: [], penaltyPolicy: null,
    board: { sessions: [], day: null }, demo: null, selectedPatient: null, doctorSessionId: null, connection: 'connecting',
  });
  boardEtag = null;
  boardStale = false;
  offlineNoted = false;
  // Every per-clinic cache goes with the session: the next sign-in on this
  // tablet may be a different clinic (CP-02).
  for (const v of Object.values(VIEWS)) { try { v.reset(); } catch { /* keep going */ } }
  activeView?.unmount();
  activeView = null;
  mountedTab = null;
  shell = null;
  screen = null;
  signingOut = false;
  render();
}

// One place for 401: whichever view tripped it, the desk lands on sign-in.
let booting = false;
setUnauthorizedHandler(() => {
  if (!state.session || signingOut || booting) return;
  toast('Your session ended — please sign in again', 'err');
  signOut({ server: false });
});

/** Kept for views: 401s are handled centrally now, so this is a plain pass-through. */
export async function call(fn) {
  return fn();
}

// ------------------------------------------------------------- freshness
let lastContact = 0;          // wall clock of the last successful HTTP or socket contact
let serverNowAt = 0;          // wall clock when state.serverNow was last set from the server
let clockSpeed = 1;           // demo clock multiplier, so the header clock does not stall between polls
let wasOffline = false;
let offlineNoted = false;
let serverTicks = false;      // the new backend ticks once a second; until we see one, the doctor timer ticks locally

function contact() { lastContact = Date.now(); }
function setServerNow(ms) {
  if (typeof ms !== 'number') return;
  state.serverNow = ms;
  serverNowAt = Date.now();
}
const estimateNow = () => (serverNowAt ? state.serverNow + (Date.now() - serverNowAt) * clockSpeed : state.serverNow);

// After an action of our own the socket replays it back at us; hush it for
// 400 ms and refetch once instead of rendering every echo (CP-21).
let suppressUntil = 0;
let hushTimer = null;
let lastActionAt = 0;
let lastBoardFetchAt = 0;
bus.addEventListener('api', (e) => {
  const { ok, method, path } = e.detail;
  if (!ok) return;
  contact();
  if (offlineNoted) { offlineNoted = false; setBanner(null); }
  if (method !== 'GET' && path.startsWith('/api/clinic/')) {
    lastActionAt = Date.now();
    suppressUntil = lastActionAt + 400;
    clearTimeout(hushTimer);
    hushTimer = setTimeout(() => {
      if (isBoardTab() && lastBoardFetchAt < lastActionAt) fetchBoard().catch(() => {});
    }, 420);
  }
});

function noteOffline(err) {
  if (err?.status === 401) return;
  if (!offlineNoted) {
    offlineNoted = true;
    toast(err?.network ? "Can't reach the clinic server — showing what was last known" : (err?.message || 'The clinic server had a problem'), 'err');
  }
  setBanner(err?.network ? "Can't reach the clinic server — retrying" : 'The clinic server had a problem — retrying');
}

// ------------------------------------------------------------------- board
let boardEtag = null;
let boardInflight = null;
let boardStale = false;    // a socket message arrived while another tab was showing

const minute = (ms) => (ms ? Math.floor(ms / 60000) : '');
function projectionSig(p) {
  return [
    p.state, p.pause?.expectedResumeAt ?? '', p.nowServing?.tokenId ?? '', Math.floor(p.nowServing?.elapsedMinutes ?? 0),
    (p.entries || []).map((e) => `${e.tokenId}:${minute(e.predictedStart?.window?.from)}`).join(','),
  ].join('|');
}

function applyBoard(data) {
  state.board = data;
  setServerNow(data.serverNow);
  if (!state.doctorSessionId && data.sessions.length) state.doctorSessionId = data.sessions[0].id;
  for (const s of data.sessions) s._sig = s.projection ? projectionSig(s.projection) : '';
  if (isBoardTab()) activeView?.update('board');
}

/** GET /board once; conditional requests ride on the ETag so an unchanged board costs a 304. */
export async function fetchBoard({ conditional = false } = {}) {
  if (boardInflight) return boardInflight;
  boardInflight = (async () => {
    try {
      const r = await api('/api/clinic/board', { withMeta: true, etag: conditional ? boardEtag : null });
      lastBoardFetchAt = Date.now();
      if (r.notModified) return;
      boardEtag = r.etag;
      applyBoard(r.data);
    } finally {
      boardInflight = null;
    }
  })();
  return boardInflight;
}

/** Views call this after their own actions. Always unconditional. */
export async function refreshBoard() {
  await fetchBoard();
}

export async function refreshDemo() {
  if (state.demo_enabled === false) return;
  try {
    state.demo = await api('/api/demo/state');
    clockSpeed = state.demo?.clock?.speed ?? 1;
  } catch (err) {
    if (err.status === 404) state.demo_enabled = false;
  }
  updateRail();
}

function forward(reason, payload) {
  if (isBoardTab()) activeView?.update(reason, payload);
  else boardStale = true;
}

function applyProjection(msg) {
  const session = state.board.sessions.find((s) => s.id === msg.sessionId);
  if (!session) { boardStale = true; if (isBoardTab()) fetchBoard().catch(() => {}); return false; }
  session.projection = msg;
  if (msg.state) session.state = msg.state;
  for (const token of session.tokens) token.projection = msg.entries?.find((e) => e.tokenId === token.id) ?? null;
  setServerNow(msg.computedAt);
  const sig = projectionSig(msg);
  // The new backend only publishes material changes and says which tokens moved;
  // the old one publishes every second, so we diff what matters ourselves.
  const material = Array.isArray(msg.changedTokenIds) || sig !== session._sig;
  session._sig = sig;
  return material;
}

function applyToken(msg) {
  const session = state.board.sessions.find((s) => s.id === msg.sessionId);
  if (!session || !msg.token) { boardStale = true; if (isBoardTab()) fetchBoard().catch(() => {}); return; }
  const i = session.tokens.findIndex((t) => t.id === msg.token.id);
  if (msg.action === 'reassigned_out') { if (i >= 0) session.tokens.splice(i, 1); return; }
  if (i >= 0) session.tokens[i] = msg.token;
  else session.tokens.push(msg.token);
  session.tokens.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

function applySession(msg) {
  const session = state.board.sessions.find((s) => s.id === msg.session?.id);
  if (!session) { boardStale = true; if (isBoardTab()) fetchBoard().catch(() => {}); return; }
  const { tokens, projection } = session;
  Object.assign(session, msg.session, { tokens: msg.session.tokens ?? tokens, projection: msg.session.projection ?? projection });
}

function onSocket(msg) {
  if (msg.type === '_status') {
    state.connection = msg.status;
    if (msg.status === 'live') {
      contact();
      // Reconcile after a gap: whatever happened while the socket was down.
      if (wasOffline) { if (isBoardTab()) fetchBoard().catch(() => {}); else boardStale = true; }
      wasOffline = false;
    } else {
      wasOffline = true;
    }
    updateLive();
    return;
  }
  contact();
  if (msg.type === 'pong' || msg.type === 'subscribed') return;
  if (Date.now() < suppressUntil) return;
  switch (msg.type) {
    case 'projection':
      if (applyProjection(msg)) forward('projection', msg);
      break;
    case 'tick':
      serverTicks = true;
      setServerNow(msg.serverNow);
      forward('tick', msg);
      break;
    case 'token.changed':
      applyToken(msg);
      forward('token', msg);
      break;
    case 'session.changed':
      applySession(msg);
      forward('session', msg);
      break;
    case 'doctor.request':
      if (state.staff?.role !== 'doctor') {
        toast(`${msg.doctorName || 'The doctor'} asks to see ${msg.patientName || msg.display} next`, { duration: 8000 });
      }
      forward('doctor.request', msg);
      break;
    default:
      // message_sent and anything newer: the Messages tab is the record.
      break;
  }
}

// ------------------------------------------------------------------- login
/**
 * One sign-in form. Your username says who you are; the clinic follows from
 * that. Nothing is listed. A clinic's own address, if used, only brands the
 * page and narrows it to that clinic's accounts.
 */
function loginScreen() {
  const root = h('div.login');
  const username = h('input.input', { placeholder: 'e.g. shaira', autocomplete: 'username', autocapitalize: 'none', name: 'username', required: true });
  const password = h('input.input', { placeholder: 'Password', type: 'password', autocomplete: 'current-password', name: 'password', required: true });
  const error = h('div.form-error', { role: 'alert' });
  const button = h('button.btn.primary.lg.block', { type: 'submit' }, 'Sign in');
  let clinic = null;
  let demo = null;

  const submit = async (e) => {
    e.preventDefault();
    error.textContent = '';
    const body = { username: username.value.trim(), password: password.value };
    if (!body.username || !body.password) { error.textContent = 'Enter your username and password.'; (body.username ? password : username).focus(); return; }
    try {
      const session = await busy(button, api(slug ? `/api/auth/clinic/${slug}/login` : '/api/auth/login', { method: 'POST', body }), 'Signing in…');
      saveSession(session);
      await boot(session);
    } catch (err) {
      error.textContent = err.status === 401 || err.status === 403 ? (err.message || 'That username and password do not match.') : (err.message || 'Could not sign in.');
      password.select();
    }
  };
  for (const el of [username, password]) el.addEventListener('input', () => { error.textContent = ''; });

  const demoBlock = (d) => h('div', { style: { marginBottom: '8px' } },
    h('div', { style: { fontWeight: 700 } }, d.clinic),
    d.users.map((u) => h('div', {}, h('span.mono', {}, u.username), ` — ${u.name}, ${u.role}`)),
    h('div', {}, 'Password: ', h('span.mono', {}, d.password)));

  const form = h('form', { onSubmit: submit, novalidate: true },
    h('label.field', {}, h('span', {}, 'Username'), username),
    h('label.field', {}, h('span', {}, 'Password'), password),
    error,
    button);

  // The form node is reused across draws; moving it drops focus, so put it back.
  const draw = () => { drawBox(); if (root.isConnected && document.activeElement === document.body) username.focus(); };
  const drawBox = () => mount(root, h('div.box.stack', {},
    slug ? h('div.crumb', {}, h('span', {}, `/clinic/${slug}/`)) : null,
    h('h1', {}, clinic ? clinic.name : 'Sign in'),
    h('p.lede', {}, clinic
      ? `${clinic.island}, ${clinic.atoll} Atoll. Only this clinic's accounts work here.`
      : 'Your username is yours alone, and it already knows which clinic you belong to.'),
    form,
    demo ? h('details.help', {},
      h('summary', {}, 'Demo sign-ins'),
      h('div', { style: { marginTop: '8px' } },
        (Array.isArray(demo) ? demo : [demo]).map(demoBlock),
        h('div.dim', {}, 'Shown only while the server runs in demo mode.'))) : null));

  if (slug) {
    api(`/api/auth/clinic/${slug}`)
      .then((c) => { clinic = c; demo = c.demo ? { clinic: c.name, ...c.demo } : null; draw(); })
      .catch(() => mount(root, h('div.box.stack', {},
        h('h1', {}, 'No clinic at this address'),
        h('p.lede', {}, `There is no clinic at /clinic/${slug}/. You can sign in without it.`),
        h('a.btn.primary', { href: '/clinic/' }, 'Go to sign-in'))));
  } else {
    api('/api/auth/sign-in').then((d) => { demo = d.demo; draw(); }).catch(() => {});
  }
  draw();
  requestAnimationFrame(() => username.focus());
  return root;
}

/** First sign-in with a generated password: change it before doing anything else. Runs before the poll and socket start (CP-01). */
function changePasswordScreen(onDone) {
  const current = h('input.input', { type: 'password', placeholder: 'The password you were given', autocomplete: 'current-password', required: true });
  const next = h('input.input', { type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password', required: true, minlength: 8 });
  const error = h('div.form-error', { role: 'alert' });
  const button = h('button.btn.primary.lg.block', { type: 'submit' }, 'Save and continue');
  for (const el of [current, next]) el.addEventListener('input', () => { error.textContent = ''; });
  const form = h('form', {
    novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (!current.value) { error.textContent = 'Enter the password you were given.'; current.focus(); return; }
      if (next.value.length < 8) { error.textContent = 'The new password needs at least 8 characters.'; next.focus(); return; }
      try {
        await busy(button, api('/api/auth/change-password', { method: 'POST', body: { currentPassword: current.value, newPassword: next.value } }), 'Saving…');
        state.session.staff.mustChangePassword = false;
        state.staff.mustChangePassword = false;
        saveSession(state.session);
        toast('Password changed');
        onDone();
      } catch (err) {
        error.textContent = err.message || 'Could not change the password.';
        (err.status === 401 || err.status === 403 ? current : next).focus();
      }
    },
  },
  h('label.field', {}, h('span', {}, 'Current password'), current),
  h('label.field', {}, h('span', {}, 'New password'), next),
  error,
  button);
  const root = h('div.login', {}, h('div.box.stack', {},
    h('h1', {}, `Welcome, ${state.staff.name.split(' ')[0]}`),
    h('p.lede', {}, 'You signed in with a password someone gave you. Choose your own before continuing.'),
    form,
    h('div.foot', {},
      h('span.help', {}, 'Not you, or given the wrong password?'),
      h('button.link', { type: 'button', onClick: () => signOut() }, 'Sign out'))));
  requestAnimationFrame(() => current.focus());
  return root;
}

/** Bootstrap failed for a reason that is not "sign in again": keep the session, keep trying (CP-04). */
function retryScreen(err, retry) {
  const button = h('button.btn.primary.lg.block', { onClick: () => busy(button, retry(), 'Retrying…') }, 'Try again');
  return h('div.login', {}, h('div.box.stack', {},
    h('h1', {}, "Can't reach the clinic server"),
    h('p.lede', {}, err?.network
      ? 'The link to the server is down. Your sign-in is kept; this page keeps trying on its own.'
      : `${err?.message || 'The server had a problem'}. Your sign-in is kept; this page keeps trying on its own.`),
    button,
    h('div.foot', {}, h('span.help', {}, 'Wrong account?'), h('button.link', { type: 'button', onClick: () => signOut({ server: false }) }, 'Sign out'))));
}

// ------------------------------------------------------------------- shell
const initials = (name) => (name || '?').replace('Dr. ', '').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

function railPinned() { try { return localStorage.getItem(RAIL_KEY) === 'pinned'; } catch { return false; } }
function setRailPinned(on) {
  try { localStorage.setItem(RAIL_KEY, on ? 'pinned' : 'rail'); } catch { /* private mode */ }
  shell?.root.classList.toggle('pinned', on);
  if (shell) shell.refs.pin.setAttribute('aria-expanded', String(on));
}

function buildShell() {
  const refs = {};
  const rail = h('aside.rail', { 'aria-label': 'Navigation' });
  refs.nav = {};

  // Brand: the clinic, as a mark when collapsed and a name when pinned.
  rail.append(h('div.brand', {},
    h('span.av', { 'aria-hidden': true }, refs.brandAv = h('span', {}, initials(state.clinic.name))),
    h('span.lbl', {}, refs.clinicName = h('div.name', {}, state.clinic.name), refs.clinicWhere = h('div.where', {}, `${state.clinic.island}, ${state.clinic.atoll} Atoll`))));

  rail.append(h('nav', { 'aria-label': 'Sections' }, TABS.map(([key, label], i) => (refs.nav[key] = h('button', {
    type: 'button', 'aria-label': label, 'data-tip': label, 'data-focus-key': `nav-${key}`,
    onClick: (e) => { setTab(key); if (e.detail) e.currentTarget.blur(); },
  }, h('span.ico', { html: ICONS[key] }), h('span.lbl', { 'aria-hidden': true }, label), h('kbd', { 'aria-hidden': true }, String(i + 1)))))));

  rail.append(h('div.spacer'));

  // Demo controls: a details block when pinned, one button that expands the rail when not.
  refs.demoGo = h('button.ib.demo-go', { type: 'button', 'aria-label': 'Demo controls', 'data-tip': 'Demo controls', onClick: () => { setRailPinned(true); state.demoOpen = true; refs.demo.open = true; refs.demoSummary.focus(); } },
    h('span.ico', { html: ICONS.play }), refs.demoBadge = h('span.badge', { hidden: true }));
  refs.demo = h('details.demo', { open: !!state.demoOpen, onToggle: (e) => { state.demoOpen = e.target.open; } },
    refs.demoSummary = h('summary', {}, '▸ Demo controls', refs.demoPill = h('span.pill.ok', { hidden: true })),
    h('div.body', {},
      refs.demoStatus = h('div.status'),
      h('div.row', {},
        refs.demoRun = h('button.btn.sm.primary.grow', { type: 'button', onClick: (e) => busy(e.currentTarget, runDay(10)) }, '▶ Run ×10'),
        h('button.btn.sm.grow', { type: 'button', onClick: (e) => busy(e.currentTarget, runDay(30)) }, '×30'),
        h('button.btn.sm.grow', { type: 'button', onClick: (e) => busy(e.currentTarget, stopDay()) }, '⏸ Stop')),
      h('button.btn.sm.ghost', {
        type: 'button',
        onClick: async () => {
          const ok = await confirmDialog({
            title: 'Reseed the demo database?',
            body: 'All current activity is discarded and everyone will need to sign in again.',
            confirm: 'Reseed', danger: true,
          });
          if (!ok) return;
          await guard(() => api('/api/demo/reseed', { method: 'POST' }), 'Reseeded');
          await signOut();
        },
      }, 'Reseed demo data')));
  if (state.demo_enabled !== false) rail.append(refs.demoGo, refs.demo);

  refs.pin = h('button.ib.pin', { type: 'button', 'aria-label': 'Expand navigation', 'data-tip': 'Expand', 'aria-expanded': railPinned(), onClick: () => setRailPinned(!railPinned()) },
    h('span.ico', { html: ICONS.pin }), h('span.lbl', { 'aria-hidden': true }, 'Collapse'));
  rail.append(refs.pin);

  // Account: avatar opens a menu (clinic, theme, sign out) — the only place that
  // survives the portrait tab bar, so sign-out is never lost (F19).
  refs.avatar = h('button.ib.av-btn', { type: 'button', 'aria-label': `Account: ${state.staff.name}`, 'aria-haspopup': 'menu', 'aria-expanded': false, 'data-tip': state.staff.name, 'data-focus-key': 'account', onClick: (e) => openAccountMenu(e.currentTarget) },
    h('span.av', { 'aria-hidden': true }, initials(state.staff.name)));
  rail.append(refs.who = h('div.who', {},
    refs.avatar,
    h('span.meta', {}, refs.whoName = h('div.n', {}, state.staff.name), refs.whoRole = h('div.role', {}, state.staff.role)),
    h('button.btn.ghost.icon.out', { type: 'button', 'aria-label': 'Sign out', title: 'Sign out', onClick: () => signOut() }, h('span', { html: ICONS.power, 'aria-hidden': true }))));

  // Tooltips: first hover waits 300 ms, the next ones are instant.
  let hot = null;
  rail.addEventListener('pointerover', (e) => {
    if (!e.target.closest?.('[data-tip]')) return;
    clearTimeout(hot);
    hot = setTimeout(() => rail.classList.add('hot'), 300);
  });
  rail.addEventListener('pointerleave', () => { clearTimeout(hot); hot = setTimeout(() => rail.classList.remove('hot'), 500); });

  // Header.
  const head = h('header.head', {},
    h('div.titles', {}, refs.title = h('h1', {}, ''), refs.sub = h('div.sub', {}, '')),
    h('div.grow'),
    refs.walkin = h('button.btn.primary', { type: 'button', onClick: () => boardMod.openWalkIn() }, '+ Walk-in ', h('kbd', { 'aria-hidden': true }, 'W')),
    h('button.btn.icon.search', { type: 'button', 'aria-label': 'Search (⌘K)', onClick: () => boardMod.openPalette() },
      h('span', { html: ICONS.search, 'aria-hidden': true }), h('span.lbl', {}, 'Search'), h('kbd', { 'aria-hidden': true }, '⌘K')),
    h('span.live', { role: 'status', 'aria-live': 'polite' },
      refs.liveDot = h('span.live-dot'), refs.liveText = h('span.txt', {}, 'Connecting…'), refs.liveSince = h('span.since')),
    refs.clock = h('span.clock', { 'aria-label': 'Clinic time' }, hhmm(state.serverNow)));

  const banner = h('div.banner', { role: 'status', hidden: true }, refs.bannerText = h('span'),
    h('button.btn.sm', { type: 'button', onClick: () => { if (isBoardTab()) fetchBoard().catch(noteOffline); else heartbeatOnce(); } }, 'Retry now'));
  const view = h('div.view', { 'data-keep-scroll': 'view' });
  const root = h('div.shell', { class: railPinned() ? 'pinned' : '' }, rail, h('div.main', {}, head, banner, view));
  return { root, rail, head, view, banner, refs };
}

function setBanner(text) {
  if (!shell) return;
  shell.refs.bannerText.textContent = text || '';
  shell.banner.hidden = !text;
}

function openAccountMenu(trigger) {
  if (!shell) return;
  closeAccountMenu();
  const item = (label, icon, onClick, cls = '') => h(`button${cls}`, { type: 'button', role: 'menuitem', onClick: () => { closeAccountMenu(); onClick(); } }, icon ? h('span.ico', { html: icon, 'aria-hidden': true }) : null, label);
  const menu = h('div.menu.account', { role: 'menu', 'aria-label': 'Account' },
    h('div.who', {}, h('b', {}, state.staff.name), `${state.staff.role} · ${state.clinic.name}`),
    h('hr'),
    item(theme.current() === 'dark' ? 'Switch to light' : 'Switch to dark', ICONS.theme, () => theme.toggle()),
    item('Sign out', ICONS.power, () => signOut(), '.danger'));
  const close = () => {
    if (!menu.isConnected) return;
    menu.remove();
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keys, true);
    trigger.focus({ preventScroll: true });
  };
  const outside = (e) => { if (!menu.contains(e.target) && e.target !== trigger) close(); };
  const keys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    const items = $$('[role="menuitem"]', menu);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  };
  shell.refs.who.append(menu);
  trigger.setAttribute('aria-expanded', 'true');
  shell._closeAccount = close;
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keys, true);
  $$('[role="menuitem"]', menu)[0]?.focus();
}
function closeAccountMenu() { shell?._closeAccount?.(); shell && (shell._closeAccount = null); }

async function runDay(speed) {
  await guard(async () => {
    await api('/api/clinic/demo/run-day', { method: 'POST' });
    await api('/api/demo/clock', { method: 'POST', body: { speed } });
  }, `Simulating the evening at ×${speed}`);
  await refreshDemo();
}
async function stopDay() {
  await guard(async () => {
    await api('/api/clinic/demo/stop-day', { method: 'POST' });
    await api('/api/demo/clock', { method: 'POST', body: { speed: 1 } });
  }, 'Simulation stopped');
  await refreshDemo();
}

/** Rail text and state, patched in place. */
function updateRail() {
  if (!shell) return;
  const { refs } = shell;
  for (const [key, btn] of Object.entries(refs.nav)) {
    if (state.tab === key) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  refs.clinicName.textContent = state.clinic.name;
  refs.brandAv.textContent = initials(state.clinic.name);
  refs.clinicWhere.textContent = `${state.clinic.island}, ${state.clinic.atoll} Atoll`;
  refs.whoName.textContent = state.staff.name;
  refs.whoRole.textContent = state.staff.role;
  const d = state.demo;
  const running = d?.simulating?.length ?? 0;
  refs.demoStatus.textContent = running
    ? `The evening runs by itself at ×${d?.clock?.speed ?? 1}${d?.staleness?.length ? ' · ⚠ stale projection' : ''}`
    : `Paused · clock ×${d?.clock?.speed ?? 1}`;
  refs.demoPill.hidden = !running;
  refs.demoPill.textContent = running ? `${running} live` : '';
  refs.demoBadge.hidden = !running;
  refs.demoBadge.textContent = running ? String(running) : '';
  if (!refs.demoRun.dataset.busy) refs.demoRun.textContent = running ? '×10' : '▶ Run ×10';
  refs.pin.setAttribute('aria-label', railPinned() ? 'Collapse navigation' : 'Expand navigation');
  refs.pin.dataset.tip = railPinned() ? 'Collapse' : 'Expand';
}

function updateHeader() {
  if (!shell) return;
  const { refs } = shell;
  const [, title, , sub] = TABS.find(([k]) => k === state.tab) ?? TABS[0];
  refs.title.textContent = title;
  refs.sub.textContent = sub;
  refs.walkin.hidden = state.tab !== 'board';
  document.title = `${title} · ${state.clinic?.name || 'Vaguthu Clinic'}`;
  updateLive();
}

/** "Live" means we heard from the server (HTTP or socket) within 10 s (CP-06). */
function updateLive() {
  if (!shell) return;
  const { refs } = shell;
  const fresh = lastContact && Date.now() - lastContact < 10000;
  const socketUp = state.connection === 'live';
  refs.liveDot.className = `live-dot ${fresh ? (socketUp ? '' : 'stale') : 'off'}`;
  refs.liveText.textContent = fresh ? 'Live' : 'Reconnecting…';
  refs.liveSince.textContent = fresh || !lastContact ? '' : `since ${hhmm(state.serverNow - (Date.now() - lastContact) * clockSpeed)}`;
  refs.clock.textContent = hhmm(estimateNow());
}

/** Switch tabs: swaps the view container's child, patches rail/header, keeps the hash honest. */
export function setTab(key) {
  if (!TAB_KEYS.includes(key)) key = 'board';
  state.tab = key;
  if (location.hash.slice(1) !== key) location.hash = key;
  if (!shell) return;
  if (mountedTab === key) { updateRail(); updateHeader(); return; }
  closeAccountMenu();
  activeView?.unmount();
  mountedTab = key;
  activeView = VIEWS[key];
  shell.view.className = `view${key === 'board' ? ' board-view' : ''}`;
  shell.view.dataset.tab = key;
  shell.view.scrollTop = 0;
  activeView.mount(shell.view);
  if (isBoardTab() && boardStale) { boardStale = false; fetchBoard().catch(noteOffline); }
  updateRail();
  updateHeader();
}

addEventListener('hashchange', () => {
  const key = location.hash.slice(1);
  if (state.session && TAB_KEYS.includes(key) && key !== state.tab) setTab(key);
});

function mountShell() {
  const root = document.getElementById('root');
  shell = buildShell();
  screen = 'shell';
  mount(root, shell.root);
  mountedTab = null;
  setTab(state.tab);
}

/**
 * Compatibility entry point for views: "something changed, reconcile".
 * Coalesced per frame. Never rebuilds the shell; on the sign-in/password
 * screens it only (re)mounts when the screen actually changes.
 */
let reconcileQueued = false;
export function render() {
  if (reconcileQueued) return;
  reconcileQueued = true;
  requestAnimationFrame(() => { reconcileQueued = false; reconcile(); });
}

function reconcile() {
  const root = document.getElementById('root');
  if (!state.session) {
    if (screen !== 'login') { screen = 'login'; shell = null; mount(root, loginScreen()); }
    return;
  }
  if (state.staff?.mustChangePassword) {
    if (screen !== 'password') { screen = 'password'; shell = null; mount(root, changePasswordScreen(() => startLive())); }
    return;
  }
  if (!shell) { mountShell(); return; }
  if (state.tab !== mountedTab) { setTab(state.tab); return; }
  activeView?.update('render');
}

// ---------------------------------------------------------------- hotkeys
const dialogOpen = () => !!document.querySelector('dialog[open], .palette-wrap, .menu.account');
const nothingFocused = () => {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement;
};
document.addEventListener('keydown', (e) => {
  if (!state.session || screen !== 'shell') return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); boardMod.openPalette(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (dialogOpen() || !nothingFocused()) return;
  if (e.key === 'w' || e.key === 'W') { e.preventDefault(); boardMod.openWalkIn(); return; }
  if (e.key === '/') { e.preventDefault(); boardMod.openPalette(); return; }
  if (e.key >= '1' && e.key <= '7') {
    const tab = TABS[Number(e.key) - 1];
    if (tab) setTab(tab[0]);
  }
});

// ------------------------------------------------------------------- boot
async function heartbeatOnce() {
  if (!state.session || isBoardTab()) return;
  try {
    await api(heartbeatPath);
  } catch (err) {
    if (err.status === 404 && heartbeatPath === '/api/auth/me') { heartbeatPath = '/api/clinic/bootstrap'; return; }
    noteOffline(err);
  }
}
let heartbeatPath = '/api/auth/me';

function stopLive() {
  socket?.close();
  socket = null;
  clearInterval(poll);
  clearInterval(heartbeat);
  clearInterval(ticker);
  clearTimeout(hushTimer);
  poll = heartbeat = ticker = null;
  closeAccountMenu();
}

/** Everything that talks to the server on a schedule starts here — after sign-in and after any forced password change. */
async function startLive() {
  stopLive();
  state.staff.mustChangePassword = false;
  screen = null;
  try { await fetchBoard(); } catch (err) { noteOffline(err); }
  await refreshDemo();
  mountShell();
  if (offlineNoted) setBanner("Can't reach the clinic server — retrying");

  socket = connect([`clinic:${state.clinic.id}`], onSocket, { pingMs: 5000 });

  // The poll fetches only what the active tab needs: the board for board/doctor,
  // nothing else but demo state. Hidden tabs wait for visibility.
  poll = setInterval(async () => {
    if (document.hidden || !state.session) return;
    if (isBoardTab()) {
      try { await fetchBoard({ conditional: true }); } catch (err) { noteOffline(err); }
    }
    refreshDemo();
  }, 4000);

  // A dead session must surface even on tabs that fetch nothing (CP-03).
  heartbeat = setInterval(heartbeatOnce, 60000);

  // One second: the clock, the Live chip, and the doctor's timer via 'tick' when the backend sends none.
  ticker = setInterval(() => {
    if (serverNowAt) state.serverNow = estimateNow();
    updateLive();
    if (!serverTicks && state.tab === 'doctor') activeView?.update('tick');
  }, 1000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.session && shell && isBoardTab()) fetchBoard({ conditional: true }).catch(noteOffline);
});

async function boot(session) {
  state.session = session;
  setAuth(session.token);
  let data;
  booting = true;
  try {
    data = await api('/api/clinic/bootstrap');
  } catch (err) {
    booting = false;
    if (err.status === 401 || err.status === 403) {
      setAuth(null); saveSession(null); state.session = null;
      render();
      throw err;
    }
    // Network or 5xx: keep the session and keep trying, backing off (CP-04).
    const retry = async () => { try { await boot(session); } catch { /* the screen stays */ } };
    const timer = setTimeout(retry, bootBackoff);
    bootBackoff = Math.min(bootBackoff * 2, 15000);
    screen = 'retry';
    mount(document.getElementById('root'), retryScreen(err, () => { clearTimeout(timer); return retry(); }));
    throw err;
  }
  booting = false;
  bootBackoff = 2000;
  Object.assign(state, data);
  state.demo_enabled = data.demo !== false;
  state.staff = { ...data.staff, mustChangePassword: !!session.staff?.mustChangePassword };
  clockSpeed = 1;
  const wanted = (location.hash || '').slice(1);
  state.tab = TAB_KEYS.includes(wanted) ? wanted : (LANDING[state.staff.role] || 'board');
  if (state.staff.mustChangePassword) { render(); return; }
  await startLive();
}

let bootBackoff = 2000;
const saved = loadSession();
if (saved?.token) {
  boot(saved).catch(() => { /* boot showed the right screen */ });
} else {
  render();
}
