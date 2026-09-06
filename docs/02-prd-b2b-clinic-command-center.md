# PRD — Vaguthu Clinic
## Cloud Clinic CRM & Queue Management Dashboard (B2B SaaS)

**Status:** Draft v1.0 for review · **Owner:** Senior Product Manager, B2B
**Reviewers:** Engineering Lead, Clinical Advisor, Head of Sales, Legal/Compliance
**Last updated:** 2026-09-06 · **Target GA:** Q2 pilot, Q3 general availability

> Read [`01-market-context.md`](01-market-context.md) first. Assumptions A1–A7 referenced throughout are defined there.

---

## 1. Product vision

**Vaguthu Clinic is the operational brain of a Maldivian clinic.**

It replaces the paper register, the whiteboard, and the reception-desk phone as the place where the truth about *who is being seen, who is next, and when* lives. It is fast enough that a receptionist mid-rush prefers it to shouting across the room, and simple enough that a doctor between patients uses it without training.

It works entirely on its own. It also exposes a public API so that patient apps — ours and other people's — can read the queue and inject bookings into it. The clinic never has to choose a patient-app ecosystem to get value from us.

### What it is not
- Not an EMR. We store the *operational* record (who, when, which doctor, which payer, what was charged), not the clinical record (diagnosis, notes, prescriptions). We integrate with EMRs; we do not become one in v1. Clinical documentation is a deliberate v2+ decision gated on regulatory review.
- Not a telemedicine platform.
- Not a pharmacy or lab information system, though we expose hooks for both.

### Design principles

1. **The queue board is the product.** Every other screen is a supporting act. If a change makes the board slower or busier, it does not ship.
2. **Sub-second or it is broken.** Target p95 interaction latency under 250 ms on a mid-range Android tablet over a typical clinic connection. A receptionist with a queue of twelve people will abandon software that makes them wait.
3. **Degrade, never block.** Aasandha down, internet down, engine down — the receptionist can still check a patient in. Clinical operations do not stop because our software has a bad day.
4. **Truthful estimates over flattering ones.** We publish a range, we publish it with a confidence, and we revise it loudly. A confidently wrong ETA destroys the product's credibility faster than no ETA at all.
5. **Localisation is structural, not cosmetic.** Thaana RTL, Friday–Saturday weekends, prayer-time pauses, Ramadan schedules, and multi-payer billing are in the data model, not in a translation file.

---

## 2. Users, roles & permissions

| Role | Primary surface | Core need | Notable permissions |
|---|---|---|---|
| **Receptionist** | Command Center (queue board) | Move people through the door without losing track of anyone | Create/edit/reorder tokens, check in, collect payment, run eligibility, send messages. Cannot see clinic-wide financials or edit doctor schedules. |
| **Doctor** | Doctor Module | Two buttons and no distractions | Start/End/Pause own session, mark no-show, add a note to a token, view own day. Cannot reorder the global queue (can *request* a reorder). |
| **Clinic Admin / Owner** | Admin & Analytics | Know whether the clinic is working | Everything in the clinic: schedules, staff, pricing, payer config, all reports, billing settings. |
| **Billing Officer** | Billing workspace | Get claims paid | Claims, invoices, refunds, payer reconciliation. Read-only on the queue. |
| **Group Admin** (multi-site) | Cross-clinic console | Compare and standardise across branches | Everything, across all sites in the group; can define group-level templates. |
| **Vaguthu Support** | Impersonation console | Fix things | Time-boxed, consent-gated, fully audit-logged read/write. Every impersonation session produces an immutable audit entry visible to the Clinic Admin. |

**Access model:** role-based, scoped to `clinic_id`, with a `group_id` scope above it. Every mutation writes an audit record (`actor`, `action`, `entity`, `before`, `after`, `at`, `ip`, `device`). Audit log is append-only and exportable — this is both a compliance requirement under A5 and a sales asset.

---

## 3. Personas

**Shaira — Senior Receptionist, 5-doctor general clinic, Malé.**
Nine years at the desk. Handles roughly 140 patients across three sessions on a busy Sunday, plus a phone that rings continuously. Knows every regular patient by voice. Her current system is a paper register, a whiteboard with token numbers, and her memory. Her worst moment of the day is when a doctor arrives 40 minutes late and eleven people who are already in the lobby need to be told something. She is fast on a keyboard and has no patience for confirmation dialogs. **Her measure of good software: does it reduce the number of times someone asks her "how long more?"**

**Dr. Hassan — Internal Medicine, works evening sessions across two clinics.**
Sees 22–30 patients in a three-hour evening session. Runs late roughly half the time, usually because two or three consultations genuinely need 20 minutes instead of 8. Deeply resistant to software that adds clicks between patients. Will not read a manual. **His measure of good software: it does not slow him down, and it stops the receptionist from interrupting him to ask how he is doing.**

**Ahmed — Clinic Owner / Admin, 15-doctor multi-specialty centre, Malé.**
Runs the business. Cannot tell you today, with confidence, which of his doctors habitually start late, what his per-doctor revenue is this month, or how many Aasandha claims are stuck in rejection. Has been quoted a six-figure MVR figure by a legacy HMS vendor and is unconvinced. **His measure of good software: it tells him something he did not already know, every week.**

---

## 4. Module 1 — Receptionist Command Center

### 4.1 The unified queue board

