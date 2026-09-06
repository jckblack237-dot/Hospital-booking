# PRD — Vaguthu
## Patient Booking & Live Token Tracking App (B2C)

**Status:** Draft v1.0 for review · **Owner:** Senior Product Manager, Consumer
**Reviewers:** Design Lead, Engineering Lead, Growth, Clinical Advisor, Legal
**Last updated:** 2026-09-06 · **Target:** Public launch 6 weeks after B2B GA in ≥ 12 clinics

> Read [`01-market-context.md`](01-market-context.md) first. This app is a client of the [Partner API](05-partner-api-and-webhooks.md) and the [Dynamic Token Engine](04-dynamic-token-engine.md).

---

## 1. Vision

**Stop making sick people sit in a room to find out when they will be seen.**

Vaguthu tells a patient exactly which token the doctor is on right now, when their own turn is likely to come, and — the part that changes behaviour — **when to leave for the clinic**. They wait at home, at work, or at a café down the road, and they walk in when it is nearly their turn.

The lobby stops being an information-gathering device.

### Positioning

*"Waze for the clinic queue."* You do not stare at the road ahead to guess your arrival time; the app watches traffic and tells you. Same idea, same emotional payoff: **the removal of uncertainty is the product**, and the time saved is the proof.

### What success looks like for a patient
- They know their position without asking anyone.
- They are told when to leave, and when they arrive they are seen within about 15 minutes.
- When something goes wrong — the doctor is late, the queue is paused, a claim is rejected — they hear it from us first, with an explanation and a choice.

### What we will not do
- No symptom-to-diagnosis engine. We route by symptom to a *specialty*; we never suggest what a patient might have. That is a regulatory and safety line we do not go near.
- No telemedicine in v1.
- No doctor ratings or reviews in v1. In a market where a specialty may have four practitioners in the entire country, a review system does more harm than good, and it would end our relationship with the doctors whose event stream the whole platform depends on.
- No selling of patient data. Ever, and stated in-product in plain language.

---

## 2. Personas

### Aishath — 29, marketing executive, lives in Hulhumalé, works in Malé

They leave the house at 07:20, cross the bridge by bus, and work until 17:00. Their doctor's evening session starts at 20:00 at a clinic on Majeedhee Magu. Today's plan, without us: arrive at 19:45, sit, wait, be seen at 21:10, get home at 22:00.

They are comfortable with apps, pay for everything on their phone, and are in six Viber groups. Their frustration is not the waiting — it is that the waiting is **unbounded and uninformative**. If someone told them "be there at 20:50", they would happily eat dinner first.

- **Job to be done:** *convert an unknown wait into a known appointment time.*
- **Behaviour we want:** book in the app, ignore it until the "leave now" push, arrive 10 minutes before their turn.
- **Retention hook:** the app is where their bookings and their Aasandha details live. Booking anywhere else is more work.
- **Kills the product for them:** two bad ETAs. They will go back to arriving early and never open it again.

### Fathimath — 34, from Naifaru (Lhaviyani Atoll), travelling with a 4-year-old for a paediatric appointment

The child has a paediatric referral to a specialist who only practises in Malé. Getting there is a ferry or a speedboat, then a night at a relative's flat in Malé. The appointment is at 16:30. If the doctor is running two hours late, they miss the return ferry and pay for another night.

Data is patchy on the boat. They use Viber constantly and Facebook heavily; they are less comfortable with app-based payments and would rather pay at the desk. They are booking for someone else — the patient is their child.

- **Job to be done:** *make a multi-day, multi-hundred-rufiyaa trip predictable, and know the night before whether it is still on.*
- **Behaviour we want:** book ahead, register a travel flag, receive an early-warning message the previous evening and the morning of, and get a real human escalation path if the session is cancelled.
- **Retention hook:** the digital wallet — referral letter, Aasandha details, child's ID — in one place, so nothing is left on the island.
- **Kills the product for them:** finding out about a cancellation *after* they arrive in Malé. One occurrence and we have lost them, and they will tell everyone on the island.

**These two personas pull the product in different directions, and both directions are correct.** Aishath needs precision inside a two-hour window. Fathimath needs early warning across a two-day window and tolerance for bad connectivity. The design must serve both; §5 covers where they diverge.

---

## 3. Feature 1 — Doctor discovery

### Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-B1.1 | Search and browse by **specialty**, with a symptom-to-specialty router (plain-language input in Dhivehi or English → suggested specialties, with an explicit "this is not medical advice" framing) | P0 |
| FR-B1.2 | Filter by **location**: Greater Malé (Malé / Hulhumalé / Vilimalé) versus atoll and island, with distance/travel context rather than raw kilometres | P0 |
| FR-B1.3 | Filter by **language spoken** — Dhivehi, English, Hindi/Urdu, Bengali, Sinhala, Tagalog. Genuinely load-bearing for a large share of this market, not a decorative filter | P0 |
| FR-B1.4 | Filter by **payer accepted**: Aasandha, named private insurers, self-pay | P0 |
| FR-B1.5 | Filter by **availability**: today, tomorrow, this week, evening sessions only | P0 |
| FR-B1.6 | Doctor profile: name, specialty, qualifications, languages, clinics, fee, payers accepted, next available slot, typical consultation length | P0 |
| FR-B1.7 | Gender-of-doctor filter — a real and frequently expressed preference in this market, particularly for O&G and paediatrics | P0 |
| FR-B1.8 | "Available now" view: doctors with a live session and a short queue, for same-day need | P1 |
| FR-B1.9 | Save favourite doctors and clinics; the home screen prioritises them | P1 |
| FR-B1.10 | Full Dhivehi (Thaana, RTL) and English, switchable, with Thaana search that tolerates common transliteration | P0 |

**Ranking:** availability first, then relevance to the query, then proximity, then favourites. **No paid placement.** In a market this small, a visibly pay-to-play ranking would destroy trust with both patients and clinics in a single news cycle, for revenue that is a rounding error against B2B subscriptions.

### The symptom router, and its guard rails

Fathimath types *"kujjaa ah hun aissa"* (child has a fever). Aishath types *"chest pain"*.

The router maps free text to specialties with a curated, clinically reviewed mapping — not a generative model. It has three hard behaviours:

1. **Red-flag interception.** A defined set of phrases (chest pain, difficulty breathing, severe bleeding, stroke symptoms, unresponsive child) immediately surfaces an emergency card with the national emergency number and the nearest emergency department, *above* any booking option. Booking remains available below, but the emergency information cannot be dismissed away from the first screen.
2. **Never names a condition.** Output is always "doctors who treat this" — never "you may have X."
3. **Fails to breadth, not to confidence.** Unrecognised input returns general practice plus a search box, never a guess.

---

## 4. Feature 2 — Live token tracking

The heart of the product. Everything else exists so that this screen can exist.

```
┌─────────────────────────────────────────────┐
│  ‹  Dr. Hassan · Malé Family Clinic         │
├─────────────────────────────────────────────┤
│                                             │
│              Your token                     │
│               ┌───────┐                     │
│               │ A-15  │                     │
│               └───────┘                     │
│                                             │
│         Now serving   A-13                  │
│         ●───●───○───○                       │
│              2 ahead of you                 │
│                                             │
│   ┌───────────────────────────────────────┐ │
│   │  Likely seen                          │ │
│   │       19:05 – 19:25                   │ │
│   │  ▮▮▮▮▮▮▮▯▯  Confidence: high          │ │
│   └───────────────────────────────────────┘ │
│                                             │
│   ┌───────────────────────────────────────┐ │
│   │  🚶 LEAVE IN ABOUT 22 MINUTES         │ │
│   │  ~10 min from where you're waiting    │ │
│   │  [I'm on my way]   [Change location]  │ │
│   └───────────────────────────────────────┘ │
│                                             │
│   ⓘ Running 18 min behind — a consultation  │
│     ahead of you ran long                   │
│                                             │
│   [Give up my turn]        [Call clinic]    │
└─────────────────────────────────────────────┘
```

### Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-B2.1 | Live display of the token currently being served, updating within 3 s of the clinic event | P0 |
| FR-B2.2 | Tokens ahead, shown as a **count and a visual progression** — the count is what people actually understand and trust | P0 |
| FR-B2.3 | ETA as a **window (P80), never a single time**, with an explicit confidence indicator | P0 |
| FR-B2.4 | **Leave-now guidance**, computed from the P80 window minus the patient's stated travel time minus a check-in buffer | P0 |
| FR-B2.5 | Patient sets where they are waiting ("at the clinic" / "nearby, ~10 min" / custom minutes). **No continuous location tracking** | P0 |
| FR-B2.6 | Plain-language reason whenever the ETA moves materially ("a consultation ahead ran long", "the doctor started late", "prayer break until 18:35") | P0 |
| FR-B2.7 | Paused-queue state with a resume estimate, visually distinct from a running queue | P0 |
| FR-B2.8 | "I'm on my way" — a one-tap signal to the clinic; the receptionist sees an inbound-patient marker on the board. Reduces premature no-show penalties, and gives the patient a feeling of agency at the exact moment they are anxious | P1 |
| FR-B2.9 | Give up my turn / cancel, with an honest explanation of the consequences | P0 |
| FR-B2.10 | Works on a locked screen: live activity / persistent notification showing "now serving" and tokens ahead without opening the app | P1 |
| FR-B2.11 | Graceful offline: last known state with a clear timestamp and a "not updating" marker. **Never show a stale number as if it were live** | P0 |
| FR-B2.12 | Track for someone else — a parent tracks a child's token from the same account | P0 |
| FR-B2.13 | Post-visit: invoice, payment status, claim status, and any follow-up date | P1 |

### The three product bets on this screen

**1. Show the window, never the point.** A single time is read as a promise, and every promise we break costs us far more credibility than the vagueness of a range costs us in clarity. Twenty minutes of honest range beats five minutes of dishonest precision.

**2. "Leave now" is the feature; the ETA is the plumbing.** Nobody wants an ETA. They want to know whether they can order another coffee. The engine biases the leave-now trigger toward leaving early on purpose ([Token Engine §3.4](04-dynamic-token-engine.md)) — arriving 10 minutes early is a minor cost, arriving 10 minutes late can forfeit the turn.

**3. Always say why.** "18:40 → 19:05" with no explanation reads as incompetence. "Running 18 min behind — a consultation ahead of you ran long" reads as a hospital being a hospital, which is something people already understand and forgive. The Partner API carries a `reason` on every ETA change specifically so this is possible.

---

## 5. Feature 3 — Patient wallet

A patient in this market carries: an ID card, an Aasandha entitlement, sometimes a referral letter from a GP, sometimes an employer insurance card, and — for a parent — all of the above for two or three other people. Losing the paper referral on the ferry is a real and expensive event.

| ID | Requirement | Priority |
|---|---|---|
| FR-B3.1 | Identity via **eFaas** (A2), giving verified identity and the correct anchor for entitlement lookup. Fallback: phone OTP + national ID with in-clinic verification | P0 |
| FR-B3.2 | Aasandha entitlement status, linked through verified identity, displayed in plain language ("covered", "not covered for this service", "could not verify") | P0 |
| FR-B3.3 | Digital ID card storage — national ID or passport, encrypted at rest, shown at check-in as a QR/barcode | P0 |
| FR-B3.4 | Private/employer insurance card storage with policy number and validity | P1 |
| FR-B3.5 | **Digital referral letters**: GP issues a referral, it lands in the patient's wallet, and it is attached automatically when booking the specialist. This removes an entire category of wasted inter-island trips | P1 |
| FR-B3.6 | Household profiles — children, parents, dependants — each with their own documents and entitlements, under one login | P0 |
| FR-B3.7 | Visit history: date, doctor, clinic, invoice, payment, claim status | P1 |
| FR-B3.8 | Saved payment methods (BML, m-Faisaa) with a clear "you can still pay at the desk" path | P1 |
| FR-B3.9 | Offline access to wallet documents. The wallet must work on a boat with no signal, or it has failed its most important user | P0 |
| FR-B3.10 | Export and delete: full data export and account deletion, self-serve, no support ticket (A5 baseline) | P0 |

**Security posture, stated plainly to users in the app's own words:** documents encrypted on device and at rest; biometric lock on the wallet; nothing shared with a clinic until the patient books there or presents it at check-in; no data sold, ever. This is written in the onboarding, in the wallet screen, and in the privacy page — because in a country of half a million people where everyone knows someone at every clinic, medical privacy anxiety is high, well-founded, and the single biggest barrier to wallet adoption.

---

## 6. Feature 4 — Notification engine

