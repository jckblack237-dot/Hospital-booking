import { h, api, hhmm, toast, guard, SOURCE_LABELS } from '/shared/core.js';
import { state, render, refreshBoard, call } from '/clinic/app.js';

let dragging = null;   // token id mid-drag — suppresses re-render until drop
let openCard = null;   // token id whose secondary actions are showing
let openMenu = null;   // session id whose "…" menu is showing

export function boardOnMessage(msg) {
  if (dragging) return;
  if (msg.type === 'projection') {
    const session = state.board.sessions.find((s) => s.id === msg.sessionId);
    if (!session) { refreshBoard(); return; }
    session.projection = msg;
    session.state = msg.state;
    for (const token of session.tokens) {
      token.projection = msg.entries.find((e) => e.tokenId === token.id) ?? null;
    }
    state.serverNow = msg.computedAt;
    render();
  } else if (msg.type === 'message_sent') {
    toast(`${msg.message.channel.toUpperCase()} sent to ${msg.message.patient_name}`);
  }
}

const STATUS = {
  booked: 'Not here yet', arrived: 'Here', called: 'Called', in_consult: 'In the room',
  penalised: 'Moved back', completed: 'Seen', no_show: 'Did not attend', cancelled: 'Cancelled',
};
const ACTIVE = new Set(['booked', 'arrived', 'called', 'penalised', 'in_consult']);
const WAITING = new Set(['booked', 'arrived', 'called', 'penalised']);
const BARS = { high: 3, medium: 2, low: 1 };

const initials = (name) => name.replace('Dr. ', '').split(' ').map((w) => w[0]).join('').slice(0, 2);

function confidence(level) {
  const on = BARS[level] ?? 0;
  return h('span.conf', { title: `Estimate confidence: ${level}` }, [0, 1, 2].map((i) => h('i', { class: i < on ? 'on' : '' })));
}

async function act(token, action, okMessage, body = {}) {
  openCard = null;
  await guard(() => call(() => api(`/api/clinic/tokens/${token.id}/${action}`, { method: 'POST', body })), okMessage);
  await refreshBoard();
}

function payerText(token) {
  const label = token.payer_type === 'aasandha' ? 'Aasandha'
    : token.payer_type === 'private' ? (token.insurer || 'Insured')
      : token.payer_type === 'corporate' ? 'Corporate' : 'Self-pay';
  if (token.payer_type === 'self_pay') return h('span', {}, label);
  const r = token.eligibility?.result;
  if (r === 'covered') return h('span', {}, label, ' ', h('span.ok', {}, '✓'));
  if (r === 'not_covered') return h('span.unv', {}, `${label} not covered`);
  // A technical failure is never shown as "not covered".
  return h('span.unv', { title: token.eligibility?.detail || 'Not checked yet' }, `${label} — check`);
}

/** Primary action: the one thing a receptionist most likely wants for this card. */
function primaryFor(token) {
  switch (token.state) {
    case 'booked': return ['checkin', 'Check in', 'Checked in'];
    case 'arrived': case 'penalised': return ['call', 'Call', `${token.display} called`];
    case 'called': return ['start', 'Start', 'Consultation started'];
    default: return null;
  }
}

