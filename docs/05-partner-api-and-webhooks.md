# API Blueprint — Vaguthu Partner Platform

**Status:** Design v1.0 · **Audience:** Third-party consumer apps, aggregators, insurer and employer portals, EMR vendors
**Base URL:** `https://api.vaguthu.mv/v1` · **Machine-readable sketch:** [`api/openapi.yaml`](api/openapi.yaml)

---

## 1. Purpose and posture

The clinic dashboard owns the queue. This API exposes that queue — read and write — to anyone the clinic authorises.

We publish it openly, including to competitors of our own patient app. That is a strategic choice, not an oversight:

- It removes the strongest objection in the B2B sale — *"I don't want to lock my patients into one app."*
- It makes us the **rail**, and rails outlast destinations. The party that owns the booking and queue-state contract for a market is very hard to displace, whoever ends up owning the consumer relationship.
- Every third-party booking still runs through our engine, which means it still improves our duration models and still shows up in the clinic's analytics.

**Three invariants, and they are not negotiable:**

1. **The clinic is the authority.** A partner's access is granted, scoped, allocated, and revoked by the clinic — not by us, and not by the partner. Revocation is immediate.
2. **Reads are cheap and generous; writes are scarce and controlled.** Queue state should be trivially available. Injecting a token into a live queue is a privileged act with a per-partner allocation.
3. **We never leak identity across partners.** Partner A that booked token X sees the patient data it supplied. It does not see any other token's patient. Queue state is exposed positionally and anonymously.

---

## 2. Authentication and authorisation

**OAuth 2.0 client credentials** for partner-server to Vaguthu-server calls. Partners never call from an end-user device; a compromised mobile binary must not carry a partner credential.

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=pk_live_a1b2c3
&client_secret=...
&scope=slots:read bookings:write queue:read
```

Tokens are JWTs, 1-hour TTL, carrying `partner_id` and granted scopes.

### Scopes

| Scope | Grants |
|---|---|
| `clinics:read` | Clinic and doctor directory, specialties, languages, locations |
| `slots:read` | Availability windows for bookable sessions |
| `bookings:write` | Create, reschedule, cancel bookings on behalf of a patient |
| `bookings:read` | Read bookings **this partner created** |
| `queue:read` | Live queue state and ETAs for sessions containing this partner's bookings |
| `queue:subscribe` | Webhook subscriptions and SSE streams |
| `payments:initiate` | Generate payment links for this partner's bookings |
| `insurance:verify` | Aasandha / payer eligibility pre-check (gated; requires a separate agreement) |

### Clinic-side control surface

Every clinic sees, in Admin, one row per partner:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Partner integrations                                                 │
├──────────────────────────────────────────────────────────────────────┤
│  Vaguthu Patient App    ● Enabled   Slots: unlimited   Bookings: 1,204│
│  Dhoni Health           ● Enabled   Slots: 20%/session Bookings: 87   │
│    ↳ can: read slots · create bookings · read queue      [Configure]  │
│    ↳ cannot: cancel other bookings · see other patients  [Revoke ⏻]   │
│  Island Care            ○ Disabled  — requested 12 Aug   [Review]     │
└──────────────────────────────────────────────────────────────────────┘
```

Per-partner controls: enable/disable, slot allocation (absolute or % of session capacity), permitted doctors, advance-booking horizon, cancellation rights, whether the partner may book into walk-in-reserved capacity.

**Slot allocation is the feature that makes clinics willing to say yes.** A clinic that fears an aggregator flooding its Sunday evening session can cap that partner at 20% of capacity and watch the number. Without this control, adoption of the API stalls and the platform strategy fails — which is why it is specified here rather than left to implementation.

---

## 3. REST resources

All responses are JSON. All timestamps are RFC 3339 with offset (`2026-09-06T18:40:00+05:00`). All money is minor units plus a currency code (`{"amount": 40000, "currency": "MVR"}`).

### Discovery

```http
GET /v1/clinics?atoll=K&island=Male&specialty=paediatrics&language=dv
GET /v1/clinics/{clinic_id}
GET /v1/clinics/{clinic_id}/doctors
GET /v1/doctors/{doctor_id}
```

`GET /v1/doctors/{doctor_id}` →

```json
{
  "id": "doc_7hK2",
  "name": "Dr. Aminath Shaheedha",
  "specialties": ["paediatrics"],
  "languages": ["dv", "en", "hi"],
  "clinics": [{ "id": "cln_91", "name": "Malé Family Clinic", "island": "Male", "atoll": "K" }],
  "consultation_fee": { "amount": 40000, "currency": "MVR" },
  "accepts_payers": ["aasandha", "allied", "self_pay"],
  "next_available": "2026-09-06T16:00:00+05:00",
  "typical_consultation_minutes": 12
}
```