Aggressive where it earns the right to be; silent otherwise. Materiality and debounce rules live in [Token Engine §5](04-dynamic-token-engine.md); this is the consumer-facing contract.

### Channel strategy

| Channel | Use | Why |
|---|---|---|
| **Push** | Default for everything | Free, instant, rich |
| **Viber** | Backup when push is undelivered/unread within 90 s, and primary for high-stakes messages | Highest read rate in this market by a wide margin |
| **SMS** | Fallback when push and Viber both fail, and always for `called` and `penalised` | Works on any handset, no data, no app needed |
| **Email** | Invoices, claim documents, records | Not a real-time channel here |

**A message never goes out on two channels at once.** Duplicate notifications are how a patient learns to ignore all of them.

### The message set for a typical visit

| Timing | Message | Channel |
|---|---|---|
| On booking | "Booked: Dr. Hassan, Sunday 6 Sep, 20:00. Token issued when the session opens." | Push |
| Evening before *(travel-flagged only)* | "Your appointment tomorrow at 16:30 is on. We'll message you if anything changes." | Viber |
| Morning of *(travel-flagged only)* | "Dr. Aminath's session is running as planned for 16:30. Safe travels." | Viber |
| Session opens | "Session started. You are token A-15, 8 ahead of you. Likely 20:35–20:55." | Push |
| 5 ahead | "5 people ahead. Likely 20:40–21:00." | Push |
| **Leave-now** | **"Leave now — about 3 people ahead of you. You'll be seen around 20:45."** | Push + Viber |
| Next | "You're next. Please check in at reception." | Push + Viber |
| Called | "Dr. Hassan is ready for you now — room 2." | Push + Viber + SMS |
| After | "Visit complete. Invoice MVR 400 · Aasandha covered MVR 400 · You paid MVR 0." | Push |

**Target: 4–6 messages per visit.** More than eight and we are training people to swipe us away.

### Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-B4.1 | Channel cascade push → Viber → SMS with delivery-receipt-driven escalation | P0 |
| FR-B4.2 | Per-channel and per-category preferences, with **operational messages non-optional while a token is active** (the patient may mute marketing; they may not accidentally mute "you're next") | P0 |
| FR-B4.3 | Notification language follows the patient's preference, including Thaana rendering in push payloads | P0 |
| FR-B4.4 | Deep links open the live tracker for the right token | P0 |
| FR-B4.5 | Quiet hours, overridden only for active-token operational messages | P1 |
| FR-B4.6 | In-app notification centre so a swiped-away message is still recoverable | P1 |
| FR-B4.7 | Per-notification instrumentation: sent, delivered, opened, and did-the-patient-arrive-on-time — this is what closes the loop on notification precision | P0 |
| FR-B4.8 | Travel-flagged patients get an extended notification profile: earlier warnings, larger materiality thresholds (a 15-minute change is noise to someone on a ferry; a cancellation is everything) | P0 |

---

## 7. Core UX flow

### 7.1 First run

```
Splash → Language (Dhivehi / English)
   → Value proposition, 3 screens, skippable
       "See exactly where you are in the queue"
       "We'll tell you when to leave"
       "Your Aasandha and ID, in one place"
   → Sign in with eFaas   [or]   Phone number + OTP
   → Ask: "Where do you usually go to the doctor?" (island/atoll)
   → Home
```

**We ask for notification permission at the moment of the first booking, not at first run** — framed as *"We'll tell you when to leave for the clinic. Turn on notifications?"* Permission granted against a concrete, just-experienced need converts far better than a cold prompt on screen one, and this app is worthless without notifications.

### 7.2 Search → book → track