function tokenCard(session, token, index, list) {
  const p = token.projection;
  const flags = token.flags || [];
  const active = ACTIVE.has(token.state);
  const draggable = active && token.state !== 'in_consult';
  const primary = primaryFor(token);

  const card = h('div', {
    class: `tok s-${token.state}${openCard === token.id ? ' open' : ''}`,
    draggable,
    dataset: { tokenId: token.id },
    onDragstart: (e) => { dragging = token.id; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', token.id); },
    onDragend: () => { dragging = null; card.classList.remove('dragging'); refreshBoard(); },
    onDragover: (e) => { if (dragging && dragging !== token.id) { e.preventDefault(); card.classList.add('drop-before'); } },
    onDragleave: () => card.classList.remove('drop-before'),
    onDrop: async (e) => {
      e.preventDefault(); e.stopPropagation();
      card.classList.remove('drop-before');
      const moved = e.dataTransfer.getData('text/plain');
      dragging = null;
      if (!moved || moved === token.id) return;
      const before = list[index - 1];
      await guard(() => call(() => api(`/api/clinic/tokens/${moved}/reorder`, {
        method: 'POST', body: { afterTokenId: before?.id ?? null, beforeTokenId: token.id },
      })), 'Queue reordered');
      await refreshBoard();
    },
  },
  h('div.l1', {},
    h('span.badge', {}, token.display),
    h('span.name', { title: token.patient_name }, token.patient_name),
    p && WAITING.has(token.state) ? h('span.when', { title: 'Likely start' }, hhmm(p.predictedStart.window.from)) : null,
    token.state === 'in_consult' && p?.nowServing ? h('span.when', {}, `${session.projection.nowServing.elapsedMinutes} min`) : null),

  h('div.l2', {},
    h('span', { class: `st ${token.state}` },
      STATUS[token.state] + (token.state === 'penalised' ? ` ×${token.penalty_count}` : '')),
    token.visit_type === 'new' && active ? h('span.dim', {}, '· New patient') : null,
    flags.includes('travel') ? h('span.flag', { title: `Travelling from ${token.travel_island}` }, `✈ ${token.travel_island}`) : null,
    flags.includes('priority') ? h('span.flag', { title: token.priority_reason }, '★ Priority') : null,
    flags.includes('needs_decision') ? h('span.flag.warn', { title: 'Travel-flagged: penalty held for your decision' }, '⚑ Your call') : null,
    token.on_my_way ? h('span.flag', {}, '🚶 On the way') : null),

  p && WAITING.has(token.state) ? h('div.l3', {},
    h('span.num', {}, `${hhmm(p.predictedStart.window.from)}–${hhmm(p.predictedStart.window.to)}`),
    confidence(p.predictedStart.confidence),
    h('span', {}, '·'), h('span', {}, p.tokensAhead > 0 ? `${p.tokensAhead} ahead` : 'Next'),
    h('span', {}, '·'), h('span', {}, SOURCE_LABELS[token.source] || token.source),
    h('span', {}, '·'), payerText(token),
    p.atRisk ? [h('span', {}, '·'), h('span.unv', {}, 'May not be reached today')] : null,
    token.invoice?.state === 'open' ? [h('span', {}, '·'), h('span.unv', {}, 'Payment due')] : null) : null,

  active ? h('div.go', {},
    primary ? h('button.btn.sm.primary', { onClick: (e) => { e.stopPropagation(); act(token, primary[0], primary[2]); } }, primary[1]) : null,
    token.state === 'in_consult'
      ? h('button.btn.sm.primary', { onClick: (e) => { e.stopPropagation(); endConsult(token); } }, 'End & call next') : null,
    token.state === 'booked'
      ? h('button.btn.sm', { onClick: (e) => { e.stopPropagation(); act(token, 'call', `${token.display} called`); } }, 'Call') : null,
    ['arrived', 'penalised'].includes(token.state)
      ? h('button.btn.sm', { onClick: (e) => { e.stopPropagation(); act(token, 'start', 'Consultation started'); } }, 'Start') : null,
    h('button.btn.sm.ghost', {
      title: 'More', style: { flex: '0 0 auto' },
      onClick: (e) => { e.stopPropagation(); openCard = openCard === token.id ? null : token.id; render(); },
    }, openCard === token.id ? '▴' : '⋯')) : null,

  openCard === token.id ? h('div.more', {},
    token.penalty_count > 0 || flags.includes('needs_decision')
      ? h('button.btn.sm', { onClick: () => act(token, 'revoke-penalty', 'Penalty undone') }, 'Undo penalty')
      : h('button.btn.sm', { onClick: () => act(token, 'penalty', 'Moved back') }, 'Apply penalty'),
    h('button.btn.sm', { onClick: () => act(token, 'no-show', 'Marked as not attending') }, 'Did not attend'),
    h('button.btn.sm.danger', { onClick: () => act(token, 'cancel', 'Cancelled') }, 'Cancel'),
    state.board.sessions.filter((s) => s.id !== session.id && ['scheduled', 'running', 'paused'].includes(s.state)).map((s) =>
      h('button.btn.sm.ghost', {
        onClick: () => guard(async () => {
          await call(() => api(`/api/clinic/tokens/${token.id}/reassign`, { method: 'POST', body: { sessionId: s.id } }));
          openCard = null; await refreshBoard();
        }, `Moved to ${s.doctor_name}`),
      }, `→ ${s.doctor_name.replace('Dr. ', '')}`))) : null,
  );
  return card;
}

async function endConsult(token) {
  await guard(() => call(() => api(`/api/clinic/tokens/${token.id}/end`, { method: 'POST', body: { callNext: true } })), 'Done — next patient called');
  await refreshBoard();
}

async function sessionAct(session, action, okMessage, body = {}) {
  openMenu = null;
  await guard(() => call(() => api(`/api/clinic/sessions/${session.id}/${action}`, { method: 'POST', body })), okMessage);
  await refreshBoard();
}

function delaySession(session) {
  const minutes = Number(prompt(`How many minutes late will ${session.doctor_name} be?\n\nEveryone waiting will be told their new time.`, '25'));
  if (!minutes) return;
  sessionAct(session, 'delay', 'Delay set — everyone waiting has been told', { minutes });
}

/** Cost is shown before sending: messaging is the biggest variable cost in the system. */
async function broadcast(session) {
  const estimate = await call(() => api(`/api/clinic/sessions/${session.id}/broadcast-estimate`));
  const text = prompt(
    `Message all ${estimate.recipients} waiting patients.\nEstimated cost: MVR ${(estimate.estimatedCostMinor / 100).toFixed(2)}\n\nMessage:`,
    `${session.doctor_name} is running late this evening. We will message you with your new time.`,
  );
  if (!text) return;
  await sessionAct(session, 'broadcast', `Sent to ${estimate.recipients} patients`, { text });
}

function sessionColumn(session) {
  const p = session.projection;
  const late = p?.runningLateMinutes ?? 0;
  const pause = p?.pause;
  const notStartedLate = session.state === 'scheduled'
    ? Math.round((state.serverNow - session.scheduled_start - (session.delay_minutes || 0) * 60000) / 60000) : 0;
  const worst = Math.max(late, notStartedLate);

  let chipText;
  let chipClass = 'ok';
  if (session.state === 'ended') { chipText = 'Finished'; chipClass = ''; }
  else if (session.state === 'cancelled') { chipText = 'Cancelled'; chipClass = ''; }
  else if (session.state === 'paused' || pause) { chipText = `Paused · ${pause?.kind ?? 'break'}${pause?.expectedResumeAt ? ` until ${hhmm(pause.expectedResumeAt)}` : ''}`; chipClass = 'warn'; }
  else if (session.state === 'running') { chipText = late > 5 ? `Running ${late} min late` : 'On time'; chipClass = late > 15 ? 'danger' : late > 5 ? 'warn' : 'ok'; }
  else if (notStartedLate > 2) { chipText = `Not started · ${notStartedLate} min late`; chipClass = notStartedLate > 15 ? 'danger' : 'warn'; }
  else { chipText = `Starts ${hhmm(session.scheduled_start + (session.delay_minutes || 0) * 60000)}`; chipClass = ''; }

  const inConsult = session.tokens.find((t) => t.state === 'in_consult');
  const waiting = session.tokens.filter((t) => WAITING.has(t.state));
  const done = session.tokens.filter((t) => ['completed', 'no_show', 'cancelled'].includes(t.state));
  const open = ['scheduled', 'running', 'paused'].includes(session.state);

  return h('section.col', { style: { position: 'relative' } },
    h('header', {},
      h('div.who', {},
        h('span.av', {}, initials(session.doctor_name)),
        h('span.grow', {}, h('div.doc', {}, session.doctor_name), h('div.spec', {}, session.specialty.replace('_', ' '))),
        session.simulating ? h('span.pill.brand', { title: 'A simulated doctor is driving this session' }, 'SIM') : null),
      h('div.status', {},
        h('span', { class: `chip ${chipClass}` }, h('span.dot'), chipText),
        h('span.dim.sm', {}, `${waiting.length} waiting`)),
      inConsult
        ? h('div.serving', {}, h('span', {}, 'In the room ', h('strong', {}, inConsult.display)),
          h('span', {}, `${p?.nowServing?.elapsedMinutes ?? 0} min${p?.nowServing?.overrunning ? ' · running over' : ''}`))
        : h('div.serving.none', {}, open ? 'Room is free' : 'No one in the room'),
      open ? h('div.acts', {},
        session.state === 'scheduled' ? h('button.btn.primary', { onClick: () => sessionAct(session, 'start', 'Session started') }, 'Start session') : null,
        session.state === 'running' ? h('button.btn', { onClick: () => sessionAct(session, 'pause', 'Paused — everyone waiting has been told', { kind: 'break', expectedMinutes: 15 }) }, 'Pause') : null,
        session.state === 'paused' ? h('button.btn.primary', { onClick: () => sessionAct(session, 'resume', 'Resumed') }, 'Resume') : null,
        h('button.btn.kebab', { onClick: () => { openMenu = openMenu === session.id ? null : session.id; render(); }, title: 'More' }, '⋯')) : null,
      openMenu === session.id ? h('div.menu', {},
        h('button', { onClick: () => delaySession(session) }, 'Doctor is running late…'),
        h('button', { onClick: () => broadcast(session) }, 'Message everyone waiting…'),
        h('button', {
          onClick: async () => {
            await call(() => api(`/api/clinic/sessions/${session.id}/simulate`, { method: 'POST', body: { enabled: !session.simulating } }));
            openMenu = null; await refreshBoard();
          },
        }, session.simulating ? 'Stop simulating this doctor' : 'Simulate this doctor'),
        h('hr'),
        h('button', { onClick: () => sessionAct(session, 'end', 'Session finished') }, 'Finish session'),
        h('button.danger', { onClick: () => { if (confirm('Cancel this whole session? Everyone waiting will be told and refunded.')) sessionAct(session, 'cancel', 'Session cancelled', { reason: 'clinic' }); } }, 'Cancel session')) : null),

    h('div.list', {
      onClick: () => { if (openMenu) { openMenu = null; render(); } },
      onDragover: (e) => { if (dragging) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); } },
      onDragleave: (e) => e.currentTarget.classList.remove('drag-over'),
      onDrop: async (e) => {
        e.currentTarget.classList.remove('drag-over');
        const moved = e.dataTransfer.getData('text/plain');
        dragging = null;
        if (!moved) return;
        const here = session.tokens.some((t) => t.id === moved);
        await guard(() => call(() => (here
          ? api(`/api/clinic/tokens/${moved}/reorder`, { method: 'POST', body: { afterTokenId: waiting[waiting.length - 1]?.id ?? null } })
          : api(`/api/clinic/tokens/${moved}/reassign`, { method: 'POST', body: { sessionId: session.id } }))),
        here ? 'Moved to the end' : `Moved to ${session.doctor_name}`);
        await refreshBoard();
      },
    },
    inConsult ? tokenCard(session, inConsult, -1, waiting) : null,
    waiting.map((t, i) => tokenCard(session, t, i, waiting)),
    !waiting.length && !inConsult ? h('div.empty', {}, open ? 'Nobody waiting. Drag a card here, or add a walk-in.' : 'Nothing more today.') : null,
    done.length ? h('details', {},
      h('summary.done-sum', {}, `${done.length} seen or gone today`),
      h('div.stack', { style: { marginTop: '8px' } }, done.map((t) => tokenCard(session, t, -1, [])))) : null),
  );
}

