import { h, api, mvr } from '/shared/core.js';
import { state, render } from '/clinic/app.js';

let data = null;
let days = 30;

async function load() {
  data = await api(`/api/clinic/analytics?clinicId=${state.clinic.id}&days=${days}`);
  render();
}

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

function bars(rows, labelKey, valueKey, format = (v) => v) {
  if (!rows.length) return h('div.dim', {}, 'No data');
  const max = Math.max(...rows.map((r) => r[valueKey] || 0)) || 1;
  return rows.map((r) => h('div.hbar', {},
    h('span.lab', { title: r[labelKey] }, r[labelKey]),
    h('span.bar', {}, h('i', { style: { width: `${((r[valueKey] || 0) / max) * 100}%` } })),
    h('span.val', {}, format(r[valueKey]))));
}

export function renderAnalytics() {
  if (!data) { load(); return h('div.empty', {}, 'Loading analytics…'); }
  const { today, punctuality, revenue, volume, quality, digest } = data;

  return h('div.stack', {},
    h('div.row', {},
      h('div.section-title', { style: { margin: 0 } }, 'Live today'),
      h('span.grow'),
      h('select.input', {
        style: { maxWidth: '160px' },
        onChange: (e) => { days = Number(e.target.value); data = null; load(); },
      }, [7, 30, 90].map((d) => h('option', { value: d, selected: d === days }, `Last ${d} days`)))),

    h('div.grid.k4', {},
      h('div.card.stat', {}, h('div.label', {}, 'Seen today'), h('div.value', {}, today.seen)),
      h('div.card.stat', {}, h('div.label', {}, 'Waiting now'), h('div.value', {}, today.waiting)),
      h('div.card.stat', {}, h('div.label', {}, 'Average wait'),
        h('div.value', {}, today.avgWaitMinutes != null ? `${today.avgWaitMinutes}m` : '—')),
      h('div.card.stat', {}, h('div.label', {}, 'Billed today'), h('div.value', {}, mvr(today.revenueMinor)),
        h('div.sub', {}, `${mvr(today.collectedMinor)} collected`))),

    today.doctorsRunningLate.length ? h('div.card.pad', {},
      h('div.section-title', { style: { marginTop: 0 } }, 'Running late right now'),
      today.doctorsRunningLate.map((d) => h('div.spread', {}, h('span', {}, d.name), h('span.pill.warn', {}, `${d.lateMinutes} min`)))) : null,

    digest.findings.length ? h('div.stack', {},
      h('div.section-title', {}, 'This week, in words'),
      digest.findings.map((f) => h('div.finding', {}, f))) : null,

    h('div.section-title', {}, 'Is the estimate honest?'),
    h('div.grid.k4', {},
      h('div.card.stat', {},
        h('div.label', {}, 'P80 coverage'),
        h('div.value', {}, pct(quality.p80Coverage)),
        h('div.sub', {}, `${quality.sample} tokens · target ≥ 80%`)),
      h('div.card.stat', {},
        h('div.label', {}, 'Median absolute error'),
        h('div.value', {}, quality.medianAbsErrorMinutes != null ? `${quality.medianAbsErrorMinutes}m` : '—')),
      h('div.card.stat', {},
        h('div.label', {}, 'Optimism bias'),
        h('div.value', { style: { color: (quality.optimismBiasMinutes ?? 0) > 2 ? 'var(--danger)' : 'inherit' } },
          quality.optimismBiasMinutes != null ? `${quality.optimismBiasMinutes > 0 ? '+' : ''}${quality.optimismBiasMinutes}m` : '—'),
        h('div.sub', {}, 'Positive is a bug, not a preference')),
      h('div.card.stat', {},
        h('div.label', {}, 'Event completeness'),
        h('div.value', {}, pct(quality.eventCompleteness)),
        h('div.sub', {}, 'Consultations with start AND end'))),

    h('div.section-title', {}, 'Are my doctors running on time?'),
    h('div.card.pad', {},
      h('div.dim.tiny', { style: { marginBottom: '10px' } },
        'Shown to each doctor in their own view first. Durations are a scheduling input, never a ranked score — and never exposed to patients or partners.'),
      h('div.scroll-x', {}, h('table.data', {},
        h('thead', {}, h('tr', {}, ['Doctor', 'Sessions', 'Median start delay', 'P90 delay', 'Consult p50 / p90', 'Slot', 'Suggested', 'Utilisation'].map((c) => h('th', {}, c)))),
        h('tbody', {}, punctuality.map((d) => h('tr', {},
          h('td', {}, d.name),
          h('td.mono', {}, d.sessions),
          h('td', {}, h('span', { class: `pill ${d.medianStartDelayMinutes > 20 ? 'danger' : d.medianStartDelayMinutes > 8 ? 'warn' : 'ok'}` }, `${d.medianStartDelayMinutes ?? '—'} min`)),
          h('td.mono', {}, `${d.p90StartDelayMinutes ?? '—'} min`),
          h('td.mono', {}, `${d.consultationMinutes.p50 ?? '—'} / ${d.consultationMinutes.p90 ?? '—'} min`),
          h('td.mono', {}, `${d.scheduledSlotMinutes} min`),
          h('td', {}, d.suggestedSlotMinutes !== d.scheduledSlotMinutes
            ? h('span.pill.info', {}, `${d.suggestedSlotMinutes} min`)
            : h('span.pill.ok', {}, 'good')),
          h('td.mono', {}, d.utilisation != null ? `${Math.round(d.utilisation * 100)}%` : '—')))))),
      punctuality.filter((d) => d.finding).map((d) => h('div.finding', { style: { marginTop: '8px' } }, d.finding))),

    h('div.grid.k2', {},
      h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Revenue by payer'),
        bars(revenue.byPayer.map((r) => ({ label: r.payer_type, value: r.billed })), 'label', 'value', mvr)),
      h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Revenue by doctor'),
        bars(revenue.byDoctor.slice(0, 8).map((r) => ({ label: r.name, value: r.billed })), 'label', 'value', mvr))),

    h('div.grid.k2', {},
      h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Where bookings come from'),
        bars(volume.bySource.map((r) => ({ label: r.source, value: r.n })), 'label', 'value'),
        h('div.dim.tiny', { style: { marginTop: '8px' } },
          `No-show rate by source: ${volume.bySource.map((r) => `${r.source} ${Math.round((r.no_shows / Math.max(1, r.n)) * 100)}%`).join(' · ')}`)),
      h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Waiting'),
        h('div.grid.k2', {},
          h('div', {}, h('div.label.tiny.dim', {}, 'Median wait'), h('div.big', {}, `${volume.medianWaitMinutes ?? '—'} min`)),
          h('div', {}, h('div.label.tiny.dim', {}, 'P90 wait'), h('div.big', {}, `${volume.p90WaitMinutes ?? '—'} min`))),
        h('div.spread', { style: { marginTop: '12px' } },
          h('span.muted', {}, 'Priority insertions'),
          h('span', { class: `pill ${volume.priorityRate > 0.2 ? 'warn' : ''}` }, `${volume.priorityInsertions} (${pct(volume.priorityRate)})`)),
        h('div.spread', {}, h('span.muted', {}, 'Total tokens'), h('span.mono', {}, volume.total)))),

    h('div.card.pad', {},
      h('div.section-title', { style: { marginTop: 0 } }, 'Peak load by hour'),
      bars(volume.byHour.map((r) => ({ label: `${String(r.hour).padStart(2, '0')}:00`, value: r.n })), 'label', 'value')),
  );
}
