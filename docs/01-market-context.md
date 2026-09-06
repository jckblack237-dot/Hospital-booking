# Market Context, Constraints & Working Assumptions

**Status:** Draft v1.0 · **Owner:** Product · **Last updated:** 2026-09-06

This document is the shared factual and assumption base for both PRDs in this repository:

- [`02-prd-b2b-clinic-command-center.md`](02-prd-b2b-clinic-command-center.md) — Vaguthu Clinic (B2B SaaS)
- [`03-prd-b2c-patient-app.md`](03-prd-b2c-patient-app.md) — Vaguthu (B2C patient app)

Product names (`Vaguthu`, Dhivehi for *time*) are working placeholders pending trademark clearance.

---

## 1. Why the Maldives is a distinct healthcare market

| Factor | Implication for product |
|---|---|
| Population is small (~550k residents incl. expatriates) and highly concentrated — roughly 45–50% live in the Greater Malé region (Malé, Hulhumalé, Vilimalé, Hulhulé) | Total addressable clinic count is in the low hundreds. We cannot win on volume; we win on **depth of workflow ownership per clinic** and on being the default booking rail. |
| The remaining population is spread across ~180+ inhabited islands, reachable only by boat or domestic flight | Patient travel is measured in **hours and ferry timetables**, not minutes. A 20-minute queue delay in Malé can cost an atoll patient an overnight stay. This is the single strongest driver of the B2C value proposition. |
| Universal state health insurance (**Aasandha**) covers Maldivian citizens; expatriate workers (a large share of the workforce) are covered by employer/private schemes or self-pay | Billing is **multi-payer by default**. A single-payer design would fail on day one. |
| **eFaas** is the national digital identity / SSO scheme | eFaas is the correct primary identity anchor for patients and for Aasandha entitlement linkage. Phone-number-only identity is insufficient for insurance flows. |
| Mobile penetration is very high; **Viber** is the dominant messaging app, well ahead of SMS for interpersonal comms | Notification strategy must be **Viber-first with SMS fallback**, not SMS-first. SMS remains the reliability floor (works on any handset, no data). |
| Two telcos: Dhiraagu and Ooredoo Maldives | Only two aggregator relationships to negotiate for A2P messaging; both are viable zero-rating / co-marketing partners. |
| Dhivehi is written in **Thaana**, a right-to-left script. English is widely used in clinical settings. Large expatriate populations speak Bengali, Hindi/Urdu, Sinhala, Tagalog | Full **RTL layout support** is a launch requirement, not a phase-2 item. Doctor "language spoken" is a genuine discovery filter, not a vanity field. |
| The weekend is **Friday–Saturday**; Sunday is a working day. Clinics commonly run split sessions (e.g. 09:00–12:00, 16:00–18:00, 20:00–22:00) with the evening session busiest | Scheduling primitives must be session-based, not "9-to-5 with lunch". Weekend logic must be configurable, never hardcoded to Sat–Sun. |
| Clinic activity pauses around the five daily prayer times, and Ramadan shifts operating hours substantially | The wait-time engine must model **scheduled blackout intervals** as first-class objects. An ETA engine that ignores prayer pauses will be wrong every single day. |
| Cash and card are giving way to mobile wallets: **BML** rails (Bank of Maldives) and **Ooredoo m-Faisaa** | Payment integration is a checkout requirement, and pay-before-you-arrive is a genuine queue-throughput improvement. |

## 2. The problem in one paragraph

A patient in Malé books an appointment for 16:00, arrives at 15:45, and is seen at 18:20. Nobody lied to them; the doctor started 40 minutes late, three walk-ins were inserted, and one consultation ran 25 minutes over. The clinic has no mechanism to tell the patient any of this, because the queue lives on a paper register at the reception desk and in the receptionist's head. The lobby fills with people who are physically present only because being physically present is the *only* way to know your position. For an atoll patient, that lobby is the reason they booked a hotel room.

The root cause is not the booking. It is that **the queue has no live, authoritative, machine-readable state**. Everything else — patient anxiety, lobby crowding, receptionist phone load, doctor punctuality drift — is downstream of that.

## 3. Product strategy: B2B first, B2C as the demand-side flywheel

```
     ┌─────────────────────────────────────────────────────────┐
     │  Vaguthu Clinic (B2B)  — owns the queue's source of truth │
     │  Receptionist · Doctor · Billing · Admin                  │
     └───────────────┬─────────────────────────────────────────┘
                     │  Partner API + Webhooks (docs/api/)
        ┌────────────┼─────────────────────┐
        ▼            ▼                     ▼
   Vaguthu (B2C)  3rd-party apps      Employer / insurer
   patient app    (aggregators)       portals
```

Three commitments that follow from this shape:

1. **The B2B dashboard must be independently valuable.** A clinic that never has a single patient use the app must still consider Vaguthu Clinic the best money it spends. If the B2B product only works when patients adopt the app, we have a chicken-and-egg problem we cannot solve in a market this small.
2. **The B2C app must never be the only consumer of the API.** We publish the same contract to third parties. This is a deliberate concession: it makes the B2B pitch credible ("we are not locking your patients into our app"), and it makes us the rail rather than the destination.
3. **Adoption of B2C is bought with B2B distribution.** The receptionist installing the app for a patient at check-in is our cheapest acquisition channel by an order of magnitude. See §7 of the B2C PRD.

## 4. Working assumptions — and how we de-risk each

These are stated explicitly because several are **unverified as of drafting** and materially affect scope. Each has a named de-risking action with a date gate.

| # | Assumption | Confidence | De-risking action | Gate |
|---|---|---|---|---|
| A1 | Aasandha exposes (or will grant under partnership) a machine interface for eligibility verification and claim submission | **Low** — no public developer documentation is available to us | Partnership conversation with Aasandha Company Ltd / NSPA before committing engineering. Build the billing module behind a `PayerAdapter` interface so a manual/portal-assisted flow ships if the API does not exist | Before Billing epic kickoff |
| A2 | eFaas supports third-party OIDC relying parties for consumer apps | **Medium** | Formal application to NCIT; fallback is phone + national ID number with in-clinic verification by the receptionist | Before B2C identity epic |
| A3 | BML and Ooredoo m-Faisaa offer merchant payment APIs with webhook callbacks suitable for a marketplace/aggregator model | **Medium-High** | Merchant onboarding conversation with both; design `PaymentAdapter` with card-gateway fallback | Before Payments epic |
| A4 | Viber Business Messages is commercially available to us at viable per-message pricing | **Medium** | Pricing quote via a Viber BSP; SMS-only fallback is fully functional, just costlier and less rich | Before B2C launch |
| A5 | No comprehensive personal data protection statute is in force; sectoral health rules and patient-rights regulation apply | **Medium** | Engage local counsel. **Design to a GDPR-equivalent baseline regardless** — this is cheaper than retrofitting when legislation lands, and it is a sales asset with corporate/insurer buyers | Continuous; legal review before GA |
| A6 | Clinics will accept cloud-hosted PHI outside the Maldives | **Low-Medium** | Region selection (nearest low-latency region, e.g. Mumbai) plus a documented data-residency roadmap. Offer in-country backup export. Expect this to be the #1 objection from hospital-scale buyers | Before first enterprise deal |
| A7 | Typical target clinic has 1–15 doctors, 1–3 reception staff, and existing software is either nothing, Excel, or a legacy on-prem HMS | **Medium-High** | 15 discovery interviews across Greater Malé and 3 atoll clinics before spec freeze | Before spec freeze |

> **Rule for the team:** anything in this repository that depends on A1–A4 is written against an *adapter interface*, never against a vendor's concrete API. If an integration is refused, the product degrades to a manual workflow — it does not fail to ship.

## 5. Competitive set

| Competitor type | Examples | Their weakness | Our wedge |
|---|---|---|---|
| Pen, paper, and a whiteboard | Most small clinics | No live state, no analytics, no remote visibility | Everything |
| Legacy on-prem HMS (regional vendors, often India/Sri Lanka-sourced) | Various | Heavy, slow, licence + server cost, no queue intelligence, no patient-facing surface, poor RTL/Dhivehi support | Speed, price, queue engine, Maldives-native localisation |
| Generic global booking SaaS | Calendly-class, international clinic SaaS | No Aasandha, no eFaas, no local payment rails, no Viber, no Thaana, no atoll travel model | Local integration depth |
| Hospital in-house systems | IGMH, ADK, Tree Top-class institutions | Not sold to third parties; expensive to build | We are the option for everyone who is not a large hospital — and eventually the queue layer *inside* one |

**The defensible position is not the software. It is the integration set** (Aasandha + eFaas + BML + m-Faisaa + both telcos + Viber) **plus the installed queue base.** Any one of these is copyable; assembling all of them for a market of a few hundred clinics is a poor return for a foreign entrant, which is exactly why the position holds.

## 6. Success metrics (portfolio level, 18 months)

| Metric | 6 mo | 12 mo | 18 mo |
|---|---|---|---|
| Paying clinics | 12 | 45 | 90 |
| Doctor seats under management | 40 | 180 | 400 |
| Monthly tokens processed through the engine | 15k | 90k | 220k |
| Registered patients (B2C) | 4,000 | 22,000 | 55,000 |
| Median lobby dwell time before consultation, instrumented clinics | −15% | −30% | −40% |
| ETA accuracy: % of tokens where actual start falls inside published P80 window | 65% | 80% | 88% |
| Net revenue retention (B2B) | — | 105% | 115% |

The ETA accuracy row is the one that matters most. Every other number is downstream of patients trusting the estimate enough to stop sitting in the lobby.