One screen. Every patient in the building or expected in the building, regardless of how they got there.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  ● LIVE   Sunday 6 Sep · Evening session          [Search: name / ID / phone]  ⌘K │
├──────────────────────────────────────────────────────────────────────────────────┤
│  Dr. Hassan · Internal Med   │  Dr. Aminath · Paeds      │  Dr. Rasheed · ENT    │
│  ▶ Running 18 min late       │  ✓ On time                │  ⏸ Paused — prayer    │
│  Now serving: A-14 (7 min)   │  Now serving: B-09        │  Resumes 18:35        │
│  ─────────────────────────── │ ───────────────────────── │ ───────────────────── │
│  ▸ A-15  Ibrahim M.   19:02  │  ▸ B-10  Aisha K.  18:40  │  ▸ C-06  Nadia S.     │
│    ⬤ App  Aasandha ✓         │    ⬤ Walk-in  Self-pay    │    ⬤ Phone  Allied ✓  │
│    [Notify] [Call] [⋮]       │    ⚠ Payment pending      │    ⏱ Arrived 17:50    │
│  ─────────────────────────── │ ───────────────────────── │ ───────────────────── │
│  ▸ A-16  Fathimath R. 19:14  │  ▸ B-11  Hussain A.       │  ▸ C-07  Ali Z.       │
│    ⬤ App  ✈ From Naifaru     │    ⬤ App                  │    ⬤ Walk-in          │
│    ⚑ Travel flag             │    ✓ Checked in 18:20     │    ⚠ Not arrived      │
├──────────────────────────────────────────────────────────────────────────────────┤
│  UNASSIGNED / HOLDING (3)         [+ Walk-in]  [+ Phone booking]  [Broadcast ⚡]  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Column per doctor session.** Cards are tokens. Everything is drag-and-drop between and within columns.

#### Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1.1 | The board merges tokens from all sources — walk-in, phone, app (Vaguthu B2C), and third-party API — into a single ordered queue per doctor session. Source is visible on every card but does **not** change how a token is handled. | P0 |
| FR-1.2 | Board updates propagate to all connected clients in under 1 second via WebSocket, with automatic reconnect and state reconciliation on drop. | P0 |
| FR-1.3 | Drag-and-drop reordering of tokens within a session; drag between sessions reassigns the doctor and re-queues. Both trigger immediate ETA recalculation (see [`04-dynamic-token-engine.md`](04-dynamic-token-engine.md)). | P0 |
| FR-1.4 | Every card shows: token number, patient name, source, payer + eligibility state, arrival state, predicted start window, and any operational flags (travel, priority, payment pending, first visit). | P0 |
| FR-1.5 | Global command palette (⌘K / Ctrl-K) supporting patient search by name, national ID, phone, or token; and verb commands ("check in", "add walk-in", "notify all"). Keyboard-first operation of every P0 action. | P0 |
| FR-1.6 | Add walk-in in ≤ 3 interactions: phone number → (auto-match existing patient or create) → assign doctor. Token issued and printable. | P0 |
| FR-1.7 | Phone booking capture on the same form, with a "booked by phone" source flag and optional callback number. | P0 |
| FR-1.8 | Holding area for tokens not yet assigned to a doctor (triage pending, wrong doctor, arrived-for-a-cancelled-session). | P1 |
| FR-1.9 | Offline mode: check-in, walk-in creation, and calling the next patient work with no connectivity, queued locally, reconciled on reconnect with conflict surfacing. | P1 |
| FR-1.10 | Full RTL layout in Dhivehi (Thaana), including the drag-and-drop board, with mixed-direction text handled correctly (Dhivehi names alongside Latin token IDs). | P0 |
| FR-1.11 | Token printing to a thermal receipt printer (ESC/POS over USB/network), showing token, doctor, predicted window, and a QR code that deep-links into the B2C app for live tracking. | P1 |

#### Priority and clinical override
Some patients must jump the queue. The board supports **priority insertion** with a required reason code (`clinical_urgency`, `elderly`, `pregnant`, `disability`, `staff_referral`, `travel_constraint`, `other + free text`). Priority insertions are logged and surfaced in the Admin analytics as a rate per receptionist per doctor — not to police staff, but because a clinic where 30% of tokens are "priority" has a scheduling problem, not a compassion problem.

### 4.2 Delay penalties and no-show handling

"Delay penalty" is the clinic-side rule that decides what happens to a patient who is not present when called. It is **configurable per clinic** because clinic cultures genuinely differ, and a hardcoded rule would be wrong for most of them.

| Policy object | Description | Default |
|---|---|---|
| `grace_period_minutes` | Time after a token is called before penalty logic applies | 5 min |
| `penalty_mode` | `move_back_n` \| `move_to_end` \| `hold_for_recall` \| `none` | `move_back_n` |
| `move_back_positions` | Positions demoted when `move_back_n` | 2 |
| `max_penalties_before_noshow` | After N demotions the token is marked no-show | 2 |
| `noshow_release_behaviour` | Whether the slot is released to walk-ins or held | `release` |
| `travel_flag_exemption` | Tokens flagged as inter-island travellers are exempt from automatic demotion and require manual action | `true` |
| `late_arrival_penalty` | Applies when a patient checks in after their predicted window closes | `move_back_n` (1) |

Two design decisions worth defending:

- **The travel exemption is not sentimentality; it is retention.** A patient who took a 3-hour ferry and got demoted for being 6 minutes late will never use the clinic — or our app — again. The system flags them and forces a human decision instead of applying a rule.
- **Penalties are always reversible with one click, and always logged.** The receptionist is the authority; the software is the memory.

