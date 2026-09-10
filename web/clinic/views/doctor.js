import { h, api, hhmm, guard, age } from '/shared/core.js';
import { state, render, refreshBoard } from '/clinic/app.js';

/**
 * Doctor Module.
 *
 * Dr. Hassan will look at this for perhaps 90 seconds across a three-hour
 * session. Every second of attention we take is a second not spent on a
 * patient, and he will punish us for it by not pressing the buttons — at which
 * point the engine goes blind. One patient, two buttons.
 */
let data = null;
let loadingFor = null;

/** Sign-out: nothing of the last clinic survives on a shared tablet. */
export function reset() { data = null; loadingFor = null; }

async function load(sessionId) {
  if (loadingFor === sessionId && data) return;
  loadingFor = sessionId;
  data = await api(`/api/clinic/doctor/${sessionId}`);
  render();
}

async function act(path, body, ok) {
  await guard(() => api(path, { method: 'POST', body }), ok);
  data = null;
  await load(state.doctorSessionId);
  await refreshBoard();
}

export function renderDoctor() {
  const sessions = state.board.sessions;
  if (!sessions.length) return h('div.empty', {}, 'No sessions today.');
  const sessionId = state.doctorSessionId ?? sessions[0].id;
  if (!data || data.session?.id !== sessionId) { load(sessionId); }

  const picker = h('select.input', {
    style: { maxWidth: '320px' },
    onChange: (e) => { state.doctorSessionId = e.target.value; data = null; load(e.target.value); },
  }, sessions.map((s) => h('option', { value: s.id, selected: s.id === sessionId }, `${s.doctor_name} — ${hhmm(s.scheduled_start)}`)));

  if (!data) return h('div.doctor-shell', {}, picker, h('div.empty', {}, 'Loading…'));

  const { session, doctor, current, upcoming, stats, runningLateMinutes, lastNote } = data;
  const elapsedSec = current?.started_at ? Math.max(0, Math.round((state.serverNow - current.started_at) / 1000)) : 0;
  const next = upcoming[0];

  return h('div.doctor-shell.stack', {},
    h('div.row', {}, picker,
      h('span.grow'),
      // The doctor sees their own punctuality FIRST, always. It is framed as a
      // scheduling input, never a score — that framing is what keeps the
      // Start/End events flowing.
      h('span', { class: `pill ${runningLateMinutes > 20 ? 'danger' : runningLateMinutes > 5 ? 'warn' : 'ok'}` },
        runningLateMinutes > 2 ? `You are ${runningLateMinutes} min behind` : 'On time')),

    h('div.card.pad.row', {},
      h('span.muted', {}, `${upcoming.length} waiting`),
      h('span.dim', {}, '·'),
      h('span.muted', {}, `${stats.seen} seen`),
      stats.medianMinutes ? [h('span.dim', {}, '·'), h('span.muted', {}, `median ${stats.medianMinutes} min`)] : null,
      h('span.grow'),
      h('span.dim.tiny', {}, `scheduled ${hhmm(session.scheduled_start)}–${hhmm(session.scheduled_end)}`)),

    session.state === 'scheduled'
      ? h('div.card.doctor-card', {},
        h('div.muted', {}, 'Session has not started'),
        h('button.btn.primary.lg', {
          style: { marginTop: '16px' },
          onClick: () => act(`/api/clinic/sessions/${session.id}/start`, { actor: 'doctor' }, 'Session started'),
        }, 'Start session'))
      : session.state === 'paused'
        ? h('div.card.doctor-card', {},
          h('div.big', {}, 'Session paused'),
          h('button.btn.primary.lg', {
            style: { marginTop: '16px' },
            onClick: () => act(`/api/clinic/sessions/${session.id}/resume`, {}, 'Resumed'),
          }, 'Resume'))
        : current
          ? h('div.card.doctor-card', {},
            h('div.token-big', {}, current.display),
            h('div.big', {}, current.patient_name),
            h('div.muted', {},
              [age(current.dob) ? `${age(current.dob)}` : null, current.gender,
                current.visit_type === 'new' ? 'New patient' : 'Follow-up',
                current.payer_type === 'aasandha' ? 'Aasandha' : current.payer_type].filter(Boolean).join(' · ')),
            lastNote?.note ? h('div.muted.sm', { style: { marginTop: '8px' } }, `Last note: ${lastNote.note}`) : null,
            h('div.timer', {}, `In consultation — ${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, '0')}`),
            h('div.doctor-actions', {},
              h('button.btn.primary', {
                onClick: () => act(`/api/clinic/tokens/${current.id}/end`, { callNext: true }, 'Next patient called'),
              }, 'End & call next'),
              h('button.btn', {
                onClick: () => act(`/api/clinic/tokens/${current.id}/end`, { callNext: false }, 'Ended'),
              }, 'End (stay free)')),
            h('div.doctor-secondary', {},
              // Extending BEFORE the overrun happens is what lets downstream
              // patients be told early rather than discovering it late.
              h('button.btn.sm', { onClick: () => act(`/api/clinic/tokens/${current.id}/extend`, { minutes: 10 }, 'Downstream times updated') }, 'Need more time +10'),
              h('button.btn.sm', { onClick: () => act(`/api/clinic/sessions/${session.id}/pause`, { kind: 'prayer', expectedMinutes: 20 }, 'Paused') }, 'Pause session'),
              h('button.btn.sm', {
                onClick: () => {
                  const note = prompt('Operational note (not a clinical record)', current.note || '');
                  if (note !== null) act(`/api/clinic/tokens/${current.id}/note`, { note }, 'Note saved');
                },
              }, 'Add note')))
          : h('div.card.doctor-card', {},
            h('div.muted', {}, 'Nobody in the room'),
            next
              ? [h('div.token-big', {}, next.display), h('div.big', {}, next.patient_name),
                h('div.doctor-actions', { style: { gridTemplateColumns: '1fr' } },
                  h('button.btn.primary', { onClick: () => act(`/api/clinic/tokens/${next.id}/start`, {}, 'Started') }, 'Start patient'))]
              : h('div.stack', { style: { marginTop: '14px' } },
                h('div.dim', {}, 'Queue is empty'),
                h('button.btn', { onClick: () => act(`/api/clinic/sessions/${session.id}/end`, {}, 'Session ended') }, 'End session')),
            h('div.doctor-secondary', {},
              next ? h('button.btn.sm', { onClick: () => act(`/api/clinic/tokens/${next.id}/no-show`, {}, 'Marked no-show') }, 'No-show') : null,
              h('button.btn.sm', { onClick: () => act(`/api/clinic/sessions/${session.id}/pause`, { kind: 'prayer', expectedMinutes: 20 }, 'Paused') }, 'Pause session'))),

    h('div.card.pad', {},
      h('div.section-title', { style: { marginTop: 0 } }, 'Next up'),
      upcoming.length ? upcoming.map((t) => h('div.spread', { style: { padding: '6px 0', borderBottom: '1px solid var(--border)' } },
        h('span.row', {},
          h('span.mono', { style: { fontWeight: 700 } }, t.display),
          h('span', {}, t.patient_name),
          t.visit_type === 'new' ? h('span.pill', {}, 'New') : null,
          t.travel_island ? h('span.pill.violet', {}, `✈ ${t.travel_island}`) : null,
          t.state === 'arrived' ? h('span.pill.ok', {}, 'Here') : null),
        h('span.row', {},
          // The doctor can ask; reception decides. One queue authority.
          h('button.btn.sm.ghost', {
            onClick: () => guard(() => api('/api/clinic/doctor/request-next', { method: 'POST', body: { tokenId: t.id } }),
              `Asked reception to see ${t.display} next`),
          }, 'See next')))) : h('div.dim', {}, 'Nobody waiting')),

    session.state === 'ended' ? h('div.card.pad.finding', {},
      `Session summary: ${stats.seen} patients, median ${stats.medianMinutes} min, started ${runningLateMinutes} min late.`
      + (stats.medianMinutes && Math.abs(stats.medianMinutes - doctor.slot_minutes) >= 2
        ? ` Your median is ${stats.medianMinutes} min but you are scheduled at ${doctor.slot_minutes}. Consider ${stats.medianMinutes}-minute slots.` : '')) : null,
  );
}
