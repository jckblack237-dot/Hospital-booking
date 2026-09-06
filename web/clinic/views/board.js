import { h, api, hhmm, toast, guard, SOURCE_LABELS, age } from '/shared/core.js';
import { state, render, refreshBoard } from '/clinic/app.js';

let dragging = null; // token id being dragged — suppresses re-render mid-drag
let openMenu = null;

export function boardOnMessage(msg) {
  if (dragging) return;
  if (msg.type === 'projection') {
    const session = state.board.sessions.find((s) => s.id === msg.sessionId);
    if (session) {
      session.projection = msg;
      session.state = msg.state;
      // Merge live projection onto the cards we already hold, so the board
      // updates in well under a second without a round trip.
      for (const token of session.tokens) {
        token.projection = msg.entries.find((e) => e.tokenId === token.id) ?? null;
      }
      state.serverNow = msg.computedAt;
      render();
    } else {
      refreshBoard();
    }
  } else if (msg.type === 'message_sent') {
    toast(`${msg.message.channel.toUpperCase()} → ${msg.message.patient_name}`);
  }
}

const CONFIDENCE_BARS = { high: 3, medium: 2, low: 1 };

function confidence(level) {
  const on = CONFIDENCE_BARS[level] ?? 0;
  return h('span.conf', { title: `Confidence: ${level}` },
    [0, 1, 2].map((i) => h('i', { class: i < on ? 'on' : '' })));
}

function payerPill(token) {
  const eligibility = token.eligibility?.result;
  const label = token.payer_type === 'aasandha' ? 'Aasandha'
    : token.payer_type === 'private' ? (token.insurer || 'Private')
      : token.payer_type === 'corporate' ? 'Corporate' : 'Self-pay';
  if (token.payer_type === 'self_pay') return h('span.pill', {}, label);
  if (eligibility === 'covered') return h('span.pill.ok', {}, `${label} ✓`);
  if (eligibility === 'not_covered') return h('span.pill.danger', {}, `${label} ✗`);
  // A technical failure must never be reported to the patient as "not covered".
  return h('span.pill.warn', { title: token.eligibility?.detail || 'Not verified yet' }, `${label} ?`);
}

