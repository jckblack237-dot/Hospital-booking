import { h, mount, api, setAuth, connect, hhmm, toast, initTheme, guard } from '/shared/core.js';
import { renderBoard, boardOnMessage, openPalette, openWalkIn } from '/clinic/views/board.js';
import { renderDoctor } from '/clinic/views/doctor.js';
import { renderPatients } from '/clinic/views/patients.js';
import { renderBilling } from '/clinic/views/billing.js';
import { renderAnalytics } from '/clinic/views/analytics.js';
import { renderMessages } from '/clinic/views/messages.js';
import { renderSettings } from '/clinic/views/settings.js';

export const state = {
  session: null, clinic: null, staff: null, doctors: [], penaltyPolicy: null,
  board: { sessions: [], day: null },
  serverNow: Date.now(), connection: 'connecting', tab: 'board',
  doctorSessionId: null, demo: null, selectedPatient: null,
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

const theme = initTheme();
let socket;
let poll;

// ----------------------------------------------------------------- session
/** Optional: a clinic's own address, /clinic/<slug>/, brands the sign-in page and accepts only its accounts. */
export const slug = (location.pathname.match(/^\/clinic\/([a-z0-9-]+)/) || [])[1] || null;
const SESSION_KEY = 'vaguthu-clinic-session';

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function saveSession(s) {
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
}

async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* already gone */ }
  setAuth(null);
  saveSession(null);
  state.session = null;
  socket?.close();
  clearInterval(poll);
  render();
}

