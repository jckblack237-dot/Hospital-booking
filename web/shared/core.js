/** Tiny DOM + data layer. No framework: the board has to stay fast on an old tablet. */

// Enumerated attributes take the strings "true"/"false": a bare "" means false
// for draggable and never matches [aria-selected="true"]. Everything else that
// is `true` is a genuine boolean attribute (open, autofocus, required, …).
const ENUMERATED = new Set(['draggable', 'contenteditable', 'spellcheck']);
// Form state lives on the node, not in markup: setting the attribute only
// works before the user has touched the field.
const PROPERTIES = new Set(['value', 'checked', 'selected', 'disabled', 'indeterminate']);

export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    const enumerated = ENUMERATED.has(k) || k.startsWith('aria-');
    if (v === null || v === undefined) continue;
    if (v === false && !enumerated) continue;
    if (k === 'class') el.className = `${el.className} ${v}`.trim();
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (PROPERTIES.has(k)) el[k] = v;
    else if (enumerated) el.setAttribute(k, String(v));
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function mount(root, ...nodes) {
  root.replaceChildren(...nodes.flat(4).filter(Boolean));
  return root;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------- fetching
let authToken = null;
let onUnauthorized = null;
/** Bearer token sent with every api() call. The clinic app sets it after sign-in. */
export function setAuth(token) {
  authToken = token || null;
}
/** Called on every 401 so the shell signs the desk out in one place instead of per view. */
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

/** Every request reports here ('api' events): the shell uses it for the "Live" chip and to hush the socket after its own actions. */
export const bus = new EventTarget();

export class ApiError extends Error {
  constructor(message, { status = 0, problem = null, network = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
    this.code = problem?.code ?? (network ? 'network' : null);
    this.network = network;
  }
}

/**
 * api(path, options)
 *   options.body        → JSON
 *   options.signal      → AbortSignal
 *   options.idempotent  → an Idempotency-Key is minted on this options object and
 *                         reused when the same object is retried
 *   options.etag        → sent as If-None-Match; a 304 resolves null (or notModified with withMeta)
 *   options.withMeta    → resolve { data, status, etag, notModified } instead of data
 * Throws ApiError with .status / .problem / .code; status 0 + .network for a dead link.
 */
export async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = {
    ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    ...(options.etag ? { 'if-none-match': options.etag } : {}),
    ...(options.headers || {}),
  };
  if (options.idempotent) {
    options.idempotencyKey ||= uid();
    headers['idempotency-key'] = options.idempotencyKey;
  }
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      signal: options.signal,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError("Can't reach the clinic server", { network: true });
  }
  bus.dispatchEvent(new CustomEvent('api', { detail: { path, method, status: res.status, ok: res.ok || res.status === 304 } }));
  if (res.status === 304) return options.withMeta ? { data: null, status: 304, etag: options.etag, notModified: true } : null;
  if (res.status === 204) return options.withMeta ? { data: null, status: 204, etag: null } : null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const message = data?.detail || data?.title || (res.status >= 500 ? 'The clinic server had a problem' : `Request failed (${res.status})`);
    const err = new ApiError(message, { status: res.status, problem: data });
    if (res.status === 401) onUnauthorized?.(err);
    throw err;
  }
  return options.withMeta ? { data, status: res.status, etag: res.headers.get('etag') } : data;
}

