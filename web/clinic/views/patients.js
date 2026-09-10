/**
 * Patients — find a person, see everything this clinic knows about them, fix
 * what was typed wrong at the desk.
 *
 * Built once per tab visit and patched in place: the search <input> is never
 * recreated (F03), results are a keyed list (F24/F12: rows truncate, nothing
 * widens the page), lookups are debounced and sequence-guarded (F30/F21), and
 * every fetch has a loading, empty and error state with Retry (CP-05).
 */
import {
  h, api, hhmm, dayLabel, mvr, toast, busy, sheet, debounce, latest, patchList, age,
  SPECIALTY_LABELS, LANGUAGE_LABELS, SOURCE_LABELS,
} from '/shared/core.js';
import { state } from '/clinic/app.js';

const LANGUAGES = ['dv', 'en', 'bn', 'hi', 'ta', 'si', 'ml'];
const LANG_LABEL = { ...LANGUAGE_LABELS, ta: 'Tamil', ml: 'Malayalam' };
const PAYER_LABEL = { aasandha: 'Aasandha', private: 'Private insurance', self: 'Self-paying', cash: 'Cash' };
const VISIT_STATE = {
  booked: ['Booked', ''], arrived: ['Arrived', 'ok'], called: ['Called', 'warn'], in_consult: ['In consult', 'brand'],
  completed: ['Seen', 'ok'], no_show: ['No-show', 'danger'], penalised: ['Penalised', 'danger'], cancelled: ['Cancelled', ''],
};
const MESSAGE_STATE = { delivered: ['Delivered', 'ok'], read: ['Read', 'ok'], sent: ['Sent', 'info'], failed: ['Failed', 'danger'] };
const INVOICE_STATE = { paid: ['Paid', 'ok'], open: ['Open', 'warn'], part_paid: ['Part paid', 'warn'], void: ['Void', ''] };
const CHANNEL_LABEL = { push: 'Push', sms: 'SMS', viber: 'Viber', whatsapp: 'WhatsApp', partner: 'Partner' };
const TEMPLATE_LABEL = {
  called: 'Called in', reminder: 'Reminder', delay: 'Running late', booked: 'Booking', arrived: 'Arrived',
  leave_now: 'Leave now', cancelled: 'Cancelled', no_show: 'Missed', penalty: 'Penalty', resumed: 'Resumed', paused: 'Paused',
};
const STACKED = matchMedia('(max-width: 1023px)');

// ------------------------------------------------------------- module state
let query = '';
let results = [];
let listStatus = 'idle';      // idle | loading | ok | error
let listError = null;
let selectedId = null;
let detail = null;            // GET /patients/:id payload for selectedId
let detailStatus = 'idle';
let detailError = null;
let listCollapsed = false;    // stacked layout: the list folds up once someone is chosen
let listFailed = false;       // toast once per outage, not per keystroke
let detailFailed = false;

let container = null;
let refs = null;
const searchSeq = latest();
const detailSeq = latest();
let selectionWatched = false;

/** Sign-out: nothing of the last clinic survives on a shared tablet (CP-02). */
export function reset() {
  query = ''; results = []; listStatus = 'idle'; listError = null;
  selectedId = null; detail = null; detailStatus = 'idle'; detailError = null;
  listCollapsed = false; listFailed = false; detailFailed = false;
  searchSeq(); detailSeq(); // abort anything in flight
  if (refs) refs.input.value = '';
}

// ----------------------------------------------------------------- helpers
// Names are Thaana as often as Latin (CP-10). Inside a sentence a name goes in
// <bdi dir=auto>; a box that truncates or clamps gets dir=auto itself, because
// dir=auto ignores <bdi> text when resolving, and the ellipsis must sit at the
// reading end. lang=dv lets tokens.css pick the Thaana face.
const THAANA = /[ހ-޿]/;
const langOf = (s) => (THAANA.test(s || '') ? 'dv' : null);
const name = (s) => h('bdi', { dir: 'auto', lang: langOf(s) }, s || '—');
function setName(el, s) {
  el.textContent = s || '—';
  el.setAttribute('dir', 'auto');
  if (langOf(s)) el.setAttribute('lang', 'dv'); else el.removeAttribute('lang');
}
const pill = (label, kind = '') => h(`span.pill${kind ? `.${kind}` : ''}`, {}, label);
const digitsOnly = (s) => (s || '').replace(/\D/g, '');
const when = (ms) => (ms ? `${dayLabel(ms)} ${hhmm(ms)}` : '—');
const waitOf = (v) => (v.arrived_at && v.started_at ? `${Math.max(0, Math.round((v.started_at - v.arrived_at) / 60000))} min` : '—');
const isAbort = (err) => err?.name === 'AbortError';
const still = () => {}; // patchList: results change under the keyboard, so no entrance and no exit animation
const gone = () => Promise.resolve();
const initial = (s) => ((s || '').trim()[0] || '?').toUpperCase();

