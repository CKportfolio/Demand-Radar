# Codex Implementation Brief

You are picking up **Market Demand Radar** after its architecture phase is complete. This
document is your entry point — read it first, then follow the links.

## Read in this order

1. [00-executive-summary.md](00-executive-summary.md) — the whole system in one page.
2. [01-product-model.md](01-product-model.md) — what the product is/isn't, vocabulary rules.
3. [02-local-topology.md](02-local-topology.md) — what runs where.
4. [03-n8n-boundary.md](03-n8n-boundary.md) — what n8n may and may not do. Read this before
   touching anything n8n-related.
5. [05-data-model.md](05-data-model.md) and [06-discovery-plan-contract.md](06-discovery-plan-contract.md)
   plus [DiscoveryPlanV1.schema.json](DiscoveryPlanV1.schema.json) — the data you'll be
   building against.
6. [07-api-contract.md](07-api-contract.md) — the API you'll implement.
7. [08-n8n-workflows.md](08-n8n-workflows.md) — the n8n workflows you'll build first.
8. [12-mvp-roadmap.md](12-mvp-roadmap.md) — the build order. **Follow this order.**
9. [13-acceptance-tests.md](13-acceptance-tests.md) — how you'll know each phase is done.
10. [14-decisions.md](14-decisions.md) — why things are the way they are; check here before
    proposing a structural change.
11. [11-risk-register.md](11-risk-register.md) — known sharp edges.
12. [09-security.md](09-security.md) and [10-playwright-boundary.md](10-playwright-boundary.md)
    — read before building the collector.

## What already exists (do not redesign these)

- `docker-compose.n8n.yml`, `.env.example` — the infra skeleton ([Phase B](12-mvp-roadmap.md)).
  `docker-compose.n8n.yml` requires **no env file and no secrets** to start.
- `n8n/README.md`, `n8n/workflows/`, `n8n/prompts/`, `n8n/schemas/` — folder structure and
  placeholders for MR-01/MR-02.