// ------------------------------------------------------------------ realtime
export function connect(channels, onMessage, { pingMs = 0 } = {}) {
  let ws;
  let closed = false;
  let backoff = 500;
  let ping;
  const state = { status: 'connecting' };

  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      state.status = 'live';
      backoff = 500;
      ws.send(JSON.stringify({ type: 'subscribe', channels: typeof channels === 'function' ? channels() : channels }));
      onMessage({ type: '_status', status: 'live' });
      // A quiet socket is indistinguishable from a dead one; the pong is what keeps "Live" honest.
      if (pingMs) ping = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); }, pingMs);
    };
    ws.onmessage = (ev) => {
      try { onMessage(JSON.parse(ev.data)); } catch { /* ignore */ }
    };
    ws.onclose = () => {
      clearInterval(ping);
      state.status = 'offline';
      onMessage({ type: '_status', status: 'offline' });
      // Reconnect and reconcile: the shell re-fetches on reopen rather than
      // trusting whatever it held while disconnected.
      if (!closed) setTimeout(open, (backoff = Math.min(backoff * 1.8, 15000)));
    };
    ws.onerror = () => ws.close();
  };
  open();

  return {
    state,
    resubscribe(next) {
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'subscribe', channels: next }));
    },
    close() { closed = true; clearInterval(ping); ws?.close(); },
  };
}

