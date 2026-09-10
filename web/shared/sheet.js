/**
 * The sheet — one component for every secondary surface on the board: card
 * sheet, session sheet, done list, walk-in, confirmations and their sub-sheets.
 *
 *   openSheet({ title, subtitle, body, rows, footer, anchor, dismissible, instant, className, focusKey, onClose })
 *     → { el, body, close(result), push(spec), back(), setTitle(title, subtitle), setFooter(footer), isOpen }
 *
 * Bottom sheet on coarse pointers or below 1100 px; with an `anchor` on a fine
 * pointer at ≥1100 px the same node renders as a popover beside its trigger.
 * Role dialog, focus trapped and restored, Escape and scrim close, one open at
 * a time. Handle-drag to dismiss with the release velocity carried into a
 * spring; the sheet rides above the iPad keyboard via visualViewport.
 */
import { h, $$, reducedMotion } from '/shared/core.js';
import { spring, project, rubberband, releaseVelocity } from '/shared/spring.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DISMISS_V = 110;       // px/s: a flick is enough
const DISMISS_FRACTION = 0.4;
const SLOP = 8;

let current = null;
let seq = 0;

export const sheetOpen = () => !!current;
export const closeSheet = (result) => current?.close(result);

const coarse = () => matchMedia('(pointer: coarse)').matches || !matchMedia('(pointer: fine)').matches;
const visible = (n) => n.offsetParent !== null || n === document.activeElement;

/** A 40 px segmented control: [[value, label], …]. Instant, no animation (it is a form control). */
export function segmented({ options, value, onChange, label, className = '' }) {
  const el = h('div.seg', { role: 'radiogroup', 'aria-label': label, class: className });
  const set = (v) => {
    el.dataset.value = v;
    for (const b of el.children) b.setAttribute('aria-checked', String(b.dataset.value === v));
  };
  for (const [v, text] of options) {
    el.append(h('button.seg-item', { type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { value: v }, onClick: () => { set(v); onChange?.(v); } }, text));
  }
  set(value ?? options[0]?.[0]);
  el.value = () => el.dataset.value;
  el.set = set;
  return el;
}

/** Wrapping 44 px chips (one selected): the choice sheets use these instead of selects. */
export function chipRow({ options, value, onChange, label }) {
  const el = h('div.chip-row', { role: 'radiogroup', 'aria-label': label });
  const set = (v) => {
    el.dataset.value = v;
    for (const b of el.children) b.setAttribute('aria-checked', String(b.dataset.value === String(v)));
  };
  for (const [v, text] of options) {
    el.append(h('button.chip-opt', { type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { value: String(v) }, onClick: () => { set(String(v)); onChange?.(v); } }, text));
  }
  set(String(value ?? options[0]?.[0]));
  el.value = () => el.dataset.value;
  el.set = set;
  return el;
}

/** A 48 px sheet row: icon · label · hint. Destructive rows are `danger`; `keep` leaves the sheet open. */
export function sheetRow({ label, hint, icon, onClick, danger = false, disabled = false, keep = false, action }, close) {
  return h(`button.sheet-row${danger ? '.danger' : ''}`, {
    type: 'button', disabled, dataset: action ? { action } : null,
    onClick: (e) => { if (!keep) close?.(); onClick?.(e); },
  }, icon ? h('span.ic', { 'aria-hidden': true }, icon) : null, h('span.lbl', {}, label), hint ? h('span.hint', {}, hint) : null);
}

function footerButtons(footer, close) {
  return (footer || []).map((b) => {
    const btn = h(`button.btn.lg${b.primary ? '.primary' : b.ghost === false ? '' : '.ghost'}${b.danger ? '.danger' : ''}`, {
      type: b.submit ? 'submit' : 'button', form: b.form || null, disabled: !!b.disabled, dataset: b.action ? { action: b.action } : null,
      onClick: b.submit ? null : async (e) => {
        if (b.close !== false && !b.onClick) return close(b.value ?? (b.primary ? true : null));
        const r = await b.onClick?.(e);
        if (r !== false && b.close !== false) close(b.value ?? (b.primary ? true : null));
      },
    }, b.label);
    if (b.ref) b.ref(btn);
    return btn;
  });
}

