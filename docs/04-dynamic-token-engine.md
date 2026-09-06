# Technical Architecture — The Dynamic Token Engine

**Status:** Design v1.0 · **Owner:** Engineering Lead + Product
**Serves:** [B2B PRD §9](02-prd-b2b-clinic-command-center.md) · [B2C PRD §3](03-prd-b2c-patient-app.md) · [Partner API](05-partner-api-and-webhooks.md)

---

## 1. What this component is responsible for

Given the live state of a doctor's session, produce for every waiting token a **predicted start time with a stated uncertainty**, keep it correct as reality changes, and tell the right people when it changes enough to matter.

This is the only genuinely hard piece of engineering in the platform, and it is the piece the entire product proposition rests on. A patient will leave the lobby and wait at a café only if they believe the number. They will believe the number roughly twice before deciding it is noise.

**The three failure modes we are designing against, in order of severity:**

1. **Optimistic drift.** The estimate says 18:40, the patient arrives at 18:35, they are seen at 19:20. Catastrophic — this is worse than the paper system, because the paper system never made a promise.
2. **Notification fatigue.** The ETA jitters by three minutes every 40 seconds and the patient's phone buzzes each time. They mute us, then they miss the message that mattered.
3. **Silent staleness.** The projection stops updating and nobody notices. Everyone downstream is confidently wrong.

Every design decision below traces back to one of these three.

---

## 2. Domain model

```
Clinic ──< Doctor ──< Session ──< Token
                        │
                        ├──< BlackoutInterval   (prayer, break, scheduled pause)
                        └──< SessionEvent       (append-only)

Token: id, session_id, seq (fractional rank), patient_id, source,
       visit_type, state, arrived_at, called_at, started_at, ended_at,
       flags[], predicted_window, version
```

**Token state machine**

```
                      ┌──────────────────────────────────┐
                      ▼                                  │
  BOOKED ──► ARRIVED ──► CALLED ──► IN_CONSULT ──► COMPLETED
     │          │           │  │
     │          │           │  └──► (grace expires) ──► PENALISED ──┐
     │          │           │                                       │
     │          │           └──────────────────────────────► NO_SHOW│
     │          └──► CANCELLED                                      │
     └──► CANCELLED                                    (re-queued) ◄┘
```

`PENALISED` re-enters the queue at a new `seq` per the clinic's delay-penalty policy (B2B PRD §4.2). `NO_SHOW` is terminal for the session but can be manually reinstated by the receptionist within the session.

**Ordering by fractional rank.** `seq` is a `numeric`, and a drag-and-drop between two tokens writes `seq = (prev + next) / 2`. A reorder is a **single-row update** regardless of queue length — no renumbering, no write amplification, no lock contention on a busy board. A background job renormalises to integers at session close, which is also when precision exhaustion (after ~50 successive insertions between the same pair, which will not happen in a real clinic) would be repaired.

**Blackout intervals are first-class.** Prayer pauses, scheduled breaks, and ad-hoc doctor pauses are all `BlackoutInterval` rows on the session. The projection walks *around* them. An engine that models a session as a continuous block of time will be visibly wrong five times a day in this market — this is the single most important localisation decision in the architecture.

---

## 3. The estimator

### 3.1 Baseline recurrence

For a session with ordered waiting tokens `t₁ … tₙ`:

```
free_at(0)   = doctor_free_at                       // now, or end of current consult
free_at(i)   = advance(free_at(i-1) + d(tᵢ) + turnover)

predicted_start(tᵢ) = advance(free_at(i-1))
```

where:

- `d(tᵢ)` — estimated consultation duration for that token
- `turnover` — inter-patient gap, estimated per doctor from observed `ended_at → next started_at` deltas (typically 60–120 s; a doctor who writes notes between patients has a bigger one, and we should measure it rather than assume it)
- `advance(t)` — pushes `t` forward past any blackout interval it falls inside, and past the end of the session into the next session block if the doctor has one

This is `O(n)` over a queue of at most a few dozen tokens: a sub-millisecond in-memory pass. There is no reason to be clever about performance here, and every reason to be clever about accuracy.

### 3.2 Estimating consultation duration `d(t)`

Duration is **log-normally distributed** — a hard floor around 3–4 minutes, a dense mode, and a long right tail of genuinely complex cases. Modelling it as a mean is precisely the mistake that produces optimistic drift, because the mean of a right-skewed distribution understates how bad the tail is for the people at the back of the queue.

We fit `ln(duration) ~ N(μ, σ²)` per bucket, with a fallback hierarchy:

```
(doctor, visit_type, is_new_patient)      ← preferred
   ↓ insufficient data
(doctor, visit_type)
   ↓
(doctor)
   ↓
(specialty, visit_type)      ← cross-clinic prior, anonymised
   ↓
global default per specialty  ← cold start
```

With small `n` — a new doctor, a rare visit type — we do not trust the empirical fit. We shrink toward the parent bucket:

```
μ̂ = (n·μ_bucket + k·μ_parent) / (n + k)          k ≈ 20 observations
```

This makes cold start behave sensibly instead of wildly: a doctor's third-ever consultation does not move their estimate by ten minutes.

Intraday, we apply an EWMA correction for *today*: a doctor who is running long on every case this evening gets a session-scoped multiplier `α` (bounded to [0.7, 1.6]) applied to their baseline. Doctors have bad days, busy days, and Ramadan evenings; the model should notice within three or four patients rather than waiting for the nightly refit.

### 3.3 The in-flight consultation — where naive engines break

The patient currently with the doctor is the largest single source of error. The naive estimate is `remaining = d̂ − elapsed`, which goes *negative* once a consultation overruns, and negative remaining time is exactly how a board ends up saying "next patient at 18:40" at 18:52.

Instead we use the **conditional expected residual** of the log-normal:

```
E[D − e | D > e]  =  E[D | D > e] − e
```

For a log-normal, this residual **increases** with elapsed time: a consultation that has already run 20 minutes is evidence of a complex case, and complex cases run longer still. That is the correct behaviour and it is the opposite of what subtraction gives you.

Implementation: precompute a lookup table of `E[D | D > e]` at 30-second granularity per bucket. Constant-time at query, refreshed nightly. No numerical integration at request time.

Two overrides sit on top:
- The doctor's `Need more time +10` (FR-2.5) sets an explicit floor on the residual.
- A hard cap prevents runaway estimates from a single pathological case: if the residual exceeds the bucket's P99, we clamp and raise an operational flag on the board so the receptionist can decide whether something is wrong.

### 3.4 Uncertainty, and why we publish a window

Point estimates are a lie we tell for free and pay for expensively. We propagate variance through the queue — approximately, by summing per-token variances (an assumption of independence that is close enough for `n < 40`, and cheap) — and publish:

- **P50** — the honest midpoint
- **the P80 window** — the central 80% interval, `[P10, P90]`, which is what the patient sees
- **P10** — the early edge, and the number "leave now" is built on

The B2C app shows a window (`18:40 – 19:05`), never a single time. The **"leave now"** trigger is computed against **P80 minus travel time**, deliberately asymmetric:

> Telling a patient to leave 10 minutes too early costs them 10 minutes in a waiting room. Telling them to leave 10 minutes too late costs them their turn, their trust, and — for someone who took a ferry from Naifaru — potentially their entire day. **We buy the cheap error**, which is why the trigger fires against the early edge of the window rather than the midpoint or the late edge. Aiming at P50 would leave half of all patients arriving after they were called.

Confidence is also displayed as a state (`high` / `medium` / `low`), driven by the width of the interval and the doctor's recent variance. Early in a session, or for a doctor with erratic durations, the app says so rather than pretending.

### 3.5 Handling non-standard queue events

| Event | Engine behaviour |
|---|---|
| Doctor starts session late | `doctor_free_at` set to actual start; full recompute; anyone whose window now exceeds the session end is flagged for receptionist triage |
| Session paused (prayer, emergency) | Insert an open-ended blackout with an expected resume time; `advance()` walks around it; ETAs shown as "paused" with a resume estimate, not as a hard time |
| Token dragged to a new position | Recompute affected suffix only (though we just recompute the whole session — it is cheaper than the bookkeeping) |
| Priority insertion | Same as reorder; the displaced tokens' notification threshold is temporarily lowered so they are told promptly rather than discovering it |
| No-show / penalty | Token leaves or re-enters at a new `seq`; recompute |
| Walk-in added | Inserted per clinic policy (end of queue by default; interleave ratio configurable — some clinics reserve every 4th slot for walk-ins, and the engine honours that) |
| Doctor takes an unannounced break | Detected as an anomalous gap after `ended_at` with no `started_at`; after a threshold (default 6 min) the engine flags "possible unlogged pause" to the board and widens the interval rather than silently accumulating error |
| Session over-runs its scheduled end | Tokens beyond the end are marked `at_risk`; the receptionist gets an explicit worklist rather than a queue that quietly promises times after closing |