function eligibilityPill(e, payer) {
  const who = PAYER_LABEL[payer] || payer || 'Payer';
  if (!e) return pill(`${who} · not checked`, 'warn');
  const kind = e.result === 'covered' ? 'ok' : e.result === 'not_covered' ? 'danger' : 'warn';
  const word = e.result === 'covered' ? 'Covered' : e.result === 'not_covered' ? 'Not covered' : 'Unverified';
  return pill(`${who} · ${word}`, kind);
}

/** A person's second line: phone, ID, island — whatever is known. */
function subline(p) {
  return [p.phone, p.national_id, p.travel_island ? `✈ ${p.travel_island}` : null].filter(Boolean).join(' · ');
}

// ------------------------------------------------------------------ search
async function runSearch() {
  const q = query;
  const t = searchSeq();
  listStatus = 'loading';
  drawListState();
  try {
    const data = await api(`/api/clinic/patients?q=${encodeURIComponent(q)}`, { signal: t.signal });
    if (!t.current()) return;
    results = data.patients || [];
    listStatus = 'ok';
    listError = null;
    listFailed = false;
  } catch (err) {
    if (isAbort(err) || !t.current()) return;
    if (err.status === 401) return; // the shell signs the desk out
    listStatus = 'error';
    listError = err;
    if (!listFailed) { listFailed = true; toast(err.message || 'Search failed', 'err'); }
  }
  drawList();
}
const searchSoon = debounce(runSearch, 220);

function onQuery(value) {
  query = value;
  // Typing must never lag: mark the list busy now, fetch in 220 ms.
  listStatus = 'loading';
  drawListState();
  searchSoon();
}

function drawListState() {
  if (!refs) return;
  const loading = listStatus === 'loading';
  refs.list.setAttribute('aria-busy', String(loading));
  refs.spinner.hidden = !loading || !results.length;
  refs.skeleton.hidden = !(loading && !results.length);
  refs.empty.hidden = !(listStatus === 'ok' && !results.length);
  refs.error.hidden = listStatus !== 'error';
  if (listStatus === 'error') refs.errorText.textContent = listError?.network ? "Can't reach the clinic server." : (listError?.message || 'Search failed.');
  refs.emptyText.textContent = query ? `No patients match “${query.length > 40 ? `${query.slice(0, 40)}…` : query}”` : 'No patients yet';
  refs.count.textContent = results.length ? `${results.length}${results.length === 25 ? '+' : ''} ${results.length === 1 ? 'person' : 'people'}` : '';
}

function drawList() {
  if (!refs) return;
  drawListState();
  patchList(refs.list, results, {
    key: (p) => p.id,
    // dir=auto on the truncating box itself, so the ellipsis lands at the reading end of a Thaana name.
    create: () => h('button.prow', { type: 'button', role: 'option', onClick: (e) => choose(e.currentTarget.dataset.key) },
      h('span.avatar', { 'aria-hidden': true }),
      h('span.txt', {}, h('span.nm.truncate', { dir: 'auto' }), h('span.sub.truncate'))),
    update: (node, p) => {
      const sub = subline(p) || 'No phone on file';
      setName(node.querySelector('.nm'), p.name);
      node.querySelector('.sub').textContent = sub;
      node.querySelector('.avatar').textContent = initial(p.name);
      node.setAttribute('aria-selected', String(p.id === selectedId));
      node.setAttribute('aria-label', `${(p.name || 'Unnamed patient').slice(0, 80)}, ${sub}`);
    },
    enter: still,
    exit: gone,
  });
  syncCollapse();
}