function tokenCard(session, token, index, list) {
  const p = token.projection;
  const flags = token.flags || [];
  const isActive = ['booked', 'arrived', 'called', 'penalised', 'in_consult'].includes(token.state);

  const card = h('div', {
    class: `tok state-${token.state}${openMenu === token.id ? ' open' : ''}`,
    draggable: isActive && token.state !== 'in_consult',
    dataset: { tokenId: token.id },
    onDragstart: (e) => {
      dragging = token.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', token.id);
    },
    onDragend: () => { dragging = null; card.classList.remove('dragging'); refreshBoard(); },
    onDragover: (e) => { if (dragging && dragging !== token.id) { e.preventDefault(); card.classList.add('drop-before'); } },
    onDragleave: () => card.classList.remove('drop-before'),
    onDrop: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove('drop-before');
      const moved = e.dataTransfer.getData('text/plain');
      dragging = null;
      if (!moved || moved === token.id) return;
      const before = list[index - 1];
      // Fractional ranks: a single-row update whatever the queue length.
      await guard(() => api(`/api/clinic/tokens/${moved}/reorder`, {
        method: 'POST', body: { afterTokenId: before?.id ?? null, beforeTokenId: token.id, actor: 'receptionist' },
      }), 'Queue reordered');
      await refreshBoard();
    },
  },
  h('div.head', {},
    h('span.num', {}, token.display),
    h('span.name', { title: token.patient_name }, token.patient_name),
    p ? h('span.win.mono', {}, hhmm(p.predictedStart.window.from)) : null,
  ),
  h('div.meta', {},
    h('span.pill', {}, SOURCE_LABELS[token.source] || token.source),
    payerPill(token),
    token.state === 'arrived' ? h('span.pill.ok', {}, '✓ Here') : null,
    token.state === 'called' ? h('span.pill.warn', {}, '📢 Called') : null,
    token.state === 'in_consult' ? h('span.pill.brand', {}, '● In room') : null,
    token.state === 'penalised' ? h('span.pill.danger', {}, `↓ Moved back ×${token.penalty_count}`) : null,
    token.state === 'no_show' ? h('span.pill.danger', {}, 'No-show') : null,
    flags.includes('travel') ? h('span.pill.violet', { title: `Travelling from ${token.travel_island}` }, `✈ ${token.travel_island}`) : null,
    flags.includes('needs_decision') ? h('span.pill.warn', { title: 'Travel-flagged: penalty deferred for a human decision' }, '⚑ Your call') : null,
    flags.includes('priority') ? h('span.pill.violet', { title: token.priority_reason }, '★ Priority') : null,
    token.on_my_way ? h('span.pill.info', {}, '🚶 On the way') : null,
    token.invoice && token.invoice.state === 'open' ? h('span.pill.warn', {}, 'Payment due') : null,
    p ? confidence(p.predictedStart.confidence) : null,
  ),
  p && isActive ? h('div.why', {},
    `${hhmm(p.predictedStart.window.from)}–${hhmm(p.predictedStart.window.to)}`,
    p.tokensAhead > 0 ? ` · ${p.tokensAhead} ahead` : ' · next',
    p.atRisk ? ' · ⚠ may not be reached today' : '',
    // Only useful to reception when the person is NOT yet in the building.
    p.leaveNow && !token.arrived_at ? ' · should be on their way' : '',
  ) : null,

  isActive ? h('div.btns', {},
    token.state === 'booked' ? h('button.btn.sm', { onClick: () => act(token, 'checkin', 'Checked in') }, 'Check in') : null,
    ['arrived', 'penalised', 'booked'].includes(token.state)
      ? h('button.btn.sm', { onClick: () => act(token, 'call', `${token.display} called`) }, 'Call') : null,
    ['arrived', 'called', 'penalised'].includes(token.state)
      ? h('button.btn.sm.primary', { onClick: () => act(token, 'start', 'Consultation started') }, 'Start') : null,
    token.state === 'in_consult'
      ? h('button.btn.sm.primary', { onClick: () => endConsult(token) }, 'End & call next') : null,
    h('button.btn.sm.ghost', {
      onClick: () => { openMenu = openMenu === token.id ? null : token.id; render(); },
    }, '⋮'),
  ) : null,

  openMenu === token.id ? h('div.stack', { style: { marginTop: '6px' } },
    h('div.row.wrap', {},
      h('button.btn.sm', { onClick: () => act(token, 'penalty', 'Delay penalty applied') }, 'Apply penalty'),
      token.penalty_count > 0 || flags.includes('needs_decision')
        ? h('button.btn.sm', { onClick: () => act(token, 'revoke-penalty', 'Penalty reversed') }, 'Undo penalty') : null,
      h('button.btn.sm', { onClick: () => act(token, 'no-show', 'Marked no-show') }, 'No-show'),
      h('button.btn.sm.danger', { onClick: () => act(token, 'cancel', 'Cancelled') }, 'Cancel'),
    ),
    h('div.row.wrap', {},
      h('span.tiny.dim', {}, 'Move to'),
      state.board.sessions.filter((s) => s.id !== session.id).map((s) =>
        h('button.btn.sm.ghost', {
          onClick: async () => {
            await guard(() => api(`/api/clinic/tokens/${token.id}/reassign`, { method: 'POST', body: { sessionId: s.id } }), 'Reassigned');
            openMenu = null; await refreshBoard();
          },
        }, s.doctor_name.replace('Dr. ', ''))),
    ),
  ) : null,
  );
  return card;
}

async function act(token, action, okMessage) {
  openMenu = null;
  await guard(() => api(`/api/clinic/tokens/${token.id}/${action}`, { method: 'POST', body: { actor: 'receptionist' } }), okMessage);
  await refreshBoard();
}

async function endConsult(token) {
  await guard(() => api(`/api/clinic/tokens/${token.id}/end`, { method: 'POST', body: { callNext: true } }), 'Ended — next patient called');
  await refreshBoard();
}

