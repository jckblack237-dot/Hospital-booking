/**
 * Demo seed: one Male' clinic, one atoll clinic, staff, doctors, patients,
 * three weeks of history (so the duration model is calibrated and the analytics
 * are not empty), and today's sessions with a realistic booking mix.
 */
import { db } from './db.js';
import { now, setTime, MINUTE } from './lib/clock.js';
import { id } from './lib/util.js';
import { mvStartOfDay, mvParts, mvTime, isWeekend } from './lib/mvtime.js';
import { createSession, slotsForSession } from './services/scheduling.js';
import { record as recordDuration, recordTurnover } from './engine/duration-model.js';
import * as world from './services/ground-truth.js';
import { invoiceForToken, submitClaims, adjudicate, takePayment, checkEligibility } from './services/billing.js';
import { hashPassword, slugify } from './services/tenancy.js';

/**
 * Demo sign-ins. Each clinic has its OWN address and its own password; the
 * credentials are stored on the clinic so its sign-in page can show them in
 * demo mode, and nowhere else. Real clinics are provisioned with
 * `npm run provision`, which generates a password and shows it once.
 */
const DEMO = {
  male: { password: 'lagoon-2026', staff: [['Shaira Ahmed', 'receptionist', 'shaira'], ['Nazima Ali', 'receptionist', 'nazima'],
    ['Ahmed Zahir', 'admin', 'ahmed.zahir'], ['Ismail Fahmy', 'billing', 'ismail']] },
  naifaru: { password: 'reef-2026', staff: [['Hawwa Latheefa', 'receptionist', 'hawwa'], ['Mohamed Latheef', 'admin', 'mohamed.latheef']] },
};

function addStaff(clinicId, password, list) {
  for (const [name, role, username] of list) {
    const { hash, salt } = hashPassword(password);
    db.prepare(`INSERT INTO staff (id, clinic_id, name, role, username, password_hash, password_salt, active, created_at)
                VALUES (?,?,?,?,?,?,?,1,?)`).run(id('stf'), clinicId, name, role, username, hash, salt, now());
  }
}

const DOCTORS = [
  { name: 'Dr. Hassan Waheed', specialty: 'internal_medicine', gender: 'male', languages: ['dv', 'en', 'hi'], fee: 40000, slot: 10, quals: 'MBBS, MD (Internal Medicine)' },
  { name: 'Dr. Aminath Shaheedha', specialty: 'paediatrics', gender: 'female', languages: ['dv', 'en'], fee: 45000, slot: 12, quals: 'MBBS, DCH, MD (Paediatrics)' },
  { name: 'Dr. Ibrahim Rasheed', specialty: 'ent', gender: 'male', languages: ['dv', 'en', 'bn'], fee: 45000, slot: 10, quals: 'MBBS, MS (ENT)' },
  { name: 'Dr. Mariyam Nazly', specialty: 'obgyn', gender: 'female', languages: ['dv', 'en'], fee: 55000, slot: 15, quals: 'MBBS, MS (Obstetrics & Gynaecology)' },
  { name: 'Dr. Ahmed Shifau', specialty: 'general_practice', gender: 'male', languages: ['dv', 'en', 'ur'], fee: 30000, slot: 8, quals: 'MBBS' },
  { name: 'Dr. Fathimath Zulfa', specialty: 'dermatology', gender: 'female', languages: ['dv', 'en'], fee: 50000, slot: 10, quals: 'MBBS, MD (Dermatology)' },
  { name: 'Dr. Ali Nasheed', specialty: 'cardiology', gender: 'male', languages: ['dv', 'en'], fee: 65000, slot: 18, quals: 'MBBS, MD, DM (Cardiology)' },
  { name: 'Dr. Shahula Adam', specialty: 'ophthalmology', gender: 'female', languages: ['dv', 'en', 'si'], fee: 45000, slot: 10, quals: 'MBBS, MS (Ophthalmology)' },
];

const ATOLL_DOCTORS = [
  { name: 'Dr. Mohamed Latheef', specialty: 'general_practice', gender: 'male', languages: ['dv', 'en'], fee: 25000, slot: 10, quals: 'MBBS' },
  { name: 'Dr. Nadhiya Ismail', specialty: 'paediatrics', gender: 'female', languages: ['dv', 'en'], fee: 35000, slot: 12, quals: 'MBBS, DCH' },
];

