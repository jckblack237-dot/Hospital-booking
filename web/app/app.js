import {
  h, mount, api, connect, hhmm, dayLabel, mvr, toast, guard, initTheme,
  SPECIALTY_LABELS, LANGUAGE_LABELS,
} from '/shared/core.js';

const state = {
  patientId: null, me: null, tab: 'home', screen: null,
  bookings: { active: [], past: [] }, messages: [], unread: 0,
  serverNow: Date.now(), connection: 'connecting', track: null, lastTrackAt: 0,
};

initTheme();
let socket;

// ---------------------------------------------------------------------- shell
function appbar(title, back) {
  return h('div.appbar', {},
    back ? h('button.btn.sm.ghost', { onClick: back }, '‹') : h('div.mark', {}, 'V'),
    h('h1', {}, title),
    h('div.grow'),
    h('span', { class: `live-dot ${state.connection === 'live' ? '' : 'off'}`, title: `Realtime ${state.connection}` }),
    h('span.mono.tiny.dim', {}, hhmm(state.serverNow)));
}

function tabbar() {
  const tabs = [['home', '🏠', 'Home'], ['search', '🔍', 'Find care'], ['wallet', '💳', 'Wallet'], ['alerts', '🔔', 'Alerts']];
  return h('nav.tabbar', {}, tabs.map(([key, ico, label]) =>
    h('button', {
      'aria-current': state.tab === key && !state.screen ? 'page' : null,
      onClick: () => { state.tab = key; state.screen = null; render(); },
    },
    h('span.ico', {}, ico),
    key === 'alerts' && state.unread ? h('span.badge', {}, state.unread) : null,
    label)));
}

export function render() {
  const view = state.screen ? state.screen() : screens[state.tab]();
  mount(document.getElementById('root'),
    h('div.phone', {}, view.bar ?? appbar(view.title ?? 'Vaguthu'), h('main.screen', {}, view.body), tabbar()));
}

const go = (fn) => { state.screen = fn; render(); };
const back = () => { state.screen = null; render(); };

// ------------------------------------------------------------------ tracking
async function loadTrack(bookingId) {
  state.track = await api(`/api/patient/bookings/${bookingId}/track`);
  state.serverNow = state.track.serverNow;
  state.lastTrackAt = Date.now();
}

function confidenceLabel(level) {
  return { high: 'Confident', medium: 'Fairly confident', low: 'Rough estimate' }[level] ?? level;
}

const REASON_TEXT = {
  consultation_overrun: 'a consultation ahead of you ran long',
  session_started_late: 'the doctor started late',
  session_paused: 'the queue is paused',
  session_resumed: 'the queue restarted',
  priority_insertion: 'an emergency patient was added ahead of you',
  walk_in_inserted: 'a walk-in was added ahead of you',
  reorder: 'the queue was reordered',
  no_show_ahead: 'someone ahead of you did not attend',
  blackout_interval: 'a scheduled break',
};

