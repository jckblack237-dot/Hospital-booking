/**
 * Messaging Orchestrator — channel cascade and the message ledger.
 *
 * Push -> Viber -> SMS, never two at once. Duplicate notifications are how a
 * patient learns to ignore all of them.
 *
 * Delivery here is SIMULATED: there is no Viber BSP or telco aggregator wired
 * up (assumptions A4 / market context section 4). The cascade logic, the
 * ledger, the costing and the wallet are real; only the transport is stubbed,
 * behind `dispatch()` so a provider drops in without touching callers.
 */
import { db } from '../db.js';
import { now } from '../lib/clock.js';
import { id, parse } from '../lib/util.js';
import { hhmm } from '../lib/mvtime.js';

export const CHANNEL_COST_MINOR = { push: 0, viber: 25, sms: 65 }; // laari

/** Body builders. English is complete; see i18n.js on Dhivehi copy status. */
const TEMPLATES = {
  token_confirmed: (v) => `Booked: ${v.doctor}, ${v.when}. You'll get your token when the session opens.`,
  session_open: (v) => `Session started. You are token ${v.token}, ${v.ahead} ahead of you. Likely ${v.window}.`,
  position: (v) => `${v.ahead} ${v.ahead === 1 ? 'person' : 'people'} ahead of you. Likely ${v.window}.`,
  leave_now: (v) => `Leave now — about ${v.ahead} ahead of you. You'll be seen around ${v.window}.`,
  next: () => `You're next. Please check in at reception.`,
  called: (v) => `${v.doctor} is ready for you now. Please come to reception.`,
  eta_changed: (v) => `Running about ${v.deltaMinutes} min later — ${v.reasonText}. New estimate ${v.window}.`,
  improved: (v) => `Moving faster than expected — you're up around ${v.window}, about ${v.deltaMinutes} min earlier.`,
  paused: (v) => `The queue is paused (${v.kind}). Expected to resume around ${v.resume}. We'll tell you when it restarts.`,
  delayed: (v) => `${v.doctor} is starting around ${v.newStart} instead of ${v.oldStart}. Your new estimate: ${v.window}.`,
  penalised: (v) => `You were called at ${v.calledAt} and we couldn't find you. You've moved back ${v.positions} — new estimate ${v.window}.`,
  at_risk: (v) => `There's a chance ${v.doctor} won't reach your token today. You can keep waiting, rebook, or cancel for a full refund.`,
  session_cancelled: (v) => `${v.doctor}'s session on ${v.when} has been cancelled. Tap to rebook — any payment is refunded automatically.`,
  no_show: (v) => `You were marked as not attending for token ${v.token}. Tap to rebook.`,
  travel_confirm: (v) => `Your appointment tomorrow at ${v.when} is on. We'll message you if anything changes.`,
  visit_complete: (v) => `Visit complete. Invoice MVR ${v.total} · ${v.payer} covered MVR ${v.covered} · You paid MVR ${v.paid}.`,
  claim_rejected: (v) => `Your ${v.payer} claim was rejected (${v.reason}). Amount now due: MVR ${v.amount}. The clinic can resubmit — tap to request a review.`,
  broadcast: (v) => v.text,
};