export function renderBoard() {
  const sessions = state.board.sessions;
  if (!sessions.length) {
    return h('div.empty', {}, h('div.big', {}, 'No sessions today'), h('div.help', {}, 'Sessions are set up under Settings → Schedule.'));
  }
  return h('div.board', {},
    sessions.map(sessionColumn),
    h('section.col.add', {},
      h('header', {},
        h('div.who', {}, h('span.grow', {}, h('div.doc', {}, 'Add someone'), h('div.spec', {}, 'Walk-ins and phone bookings'))),
        h('div.acts', {},
          h('button.btn.primary', { onClick: () => openWalkIn() }, '+ Walk-in'),
          h('button.btn', { onClick: () => openWalkIn('phone') }, '+ Phone'))),
      h('div.list', {},
        h('div.help', { style: { padding: '4px 6px' } },
          h('p', { style: { margin: '0 0 8px' } }, 'Drag a card to move someone up, down, or to another doctor.'),
          h('p', { style: { margin: '0 0 8px' } }, 'Press ', h('kbd', {}, 'W'), ' to add a walk-in, ', h('kbd', {}, '⌘K'), ' to find anyone.'),
          h('p', { style: { margin: 0 } }, 'Coloured edge: ', h('span', { style: { color: 'var(--here)', fontWeight: 700 } }, 'green'), ' here · ',
            h('span', { style: { color: 'var(--called)', fontWeight: 700 } }, 'amber'), ' called · ',
            h('span', { style: { color: 'var(--brand-deep)', fontWeight: 700 } }, 'teal'), ' in the room · ',
            h('span', { style: { color: 'var(--back)', fontWeight: 700 } }, 'red'), ' moved back.')))));
}