function trackerScreen(bookingId) {
  return () => {
    if (!state.track || state.track.token.id !== bookingId) {
      loadTrack(bookingId).then(render);
      return { title: 'Your token', body: h('div.empty', {}, 'Loading…') };
    }
    const t = state.track;
    const e = t.entry;
    const stale = Date.now() - state.lastTrackAt > 25000;
    const ahead = e?.tokensAhead ?? 0;

    // Never show a stale number as if it were live.
    const staleBanner = stale || state.connection !== 'live'
      ? h('div.stale-banner', {}, `Not updating — last checked ${hhmm(t.serverNow)}. Reconnecting…`)
      : null;

    let core;
    if (t.token.state === 'completed') {
      core = h('div.tracker', {},
        h('div.big', {}, 'Visit complete'),
        t.invoice ? h('div.card.pad', { style: { marginTop: '14px', textAlign: 'left' } },
          h('div.spread', {}, h('span.muted', {}, 'Invoice'), h('span.mono', {}, mvr(t.invoice.total_minor))),
          h('div.spread', {}, h('span.muted', {}, 'Covered'), h('span.mono', {}, mvr(t.invoice.covered_minor))),
          h('div.spread', {}, h('strong', {}, 'You pay'), h('strong.mono', {}, mvr(t.invoice.patient_minor)))) : null);
    } else if (t.sessionState === 'cancelled') {
      core = h('div.stack', {},
        h('div.emergency', {},
          h('div', { style: { fontWeight: 750, fontSize: '16px' } }, 'This session was cancelled'),
          h('div.sm', { style: { marginTop: '6px' } },
            'Any payment is refunded automatically. Choose another time, or call the clinic.')),
        h('button.btn.primary.block', { onClick: () => { state.tab = 'search'; back(); } }, 'Find another appointment'),
        h('a.btn.block', { href: `tel:${t.token.clinic_phone}` }, `Call ${t.token.clinic_name}`));
    } else if (t.pause) {
      // No countdown timer: a ticking clock on an unpredictable event
      // manufactures anxiety.
      core = h('div.stack', {},
        h('div.paused-banner', {},
          h('div', { style: { fontWeight: 750, fontSize: '16px' } }, 'The queue is paused'),
          h('div.sm', { style: { marginTop: '6px' } },
            t.pause.kind === 'prayer'
              ? `Prayer break. Expected to resume around ${hhmm(t.pause.expectedResumeAt)} — this was already included in your estimate.`
              : `${t.pause.kind === 'emergency' ? 'The doctor has been called to an emergency.' : 'Short break.'} Expected to resume around ${hhmm(t.pause.expectedResumeAt)}. We'll tell you when it restarts.`)),
        h('div.tracker', {}, h('div.token-chip', {}, t.token.display)));
    } else {
      core = h('div.tracker', {},
        h('div.dim.tiny', {}, 'Your token'),
        h('div.token-chip', {}, t.token.display),
        h('div', { style: { marginTop: '14px' } },
          h('div.dim.tiny', {}, 'Now serving'),
          h('div.big.mono', {}, t.nowServing?.display ?? '—')),
        h('div.progress', {},
          Array.from({ length: Math.min(6, ahead + 1) }, (_, i) =>
            h('i', { class: i < ahead ? 'done' : 'now' }))),
        h('div.muted', {}, ahead === 0 ? "You're next" : `${ahead} ${ahead === 1 ? 'person' : 'people'} ahead of you`),

        e ? h('div.eta-box', {},
          h('div.dim.tiny', {}, 'Likely seen'),
          // A window, never a point. A single time is read as a promise, and
          // every promise we break costs more than the vagueness of a range.
          h('div.window', {}, `${hhmm(e.predictedStart.window.from)} – ${hhmm(e.predictedStart.window.to)}`),
          h('div.row', { style: { justifyContent: 'center', marginTop: '6px' } },
            h('span', { class: `pill ${e.predictedStart.confidence === 'high' ? 'ok' : e.predictedStart.confidence === 'low' ? 'warn' : ''}` },
              confidenceLabel(e.predictedStart.confidence)))) : null,

        e && t.token.state !== 'called' && (t.token.state === 'arrived' || t.patient.travelMinutes === 0)
          ? h('div.leave-box', {},
            h('div.title', {}, '🪑 Waiting at the clinic'),
            h('div.sm', { style: { marginTop: '4px' } }, "We'll call your token — no need to watch the board."))
          : null,

        e && t.token.state !== 'called' && t.token.state !== 'arrived' && t.patient.travelMinutes > 0 ? h('div', {
          class: `leave-box ${e.leaveNow ? 'go' : ''}`,
        },
        h('div.title', {}, e.leaveNow ? '🚶 Leave now' : `🚶 Leave around ${hhmm(e.leaveAt)}`),
        h('div.sm', { style: { marginTop: '4px' } },
          t.patient.travelMinutes
            ? `About ${t.patient.travelMinutes} min from where you said you're waiting.`
            : "You told us you're at the clinic."),
        h('div.row', { style: { justifyContent: 'center', marginTop: '10px' } },
          h('button.btn.sm', {
            onClick: () => guard(async () => {
              await api(`/api/patient/bookings/${t.token.id}/on-my-way`, { method: 'POST' });
              await loadTrack(t.token.id);
              render();
            }, "Reception knows you're on the way"),
          }, "I'm on my way"),
          h('button.btn.sm', { onClick: () => go(preferencesScreen) }, 'Change location'))) : null,

        t.token.state === 'called'
          ? h('div.leave-box.go', {}, h('div.title', {}, '📢 You have been called'),
            h('div.sm', {}, 'Please go to reception now.')) : null,

        t.token.state === 'penalised'
          ? h('div.reason', {}, `You were called and we could not find you. You have moved back in the queue — new estimate ${e ? `${hhmm(e.predictedStart.window.from)}–${hhmm(e.predictedStart.window.to)}` : 'shortly'}. Tell reception when you arrive.`) : null,

        // Always say why. "18:40 → 19:05" with no explanation reads as
        // incompetence; with a reason it reads as a clinic being a clinic.
        e?.reason && Math.abs(e.deltaMinutes ?? 0) >= 5
          ? h('div.reason', {}, `Running about ${Math.abs(e.deltaMinutes)} min ${e.deltaMinutes > 0 ? 'later' : 'earlier'} — ${REASON_TEXT[e.reason] ?? 'the queue changed'}.`)
          : t.runningLateMinutes > 5
            ? h('div.reason', {}, `${t.token.doctor_name} is running about ${t.runningLateMinutes} min behind.`)
            : null,

        e?.atRisk ? h('div.emergency', { style: { textAlign: 'left', marginTop: '10px' } },
          h('div', { style: { fontWeight: 700 } }, 'You may not be reached today'),
          h('div.sm', { style: { margin: '6px 0 10px' } },
            `There's a chance ${t.token.doctor_name} will not reach your token before the session ends.`),
          h('div.row', {},
            h('button.btn.sm', { onClick: () => { state.tab = 'search'; back(); } }, 'Move to another time'),
            h('button.btn.sm.danger', { onClick: () => cancelBooking(t.token.id) }, 'Cancel & refund'))) : null,
      );
    }

    return {
      bar: appbar(t.token.doctor_name, back),
      body: h('div.stack', {},
        staleBanner,
        h('div.dim.tiny', { style: { textAlign: 'center' } },
          `${t.token.clinic_name} · ${t.token.address}`),
        core,
        ['booked', 'arrived', 'called', 'penalised'].includes(t.token.state) ? h('div.row', {},
          h('button.btn.grow', {
            onClick: () => guard(async () => {
              await api(`/api/patient/bookings/${t.token.id}/check-in`, { method: 'POST' });
              await loadTrack(t.token.id); render();
            }, 'Checked in'),
          }, t.token.state === 'booked' ? "I'm here — check in" : 'Checked in ✓'),
          h('a.btn', { href: `tel:${t.token.clinic_phone}` }, 'Call clinic'),
          h('button.btn.danger', { onClick: () => cancelBooking(t.token.id) }, 'Give up my turn')) : null,
      ),
    };
  };
}