Every penalty event fires a notification to the patient explaining exactly what happened and what it means for their new expected time. A silent demotion is worse than no system at all.

### 4.3 Messaging: Viber and SMS dispatch

| ID | Requirement | Priority |
|---|---|---|
| FR-1.20 | Per-token one-tap dispatch of templated messages: `token_confirmed`, `queue_position_update`, `leave_now`, `you_are_next`, `called`, `delay_notice`, `session_paused`, `session_cancelled`, `payment_link`, `follow_up_reminder`. | P0 |
| FR-1.21 | Channel cascade: **Viber → SMS fallback** on non-delivery within a configurable window (default 90 s), plus push if the patient has the app. Never send the same message on two channels simultaneously. | P0 |
| FR-1.22 | Broadcast to all waiting patients of a session — used when a doctor is delayed or a session is cancelled. Requires confirmation and shows recipient count and estimated cost before sending. | P0 |
| FR-1.23 | Templates in Dhivehi and English, per-patient language preference, with a merge-field editor for Clinic Admins and a preview that renders Thaana correctly. | P0 |
| FR-1.24 | Automated triggers configurable per clinic: notify at N tokens ahead, notify on ETA change > X minutes, notify on pause. Defaults tuned to avoid spam (see notification materiality rules in the Token Engine doc). | P0 |
| FR-1.25 | Message ledger per patient — every message, channel, status, and cost — visible to the receptionist so "I never got a message" is answerable in two seconds. | P1 |
| FR-1.26 | Messaging wallet with prepaid balance, low-balance warning, and hard stop with clear escalation. Transactional queue messages continue on a small overdraft buffer; marketing messages stop immediately. | P1 |
| FR-1.27 | Quiet hours per clinic; overridable for urgent operational messages (`session_cancelled`, `called`). | P2 |

**Cost control is a product feature.** Messaging is the largest variable cost in the system and the easiest thing to accidentally 10×. The trigger configuration UI shows a projected monthly message volume and cost based on the clinic's actual token history whenever a rule is changed.

### 4.4 Check-in, patient record, and CRM surface

The "CRM" in the product name is deliberately modest in v1: a clean patient record with the operational history that a receptionist actually uses.

- Patient profile: identity (name, national ID / passport, eFaas link where available, DOB, gender, phone, language preference), payer(s), emergency contact, notes, travel origin island.
- Visit history: every token — doctor, date, wait time, outcome (seen / no-show / cancelled), charge, payer, claim status.
- Household linking: one account books for children and elderly parents. This is not a nice-to-have in this market; a single adult routinely manages care for three or four people.
- Recall / follow-up lists: "patients due for a 3-month review with Dr. Hassan" → bulk message with a booking link. This is the feature that turns the CRM claim into revenue for the clinic, and it is the strongest single upsell argument for the mid tier.
- Duplicate detection on create, matching on phone + national ID + fuzzy name, with a merge tool.

---

## 5. Module 2 — Doctor Module

### 5.1 Design brief

Dr. Hassan will use this on a second monitor, a tablet propped beside him, or a phone in his pocket. He will look at it for a total of perhaps 90 seconds across a three-hour session. Every second of attention we take from him is a second not spent on a patient, and he will punish us for it by not using the product.

**The entire screen is one patient and two buttons.**

```
┌───────────────────────────────────────────────────────┐
│  Evening session · 22 waiting · You are 18 min behind │
├───────────────────────────────────────────────────────┤
│                                                       │
│   Token A-14                                          │
│   Ibrahim Mohamed · 47 · Male                         │
│   Follow-up · Hypertension · Aasandha ✓               │
│   Last seen by you: 12 Jun 2026                       │
│                                                       │
│   ⏱  In consultation — 07:12                          │
│                                                       │
│   ┌─────────────────────┐  ┌────────────────────────┐ │
│   │   END & CALL NEXT   │  │   END (stay free)      │ │
│   └─────────────────────┘  └────────────────────────┘ │
│                                                       │
│   [No-show] [Need more time +10] [Pause session]      │
├───────────────────────────────────────────────────────┤
│  Next: A-15 Fathimath R. · New patient · ✈ Naifaru    │
└───────────────────────────────────────────────────────┘
```

### 5.2 Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-2.1 | `Start Patient` / `End Patient` as the two primary actions, each a single tap with no confirmation dialog. Undo available for 30 seconds. | P0 |
| FR-2.2 | `End & Call Next` combines ending the current consultation and starting the next — the single most-used control in the module. | P0 |
| FR-2.3 | Every start/end emits a timestamped event to the Dynamic Token Engine, which is what makes every downstream ETA real rather than theoretical. | P0 |
| FR-2.4 | `Pause session` with reason (`prayer`, `emergency`, `break`, `admin`, `other`) and an expected resume time. Pause immediately propagates to the board, to waiting patients, and to the API. | P0 |
| FR-2.5 | `Need more time` extends the current consultation's expected duration by a configurable increment, recalculating downstream ETAs *before* the overrun happens rather than after. | P1 |
| FR-2.6 | Mark no-show, triggering the clinic's configured penalty policy. | P0 |
| FR-2.7 | Doctor-initiated reorder **request**: the doctor can flag "see A-19 next" — this notifies the receptionist rather than mutating the queue directly, preserving a single point of queue authority. | P1 |
| FR-2.8 | Session start/end: the doctor opens and closes their own session. Session actual-start time versus scheduled start is the raw input to the punctuality metric. | P0 |
| FR-2.9 | Brief structured note per token (free text + optional follow-up interval). This is an operational note, not a clinical record, and is labelled as such in the UI. | P2 |
| FR-2.10 | Works fully on mobile web; no app install required for a doctor to run a session. | P0 |
| FR-2.11 | Ambient status line showing running-late delta, so the doctor learns their own punctuality without anyone having to tell them. | P1 |