// -------------------------------------------------------------------- format
const MV_OFFSET = 5 * 3600000;
export function hhmm(ms) {
  if (ms == null) return '—';
  const d = new Date(ms + MV_OFFSET);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
export function dayLabel(ms) {
  const d = new Date(ms + MV_OFFSET);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
export const mvr = (minor) => `MVR ${(Math.round(minor || 0) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
export const mins = (ms) => Math.round((ms || 0) / 60000);

export function relative(ms, nowMs) {
  const diff = Math.round((ms - nowMs) / 60000);
  if (Math.abs(diff) < 1) return 'now';
  if (diff > 0) return `in ${diff} min`;
  return `${-diff} min ago`;
}

export function age(dob) {
  if (!dob) return null;
  const then = new Date(dob);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((Date.now() - then.getTime()) / (365.25 * 86400000));
}

// -------------------------------------------------------------------- timing
/** Trailing debounce with .cancel() and .flush(). */
export function debounce(fn, ms) {
  let timer = null;
  let lastArgs = null;
  const run = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...lastArgs); }, ms);
  };
  run.cancel = () => { clearTimeout(timer); timer = null; };
  run.flush = () => { if (timer) { clearTimeout(timer); timer = null; fn(...lastArgs); } };
  return run;
}

/**
 * Sequence guard for async lookups: results that arrive out of order are dropped.
 *   const seq = latest();
 *   async function search(q) {
 *     const t = seq();
 *     const r = await api(url, { signal: t.signal });
 *     if (!t.current()) return;
 *   }
 * Each call aborts the previous in-flight request.
 */
export function latest() {
  let n = 0;
  let controller = null;
  return () => {
    controller?.abort();
    controller = new AbortController();
    const mine = ++n;
    return { current: () => mine === n, signal: controller.signal };
  };
}

/**
 * Lock a button for the life of a promise: disabled + aria-busy + a spinner in
 * place of the label. Held for at least 300 ms so a fast round-trip does not
 * flicker. Width is pinned so the row does not jump.
 */
export async function busy(button, promise, label) {
  if (!button || button.dataset.busy) return promise; // a second tap while busy is a no-op
  const prior = [...button.childNodes];
  const width = button.getBoundingClientRect().width;
  button.dataset.busy = '1';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (width) button.style.minWidth = `${Math.ceil(width)}px`;
  button.replaceChildren(h('span.spinner', { 'aria-hidden': true }), label ? h('span', {}, label) : null);
  const started = Date.now();
  try {
    return await promise;
  } finally {
    const wait = Math.max(0, 300 - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
    button.replaceChildren(...prior);
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.style.minWidth = '';
    delete button.dataset.busy;
  }
}

// --------------------------------------------------------------------- toast
let toastHost;
const TOAST_MS = { '': 2800, ok: 2800, err: 5000, warn: 4000 };
/**
 * toast(message, kind) or toast(message, { kind, action: { label, onClick }, duration }).
 * With an action the toast stays 8 s (an Undo window). Timers pause while hovered.
 */
export function toast(message, opts = {}) {
  const o = typeof opts === 'string' ? { kind: opts } : opts;
  const kind = o.kind || '';
  if (!toastHost) {
    toastHost = h('div.toast-host', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  let timer = null;
  let remaining = o.duration ?? (o.action ? 8000 : TOAST_MS[kind] ?? 2800);
  let startedAt = 0;
  let gone = false;

  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    el.classList.remove('show');
    const drop = () => el.remove();
    el.addEventListener('transitionend', drop, { once: true });
    setTimeout(drop, 220); // transitionend does not fire under reduced motion
  };
  const arm = () => { startedAt = Date.now(); timer = setTimeout(dismiss, remaining); };
  const hold = () => { clearTimeout(timer); remaining = Math.max(600, remaining - (Date.now() - startedAt)); };

  const el = h(`div.toast${kind ? `.${kind}` : ''}`, { onPointerenter: hold, onPointerleave: arm, onFocusin: hold, onFocusout: arm },
    h('span.msg', {}, message),
    o.action ? h('button.act', {
      type: 'button',
      onClick: () => { dismiss(); o.action.onClick?.(); },
    }, o.action.label) : null);

  // Never let toasts pile up over the page: at most three, oldest out first.
  while (toastHost.children.length >= 3) toastHost.firstChild.remove();
  toastHost.append(el);
  // Two frames so the entering transition starts from the pre-show state.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  arm();
  return { dismiss, el };
}

export async function guard(fn, okMessage) {
  try {
    const out = await fn();
    if (okMessage) toast(okMessage);
    return out;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    toast(err.message || 'Something went wrong', 'err');
    throw err;
  }
}

// ------------------------------------------------------------------- dialogs
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared <dialog> plumbing: centred, focus trapped, Escape and backdrop close,
 * and focus goes back to whatever opened it. Returns { dialog, close(result) };
 * `settle` receives the result on close.
 */
function openDialog({ title, body, actions = [], className = '', onSubmit, settle, initialFocus }) {
  const opener = document.activeElement;
  const openerKey = opener?.dataset?.focusKey;
  let closed = false;
  const id = `dlg-${uid()}`;

  const close = (result) => {
    if (closed) return;
    closed = true;
    dialog.classList.add('closing');
    const finish = () => {
      dialog.close();
      dialog.remove();
      // Re-query by key when the opener was re-rendered away in the meantime.
      const target = opener?.isConnected ? opener : (openerKey ? document.querySelector(`[data-focus-key="${CSS.escape(openerKey)}"]`) : null);
      if (target && target !== document.body) target.focus({ preventScroll: true });
      settle?.(result);
    };
    if (reducedMotion()) finish();
    else setTimeout(finish, 150);
  };

  const form = h('form.body', { id: `${id}-f`, onSubmit: (e) => { e.preventDefault(); onSubmit ? onSubmit(close) : close(true); } }, body);
  const dialog = h('dialog.modal', {
    class: className,
    'aria-labelledby': title ? `${id}-t` : null,
    onCancel: (e) => { e.preventDefault(); close(null); },
    onClick: (e) => { if (e.target === dialog) close(null); },
    onKeydown: (e) => {
      if (e.key !== 'Tab') return;
      const items = $$(FOCUSABLE, dialog).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    },
  },
  h('div.panel', {},
    title ? h('header', { id: `${id}-t` }, title) : null,
    form,
    actions.length ? h('footer', {}, actions.map((a) => h(`button.btn${a.primary ? '.primary' : ''}${a.danger ? '.danger' : ''}`, {
      type: a.submit ? 'submit' : 'button',
      form: a.submit ? `${id}-f` : null, // submit buttons sit outside the form but belong to it
      onClick: a.submit ? null : () => { const r = a.onClick?.(); if (r !== false) close(a.value ?? (a.primary ? true : null)); },
    }, a.label))) : null));

  document.body.append(dialog);
  dialog.showModal();
  const focusTarget = initialFocus || $$(FOCUSABLE, dialog).find((n) => n.closest('.body')) || $('footer .btn.primary', dialog) || $(FOCUSABLE, dialog);
  focusTarget?.focus();
  if (focusTarget?.select && !['number', 'checkbox', 'radio'].includes(focusTarget.type)) focusTarget.select();
  return { dialog, close };
}

/**
 * ask({ title, label, initial, type, hint, confirm, placeholder, multiline, validate })
 * → Promise<string | null>. Enter submits; Escape / backdrop / Cancel resolve null.
 * validate(value) returns an error string to block submission.
 */
export function ask({ title, label, initial = '', type = 'text', hint, confirm = 'OK', cancel = 'Cancel', placeholder, multiline = false, validate, inputmode, min, max } = {}) {
  return new Promise((resolve) => {
    const input = multiline
      ? h('textarea.input', { rows: 4, placeholder, value: initial })
      : h('input.input', { type, placeholder, value: initial, inputmode, min, max, autocomplete: 'off' });
    const error = h('div.field-error', { role: 'alert' });
    const field = h('label.field', {}, label ? h('span', {}, label) : null, input, hint ? h('div.help', {}, hint) : null, error);
    input.addEventListener('input', () => { error.textContent = ''; });
    const submit = (done) => {
      const value = input.value;
      const problem = validate?.(value);
      if (problem) { error.textContent = problem; input.focus(); return; }
      done(value);
    };
    let close;
    if (multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(close); } });
    ({ close } = openDialog({
      title,
      body: field,
      onSubmit: submit,
      actions: [{ label: cancel }, { label: confirm, primary: true, submit: true }],
      settle: (r) => resolve(typeof r === 'string' ? r : null),
      initialFocus: input,
    }));
  });
}

/** confirmDialog({ title, body, confirm, cancel, danger }) → Promise<boolean>. */
export function confirmDialog({ title, body, confirm = 'Confirm', cancel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    openDialog({
      title,
      body: typeof body === 'string' ? h('p.lede', {}, body) : body,
      actions: [{ label: cancel }, { label: confirm, primary: !danger, danger, submit: true }],
      settle: (r) => resolve(r === true),
    });
  });
}

/**
 * sheet({ title, body, actions: [{ label, onClick, primary }] }) for information
 * that must stay on screen until dismissed (one-time passwords, an audit log).
 * Returns a promise that resolves when closed; .close() closes it early.
 */
export function sheet({ title, body, actions, className = 'sheet' } = {}) {
  let closeFn;
  const p = new Promise((resolve) => {
    ({ close: closeFn } = openDialog({
      title,
      className,
      body: typeof body === 'string' ? h('p.lede', {}, body) : body,
      actions: actions?.length ? actions : [{ label: 'Done', primary: true }],
      settle: () => resolve(),
    }));
  });
  p.close = () => closeFn?.(null);
  return p;
}

// ----------------------------------------------------------------- patching
/**
 * Keyed list reconciler. Reuses children by data-key, moves them with FLIP,
 * fades new ones in and old ones out. A node that is still on screen is never
 * rebuilt, so scroll, focus and in-flight transitions survive.
 *
 *   patchList(list, tokens, {
 *     key: (t) => t.id,
 *     create: (t) => h('div.tok'),          // a shell is enough; update() fills it
 *     update: (node, t, isNew) => { … },    // called for every item, every time
 *     enter: (node) => {},                  // optional: replaces the default fade/scale in
 *     exit: (node) => Promise,              // optional: resolves when the node may be removed
 *   });
 */
export function patchList(container, items, { key, create, update, enter, exit }) {
  const reduce = reducedMotion();
  const byKey = new Map();
  for (const child of container.children) {
    if (child.dataset.key !== undefined) byKey.set(child.dataset.key, child);
  }
  const keys = items.map((item) => String(key(item)));
  const wanted = new Set(keys);

  // Measure before anything moves.
  const first = new Map();
  if (!reduce) for (const [k, node] of byKey) if (wanted.has(k)) first.set(k, node.getBoundingClientRect());

  const fresh = [];
  let cursor = container.firstElementChild;
  items.forEach((item, i) => {
    const k = keys[i];
    let node = byKey.get(k);
    const isNew = !node;
    if (isNew) {
      node = create(item);
      node.dataset.key = k;
      fresh.push(node);
    } else if (node.dataset.exiting) {
      // It was on its way out and came back: cancel the exit.
      delete node.dataset.exiting;
      node.style.transition = '';
      node.style.opacity = '';
      node.style.pointerEvents = '';
    }
    update?.(node, item, isNew);
    while (cursor && cursor.dataset.exiting) cursor = cursor.nextElementSibling;
    if (node !== cursor) container.insertBefore(node, cursor);
    else cursor = cursor.nextElementSibling;
  });

  // Whatever is left over leaves.
  for (const [k, node] of byKey) {
    if (wanted.has(k) || node.dataset.exiting) continue;
    node.dataset.exiting = '1';
    const gone = exit ? exit(node) : fadeOut(node);
    Promise.resolve(gone).then(() => { if (node.dataset.exiting) node.remove(); });
  }

  if (!reduce) {
    // FLIP the survivors that changed place; new nodes start small and clear.
    const moves = [];
    for (const [k, rect] of first) {
      const node = byKey.get(k);
      const now = node.getBoundingClientRect();
      const dx = rect.left - now.left;
      const dy = rect.top - now.top;
      if (Math.abs(dx) > .5 || Math.abs(dy) > .5) {
        node.style.transition = 'none';
        node.style.transform = `translate(${dx}px, ${dy}px)`;
        moves.push(node);
      }
    }
    for (const node of fresh) {
      if (enter) { enter(node); continue; }
      node.style.transition = 'none';
      node.style.opacity = '0';
      node.style.transform = 'scale(.97)';
    }
    if (moves.length || fresh.length) {
      void container.offsetWidth; // commit the start state before transitioning away from it
      for (const node of moves) {
        node.style.transition = 'transform 200ms cubic-bezier(.77,0,.175,1)';
        node.style.transform = '';
        clearAfter(node, 220);
      }
      for (const node of fresh) {
        if (enter) continue;
        node.style.transition = 'opacity 160ms cubic-bezier(.23,1,.32,1), transform 160ms cubic-bezier(.23,1,.32,1)';
        node.style.opacity = '';
        node.style.transform = '';
        clearAfter(node, 180);
      }
    }
  }
  return container;
}

function clearAfter(node, ms) {
  const done = () => { node.style.transition = ''; node.style.transform = ''; };
  node.addEventListener('transitionend', done, { once: true });
  setTimeout(done, ms);
}

function fadeOut(node) {
  if (reducedMotion()) return Promise.resolve();
  return new Promise((resolve) => {
    node.style.transition = 'opacity 120ms cubic-bezier(.23,1,.32,1)';
    node.style.opacity = '0';
    node.style.pointerEvents = 'none';
    node.addEventListener('transitionend', resolve, { once: true });
    setTimeout(resolve, 140);
  });
}

// ----------------------------------------------------------------- preserve
/**
 * A structural address for a node under `root` that survives a rebuild of the
 * same tree: keyed nodes (data-keep-scroll, data-key, data-token-id, id) anchor
 * the path; everything else is tag + class + position among same-tag siblings.
 */
function pathKey(el, root) {
  const parts = [];
  let node = el;
  while (node && node !== root && node !== document.body && node.nodeType === 1) {
    const ds = node.dataset || {};
    if (ds.keepScroll !== undefined) { parts.unshift(`[keep=${ds.keepScroll}]`); break; }
    if (ds.key !== undefined) { parts.unshift(`[key=${ds.key}]`); node = node.parentElement; continue; }
    if (ds.tokenId) { parts.unshift(`[token=${ds.tokenId}]`); node = node.parentElement; continue; }
    if (node.id) { parts.unshift(`#${node.id}`); break; }
    let i = 0;
    let sib = node;
    while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) i++;
    parts.unshift(`${node.tagName}.${node.className || ''}:${i}`);
    node = node.parentElement;
  }
  return parts.join('>');
}