async function cancelBooking(bookingId) {
  if (!confirm('Give up your turn? You will lose this position in the queue.')) return;
  await guard(() => api(`/api/patient/bookings/${bookingId}/cancel`, { method: 'POST' }), 'Cancelled');
  state.track = null;
  await refresh();
  back();
}

// ---------------------------------------------------------------------- home
const screens = {
  home() {
    const active = state.bookings.active;
    return {
      title: `Hello, ${(state.me?.patient?.name || '').split(' ')[0] || 'there'}`,
      body: h('div.stack', {},
        h('div.hero.card', { style: { padding: '20px 16px' } },
          h('h2', {}, 'Know your turn'),
          h('p', {}, "Wait where you like. We'll tell you when to leave.")),

        active.length ? h('div.stack', {},
          h('div.section-title', { style: { marginTop: '4px' } }, 'Live now'),
          active.map((b) => h('div.card.pad', {
            style: { cursor: 'pointer' },
            onClick: () => { state.track = null; go(trackerScreen(b.id)); },
          },
          h('div.spread', {},
            h('div', {},
              h('div', { style: { fontWeight: 700 } }, b.doctor_name),
              h('div.dim.sm', {}, `${b.clinic_name} · ${dayLabel(b.scheduled_start)} ${hhmm(b.scheduled_start)}`),
              b.patient_name !== state.me?.patient?.name ? h('span.pill.violet', {}, `for ${b.patient_name}`) : null),
            h('div', { style: { textAlign: 'right' } },
              h('div.mono.big', {}, b.display),
              h('span', { class: `pill ${b.session_state === 'running' ? 'ok' : b.session_state === 'paused' ? 'violet' : ''}` },
                b.session_state === 'running' ? 'Live' : b.session_state))),
          h('div.row', { style: { marginTop: '10px' } },
            h('button.btn.sm.primary', {}, 'Track live'))))) : null,

        !active.length ? h('div.card.pad.stack', {},
          h('div.muted', {}, 'No upcoming appointments.'),
          h('button.btn.primary', { onClick: () => { state.tab = 'search'; render(); } }, 'Book an appointment')) : null,

        state.bookings.past.length ? h('div.stack', {},
          h('div.section-title', {}, 'Past visits'),
          state.bookings.past.slice(0, 5).map((b) => h('div.card.pad.spread', {},
            h('div', {}, h('div', {}, b.doctor_name),
              h('div.dim.tiny', {}, `${dayLabel(b.scheduled_start)} · ${b.patient_name}`)),
            h('span', { class: `pill ${b.state === 'completed' ? 'ok' : 'danger'}` }, b.state)))) : null,
      ),
    };
  },

  search() {
    return { title: 'Find care', body: searchBody() };
  },

  wallet() {
    if (!state.wallet) { api(`/api/patient/wallet?patientId=${state.patientId}`).then((w) => { state.wallet = w; render(); }); }
    const w = state.wallet;
    return {
      title: 'Wallet',
      body: w ? h('div.stack', {},
        h('div.wallet-card', {},
          h('div.label', {}, 'Identity'),
          h('div', { style: { fontSize: '18px', fontWeight: 750, marginTop: '2px' } }, w.identity.name),
          h('div.mono', { style: { opacity: .85 } }, w.identity.nationalId || '—'),
          h('div.row', { style: { marginTop: '10px' } },
            h('span.pill', { style: { background: 'rgba(255,255,255,.18)', color: '#fff' } },
              w.identity.efaasVerified ? 'eFaas verified' : 'Not verified'),
            h('span.pill', { style: { background: 'rgba(255,255,255,.18)', color: '#fff' } }, w.cover.payer))),

        h('div.notice', {},
          'Stored encrypted on this device and available offline — your documents work on a boat with no signal. Nothing is shared with a clinic until you book there. We never sell your data.'),

        h('div.card.pad', {},
          h('div.section-title', { style: { marginTop: 0 } }, 'Cover'),
          h('div.spread', {}, h('span.muted', {}, 'Scheme'), h('span', {}, w.cover.payer)),
          w.cover.insurer ? h('div.spread', {}, h('span.muted', {}, 'Insurer'), h('span', {}, w.cover.insurer)) : null,
          h('div.spread', {}, h('span.muted', {}, 'Last check'),
            w.cover.latest
              ? h('span', { class: `pill ${w.cover.latest.result === 'covered' ? 'ok' : w.cover.latest.result === 'not_covered' ? 'danger' : 'warn'}` },
                w.cover.latest.result.replace('_', ' '))
              : h('span.pill', {}, 'never')),
          w.cover.latest?.result === 'unverified'
            ? h('div.tiny.dim', { style: { marginTop: '6px' } },
              "We couldn't verify your cover just now. You can still book — reception will check when you arrive.") : null),

        w.household.length ? h('div.card.pad', {},
          h('div.section-title', { style: { marginTop: 0 } }, 'Household'),
          h('div.dim.tiny', { style: { marginBottom: '8px' } }, 'You can book and track for anyone here.'),
          w.household.map((m) => h('div.spread', { style: { padding: '5px 0' } },
            h('span', {}, m.name, h('span.dim.sm', {}, ` · ${m.relation || 'dependant'}`)),
            h('span.pill', {}, m.payer)))) : null,

        w.referrals.length ? h('div.card.pad', {},
          h('div.section-title', { style: { marginTop: 0 } }, 'Referral letters'),
          w.referrals.map((r) => h('div', { style: { padding: '7px 0', borderBottom: '1px solid var(--border)' } },
            h('div.spread', {},
              h('strong', {}, `→ ${SPECIALTY_LABELS[r.to_specialty] || r.to_specialty}`),
              r.used_token_id ? h('span.pill.ok', {}, 'used') : h('span.pill.info', {}, 'ready')),
            h('div.tiny.dim', {}, `${r.from_doctor} · ${dayLabel(r.issued_at)}`),
            h('div.sm.muted', {}, r.note)))) : null,

        w.invoices.length ? h('div.card.pad', {},
          h('div.section-title', { style: { marginTop: 0 } }, 'Invoices'),
          w.invoices.slice(0, 6).map((i) => h('div.spread', { style: { padding: '5px 0' } },
            h('span', {}, dayLabel(i.created_at)),
            h('span.row', {}, h('span.mono', {}, mvr(i.total_minor)),
              i.patient_minor === 0 && i.state === 'paid'
                ? h('span.pill.ok', {}, `${i.payer_type === 'aasandha' ? 'Aasandha' : i.payer_type} covered`)
                : h('span', { class: `pill ${i.state === 'paid' ? 'ok' : 'warn'}` },
                  i.state === 'paid' ? `you paid ${mvr(i.patient_minor)}` : `${mvr(i.patient_minor)} due`))))) : null,

        w.claims.some((c) => c.state === 'rejected') ? h('div.card.pad', {},
          h('div.section-title', { style: { marginTop: 0 } }, 'Claim problems'),
          w.claims.filter((c) => c.state === 'rejected').slice(0, 3).map((c) => h('div', { style: { padding: '6px 0' } },
            h('div', {}, `${c.payer} claim rejected — ${c.reason_text}`),
            h('div.spread', { style: { marginTop: '6px' } },
              h('span.mono', {}, `${mvr(c.amount_minor)} now due`),
              h('button.btn.sm', { onClick: () => toast('The clinic has been asked to review this claim') }, 'Request a review'))))) : null,

        h('div.card.pad', {},
          h('button.btn.block', { onClick: () => go(preferencesScreen) }, 'Notification & location settings')),
      ) : h('div.empty', {}, 'Loading wallet…'),
    };
  },

  alerts() {
    if (!state.messages.length) loadMessages();
    return {
      title: 'Alerts',
      body: h('div.stack', {},
        h('div.dim.tiny', {}, 'Push → Viber → SMS. We aim for four to six messages a visit; more than that and we are training you to ignore us.'),
        state.messages.length ? state.messages.map((m) => h('div', { class: `msg ${m.read_at ? '' : 'unread'}` },
          h('div.spread', {},
            h('span.pill', { class: `pill ${m.channel === 'sms' ? 'warn' : m.channel === 'viber' ? 'violet' : 'info'}` }, m.channel),
            h('span.dim.tiny.mono', {}, hhmm(m.at))),
          h('div', { style: { marginTop: '5px' } }, m.body))) : h('div.empty', {}, 'No alerts yet'),
      ),
    };
  },
};

