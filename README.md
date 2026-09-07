# Vaguthu — Clinic Queue Platform for the Maldives

A working two-sided healthcare queue platform, plus the product documentation it was built from.

- **Vaguthu Clinic** (B2B) — a cloud clinic CRM and queue-management dashboard that owns the live state of a clinic's queue.
- **Vaguthu** (B2C) — a patient app for finding doctors, booking, and tracking a live token from home.
- **Partner API** — the same queue, published to any third-party app the clinic authorises.
- **Marketing site** — the pitch, the pricing, and links into both apps.

> `Vaguthu` (Dhivehi: *time*) is a working name pending trademark clearance.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # 61 tests: engine calibration, API, cross-clinic isolation, sign-in
```

The database seeds itself on first boot with a Malé clinic, an atoll clinic, ten doctors,
three weeks of history, and today's evening sessions.

| | |
|---|---|
| Marketing site | <http://localhost:3000/> |
| Clinic dashboard | <http://localhost:3000/clinic/> — see **Sign-ins** below |
| Patient app | <http://localhost:3000/app/> |
| Partner API | `http://localhost:3000/v1` (`pk_demo_dhoni` / `sk_demo_dhoni_secret`) |

**Press "Run the evening" in the dashboard.** Simulated doctors start late, run over, pause for
prayer, and lose the occasional patient to a no-show — while the board, the patient tracker and
the notification cascade all react live. Open `/app/` in a second window as *Aishath Shifa* to
watch the same queue from the patient's side.

The demo runs on a **virtual clock** (`server/lib/clock.js`). Everything reads time through it, so
a three-hour clinic session is watchable in a few minutes. Notification debounce windows are in
*clinic* minutes, so at ×20 or ×120 messages arrive compressed — that is the clock, not the rules.

## Sign-ins

One sign-in form, at `/clinic/`: username and password. **Usernames are unique across the whole
platform**, so a username alone says which clinic you belong to — there is nothing to choose, and
nothing lists clinics or staff.

| Clinic | Demo accounts | Password |
|---|---|---|
| Malé Family Clinic | `shaira`, `nazima` (reception) · `ahmed.zahir` (admin) · `ismail` (billing) | `lagoon-2026` |
| Naifaru Health Centre | `hawwa` (reception) · `mohamed.latheef` (admin) | `reef-2026` |

Each clinic also has an optional address of its own — `/clinic/male-family-clinic/` — which brands
the page with the clinic's name and accepts only that clinic's accounts; handy as a bookmark on the
reception tablet, never required. Passwords are scrypt-hashed with a per-account salt. Five failed
attempts lock the account for five minutes. Admins issue sign-ins to their own team from
Settings → Your team: a generated password is shown once, and the new person must change it on
first sign-in. Switching an account off ends its sessions immediately.

**Giving a new clinic its sign-in** is how Vaguthu onboards a customer:

```bash
npm run provision -- --name "Hulhumalé Medical" --island Hulhumale --atoll K \
                     --admin "Aishath Nadha" --username aishath.nadha
#   Sign in:   http://localhost:3000/clinic/hulhumal-medical/   (or just /clinic/)
#   Admin:     aishath.nadha
#   Password:  coral-tide-47   (shown once)
```

The demo credentials above are stored on the seeded clinics and offered by the sign-in page only
while `VAGUTHU_DEMO` is not `false`; they never appear in any other response.

## The demo runs by itself

While `VAGUTHU_DEMO` is not `false`, the server drives the demo on its own (`server/services/autopilot.js`):
the evening starts when the server boots, doctors are simulated at ×10 (`VAGUTHU_DEMO_SPEED`),
and when every session has finished the demo rolls on to the next working day with a fresh
evening for each seeded clinic. A restart resumes rather than freezing the board. The demo
controls in the dashboard sidebar change the speed or pause it; the next evening starts again
regardless. Set `VAGUTHU_AUTOPILOT=false` to disable it without leaving demo mode.

## Each clinic is its own CRM

Two clinics are seeded — Malé Family Clinic and Naifaru Health Centre — and they cannot see each
other. This is enforced, not assumed:

- Staff sign in as **themselves**; the tenant comes from the signed-in session
  and from nothing else: there is no `clinicId` parameter on any clinic route, and one in a query
  string or body is ignored (`server/routes/clinic.js`, `server/services/tenancy.js`).
- Every entity route checks ownership **before** reading — and a miss is a 404, not a 403, because
  confirming that another clinic's record exists is itself a leak.
- A clinic sees only patients who have booked, walked in or been registered *there*
  (`clinic_patients`). A person known to two clinics shows each clinic only its own visits,
  invoices and messages.
- Only admins can change settings or partner access. Sign-out invalidates the session immediately.

`test/tenancy.test.js` signs in as both clinics and tries every route against the other's
sessions, tokens, patients, invoices, claims and settings — and checks that a username resolves to
its own clinic, that a clinic's optional address accepts only its accounts, that lockout works, and
that no response carries a hash or a password. In production the same rules would also
be in Postgres row-level security; here they live in one middleware so no route can forget them.
For clinics that need physical separation (data residency, A6), the server runs one-per-clinic
with its own database directory: `VAGUTHU_DATA_DIR=/data/clinic-a PORT=3001 npm start`.

## What is real, and what is simulated

Real, and tested:

- The **Dynamic Token Engine** — log-normal duration model with hierarchical shrinkage, conditional
  residual estimation for the consultation in progress, blackout intervals, variance propagation,
  P50/P80 windows and confidence.
- **Queue service** — fractional-rank ordering, the full token state machine, drag-and-drop reorder,
  configurable delay-penalty policy with the travel exemption, priority insertion, grace-period sweep.