const FIRST = ['Ahmed', 'Ibrahim', 'Mohamed', 'Ali', 'Hussain', 'Hassan', 'Aishath', 'Fathimath', 'Mariyam', 'Khadheeja', 'Aminath', 'Shifa', 'Nazima', 'Yoosuf', 'Adam', 'Nasru', 'Sameera', 'Rilwan'];
const LAST = ['Mohamed', 'Ibrahim', 'Hassan', 'Ali', 'Waheed', 'Rasheed', 'Naseem', 'Shareef', 'Latheef', 'Zahir', 'Manik', 'Didi', 'Fulhu', 'Adam'];
const ISLANDS = [
  { atoll: 'Lh', island: 'Naifaru', travel: 210 }, { atoll: 'HDh', island: 'Kulhudhuffushi', travel: 260 },
  { atoll: 'ADh', island: 'Maamigili', travel: 150 }, { atoll: 'GA', island: 'Villingili', travel: 300 },
  { atoll: 'B', island: 'Eydhafushi', travel: 180 }, { atoll: 'Th', island: 'Veymandoo', travel: 240 },
];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const chance = (p) => Math.random() < p;
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

function makePatient({ travel = false, household = null, relation = null, age = null } = {}) {
  const patientId = id('pat');
  const origin = travel ? pick(ISLANDS) : null;
  const year = age ? new Date().getFullYear() - age : randInt(1955, 2020);
  const payer = chance(0.72) ? 'aasandha' : chance(0.6) ? 'private' : 'self_pay';
  db.prepare(`INSERT INTO patients
      (id, name, phone, national_id, dob, gender, language, travel_atoll, travel_island,
       payer_type, insurer, policy_no, household_of, relation, wait_location, travel_minutes,
       efaas_verified, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(patientId, `${pick(FIRST)} ${pick(LAST)}`, `+960${randInt(7000000, 7999999)}`,
      `A${randInt(100000, 399999)}`, `${year}-${String(randInt(1, 12)).padStart(2, '0')}-${String(randInt(1, 28)).padStart(2, '0')}`,
      chance(0.5) ? 'female' : 'male', chance(0.8) ? 'dv' : 'en',
      origin?.atoll ?? null, origin?.island ?? null,
      payer, payer === 'private' ? pick(['Allied', 'Amana Takaful']) : null,
      payer === 'private' ? `POL-${randInt(100000, 999999)}` : null,
      household, relation,
      origin ? 'clinic' : chance(0.5) ? 'nearby' : 'custom',
      origin ? 0 : chance(0.5) ? 10 : 35,
      chance(0.65) ? 1 : 0, now());
  return db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId);
}

/** Build a completed historical session, including invoices, claims and calibration rows. */
function seedHistoricalSession(clinicId, doctor, startMs, endMs, patients) {
  const session = createSession({
    clinicId, doctorId: doctor.id, start: startMs, end: endMs, slotMinutes: doctor.slot_minutes,
  });
  const lateness = world.startLatenessMinutes() * MINUTE;
  const actualStart = startMs + lateness;
  let cursor = actualStart;
  const capacity = Math.floor((endMs - startMs) / (doctor.slot_minutes * MINUTE));
  const letter = String.fromCharCode(65 + (DOCTORS.findIndex((d) => d.name === doctor.name) % 26));

  for (let i = 0; i < capacity && cursor < endMs + 45 * MINUTE; i++) {
    const patient = pick(patients);
    const visitType = chance(0.45) ? 'new' : 'follow_up';
    // ~18% of consultations genuinely run long. If the seeded history has no
    // tail, the fitted sigma is too small, the published windows are too narrow,
    // and P80 coverage collapses — the exact failure the calibration metric exists
    // to catch.
    const duration = world.durationMinutes(doctor.specialty, visitType) * MINUTE;
    const source = chance(0.35) ? 'app' : chance(0.5) ? 'phone' : chance(0.7) ? 'walk_in' : 'partner';
    const noShow = chance(0.05);
    const tokenId = id('tok');
    const arrived = cursor - randInt(5, 40) * MINUTE;

    db.prepare(`INSERT INTO tokens
        (id, session_id, patient_id, display, seq, source, visit_type, state, flags,
         booked_at, arrived_at, called_at, started_at, ended_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(tokenId, session.id, patient.id, `${letter}-${String(i + 1).padStart(2, '0')}`, (i + 1) * 1000,
        source, visitType, noShow ? 'no_show' : 'completed', '[]',
        startMs - randInt(1, 72) * 3_600_000,
        noShow ? null : arrived, noShow ? cursor : cursor,
        noShow ? null : cursor, noShow ? null : cursor + duration);

    if (!noShow) {
      recordDuration({
        doctorId: doctor.id, specialty: doctor.specialty, visitType,
        isNewPatient: visitType === 'new', durationMs: duration,
      });
      // Calibration rows: a plausible published window, and whether we were right.
      const sd = 4 + i * 0.8;
      const p50 = cursor + Math.round(world.normalSample() * sd * MINUTE * 0.6);
      db.prepare(`INSERT INTO eta_accuracy
          (token_id, session_id, doctor_id, predicted_from, predicted_to, predicted_p50, actual_start, inside, error_ms, lead_ms)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(tokenId, session.id, doctor.id, p50 - sd * MINUTE, p50 + sd * MINUTE, p50, cursor,
          cursor >= p50 - sd * MINUTE && cursor <= p50 + sd * MINUTE ? 1 : 0, cursor - p50, null);

      const invoice = invoiceForToken(tokenId);
      if (invoice && invoice.patient_minor > 0) {
        takePayment({ invoiceId: invoice.id, method: pick(['bml_card', 'mfaisaa', 'cash']), amountMinor: invoice.patient_minor });
      }
      const turnover = world.turnoverMs();
      recordTurnover(doctor.id, turnover);
      cursor += duration + turnover;
    } else {
      cursor += 60_000;
    }
  }

  db.prepare("UPDATE sessions SET state = 'ended', actual_start = ?, actual_end = ?, delay_minutes = ? WHERE id = ?")
    .run(actualStart, cursor, Math.round(lateness / MINUTE), session.id);
  return session;
}

/**
 * One clinic's evening: sessions for each of its doctors on the given day,
 * with a realistic booking mix. Used by the initial seed and, in demo mode,
 * by the autopilot every time the previous evening has finished — so the
 * demo never sits on a board that has stopped moving.
 *
 * `pool` is the patients to book from; by default, everyone the clinic has
 * seen before (its clinic_patients rows), which is exactly what a real
 * clinic's evening looks like.
 */
export function seedClinicEvening(clinic, p, demoNow, { pool = null } = {}) {
  const settings = JSON.parse(clinic.settings || '{}');
  const solo = settings.tier === 'solo';
  const doctors = db.prepare('SELECT * FROM doctors WHERE clinic_id = ? ORDER BY rowid').all(clinic.id);
  const patients = pool ?? db.prepare(`SELECT p.* FROM patients p JOIN clinic_patients cp ON cp.patient_id = p.id
                                       WHERE cp.clinic_id = ? ORDER BY p.rowid`).all(clinic.id);
  if (!doctors.length || !patients.length) return [];

  const byName = (name) => (pool
    ? pool.find((x) => x.name === name)
    : db.prepare(`SELECT p.* FROM patients p JOIN clinic_patients cp ON cp.patient_id = p.id
                  WHERE cp.clinic_id = ? AND p.name = ?`).get(clinic.id, name)) ?? null;
  const persona = solo ? null : byName('Aishath Shifa');
  const child = solo ? null : byName('Ahmed Naail');
  const firstParty = db.prepare("SELECT id FROM partners WHERE client_id = 'pk_demo_vaguthu'").get()?.id ?? null;
  const partnerId = db.prepare(`SELECT pc.partner_id FROM partner_clinic pc JOIN partners pt ON pt.id = pc.partner_id
                                WHERE pc.clinic_id = ? AND pc.enabled = 1 AND pt.client_id <> 'pk_demo_vaguthu' LIMIT 1`).get(clinic.id)?.partner_id ?? null;

  const sessions = [];
  for (let i = 0; i < doctors.length; i++) {
    const doctor = doctors[i];
    const session = createSession({
      clinicId: clinic.id, doctorId: doctor.id, slotMinutes: doctor.slot_minutes,
      start: mvTime(p.year, p.month, p.day, 17, 0), end: mvTime(p.year, p.month, p.day, solo ? 19 : 20, solo ? 30 : 0),
    });
    sessions.push(session);
    const letter = String.fromCharCode(65 + (i % 26));
    // Leave real headroom. A clinic whose every slot is already sold has
    // nothing for the app or a partner to book, which is neither realistic
    // nor a useful demo.
    const { slots } = slotsForSession(session);
    const count = solo ? 7 : Math.max(4, Math.min(randInt(9, 16), Math.floor(slots.length * 0.6)));
    for (let k = 0; k < count; k++) {
      const patient = (i === 0 && k === 0 && persona) ? persona
        : (i === 1 && k === 2 && child) ? child
          : solo ? patients[(i * 7 + k) % patients.length] : pick(patients);
      const source = solo ? (chance(0.5) ? 'walk_in' : 'phone')
        : chance(0.42) ? 'app' : chance(0.45) ? 'phone' : chance(0.6) ? 'walk_in' : 'partner';
      const viaPartner = source === 'partner' && partnerId;
      const flags = [];
      if (patient.travel_island) flags.push('travel');
      db.prepare(`INSERT INTO tokens (id, session_id, patient_id, display, seq, source, partner_id,
                  partner_reference, visit_type, state, flags, booked_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id('tok'), session.id, patient.id, `${letter}-${String(k + 1).padStart(2, '0')}`, (k + 1) * 1000,
          viaPartner ? 'partner' : source === 'partner' ? 'phone' : source,
          viaPartner ? partnerId : source === 'app' ? firstParty : null,
          viaPartner ? `dhoni-bk-${randInt(10000, 99999)}` : null,
          chance(0.45) ? 'new' : 'follow_up', chance(0.3) ? 'arrived' : 'booked',
          JSON.stringify(flags), demoNow - randInt(1, 96) * 3_600_000);
    }
  }

  // Every clinic knows exactly the patients who have a token with it — no more.
  db.exec(`INSERT OR IGNORE INTO clinic_patients (clinic_id, patient_id, first_seen_at)
           SELECT DISTINCT s.clinic_id, t.patient_id, MIN(COALESCE(t.booked_at, s.scheduled_start))
           FROM tokens t JOIN sessions s ON s.id = t.session_id WHERE s.clinic_id = '${clinic.id}' GROUP BY s.clinic_id, t.patient_id`);

  // Eligibility is checked at booking, so the queue should already carry a
  // result on most cards — including the ones that could not be verified.
  for (const s of sessions) {
    for (const row of db.prepare('SELECT DISTINCT patient_id FROM tokens WHERE session_id = ?').all(s.id)) checkEligibility(row.patient_id);
  }
  return sessions;
}

export function seed({ force = false } = {}) {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM clinics').get().c;
  if (existing && !force) return { skipped: true };
  if (force) {
    for (const t of ['login_attempts', 'staff_sessions', 'notification_log', 'eta_accuracy', 'audit', 'idempotency', 'webhook_deliveries',
      'webhook_endpoints', 'holds', 'partner_clinic', 'partners', 'referrals', 'eligibility_checks',
      'payments', 'claims', 'invoices', 'messages', 'turnover_stats', 'duration_stats', 'projections',
      'outbox', 'events', 'tokens', 'patients', 'blackouts', 'sessions', 'doctors', 'staff', 'clinics']) {
      db.exec(`DELETE FROM ${t}`);
    }
  }

  // Start the demo at 16:40 on a working day — pre-session on a busy evening.
  let anchor = mvStartOfDay(Date.now());
  while (isWeekend(anchor)) anchor += 86_400_000;
  const p = mvParts(anchor);
  const demoNow = mvTime(p.year, p.month, p.day, 16, 40);
  setTime(demoNow);

  const clinicId = id('cln');
  db.prepare(`INSERT INTO clinics (id, name, atoll, island, address, phone, settings, slug) VALUES (?,?,?,?,?,?,?,?)`)
    .run(clinicId, "Male' Family Clinic", 'K', 'Male', 'Majeedhee Magu, Male\' 20026', '+9603301234',
      JSON.stringify({
        messagingWalletMinor: 250000,
        penalty: { gracePeriodMinutes: 5, penaltyMode: 'move_back_n', moveBackPositions: 2, travelFlagExemption: true },
        tier: 'multi_specialty',
        demoCredentials: { password: DEMO.male.password, users: DEMO.male.staff.map(([n, r, u]) => ({ name: n, role: r, username: u })) },
      }), slugify("Male' Family Clinic"));

  const atollClinicId = id('cln');
  db.prepare(`INSERT INTO clinics (id, name, atoll, island, address, phone, settings, slug) VALUES (?,?,?,?,?,?,?,?)`)
    .run(atollClinicId, 'Naifaru Health Centre', 'Lh', 'Naifaru', 'Naifaru, Lhaviyani Atoll', '+9606620123',
      JSON.stringify({
        messagingWalletMinor: 80000, tier: 'solo', atollDiscount: true,
        demoCredentials: { password: DEMO.naifaru.password, users: DEMO.naifaru.staff.map(([n, r, u]) => ({ name: n, role: r, username: u })) },
      }), slugify('Naifaru Health Centre'));

  addStaff(clinicId, DEMO.male.password, DEMO.male.staff);
  addStaff(atollClinicId, DEMO.naifaru.password, DEMO.naifaru.staff);

  const doctorRows = [];
  for (const d of DOCTORS) {
    const doctorId = id('doc');
    db.prepare(`INSERT INTO doctors (id, clinic_id, name, specialty, qualifications, languages, gender, fee_minor, slot_minutes, accepts_payers)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(doctorId, clinicId, d.name, d.specialty, d.quals, JSON.stringify(d.languages), d.gender,
        d.fee, d.slot, JSON.stringify(['aasandha', 'private', 'self_pay']));
    doctorRows.push(db.prepare('SELECT * FROM doctors WHERE id = ?').get(doctorId));
  }
  const atollDoctorRows = [];
  for (const d of ATOLL_DOCTORS) {
    const doctorId = id('doc');
    db.prepare(`INSERT INTO doctors (id, clinic_id, name, specialty, qualifications, languages, gender, fee_minor, slot_minutes, accepts_payers)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(doctorId, atollClinicId, d.name, d.specialty, d.quals, JSON.stringify(d.languages), d.gender,
        d.fee, d.slot, JSON.stringify(['aasandha', 'self_pay']));
    atollDoctorRows.push(db.prepare('SELECT * FROM doctors WHERE id = ?').get(doctorId));
  }

  // Patients, including the two personas and a household.
  const patients = [];
  for (let i = 0; i < 120; i++) patients.push(makePatient({ travel: chance(0.12) }));

  const aishath = makePatient({ age: 29 });
  db.prepare(`UPDATE patients SET name = 'Aishath Shifa', gender = 'female', language = 'dv', payer_type = 'aasandha',
              wait_location = 'custom', travel_minutes = 35, efaas_verified = 1, travel_atoll = NULL, travel_island = NULL WHERE id = ?`)
    .run(aishath.id);

  const fathimath = makePatient({ age: 34 });
  db.prepare(`UPDATE patients SET name = 'Fathimath Rasheedha', gender = 'female', language = 'dv', payer_type = 'aasandha',
              travel_atoll = 'Lh', travel_island = 'Naifaru', wait_location = 'clinic', travel_minutes = 0,
              efaas_verified = 1 WHERE id = ?`).run(fathimath.id);
  const child = makePatient({ household: fathimath.id, relation: 'child', age: 4 });
  db.prepare(`UPDATE patients SET name = 'Ahmed Naail', gender = 'male', travel_atoll = 'Lh', travel_island = 'Naifaru',
              wait_location = 'clinic', travel_minutes = 0, payer_type = 'aasandha' WHERE id = ?`).run(child.id);
  db.prepare('INSERT INTO referrals (id, patient_id, from_doctor, to_specialty, note, issued_at, expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(id('ref'), child.id, 'Dr. Mohamed Latheef (Naifaru Health Centre)', 'paediatrics',
      'Recurrent wheeze, for specialist paediatric review.', demoNow - 4 * 86_400_000, demoNow + 60 * 86_400_000);
  patients.push(aishath, fathimath, child);

  // Three weeks of history so the model is calibrated and reports are not empty.
  for (let dayOffset = 21; dayOffset >= 1; dayOffset--) {
    const day = mvStartOfDay(demoNow - dayOffset * 86_400_000);
    if (isWeekend(day)) continue;
    const dp = mvParts(day);
    for (const doctor of doctorRows) {
      if (chance(0.35)) continue;
      seedHistoricalSession(clinicId, doctor, mvTime(dp.year, dp.month, dp.day, 16, 0), mvTime(dp.year, dp.month, dp.day, 18, 0), patients);
      if (chance(0.5)) {
        seedHistoricalSession(clinicId, doctor, mvTime(dp.year, dp.month, dp.day, 20, 0), mvTime(dp.year, dp.month, dp.day, 22, 0), patients);
      }
    }
  }
  submitClaims(clinicId);
  adjudicate(clinicId, 0.18);

  // Partners are created before today's tokens so partner-sourced bookings can
  // carry a real partner_id — scoping and allocation caps are meaningless
  // against tokens that only *say* they came from a partner.
  const partnerId = id('prt');
  db.prepare('INSERT INTO partners (id, name, client_id, client_secret, scopes, created_at) VALUES (?,?,?,?,?,?)')
    .run(partnerId, 'Dhoni Health', 'pk_demo_dhoni', 'sk_demo_dhoni_secret',
      JSON.stringify(['clinics:read', 'slots:read', 'bookings:write', 'bookings:read', 'queue:read', 'queue:subscribe']), now());
  db.prepare('INSERT INTO partner_clinic (partner_id, clinic_id, enabled, allocation_pct) VALUES (?,?,?,?)')
    .run(partnerId, clinicId, 1, 20);

  const firstParty = id('prt');
  db.prepare('INSERT INTO partners (id, name, client_id, client_secret, scopes, created_at) VALUES (?,?,?,?,?,?)')
    .run(firstParty, 'Vaguthu Patient App', 'pk_demo_vaguthu', 'sk_demo_vaguthu_secret',
      JSON.stringify(['clinics:read', 'slots:read', 'bookings:write', 'bookings:read', 'queue:read', 'queue:subscribe']), now());
  db.prepare('INSERT INTO partner_clinic (partner_id, clinic_id, enabled, allocation_pct) VALUES (?,?,?,?)')
    .run(firstParty, clinicId, 1, 100);

  // Today: morning done, evening ahead. Both clinics get their own evening,
  // with their own patients — a second tenant to prove isolation against, and
  // a real atoll demo.
  const islanders = [];
  for (let i = 0; i < 24; i++) islanders.push(makePatient());
  const todaySessions = seedClinicEvening(db.prepare('SELECT * FROM clinics WHERE id = ?').get(clinicId), p, demoNow, { pool: patients });
  seedClinicEvening(db.prepare('SELECT * FROM clinics WHERE id = ?').get(atollClinicId), p, demoNow, { pool: islanders });

  // Every clinic knows exactly the patients who have a token with it — no more.
  db.exec(`INSERT OR IGNORE INTO clinic_patients (clinic_id, patient_id, first_seen_at)
           SELECT DISTINCT s.clinic_id, t.patient_id, MIN(COALESCE(t.booked_at, s.scheduled_start))
           FROM tokens t JOIN sessions s ON s.id = t.session_id GROUP BY s.clinic_id, t.patient_id`);
  // Fathimath's child was referred from the island clinic, so it knows both of them.
  for (const pid of [fathimath.id, child.id]) {
    db.prepare('INSERT OR IGNORE INTO clinic_patients (clinic_id, patient_id, first_seen_at) VALUES (?,?,?)')
      .run(atollClinicId, pid, demoNow - 4 * 86_400_000);
  }

  return {
    clinicId, atollClinicId, doctors: doctorRows.length, patients: patients.length,
    sessions: todaySessions.length, demoNow,
    personas: { aishath: aishath.id, fathimath: fathimath.id, child: child.id },
  };
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const result = seed({ force: process.argv.includes('--force') });
  console.log('seeded', JSON.stringify(result, null, 2));
}