### 5.3 On measuring doctors

Doctor punctuality data is politically live. A product that appears to be a surveillance tool will be blocked by the very doctors whose event stream we depend on.

Our position, and it is written into the UI copy:

- Punctuality metrics are **visible to the doctor first**, always, in their own view.
- Clinic Admin sees aggregate and per-doctor punctuality; individual consultation durations are shown as distributions, never as a ranked leaderboard.
- We never expose per-doctor punctuality to patients. Average wait for a *clinic* is public; "Dr. X is habitually 25 minutes late" is not.
- Consultation duration is explicitly framed in-product as a **scheduling input**, not a performance score. A doctor who takes 18 minutes per patient is not slow; they are mis-scheduled at 10-minute slots, and the product's job is to fix the schedule.

This framing is what makes FR-2.3 achievable. Without it, doctors stop pressing the buttons and the engine goes blind.

---

## 6. Module 3 — Billing & Insurance

### 6.1 Multi-payer architecture

Every charge resolves against a `PayerAdapter`. Four implementations at launch:

| Adapter | Covers | Interface | Assumption |
|---|---|---|---|
| `AasandhaAdapter` | Maldivian citizens under the national scheme | Eligibility check + claim submission + status polling | **A1 (low confidence)** |
| `PrivateInsurerAdapter` | Expatriate and top-up cover | Pre-auth where supported; otherwise invoice-and-reimburse | Per-insurer |
| `CorporateAccountAdapter` | Resort and company accounts billed monthly | Internal — no external dependency | None |
| `SelfPayAdapter` | Cash, card, BML, m-Faisaa | Payment rails below | **A3** |

Split billing is a first-class case, not an edge case: a consultation partly covered by Aasandha with a self-pay balance is the *normal* transaction, and the UI treats it that way.

### 6.2 Aasandha integration

| ID | Requirement | Priority |
|---|---|---|
| FR-3.1 | Eligibility check at check-in, keyed on national ID / eFaas identity, returning entitlement status and any scheme-level limits. Result cached for the visit and displayed on the queue card. | P0 |
| FR-3.2 | Eligibility failures never block check-in. The patient is checked in with a `payer_unverified` flag and the receptionist is prompted to resolve or convert to self-pay. | P0 |
| FR-3.3 | Claim construction from the visit record (service codes, doctor, date, payer) with clinic-configurable code mapping. | P0 |
| FR-3.4 | Claim submission, status tracking, and a rejection worklist with reason codes, resubmission, and an ageing view. | P0 |
| FR-3.5 | Reconciliation: match remittances against submitted claims, flag variances, and produce a payer-level statement. | P1 |
| FR-3.6 | **Degraded mode (A1 fallback):** if no API is available, the module produces submission-ready claim batches in the portal's required format, tracks status by manual entry, and still delivers the rejection worklist and reconciliation. The clinic keeps ~80% of the value with ~0% of the integration risk. | P0 |
| FR-3.7 | Rejection analytics: top rejection reasons by doctor, by service code, by month. This is the highest-ROI report in the entire product for a mid-size clinic. | P1 |

> **Scoping note for engineering:** FR-3.6 is P0 and FR-3.1/3.3/3.4 are P0 *conditional on A1 resolving positively*. Build the degraded path first. It is the only path we control.

### 6.3 Payments

| ID | Requirement | Priority |
|---|---|---|
| FR-3.10 | BML rails: card-present at the desk where the clinic has a terminal, plus hosted-checkout / payment-link for remote payment. | P0 |
| FR-3.11 | Ooredoo m-Faisaa wallet payment, initiated from the desk or via a link sent to the patient. | P0 |
| FR-3.12 | Pay-before-arrival: a payment link attached to the booking confirmation. Paid tokens are visually distinct on the board and skip the payment step at check-in — a real throughput gain at the desk, not just a convenience. | P1 |
| FR-3.13 | Webhook-driven settlement reconciliation; every payment carries an idempotency key; duplicate callbacks are safe. | P0 |
| FR-3.14 | Refunds and partial refunds with reason codes and full audit trail. | P1 |
| FR-3.15 | GST handling configurable per service line, with correct treatment of exempt medical services versus taxable non-medical items (certificates, reports, supplies). Invoice templates meet local tax-invoice requirements. | P0 |
| FR-3.16 | End-of-session cash reconciliation: expected versus counted, by staff member, by session. | P1 |

**We do not touch patient money.** Payments settle directly to the clinic's merchant account. We are not a payment facilitator, we do not hold funds, and our revenue comes from subscriptions — not from a cut of clinical revenue. This keeps us outside a licensing regime we have no business being inside, and it is a deliberate strategic choice, not a temporary one.

### 6.4 Pricing, invoicing, and the receipt

- Service catalogue per clinic: consultation types, procedures, certificates, each with a price, a payer-specific price override, and a tax treatment.
- Invoice on completion of a token, printable and sendable by Viber/SMS as a link.
- Doctor-share calculation where clinics pay doctors a percentage — a genuine administrative burden today, solved with a report.

---

