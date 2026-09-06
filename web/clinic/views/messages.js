import { h, api, hhmm, mvr } from '/shared/core.js';
import { state, render } from '/clinic/app.js';

let data = null;
const mvr2 = (minor) => `MVR ${((minor || 0) / 100).toFixed(2)}`;

async function load() {
  data = await api(`/api/clinic/messages`);
  render();
}

export function renderMessages() {
  if (!data) { load(); return h('div.empty', {}, 'Loading messages…'); }
  const delivered = data.messages.filter((m) => m.state === 'delivered');
  const byChannel = delivered.reduce((acc, m) => ({ ...acc, [m.channel]: (acc[m.channel] || 0) + 1 }), {});
  const spend = delivered.reduce((s, m) => s + m.cost_minor, 0);

  return h('div.stack', {},
    h('div.grid.k4', {},
      h('div.card.stat', {}, h('div.label', {}, 'Wallet balance'),
        h('div.value', { style: { color: data.walletMinor < 5000 ? 'var(--warn)' : 'inherit' } }, mvr(data.walletMinor)),
        h('div.sub', {}, 'Transactional messages continue on a small overdraft')),
      h('div.card.stat', {}, h('div.label', {}, 'Delivered'), h('div.value', {}, delivered.length)),
      h('div.card.stat', {}, h('div.label', {}, 'Spend shown'), h('div.value', {}, mvr2(spend))),
      h('div.card.stat', {}, h('div.label', {}, 'Channel mix'),
        h('div.value.sm', { style: { fontSize: '15px' } },
          Object.entries(byChannel).map(([c, n]) => `${c} ${n}`).join(' · ') || '—'),
        h('div.sub', {}, `SMS ${mvr2(data.costs.sms)} · Viber ${mvr2(data.costs.viber)} · push free`))),

    h('div.card.pad', {},
      h('div.section-title', { style: { marginTop: 0 } }, 'Message ledger'),
      h('div.dim.tiny', { style: { marginBottom: '10px' } },
        'Push → Viber → SMS, never two at once. Failed attempts are shown so the cascade is visible. '
        + 'Delivery is simulated here: no Viber BSP or telco aggregator is wired up (assumption A4).'),
      h('div.scroll-x', { style: { maxHeight: '60vh' } }, h('table.data', {},
        h('thead', {}, h('tr', {}, ['Time', 'Patient', 'Template', 'Channel', 'Status', 'Cost', 'Body'].map((c) => h('th', {}, c)))),
        h('tbody', {}, data.messages.slice(0, 120).map((m) => h('tr', {},
          h('td.mono', {}, hhmm(m.at)),
          h('td', {}, m.patient_name || '—'),
          h('td', {}, h('span.pill', {}, m.template)),
          h('td', {}, h('span', { class: `pill ${m.channel === 'sms' ? 'warn' : m.channel === 'viber' ? 'violet' : 'info'}` }, m.channel)),
          h('td', {}, h('span', { class: `pill ${m.state === 'delivered' ? 'ok' : 'danger'}` }, m.state)),
          h('td.mono', {}, m.cost_minor ? mvr2(m.cost_minor) : '—'),
          h('td.sm.muted', { style: { maxWidth: '360px' } }, m.body))))))),
  );
}