We expose `typical_consultation_minutes` (a rounded, low-resolution figure) but **never** per-doctor punctuality or lateness. Partners cannot build a "which doctors run late" leaderboard from our data — a commitment we make to doctors in the B2B product (B2B PRD §5.3) and must honour at the API boundary or it is worthless.

### Availability

```http
GET /v1/doctors/{doctor_id}/availability?from=2026-09-06&to=2026-09-08
```

```json
{
  "doctor_id": "doc_7hK2",
  "sessions": [
    {
      "session_id": "ses_44Ab",
      "clinic_id": "cln_91",
      "starts_at": "2026-09-06T16:00:00+05:00",
      "ends_at": "2026-09-06T18:00:00+05:00",
      "slots": [
        { "slot_id": "slt_01", "starts_at": "2026-09-06T16:00:00+05:00",
          "duration_minutes": 12, "status": "available" },
        { "slot_id": "slt_02", "starts_at": "2026-09-06T16:12:00+05:00",
          "duration_minutes": 12, "status": "held", "held_until": "2026-09-06T15:42:10+05:00" }
      ],
      "partner_allocation": { "total": 8, "used": 3, "remaining": 5 }
    }
  ]
}
```

Availability is cacheable for 30 seconds (`Cache-Control: max-age=30`, `ETag`). Partners that need it fresher should subscribe to `slot.availability.changed` rather than poll harder — and the rate limiter will enforce that preference.

### Booking (two-phase)

Booking is two-phase because a naive single-call booking creates double-bookings the moment two partners hit the same slot, and in a small market that will happen on the first busy evening.

**Phase 1 — hold** (soft-locks for 120 s):

```http
POST /v1/holds
Idempotency-Key: 5f3a...

{ "slot_id": "slt_01", "partner_reference": "dhoni-bk-99213" }
```

```json
{ "hold_id": "hld_x8", "expires_at": "2026-09-06T15:44:10+05:00" }
```

**Phase 2 — confirm:**

```http
POST /v1/bookings
Idempotency-Key: 9c1d...

{
  "hold_id": "hld_x8",
  "patient": {
    "external_id": "dhoni-user-4412",
    "name": "Ibrahim Mohamed",
    "phone": "+9607771234",
    "national_id": "A123456",
    "date_of_birth": "1979-04-11",
    "language": "dv",
    "travel_origin": { "atoll": "Lh", "island": "Naifaru" }
  },
  "visit_type": "follow_up",
  "payer": { "type": "aasandha" },
  "notify_via_partner_only": true
}
```

```json
{
  "booking_id": "bkg_2Qm",
  "token": { "id": "tok_9f", "display": "A-15", "session_id": "ses_44Ab" },
  "status": "confirmed",
  "predicted_start": {
    "p50": "2026-09-06T16:04:00+05:00",
    "p80_window": { "from": "2026-09-06T16:00:00+05:00", "to": "2026-09-06T16:18:00+05:00" },
    "confidence": "medium"
  },
  "queue": { "position": 2, "tokens_ahead": 1 },
  "payment": { "required": true, "amount": { "amount": 40000, "currency": "MVR" },
               "payment_link": "https://pay.vaguthu.mv/l/x8Kq2" },
  "cancellation_policy": { "free_until": "2026-09-06T14:00:00+05:00" }
}
```

`notify_via_partner_only: true` suppresses Vaguthu's own patient messaging so the patient does not receive two sets of notifications from two apps. Partners that take this option **must** relay `queue.token.*` webhooks to their users; we audit this, because a patient who receives nothing is a patient who misses their turn and blames the clinic.

```http
GET    /v1/bookings/{booking_id}
PATCH  /v1/bookings/{booking_id}       # reschedule
DELETE /v1/bookings/{booking_id}       # cancel
```

Partners may only read, modify, or cancel bookings they created. Enforced at the data layer, not by convention.

### Live queue state

```http
GET /v1/sessions/{session_id}/queue
If-None-Match: "v-8814"
```

```json
{
  "session_id": "ses_44Ab",
  "version": 8815,
  "computed_at": "2026-09-06T17:02:11+05:00",
  "state": "running",
  "running_late_minutes": 18,
  "now_serving": { "display": "A-14", "started_at": "2026-09-06T16:55:03+05:00" },
  "tokens_waiting": 7,
  "your_bookings": [
    {
      "booking_id": "bkg_2Qm",
      "token_display": "A-15",
      "state": "arrived",
      "tokens_ahead": 1,
      "predicted_start": {
        "p50": "2026-09-06T17:09:00+05:00",
        "p80_window": { "from": "2026-09-06T17:04:00+05:00", "to": "2026-09-06T17:22:00+05:00" },
        "confidence": "high"
      },
      "leave_now": false
    }
  ]
}
```