function choose(id) {
  open(id);
  if (STACKED.matches) { listCollapsed = true; syncCollapse(); }
}

// ------------------------------------------------------------------ detail
async function open(id, { silent = false } = {}) {
  if (!id || !refs) return;
  const changed = id !== selectedId;
  selectedId = id;
  if (state.selectedPatient !== id) state.selectedPatient = id;
  if (changed) { detail = null; detailError = null; }
  const t = detailSeq();
  detailStatus = 'loading';
  if (!silent) drawDetail();
  for (const row of refs.list.children) row.setAttribute('aria-selected', String(row.dataset.key === id));
  try {
    const data = await api(`/api/clinic/patients/${encodeURIComponent(id)}`, { signal: t.signal });
    if (!t.current()) return;
    detail = data;
    detailStatus = 'ok';
    detailError = null;
    detailFailed = false;
  } catch (err) {
    if (isAbort(err) || !t.current()) return;
    if (err.status === 401) return;
    detailStatus = 'error';
    detailError = err;
    if (!detailFailed) { detailFailed = true; toast(err.message || 'Could not open the patient', 'err'); }
  }
  drawDetail();
  if (changed && refs) { refs.detail.scrollTop = 0; refs.visitsScroll.scrollTop = 0; }
}

function drawDetail() {
  if (!refs) return;
  const r = refs;
  const loading = detailStatus === 'loading';
  r.detail.setAttribute('aria-busy', String(loading));
  r.dEmpty.hidden = !!selectedId;
  r.dSkeleton.hidden = !(selectedId && loading && !detail);
  r.dError.hidden = !(selectedId && detailStatus === 'error' && !detail);
  r.dBody.hidden = !(selectedId && detail);
  if (detailStatus === 'error') {
    r.dErrorText.textContent = detailError?.status === 404
      ? 'This patient is not on this clinic’s books.'
      : (detailError?.network ? "Can't reach the clinic server." : (detailError?.message || 'Could not open the patient.'));
  }
  if (!detail) return;

  const p = detail.patient;
  setName(r.name, p.name);
  const years = age(p.dob);
  r.meta.textContent = [p.phone || 'No phone', p.national_id, p.dob ? `${p.dob}${years != null ? ` (${years})` : ''}` : null].filter(Boolean).join(' · ');
  r.tags.replaceChildren(...[
    eligibilityPill(detail.eligibility, p.payer_type),
    pill(LANG_LABEL[p.language] || p.language || 'Language unknown'),
    p.travel_island ? pill(`✈ ${p.travel_island}${p.travel_atoll ? `, ${p.travel_atoll}` : ''}`, 'violet') : null,
    p.efaas_verified ? pill('eFaas verified', 'ok') : pill('Not eFaas-verified'),
    p.relation ? pill(`${p.relation} in a household`) : null,
  ].filter(Boolean)); // replaceChildren would print a null as text
  r.eligNote.textContent = detail.eligibility?.detail ? `${detail.eligibility.detail} · checked ${when(detail.eligibility.at)}` : 'Eligibility has not been checked yet.';

  const hh = detail.household || [];
  r.household.hidden = !hh.length;
  patchList(r.householdList, hh, {
    key: (m) => m.id,
    create: () => h('div.hrow', {},
      h('span.txt.grow', {}, h('span.nm.truncate', { dir: 'auto' }), h('span.sub.truncate')),
      h('button.btn.sm', { type: 'button', onClick: (e) => open(e.currentTarget.closest('.hrow').dataset.key) }, 'Open')),
    update: (node, m) => {
      setName(node.querySelector('.nm'), m.name);
      node.querySelector('.sub').textContent = [m.relation || 'dependant', m.phone].filter(Boolean).join(' · ');
    },
    enter: still, exit: gone,
  });

  const referrals = detail.referrals || [];
  r.referrals.hidden = !referrals.length;
  patchList(r.referralList, referrals, {
    key: (x) => x.id,
    create: () => h('div.rrow', {}, h('div.spread', {}, h('span.to'), h('span.st')), h('div.sub'), h('div.note')),
    update: (node, x) => {
      node.querySelector('.to').textContent = `→ ${SPECIALTY_LABELS[x.to_specialty] || x.to_specialty || 'Specialist'}`;
      const expired = x.expires_at && x.expires_at < (state.serverNow || Date.now()) && !x.used_token_id;
      node.querySelector('.st').replaceChildren(x.used_token_id ? pill('Used', 'ok') : expired ? pill('Expired', 'danger') : pill('Open', 'info'));
      node.querySelector('.sub').textContent = [x.from_doctor, dayLabel(x.issued_at), x.expires_at ? `valid to ${dayLabel(x.expires_at)}` : null].filter(Boolean).join(' · ');
      const note = node.querySelector('.note');
      setName(note, x.note);
      note.hidden = !x.note;
    },
    enter: still, exit: gone,
  });

  const visits = detail.visits || [];
  r.visitsEmpty.hidden = !!visits.length;
  r.visitsScroll.hidden = !visits.length;
  patchList(r.visitsBody, visits, {
    key: (v) => v.id,
    // .tkn, not .tok: the board owns .tok for its cards.
    create: () => h('tr', {}, h('td.when'), h('td.doc', { dir: 'auto' }), h('td.mono.tkn'), h('td.src'), h('td.mono.wait'), h('td.out')),
    update: (node, v) => {
      const [d, doc, tok, src, wait, out] = node.children;
      d.textContent = dayLabel(v.scheduled_start);
      setName(doc, v.doctor_name);
      tok.textContent = v.display || '—';
      src.textContent = SOURCE_LABELS[v.source] || v.source || '—';
      wait.textContent = waitOf(v);
      const [label, kind] = VISIT_STATE[v.state] || [v.state || '—', ''];
      out.replaceChildren(pill(label, kind));
    },
    enter: still, exit: gone,
  });

  const msgs = (detail.messages || []).slice(0, 30);
  r.msgEmpty.hidden = !!msgs.length;
  patchList(r.msgList, msgs, {
    key: (m) => m.id,
    create: () => h('div.mrow', {}, h('div.txt.grow', {}, h('div.body'), h('div.sub')), h('span.st')),
    update: (node, m) => {
      setName(node.querySelector('.body'), m.body);
      node.querySelector('.sub').textContent = [TEMPLATE_LABEL[m.template] || m.template, CHANNEL_LABEL[m.channel] || m.channel, when(m.at)].filter(Boolean).join(' · ');
      const [label, kind] = MESSAGE_STATE[m.state] || [m.state || '—', ''];
      node.querySelector('.st').replaceChildren(pill(label, kind));
    },
    enter: still, exit: gone,
  });

  const inv = (detail.invoices || []).slice(0, 12);
  r.invEmpty.hidden = !!inv.length;
  patchList(r.invList, inv, {
    key: (i) => i.id,
    create: () => h('div.irow', {}, h('span.txt.grow', {}, h('span.d'), h('span.sub')), h('span.mono.amt'), h('span.st')),
    update: (node, i) => {
      node.querySelector('.d').textContent = dayLabel(i.created_at);
      node.querySelector('.sub').textContent = [PAYER_LABEL[i.payer_type] || i.payer_type, i.patient_minor ? `patient pays ${mvr(i.patient_minor)}` : null].filter(Boolean).join(' · ');
      node.querySelector('.amt').textContent = mvr(i.total_minor);
      const [label, kind] = INVOICE_STATE[i.state] || [i.state || '—', ''];
      node.querySelector('.st').replaceChildren(pill(label, kind));
    },
    enter: still, exit: gone,
  });
}