function sessionColumn(session) {
  const p = session.projection;
  const late = p?.runningLateMinutes ?? 0;
  const pause = p?.pause;
  const stateLabel = session.state === 'running' && pause ? `Paused — ${pause.kind}`
    : session.state === 'running' ? (late > 5 ? `Running ${late} min late` : 'On time')
      : session.state === 'paused' ? `Paused — ${pause?.kind ?? 'break'}`
        : session.state === 'ended' ? 'Session ended'
          : session.state === 'cancelled' ? 'Cancelled'
            : `Starts ${hhmm(session.scheduled_start + (session.delay_minutes || 0) * 60000)}`;
  const stateClass = session.state === 'ended' || session.state === 'cancelled' ? 'dim'
    : pause || session.state === 'paused' ? 'warn' : late > 15 ? 'danger' : late > 5 ? 'warn' : 'ok';

  const active = session.tokens.filter((t) => ['booked', 'arrived', 'called', 'penalised'].includes(t.state));
  const inConsult = session.tokens.find((t) => t.state === 'in_consult');
  const done = session.tokens.filter((t) => ['completed', 'no_show', 'cancelled'].includes(t.state));

  return h('section.col', {},
    h('header', {},
      h('div.spread', {},
        h('div.doc', {}, session.doctor_name),
        session.simulating ? h('span.pill.brand', { title: 'Simulated doctor driving this session' }, 'SIM') : null),
      h('div.state', {},
        h('span', { class: `pill ${stateClass}` }, stateLabel),
        h('span.dim.tiny', {}, `${active.length} waiting`),
        pause?.expectedResumeAt ? h('span.dim.tiny', {}, `resumes ${hhmm(pause.expectedResumeAt)}`) : null,
      ),
      inConsult
        ? h('div.serving', {},
          h('span', {}, 'Now serving ', h('strong.mono', {}, inConsult.display)),
          h('span.mono', {}, `${p?.nowServing?.elapsedMinutes ?? 0} min`),
          p?.nowServing?.overrunning ? h('span.pill.warn', {}, 'over') : null)
        : h('div.serving.none', {}, 'Nobody in the room'),
      h('div.acts', {},
        session.state === 'scheduled'
          ? h('button.btn.sm.primary', { onClick: () => sessionAct(session, 'start', 'Session started') }, 'Start session') : null,
        session.state === 'running'
          ? h('button.btn.sm', { onClick: () => sessionAct(session, 'pause', 'Paused', { kind: 'break', expectedMinutes: 15 }) }, 'Pause') : null,
        session.state === 'paused'
          ? h('button.btn.sm.primary', { onClick: () => sessionAct(session, 'resume', 'Resumed') }, 'Resume') : null,
        ['scheduled', 'running'].includes(session.state)
          ? h('button.btn.sm', { onClick: () => delaySession(session) }, 'Delay') : null,
        ['scheduled', 'running', 'paused'].includes(session.state)
          ? h('button.btn.sm', { onClick: () => broadcast(session) }, '⚡ Broadcast') : null,
        h('button.btn.sm.ghost', {
          onClick: async () => {
            await api(`/api/clinic/sessions/${session.id}/simulate`, { method: 'POST', body: { enabled: !session.simulating } });
            await refreshBoard();
          },
        }, session.simulating ? 'Stop sim' : 'Simulate'),
      ),
    ),
    h('div.list', {
      onDragover: (e) => { if (dragging) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); } },
      onDragleave: (e) => e.currentTarget.classList.remove('drag-over'),
      onDrop: async (e) => {
        e.currentTarget.classList.remove('drag-over');
        const moved = e.dataTransfer.getData('text/plain');
        dragging = null;
        if (!moved) return;
        const inColumn = session.tokens.some((t) => t.id === moved);
        if (inColumn) {
          await guard(() => api(`/api/clinic/tokens/${moved}/reorder`, {
            method: 'POST', body: { afterTokenId: active[active.length - 1]?.id ?? null },
          }), 'Moved to the end');
        } else {
          await guard(() => api(`/api/clinic/tokens/${moved}/reassign`, {
            method: 'POST', body: { sessionId: session.id },
          }), `Moved to ${session.doctor_name}`);
        }
        await refreshBoard();
      },
    },
    inConsult ? tokenCard(session, inConsult, -1, active) : null,
    active.map((t, i) => tokenCard(session, t, i, active)),
    !active.length && !inConsult ? h('div.empty.tiny', {}, 'Queue empty') : null,
    done.length ? h('details', { style: { marginTop: '4px' } },
      h('summary', { class: 'tiny dim', style: { cursor: 'pointer', padding: '4px' } }, `${done.length} done`),
      h('div.stack', { style: { marginTop: '6px' } }, done.map((t) => tokenCard(session, t, -1, [])))) : null,
    ),
  );
}

