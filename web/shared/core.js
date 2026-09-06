/** Tiny DOM + data layer. No framework: the board has to stay fast on an old tablet. */

export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = `${el.className} ${v}`.trim();
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
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

// ------------------------------------------------------------------- fetching
let authToken = null;
/** Bearer token sent with every api() call. The clinic app sets it after sign-in. */
export function setAuth(token) {
  authToken = token || null;
}

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.detail || data?.title || `Request failed (${res.status})`);
    err.problem = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------ realtime
export function connect(channels, onMessage) {
  let ws;
  let closed = false;
  let backoff = 500;
  const state = { status: 'connecting' };

  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      state.status = 'live';
      backoff = 500;
      ws.send(JSON.stringify({ type: 'subscribe', channels: typeof channels === 'function' ? channels() : channels }));
      onMessage({ type: '_status', status: 'live' });
    };
    ws.onmessage = (ev) => {
      try { onMessage(JSON.parse(ev.data)); } catch { /* ignore */ }
    };
    ws.onclose = () => {
      state.status = 'offline';
      onMessage({ type: '_status', status: 'offline' });
      // Reconnect and reconcile: the client always re-fetches state on reopen
      // rather than trusting whatever it held while disconnected.
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
    close() { closed = true; ws?.close(); },
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

// --------------------------------------------------------------------- toast
let toastHost;
export function toast(message, kind = '') {
  if (!toastHost) {
    toastHost = h('div.toast-host');
    document.body.append(toastHost);
  }
  const el = h(`div.toast${kind ? `.${kind}` : ''}`, {}, message);
  toastHost.append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 5000 : 2800);
}

export async function guard(fn, okMessage) {
  try {
    const out = await fn();
    if (okMessage) toast(okMessage);
    return out;
  } catch (err) {
    toast(err.message || 'Something went wrong', 'err');
    throw err;
  }
}

// --------------------------------------------------------------------- theme
export function initTheme() {
  const saved = localStorage.getItem('vaguthu-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  return {
    toggle() {
      const current = document.documentElement.dataset.theme
        || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = current === 'dark' ? 'light' : 'dark';
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