export const REASON_TEXT = {
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

const insert = db.prepare(`
  INSERT INTO messages (id, clinic_id, patient_id, token_id, template, channel, body, state, cost_minor, at, urgent)
  VALUES (@id, @clinicId, @patientId, @tokenId, @template, @channel, @body, @state, @cost, @at, @urgent)
`);

const listeners = new Set();
export function onMessage(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Transport stub. Returns whether the channel accepted the message.
 * Push is unreliable in the real world (stale tokens, permissions revoked),
 * which is exactly why the cascade exists — so the simulation reflects that.
 */
function dispatch(channel, patient) {
  const prefs = parse(patient.notify_prefs, {}) || {};
  if (prefs[channel] === false) return false;
  if (channel === 'push') return patient.efaas_verified ? Math.random() > 0.12 : false;
  if (channel === 'viber') return Math.random() > 0.06;
  return true; // SMS is the reliability floor: any handset, no data
}

function walletBalance(clinicId) {
  const row = db.prepare('SELECT settings FROM clinics WHERE id = ?').get(clinicId);
  return (parse(row?.settings, {}) || {}).messagingWalletMinor ?? 0;
}

function chargeWallet(clinicId, amount) {
  const row = db.prepare('SELECT settings FROM clinics WHERE id = ?').get(clinicId);
  const settings = parse(row?.settings, {}) || {};
  settings.messagingWalletMinor = (settings.messagingWalletMinor ?? 0) - amount;
  db.prepare('UPDATE clinics SET settings = ? WHERE id = ?').run(JSON.stringify(settings), clinicId);
  return settings.messagingWalletMinor;
}

/**
 * Send one notification down the cascade.
 * @returns {null | object} the ledger row that was actually delivered
 */
export function send({ patient, clinicId, tokenId = null, template, vars = {}, urgent = false, marketing = false }) {
  const builder = TEMPLATES[template];
  if (!builder) throw new Error(`unknown template: ${template}`);
  const body = builder(vars);
  const at = now();

  // Transactional queue messages continue on a small overdraft buffer;
  // marketing stops immediately. Running out of credit must never stop a
  // patient being told their turn has come.
  const balance = walletBalance(clinicId);
  if (marketing && balance <= 0) return null;
  if (!marketing && balance < -5000) return null;

  const order = urgent ? ['push', 'viber', 'sms'] : ['push', 'viber', 'sms'];
  let delivered = null;
  for (const channel of order) {
    const ok = dispatch(channel, patient);
    const cost = CHANNEL_COST_MINOR[channel];
    const row = {
      id: id('msg'), clinicId, patientId: patient.id, tokenId, template, channel, body,
      state: ok ? 'delivered' : 'failed', cost: ok ? cost : 0, at, urgent: urgent ? 1 : 0,
    };
    insert.run(row);
    if (ok) {
      if (cost) chargeWallet(clinicId, cost);
      delivered = row;
      break;
    }
  }

  // `called` and `penalised` are high stakes: the consequence of non-delivery
  // is a forfeited turn, so SMS goes regardless of what already succeeded.
  if (delivered && delivered.channel !== 'sms' && (template === 'called' || template === 'penalised')) {
    const row = {
      id: id('msg'), clinicId, patientId: patient.id, tokenId, template, channel: 'sms', body,
      state: 'delivered', cost: CHANNEL_COST_MINOR.sms, at, urgent: 1,
    };
    insert.run(row);
    chargeWallet(clinicId, CHANNEL_COST_MINOR.sms);
  }

  if (delivered) for (const fn of listeners) fn({ ...delivered, patient });
  return delivered;
}

export function broadcast({ sessionId, text, clinicId }) {
  const rows = db
    .prepare(`SELECT t.id AS token_id, p.* FROM tokens t JOIN patients p ON p.id = t.patient_id
              WHERE t.session_id = ? AND t.state IN ('booked','arrived','called','penalised')`)
    .all(sessionId);
  let sent = 0;
  for (const patient of rows) {
    const r = send({ patient, clinicId, tokenId: patient.token_id, template: 'broadcast', vars: { text }, urgent: true });
    if (r) sent++;
  }
  return { recipients: rows.length, sent };
}

/** Cost preview shown before a broadcast is confirmed. Cost control is a feature. */
export function estimateBroadcast(sessionId) {
  const n = db
    .prepare("SELECT COUNT(*) AS c FROM tokens WHERE session_id = ? AND state IN ('booked','arrived','called','penalised')")
    .get(sessionId).c;
  return { recipients: n, estimatedCostMinor: n * CHANNEL_COST_MINOR.viber };
}

export function ledgerForPatient(patientId, limit = 50) {
  return db.prepare('SELECT * FROM messages WHERE patient_id = ? ORDER BY at DESC LIMIT ?').all(patientId, limit);
}

export function ledgerForClinic(clinicId, limit = 200) {
  return db
    .prepare(`SELECT m.*, p.name AS patient_name FROM messages m LEFT JOIN patients p ON p.id = m.patient_id
              WHERE m.clinic_id = ? ORDER BY m.at DESC LIMIT ?`)
    .all(clinicId, limit);
}

export function windowText(entry) {
  return `${hhmm(entry.predictedStart.window.from)}–${hhmm(entry.predictedStart.window.to)}`;
}

export { TEMPLATES };
