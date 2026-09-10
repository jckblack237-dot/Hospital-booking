/**
 * Billing & Insurance.
 *
 * Every charge resolves against a PayerAdapter. Split billing — partly covered
 * by Aasandha with a self-pay balance — is the NORMAL transaction here, not an
 * edge case, so the model treats it that way.
 *
 * IMPORTANT: no external payer or payment API is wired up. Aasandha (A1), BML
 * and m-Faisaa (A3) are unverified assumptions; see docs/01-market-context.md.
 * The adapters below implement the full clinic-side workflow — eligibility,
 * claim construction, submission, rejection worklist, reconciliation — with a
 * simulated counterparty. `AasandhaAdapter` ships in `degraded` mode by
 * default, which is the path we control and the one specified as P0.
 */
import { db } from '../db.js';
import { now } from '../lib/clock.js';
import { id, parse, HttpError } from '../lib/util.js';

export const GST_RATE = 0.08; // GGST. Medical services are exempt; non-medical lines are not.

/** Rejection reasons seen in practice, used by the worklist and its analytics. */
const REJECTION_REASONS = [
  { code: 'ELG-02', text: 'Member not eligible on date of service' },
  { code: 'SVC-11', text: 'Service not covered under scheme' },
  { code: 'DOC-04', text: 'Supporting documentation missing' },
  { code: 'CDE-07', text: 'Service code / diagnosis mismatch' },
  { code: 'LMT-01', text: 'Annual limit exhausted' },
];

class PayerAdapter {
  constructor(name) { this.name = name; }
  // eslint-disable-next-line no-unused-vars
  checkEligibility(patient) { return { result: 'unverified', detail: 'Not implemented' }; }
  coverage(_patient, lines) { return { coveredMinor: 0, lines }; }
  submitClaim() { return { state: 'submitted', mode: 'manual' }; }
}

class SelfPayAdapter extends PayerAdapter {
  constructor() { super('self_pay'); }
  checkEligibility() { return { result: 'covered', detail: 'Self-pay' }; }
  coverage(_p, lines) { return { coveredMinor: 0, lines }; }
}

class AasandhaAdapter extends PayerAdapter {
  /**
   * @param {'api'|'degraded'} mode - `degraded` produces submission-ready claim
   *   batches and tracks status by manual entry. It keeps ~80% of the value with
   *   ~0% of the integration risk, and it is what ships first.
   */
  constructor(mode = 'degraded') { super('aasandha'); this.mode = mode; }

  checkEligibility(patient) {
    // The scheme covers Maldivian citizens. Without a national ID we cannot
    // even ask — and a technical failure must never be reported as "not covered".
    if (!patient.national_id) return { result: 'unverified', detail: 'No national ID on file' };
    if (patient.payer_type !== 'aasandha') return { result: 'not_covered', detail: 'Patient is not on the scheme' };
    if (Math.random() < 0.07) return { result: 'unverified', detail: 'Scheme did not respond — check again or convert to self-pay' };
    return { result: 'covered', detail: 'Eligible on date of service' };
  }

  coverage(patient, lines) {
    let covered = 0;
    const out = lines.map((l) => {
      const eligible = l.category === 'consultation' || l.category === 'procedure';
      const amount = eligible ? Math.min(l.amountMinor, l.schemeCapMinor ?? l.amountMinor) : 0;
      covered += amount;
      return { ...l, coveredMinor: amount };
    });
    return { coveredMinor: covered, lines: out };
  }

  submitClaim(claim) {
    if (this.mode === 'degraded') {
      return { state: 'submitted', mode: 'manual', batch: `AAS-${new Date(now()).toISOString().slice(0, 10)}` };
    }
    return { state: 'submitted', mode: 'api' };
  }
}

class PrivateInsurerAdapter extends PayerAdapter {
  constructor() { super('private'); }
  checkEligibility(patient) {
    if (!patient.policy_no) return { result: 'unverified', detail: 'No policy number on file' };
    return { result: 'covered', detail: `Policy ${patient.policy_no} active` };
  }
  coverage(_p, lines) {
    let covered = 0;
    const out = lines.map((l) => {
      const amount = l.category === 'consultation' ? Math.round(l.amountMinor * 0.8) : 0;
      covered += amount;
      return { ...l, coveredMinor: amount };
    });
    return { coveredMinor: covered, lines: out };
  }
}