- `scripts/n8n-up.ps1`, `scripts/n8n-down.ps1`, `scripts/n8n-logs.ps1` — PowerShell wrappers.
- `DiscoveryPlanV1.schema.json` — the contract. Treat as frozen at `schemaVersion: "1.1"`
  unless you have a concrete reason to evolve it (see the evolution procedure in
  [06-discovery-plan-contract.md](06-discovery-plan-contract.md#schema-evolution)).

## Your first concrete task (Phase C, per the roadmap)

Build MR-01 and MR-02 for real in the n8n editor, following
[08-n8n-workflows.md](08-n8n-workflows.md) node-by-node. Do not start on the Node.js app before
these work end-to-end (test them with `curl`/Postman against the Production URLs).

## Hard rules (violating these is a regression, not a stylistic choice)

1. **Never** give n8n direct access to the app's SQLite database or the Playwright browser.
2. **Never** use the AI Agent node for MR-01/MR-02 — Basic LLM Chain + Structured Output
   Parser only, unless you're solving a genuinely new, multi-step, tool-using problem (write a
   new ADR if so).
3. **Never** add `$ref`/`$defs` to `DiscoveryPlanV1.schema.json`.
4. **Never** let a plan get stored without passing schema validation. One repair attempt, then
   hard failure — no silent partial saves.
5. **Never** introduce automatic retries on app↔n8n calls.
6. **Never** use "confirmed sale", "the product sells", "profitable ad", "ROAS", "revenue",
   "conversion rate" (unless explicitly qualified as *not observed*) anywhere in prompts,
   schema descriptions, or UI copy. Use "traction signal" / "demand signal" / "probable
   traction" / "scaling signal" instead.
7. **Never** require "topic", "target customer", or "problem to solve" as an input field on
   the Project Brief — those are discovery outputs, not inputs.
8. **Never** add Postgres, Redis, a message queue, or a second Docker service without writing
   a new ADR in [14-decisions.md](14-decisions.md) explaining the concrete requirement.
9. **Never** implement an async/callback pattern between n8n and the app speculatively — only
   when a concrete long-running-job requirement exists, and pick from the documented menu in
   [04-future-vps-switch.md](04-future-vps-switch.md).
10. **Never** wire a destructive Data Explorer action to anything but an explicit
    `{ "confirm": true }` body.
11. **Never** treat manual plan revision as a lesser/fallback path — `POST
    /discovery-plans/:versionId/manual-revision` is an equal, first-class way to produce a new
    `DiscoveryPlanVersion` (`sourceEvent=MANUAL_REVISION`), alongside MR-01/MR-02, per
    [07-api-contract.md](07-api-contract.md) and ADR-12.
12. **Never** let the LLM (MR-01/MR-02) propose a `discoveryStrategies[]` entry whose
    `source`/`mode` isn't present in the `availableDiscoveryCapabilities` sent in that request —
    this is enforced structurally by the schema's enums; don't loosen them to make the LLM's
    life easier (ADR-13).
13. **Never** skip the `requestId` idempotency check on `generate-plan`/`revise-plan`/
    `manual-revision` — the app must reserve the `RequestLog` row **atomically, before** calling
    n8n or validating a manual edit, via an insert guarded by the `UNIQUE(endpoint, requestId)`
    constraint (never a bare global `UNIQUE(requestId)`). A repeat of the same `(endpoint,
    requestId)` while the original is still `PROCESSING` must return `409 REQUEST_IN_PROGRESS`
    with no n8n call; a repeat after `COMPLETED` returns the prior result; a repeat after
    `FAILED` returns the recorded failure and never auto-retries — a genuinely new `requestId`
    is required (ADR-14).
14. **Never** add app↔n8n authentication (shared secret, HMAC, etc.) without first writing a
    new ADR — local MVP intentionally has none (loopback-only), and this is deliberate, not an
    oversight to "fix" (ADR-15, [09-security.md](09-security.md)).
15. **Never** infer `DiscoveryPlanVersion.parentVersionId` from `versionNumber` — it's an
    explicit, nullable field set at write time (`null` for MR-01, the acted-on `:versionId` for
    MR-02/manual-revision), and `versionNumber` remains a plain creation-order counter that
    must never be used to reconstruct lineage (ADR-16).
16. **Never** add a `role` column back onto `ChatMessage`, and never persist a `system`-role
    row anywhere — every `ChatMessage` row is implicitly a user instruction; the assistant side
    of a turn is reconstructed at render/prompt time from the linked version's `changeSummary`/
    `warnings`, and system prompts stay inside `n8n/prompts/*.md` only (ADR-17).
17. **Never** require the client to supply `changeSummary` on
    `POST /discovery-plans/:versionId/manual-revision` — it takes an optional `changeNote`, and
    the app generates `changeSummary` itself via a deterministic, non-LLM structural diff
    against the parent version (ADR-18).

## Open decisions left to you (not blocking, but decide once and record in code/README, not by drifting)

- Node.js framework: Fastify vs. Express (either satisfies [07-api-contract.md](07-api-contract.md)).
- SQLite access layer: `better-sqlite3` directly vs. a thin query builder (either satisfies
  [05-data-model.md](05-data-model.md)).
- Runtime JSON Schema validator: Zod (mirrored schema) vs. `ajv` (loads the JSON Schema
  directly) for [06-discovery-plan-contract.md](06-discovery-plan-contract.md) validation.
- Where the "one repair attempt" for invalid LLM output lives: inside the n8n workflow
  (Auto-fixing Output Parser) vs. app-side re-call (see
  [08-n8n-workflows.md](08-n8n-workflows.md#repair-on-invalid-output-pattern)).

## When you're unsure whether something is in scope

Check [12-mvp-roadmap.md](12-mvp-roadmap.md)'s "What NOT to build until its phase arrives"
section and the current phase you're in. If it's not listed as part of your current phase,
don't build it yet — flag it as a question instead of guessing.