// -------------------------------------------------------------- walk-in modal
export function openWalkIn(source = 'walk_in') {
  const sessions = state.board.sessions.filter((s) => ['scheduled', 'running', 'paused'].includes(s.state));
  if (!sessions.length) return toast('No open sessions to add to', 'err');

  const phone = h('input.input', { placeholder: '+960 777 1234', autofocus: true, inputmode: 'tel' });
  const name = h('input.input', { placeholder: 'Patient name' });
  const nationalId = h('input.input', { placeholder: 'A123456' });
  const doctor = h('select.input', {}, sessions.map((s) => h('option', { value: s.id }, `${s.doctor_name} — ${hhmm(s.scheduled_start)}`)));
  const visit = h('select.input', {}, [['new', 'New patient'], ['follow_up', 'Follow-up'], ['review', 'Review']].map(([v, l]) => h('option', { value: v }, l)));
  const priority = h('select.input', {}, [['', 'Normal place in the queue'], ['clinical_urgency', 'Clinical urgency'], ['elderly', 'Elderly'],
    ['pregnant', 'Pregnant'], ['disability', 'Disability'], ['travel_constraint', 'Travel constraint'], ['staff_referral', 'Staff referral']]
    .map(([v, l]) => h('option', { value: v }, l)));
  const found = h('div.help');
  let matchedId = null;

  phone.addEventListener('input', async () => {
    const q = phone.value.trim();
    matchedId = null;
    if (q.length < 6) { found.textContent = ''; return; }
    const { patients } = await call(() => api(`/api/clinic/patients?q=${encodeURIComponent(q)}`));
    if (patients.length) {
      matchedId = patients[0].id;
      name.value = patients[0].name;
      nationalId.value = patients[0].national_id || '';
      found.textContent = `Known here: ${patients[0].name}${patients[0].travel_island ? ` · from ${patients[0].travel_island}` : ''}`;
    } else {
      found.textContent = 'Not seen at this clinic before — a record will be created.';
    }
  });

  const dialog = h('dialog.modal', {},
    h('header', {}, source === 'phone' ? 'Phone booking' : 'Add a walk-in'),
    h('div.body', {},
      h('label.field', {}, h('span', {}, 'Phone'), phone, found),
      h('label.field', {}, h('span', {}, 'Name'), name),
      h('label.field', {}, h('span', {}, 'National ID or passport'), nationalId),
      h('label.field', {}, h('span', {}, 'Doctor'), doctor),
      h('label.field', {}, h('span', {}, 'Visit'), visit),
      h('label.field', {}, h('span', {}, 'Priority'), priority),
      h('div.help', {}, 'Priority insertions are logged and reported. A clinic where a third of tokens are priority has a scheduling problem, not a compassion problem.')),
    h('footer', {},
      h('button.btn', { onClick: () => dialog.close() }, 'Cancel'),
      h('button.btn.primary', {
        onClick: async () => {
          if (!name.value.trim() || !phone.value.trim()) return toast('Name and phone are required', 'err');
          await guard(() => call(() => api('/api/clinic/tokens', {
            method: 'POST',
            body: {
              sessionId: doctor.value, patientId: matchedId, source,
              name: name.value.trim(), phone: phone.value.trim(), nationalId: nationalId.value.trim(),
              visitType: visit.value, priorityReason: priority.value || null,
            },
          })), 'Token issued');
          dialog.close();
          await refreshBoard();
        },
      }, 'Issue token')));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  phone.focus();
}

