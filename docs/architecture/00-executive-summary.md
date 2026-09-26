# 00 — Executive Summary

## What this system is

**Market Demand Radar** is a local-first research tool that helps a creator with a defined
*capability* (e.g. "I am a psychologist, I can produce courses/webinars/trainings about
psychology") discover which **topics, market segments, and product formats currently show
advertising traction** — before the creator has decided what to build.

The system does **not** analyze competitors of a product the user already has. The product,
topic, and audience are **outputs of discovery**, not inputs.

The system never claims to observe sales, revenue, ROAS, or conversion. It only observes and
reports **indirect signals of advertising traction** (ad longevity, creative multiplication,
repeated campaigns, funnel expansion). Vocabulary is deliberately hedged: *traction signal*,
*strong demand signal*, *probable traction*, *scaling signal* — never *confirmed sale* or
*profitable ad*.

## What we are building right now (this iteration)

We are **not** building the full product. We are building:

1. A written, questioned architecture (this `docs/architecture/` folder).
2. The `DiscoveryPlanV1` contract — the single most important cross-system data structure.
3. A minimal, correct local n8n Docker Compose setup (LLM automation layer only).
4. A repository skeleton (folders, env examples, scripts) that a future implementation agent
   (Codex) can build inside **without** re-deciding the architecture.

We are explicitly **not** building yet: the Node.js application, the Playwright collector, the
frontend, or any iterative discovery loop.

## The one-sentence architecture

> A native Windows Node.js app (`:7654`) owns the SQLite database, the UI, and the Playwright
> collector; a single local n8n Docker container (`:5678`) is an LLM-automation sidecar that
> owns no Market Demand Radar application data — it turns a user brief into a validated
> `DiscoveryPlanV1` JSON and back, called synchronously over HTTP and never given direct
> database or browser access.

## Why this shape

| Decision | Reason |
|---|---|
| n8n is the *only* container | Keeps Docker's blast radius to one disposable service that owns no application data. Everything that must survive and be queried (data) lives in SQLite, owned by the app. |
| App runs natively on Windows, not in Docker | Playwright needs headed-mode, a persistent browser profile, and easy debugging. Dockerizing Playwright on Windows adds real friction (GPU/display, volume permissions, slower dev loop) for no MVP benefit. |
| SQLite, not Postgres | Single-writer local app, no concurrent multi-user access, zero ops. Postgres would be justified only by concurrency or hosting requirements this MVP doesn't have. |
| n8n never touches the app's database or the browser | Preserves a single owner of pipeline state (the app) and keeps the "swap local n8n for VPS n8n" migration to a config change, not a data-migration problem. |
| Every LLM call is synchronous request/response | No callback infrastructure needed yet; avoids the "VPS can't reach my localhost" problem entirely, at the cost of the client holding a connection open during generation (acceptable for MVP plan generation, which is a deliberate, occasional action, not a hot path). |
| Structured Output (JSON Schema) over AI Agent | Plan generation must be deterministic and schema-valid. An agent's multi-step tool loop adds cost, latency, and non-determinism the use case doesn't need. |

## Biggest risks (see [11-risk-register.md](11-risk-register.md) for detail)

1. Meta Ad Library has no stable public scraping contract — the Playwright collector boundary
   is deliberately deferred and inspectable (`collector:inspect`), not guessed.
2. LLM structured-output reliability varies by provider — the contract mandates
   app-side JSON Schema validation plus **at most one** repair attempt, never silent retries.
3. "Traction signal" language discipline must be enforced everywhere (prompts, schema,
   frontend copy) or the whole product thesis (no sales claims) quietly erodes.
4. Community Edition n8n has no Git-based Source Control (that's a paid feature) — workflow
   portability across local → VPS depends on plain JSON export/import, which this repo
   accounts for explicitly (`n8n/workflows/*.json`).

## Document map

| File | Purpose |
|---|---|
| [01-product-model.md](01-product-model.md) | What the product is/isn't, discovery vocabulary, user brief model |
| [02-local-topology.md](02-local-topology.md) | Processes, ports, volumes, what runs where |
| [03-n8n-boundary.md](03-n8n-boundary.md) | Exactly what n8n is and is not allowed to do |
| [04-future-vps-switch.md](04-future-vps-switch.md) | How local → VPS n8n migration works |
| [05-data-model.md](05-data-model.md) | SQLite entities and relationships |
| [06-discovery-plan-contract.md](06-discovery-plan-contract.md) | `DiscoveryPlanV1` explained field by field |
| [07-api-contract.md](07-api-contract.md) | Local app HTTP API + app↔n8n HTTP contract |
| [08-n8n-workflows.md](08-n8n-workflows.md) | MR-01 / MR-02 workflow design |
| [09-security.md](09-security.md) | Webhook auth, secrets, prompt injection |
| [10-playwright-boundary.md](10-playwright-boundary.md) | Collector interface, `collector:inspect`, safety stop conditions |
| [11-risk-register.md](11-risk-register.md) | Risks and mitigations |
| [12-mvp-roadmap.md](12-mvp-roadmap.md) | Build order for the vertical slice and beyond |
| [13-acceptance-tests.md](13-acceptance-tests.md) | How we'll know the vertical slice works |
| [14-decisions.md](14-decisions.md) | ADRs |
| [DiscoveryPlanV1.schema.json](DiscoveryPlanV1.schema.json) | The JSON Schema itself |
| [codex-implementation-brief.md](codex-implementation-brief.md) | Brief for the next implementation agent |
