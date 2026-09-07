/* The home page is information about the business; the apps live in their own tabs. */

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