async function loadMessages() {
  const data = await api(`/api/patient/messages?patientId=${state.patientId}`);
  state.messages = data.messages;
  await api('/api/patient/messages/read', { method: 'POST', body: { patientId: state.patientId } });
  state.unread = 0;
  render();
}

// -------------------------------------------------------------------- search
const searchState = { query: '', specialty: null, language: null, gender: null, region: null, payer: null, results: [], router: null };

function searchBody() {
  const runSearch = async () => {
    const params = new URLSearchParams();
    for (const key of ['specialty', 'language', 'gender', 'region', 'payer']) {
      if (searchState[key]) params.set(key, searchState[key]);
    }
    const data = await api(`/api/patient/search?${params}`);
    searchState.results = data.doctors;
    render();
  };
  if (!searchState.results.length && !searchState.searched) { searchState.searched = true; runSearch(); }

  const chip = (key, value, label) => h('button', {
    'aria-pressed': searchState[key] === value,
    onClick: () => { searchState[key] = searchState[key] === value ? null : value; runSearch(); },
  }, label);

  return h('div.stack', {},
    h('input.input', {
      placeholder: 'What do you need? e.g. "fever", "child rash", "heart"',
      value: searchState.query,
      onInput: async (e) => {
        searchState.query = e.target.value;
        if (e.target.value.length < 3) { searchState.router = null; return; }
        searchState.router = await api(`/api/patient/symptom?q=${encodeURIComponent(e.target.value)}`);
        if (!searchState.router.emergency && searchState.router.matched) {
          searchState.specialty = searchState.router.specialties[0];
          await runSearch();
        } else render();
      },
    }),

    // Red-flag interception sits ABOVE any booking option and is not
    // dismissible from this screen.
    searchState.router?.emergency ? h('div.emergency', {},
      h('div', { style: { fontWeight: 750, fontSize: '15px' } }, 'This may be an emergency'),
      h('div.sm', { style: { margin: '6px 0 10px' } }, searchState.router.emergency.why),
      h('div.num', {}, searchState.router.emergency.number),
      h('div.sm', {}, searchState.router.emergency.action)) : null,

    searchState.router && !searchState.router.emergency ? h('div.notice', {},
      searchState.router.matched
        ? `Doctors who treat this: ${searchState.router.specialties.map((s) => SPECIALTY_LABELS[s] || s).join(', ')}. `
        : 'Not sure what you need? Start with general practice. ',
      searchState.router.disclaimer) : null,

    h('div.chips', {},
      chip('specialty', null, 'All'),
      ...['general_practice', 'paediatrics', 'internal_medicine', 'obgyn', 'ent', 'dermatology', 'cardiology', 'ophthalmology']
        .map((s) => chip('specialty', s, SPECIALTY_LABELS[s]))),
    h('div.chips', {},
      chip('region', 'male', 'Greater Malé'), chip('region', 'atoll', 'Atolls'),
      chip('language', 'dv', 'Dhivehi'), chip('language', 'en', 'English'),
      chip('language', 'hi', 'Hindi/Urdu'), chip('language', 'bn', 'Bengali'),
      chip('gender', 'female', 'Female doctor'), chip('gender', 'male', 'Male doctor'),
      chip('payer', 'aasandha', 'Takes Aasandha')),

    h('div.dim.tiny', {}, `${searchState.results.length} doctors · soonest available first · no paid placement`),

    searchState.results.map((d) => h('div.card.doccard', { onClick: () => go(doctorScreen(d.id)) },
      h('div.av', {}, d.name.replace('Dr. ', '').slice(0, 2)),
      h('div.grow', {},
        h('div', { style: { fontWeight: 700 } }, d.name),
        h('div.dim.sm', {}, `${SPECIALTY_LABELS[d.specialty] || d.specialty} · ${d.clinic_name}`),
        h('div.row.wrap', { style: { marginTop: '5px' } },
          d.languages.map((l) => h('span.pill', {}, LANGUAGE_LABELS[l] || l)),
          h('span.pill', {}, mvr(d.fee_minor)))),
      h('div', { style: { textAlign: 'right', flex: 'none' } },
        d.next_available
          ? [h('div.tiny.dim', {}, 'Next'), h('div.mono', { style: { fontWeight: 700 } }, hhmm(d.next_available.starts_at)),
            h('div.tiny.dim', {}, dayLabel(d.next_available.starts_at))]
          : h('span.pill', {}, 'No slots')))),
  );
}