export function openSheet(spec = {}) {
  const {
    title, subtitle, body, rows, footer, anchor = null, dismissible = true, instant = false, className = '',
    focusKey = null, onClose, initialFocus = null,
  } = spec;
  if (current) current.close(null, { instant: true });
  const id = `sheet-${++seq}`;
  const opener = document.activeElement;
  const pop = !!anchor && !coarse() && window.innerWidth >= 1100 && anchor.isConnected;
  const reduce = reducedMotion();
  let closed = false;
  const stack = [];

  const titleEl = h('h2.sheet-title', { id: `${id}-t` }, title || '');
  const subEl = h('p.sheet-sub', { hidden: !subtitle }, subtitle || '');
  const backBtn = h('button.sheet-back', { type: 'button', 'aria-label': 'Back', hidden: true, onClick: () => api.back() }, h('span', { 'aria-hidden': true }, '‹'));
  const xBtn = h('button.sheet-x', { type: 'button', 'aria-label': 'Close', onClick: () => api.close(null) }, h('span', { 'aria-hidden': true }, '×'));
  const head = h('header.sheet-head', {}, backBtn, h('div.titles', {}, titleEl, subEl), dismissible ? xBtn : null);
  const bodyEl = h('div.sheet-body');
  const footEl = h('footer.sheet-foot', { hidden: true });
  const panel = h('div.sheet', {
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-t`, class: className, tabindex: -1,
  }, pop ? null : h('i.grabber', { 'aria-hidden': true }), head, bodyEl, footEl);
  const scrim = h('div.sheet-scrim', { onClick: () => { if (dismissible) api.close(null); } });
  const wrap = h('div.sheet-wrap', { dataset: { mode: pop ? 'pop' : 'sheet', ...(instant || reduce ? { instant: '' } : {}) } }, scrim, panel);

  const fill = (s) => {
    titleEl.textContent = s.title || '';
    subEl.textContent = s.subtitle || '';
    subEl.hidden = !s.subtitle;
    const content = [];
    if (s.body) content.push(...[s.body].flat().filter(Boolean));
    if (s.rows?.length) content.push(h('div.sheet-rows', {}, s.rows.filter(Boolean).map((r) => (r instanceof Node ? r : sheetRow(r, () => api.close(null))))));
    bodyEl.replaceChildren(...content);
    bodyEl.scrollTop = 0;
    api.setFooter(s.footer);
  };

  const focusFirst = (prefer) => {
    const target = prefer || $$(FOCUSABLE, bodyEl).find(visible) || $$(FOCUSABLE, footEl).find(visible) || $$(FOCUSABLE, panel).find(visible) || panel;
    target.focus({ preventScroll: true });
    if (target.select && !['number', 'checkbox', 'radio'].includes(target.type)) target.select?.();
  };

  // ---- placement (popover) and keyboard riding (sheet)
  const place = () => {
    if (!pop) return;
    const r = anchor.getBoundingClientRect();
    const w = 320;
    const hgt = panel.offsetHeight;
    let left = r.right - w;
    let top = r.bottom + 6;
    let origin = 'top right';
    if (left < 8) { left = Math.max(8, r.left); origin = 'top left'; }
    if (left + w > window.innerWidth - 8) left = window.innerWidth - 8 - w;
    if (top + hgt > window.innerHeight - 8 && r.top - 6 - hgt >= 8) { top = r.top - 6 - hgt; origin = origin.replace('top', 'bottom'); }
    top = Math.max(8, Math.min(top, window.innerHeight - 8 - hgt));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.transformOrigin = origin;
  };
  const vv = window.visualViewport;
  const ride = () => {
    if (pop || !vv) return;
    const lift = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    panel.style.setProperty('--kb', `${lift}px`);
    const a = document.activeElement;
    if (lift && panel.contains(a) && a.matches?.('input, textarea, select')) a.scrollIntoView({ block: 'nearest' });
  };

  // ---- drag to dismiss (bottom sheets)
  let drag = null;
  let ret = null;           // the return/dismiss spring
  const H = () => panel.offsetHeight || 1;
  const currentY = () => { const m = new DOMMatrixReadOnly(getComputedStyle(panel).transform); return m.f || 0; };
  const setY = (y) => {
    panel.style.transform = `translateY(${y}px)`;
    scrim.style.opacity = String(Math.max(0, Math.min(1, 1 - Math.max(0, y) / H())));
  };
  const onDown = (e) => {
    if (pop || !dismissible || reduce) return;
    if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return; // one pointer only
    if (e.target.closest('button, a, input, textarea, select, [role="radio"]') && !e.target.closest('.sheet-head')) return;
    const onHandle = !!e.target.closest('.sheet-head, .grabber');
    const y0 = ret && !ret.done ? currentY() : 0;
    if (ret) { ret.cancel(); ret = null; panel.classList.remove('dismissing'); }
    drag = { id: e.pointerId, startY: e.clientY, y0, live: onHandle || y0 > 0, onHandle, samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }] };
    if (drag.live) { panel.setPointerCapture(e.pointerId); panel.classList.add('grabbed'); }
  };
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.startY;
    if (!drag.live) {
      // Not on the handle: only a downward pull from a scroller at the top takes the sheet.
      if (Math.abs(dy) < SLOP) return;
      if (dy < 0 || bodyEl.scrollTop > 0) { drag = null; return; }
      drag.live = true; drag.startY = e.clientY;
      panel.setPointerCapture(e.pointerId); panel.classList.add('grabbed');
      return;
    }
    const raw = drag.y0 + e.clientY - drag.startY;
    const y = raw >= 0 ? raw : rubberband(raw, H());
    drag.samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (drag.samples.length > 5) drag.samples.shift();
    setY(y);
  };
  const onUp = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    panel.classList.remove('grabbed');
    if (!d.live) return;
    const { vy } = releaseVelocity(d.samples);
    const y = currentY();
    const h = H();
    const dismiss = vy > DISMISS_V || y + project(vy) > DISMISS_FRACTION * h;
    const target = dismiss ? h + 20 : 0;
    if (dismiss) { closed = true; panel.classList.add('dismissing'); }
    ret = spring({ from: y, to: target, velocity: vy, onUpdate: setY, onSettle: () => { ret = null; if (dismiss) finish(null); else { panel.style.transform = ''; scrim.style.opacity = ''; } } });
  };
  panel.addEventListener('pointerdown', onDown);
  panel.addEventListener('pointermove', onMove);
  panel.addEventListener('pointerup', onUp);
  panel.addEventListener('pointercancel', onUp);
  // Press feedback the instant the finger lands (Safari delays :active on touch); cleared on up, cancel or leave.
  const PRESSABLE = '.sheet-row, .btn, .chip-opt, .sheet-x, .sheet-back, .sheet-radio';
  const unpress = () => { for (const el of wrap.querySelectorAll('[data-pressed]')) delete el.dataset.pressed; };
  wrap.addEventListener('pointerdown', (e) => { const p = e.target.closest(PRESSABLE); if (p && !p.disabled) p.dataset.pressed = ''; });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) wrap.addEventListener(ev, unpress);

  // ---- keyboard: trap Tab, Escape closes
  const onKey = (e) => {
    if (e.key === 'Escape') {
      if (!dismissible) return;
      e.preventDefault(); e.stopPropagation();
      if (stack.length) api.back(); else api.close(null);
      return;
    }
    if (e.key !== 'Tab') return;
    const items = $$(FOCUSABLE, panel).filter(visible);
    if (!items.length) { e.preventDefault(); panel.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  wrap.addEventListener('keydown', onKey);
  // Focus that escapes the sheet (a click on the inert page cannot, but scripts can) is pulled back.
  const onFocusIn = (e) => { if (!closed && !wrap.contains(e.target)) focusFirst(); };

  const finish = (result) => {
    wrap.remove();
    document.removeEventListener('focusin', onFocusIn);
    window.removeEventListener('resize', place);
    vv?.removeEventListener('resize', ride);
    vv?.removeEventListener('scroll', ride);
    if (current === api) { current = null; const root = document.getElementById('root'); if (root) root.inert = false; }
    // Back to the trigger, re-queried by key when the patcher has replaced the node (CP-23).
    const key = focusKey || opener?.dataset?.focusKey;
    const target = opener?.isConnected ? opener : (key ? document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`) : null);
    if (target && target !== document.body) target.focus({ preventScroll: true });
    onClose?.(result);
  };

  const api = {
    el: panel, wrap, body: bodyEl, scrim,
    get isOpen() { return !closed; },
    close(result = null, { instant: fast = false } = {}) {
      if (closed) return;
      closed = true;
      if (fast || instant || reduce) { finish(result); return; }
      ret?.cancel(); ret = null;
      wrap.classList.remove('is-open');
      let done = false;
      const end = () => { if (done) return; done = true; finish(result); };
      panel.addEventListener('transitionend', end, { once: true });
      setTimeout(end, pop ? 140 : 260);
    },
    setTitle(t, sub) { titleEl.textContent = t || ''; if (sub !== undefined) { subEl.textContent = sub || ''; subEl.hidden = !sub; } },
    setFooter(f) {
      if (!f || !f.length) { footEl.replaceChildren(); footEl.hidden = true; return; }
      footEl.replaceChildren(...footerButtons(f, api.close));
      footEl.hidden = false;
    },
    /** Sub-sheet: replaces the content in place; back() restores the parent. */
    push(sub) {
      stack.push({ title: titleEl.textContent, subtitle: subEl.hidden ? '' : subEl.textContent, body: [...bodyEl.childNodes], foot: [...footEl.childNodes], footHidden: footEl.hidden });
      fill(sub);
      backBtn.hidden = false;
      focusFirst(sub.initialFocus);
    },
    back() {
      const prev = stack.pop();
      if (!prev) return;
      titleEl.textContent = prev.title; subEl.textContent = prev.subtitle; subEl.hidden = !prev.subtitle;
      bodyEl.replaceChildren(...prev.body);
      footEl.replaceChildren(...prev.foot); footEl.hidden = prev.footHidden;
      backBtn.hidden = !stack.length;
      focusFirst();
    },
  };

  fill({ title, subtitle, body, rows, footer });
  current = api;
  const root = document.getElementById('root');
  if (root) root.inert = true;
  document.body.append(wrap);
  place();
  ride();
  void wrap.offsetWidth; // commit the start state, then let the transition carry it in
  wrap.classList.add('is-open');
  focusFirst(initialFocus);
  document.addEventListener('focusin', onFocusIn);
  window.addEventListener('resize', place);
  vv?.addEventListener('resize', ride);
  vv?.addEventListener('scroll', ride);
  return api;
}

/** confirmSheet({ title, body, confirm, cancel, danger }) → Promise<boolean>. The only surface that asks first (§10.3). */
export function confirmSheet({ title, body, confirm = 'Confirm', cancel = 'Cancel', danger = false, instant = false } = {}) {
  return new Promise((resolve) => {
    openSheet({
      title, instant, className: 'confirm',
      body: typeof body === 'string' ? h('p.sheet-lede', {}, body) : body,
      footer: [{ label: cancel, value: false }, { label: confirm, primary: true, danger, value: true }],
      onClose: (r) => resolve(r === true),
    });
  });
}
