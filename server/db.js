import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.VAGUTHU_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const file = process.env.VAGUTHU_DB === ':memory:' ? ':memory:' : path.join(dataDir, 'vaguthu.db');

export const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS clinics (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, atoll TEXT, island TEXT, address TEXT,
  phone TEXT, settings TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY, clinic_id TEXT NOT NULL REFERENCES clinics(id),
  name TEXT NOT NULL, role TEXT NOT NULL, pin TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS doctors (
  id TEXT PRIMARY KEY, clinic_id TEXT NOT NULL REFERENCES clinics(id),
  name TEXT NOT NULL, specialty TEXT NOT NULL, qualifications TEXT,
  languages TEXT NOT NULL DEFAULT '["en"]', gender TEXT,
  fee_minor INTEGER NOT NULL DEFAULT 40000, slot_minutes INTEGER NOT NULL DEFAULT 12,
  accepts_payers TEXT NOT NULL DEFAULT '["aasandha","self_pay"]'
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, clinic_id TEXT NOT NULL REFERENCES clinics(id),
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  scheduled_start INTEGER NOT NULL, scheduled_end INTEGER NOT NULL,
  slot_minutes INTEGER NOT NULL DEFAULT 12,
  state TEXT NOT NULL DEFAULT 'scheduled',       -- scheduled|running|paused|ended|cancelled
  actual_start INTEGER, actual_end INTEGER,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  walkin_reserve_pct INTEGER NOT NULL DEFAULT 20,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(clinic_id, scheduled_start);

CREATE TABLE IF NOT EXISTS blackouts (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL,                             -- prayer|break|emergency|admin|other
  starts_at INTEGER NOT NULL, ends_at INTEGER,
  expected_resume_at INTEGER, open_ended INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_blackouts_session ON blackouts(session_id);

CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, national_id TEXT,
  dob TEXT, gender TEXT, language TEXT NOT NULL DEFAULT 'dv',
  travel_atoll TEXT, travel_island TEXT,
  payer_type TEXT NOT NULL DEFAULT 'aasandha', insurer TEXT, policy_no TEXT,
  household_of TEXT REFERENCES patients(id), relation TEXT,
  wait_location TEXT NOT NULL DEFAULT 'nearby', travel_minutes INTEGER NOT NULL DEFAULT 10,
  efaas_verified INTEGER NOT NULL DEFAULT 0,
  notify_prefs TEXT NOT NULL DEFAULT '{"push":true,"viber":true,"sms":true,"marketing":false}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  patient_id TEXT NOT NULL REFERENCES patients(id),
  display TEXT NOT NULL, seq REAL NOT NULL,
  source TEXT NOT NULL,                           -- walk_in|phone|app|partner
  partner_id TEXT, partner_reference TEXT,
  visit_type TEXT NOT NULL DEFAULT 'new',
  state TEXT NOT NULL DEFAULT 'booked',           -- booked|arrived|called|in_consult|completed|no_show|penalised|cancelled
  flags TEXT NOT NULL DEFAULT '[]',
  priority_reason TEXT, penalty_count INTEGER NOT NULL DEFAULT 0,
  booked_at INTEGER, arrived_at INTEGER, called_at INTEGER,
  started_at INTEGER, ended_at INTEGER,
  extra_minutes INTEGER NOT NULL DEFAULT 0,
  on_my_way INTEGER NOT NULL DEFAULT 0,
  notify_via_partner_only INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_session ON tokens(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_tokens_patient ON tokens(patient_id);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL, session_id TEXT, token_id TEXT, clinic_id TEXT,
  type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);

-- Transactional outbox: written in the same transaction as the queue mutation,
-- drained by the relay. This is what stops a lost event silently corrupting
-- every downstream ETA.
CREATE TABLE IF NOT EXISTS outbox (
  event_seq INTEGER PRIMARY KEY REFERENCES events(seq),
  processed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projections (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  version INTEGER NOT NULL, computed_at INTEGER NOT NULL, body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS duration_stats (
  bucket TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0,
  sum_ln REAL NOT NULL DEFAULT 0, sum_ln2 REAL NOT NULL DEFAULT 0,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS turnover_stats (
  doctor_id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, sum_ms REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, clinic_id TEXT, patient_id TEXT, token_id TEXT,
  template TEXT NOT NULL, channel TEXT NOT NULL, body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'sent',             -- sent|delivered|failed|read
  cost_minor INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0, read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_patient ON messages(patient_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_token ON messages(token_id, at DESC);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, clinic_id TEXT NOT NULL, token_id TEXT, patient_id TEXT NOT NULL,
  lines TEXT NOT NULL, total_minor INTEGER NOT NULL,
  payer_type TEXT NOT NULL, covered_minor INTEGER NOT NULL DEFAULT 0,
  patient_minor INTEGER NOT NULL DEFAULT 0, gst_minor INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open',             -- open|paid|part_paid|void
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_clinic ON invoices(clinic_id, created_at DESC);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id),
  clinic_id TEXT NOT NULL, payer TEXT NOT NULL, amount_minor INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',            -- draft|submitted|accepted|rejected|resubmitted|paid
  reason_code TEXT, reason_text TEXT,
  submitted_at INTEGER, settled_at INTEGER, mode TEXT NOT NULL DEFAULT 'api'
);
CREATE INDEX IF NOT EXISTS idx_claims_clinic ON claims(clinic_id, state);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id),
  clinic_id TEXT NOT NULL, method TEXT NOT NULL, amount_minor INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',          -- pending|succeeded|failed|refunded
  reference TEXT, at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS eligibility_checks (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, payer TEXT NOT NULL,
  result TEXT NOT NULL,                            -- covered|not_covered|unverified
  detail TEXT, at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, from_doctor TEXT, to_specialty TEXT,
  note TEXT, issued_at INTEGER NOT NULL, expires_at INTEGER, used_token_id TEXT
);

CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, client_id TEXT UNIQUE NOT NULL,
  client_secret TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS partner_clinic (
  partner_id TEXT NOT NULL, clinic_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  allocation_pct INTEGER NOT NULL DEFAULT 20,
  can_cancel INTEGER NOT NULL DEFAULT 1,
  horizon_days INTEGER NOT NULL DEFAULT 14,
  PRIMARY KEY (partner_id, clinic_id)
);

CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, slot_index INTEGER NOT NULL,
  partner_id TEXT, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id),
  url TEXT NOT NULL, events TEXT NOT NULL, clinic_ids TEXT NOT NULL DEFAULT '[]',
  secret TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active',
  failures INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id),
  event_id TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',          -- pending|delivered|failed
  last_status INTEGER, last_error TEXT, expires_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON webhook_deliveries(state, next_attempt_at);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY, scope TEXT NOT NULL, response TEXT NOT NULL, at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY, clinic_id TEXT, actor TEXT, action TEXT NOT NULL,
  entity TEXT, before TEXT, after TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_clinic ON audit(clinic_id, at DESC);

-- Calibration record: what we promised vs. what happened. This is the table
-- the P80-coverage metric is computed from, and the one that tells us whether
-- the estimate is honest.
CREATE TABLE IF NOT EXISTS eta_accuracy (
  token_id TEXT PRIMARY KEY, session_id TEXT, doctor_id TEXT,
  predicted_from INTEGER, predicted_to INTEGER, predicted_p50 INTEGER,
  actual_start INTEGER, inside INTEGER, error_ms INTEGER, lead_ms INTEGER
);

-- Throttled history of published windows, so P80 coverage can be measured at a
-- fixed LEAD TIME. Measuring against the window published one second before the
-- consultation starts is trivially true and tells us nothing.
CREATE TABLE IF NOT EXISTS eta_snapshots (
  token_id TEXT NOT NULL, at INTEGER NOT NULL,
  from_ms INTEGER, to_ms INTEGER, p50 INTEGER,
  PRIMARY KEY (token_id, at)
);

CREATE TABLE IF NOT EXISTS notification_log (
  token_id TEXT NOT NULL, rule TEXT NOT NULL, at INTEGER NOT NULL,
  value TEXT, PRIMARY KEY (token_id, rule)
);
`);

export function tx(fn) {
  return db.transaction(fn);
}

export default db;