class CorporateAdapter extends PayerAdapter {
  constructor() { super('corporate'); }
  checkEligibility() { return { result: 'covered', detail: 'Corporate account — billed monthly' }; }
  coverage(_p, lines) {
    const covered = lines.reduce((s, l) => s + l.amountMinor, 0);
    return { coveredMinor: covered, lines: lines.map((l) => ({ ...l, coveredMinor: l.amountMinor })) };
  }
}

const adapters = {
  aasandha: new AasandhaAdapter(process.env.AASANDHA_MODE === 'api' ? 'api' : 'degraded'),
  private: new PrivateInsurerAdapter(),
  corporate: new CorporateAdapter(),
  self_pay: new SelfPayAdapter(),
};

export function adapterFor(payerType) {
  return adapters[payerType] || adapters.self_pay;
}

export function checkEligibility(patientId) {
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
  if (!patient) return null;
  const adapter = adapterFor(patient.payer_type);
  const res = adapter.checkEligibility(patient);
  db.prepare('INSERT INTO eligibility_checks (id, patient_id, payer, result, detail, at) VALUES (?,?,?,?,?,?)')
    .run(id('elg'), patientId, patient.payer_type, res.result, res.detail, now());
  return { payer: patient.payer_type, ...res };
}

export function latestEligibility(patientId) {
  return db.prepare('SELECT * FROM eligibility_checks WHERE patient_id = ? ORDER BY at DESC LIMIT 1').get(patientId);
}

/**
 * Build an invoice from a completed token. Medical services are GST-exempt;
 * certificates, reports and supplies are not, and the split has to be right on
 * the tax invoice.
 */