- **Event sourcing** — transactional outbox, per-session ordering, projections rebuildable from the log.
- **Notification materiality** — position thresholds with hysteresis, a single shared ETA baseline,
  debounce, coalescing, per-patient rate cap, and the push → Viber → SMS cascade.
- **Billing** — payer adapters, split billing, claim lifecycle, rejection worklist and analytics, GST treatment.
- **Partner API** — OAuth2 client credentials and scopes, two-phase booking, idempotency, per-partner
  allocation caps, HMAC-signed webhooks with retry/dead-letter/replay, SSE streaming, RFC 9457 errors.
- **Analytics** — punctuality, revenue, volume, and the calibration metrics.

Simulated, behind an adapter, because the integration is an **unverified assumption**
(see [`docs/01-market-context.md`](docs/01-market-context.md) §4):

| Assumption | What is stubbed | What is real |
|---|---|---|
| A1 Aasandha | Eligibility responses and claim adjudication | The whole clinic-side workflow, and the **degraded mode** that ships first: submission-ready batches, manual status entry, rejection worklist |
| A2 eFaas | Identity verification | Demo persona sign-in; the phone + national-ID fallback path |
| A3 BML / m-Faisaa | Payment authorisation | Invoicing, split billing, settlement state, refunds |
| A4 Viber / SMS | Message transport | Channel cascade, delivery ledger, costing, prepaid wallet |

Nothing here claims a partnership we do not have.

## Is the estimate honest?

The product rests on one number: does the published window actually contain the time the patient
is seen? `npm test` runs a Monte-Carlo harness that replays synthetic sessions against the pure
estimator — no HTTP, no simulator, deterministic seed:

```
calibration: n=12806 coverage=80.1% bias=1.2 min
```

80% of actual starts fall inside the published 80% window, with no material optimism. **Positive
bias is treated as a bug, not a tuning preference** — it is the failure that destroys trust fastest.
The clinic dashboard reports the same three metrics measured live, from real events, at a fixed
15-minute lead time (Analytics → *Is the estimate honest?*).

Three defects were found by writing that harness and are fixed in this code: hierarchical shrinkage
double-counting the same observations at every bucket level, published quantiles that could land
inside a prayer pause, and the two ETA-movement rules keeping separate notification baselines.

## Layout

```
server/
  engine/          duration-model · projector · engine · materiality
  services/        queue · scheduling · billing · messaging · webhooks
                   notify · analytics · simulator · ground-truth · symptom-router · i18n
  routes/          clinic · patient · partner · demo
  lib/             clock (virtual) · mvtime (UTC+5, Fri–Sat weekend, prayer times) · util
  db.js  seed.js  realtime.js  index.js
web/
  site/            marketing website
  clinic/          receptionist board · doctor module · patients · billing · analytics · messages · settings
  app/             patient app — discovery · live tracker · wallet · alerts
  shared/          design tokens · UI components · DOM and API helpers
test/              engine.test.js (19) · api.test.js (21) · tenancy.test.js (21)
docs/              the PRDs and specifications this was built from
```

No bundler and no build step. The dashboard is a PWA-shaped vanilla-ES-module app because clinics
run whatever hardware they have — old Windows desktops, Android tablets, iPads — and the board has
to stay fast on all of them.

## Documents

| Document | What it covers |
|---|---|
| [`docs/01-market-context.md`](docs/01-market-context.md) | Why the Maldives is a distinct market, platform strategy, assumptions A1–A7, competitive set |
| [`docs/02-prd-b2b-clinic-command-center.md`](docs/02-prd-b2b-clinic-command-center.md) | **B2B PRD** — the four modules, receptionist and doctor journeys, pricing strategy, rollout, risks |
| [`docs/03-prd-b2c-patient-app.md`](docs/03-prd-b2c-patient-app.md) | **B2C PRD** — the four features, personas, UX flow, edge cases, acquisition plan |
| [`docs/04-dynamic-token-engine.md`](docs/04-dynamic-token-engine.md) | Engine architecture: estimation model, event pipeline, materiality rules, degradation ladder |
| [`docs/05-partner-api-and-webhooks.md`](docs/05-partner-api-and-webhooks.md) | Partner API blueprint and the webhook catalogue |
| [`docs/api/openapi.yaml`](docs/api/openapi.yaml) | Machine-readable API sketch |

## Local decisions worth knowing

These are in the data model, not a translation file:

- **Prayer pauses** are first-class blackout intervals. An engine that treats a session as one
  continuous block is visibly wrong five times a day here.
- **The weekend is Friday–Saturday.** Nothing assumes Sat–Sun.
- **Sessions, not office hours.** Clinics run split morning/afternoon/evening sessions, evening busiest.
- **Multi-payer by default.** Aasandha covers citizens; a large expatriate workforce is on employer
  cover or self-pay. Split billing is the normal transaction.
- **Dhivehi is right-to-left Thaana.** RTL is structural. The copy itself is a translation task with a
  named owner — untranslated strings fall back to English rather than shipping wrong Dhivehi, and
  `i18n.pendingTranslations()` reports what is outstanding.
- **Travel-flagged patients are never silently demoted.** A patient who took a three-hour ferry and
  was moved back for being six minutes late will not come back, and will tell the island.
- **Doctor punctuality never leaves the clinic** — not to patients, not through the API. The engine
  depends on doctors pressing Start and End; they will stop if it becomes a leaderboard.

## Status

Working demo, not production. Sign-in is username + password with lockout; production adds
password-strength rules, session revocation UI, and for hospitals SSO. SQLite rather than Postgres. Simulated
external counterparties as described above.