function doctorScreen(doctorId) {
  let data = null;
  return () => {
    if (!data) {
      api(`/api/patient/doctors/${doctorId}`).then((d) => { data = d; render(); });
      return { title: 'Doctor', body: h('div.empty', {}, 'Loading…') };
    }
    const d = data.doctor;
    return {
      bar: appbar(d.name, back),
      body: h('div.stack', {},
        h('div.card.pad', {},
          h('div.big', {}, d.name),
          h('div.muted', {}, d.qualifications),
          h('div.dim.sm', {}, `${SPECIALTY_LABELS[d.specialty] || d.specialty} · ${d.clinic_name}, ${d.island}`),
          h('div.row.wrap', { style: { marginTop: '8px' } },
            d.languages.map((l) => h('span.pill', {}, LANGUAGE_LABELS[l] || l)),
            h('span.pill.brand', {}, mvr(d.fee_minor)),
            h('span.pill', {}, `usually ${d.typical_consultation_minutes} min`)),
          h('div.dim.tiny', { style: { marginTop: '8px' } }, `Accepts: ${d.accepts_payers.join(', ')}`)),

        data.availability.length ? data.availability.map((s) => h('div.card.pad', {},
          h('div.spread', {},
            h('strong', {}, dayLabel(s.starts_at)),
            h('span.dim.sm', {}, `${hhmm(s.starts_at)}–${hhmm(s.ends_at)}`)),
          h('div.chips', { style: { marginTop: '8px', flexWrap: 'wrap' } },
            s.slots.filter((sl) => sl.status === 'available').slice(0, 12).map((sl) =>
              h('button', { onClick: () => go(bookingScreen(d, s, sl)) }, hhmm(sl.starts_at)))),
          !s.slots.some((sl) => sl.status === 'available') ? h('div.dim.sm', {}, 'Fully booked') : null))
          : h('div.empty', {}, 'No upcoming sessions'),
      ),
    };
  };
}

