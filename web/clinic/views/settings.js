import { h, api, guard } from '/shared/core.js';
import { state, render } from '/clinic/app.js';

let data = null;

async function load() {
  data = await api(`/api/clinic/settings`);
  render();
}

async function savePenalty(patch) {
  const penalty = { ...data.penalty, ...patch };
  await guard(() => api('/api/clinic/settings', {
    method: 'PUT', body: { settings: { penalty } },
  }), 'Policy saved');
  data = null;
  await load();
}

export function renderSettings() {
  if (!data) { load(); return h('div.empty', {}, 'Loading settings…'); }
  const p = data.penalty;

  const field = (label, node, hint) => h('label.field', {}, h('span', {}, label), node, hint ? h('div.tiny.dim', {}, hint) : null);
  const isAdmin = state.staff.role === 'admin';
  const newName = h('input.input', { placeholder: 'Full name', style: { maxWidth: '180px' } });
  const newUser = h('input.input', { placeholder: 'username', autocapitalize: 'none', style: { maxWidth: '150px' } });
  const newRole = h('select.input', { style: { maxWidth: '140px' } },
    ['receptionist', 'admin', 'billing', 'doctor'].map((r) => h('option', { value: r }, r)));

  return h('div.grid.k2', {},
    h('div.card.pad', {},
      h('div.section-title', { style: { marginTop: 0 } }, 'Delay penalty policy'),
      h('div.dim.tiny', { style: { marginBottom: '12px' } },
        'Configurable per clinic because clinic cultures genuinely differ. Every penalty is reversible in one click, logged, and explained to the patient — a silent demotion is worse than no system at all.'),
      field('Grace period after being called',
        h('select.input', { onChange: (e) => savePenalty({ gracePeriodMinutes: Number(e.target.value) }) },
          [2, 3, 5, 8, 10, 15].map((v) => h('option', { value: v, selected: v === p.gracePeriodMinutes }, `${v} minutes`)))),
      field('What happens then',
        h('select.input', { onChange: (e) => savePenalty({ penaltyMode: e.target.value }) },
          [['move_back_n', 'Move back a few places'], ['move_to_end', 'Move to the end of the queue'],
            ['hold_for_recall', 'Hold for recall'], ['none', 'Nothing — reception decides']]
            .map(([v, l]) => h('option', { value: v, selected: v === p.penaltyMode }, l)))),
      field('Places to move back',
        h('select.input', { onChange: (e) => savePenalty({ moveBackPositions: Number(e.target.value) }) },
          [1, 2, 3, 5].map((v) => h('option', { value: v, selected: v === p.moveBackPositions }, v)))),
      field('Penalties before marking no-show',
        h('select.input', { onChange: (e) => savePenalty({ maxPenaltiesBeforeNoShow: Number(e.target.value) }) },
          [1, 2, 3].map((v) => h('option', { value: v, selected: v === p.maxPenaltiesBeforeNoShow }, v)))),
      h('label.row', { style: { gap: '8px', marginTop: '4px' } },
        h('input', {
          type: 'checkbox', checked: p.travelFlagExemption,
          onChange: (e) => savePenalty({ travelFlagExemption: e.target.checked }),
        }),
        h('span', {}, 'Exempt inter-island travellers from automatic demotion')),
      h('div.tiny.dim', { style: { marginTop: '6px' } },
        'Not sentimentality — retention. A patient who took a three-hour ferry and got demoted for being six minutes late will never come back, and will tell the island. The system flags them and forces a human decision instead.')),

    h('div.stack', {},
      h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Partner integrations'),
        h('div.dim.tiny', { style: { marginBottom: '12px' } },
          'You grant, cap and revoke partner access — not us, and not the partner. Revocation takes effect immediately.'),
        data.partners.map((partner) => h('div', { style: { padding: '10px 0', borderTop: '1px solid var(--border)' } },
          h('div.spread', {},
            h('div', {}, h('strong', {}, partner.name),
              h('div.tiny.dim', {}, `${partner.bookings} bookings all time`)),
            h('label.row', { style: { gap: '6px' } },
              h('input', {
                type: 'checkbox', checked: !!partner.enabled,
                onChange: async (e) => {
                  await guard(() => api(`/api/clinic/partners/${partner.id}`, {
                    method: 'PUT',
                    body: {
                      enabled: e.target.checked,
                      allocationPct: partner.allocation_pct ?? 20,
                      canCancel: !!partner.can_cancel, horizonDays: partner.horizon_days ?? 14,
                    },
                  }), e.target.checked ? `${partner.name} enabled` : `${partner.name} revoked`);
                  data = null; await load();
                },
              }),
              h('span.sm', {}, partner.enabled ? 'Enabled' : 'Disabled'))),
          partner.enabled ? h('div.row', { style: { marginTop: '8px' } },
            h('span.sm.muted', {}, 'Slot allocation'),
            h('select.input', {
              style: { maxWidth: '120px' },
              onChange: async (e) => {
                await guard(() => api(`/api/clinic/partners/${partner.id}`, {
                  method: 'PUT',
                  body: {
                    enabled: true, allocationPct: Number(e.target.value),
                    canCancel: !!partner.can_cancel, horizonDays: partner.horizon_days ?? 14,
                  },
                }), 'Allocation updated');
                data = null; await load();
              },
            }, [5, 10, 20, 30, 50, 100].map((v) => h('option', { value: v, selected: v === partner.allocation_pct }, `${v}% of session`))),
            h('span.tiny.dim', {}, 'Caps how much of each session this partner can sell')) : null))),

      h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Your team'),
        h('div.help', { style: { marginBottom: '6px' } },
          'Everyone who can sign in to this clinic. Each person has their own username and password — the username alone says which clinic they belong to. ',
          'Admins can add people, reset a password, or switch an account off. Optional clinic address for a bookmark: ', h('span.mono', {}, data.signInPath), '.'),
        (data.staff || []).map((m) => h('div.spread', { style: { padding: '7px 0', borderTop: '1px solid var(--border)' } },
          h('span', {}, h('div', { style: { fontWeight: 700, opacity: m.active ? 1 : .5 } }, m.name),
            h('div.tiny.dim', {}, h('span.mono', {}, m.username), ` · ${m.role}`, m.must_change_password ? ' · must change password' : '', m.active ? '' : ' · switched off')),
          isAdmin ? h('span.row', {},
            h('button.btn.sm', {
              onClick: () => guard(async () => {
                const r = await api(`/api/clinic/staff/${m.id}/reset-password`, { method: 'POST' });
                alert(`New password for ${m.name}:\n\n${r.password}\n\nShown once. They will be asked to change it.`);
              }),
            }, 'Reset password'),
            m.id !== state.staff.id ? h('button.btn.sm.ghost', {
              onClick: () => guard(async () => {
                await api(`/api/clinic/staff/${m.id}/active`, { method: 'POST', body: { active: !m.active } });
                data = null; await load();
              }, m.active ? 'Account switched off' : 'Account switched on'),
            }, m.active ? 'Switch off' : 'Switch on') : null) : null)),
        isAdmin ? h('div', { style: { marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' } },
          h('div', { style: { fontWeight: 700, marginBottom: '6px' } }, 'Add someone'),
          h('div.row.wrap', {}, newName, newUser, newRole,
            h('button.btn.primary.sm', {
              onClick: () => guard(async () => {
                const r = await api('/api/clinic/staff', { method: 'POST', body: { name: newName.value.trim(), username: newUser.value.trim(), role: newRole.value } });
                alert(`${r.staff.name} can now sign in.\n\nUsername: ${r.staff.username}\nPassword: ${r.password}\n\nShown once. They will be asked to change it.`);
                newName.value = ''; newUser.value = '';
                data = null; await load();
              }),
            }, 'Create sign-in'))) : null),

      h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Clinic'),
        h('div.spread', {}, h('span.muted', {}, 'Name'), h('span', {}, data.clinic.name)),
        h('div.spread', {}, h('span.muted', {}, 'Island'), h('span', {}, `${data.clinic.island}, ${data.clinic.atoll}`)),
        h('div.spread', {}, h('span.muted', {}, 'Tier'), h('span.pill.brand', {}, data.clinic.settings.tier || 'clinic')),
        h('div.spread', {}, h('span.muted', {}, 'Weekend'), h('span', {}, 'Friday–Saturday')),
        h('div.spread', {}, h('span.muted', {}, 'Prayer pauses'), h('span.pill.ok', {}, 'Modelled as blackout intervals'))),

      h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Localisation'),
        h('div.dim.tiny', {}, 'Dhivehi is written in Thaana, a right-to-left script. RTL is structural here, not a translation file — but the copy itself is a translation task with a named owner, and untranslated strings fall back to English rather than shipping wrong Dhivehi.'),
        h('div.row', { style: { marginTop: '10px' } },
          h('button.btn.sm', {
            onClick: async () => {
              const dv = await api('/api/demo/i18n/dv');
              alert(`Thaana renders as: ${dv.strings['app.name']} — ${dv.strings['queue.howLong']}\n\n`
                + `${dv.pending.length} strings still awaiting Dhivehi copy review.`);
            },
          }, 'Check Dhivehi status'))),

      h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Audit'),
        h('button.btn.sm', {
          onClick: async () => {
            const { audit } = await api(`/api/clinic/audit`);
            alert(audit.slice(0, 20).map((a) => `${new Date(a.at).toISOString().slice(11, 16)} ${a.actor} ${a.action} ${a.entity ?? ''}`).join('\n') || 'No audit entries yet');
          },
        }, 'View recent audit log'))),
  );
}
