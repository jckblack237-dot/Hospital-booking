# Vaguthu — Clinic Queue Platform for the Maldives

Product documentation for a two-sided healthcare queue platform:

- **Vaguthu Clinic** (B2B) — a cloud clinic CRM and queue-management dashboard that owns the live state of a clinic's queue.
- **Vaguthu** (B2C) — a patient app for discovering doctors, booking, and tracking a live token from home.

The B2B product works entirely on its own. The B2C app is one client of a public Partner API that any third-party app can also use.

> `Vaguthu` (Dhivehi: *time*) is a working name pending trademark clearance.

## Documents

| Document | What it covers |
|---|---|
| [`docs/01-market-context.md`](docs/01-market-context.md) | Why the Maldives is a distinct market, platform strategy, the assumptions (A1–A7) both PRDs depend on, competitive set, portfolio metrics |
| [`docs/02-prd-b2b-clinic-command-center.md`](docs/02-prd-b2b-clinic-command-center.md) | **B2B PRD.** Receptionist Command Center, Doctor Module, Billing & Insurance, Admin & Analytics, receptionist and doctor journeys, SaaS pricing strategy, rollout, risks |
| [`docs/03-prd-b2c-patient-app.md`](docs/03-prd-b2c-patient-app.md) | **B2C PRD.** Discovery, live token tracking, patient wallet, notification engine, personas, UX flow, edge cases, acquisition plan for the first 10,000 patients |
| [`docs/04-dynamic-token-engine.md`](docs/04-dynamic-token-engine.md) | Technical architecture of the wait-time engine: estimation model, event pipeline, notification materiality, degradation, calibration metrics |
| [`docs/05-partner-api-and-webhooks.md`](docs/05-partner-api-and-webhooks.md) | Partner API blueprint: auth and scopes, two-phase booking, live queue reads, the full webhook catalogue and delivery semantics |
| [`docs/api/openapi.yaml`](docs/api/openapi.yaml) | Machine-readable sketch of the Partner API |

## The thesis in four claims

1. **The queue has no digital source of truth today.** Lobby crowding, patient anxiety, receptionist phone load, and invisible doctor punctuality are all downstream of that one gap.
2. **Whoever owns that source of truth owns the market's booking rail.** So we sell the clinic dashboard first, and it must be worth paying for even if no patient ever installs an app.
3. **The estimate is the product.** A patient leaves the lobby only if they believe the number. Everything in [`04-dynamic-token-engine.md`](docs/04-dynamic-token-engine.md) exists to make the number believable — windows instead of points, an explicit reason on every change, and calibration measured as P80 coverage.
4. **The defensible position is the integration set, not the software.** Aasandha, eFaas, BML, m-Faisaa, both telcos, Viber, Thaana RTL, prayer-time scheduling. Any one is copyable; assembling all of them for a few hundred clinics is a poor return for a foreign entrant.

## Status

Draft v1.0, for review. Several integration assumptions (Aasandha, eFaas, payment rails, Viber pricing) are **unverified** and are tracked with confidence levels and named de-risking gates in [`docs/01-market-context.md`](docs/01-market-context.md) §4. Every dependent feature is specified behind an adapter interface with a working degraded path, so a refused integration delays capability — it does not block the product.