```
HOME
 ├── "Book an appointment"
 ├── Live tokens (if any active) ─────────────► LIVE TRACKER
 ├── Upcoming appointments
 └── Wallet shortcut

    ▼ Book
SEARCH
 │  [What do you need? e.g. "fever", "skin", "heart"]
 │  Quick chips: GP · Paediatrics · Dental · O&G · ENT · Dermatology
 ▼
 (Red-flag check → emergency card if triggered, non-dismissible on this screen)
 ▼
RESULTS — doctors matching the specialty
 │  Filters: location · language · payer · gender · availability
 │  Card: name · specialty · languages · clinic · fee · NEXT AVAILABLE
 │  Sort: soonest available (default)
 ▼
DOCTOR PROFILE
 │  Qualifications · languages · clinics · fee · payers · typical 12 min
 │  Session picker:  Today 20:00–22:00  ·  Mon 09:00–12:00  ·  Mon 16:00–18:00
 ▼
SLOT SELECTION
 │  ⓘ "This clinic works by token order. Your slot is a starting estimate —
 │     we'll track the real queue and tell you when to leave."
 │  ← expectation-setting placed HERE, before commitment, not after
 ▼
WHO IS THIS FOR?
 │  Me · Ahmed (son, 4) · Mariyam (mother, 68) · + Add someone
 ▼
CONFIRM
 │  Payer: Aasandha ✓ verified  /  Self-pay MVR 400
 │  Attach referral letter?  [Dr. Nasru — 2 Sep] ✓
 │  Travelling from another island?  [ ] ← sets the travel flag
 │  Pay now (BML / m-Faisaa) or pay at the clinic
 ▼
BOOKED
 │  Confirmation + calendar add + "we'll notify you when the session opens"
 ▼
 (session opens — push)
 ▼
LIVE TRACKER  ──► leave-now push ──► arrive ──► check in (QR)
 ▼
POST-VISIT
    Invoice · payment · claim status · follow-up date · [Rebook]
```

**The single most important screen in this flow is SLOT SELECTION**, and specifically the notice on it. Maldivian clinics run token queues, not strict appointment times. If a patient books "20:00" believing it is a Western-style appointment, we have set them up to feel cheated at 20:35 — and they will blame us, not the clinic. Teaching "your slot is a position, we track the reality" *before* they commit is what makes every later message land as help rather than excuse.

### 7.3 Check-in

Patient arrives → opens app → `Check in` (QR on screen, receptionist scans; or receptionist taps arrival on the board). Token state → `ARRIVED`. Delay-penalty timers are governed by this state, so the app makes it obvious and one-tap. If they forget, the receptionist handles it — the app is never the only path.

---

## 8. Edge cases

This section is disproportionately long relative to the happy path, on purpose. **The happy path is not what determines whether this product is trusted.** A queue product is judged entirely on how it behaves when the queue misbehaves.

### 8.1 Sudden clinic delays

| Situation | App behaviour |
|---|---|
| Doctor starts 30 min late | Card turns amber the moment the clinic sets a delay — *before* the scheduled start. "Dr. Hassan is starting around 20:30 instead of 20:00. Your new estimate: 21:05–21:30." Leave-now recalculates silently. Confidence drops until real events arrive |
| Consultation ahead overruns | ETA shifts; notify only if material (≥ 15 min). Always with the reason |
| Cascading delay pushes past session end | Token flagged `at_risk`. Explicit, honest message: *"There's a chance Dr. Hassan won't reach your token tonight. You can keep waiting, move to tomorrow 09:00, or cancel with a full refund."* **Three concrete options, presented before the patient has wasted the evening** |
| Delay while patient is already travelling from an atoll | Different treatment entirely: no silent adjustment. Viber + push + SMS, plus a callback request button that puts them in touch with the clinic. A 90-minute delay is trivial for Aishath and potentially trip-ending for Fathimath |
| Doctor never shows; session cancelled | Highest-urgency path. All channels. Automatic rebooking suggestions on the same doctor and same-specialty alternatives at the same clinic. Automatic refund initiation for pre-paid tokens, stated in the message. For travel-flagged patients, an escalation flag on the clinic's board with a "call this patient" task — **a human calls them; a push notification is not sufficient for someone who booked a boat** |

### 8.2 Paused queues

| Situation | App behaviour |
|---|---|
| Prayer pause (scheduled) | Shown *in advance* on the tracker: "Queue pauses 18:15–18:35 for prayer — already included in your estimate." Predictable pauses should never be a surprise; they are in the schedule and therefore in the ETA |
| Emergency pause (unplanned) | Tracker switches to a distinct paused state: "The doctor has been called to an emergency. Queue paused, expected to resume around 19:10. We'll tell you when it restarts." No countdown timer — a ticking clock on an unpredictable event manufactures anxiety |
| Pause exceeds its estimate | Proactive re-notification at the point the original estimate lapses. **Silence during an over-running pause is the fastest way to lose trust in the whole product** |
| Pause resumes | "Queue restarted. You're 4 ahead. Likely 19:35–19:55." Leave-now recomputed |
| Indefinite pause / session abandoned | Same path as cancellation (§8.1) |