## 7. Module 4 — Admin & Analytics

The analytics module answers four questions, and it is designed backwards from them. Every chart on the default dashboard has to earn its place by answering one.

### 7.1 "Are my doctors running on time?"

| Metric | Definition |
|---|---|
| Session punctuality | `actual_session_start − scheduled_session_start`, per doctor, per session, distribution over time |
| Mean / P50 / P90 consultation duration | Per doctor, per visit type — feeds the engine *and* the schedule |
| Overrun | `actual_session_end − scheduled_session_end` |
| Pause time | Total and by reason, separating prayer pauses (expected) from unplanned ones |
| Effective utilisation | Consulting time ÷ scheduled session time |
| Schedule fit score | How well the doctor's slot length matches their actual duration distribution — the actionable version of punctuality |

The output the Admin actually gets is a sentence: *"Dr. Hassan's median consultation is 14 minutes but he is scheduled at 10. Moving him to 15-minute slots would reduce average patient wait by 22 minutes and cost 4 appointment slots per session."* That is the product.

### 7.2 "How much money did we make, and from whom?"

Revenue by day/doctor/service/payer; collected versus billed versus claimed; outstanding claims by age; rejection value; average revenue per patient; doctor-share liabilities; payment-method mix.

### 7.3 "How many patients, and what happened to them?"

Volume by day/session/doctor/source; new versus returning; walk-in versus booked versus app versus API mix; no-show rate (by source — booked-via-app no-show rates versus phone bookings is a genuinely interesting number for a clinic); cancellation rate and lead time; median wait time and lobby dwell; peak-hour load heatmap for staffing decisions.

### 7.4 "Is the clinic getting better?"

Week-over-week wait time; ETA accuracy; message volume and cost per token; priority-insertion rate; queue-abandonment rate.

### 7.5 Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-4.1 | Live "today" dashboard: patients seen, waiting, average wait, revenue so far, doctors running late. Refreshes in real time. | P0 |
| FR-4.2 | Standard report set covering §7.1–7.4, with date range, doctor, and payer filters. | P0 |
| FR-4.3 | CSV and PDF export of every report. Non-negotiable — clinic owners want their numbers in Excel. | P0 |
| FR-4.4 | Scheduled weekly digest by email/Viber to the Clinic Admin, written as prose findings rather than a chart dump. | P1 |
| FR-4.5 | Schedule management: doctors, sessions, recurring templates, leave, holidays, Ramadan schedule variants, prayer-time blackout configuration. | P0 |
| FR-4.6 | Staff management, roles, and the audit log viewer. | P0 |
| FR-4.7 | Multi-site group console with cross-clinic comparison. | P2 |
| FR-4.8 | Anomaly surfacing: "Dr. Rasheed's no-show rate doubled this month", "claims rejected for code X are up 40%". Small number of high-signal alerts, not a firehose. | P2 |

---

## 8. User journeys

### 8.1 Receptionist — Shaira's Sunday evening session

**16:40 — Pre-session.**
Shaira opens the board. Three doctor columns for the evening. Dr. Hassan's column shows 19 tokens: 11 booked through the Vaguthu app, 4 by phone, 4 from an aggregator app via the API. Two cards carry a ✈ travel flag — patients coming from outer islands today. One card is amber: Aasandha eligibility could not be verified this morning. She taps it, re-runs the check, it clears, the card goes green. Elapsed: 40 seconds.

**16:55 — The delay.**
Dr. Hassan messages that he is stuck and will arrive at 17:25 instead of 17:00. Shaira opens his column, taps `Delay session`, enters 25 minutes.

Everything downstream happens without her: the engine recomputes all 19 predicted start windows; the board redraws; every patient with a token receives a Viber message in their preferred language stating the new estimate and their position; the two travel-flagged patients get an additional line noting they can confirm whether they still want the slot; the three tokens whose windows have moved past the session's scheduled end are highlighted for her to decide about. The aggregator app that sold four of tonight's slots receives a `queue.session.delayed` webhook and updates its own users. Elapsed: 15 seconds of her time.

**Without the product, this is eleven phone calls she does not have time to make, so instead eleven people sit in the lobby for 25 extra minutes and blame her.**

**17:10 — Walk-ins.**
A patient arrives without a booking. Shaira presses `W`. Types a phone number. The system finds an existing record — a patient from four months ago — and pre-fills. She picks Dr. Hassan, the token prints with a QR code, and she tells the patient their expected window is 18:50–19:15 and that they can scan the code and wait at the café. This exchange takes 25 seconds and replaces a five-minute conversation about how long the wait will be.

**17:25 — Session start.** Dr. Hassan taps `Start session` on his tablet. The board goes live. The engine switches from schedule-based prediction to observation-based prediction.

**18:05 — The overrun.**
Consultation A-14 has been running 22 minutes against an 11-minute expectation. The engine has already detected the overrun and pushed windows back; patients whose ETA moved more than 15 minutes have been notified automatically. Shaira does nothing. This is the point of the product: **the common case requires no human intervention at all.**

**18:20 — A patient is not there.**
A-15 is called. No answer. The grace period runs; after 5 minutes the configured policy demotes the token two positions and sends a message: *"You were called and we could not find you. You are now token 2 in line, expected 18:55. Please tell reception when you arrive."* At 18:32 the patient walks in from the pharmacy downstairs, apologises, and is seen at 18:57. No argument occurs, because the rule was applied consistently and the patient was told.

