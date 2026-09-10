import { h, api, hhmm, dayLabel, mvr, guard, SOURCE_LABELS } from '/shared/core.js';
import { state, render } from '/clinic/app.js';

let results = [];
let detail = null;
let query = '';

/** Sign-out: nothing of the last clinic survives on a shared tablet. */
export function reset() { results = []; detail = null; query = ''; }

async function search(q) {
  query = q;
  const data = await api(`/api/clinic/patients?q=${encodeURIComponent(q)}`);
  results = data.patients;
  render();
}

async function open(id) {
  detail = await api(`/api/clinic/patients/${id}`);
  state.selectedPatient = id;
  render();
}

export function renderPatients() {
  if (state.selectedPatient && detail?.patient?.id !== state.selectedPatient) open(state.selectedPatient);
  if (!results.length && !query) search('');

  return h('div.grid.k2', {},
    h('div.card.pad', {},
      h('input.input', {
        placeholder: 'Search by name, phone or national ID…',
        value: query, onInput: (e) => search(e.target.value),
      }),
      h('div.stack', { style: { marginTop: '12px' } },
        results.map((p) => h('button.btn.ghost', {
          style: { justifyContent: 'flex-start', textAlign: 'left', width: '100%' },
          onClick: () => open(p.id),
        }, h('div', {},
          h('div', { style: { fontWeight: 650 } }, p.name),
          h('div.tiny.dim', {}, [p.phone, p.national_id, p.travel_island].filter(Boolean).join(' · ')))))),
      !results.length ? h('div.empty', {}, 'No patients found') : null),

    detail ? h('div.stack', {},
      h('div.card.pad', {},
        h('div.spread', {},
          h('div', {}, h('div.big', {}, detail.patient.name),
            h('div.dim.sm', {}, [detail.patient.phone, detail.patient.national_id, detail.patient.dob].filter(Boolean).join(' · '))),
          detail.eligibility
            ? h('span', { class: `pill ${detail.eligibility.result === 'covered' ? 'ok' : detail.eligibility.result === 'not_covered' ? 'danger' : 'warn'}` },
              `${detail.patient.payer_type} · ${detail.eligibility.result}`)
            : h('span.pill.warn', {}, 'Not checked')),
        h('div.row.wrap', { style: { marginTop: '10px' } },
          detail.patient.travel_island ? h('span.pill.violet', {}, `✈ ${detail.patient.travel_island}, ${detail.patient.travel_atoll}`) : null,
          h('span.pill', {}, detail.patient.language === 'dv' ? 'Dhivehi' : 'English'),
          detail.patient.efaas_verified ? h('span.pill.ok', {}, 'eFaas verified') : h('span.pill', {}, 'Not eFaas-verified'),
          h('button.btn.sm', {
            onClick: () => guard(async () => {
              const r = await api(`/api/clinic/patients/${detail.patient.id}/eligibility`, { method: 'POST' });
              await open(detail.patient.id);
              return r;
            }, 'Eligibility re-checked'),
          }, 'Re-check eligibility'))),

      detail.household.length ? h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Household'),
        detail.household.map((m) => h('div.spread', { style: { padding: '4px 0' } },
          h('span', {}, m.name, h('span.dim.sm', {}, ` · ${m.relation || 'dependant'}`)),
          h('button.btn.sm.ghost', { onClick: () => open(m.id) }, 'Open')))) : null,

      detail.referrals.length ? h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Referrals'),
        detail.referrals.map((r) => h('div', { style: { padding: '4px 0' } },
          h('div', {}, `→ ${r.to_specialty}`, r.used_token_id ? h('span.pill.ok', { style: { marginLeft: '6px' } }, 'used') : null),
          h('div.tiny.dim', {}, `${r.from_doctor} · ${dayLabel(r.issued_at)}`),
          h('div.sm.muted', {}, r.note)))) : null,

      h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Visit history'),
        h('div.scroll-x', {}, h('table.data', {},
          h('thead', {}, h('tr', {}, ['Date', 'Doctor', 'Token', 'Source', 'Wait', 'Outcome'].map((c) => h('th', {}, c)))),
          h('tbody', {}, detail.visits.map((v) => h('tr', {},
            h('td', {}, dayLabel(v.scheduled_start)),
            h('td', {}, v.doctor_name),
            h('td.mono', {}, v.display),
            h('td', {}, SOURCE_LABELS[v.source] || v.source),
            h('td.mono', {}, v.arrived_at && v.started_at ? `${Math.round((v.started_at - v.arrived_at) / 60000)} min` : '—'),
            h('td', {}, h('span', { class: `pill ${v.state === 'completed' ? 'ok' : v.state === 'no_show' ? 'danger' : ''}` }, v.state)))))))),

      h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Message ledger'),
        h('div.dim.tiny', { style: { marginBottom: '8px' } }, '"I never got a message" answerable in two seconds.'),
        detail.messages.slice(0, 12).map((m) => h('div.spread', { style: { padding: '5px 0', borderBottom: '1px solid var(--border)' } },
          h('div.grow', {}, h('div.sm', {}, m.body), h('div.tiny.dim', {}, `${m.template} · ${hhmm(m.at)}`)),
          h('span', { class: `pill ${m.state === 'delivered' ? 'ok' : 'danger'}` }, `${m.channel} ${m.state === 'delivered' ? '✓' : '✗'}`))),
        !detail.messages.length ? h('div.dim', {}, 'No messages yet') : null),

      h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Invoices'),
        detail.invoices.slice(0, 8).map((i) => h('div.spread', { style: { padding: '5px 0' } },
          h('span', {}, dayLabel(i.created_at), h('span.dim.sm', {}, ` · ${i.payer_type}`)),
          h('span.row', {},
            h('span.mono', {}, mvr(i.total_minor)),
            h('span', { class: `pill ${i.state === 'paid' ? 'ok' : 'warn'}` }, i.state)))),
        !detail.invoices.length ? h('div.dim', {}, 'No invoices') : null),
    ) : h('div.empty', {}, 'Select a patient'));
}