### 8.3 Insurance and payment problems

| Situation | App behaviour |
|---|---|
| Aasandha eligibility cannot be verified at booking | Do not block booking. Neutral status: "We couldn't verify your Aasandha cover right now. You can still book — reception will check when you arrive." Never assert non-coverage from a technical failure |
| Verified as not covered for this service | Told **at booking time**, with the self-pay amount and the option to continue or change: "This service isn't covered under Aasandha. Cost: MVR 400." Discovering this at the desk after travelling is the failure we exist to prevent |
| Claim rejected after the visit | Plain-language notification with the rejection reason, the amount now owed, what to do about it, and a "the clinic can resubmit — request a review" button that creates a task on the clinic's rejection worklist. **We never simply present a bill and go quiet** |
| Payment fails at booking | Booking is held for 15 minutes with a retry, an alternative method, and pay-at-clinic. We never lose a slot to a payment error |
| Patient prepaid and the session is cancelled | Refund initiated automatically, stated in the cancellation message with an expected timeline |

### 8.4 Queue-position edge cases

| Situation | App behaviour |
|---|---|
| Patient is called and not present | Grace period is visible and counting in the app before the penalty applies — a last chance, not an ambush. Then: "You were called at 20:41 and we couldn't find you. You've moved back 2 places — new estimate 21:05–21:20." Never a silent demotion |
| Patient marked no-show | Full explanation, the clinic's policy in plain words, and a one-tap rebook. If they were travel-flagged, the app surfaces "contact the clinic" instead, because a human should decide |
| Emergency case jumps the queue | Told, with the reason: "An emergency patient was added ahead of you. New estimate 21:15–21:35." Patients accept this readily; what they do not accept is an unexplained ten minutes appearing from nowhere |
| Queue moves faster than predicted | Notified — this is good news, it changes behaviour, and it builds trust in the estimate. "Moving faster than expected — you're up in about 15 minutes." |
| Patient loses connectivity (ferry, lift, dead battery) | Last known state with a visible timestamp and a "not updating" marker. On reconnect, immediate refresh with a summary of what changed. SMS fallback covers the no-data case |
| Two appointments the same day | Cross-checked at booking with a conflict warning based on both P80 windows plus travel time |
| Patient at the clinic in person | Leave-now suppressed; tracker switches to a lobby mode: token, now-serving, and a queue view |

### 8.5 Trust and safety

- **Red-flag symptoms** always surface emergency guidance above booking (§3).
- **Never a clinical opinion.** Not from the router, not from notification copy, not from support.
- **Booking-on-behalf** requires an explicit relationship declaration; adult dependants' records need the adult's own consent via their eFaas identity before their data is visible.
- **Account sharing** is common in this market and we design for it rather than against it (household profiles, FR-B3.6) — because the alternative is patients sharing one login and us losing all data integrity.

---

## 9. Acquisition: the first 10,000 patients

### 9.1 Strategy in one sentence

**We do not acquire patients. Our clinics do, at the moment of highest intent — the reception desk — and we make that the cheapest and most valuable channel by an order of magnitude.**

Digital marketing supports that motion; it does not replace it. In a market where the addressable population in Greater Malé is a few hundred thousand and every patient physically stands in front of one of our clinics, treating this as a broad digital-acquisition problem would be both expensive and slow.

### 9.2 Prerequisite

**The app does not launch publicly until ≥ 12 clinics with ≥ 40 doctors are live on Vaguthu Clinic in Greater Malé.** An empty marketplace burns the launch, and in a market this small the word travels in days and you do not get a second first impression.

### 9.3 Channel plan — 90 days to 10,000