async function recheck(button) {
  if (!detail) return;
  const id = detail.patient.id;
  try {
    await busy(button, api(`/api/clinic/patients/${encodeURIComponent(id)}/eligibility`, { method: 'POST' }), 'Checking…');
    toast('Eligibility re-checked');
    await open(id, { silent: true });
  } catch (err) {
    if (!isAbort(err)) toast(err.message || 'Could not check eligibility', 'err');
  }
}

// -------------------------------------------------------------------- edit
/** Edit name, phone, ID, date of birth and language. Optimistic; a 400 reverts and says why. */
async function edit(startFrom = null, badField = null, problem = '') {
  if (!detail) return;
  const p = detail.patient;
  const start = startFrom || { name: p.name || '', phone: p.phone || '', national_id: p.national_id || '', dob: p.dob || '', language: p.language || 'dv' };
  const inputs = {
    name: h('input.input', { value: start.name, maxlength: 120, autocomplete: 'off', dir: 'auto' }),
    phone: h('input.input', { value: start.phone, type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: '+960 7XX XXXX' }),
    national_id: h('input.input', { value: start.national_id, maxlength: 32, autocomplete: 'off', placeholder: 'A123456' }),
    dob: h('input.input', { value: start.dob, type: 'date', max: new Date().toISOString().slice(0, 10) }),
    language: h('select.input', {}, LANGUAGES.map((l) => h('option', { value: l, selected: l === start.language }, LANG_LABEL[l] || l))),
  };
  const errors = {};
  const field = (key, label) => {
    const input = inputs[key];
    errors[key] = h('div.field-error', { role: 'alert' }, key === badField ? problem : '');
    if (key === badField) input.setAttribute('aria-invalid', 'true');
    input.addEventListener('input', () => { errors[key].textContent = ''; input.removeAttribute('aria-invalid'); });
    return h('label.field', {}, h('span', {}, label), input, errors[key]);
  };
  const form = h('div.edit-patient', {},
    field('name', 'Name'),
    field('phone', 'Phone'),
    h('div.two', {}, field('national_id', 'National ID'), field('dob', 'Date of birth')),
    field('language', 'Preferred language'));
  const values = () => ({
    name: inputs.name.value.trim(), phone: inputs.phone.value.trim(), national_id: inputs.national_id.value.trim(),
    dob: inputs.dob.value.trim(), language: inputs.language.value,
  });
  const validate = (v) => {
    if (!v.name) return ['name', 'A name is needed.'];
    const d = digitsOnly(v.phone);
    if (v.phone && d.length !== 7 && (d.length < 8 || d.length > 15)) return ['phone', 'Use a 7-digit Maldivian number or a full international one.'];
    if (v.dob && !/^\d{4}-\d{2}-\d{2}$/.test(v.dob)) return ['dob', 'Use YYYY-MM-DD.'];
    return null;
  };
  let submitted = null;
  const trySave = () => {
    const v = values();
    const bad = validate(v);
    if (bad) {
      inputs[bad[0]].setAttribute('aria-invalid', 'true');
      errors[bad[0]].textContent = bad[1];
      inputs[bad[0]].focus();
      return false; // keeps the dialog open
    }
    submitted = v;
    return true;
  };
  // Enter in a field saves through the same validation as the button.
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName === 'SELECT') return;
    e.preventDefault();
    e.target.closest('dialog')?.querySelector('footer .btn.primary')?.click();
  });
  await sheet({ title: 'Edit details', className: 'edit-patient-dialog', body: form, actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: trySave }] });
  if (!submitted) return;

  const before = { name: p.name, phone: p.phone, national_id: p.national_id, dob: p.dob, language: p.language };
  const patch = {};
  for (const k of Object.keys(before)) if ((submitted[k] || '') !== (before[k] || '')) patch[k] = submitted[k] || null;
  if (patch.phone === null) delete patch.phone; // a blank phone is "leave it", not "remove it"
  if (!Object.keys(patch).length) return;

  const id = p.id;
  const apply = (fields) => {
    if (detail?.patient?.id !== id) return;
    Object.assign(detail.patient, fields);
    const row = results.find((x) => x.id === id);
    if (row) Object.assign(row, fields);
    drawDetail();
    drawList();
  };
  apply(patch); // optimistic: the desk sees the correction at once
  try {
    const out = await api(`/api/clinic/patients/${encodeURIComponent(id)}`, { method: 'PUT', body: patch });
    apply(out.patient); // the server's canonical shape (phone spacing)
    toast('Details saved');
  } catch (err) {
    if (isAbort(err)) return;
    apply(before);
    if (err.status === 401) return;
    toast(err.message || 'Could not save', {
      kind: 'err',
      action: err.status === 400 ? { label: 'Fix it', onClick: () => edit(submitted, err.problem?.field || null, err.message) } : null,
    });
  }
}