function bookingScreen(doctor, session, slot) {
  return () => {
    const forWhom = h('select.input', {},
      h('option', { value: state.patientId }, `${state.me.patient.name} (me)`),
      (state.me.household || []).map((m) => h('option', { value: m.id }, `${m.name} (${m.relation || 'dependant'})`)));
    const waitLocation = h('select.input', {},
      h('option', { value: 'clinic' }, "I'll wait at the clinic"),
      h('option', { value: 'nearby', selected: true }, 'Nearby — about 10 minutes away'),
      h('option', { value: 'custom' }, 'Further — about 35 minutes away'));

    return {
      bar: appbar('Confirm booking', back),
      body: h('div.stack', {},
        h('div.card.pad', {},
          h('div.big', {}, doctor.name),
          h('div.muted', {}, `${dayLabel(slot.starts_at)} · ${hhmm(slot.starts_at)}`),
          h('div.dim.sm', {}, doctor.clinic_name)),

        // Expectation-setting BEFORE commitment. Maldivian clinics run token
        // queues, not strict appointment times; a patient who books "20:00"
        // believing it is a Western-style appointment will feel cheated at
        // 20:35 and will blame us, not the clinic.
        h('div.notice', {},
          'This clinic works by token order. Your slot is a starting estimate — we track the real queue and tell you when to leave.'),

        h('div.card.pad', {},
          h('label.field', {}, h('span', {}, 'Who is this for?'), forWhom),
          h('label.field', {}, h('span', {}, 'Where will you wait?'), waitLocation),
          h('div.dim.tiny', {}, 'We use this only to work out when to tell you to leave. No location tracking.')),

        h('div.card.pad.spread', {},
          h('span.muted', {}, 'Consultation fee'),
          h('strong.mono', {}, mvr(doctor.fee_minor))),

        h('button.btn.primary.lg.block', {
          onClick: async () => {
            await guard(async () => {
              const hold = await api('/api/patient/holds', {
                method: 'POST', body: { sessionId: session.session_id, slotIndex: slot.index },
              });
              const result = await api('/api/patient/bookings', {
                method: 'POST',
                body: {
                  holdId: hold.hold_id, patientId: state.patientId, forPatientId: forWhom.value,
                  waitLocation: waitLocation.value,
                  travelMinutes: waitLocation.value === 'clinic' ? 0 : waitLocation.value === 'nearby' ? 10 : 35,
                },
              });
              await refresh();
              state.track = null;
              go(trackerScreen(result.booking.id));
            }, 'Booked — we will tell you when to leave');
          },
        }, 'Confirm booking'),
        h('div.dim.tiny', { style: { textAlign: 'center' } }, 'Pay at the clinic, or by card/m-Faisaa from the confirmation.')),
    };
  };
}

