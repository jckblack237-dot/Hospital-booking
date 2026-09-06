import { h, mount, api, connect, hhmm, toast, initTheme, guard } from '/shared/core.js';
import { renderBoard, boardOnMessage, openPalette, openWalkIn } from '/clinic/views/board.js';
import { renderDoctor } from '/clinic/views/doctor.js';
import { renderPatients } from '/clinic/views/patients.js';
import { renderBilling } from '/clinic/views/billing.js';
import { renderAnalytics } from '/clinic/views/analytics.js';
import { renderMessages } from '/clinic/views/messages.js';
import { renderSettings } from '/clinic/views/settings.js';

export const state = {
  clinic: null, doctors: [], staff: [], penaltyPolicy: null,
  board: { sessions: [], day: null },
  serverNow: Date.now(), connection: 'connecting', tab: 'board',
  doctorSessionId: null, demo: null,
};

const TABS = [
  ['board', 'Queue board'], ['doctor', 'Doctor'], ['patients', 'Patients'],
  ['billing', 'Billing'], ['analytics', 'Analytics'], ['messages', 'Messages'], ['settings', 'Settings'],
];

const theme = initTheme();
let socket;

export async function refreshBoard() {
  const data = await api(`/api/clinic/board?clinicId=${state.clinic.id}`);
  state.board = data;
  state.serverNow = data.serverNow;
  if (!state.doctorSessionId && data.sessions.length) state.doctorSessionId = data.sessions[0].id;
  render();
}

export async function refreshDemo() {
  state.demo = await api('/api/demo/state');
}

function nav() {
  return h('div.topbar',
    {},
    h('div.brand', {}, h('div.mark', {}, 'V'), 'Vaguthu Clinic'),
    h('nav.nav', {}, TABS.map(([key, label]) =>
      h('button', {
        'aria-current': state.tab === key ? 'page' : null,
        onClick: () => { state.tab = key; location.hash = key; render(); },
      }, label))),
    h('div.grow'),
    h('div.row', {},
      h('span', { class: `live-dot ${state.connection === 'live' ? '' : 'off'}`, title: `Realtime ${state.connection}` }),
      h('span.clock.mono', {}, hhmm(state.serverNow)),
      h('button.btn.sm.ghost', { onClick: () => theme.toggle(), title: 'Toggle theme' }, '◐'),
    ),
  );
}

/**
 * Demo controls. The virtual clock is a real part of the platform (server/lib/clock.js)
 * — everything reads time through it — which is what makes a three-hour clinic
 * session watchable in a few minutes.
 */
function simbar() {
  const d = state.demo;
  const running = d?.simulating?.length ?? 0;
  return h('div.simbar', {},
    h('strong', {}, 'Demo'),
    h('span.grow', {},
      running
        ? h('span.pill.ok', {}, `${running} session${running > 1 ? 's' : ''} simulating`)
        : h('span.pill', {}, 'idle'),
      h('span.dim', {}, `clock ×${d?.clock?.speed ?? 1}`),
      d?.staleness?.length ? h('span.pill.warn', {}, `${d.staleness.length} stale projection`) : null,
    ),
    h('button.btn.sm', { onClick: () => runDay(20) }, '▶ Run the evening (×20)'),
    h('button.btn.sm', { onClick: () => runDay(60) }, '×60'),
    h('button.btn.sm', { onClick: async () => { await api('/api/demo/stop-day', { method: 'POST' }); await refreshDemo(); render(); } }, '⏸ Stop'),
    h('button.btn.sm.ghost', {
      onClick: async () => {
        if (!confirm('Reseed the demo database? All current activity is discarded.')) return;
        await guard(() => api('/api/demo/reseed', { method: 'POST' }), 'Reseeded');
        await boot();
      },
    }, 'Reseed'),
  );
}

async function runDay(speed) {
  await guard(() => api('/api/demo/run-day', { method: 'POST', body: { clinicId: state.clinic.id, speed } }),
    `Simulating the evening at ×${speed}`);
  await refreshDemo();
  render();
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
  const isBoard = state.tab === 'board';
  mount(document.getElementById('root'),
    h('div.shell', {}, nav(), simbar(), h('div', { class: `view ${isBoard ? 'board-view' : ''}` }, view())));
}

document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (typing) return;
  // Keyboard-first: a receptionist with twelve people waiting will not reach
  // for a mouse.
  if (e.key === 'w' || e.key === 'W') { e.preventDefault(); openWalkIn(); }
  if (e.key === '/') { e.preventDefault(); openPalette(); }
  if (e.key >= '1' && e.key <= '7') {
    const tab = TABS[Number(e.key) - 1];
    if (tab) { state.tab = tab[0]; render(); }
  }
});

async function boot() {
  const data = await api('/api/clinic/bootstrap');
  Object.assign(state, data);
  state.tab = (location.hash || '#board').slice(1) || 'board';
  if (!TABS.some(([k]) => k === state.tab)) state.tab = 'board';
  await refreshBoard();
  await refreshDemo();

  socket?.close();
  socket = connect([`clinic:${state.clinic.id}`], (msg) => {
    if (msg.type === '_status') { state.connection = msg.status; render(); return; }
    boardOnMessage(msg);
  });

  // A slow poll behind the socket: reconnect-and-reconcile means never trusting
  // what we held while disconnected, and it also drives the demo clock display.
  setInterval(async () => {
    try {
      await refreshDemo();
      if (state.tab === 'board' || state.tab === 'doctor') await refreshBoard();
      else render();
    } catch { /* offline; the socket handler will report it */ }
  }, 4000);
  render();
}

boot().catch((err) => {
  console.error(err);
  toast(err.message, 'err');
  mount(document.getElementById('root'), h('div.empty', {}, `Could not start: ${err.message}`));
});