// ------------------------------------------------------------------ layout
/** Stacked (<1024): once someone is chosen the list folds to a one-line bar with a Show button. */
function syncCollapse() {
  if (!refs) return;
  const on = STACKED.matches && listCollapsed && !!selectedId && !!results.length;
  refs.aside.classList.toggle('collapsed', on);
  refs.listWrap.hidden = on;
  refs.foldBar.hidden = !on;
  refs.foldBtn.setAttribute('aria-expanded', String(!on));
  refs.foldText.textContent = `${results.length}${results.length === 25 ? '+' : ''} ${results.length === 1 ? 'match' : 'matches'}`;
}
function onLayoutChange() { if (!STACKED.matches) listCollapsed = false; syncCollapse(); }

// The palette and the board hand a patient over by setting state.selectedPatient
// and then setTab('patients'); when this tab is already showing, setTab is a
// no-op, so the field itself has to tell us. Restored to a plain value on unmount.
function watchSelection() {
  if (selectionWatched) return;
  let value = state.selectedPatient;
  Object.defineProperty(state, 'selectedPatient', {
    configurable: true, enumerable: true,
    get: () => value,
    set: (v) => { value = v; if (v && v !== selectedId && refs) open(v); },
  });
  selectionWatched = true;
}
function unwatchSelection() {
  if (!selectionWatched) return;
  const v = state.selectedPatient;
  Object.defineProperty(state, 'selectedPatient', { configurable: true, enumerable: true, writable: true, value: v });
  selectionWatched = false;
}

