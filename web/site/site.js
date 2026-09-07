/* The hero shows a real queue from the demo clinic, anonymised. If the
   server is not in demo mode the widget simply says so. */
const cols = document.getElementById('live-cols');
const title = document.getElementById('live-title');
const clock = document.getElementById('live-clock');
const dot = document.querySelector('.live-dot');

const STATE = { booked: 'waiting', arrived: 'here', called: 'called', penalised: 'moved back' };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function statusOf(s) {
  if (s.state === 'ended') return ['finished', ''];
  if (s.state === 'paused') return ['paused', 'warn'];
  if (s.state === 'running') return [s.lateMinutes > 5 ? `${s.lateMinutes} min late` : 'on time', s.lateMinutes > 15 ? 'danger' : s.lateMinutes > 5 ? 'warn' : 'ok'];
  return ['not started', ''];
}

async function refresh() {
  try {
    const r = await fetch('/api/public/showcase', { cache: 'no-store' });
    if (!r.ok) throw new Error('offline');
    const d = await r.json();
    title.textContent = d.live ? `${d.clinic} — live` : `${d.clinic} — before the evening session`;
    clock.textContent = d.clock;
    dot.classList.toggle('off', !d.live);
    cols.replaceChildren(...d.sessions.slice(0, 4).map((s) => {
      const col = el('div', 'live-col');
      const doc = el('div', 'doc'); doc.append(el('span', null, s.doctor), el('span', null, s.specialty)); col.append(doc);
      const [label, cls] = statusOf(s);
      const st = el('div', `st ${cls}`); st.append(el('i'), el('span', null, `${label} · ${s.waiting} waiting`)); col.append(st);
      if (s.nowServing) {
        const t = el('div', 'live-tok room'); t.append(el('span', 'mono', s.nowServing.display), el('span', null, 'in the room'), el('span', 'win mono', `${s.nowServing.minutes} min`)); col.append(t);
      }
      let leaveShown = false;
      for (const n of s.next.slice(0, s.nowServing ? 2 : 3)) {
        const t = el('div', `live-tok ${n.state}`);
        t.append(el('span', 'mono', n.display));
        const showLeave = n.leaveNow && n.state === 'booked' && !leaveShown;
        if (showLeave) { leaveShown = true; t.append(el('span', 'state go', 'leave now')); }
        else t.append(el('span', 'state', STATE[n.state] || n.state));
        t.append(el('span', 'win mono', n.window));
        col.append(t);
      }
      return col;
    }));
  } catch {
    title.textContent = 'Live queue unavailable right now';
    dot.classList.add('off');
  }
}
refresh();
setInterval(refresh, 5000);

// Demo request form.
const form = document.getElementById('lead');
const status = document.getElementById('lead-status');
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(form).entries());
  status.textContent = 'Sending…';
  try {
    const r = await fetch('/api/public/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error();
    form.reset();
    status.textContent = "Thanks — we'll be in touch within a working day.";
  } catch {
    status.textContent = "That didn't send. Try again, or email hello@vaguthu.mv.";
  }
});