/** Any 401 means the desk has to sign in again — quietly, without losing the page. */
export async function call(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status === 401) {
      toast('Your session ended — please sign in again', 'err');
      await signOut();
    }
    throw err;
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
  const username = h('input.input', { placeholder: 'e.g. shaira', autocomplete: 'username', autofocus: true, autocapitalize: 'none' });
  const password = h('input.input', { placeholder: 'Password', type: 'password', autocomplete: 'current-password' });
  let clinic = null;
  let demo = null;

  const submit = () => guard(async () => {
    const session = await api(slug ? `/api/auth/clinic/${slug}/login` : '/api/auth/login', {
      method: 'POST', body: { username: username.value.trim(), password: password.value },
    });
    saveSession(session);
    await boot(session);
  });
  for (const el of [username, password]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  const demoBlock = (d) => h('div', { style: { marginBottom: '8px' } },
    h('div', { style: { fontWeight: 700 } }, d.clinic),
    d.users.map((u) => h('div', {}, h('span.mono', {}, u.username), ` — ${u.name}, ${u.role}`)),
    h('div', {}, 'Password: ', h('span.mono', {}, d.password)));

  const draw = () => mount(root, h('div.box.stack', {},
    slug ? h('div.crumb', {}, h('span', {}, `/clinic/${slug}/`)) : null,
    h('h1', {}, clinic ? clinic.name : 'Sign in'),
    h('p.lede', {}, clinic
      ? `${clinic.island}, ${clinic.atoll} Atoll. Only this clinic's accounts work here.`
      : 'Your username is yours alone, and it already knows which clinic you belong to.'),
    h('label.field', {}, h('span', {}, 'Username'), username),
    h('label.field', {}, h('span', {}, 'Password'), password),
    h('button.btn.primary.lg.block', { onClick: submit }, 'Sign in'),
    demo ? h('details.help', {},
      h('summary', { style: { cursor: 'pointer', fontWeight: 700 } }, 'Demo sign-ins'),
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
  return root;
}

/** First sign-in with a generated password: change it before doing anything else. */
function changePasswordScreen() {
  const current = h('input.input', { type: 'password', placeholder: 'The password you were given', autocomplete: 'current-password' });
  const next = h('input.input', { type: 'password', placeholder: 'At least 8 characters', autocomplete: 'new-password' });
  return h('div.login', {}, h('div.box.stack', {},
    h('h1', {}, `Welcome, ${state.staff.name.split(' ')[0]}`),
    h('p.lede', {}, 'You signed in with a password someone gave you. Choose your own before continuing.'),
    h('label.field', {}, h('span', {}, 'Current password'), current),
    h('label.field', {}, h('span', {}, 'New password'), next),
    h('button.btn.primary.lg.block', {
      onClick: () => guard(async () => {
        await api('/api/auth/change-password', { method: 'POST', body: { currentPassword: current.value, newPassword: next.value } });
        state.session.staff.mustChangePassword = false;
        state.staff.mustChangePassword = false;
        saveSession(state.session);
        render();
      }, 'Password changed'),
    }, 'Save and continue')));
}

// ------------------------------------------------------------------- shell
export async function refreshBoard() {
  const data = await call(() => api('/api/clinic/board'));
  state.board = data;
  state.serverNow = data.serverNow;
  if (!state.doctorSessionId && data.sessions.length) state.doctorSessionId = data.sessions[0].id;
  render();
}

export async function refreshDemo() {
  state.demo = await api('/api/demo/state');
}

function sidebar() {
  const initials = (name) => name.split(' ').map((w) => w[0]).join('').slice(0, 2);
  const d = state.demo;
  const running = d?.simulating?.length ?? 0;
  return h('aside.side', {},
    h('div.clinic', {},
      h('div.name', {}, state.clinic.name),
      h('div.where', {}, `${state.clinic.island}, ${state.clinic.atoll} Atoll`),
      h('div.yours', { title: `Your clinic's own address: /clinic/${state.clinic.slug}/` }, '🔒 Your clinic only')),
    h('nav', {}, TABS.map(([key, label, ico], i) =>
      h('button', {
        'aria-current': state.tab === key ? 'page' : null,
        onClick: () => { state.tab = key; location.hash = key; render(); },
      }, h('span.ico', { html: ICONS[ico] }), label, h('kbd', {}, String(i + 1))))),
    h('div.spacer'),
    h('details.demo', { open: running > 0 },
      h('summary', {}, '▸ Demo controls', running ? h('span.pill.ok', {}, `${running} live`) : null),
      h('div.body', {},
        h('div.status', {}, `Clock ×${d?.clock?.speed ?? 1}${d?.staleness?.length ? ' · ⚠ stale projection' : ''}`),
        h('button.btn.sm.primary', { onClick: () => runDay(20) }, '▶ Run the evening (×20)'),
        h('div.row', {},
          h('button.btn.sm.grow', { onClick: () => runDay(60) }, '×60'),
          h('button.btn.sm.grow', { onClick: () => stopDay() }, '⏸ Stop')),
        h('button.btn.sm.ghost', {
          onClick: async () => {
            if (!confirm('Reseed the demo database? All current activity is discarded and you will need to sign in again.')) return;
            await guard(() => api('/api/demo/reseed', { method: 'POST' }), 'Reseeded');
            await signOut();
          },
        }, 'Reseed demo data'))),
    h('div.who', {},
      h('span.av', {}, initials(state.staff.name)),
      h('span.grow', {}, h('div', { style: { fontWeight: 700, fontSize: '14px' } }, state.staff.name), h('div.role', {}, state.staff.role)),
      h('button.btn.sm.ghost', { onClick: signOut, title: 'Sign out' }, '⏻')),
  );
}

async function runDay(speed) {
  await guard(async () => {
    await api('/api/clinic/demo/run-day', { method: 'POST' });
    await api('/api/demo/clock', { method: 'POST', body: { speed } });
  }, `Simulating the evening at ×${speed}`);
  await refreshDemo();
  render();
}
async function stopDay() {
  await api('/api/clinic/demo/stop-day', { method: 'POST' });
  await api('/api/demo/clock', { method: 'POST', body: { speed: 1 } });
  await refreshDemo();
  render();
}

function header() {
  const [, title, , sub] = TABS.find(([k]) => k === state.tab) ?? TABS[0];
  return h('div.head', {},
    h('div', {}, h('h1', {}, title), h('div.sub', {}, sub)),
    h('div.grow'),
    state.tab === 'board' ? h('button.btn.primary', { onClick: () => openWalkIn() }, '+ Walk-in ', h('kbd', { style: { opacity: .7 } }, 'W')) : null,
    h('button.btn', { onClick: () => openPalette() }, 'Search ', h('kbd', {}, '⌘K')),
    h('span.live', {},
      h('span', { class: `live-dot ${state.connection === 'live' ? '' : 'off'}` }),
      state.connection === 'live' ? 'Live' : 'Reconnecting…'),
    h('span.clock', {}, hhmm(state.serverNow)),
    h('button.btn.sm.ghost', { onClick: () => theme.toggle(), title: 'Light / dark' }, '◐'),
  );
}

function view() {
  switch (state.tab) {
    case 'doctor': return renderDoctor();
    case 'patients': return renderPatients();
    case 'billing': return renderBilling();
    case 'analytics': return renderAnalytics();
    case 'messages': return renderMessages();
    case 'settings': return renderSettings();
    default: return renderBoard();
  }
}

export function render() {
  const root = document.getElementById('root');
  if (!state.session) { mount(root, loginScreen()); return; }
  if (state.staff?.mustChangePassword) { mount(root, changePasswordScreen()); return; }
  const isBoard = state.tab === 'board';
  mount(root, h('div.shell', {}, sidebar(),
    h('div.main', {}, header(), h('div', { class: `view ${isBoard ? 'board-view' : ''}` }, view()))));
}

document.addEventListener('keydown', (e) => {
  if (!state.session) return;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (typing) return;
  if (e.key === 'w' || e.key === 'W') { e.preventDefault(); openWalkIn(); }
  if (e.key === '/') { e.preventDefault(); openPalette(); }
  if (e.key >= '1' && e.key <= '7') {
    const tab = TABS[Number(e.key) - 1];
    if (tab) { state.tab = tab[0]; render(); }
  }
});

async function boot(session) {
  state.session = session;
  setAuth(session.token);
  const data = await call(() => api('/api/clinic/bootstrap'));
  Object.assign(state, data);
  state.staff = { ...data.staff, mustChangePassword: !!session.staff?.mustChangePassword };
  state.tab = (location.hash || '#board').slice(1) || 'board';
  if (!TABS.some(([k]) => k === state.tab)) state.tab = 'board';
  await refreshBoard();
  await refreshDemo();

  socket?.close();
  socket = connect([`clinic:${state.clinic.id}`], (msg) => {
    if (msg.type === '_status') { state.connection = msg.status; render(); return; }
    boardOnMessage(msg);
  });

  clearInterval(poll);
  poll = setInterval(async () => {
    try {
      await refreshDemo();
      if (state.tab === 'board' || state.tab === 'doctor') await refreshBoard();
      else render();
    } catch { /* offline; the socket handler reports it */ }
  }, 4000);
  render();
}

const saved = loadSession();
if (saved?.token) {
  boot(saved).catch(() => { saveSession(null); state.session = null; render(); });
} else {
  render();
}