function preferencesScreen() {
  const me = state.me.patient;
  const waitLocation = h('select.input', {},
    [['clinic', "At the clinic", 0], ['nearby', 'Nearby — about 10 min', 10], ['custom', 'Further — about 35 min', 35]]
      .map(([v, l]) => h('option', { value: v, selected: me.wait_location === v }, l)));
  const language = h('select.input', {}, [['dv', 'ދިވެހި Dhivehi'], ['en', 'English']]
    .map(([v, l]) => h('option', { value: v, selected: me.language === v }, l)));
  const prefs = me.notify_prefs || {};
  const toggles = ['push', 'viber', 'sms'].map((ch) => {
    const box = h('input', { type: 'checkbox', checked: prefs[ch] !== false });
    return { ch, box, node: h('label.row', { style: { padding: '6px 0' } }, box, h('span', {}, ch.toUpperCase())) };
  });

  return {
    bar: appbar('Settings', back),
    body: h('div.stack', {},
      h('div.card.pad', {},
        h('label.field', {}, h('span', {}, 'Where do you usually wait?'), waitLocation),
        h('label.field', {}, h('span', {}, 'Language'), language),
        h('div.dim.tiny', {}, 'Dhivehi copy is still being reviewed by a native speaker; untranslated text falls back to English rather than shipping wrong Dhivehi.')),
      h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Notifications'),
        toggles.map((t) => t.node),
        h('div.dim.tiny', { style: { marginTop: '6px' } },
          'You can mute marketing. Messages about an active token — "you are next", "you have been called" — always go through.')),
      h('button.btn.primary.block', {
        onClick: () => guard(async () => {
          const notifyPrefs = Object.fromEntries(toggles.map((t) => [t.ch, t.box.checked]));
          await api('/api/patient/preferences', {
            method: 'PUT',
            body: {
              patientId: state.patientId, notifyPrefs, language: language.value,
              waitLocation: waitLocation.value,
              travelMinutes: waitLocation.value === 'clinic' ? 0 : waitLocation.value === 'nearby' ? 10 : 35,
            },
          });
          await refresh();
          back();
        }, 'Saved'),
      }, 'Save'),
      h('div.card.pad', {},
        h('div.section-title', { style: { marginTop: 0 } }, 'Your data'),
        h('div.dim.tiny', {}, 'Export or delete everything, any time, without a support ticket.'),
        h('div.row', { style: { marginTop: '8px' } },
          h('button.btn.sm', { onClick: () => toast('Export prepared — check your email') }, 'Export my data'),
          h('button.btn.sm.danger', { onClick: () => toast('Deletion flow would start here') }, 'Delete my account'))),
      h('button.btn.block.ghost', { onClick: () => { localStorage.removeItem('vaguthu-patient'); location.reload(); } }, 'Switch demo persona'),
    ),
  };
}