Note the shape: aggregate queue facts are public to the partner; **per-token detail exists only for that partner's own bookings**. `now_serving` is a token display code, never a patient identity.

**Streaming alternative** for apps wanting sub-second updates without polling:

```http
GET /v1/stream/sessions/{session_id}      # Server-Sent Events
Accept: text/event-stream
```

Emits `queue.updated` frames carrying the same body, each with a monotonically increasing `version`. Reconnect with `Last-Event-ID` to replay missed frames from a 15-minute buffer.

---

## 4. Webhooks

The core of the platform contract. Polling is a fallback; webhooks are the intended path.

### Subscription

```http
POST /v1/webhook_endpoints
{
  "url": "https://partner.example/hooks/vaguthu",
  "events": ["queue.token.eta_changed", "queue.token.now_serving",
             "queue.session.delayed", "booking.cancelled"],
  "clinic_ids": ["cln_91"]
}
```
→ returns `{ "id": "whe_31", "signing_secret": "whsec_..." }` (shown once).

`GET`, `PATCH`, `DELETE /v1/webhook_endpoints/{id}` manage the subscription. `POST /v1/webhook_endpoints/{id}/test` sends a synthetic event of any type — partners should not have to wait for a real clinic delay to test their delay handler.

### Event catalogue

| Event | Fires when | Typical partner action |
|---|---|---|
| `slot.availability.changed` | Slots opened, taken, or a session's capacity changed | Invalidate cached availability |
| `slot.session.published` | A clinic publishes a new session | Refresh the doctor's calendar |
| `booking.confirmed` | Booking confirmed (including via other channels, for the partner's own patients) | Update local record |
| `booking.rescheduled` | Time or doctor changed | Notify user, update record |
| `booking.cancelled` | Cancelled by clinic, patient, or partner | Notify user, offer alternatives |
| `booking.payment_required` | Payment link issued or payment overdue | Prompt user to pay |
| `queue.session.started` | Doctor started the session | Switch UI to live tracking |
| `queue.session.delayed` | Session start pushed back | **"Your appointment is running ~25 min late"** |
| `queue.session.paused` | Prayer, break, or emergency pause | Show paused state + resume estimate |
| `queue.session.resumed` | Pause ended | Resume live tracking |
| `queue.session.cancelled` | Session cancelled outright | Urgent notify + rebooking flow |
| `queue.token.now_serving` | A new token entered consultation | Update "now serving" display |
| `queue.token.eta_changed` | Material ETA change for a partner's token (materiality rules in [Token Engine §5](04-dynamic-token-engine.md)) | Update ETA, possibly notify |
| `queue.token.leave_now` | Engine's leave-now threshold crossed | **Highest-value push the partner can send** |
| `queue.token.next` | Token is next in line | "You're next" |
| `queue.token.called` | Patient called into the room | Urgent push |
| `queue.token.penalised` | Delay penalty applied | Explain the demotion and the new time |
| `queue.token.no_show` | Marked no-show | Explain, offer rebooking |
| `queue.token.completed` | Consultation ended | Close the tracking UI, request feedback |
| `queue.token.at_risk` | Unlikely to be reached before session end | Offer a decision while it is still useful |
| `payment.succeeded` / `payment.failed` / `payment.refunded` | Payment lifecycle | Update state |
| `insurance.eligibility.result` | Eligibility check completed | Show cover status |
| `claim.status.changed` | Claim submitted / accepted / rejected | Inform user of out-of-pocket change |

### Payload envelope

Every webhook body has the same shape:

```json
{
  "id": "evt_01J8XQ",
  "type": "queue.token.eta_changed",
  "created_at": "2026-09-06T17:02:11+05:00",
  "api_version": "2026-09-01",
  "clinic_id": "cln_91",
  "session_id": "ses_44Ab",
  "sequence": 8815,
  "data": {
    "booking_id": "bkg_2Qm",
    "token_display": "A-15",
    "tokens_ahead": 1,
    "previous_predicted_start": { "p50": "2026-09-06T16:52:00+05:00" },
    "predicted_start": {
      "p50": "2026-09-06T17:09:00+05:00",
      "p80_window": { "from": "2026-09-06T17:04:00+05:00", "to": "2026-09-06T17:22:00+05:00" },
      "confidence": "high"
    },
    "delta_minutes": 17,
    "reason": "consultation_overrun"
  }
}
```

`reason` is a genuinely important field and is populated on every ETA change: `consultation_overrun`, `session_started_late`, `session_paused`, `priority_insertion`, `walk_in_inserted`, `reorder`, `no_show_ahead` (this one is good news), `blackout_interval`. A partner app that can say *"running 17 minutes late because a consultation ahead of you ran long"* produces a fundamentally different emotional response from one that silently changes a number. We give partners what they need to be honest.

### Delivery semantics

| Property | Behaviour |
|---|---|
| Guarantee | **At-least-once.** Consumers must be idempotent on `event.id` |
| Ordering | **Not guaranteed.** Every event carries `sequence`, monotonic per `session_id`. Discard any event whose `sequence` is lower than the last processed for that session |
| Timeout | 5 s to respond `2xx` |
| Retries | 6 attempts with exponential backoff + jitter: ~30 s, 2 m, 10 m, 1 h, 4 h, 12 h |
| Dead letter | After final failure, event is retained 7 days and retrievable via `GET /v1/webhook_endpoints/{id}/failed_events` |
| Replay | `POST /v1/webhook_endpoints/{id}/replay { "from": "...", "to": "...", "types": [...] }` |
| Auto-disable | An endpoint failing > 95% of deliveries over 6 h is disabled, with an email to the partner. We do not spend a day retrying into a dead host |
| Time-to-live | `queue.token.*` events carry `expires_at`. A "leave now" delivered 40 minutes late is worse than useless — consumers must drop expired events |

### Signature verification

```
X-Vaguthu-Signature: t=1757178131,v1=5257a869e7ec...
```

`v1` is `HMAC-SHA256(secret, "{t}.{raw_body}")`. Verify with a constant-time comparison and reject if `|now − t| > 300 s`. Two secrets may be active simultaneously to allow zero-downtime rotation; `POST /v1/webhook_endpoints/{id}/rotate_secret` returns the new one and keeps the old valid for 24 hours.

---

## 5. Cross-cutting concerns

**Errors** — RFC 9457 problem details:

```json
{
  "type": "https://docs.vaguthu.mv/errors/slot_unavailable",
  "title": "Slot no longer available",
  "status": 409,
  "detail": "Slot slt_01 was taken at 2026-09-06T15:41:58+05:00",
  "instance": "/v1/holds",
  "request_id": "req_8812",
  "alternatives": [{ "slot_id": "slt_03", "starts_at": "2026-09-06T16:24:00+05:00" }]
}
```

Returning `alternatives` on a 409 is a deliberate courtesy: the partner's user is standing in front of a screen, and a booking failure that immediately offers the next slot is a recoverable moment rather than an abandoned one.

**Idempotency** — required on `POST /v1/holds`, `POST /v1/bookings`, and all payment initiations via `Idempotency-Key`. Keys retained 24 h; a replay returns the original response.

**Rate limits** — per partner: 600 req/min sustained, 60 req/s burst; webhook subscription management 60 req/min. Headers `X-RateLimit-Limit`, `-Remaining`, `-Reset`; `429` carries `Retry-After`. Streaming and webhooks are outside the limit — we want partners on push, so the pricing of the API is deliberately shaped to reward it.

**Versioning** — date-based (`2026-09-01`) pinned per partner at onboarding, sent as `Vaguthu-Version`. Breaking changes ship as a new version with 12 months of overlap; additive changes go to all versions. Partners must tolerate unknown fields and unknown enum values — stated in the terms, and verified in the certification suite.

**Sandbox** — `https://sandbox.api.vaguthu.mv/v1` with a simulated clinic, a fake doctor whose consultation durations can be scripted, and a `POST /v1/sandbox/simulate` endpoint that can force a delay, a pause, an overrun, or a no-show on demand. A partner must be able to test their "session delayed" handling without waiting for a real doctor to be late.

**Partner certification** before production access: correct signature verification, idempotent event handling, out-of-order tolerance via `sequence`, expired-event dropping, and — assessed manually — sane notification behaviour. We do not let a partner attach to our rail and then spam patients on our clinics' behalf.

---

## 6. What we deliberately do not expose

| Not exposed | Why |
|---|---|
| Other partners' or walk-in patients' identities | Privacy; never negotiable |
| Per-doctor punctuality, lateness history, or ranked durations | A commitment made to doctors in the B2B product. If it leaks through the API, doctors stop emitting events and the engine dies |
| Clinical notes, diagnoses, prescriptions | Out of product scope, and a category of data we do not want to be the custodian of |
| Clinic financials, pricing history, claim values | The clinic's commercial data, not ours to sell |
| Raw event streams / model internals | Stable contracts only; internals must stay free to change |
| Bulk directory export | Directory reads are rate-limited and per-lookup. We are a booking rail, not a lead-generation list for sale |