function byPath(root, key) {
  if (key === '') return root;
  const walk = (scope, parts) => {
    if (!parts.length) return scope;
    const [head, ...rest] = parts;
    let next = null;
    if (head.startsWith('[keep=')) next = $(`[data-keep-scroll="${CSS.escape(head.slice(6, -1))}"]`, scope);
    else if (head.startsWith('[key=')) next = $(`[data-key="${CSS.escape(head.slice(5, -1))}"]`, scope);
    else if (head.startsWith('[token=')) next = $(`[data-token-id="${CSS.escape(head.slice(7, -1))}"]`, scope);
    else if (head.startsWith('#')) next = document.getElementById(head.slice(1));
    else {
      const at = head.lastIndexOf(':');
      const tagCls = head.slice(0, at);
      const idx = Number(head.slice(at + 1));
      const dot = tagCls.indexOf('.');
      const tag = tagCls.slice(0, dot);
      const cls = tagCls.slice(dot + 1);
      next = [...scope.children].filter((c) => c.tagName === tag && (c.className || '') === cls)[idx] ?? null;
    }
    return next ? walk(next, rest) : null;
  };
  return walk(root, key.split('>'));
}

/**
 * Run fn() and put the user back where they were: scroll positions of every
 * scrolled element (and every [data-keep-scroll]) under root, the focused
 * element with its caret, and which <details> were open.
 */