| # | Channel | Mechanism | Target | Est. CAC |
|---|---|---|---|---|
| 1 | **Receptionist-assisted install** | At check-in: *"Would you like to see your queue on your phone? Scan this."* Standee QR at the desk. Receptionist gets a per-install incentive (MVR 10) — small, immediate, and it makes the receptionist an ally rather than an obstacle | **4,500** | ~MVR 15 |
| 2 | **Token slip QR** | Every printed token carries a QR deep-linking to that exact token's live tracker. **Highest-intent surface in the entire market** — they are holding it while wondering how long they will wait | **2,200** | ~MVR 2 |
| 3 | **Queue SMS/Viber with a link** | Non-app patients receive queue updates with "track live in the app" | **1,200** | ~MVR 8 |
| 4 | **Clinic standees & lobby screens** | Lobby standees and a wall-mounted "now serving" screen branded and QR'd. The lobby TV is watched by everyone in the room because it is the only source of information | **900** | ~MVR 20 |
| 5 | **Facebook / Instagram** | Geo-targeted Greater Malé, Dhivehi-first creative. The hero creative is a 15-second split screen: a lobby full of people versus someone drinking coffee with the tracker on their phone | **700** | ~MVR 55 |
| 6 | **TikTok / creators** | 5–8 local creators, especially parenting and everyday-life accounts. Story-led, not feature-led | **300** | ~MVR 70 |
| 7 | **Viber communities** | Seeding in island and neighbourhood community groups, with clinic-partnered posts announcing "you can now track your queue at X clinic" | **250** | ~MVR 12 |
| 8 | **Pharmacy partnerships** | Counter standees at high-traffic pharmacies near partner clinics | **150** | ~MVR 30 |
| | **Total** | | **~10,200** | **blended ~MVR 18 (~USD 1.2)** |

### 9.4 The 90-day sequence

**Days 1–30 — Prove it in three clinics.**
Soft launch, no paid media. Three highest-volume partner clinics. A Vaguthu person physically present at each desk for the first week, watching real patients install and use it. Target 1,200 patients. **The gate to phase 2 is not a download count — it is D7 retention above 30% and P80 ETA coverage above 75%.** If the estimates are not good, more users just means more people learning not to trust us.

**Days 31–60 — Scale the clinic channel.**
All 12+ clinics equipped: standees, token QR, lobby screens, receptionist training and incentives. Paid social begins, small budget, testing Dhivehi versus English creative. Launch a referral loop: both parties get a small messaging credit or a partnered pharmacy discount. Target cumulative 5,000.

**Days 61–90 — Broad awareness plus the atoll story.**
Full paid social and TikTok. PR angle — *"Maldivian clinics cut waiting times by a third"* — with real instrumented numbers from partner clinics, because we will actually have them. Atoll push through island community groups and ferry-terminal placements, leading with the travel story, which is the emotionally strongest version of this product. Target cumulative 10,000+.

### 9.5 Physical standee — creative brief

Standees fail when they list features. This one asks a question the reader is already asking themselves:

```
┌────────────────────────────────────┐
│                                    │
│     ކިހާ އިރެއް؟                    │
│     How much longer?               │
│                                    │
│     [ QR ]                         │
│                                    │
│     Scan. See your token live.     │
│     Wait at home, not here.        │
│                                    │
│     Vaguthu · ވަގުތު                │
└────────────────────────────────────┘
```

Placement: at eye level beside the reception desk (decision moment), and on the wall facing the seating (boredom moment). Two placements, two different moments, one QR that deep-links straight into the tracker rather than a generic store page.

### 9.6 Retention — because acquisition without it is a treadmill

Healthcare is inherently low-frequency: a typical person books a few times a year. Retention therefore cannot rest on booking frequency.

| Mechanism | Effect |
|---|---|
| **Household profiles** | An adult managing care for children and parents uses the app 3–5× more often than for themselves alone. This is the single largest frequency multiplier available to us |
| **Wallet as a habit** | ID, Aasandha, and referral letters live here. Opened even when not booking |
| **Follow-up reminders** | Clinic-initiated recalls arrive as a booking-ready notification |
| **Cross-clinic history** | A complete visit record across every partner clinic — something no single clinic can offer, and the clearest reason to use the app instead of a clinic's own channel |
| **Speed of rebooking** | Rebooking a known doctor in two taps |

**Targets:** D1 55% · D7 32% · D30 20% · 6-month reactivation 45%.
**North-star metric: monthly *tracked* tokens** — bookings that were actively tracked to completion. It captures acquisition, retention, and whether the core experience actually worked, in one number. Downloads are a vanity metric and will not be reported as a headline.

---

## 10. Technical notes