async function sessionAct(session, action, okMessage, body = {}) {
  await guard(() => api(`/api/clinic/sessions/${session.id}/${action}`, { method: 'POST', body: { actor: 'receptionist', ...body } }), okMessage);
  await refreshBoard();
}

function delaySession(session) {
  const minutes = Number(prompt(`How many minutes late will ${session.doctor_name} be?`, '25'));
  if (!minutes) return;
  sessionAct(session, 'delay', `Delay set — everyone waiting has been told`, { minutes });
}

/** Cost preview before sending. Messaging is the biggest variable cost in the system. */
async function broadcast(session) {
  const estimate = await api(`/api/clinic/sessions/${session.id}/broadcast-estimate`);
  const text = prompt(
    `Message all ${estimate.recipients} waiting patients.\nEstimated cost: MVR ${(estimate.estimatedCostMinor / 100).toFixed(2)}\n\nMessage:`,
    `${session.doctor_name} is running late this evening. We will message you with your new time.`,
  );
  if (!text) return;
  await guard(() => api(`/api/clinic/sessions/${session.id}/broadcast`, { method: 'POST', body: { text } }),
    `Sent to ${estimate.recipients} patients`);
  await refreshBoard();
}

export function renderBoard() {
  const sessions = state.board.sessions;
  if (!sessions.length) return h('div.empty', {}, 'No sessions scheduled today.');
  return h('div.board', {},
    sessions.map(sessionColumn),
    h('section.col.holding', {},
      h('header', {},
        h('div.doc', {}, 'Add to the queue'),
        h('div.state', {}, h('span.dim.tiny', {}, 'Walk-ins and phone bookings')),
        h('div.acts', {},
          h('button.btn.sm.primary', { onClick: () => openWalkIn() }, '+ Walk-in'),
          h('button.btn.sm', { onClick: () => openWalkIn('phone') }, '+ Phone'),
        )),
      h('div.list', {},
        h('div.tiny.dim', { style: { padding: '6px' } },
          h('div', {}, h('kbd', {}, 'W'), ' walk-in'),
          h('div', { style: { marginTop: '4px' } }, h('kbd', {}, '⌘K'), ' search or command'),
          h('div', { style: { marginTop: '4px' } }, h('kbd', {}, '1'), '–', h('kbd', {}, '7'), ' switch views'),
        )),
    ),
  );
}