export function invoiceForToken(tokenId, extraLines = []) {
  const token = db.prepare('SELECT * FROM tokens WHERE id = ?').get(tokenId);
  if (!token) return null;
  const existing = db.prepare('SELECT * FROM invoices WHERE token_id = ?').get(tokenId);
  if (existing) return hydrate(existing);

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(token.session_id);
  const doctor = db.prepare('SELECT * FROM doctors WHERE id = ?').get(session.doctor_id);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(token.patient_id);

  const lines = [
    { description: `Consultation — ${doctor.name}`, category: 'consultation', amountMinor: doctor.fee_minor, taxable: false },
    ...extraLines,
  ];
  const adapter = adapterFor(patient.payer_type);
  const { coveredMinor, lines: priced } = adapter.coverage(patient, lines);
  const total = lines.reduce((s, l) => s + l.amountMinor, 0);
  const gst = Math.round(lines.filter((l) => l.taxable).reduce((s, l) => s + l.amountMinor, 0) * GST_RATE);
  const patientMinor = Math.max(0, total + gst - coveredMinor);

  const invoiceId = id('inv');
  db.prepare(`INSERT INTO invoices
      (id, clinic_id, token_id, patient_id, lines, total_minor, payer_type, covered_minor, patient_minor, gst_minor, state, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(invoiceId, session.clinic_id, tokenId, patient.id, JSON.stringify(priced), total,
      patient.payer_type, coveredMinor, patientMinor, gst, patientMinor === 0 ? 'paid' : 'open', now());

  if (coveredMinor > 0 && patient.payer_type !== 'self_pay') {
    db.prepare('INSERT INTO claims (id, clinic_id, invoice_id, payer, amount_minor, state, mode) VALUES (?,?,?,?,?,?,?)')
      .run(id('clm'), session.clinic_id, invoiceId, patient.payer_type, coveredMinor, 'draft',
        patient.payer_type === 'aasandha' ? adapters.aasandha.mode : 'api');
  }
  return hydrate(db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId));
}

function hydrate(row) {
  return { ...row, lines: parse(row.lines, []) };
}

export function submitClaims(clinicId) {
  const drafts = db.prepare("SELECT * FROM claims WHERE clinic_id = ? AND state = 'draft'").all(clinicId);
  const at = now();
  const submitted = [];
  for (const claim of drafts) {
    const res = adapterFor(claim.payer).submitClaim(claim);
    db.prepare("UPDATE claims SET state = 'submitted', submitted_at = ?, mode = ? WHERE id = ?")
      .run(at, res.mode ?? 'api', claim.id);
    submitted.push({ ...claim, state: 'submitted', batch: res.batch });
  }
  return { submitted: submitted.length, batch: submitted[0]?.batch ?? null, claims: submitted };
}

/** Simulated adjudication — in `degraded` mode this is the receptionist keying in outcomes. */
export function adjudicate(clinicId, rejectionRate = 0.18) {
  const open = db.prepare("SELECT * FROM claims WHERE clinic_id = ? AND state IN ('submitted','resubmitted')").all(clinicId);
  let accepted = 0;
  let rejected = 0;
  for (const claim of open) {
    if (Math.random() < rejectionRate) {
      const r = REJECTION_REASONS[Math.floor(Math.random() * REJECTION_REASONS.length)];
      db.prepare("UPDATE claims SET state = 'rejected', reason_code = ?, reason_text = ?, settled_at = ? WHERE id = ?")
        .run(r.code, r.text, now(), claim.id);
      rejected++;
    } else {
      db.prepare("UPDATE claims SET state = 'accepted', settled_at = ? WHERE id = ?").run(now(), claim.id);
      accepted++;
    }
  }
  return { accepted, rejected };
}

export function resubmitClaim(claimId) {
  db.prepare("UPDATE claims SET state = 'resubmitted', reason_code = NULL, reason_text = NULL, submitted_at = ? WHERE id = ?")
    .run(now(), claimId);
  return db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
}

export function rejectionWorklist(clinicId) {
  return db.prepare(`
    SELECT c.*, i.patient_id, i.token_id, p.name AS patient_name, i.total_minor
    FROM claims c JOIN invoices i ON i.id = c.invoice_id JOIN patients p ON p.id = i.patient_id
    WHERE c.clinic_id = ? AND c.state = 'rejected' ORDER BY c.settled_at DESC
  `).all(clinicId);
}

export function rejectionAnalytics(clinicId) {
  return db.prepare(`
    SELECT c.reason_code AS code, c.reason_text AS text, COUNT(*) AS count, SUM(c.amount_minor) AS value_minor
    FROM claims c WHERE c.clinic_id = ? AND c.state = 'rejected'
    GROUP BY c.reason_code ORDER BY count DESC
  `).all(clinicId);
}

// ------------------------------------------------------------------ payments

export const PAYMENT_METHODS = ['bml_card', 'bml_link', 'mfaisaa', 'cash'];

/**
 * We never touch patient money: payments settle directly to the clinic's
 * merchant account. That keeps us out of a licensing regime we have no business
 * being inside, and it is a deliberate strategic choice — our revenue is
 * subscriptions, not a cut of clinical revenue.
 */
export function takePayment({ invoiceId, method, amountMinor }) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice) return null;
  if (!PAYMENT_METHODS.includes(method)) throw HttpError.badRequest(`method must be one of: ${PAYMENT_METHODS.join(', ')}`, { field: 'method' });
  const paidSoFar = db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS s FROM payments WHERE invoice_id = ? AND state = 'succeeded'").get(invoiceId).s;
  const outstanding = Math.max(0, invoice.patient_minor - paidSoFar);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0 || amountMinor > outstanding) {
    throw HttpError.badRequest(`amountMinor must be between 1 and ${outstanding} (the amount still due)`, { field: 'amountMinor', outstanding });
  }
  const paymentId = id('pay');
  const succeeded = method === 'cash' ? true : Math.random() > 0.05;
  db.prepare('INSERT INTO payments (id, invoice_id, clinic_id, method, amount_minor, state, reference, at) VALUES (?,?,?,?,?,?,?,?)')
    .run(paymentId, invoiceId, invoice.clinic_id, method, amountMinor,
      succeeded ? 'succeeded' : 'failed', `${method.toUpperCase()}-${paymentId.slice(-8)}`, now());

  if (succeeded) {
    const paid = db.prepare("SELECT COALESCE(SUM(amount_minor),0) AS s FROM payments WHERE invoice_id = ? AND state = 'succeeded'").get(invoiceId).s;
    const state = paid >= invoice.patient_minor ? 'paid' : 'part_paid';
    db.prepare('UPDATE invoices SET state = ? WHERE id = ?').run(state, invoiceId);
  }
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
}

export function refund(paymentId, reason = 'session_cancelled') {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p) return null;
  db.prepare("UPDATE payments SET state = 'refunded' WHERE id = ?").run(paymentId);
  db.prepare("UPDATE invoices SET state = 'void' WHERE id = ?").run(p.invoice_id);
  return { ...p, state: 'refunded', reason };
}

export function invoicesForPatient(patientId) {
  return db.prepare('SELECT * FROM invoices WHERE patient_id = ? ORDER BY created_at DESC').all(patientId).map(hydrate);
}

export function invoiceForTokenIfAny(tokenId) {
  const row = db.prepare('SELECT * FROM invoices WHERE token_id = ?').get(tokenId);
  return row ? hydrate(row) : null;
}

export { REJECTION_REASONS };