**18:35 — Prayer pause.** Dr. Rasheed's column pauses automatically per the clinic's configured blackout, resumes at 18:35, and every affected ETA already accounts for it. Nobody was told to wait "a few minutes" and then left for twenty.

**20:50 — Close.**
Shaira runs end-of-session reconciliation: 61 patients seen, 3 no-shows, cash counted and matched, 14 Aasandha claims queued for submission, 2 flagged for missing service codes. She resolves both from the worklist. The day closes in four minutes instead of twenty-five.

### 8.2 Doctor — Dr. Hassan's evening

**17:24.** Opens the tablet, taps `Start session`. He sees one line: *22 waiting · scheduled end 20:00*.

**17:25.** Taps `Start Patient` for A-01. The screen shows name, age, visit type, payer, and his own last note about this patient. He never looks at it again during the consultation.

**17:33.** Taps `End & Call Next`. One tap. Total interaction time this consultation: about two seconds. This is the entire design constraint of the module.

**18:05.** A complex case. He taps `Need more time +10` at the 12-minute mark. Downstream ETAs shift immediately and the affected patients are told *before* they start wondering. He does not have to tell the receptionist anything.

**18:40.** He wants to see A-19 next — an elderly patient who has been waiting a long time. He taps the token and selects `Request next`. Shaira gets an alert, agrees, and reorders. Two seconds for him; the queue keeps a single authority.

**19:15.** The status line reads *"You are 12 min behind."* Last month it habitually read 30. Nobody had a difficult conversation with him about it; he simply started seeing the number.

**20:12.** `End session`. His summary: 24 patients, median 11 minutes, started 25 minutes late (recorded reason: prior clinic overrun), finished 12 minutes over. Next to it, a suggestion: *"Your median is 11 min; you are scheduled at 10. Consider 12-minute slots."*

---

## 9. Technical architecture (summary)

The Dynamic Token Engine has its own document: **[`04-dynamic-token-engine.md`](04-dynamic-token-engine.md)**. Summary of the platform around it:

```
        Clinic dashboard (React, PWA)      Doctor module (mobile web)
                   │  WebSocket + REST              │
                   └──────────────┬─────────────────┘
                                  ▼
                        ┌────────────────────┐
                        │   API Gateway      │  authn/z, rate limit, tenancy
                        └─────────┬──────────┘
        ┌──────────────┬──────────┼───────────┬──────────────┐
        ▼              ▼          ▼           ▼              ▼
   Scheduling     Queue Svc   Billing Svc  Messaging     Partner API
   (slots,        (source of  (payers,     Orchestrator  (public,
    sessions)      truth)      claims,     (Viber/SMS/    OAuth2,
                       │       payments)    push)         webhooks)
                       │ outbox
                       ▼
                 Event bus  ──────►  Token Engine Workers ──► Redis projections
                (per-session                                       │
                 partitioned)                                      ▼
                       │                                    Fanout (WS/SSE,
                       ▼                                     push, webhooks)
                 Postgres (row-level tenant isolation)
                       │
                       ▼
                 Analytics store (nightly + streaming rollups)
```

**Choices and why:**
- **Postgres as the single source of truth**, with `clinic_id` on every row and row-level security enforced at the database, not just the application. Tenant leakage in a health product is an extinction-level event; belt and braces.
- **Outbox pattern** from Postgres to the event bus, so a queue mutation and its event are atomic. Losing a `consultation.ended` event silently corrupts every downstream ETA.
- **Per-session partitioning** on the bus gives us single-writer semantics per queue without distributed locks. A queue is at most a few dozen tokens; the whole recompute is a sub-millisecond in-memory pass.
- **PWA, not native, for the clinic.** Clinics use whatever hardware they have — old Windows desktops, Android tablets, iPads. A PWA installs on all of them, updates without app-store review, and works offline with a service worker.
- **Region choice** balances latency to the Maldives against A6. Data residency is a documented roadmap commitment with an in-country export path.

**Non-functional requirements**

| NFR | Target |
|---|---|
| p95 API latency | < 200 ms in-region |
| p95 board interaction latency | < 250 ms on a mid-range Android tablet |
| Queue event → all connected clients | < 1 s p95 |
| Availability | 99.9% monthly, measured during clinic operating hours |
| RPO / RTO | 5 min / 1 h |
| Offline tolerance (receptionist) | 60 min of core operations |
| Encryption | TLS 1.3 in transit; AES-256 at rest; field-level encryption for national ID and payer identifiers |
| Audit | Every PHI read and every mutation logged, immutable, exportable |
| Data subject rights | Export and erasure workflows built to a GDPR-equivalent baseline (A5) |
| Localisation | Dhivehi (Thaana, RTL) and English at parity; date/time in Maldives time; Friday–Saturday weekend defaults |

---

## 10. SaaS pricing strategy

### 10.1 The value metric

We price on **active doctor seats**, and we make receptionist and admin seats free and unlimited.

Reasoning:
- Doctor seats track clinic throughput, which tracks the value we deliver, which tracks ability to pay. A 15-doctor centre gets roughly 15× the value of a solo clinic and can pay accordingly.
- Charging per receptionist seat would be actively harmful: it would push clinics to share logins, which destroys our audit trail and our per-staff analytics. Never price a metric you need to be accurate.
- Charging per patient or per token would make the clinic ration usage of the exact behaviour we want to maximise — putting every patient in the system. Any pricing model that makes a clinic think twice before adding a walk-in is a bad model.

