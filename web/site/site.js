/* The home page is information about the business; the apps live in their own tabs. */

// ---------------------------------------------------------------- nav menu
// Below 900px the section links live behind the menu button. The panel is
// anchored to that button and leaves the way it arrived.
const navToggle = document.getElementById('nav-toggle');
const navLinks = document.getElementById('nav-links');
const mobile = window.matchMedia('(max-width: 900px)');

function setMenu(open) {
  if (!navToggle || !navLinks) return;
  navToggle.setAttribute('aria-expanded', String(open));
  navLinks.toggleAttribute('data-open', open);
}
function syncMenu() {
  // Above the breakpoint the links are always visible; clear the open flag so
  // the panel doesn't come back mid-open when the viewport shrinks again.
  if (mobile.matches) setMenu(navToggle.getAttribute('aria-expanded') === 'true');
  else { navToggle?.setAttribute('aria-expanded', 'false'); navLinks.removeAttribute('data-open'); }
}
navToggle?.addEventListener('click', () => setMenu(navToggle.getAttribute('aria-expanded') !== 'true'));
// Following a link, pressing Escape, or clicking away all close it.
navLinks?.addEventListener('click', (e) => { if (e.target.closest('a') && mobile.matches) setMenu(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && navToggle?.getAttribute('aria-expanded') === 'true') { setMenu(false); navToggle.focus(); }
});
document.addEventListener('click', (e) => {
  if (!mobile.matches) return;
  if (navToggle?.getAttribute('aria-expanded') !== 'true') return;
  if (!e.target.closest('.nav')) setMenu(false);
});
mobile.addEventListener('change', syncMenu);
syncMenu();

// ------------------------------------------------------------- scroll edge
// The sticky bar only draws a separating edge once content is under it.
const nav = document.querySelector('.nav');
if (nav) {
  const sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px;pointer-events:none';
  document.body.prepend(sentinel);
  new IntersectionObserver(
    ([entry]) => nav.classList.toggle('stuck', !entry.isIntersecting),
    { rootMargin: '0px' }
  ).observe(sentinel);
}

// ------------------------------------------------------------------- theme
// The stylesheet already honours [data-theme]; this gives people the switch.
const themeBtns = document.querySelectorAll('.js-theme');
const stored = (() => { try { return localStorage.getItem('vaguthu-theme'); } catch { return null; } })();
if (stored === 'light' || stored === 'dark') document.documentElement.dataset.theme = stored;
function currentTheme() {
  return document.documentElement.dataset.theme
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
// The dark artwork is declared with a prefers-color-scheme source, so it is
// correct without JS. When someone overrides the theme by hand, retarget those
// sources at the resolved theme instead of the system one.
function syncArtwork() {
  const dark = currentTheme() === 'dark';
  document.querySelectorAll('picture source[data-theme-src]').forEach(src => {
    src.media = dark ? 'all' : 'not all';
  });
}
function syncThemeBtn() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  themeBtns.forEach(btn => {
    btn.setAttribute('aria-label', `Switch to ${next} theme`);
    btn.setAttribute('title', `Switch to ${next} theme`);
  });
}
themeBtns.forEach(btn => btn.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('vaguthu-theme', next); } catch {}
  syncThemeBtn(); syncArtwork();
}));
syncThemeBtn(); syncArtwork();

// -------------------------------------------------------- demo request form
const form = document.getElementById('lead');
const status = document.getElementById('lead-status');
const submit = form?.querySelector('button[type="submit"]');
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(form).entries());
  status.textContent = 'Sending…';
  if (submit) { submit.disabled = true; submit.textContent = 'Sending…'; }
  try {
    const r = await fetch('/api/public/leads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error();
    form.reset();
    status.textContent = "Thanks — we'll be in touch within a working day.";
  } catch {
    status.textContent = "That didn't send. Try again, or email hello@vaguthu.mv.";
  } finally {
    if (submit) { submit.disabled = false; submit.textContent = 'Request a demo'; }
  }
});