---

## 4. System architecture

```
   Receptionist board      Doctor module        B2C app / partners
          │  WS                 │  REST                │ WS·SSE·webhook
          └─────────┬───────────┘                      │
                    ▼                                  │
            ┌───────────────┐                          │
            │  Queue Service │  ← the ONLY writer of queue state
            └───────┬───────┘
                    │ (1) mutate + write outbox row  [single transaction]
                    ▼
              ┌──────────┐
              │ Postgres │  tokens · sessions · events · outbox
              └────┬─────┘
                   │ (2) outbox relay
                   ▼
        ┌────────────────────────┐
        │  Event bus              │  partitioned by session_id
        │  (Redis Streams / NATS) │  → strict per-session ordering
        └───────┬─────────────────┘
                │ (3)
                ▼
     ┌────────────────────────┐        ┌──────────────────────┐
     │  Token Engine Worker   │◄───────│  Estimator Service   │
     │  · replay session state│  params│  · nightly distribution fits
     │  · recompute projection│        │  · residual lookup tables
     │  · emit diff           │        │  · intraday EWMA
     └───────┬────────────────┘        └──────────────────────┘
             │ (4) write projection + version
             ▼
      ┌──────────────┐
      │ Redis         │  session:{id}:projection   (hot read path)
      └──────┬────────┘
             │ (5) diff
             ▼
   ┌──────────────────────────┐
   │  Fanout / Notification    │
   │  Orchestrator             │
   │  · materiality filter     │
   │  · debounce + coalesce    │
   │  · channel selection      │
   └──┬────────┬────────┬──────┘
      ▼        ▼        ▼
   WebSocket  Push/    Partner
   (clinic)   Viber/   webhooks
              SMS
```

### Why each piece is shaped this way

**Single writer per session.** The bus is partitioned by `session_id`, so all events for one queue are processed in order by one consumer. This gives us the ordering guarantees of a distributed lock with none of the cost or failure modes. A queue is a naturally serial thing; fighting that would be perverse.

**Transactional outbox.** The queue mutation and its event row commit in the same Postgres transaction. A relay ships the outbox to the bus. Without this, a lost `consultation.ended` event leaves every downstream ETA permanently wrong with no self-healing path — failure mode #3, the worst one, because nothing alerts.

**Projections are derived and disposable.** Redis holds the current projection for fast reads, but Postgres holds the event log. Any projection can be rebuilt by replaying a session's events, which takes milliseconds. This makes Redis loss a non-event and makes algorithm changes safely deployable — we can recompute history with a new estimator and compare.

**Monotonic versioning.** Every projection carries `(session_id, version)`, incremented per recompute. Every WebSocket frame, push payload, and webhook body carries it. Consumers discard anything older than what they hold. This is how we survive out-of-order delivery on the fanout path without ordered delivery guarantees on it.

**Staleness is actively detected.** Each projection carries `computed_at`. A watchdog compares it against the session's last event; if a session has live events but a stale projection, we alert internally *and* degrade the client display to "estimates temporarily unavailable" rather than showing a confidently wrong number. Failure mode #3 must be loud.

### Performance

A recompute is an `O(n)` in-memory pass with constant-time distribution lookups: **sub-millisecond** for a realistic queue. The dominant cost of the whole pipeline is fanout, not computation. Capacity is bounded by concurrent sessions, and even an aggressive projection of the entire Maldivian market — a few hundred clinics, a few thousand concurrent sessions at peak evening hours — sits comfortably inside a single modest worker fleet. We should resist any urge to over-engineer this.

---

## 5. Notification materiality — solving failure mode #2

The engine recomputes on every event. It must **not** notify on every recompute. A patient should receive roughly 3–5 messages for a typical visit, and every one of them should be worth reading.

A projection diff produces a notification only if it crosses a materiality rule:

| Rule | Trigger | Channel | Rationale |
|---|---|---|---|
| **Position threshold** | `tokens_ahead` crosses 5, then 3, then 1 | Push → Viber | Positional, intuitive, and monotonic — it never flip-flops |
| **Leave now** | `now ≥ P80(start) − travel_time − buffer` | Push + Viber, high priority | The single most valuable message the product sends |
| **Material ETA shift** | Predicted start moves by ≥ 15 min (configurable) since last notification | Push → Viber | Absorbs jitter; only real news gets through |
| **You are next** | Token becomes `tokens_ahead == 0` | Push + Viber | |
| **Called** | State → `CALLED` | Push + Viber + SMS | Highest stakes: SMS included because the consequence of non-delivery is a penalty |
| **Pause / delay** | Session paused or delayed > 10 min | Push + Viber | |
| **Penalty applied** | State → `PENALISED` | Push + Viber + SMS | Never let a demotion be silent |
| **At risk** | Token flagged as unlikely to be reached before session end | Push + Viber | Gives the patient a real decision to make while it still matters |

