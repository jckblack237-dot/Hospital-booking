import { h, api, dayLabel, mvr, guard } from '/shared/core.js';
import { state, render } from '/clinic/app.js';

let data = null;

/** Sign-out: nothing of the last clinic survives on a shared tablet. */
export function reset() { data = null; }

async function load() {
  data = await api(`/api/clinic/billing`);
  render();
}

async function run(fn, ok) {
  await guard(fn, ok);
  await load();
}

export function renderBilling() {
  if (!data) { load(); return h('div.empty', {}, 'Loading billing…'); }

  const byState = Object.fromEntries(data.claims.map((c) => [c.state, c]));
  const rejected = byState.rejected ?? { n: 0, value: 0 };

  return h('div.stack', {},
    h('div.card.pad.spread', {},
      h('div', {},
        h('strong', {}, 'Aasandha integration mode: '),
        h('span', { class: `pill ${data.aasandhaMode === 'api' ? 'ok' : 'warn'}` }, data.aasandhaMode),
        h('div.dim.sm', { style: { marginTop: '4px' } },
          data.aasandhaMode === 'degraded'
            ? 'Degraded mode: claim batches are produced in submission-ready form and status is tracked by manual entry. No scheme API is wired up (assumption A1). This is the path we control, and it ships first.'
            : 'Live API mode.')),
      h('div.row', {},
        h('button.btn', { onClick: () => run(() => api('/api/clinic/billing/claims/submit', { method: 'POST', body: {} }), 'Claims submitted') }, 'Submit draft claims'),
        h('button.btn.ghost', { onClick: () => run(() => api('/api/clinic/billing/claims/adjudicate', { method: 'POST', body: {} }), 'Adjudication simulated') }, 'Simulate adjudication'))),

    h('div.grid.k4', {},
      ['draft', 'submitted', 'accepted', 'rejected'].map((s) => h('div.card.stat', {},
        h('div.label', {}, `${s} claims`),
        h('div.value', {}, byState[s]?.n ?? 0),
        h('div.sub', {}, mvr(byState[s]?.value ?? 0))))),

    rejected.n ? h('div.card.pad', {},
      h('div.spread', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Rejection worklist'),
        h('span.pill.danger', {}, `${mvr(rejected.value)} at stake`)),
      h('div.scroll-x', {}, h('table.data', {},
        h('thead', {}, h('tr', {}, ['Patient', 'Payer', 'Amount', 'Reason', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, data.worklist.slice(0, 25).map((c) => h('tr', {},
          h('td', {}, c.patient_name),
          h('td', {}, c.payer),
          h('td.mono', {}, mvr(c.amount_minor)),
          h('td', {}, h('div', {}, h('span.pill.danger', {}, c.reason_code)), h('div.tiny.dim', {}, c.reason_text)),
          h('td', {}, h('button.btn.sm', {
            onClick: () => run(() => api(`/api/clinic/billing/claims/${c.id}/resubmit`, { method: 'POST' }), 'Resubmitted'),
          }, 'Resubmit')))))))) : null,

    data.rejectionAnalytics.length ? h('div.card.pad', {},
      h('div.section-title', { style: { marginTop: 0 } }, 'Why claims are rejected'),
      h('div.dim.tiny', { style: { marginBottom: '10px' } }, 'The highest-ROI report in the product for a mid-size clinic.'),
      (() => {
        const max = Math.max(...data.rejectionAnalytics.map((r) => r.count));
        return data.rejectionAnalytics.map((r) => h('div.hbar', {},
          h('span.lab', { title: r.text }, `${r.code} ${r.text}`),
          h('span.bar', {}, h('i', { style: { width: `${(r.count / max) * 100}%` } })),
          h('span.val', {}, `${r.count} · ${mvr(r.value_minor)}`)));
      })()) : null,

    h('div.card.pad', {},
      h('div.section-title', { style: { marginTop: 0 } }, 'Recent invoices'),
      h('div.scroll-x', {}, h('table.data', {},
        h('thead', {}, h('tr', {}, ['Date', 'Patient', 'Payer', 'Billed', 'Covered', 'Patient pays', 'Status', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, data.invoices.slice(0, 40).map((i) => h('tr', {},
          h('td', {}, dayLabel(i.created_at)),
          h('td', {}, i.patient_name),
          h('td', {}, i.payer_type),
          h('td.mono', {}, mvr(i.total_minor)),
          h('td.mono', {}, mvr(i.covered_minor)),
          h('td.mono', {}, mvr(i.patient_minor)),
          h('td', {}, h('span', { class: `pill ${i.state === 'paid' ? 'ok' : i.state === 'void' ? '' : 'warn'}` }, i.state)),
          h('td', {}, i.state === 'open' && i.patient_minor > 0
            ? h('div.row', {}, ['bml_card', 'mfaisaa', 'cash'].map((m) => h('button.btn.sm', {
              onClick: () => run(() => api('/api/clinic/billing/payments', {
                method: 'POST', body: { invoiceId: i.id, method: m, amountMinor: i.patient_minor },
              }), 'Payment taken'),
            }, m === 'bml_card' ? 'BML' : m === 'mfaisaa' ? 'm-Faisaa' : 'Cash')))
            : null))))))),

    h('div.card.pad.dim.tiny', {},
      'We never touch patient money — payments settle directly to the clinic merchant account. '
      + 'No external payment rail is wired up here; BML and m-Faisaa are unverified assumptions (A3) behind a PaymentAdapter.'),
  );
}
