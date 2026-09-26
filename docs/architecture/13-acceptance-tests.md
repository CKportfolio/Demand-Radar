# 13 — Acceptance Tests

These are the tests that prove **this delivery** (Phase A + Phase B: docs + infra skeleton,
no app code) is correct, plus forward-looking acceptance tests for the vertical slice
(Phase C/D from [12-mvp-roadmap.md](12-mvp-roadmap.md)) so implementers know the bar in
advance.

## This delivery (Phase A + B) — acceptance checklist

| # | Check | How to verify |
|---|---|---|
| 1 | All 15 architecture docs exist and cross-link correctly | Files present under `docs/architecture/`; spot-check relative links resolve |
| 2 | Every architecture doc containing a system/flow diagram uses Mermaid | Visual scan of `00`, `02`, `04`, `05`, `08`, `10`, `12` |
| 3 | `14-decisions.md` uses ADR format (problem/options/decision/consequences) for every decision | Visual scan |
| 4 | `DiscoveryPlanV1.schema.json` is valid JSON Schema draft-07 and contains **no** `$ref`/`$defs` | `python -m json.tool` (or equivalent) parses it; grep for `$ref` returns nothing |
| 5 | `docker-compose.n8n.yml` defines exactly one service (`n8n`), binds `127.0.0.1:5678:5678`, mounts a named volume at `/home/node/.n8n`, pins a specific image tag (not `latest`), and requires **no** env file / secrets to start | Manual review of the file; `docker compose -f docker-compose.n8n.yml up -d` succeeds with zero `.env.n8n` file present |
| 6 | `.env.example` exists with placeholder (non-real) values only; no `N8N_AUTH_MODE`/`N8N_SHARED_SECRET`/`N8N_ENCRYPTION_KEY` variables appear in **active runtime configuration** — `docker-compose.n8n.yml`, `.env.example`, the PowerShell startup scripts (`scripts/*.ps1`), or any active app configuration | Manual review of those specific files/paths; grep scoped to them (historical ADR/security discussion in `docs/architecture/` may still mention these identifiers by name and is explicitly exempt — see [14-decisions.md](14-decisions.md) ADR-07/ADR-11/ADR-15) |
| 7 | `n8n/` folder contains `README.md`, `workflows/`, `prompts/`, `schemas/` | `list_dir` |
| 8 | `scripts/n8n-up.ps1`, `scripts/n8n-down.ps1`, `scripts/n8n-logs.ps1` exist, wrap `docker compose -f docker-compose.n8n.yml ...`, and do not require a `.env.n8n` file | Manual review |
| 9 | Root `README.md` documents first-run steps (copy `.env.example`, `n8n-up.ps1`, open `http://127.0.0.1:5678`, manual n8n GUI onboarding) with **no** encryption-key/shared-secret generation step | Manual review |
| 10 | No application code (Node.js app, Playwright collector) was implemented in this delivery | `list_dir` shows no `src/` app implementation beyond what's explicitly listed as Phase B scope |
| 11 | Running `docker compose -f docker-compose.n8n.yml config` succeeds (valid compose syntax) against the real file, with no env file present | Manual terminal check when Docker Desktop is available |
| 12 | n8n container starts and the editor is reachable at `http://127.0.0.1:5678` with zero manual secret setup beforehand | Manual check: `scripts/n8n-up.ps1`, then open the URL, complete n8n's own first-run account setup |

## Forward-looking acceptance tests (Phase C/D — not run in this delivery)

| # | Check |
|---|---|
| 13 | MR-01 Production URL, called with a realistic brief payload, returns HTTP 200 with a body that validates against `DiscoveryPlanV1.schema.json` |
| 14 | MR-01 called with a missing required brief field returns a clear error response, not a 500 or a malformed LLM call |
| 15 | MR-02 Production URL, called with a valid `currentPlan` + `userInstruction`, returns a new schema-valid plan with non-empty `changeSummary` |
| 16 | An intentionally malformed LLM response (simulate by breaking the schema temporarily) triggers exactly one repair attempt, then a clear failure — never a silently stored invalid plan |
| 17 | Submitting a Project Brief through the real UI, with the real n8n container running, produces a stored `DiscoveryPlanVersion` row with `status=DRAFT` and a schema-valid `planJson` |
| 18 | `LLM_MOCK_MODE=true` lets the full UI flow (brief → plan) work with n8n stopped |
| 19 | Approving a new plan version flips the previously `APPROVED` version to `SUPERSEDED`, and only one `APPROVED` version ever exists per project |
| 20 | A `DELETE` to any `/api/data/*` endpoint without `{ "confirm": true }` in the body is rejected, not executed |
| 21 | Changing only `N8N_BASE_URL` (and related path vars) in `.env`, with no code changes, correctly redirects MR-01/MR-02 calls to a second, separately-running n8n instance (simulates the VPS switch) |
| 22 | `POST /api/discovery-plans/:versionId/manual-revision` with a valid edited plan (no `changeNote` required) creates a new `DiscoveryPlanVersion` with `sourceEvent=MANUAL_REVISION`, `parentVersionId = :versionId`, and a non-empty `changeSummary` generated mechanically by the app (no `changeSummary` supplied by the client, no n8n call made) |
| 23 | `POST /api/discovery-plans/:versionId/manual-revision` with a duplicate item `id` in the edited plan is rejected (`400`), and nothing is persisted |
| 24 | Sending the same `requestId` twice to the same endpoint (`generate-plan`, `revise-plan`, or `manual-revision`), after the first has reached `COMPLETED`, returns the same `DiscoveryPlanVersion` both times and creates only one row in the database |
| 25 | A `seedQueries[]` item toggled `enabled: false` via manual revision is preserved (not deleted) with its original `id`, produces a `Disabled seed query "..."` line in the mechanically generated `changeSummary`, and the resulting document is still schema-valid |
| 26 | MR-01's `discoveryStrategies[]` output only ever uses `source`/`mode` pairs present in the `availableDiscoveryCapabilities` sent in the request |
| 27 | `DiscoveryPlanVersion.briefSnapshotJson` reflects the `Project` brief fields as they were at generation/revision time, even if the `Project` row is edited afterward |
| 28 | `DiscoveryPlanVersion.parentVersionId` is `null` for every `sourceEvent=LLM_GENERATION` version, and equals the `:versionId` supplied on the call for every `LLM_REVISION`/`MANUAL_REVISION` version — verified independently of `versionNumber` (e.g. by constructing a case where they'd diverge if ancestry were wrongly inferred from `versionNumber - 1`) |
| 29 | Two requests sent with the identical `(endpoint, requestId)` pair while the first is still being processed: the second receives `409 REQUEST_IN_PROGRESS` immediately, no second n8n call is made, and exactly one `DiscoveryPlanVersion` is eventually created |
| 30 | A `requestId` whose `RequestLog` row reached `FAILED` (e.g. n8n was unreachable) does not auto-retry on a repeat of the same `requestId`; the same failure is returned again, and only a genuinely new `requestId` can succeed |
| 31 | `ChatMessage` rows never contain a `role` value other than implicitly "user" (no `role` column exists); the Plan Chat UI's assistant bubble for a given turn is reconstructed from that row's `outputPlanVersionId` → `changeSummary`/`warnings`, not from a stored assistant row |

## Out of scope for acceptance testing in this delivery

Playwright collector behavior, `DiscoveryRun` end-to-end execution, advertiser/taxonomy
discovery quality, and any LLM output *quality* judgment (as opposed to schema validity) — all
belong to later phases per [12-mvp-roadmap.md](12-mvp-roadmap.md).