Additional guards:

- **Debounce window.** No more than one non-urgent notification per token per 10 minutes. Urgent classes (`called`, `penalised`, `session_cancelled`) bypass it.
- **Coalescing.** If three rules fire inside the debounce window, one message is composed carrying the most important content.
- **Hysteresis on thresholds.** Position thresholds fire only on the *downward* crossing. A queue that oscillates between 4 and 3 tokens ahead sends one message, not six.
- **Direction asymmetry.** Improvements ("you'll be seen 20 minutes earlier") *are* notified — they change behaviour and they build trust in the estimate. Deteriorations are notified with more context and a suggested action.
- **Per-patient rate cap** across all clinics, so someone with two appointments in one day is not double-spammed.

The "leave now" computation deserves its own note, because it is the feature the B2C product is built around:

```
travel_time = f(patient_location_mode, clinic_id)
   · "I'm at the clinic"      →  0 min
   · "Nearby" (default, Malé) →  10 min
   · Custom (Hulhumalé, etc.) →  patient-set, default 35 min
   · Travelling from an atoll →  handled as a scheduling constraint,
                                 not a notification (see B2C PRD §5)

leave_at = P10(predicted_start) − travel_time − check_in_buffer(5 min)
           └── the EARLY edge of the published window, not the late one
```

We deliberately do **not** ask for continuous location access. It is unnecessary — the patient knows where they are far better than we do — and asking for it would cost us installs and trust for no accuracy gain. A single "where are you waiting?" control at booking time gets us 95% of the value at zero privacy cost.

---

## 6. Degradation ladder

| Failure | Behaviour | Patient sees | Clinic sees |
|---|---|---|---|
| Estimator Service down | Fall back to static slot durations from the schedule | Wider window, `confidence: low` | Banner: "Estimates are approximate" |
| Engine worker lag > 30 s | Serve last projection with an explicit staleness marker | "Estimates updating…" | Amber indicator on the board |
| Redis unavailable | Compute on demand from Postgres; higher latency, correct results | Slightly slower refresh | Nothing |
| Event bus down | Queue Service continues to write; outbox drains on recovery; no queue state is lost | Stale ETA + staleness marker | Banner + "estimates paused" |
| Clinic loses internet | Receptionist PWA operates offline: check-in, call next, add walk-in. Local ordering preserved; reconciled on reconnect | Last known state, marked offline | Offline banner, full local function |
| Doctor stops emitting events | Confidence drops; fallback estimator infers boundaries from check-in/called events | Wider windows, low confidence | "Doctor module not reporting" alert to reception |

**The invariant:** no failure in this component may ever prevent a receptionist from checking a patient in or a doctor from seeing one. The engine is an enhancement to a clinical operation that must continue without it.

---

## 7. Measuring whether it works

Instrument from day one; these are product metrics, not just ops metrics.

| Metric | Definition | Target at GA |
|---|---|---|
| **P80 coverage** | % of tokens whose actual start fell inside the published P80 window | **≥ 80%** (the definition of a calibrated model) |
| P50 median absolute error | Median \|actual − predicted\| at T−30 min | < 8 min |
| Optimism bias | Mean signed error; **positive bias is a bug, not a tuning preference** | −2 to +2 min |
| Notification precision | % of "leave now" messages after which the patient was seen within 20 min of arriving | > 85% |
| Notifications per token | Total messages ÷ tokens served | 3–5 |
| Mute/opt-out rate | Patients disabling notifications | < 5% |
| Lobby dwell reduction | Median `arrived_at → started_at`, versus clinic baseline | −30% |
| Event completeness | % of consultations with both start and end events | > 95% |
| Recompute latency | p99 event → projection written | < 100 ms |
| Fanout latency | p95 projection → client rendered | < 1 s |

**Backtesting harness.** Because every projection is derived from an immutable event log, we can replay any historical session against a candidate estimator and measure P80 coverage before shipping it. No estimator change reaches production without a backtest across at least 5,000 historical tokens spanning multiple specialties. This is the single highest-leverage piece of internal tooling in the project and should be built during Phase 1, not after.