- **React Native** (iOS + Android) with a PWA fallback. Rationale: one team, one release cycle, and a market where a meaningful share of users are on low-to-mid Android devices — but where iOS share in Greater Malé is high enough that Android-only is not viable.
- **Push:** FCM + APNs. **Viber:** via a business messaging provider (A4). **SMS:** via both telcos through an aggregator.
- **Live updates:** SSE from the Partner API with WebSocket upgrade for the foreground tracker; push for background. Aggressive reconnect with exponential backoff; on resume, always fetch fresh state rather than trusting a cached projection.
- **Offline:** wallet documents and last-known queue state persisted encrypted on device; every cached value renders with its own age.
- **Identity:** eFaas OIDC (A2) with phone-OTP fallback.
- **Payments:** BML and m-Faisaa SDK/redirect flows (A3); we never store card data.
- **Localisation:** Dhivehi (Thaana, RTL) and English at full parity from v1 — including push payloads, which are frequently forgotten and are the most-read text in the product.
- **Accessibility:** dynamic type, screen-reader labels on the tracker, colour-independent state indicators (an elderly patient reading a queue position must not depend on distinguishing amber from green).
- **Performance budget:** cold start to home under 2 s on a mid-range Android; tracker screen interactive under 1 s from a push deep link.

## 11. Success metrics

| Metric | Definition | 90-day target |
|---|---|---|
| Registered patients | Completed sign-up | 10,000 |
| Activated patients | Completed ≥ 1 booking | 6,000 |
| **Tracked tokens** *(north star)* | Bookings actively tracked to completion | 4,500/mo |
| Lobby time saved | Median `arrived_at → started_at` versus clinic non-app baseline | −30% |
| Leave-now precision | % of leave-now messages after which the patient was seen within 20 min of arrival | > 85% |
| ETA trust | % of patients who arrive after (not before) their leave-now message | > 60% |
| No-show rate, app bookings | Versus clinic's phone-booking baseline | −40% |
| Notification opt-out | Patients disabling non-essential notifications | < 8% |
| D7 / D30 retention | | 32% / 20% |
| App store rating | | > 4.3 |
| Blended CAC | | < MVR 25 |

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **ETAs are not accurate enough and patients stop trusting the app** | Critical — this is the product | Gate public launch on P80 coverage > 75%; publish windows not points; bias leave-now early; always explain changes; kill the launch rather than ship an untrusted estimate |
| Not enough clinics at launch | High | Hard prerequisite of 12 clinics / 40 doctors (§9.2) |
| Clinics resist patients "leaving the lobby" — some prefer a full waiting room | Medium | Show them the data: shorter dwell, fewer desk interruptions, lower no-shows. Make lobby mode good so present patients are served too |
| eFaas access denied (A2) | Medium | Phone + national ID with in-clinic verification; wallet degrades but functions |
| Viber costs or access change (A4) | Medium | Push-first architecture; SMS floor; channel abstraction |
| Notification fatigue | High | Materiality rules, debounce, coalescing, 4–6 messages per visit target, opt-out monitored as a first-class metric |
| Privacy incident or perception of one | Critical | GDPR-equivalent baseline, encryption, biometric wallet lock, minimal collection, no data sales — and say all of it in the app in plain language |
| A clinic group launches its own app | Medium | We are cross-clinic and we are the rail; a single-clinic app cannot show a patient their whole history or the whole market |

## 13. Open questions

1. Do we ever show *predicted* wait time for a doctor a patient has not yet booked with (a discovery signal), given it edges toward a punctuality leaderboard? **Recommendation: no per-doctor figure; show a clinic-level typical wait only.**
2. Should the app show queue position for patients who booked through a *third-party* app, if they install ours? Technically yes via the token QR; commercially it is competitive with our own partners. Needs a policy decision before the API goes public.
3. Referral letters (FR-B3.5) require GP-side issuance in the B2B product. Is that in the B2B v1 scope, or does the wallet ship without it? **Recommendation: ship the wallet without it; add referrals in the first post-GA cycle — it is the strongest atoll-facing feature we have.**
4. Do we let patients join a queue remotely without a booked slot (a virtual walk-in)? High value, and high risk of gaming and of clinics losing control of their own door. Pilot with one clinic before deciding.
5. Reviews and ratings: currently out of scope (§1). Revisit only once doctor trust in the platform is established, and probably never for individual doctors — clinic-level service ratings are the safer instrument.