function onListKey(e) {
  const rows = [...refs.list.children];
  const i = rows.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' && i < rows.length - 1) { e.preventDefault(); rows[i + 1].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); (i > 0 ? rows[i - 1] : refs.input).focus(); }
}

// --------------------------------------------------------------- lifecycle
export function mount(el) {
  container = el;
  const r = {};
  r.input = h('input.input', {
    id: 'patients-q', type: 'text', value: query, placeholder: 'Name, phone or national ID',
    autocomplete: 'off', autocapitalize: 'none', spellcheck: false, enterkeyhint: 'search', 'aria-controls': 'patients-results',
    onInput: (e) => onQuery(e.target.value),
    onKeydown: (e) => {
      if (e.key === 'ArrowDown' && refs.list.firstElementChild) { e.preventDefault(); refs.list.firstElementChild.focus(); }
      else if (e.key === 'Escape' && e.target.value) { e.stopPropagation(); e.target.value = ''; onQuery(''); }
      else if (e.key === 'Enter') searchSoon.flush();
    },
  });
  r.spinner = h('span.spinner', { hidden: true, 'aria-hidden': true });
  r.count = h('span.count.sm.dim', { 'aria-live': 'polite' });
  r.list = h('div.plist-rows', { id: 'patients-results', role: 'listbox', 'aria-label': 'Patients', onKeydown: onListKey });
  r.skeleton = h('div.skel', { hidden: true, 'aria-hidden': true }, [1, 2, 3, 4, 5].map(() => h('div.skel-row', {}, h('span.a'), h('span.bars', {}, h('i'), h('i')))));
  r.emptyText = h('div.t');
  r.empty = h('div.state', { hidden: true }, r.emptyText, h('div.help', {}, 'Try fewer letters, or the phone number without spaces.'));
  r.errorText = h('div.t');
  r.error = h('div.state.fail', { hidden: true, role: 'alert' }, r.errorText, h('button.btn', { type: 'button', onClick: () => runSearch() }, 'Retry'));
  r.listWrap = h('div.plist-body', {}, r.skeleton, r.list, r.empty, r.error);
  r.foldText = h('span.sm.dim');
  r.foldBtn = h('button.btn.sm.ghost', { type: 'button', 'aria-expanded': 'true', 'aria-controls': 'patients-results', onClick: () => { listCollapsed = false; syncCollapse(); } }, 'Show list');
  r.foldBar = h('div.fold', { hidden: true }, r.foldText, r.foldBtn);
  r.aside = h('aside.plist.card', { 'aria-label': 'Find a patient' },
    h('div.search', {}, h('label.vh', { for: 'patients-q' }, 'Search patients'), r.input, r.spinner),
    h('div.plist-head', {}, r.count),
    r.foldBar,
    r.listWrap);

  // Detail panel: one set of sections, filled in place so scroll and focus survive.
  r.name = h('h2.pname', { dir: 'auto' });
  r.meta = h('div.pmeta.mono');
  r.tags = h('div.row.wrap.tags');
  r.eligNote = h('div.help');
  r.editBtn = h('button.btn', { type: 'button', 'data-focus-key': 'patient-edit', onClick: () => edit() }, 'Edit');
  r.recheckBtn = h('button.btn', { type: 'button', onClick: (e) => recheck(e.currentTarget) }, 'Re-check eligibility');
  r.householdList = h('div.hlist');
  r.household = h('section.card.pad', { hidden: true }, h('h3.section-title', {}, 'Household'), r.householdList);
  r.referralList = h('div.rlist');
  r.referrals = h('section.card.pad', { hidden: true }, h('h3.section-title', {}, 'Referrals'), r.referralList);
  r.visitsBody = h('tbody');
  r.visitsScroll = h('div.visits-scroll', { 'data-keep-scroll': 'patient-visits', tabindex: 0, 'aria-label': 'Visit history' },
    h('table.data', {},
      h('thead', {}, h('tr', {}, ['Date', 'Doctor', 'Token', 'Source', 'Wait', 'Outcome'].map((c) => h('th', { scope: 'col' }, c)))),
      r.visitsBody));
  r.visitsEmpty = h('div.dim.sm', { hidden: true }, 'No visits at this clinic yet.');
  r.msgList = h('div.mlist');
  r.msgEmpty = h('div.dim.sm', { hidden: true }, 'No messages sent yet.');
  r.invList = h('div.ilist');
  r.invEmpty = h('div.dim.sm', { hidden: true }, 'No invoices.');
  r.dBody = h('div.stack.detail-body', { hidden: true },
    h('section.card.pad.phead', {},
      h('div.spread.top', {},
        h('div.grow.min0', {}, r.name, r.meta),
        h('div.row.actions', {}, r.editBtn, r.recheckBtn)),
      r.tags,
      r.eligNote),
    r.household,
    r.referrals,
    h('section.card.pad', {}, h('h3.section-title', {}, 'Visit history'), r.visitsEmpty, r.visitsScroll),
    h('section.card.pad', {}, h('h3.section-title', {}, 'Message ledger'), h('div.help', {}, '“I never got a message” — answered here.'), r.msgEmpty, r.msgList),
    h('section.card.pad', {}, h('h3.section-title', {}, 'Invoices'), r.invEmpty, r.invList));
  r.dEmpty = h('div.state.pick', {}, h('div.t', {}, 'Pick a patient'), h('div.help', {}, 'Search on the left, or press ⌘K anywhere.'));
  r.dSkeleton = h('div.skel.detail', { hidden: true, 'aria-hidden': true },
    h('div.card.pad', {}, h('i.w60'), h('i.w40.thin')),
    h('div.card.pad', {}, h('i.w30.thin'), h('i'), h('i'), h('i.w80')));
  r.dErrorText = h('div.t');
  r.dError = h('div.state.fail', { hidden: true, role: 'alert' }, r.dErrorText, h('button.btn', { type: 'button', onClick: () => open(selectedId) }, 'Retry'));
  r.detail = h('section.pdetail', { 'aria-label': 'Patient record', 'data-keep-scroll': 'patient-detail' }, r.dEmpty, r.dSkeleton, r.dError, r.dBody);

  refs = r;
  container.replaceChildren(h('div.patients', {}, r.aside, r.detail));
  STACKED.addEventListener('change', onLayoutChange);
  watchSelection();

  drawList();
  drawDetail();
  // Fresh results every visit (LIVE F12): the last list stays on screen, marked busy, until they land.
  runSearch();
  const wanted = state.selectedPatient;
  if (wanted) open(wanted);
  else if (!STACKED.matches) requestAnimationFrame(() => { if (refs && document.activeElement === document.body) refs.input.focus({ preventScroll: true }); });
}

export function update(reason) {
  if (!refs) return;
  if (reason === 'render' && state.selectedPatient && state.selectedPatient !== selectedId) open(state.selectedPatient);
}

export function unmount() {
  searchSoon.cancel();
  searchSeq(); detailSeq();
  STACKED.removeEventListener('change', onLayoutChange);
  unwatchSelection();
  container?.replaceChildren();
  container = null;
  refs = null;
  listStatus = results.length ? 'ok' : 'idle';
  detailStatus = detail ? 'ok' : 'idle';
}