// -------------------------------------------------------------- walk-in modal
export function openWalkIn(source = 'walk_in') {
  const sessions = state.board.sessions.filter((s) => ['scheduled', 'running', 'paused'].includes(s.state));
  if (!sessions.length) return toast('No open sessions to add to', 'err');

  const phone = h('input.input', { placeholder: '+960 777 1234', autofocus: true });
  const name = h('input.input', { placeholder: 'Patient name' });
  const nationalId = h('input.input', { placeholder: 'A123456' });
  const doctor = h('select.input', {}, sessions.map((s) => h('option', { value: s.id }, `${s.doctor_name} — ${hhmm(s.scheduled_start)}`)));
  const visit = h('select.input', {}, [['new', 'New patient'], ['follow_up', 'Follow-up'], ['review', 'Review']]
    .map(([v, l]) => h('option', { value: v }, l)));
  const priority = h('select.input', {}, [['', 'Normal queue position'], ['clinical_urgency', 'Clinical urgency'],
    ['elderly', 'Elderly'], ['pregnant', 'Pregnant'], ['disability', 'Disability'],
    ['travel_constraint', 'Travel constraint'], ['staff_referral', 'Staff referral']]
    .map(([v, l]) => h('option', { value: v }, l)));
  const found = h('div.tiny.dim');
  let matchedId = null;

  // Duplicate detection on create. Phone is the practical key in this market.
  phone.addEventListener('input', async () => {
    const q = phone.value.trim();
    matchedId = null;
    if (q.length < 6) { found.textContent = ''; return; }
    const { patients } = await api(`/api/clinic/patients?q=${encodeURIComponent(q)}`);
    if (patients.length) {
      matchedId = patients[0].id;
      name.value = patients[0].name;
      nationalId.value = patients[0].national_id || '';
      found.textContent = `Existing patient: ${patients[0].name}${patients[0].travel_island ? ` · from ${patients[0].travel_island}` : ''}`;
    } else {
      found.textContent = 'New patient — will be created';
    }
  });

  const dialog = h('dialog.modal', {},
    h('header', {}, source === 'phone' ? 'Phone booking' : 'Add walk-in'),
    h('div.body', {},
      h('label.field', {}, h('span', {}, 'Phone'), phone, found),
      h('label.field', {}, h('span', {}, 'Name'), name),
      h('label.field', {}, h('span', {}, 'National ID / passport'), nationalId),
      h('label.field', {}, h('span', {}, 'Doctor'), doctor),
      h('label.field', {}, h('span', {}, 'Visit type'), visit),
      h('label.field', {}, h('span', {}, 'Priority'), priority),
      h('div.tiny.dim', {}, 'Priority insertions are logged and reported — a clinic where a third of tokens are priority has a scheduling problem, not a compassion problem.'),
    ),
    h('footer', {},
      h('button.btn', { onClick: () => dialog.close() }, 'Cancel'),
      h('button.btn.primary', {
        onClick: async () => {
          if (!name.value.trim() || !phone.value.trim()) return toast('Name and phone are required', 'err');
          await guard(() => api('/api/clinic/tokens', {
            method: 'POST',
            body: {
              sessionId: doctor.value, patientId: matchedId, source,
              name: name.value.trim(), phone: phone.value.trim(), nationalId: nationalId.value.trim(),
              visitType: visit.value, priorityReason: priority.value || null, actor: 'receptionist',
            },
          }), 'Token issued');
          dialog.close();
          await refreshBoard();
        },
      }, 'Issue token'),
    ),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  phone.focus();
}

// ------------------------------------------------------------ command palette
export function openPalette() {
  let results = [];
  let cursor = 0;
  const input = h('input', { placeholder: 'Search patients, or type a command…', autofocus: true });
  const list = h('div.results');

  const commands = [
    { label: 'Add walk-in', hint: 'W', run: () => openWalkIn() },
    { label: 'Add phone booking', run: () => openWalkIn('phone') },
    { label: 'Go to queue board', run: () => { state.tab = 'board'; render(); } },
    { label: 'Go to doctor module', run: () => { state.tab = 'doctor'; render(); } },
    { label: 'Go to billing', run: () => { state.tab = 'billing'; render(); } },
    { label: 'Go to analytics', run: () => { state.tab = 'analytics'; render(); } },
    { label: 'Go to messages', run: () => { state.tab = 'messages'; render(); } },
    { label: 'Go to settings', run: () => { state.tab = 'settings'; render(); } },
  ];

  const draw = () => {
    list.replaceChildren(...results.map((r, i) =>
      h('div.res', { 'aria-selected': i === cursor, onClick: () => choose(i) },
        h('span.grow', {}, r.label),
        r.hint ? h('kbd', {}, r.hint) : null,
        r.sub ? h('span.dim.tiny', {}, r.sub) : null)));
  };

  const search = async () => {
    const q = input.value.trim().toLowerCase();
    const cmd = commands.filter((c) => c.label.toLowerCase().includes(q));
    let patients = [];
    if (q.length >= 2) {
      const data = await api(`/api/clinic/patients?q=${encodeURIComponent(q)}`);
      patients = data.patients.map((p) => ({
        label: p.name,
        sub: `${p.phone || ''} ${p.travel_island ? `· ${p.travel_island}` : ''}`,
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
      h('footer', {}, h('span', {}, h('kbd', {}, '↑↓'), ' navigate'), h('span', {}, h('kbd', {}, '↵'), ' select'), h('span', {}, h('kbd', {}, 'esc'), ' close'))));
  document.body.append(wrap);
  input.focus();
  search();
}