Messaging is metered separately and passed through at a small margin, because it is a genuine variable cost and clinics understand and accept telco-style billing.

### 10.2 Tiers

Prices in MVR per month, billed monthly; annual prepay discounted 15%. GST added per local rules.

| | **Solo** | **Clinic** | **Multi-Specialty** | **Enterprise** |
|---|---|---|---|---|
| **Target** | 1 doctor, 1 receptionist | 2–5 doctors | 6–15 doctors, multi-specialty | 15+ doctors, hospitals, groups |
| **Price** | **MVR 749/mo** | **MVR 2,450/mo** (incl. 3 doctors) | **MVR 6,900/mo** (incl. 8 doctors) | **From MVR 15,000/mo**, custom |
| **Extra doctor seat** | n/a (upgrade) | MVR 550/mo | MVR 450/mo | negotiated |
| *≈ per doctor at tier midpoint* | ~MVR 749 | ~MVR 610 | ~MVR 500 | ~MVR 350–450 |
| Queue board, unlimited staff seats | ✓ | ✓ | ✓ | ✓ |
| Doctor module | ✓ | ✓ | ✓ | ✓ |
| Dynamic Token Engine + ETAs | ✓ | ✓ | ✓ | ✓ |
| Viber/SMS dispatch | ✓ metered | ✓ metered | ✓ metered | ✓ metered |
| Bookings from Vaguthu patient app | ✓ | ✓ | ✓ | ✓ |
| Payments (BML, m-Faisaa) | ✓ | ✓ | ✓ | ✓ |
| Aasandha eligibility check | ✓ | ✓ | ✓ | ✓ |
| Aasandha claims + rejection worklist | — | ✓ | ✓ | ✓ |
| Private/corporate payer billing | — | ✓ | ✓ | ✓ |
| Analytics | Basic (today + 7-day) | Standard | Full + anomaly alerts | Full + custom |
| Recall / follow-up campaigns | — | ✓ | ✓ | ✓ |
| Partner API access (inbound bookings) | Read-only | ✓ | ✓ | ✓ |
| Multi-site group console | — | — | ✓ (up to 3 sites) | ✓ unlimited |
| Custom roles, SSO | — | — | — | ✓ |
| EMR / LIS integration | — | — | Add-on | ✓ |
| Data residency & custom DPA | — | — | — | ✓ |
| Support | Email, next business day | Email + Viber, 8h | Priority 4h + named CSM | 1h SLA, on-site onboarding |
| Onboarding | Self-serve + 1 remote session | Remote, 2 sessions | **On-site, 2 days** (MVR 7,500 one-off) | Custom SOW |

**Metered add-ons (all tiers)**
- Messaging wallet: SMS ~MVR 0.65/message, Viber ~MVR 0.25/message, push free. Prepaid, top-up in-app. Typical 5-doctor clinic: MVR 400–900/month.
- Additional site (Clinic tier): MVR 1,800/mo.
- Aasandha claims module for Solo: MVR 350/mo add-on.
- Historical data migration: from MVR 5,000 one-off.

### 10.3 Why these numbers

**Solo at MVR 749 (~USD 49).** This is deliberately priced against *inertia*, not against competitors. A solo practitioner's alternative is a paper book that costs nothing. The number has to be small enough to be an impulse decision by an owner-operator — comparable to a mobile plan or a couple of consultation fees — and it has to survive the sentence "it pays for itself if it prevents two no-shows a month." At an average consultation fee in the MVR 300–500 range, that sentence is true, and it is the entire Solo sales pitch. We accept a thin margin here because Solo clinics are our volume tier, our word-of-mouth engine, and our patient-supply for the B2C app.

**Clinic at MVR 2,450 (~USD 159) including 3 doctors.** The step from Solo is justified by the Aasandha claims module and recall campaigns — both of which have a directly calculable return. A 4-doctor clinic recovering even 3 rejected claims a month at MVR 400 each, or filling 8 recall appointments, has covered the subscription. The seat overage at MVR 550 is priced *above* the per-doctor rate at the top of the tier so that a 6-doctor clinic finds upgrading to Multi-Specialty cheaper than adding seats. Expansion should feel like a saving, not a penalty.

**Multi-Specialty at MVR 6,900 (~USD 450) including 8 doctors.** For Ahmed's 15-doctor centre: MVR 6,900 + 7 × MVR 450 = **MVR 10,050/month** (~USD 650), about MVR 670 per doctor. Benchmarks that make this defensible in the room:
- It is a fraction of one receptionist's monthly salary, and the product measurably reduces desk load.
- Legacy HMS quotes in this market run to six figures MVR up front plus annual maintenance and a server, with none of the queue intelligence and no patient-facing surface. Our first-year total cost is materially lower with no capital outlay.
- Against his own revenue: a 15-doctor centre seeing ~350 patients/day at an average MVR 400 does roughly MVR 3.5m/month. We are asking for **under 0.3% of revenue**. Framed that way — and it always is framed that way in the pitch — the conversation stops being about price.
- The single most persuasive line for this buyer is not a feature. It is: *"You currently cannot tell me which of your fifteen doctors starts late. In four weeks you will know, with numbers, and so will they."*

**Enterprise from MVR 15,000.** Custom because the deal is about data residency (A6), integration with an existing HMS/EMR, procurement process, and SLA — not about seat count. Expect long cycles and treat the first two as reference-account investments.

### 10.4 Packaging decisions worth defending