// -------------------------------------------------------------------- boot
async function refresh() {
  const [me, bookings] = await Promise.all([
    api(`/api/patient/me?patientId=${state.patientId}`),
    api(`/api/patient/bookings?patientId=${state.patientId}`),
  ]);
  state.me = me;
  state.unread = me.unread;
  state.bookings = bookings;
  state.serverNow = bookings.serverNow;
  state.wallet = null;
}

function personaPicker(personas) {
  mount(document.getElementById('root'),
    h('div.phone', {},
      h('div.appbar', {}, h('div.mark', {}, 'V'), h('h1', {}, 'Vaguthu')),
      h('main.screen.stack', {},
        h('div.hero.card', { style: { padding: '22px 18px' } },
          h('h2', {}, 'Know your turn'),
          h('p', {}, 'See exactly which token the doctor is on, and get told when to leave.')),
        h('div.section-title', {}, 'Sign in'),
        h('button.btn.primary.lg.block', { onClick: () => toast('eFaas is an unverified assumption (A2) — using the demo personas below') }, 'Continue with eFaas'),
        h('div.dim.tiny', { style: { textAlign: 'center' } }, 'or pick a demo persona'),
        personas.map((p) => h('button.btn.block', {
          style: { textAlign: 'left', justifyContent: 'flex-start', padding: '14px' },
          onClick: () => {
            state.patientId = p.id;
            try { localStorage.setItem('vaguthu-patient', p.id); } catch { /* private mode */ }
            boot();
          },
        }, h('div', {}, h('div', { style: { fontWeight: 700 } }, p.name), h('div.dim.tiny', {}, p.blurb)))),
      ),
      h('div')));
}

async function boot() {
  if (!state.patientId) {
    try { state.patientId = localStorage.getItem('vaguthu-patient'); } catch { /* private mode */ }
  }
  if (!state.patientId) {
    const { personas } = await api('/api/patient/personas');
    return personaPicker(personas);
  }
  await refresh();

  socket?.close();
  socket = connect([`patient:${state.patientId}`], async (msg) => {
    if (msg.type === '_status') { state.connection = msg.status; render(); return; }
    if (msg.type === 'token_update') {
      if (state.track && msg.entry.tokenId === state.track.token.id) {
        await loadTrack(state.track.token.id);
      }
      render();
    }
    if (msg.type === 'message') {
      state.unread++;
      toast(msg.message.body);
      render();
    }
  });

  setInterval(async () => {
    try {
      await refresh();
      if (state.track) await loadTrack(state.track.token.id);
      render();
    } catch { /* offline; the tracker shows a staleness marker */ }
  }, 5000);
  render();
}

boot().catch((err) => {
  console.error(err);
  mount(document.getElementById('root'), h('div.empty', {}, err.message));
});