// ------------------------------------------------------------ command palette
export function openPalette() {
  let results = [];
  let cursor = 0;
  const input = h('input', { placeholder: 'Find a patient, or jump somewhere…', autofocus: true });
  const list = h('div.results');
  const commands = [
    { label: 'Add a walk-in', hint: 'W', run: () => openWalkIn() },
    { label: 'Add a phone booking', run: () => openWalkIn('phone') },
    ...[['board', 'Queue board'], ['doctor', 'Doctor'], ['patients', 'Patients'], ['billing', 'Billing'],
      ['analytics', 'Insights'], ['messages', 'Messages'], ['settings', 'Settings']]
      .map(([tab, label], i) => ({ label: `Go to ${label}`, hint: String(i + 1), run: () => { state.tab = tab; render(); } })),
  ];
  const draw = () => list.replaceChildren(...results.map((r, i) =>
    h('div.res', { 'aria-selected': i === cursor, onClick: () => choose(i) },
      h('span.grow', {}, r.label), r.hint ? h('kbd', {}, r.hint) : null, r.sub ? h('span.dim.sm', {}, r.sub) : null)));
  const search = async () => {
    const q = input.value.trim().toLowerCase();
    const cmd = commands.filter((c) => c.label.toLowerCase().includes(q));
    let patients = [];
    if (q.length >= 2) {
      const data = await call(() => api(`/api/clinic/patients?q=${encodeURIComponent(q)}`));
      patients = data.patients.map((p) => ({
        label: p.name, sub: `${p.phone || ''}${p.travel_island ? ` · ${p.travel_island}` : ''}`,
        run: () => { state.tab = 'patients'; state.selectedPatient = p.id; render(); },
      }));
    }
    results = [...patients, ...cmd].slice(0, 12);
    cursor = 0;
    draw();
  };
  const choose = (i) => { wrap.remove(); results[i]?.run(); };
  input.addEventListener('input', search);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { cursor = Math.min(cursor + 1, results.length - 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { cursor = Math.max(cursor - 1, 0); draw(); e.preventDefault(); }
    if (e.key === 'Enter') choose(cursor);
    if (e.key === 'Escape') wrap.remove();
  });
  const wrap = h('div.palette-wrap', { onClick: (e) => { if (e.target === wrap) wrap.remove(); } },
    h('div.palette', {}, input, list,
      h('footer', {}, h('span', {}, h('kbd', {}, '↑↓'), ' move'), h('span', {}, h('kbd', {}, '↵'), ' open'), h('span', {}, h('kbd', {}, 'esc'), ' close'))));
  document.body.append(wrap);
  input.focus();
  search();
}