- **We never gate the queue engine or the ETAs.** They are the product's soul and the source of B2C data. Gating them behind a higher tier would cripple the network we are trying to build. Everything gated is a *back-office* capability — claims, analytics depth, multi-site.
- **Free receptionist seats** are worth more to us as clean data than as revenue.
- **Free tier: no.** A free tier in a market of a few hundred clinics cannibalises the paying base and generates support load we cannot serve. Instead: **60-day free pilot with hands-on onboarding**, capped at a target number of concurrent pilots. Scarcity plus service beats freemium here.
- **Atoll clinic programme:** 50% discount for clinics on islands outside Greater Malé, indefinitely. Justification is not charity — it is that atoll coverage is what makes the B2C app's travel value proposition real, and it positions us for public-sector procurement. This is a marketing budget line, accounted for as such.
- **Annual prepay at 15%** matters more than usual here: it improves cash collection in a market with long payment habits.

### 10.5 Unit economics sanity check (Clinic tier, 4 doctors)

| Line | MVR/month |
|---|---|
| Subscription (2,450 + 1×550) | 3,000 |
| Messaging margin (~2,000 msgs, ~30% margin) | ~180 |
| **Gross revenue** | **~3,180** |
| Infrastructure + third-party per clinic | ~(280) |
| Support allocation | ~(400) |
| **Gross margin** | **~78%** |

Target CAC MVR 9,000–14,000 (2 sales visits + 2 onboarding days). Payback **~4–5 months**, well inside a 12-month target for a market where the sales motion is in-person and relationship-driven. Target logo churn under 8% annually — sticky because the queue is the clinic's operational memory, and the switching cost is measured in patient history and staff habit, not in data export.

---

## 11. Partner API and webhooks

Full specification: **[`05-partner-api-and-webhooks.md`](05-partner-api-and-webhooks.md)** and the machine-readable sketch in [`api/openapi.yaml`](api/openapi.yaml).

Summary of the commitment made here: the clinic — not Vaguthu — controls which partners can read its queue and write bookings into it, per-partner, with a per-partner slot allocation and an on/off switch that takes effect immediately. A clinic that is nervous about "letting an app control my queue" must be able to see exactly what a partner can do and revoke it in one click. Without that control surface, no clinic will enable the API, and the whole platform strategy stalls.

---

## 12. Rollout plan

| Phase | Duration | Scope | Exit criteria |
|---|---|---|---|
| **0 — Discovery** | 4 wks | 15 clinic interviews; time-and-motion at 3 reception desks; A1–A4 partnership conversations opened | Spec frozen; A1 and A3 resolved to go/no-go |
| **1 — Design partner alpha** | 8 wks | Queue board + Doctor module + engine, 2 clinics, free, on-site presence | Doctors press the buttons unprompted for 2 consecutive weeks; ETA P80 accuracy > 60% |
| **2 — Pilot** | 10 wks | + messaging, payments, eligibility. 8 clinics, paid pilot pricing | 6 of 8 convert to paid; NPS > 40; wait-time reduction demonstrated in ≥ 4 clinics |
| **3 — GA (B2B)** | — | + claims, full analytics, self-serve onboarding | 25 paying clinics |
| **4 — Platform** | +8 wks | Partner API public, B2C app launch | 3 third-party integrations live; see B2C PRD |

**Explicitly out of scope for v1:** clinical documentation/EMR, e-prescribing, lab and imaging orders, inventory/pharmacy, telemedicine, patient-reported outcomes, HR/payroll. Each is a credible future module; none is required to prove the thesis.

## 13. Key risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Doctors stop pressing Start/End** — the engine goes blind and every ETA becomes fiction | Critical | Ruthless simplicity in the Doctor module; punctuality framed as scheduling not surveillance (§5.3); a fallback estimator that infers consultation boundaries from receptionist check-in events, degraded but not dead; monitored per-doctor "event completeness" score that triggers a CSM call, not an automated nag |
| Aasandha API does not materialise (A1) | High | Degraded mode is P0 and ships first (FR-3.6) |
| Clinic refuses cloud PHI (A6) | High | Regional hosting, documented residency roadmap, in-country export, GDPR-equivalent baseline as a sales asset |
| Market too small to sustain the business | High | Deliberate architectural neutrality: nothing Maldives-specific outside adapter implementations and localisation. The same product serves comparable small-island and regional markets |
| Messaging costs surprise a clinic | Medium | Prepaid wallet, cost preview on every rule change, projected-spend dashboard |
| A large hospital builds this internally | Medium | We are not selling to them first; by the time they consider it we are the rail their patients already use |
| Receptionist rejects the tool under rush conditions | High | Keyboard-first design, on-site onboarding included in mid/high tiers, and a hard rule that paper-to-digital transition happens with a Vaguthu person physically at the desk for the first two days |

## 14. Open questions

1. Do we hold any position on clinical documentation, or stay strictly operational? (Decision gate: end of Phase 2. Recommendation: stay operational; partner for EMR.)
2. Does the atoll discount extend to government-run island health centres, and does that put us into public procurement earlier than we want?
3. Should the Solo tier be sold self-serve at all, or does every clinic in this market need a human visit? (Test in Phase 3.)
4. Do we charge partners for API access, or is it free to maximise rail adoption? (Recommendation: free at launch, revisit once ≥ 5 partners are live and volume is meaningful.)
5. Who owns the patient record — the clinic, the patient, or the platform? This has a legal answer (A5) and a product answer, and they may differ. Needs counsel before GA.