export function preserve(fn, { root = document.body } = {}) {
  const scrolls = [];
  for (const el of [root, ...$$('*', root)]) {
    if (el.scrollTop || el.scrollLeft || el.dataset?.keepScroll !== undefined) scrolls.push([pathKey(el, root), el.scrollTop, el.scrollLeft]);
  }
  const opened = $$('details[open]', root).map((d) => pathKey(d, root));
  const active = document.activeElement;
  const focus = active && active !== document.body && root.contains(active)
    ? { key: pathKey(active, root), start: active.selectionStart, end: active.selectionEnd, dir: active.selectionDirection }
    : null;

  const out = fn();

  for (const key of opened) { const d = byPath(root, key); if (d && !d.open) d.open = true; }
  for (const [key, top, left] of scrolls) {
    const el = byPath(root, key);
    if (!el) continue;
    if (top && el.scrollTop !== top) el.scrollTop = top;
    if (left && el.scrollLeft !== left) el.scrollLeft = left;
  }
  const stillFocused = document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected;
  if (focus && !stillFocused) {
    const el = byPath(root, focus.key);
    if (el) {
      el.focus({ preventScroll: true });
      if (focus.start != null && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(focus.start, focus.end, focus.dir || 'none'); } catch { /* not a text control */ }
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------- theme
export function initTheme() {
  const saved = localStorage.getItem('vaguthu-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  return {
    current() {
      return document.documentElement.dataset.theme
        || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    },
    toggle() {
      const next = this.current() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('vaguthu-theme', next); } catch { /* private mode */ }
      return next;
    },
  };
}

export const SPECIALTY_LABELS = {
  general_practice: 'General practice', internal_medicine: 'Internal medicine',
  paediatrics: 'Paediatrics', obgyn: 'Obstetrics & gynaecology', cardiology: 'Cardiology',
  dermatology: 'Dermatology', ent: 'ENT', ophthalmology: 'Ophthalmology',
  orthopaedics: 'Orthopaedics', dental: 'Dental', psychiatry: 'Psychiatry',
};
export const LANGUAGE_LABELS = { dv: 'Dhivehi', en: 'English', hi: 'Hindi/Urdu', ur: 'Hindi/Urdu', bn: 'Bengali', si: 'Sinhala', tl: 'Tagalog' };
export const SOURCE_LABELS = { walk_in: 'Walk-in', phone: 'Phone', app: 'App', partner: 'Partner' };
