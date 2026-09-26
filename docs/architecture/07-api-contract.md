# 07 — API Contract

Two separate contracts exist and must not be confused:

1. **Frontend ↔ App** — the local app's own HTTP API, consumed by its own frontend.
2. **App ↔ n8n** — the app calling n8n's webhooks (MR-01, MR-02).

## 1. Frontend ↔ App API (`http://127.0.0.1:7654`)

Framework choice (Fastify vs. Express) is left open here deliberately — either satisfies
everything below; pick one in [codex-implementation-brief.md](codex-implementation-brief.md)
and don't relitigate it mid-implementation. All request/response bodies are JSON.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects` | List projects |
| `POST` | `/api/projects` | Create project (the Project Brief fields, see [01](01-product-model.md)) |
| `GET` | `/api/projects/:id` | Get one project |
| `PATCH` | `/api/projects/:id` | Edit brief fields |
| `DELETE` | `/api/projects/:id` | Delete project (Data Explorer / project screen; cascades to plan versions/runs) |
| `POST` | `/api/projects/:id/discovery-plans` | Trigger MR-01 → creates `DiscoveryPlanVersion` v1 (`sourceEvent=LLM_GENERATION`, `parentVersionId = null`) |
| `GET` | `/api/projects/:id/discovery-plans` | List plan versions for a project |
| `GET` | `/api/discovery-plans/:versionId` | Get one plan version (full `DiscoveryPlanV1` + metadata, including `parentVersionId`) |
| `POST` | `/api/discovery-plans/:versionId/revise` | Trigger MR-02 with a free-text user instruction → creates the next version (`sourceEvent=LLM_REVISION`, `parentVersionId = :versionId`) |
| `POST` | `/api/discovery-plans/:versionId/manual-revision` | Apply a direct, LLM-free edit (from the plan UI: toggle/edit/remove an item) → creates the next version (`sourceEvent=MANUAL_REVISION`, `parentVersionId = :versionId`). See shape below — a first-class, equally-supported alternative to `/revise`, not a fallback. |
| `POST` | `/api/discovery-plans/:versionId/approve` | Mark `APPROVED`, supersede the prior `APPROVED` version |
| `POST` | `/api/discovery-plans/:versionId/reject` | Mark `REJECTED` |
| `GET` | `/api/projects/:id/chat-messages` | List `ChatMessage` rows (user instructions only — see [05-data-model.md](05-data-model.md)) for the project's "Plan chat" screen, ordered by `createdAt`; the frontend reconstructs each "assistant" bubble from the row's `outputPlanVersionId` → `changeSummary`/`warnings`, no separate assistant row exists |
| `GET` | `/api/data/*` | Data Explorer read endpoints (list/filter/preview any table) |
| `DELETE` | `/api/data/*` | Data Explorer destructive endpoints (delete record/project/clear test data) — must require an explicit confirmation flag in the request body, e.g. `{ "confirm": true }`, and must never be a bare `DELETE` triggered by a GET-like link |

Error shape (all endpoints): `{ "error": { "code": "STRING_CODE", "message": "human readable" } }`
with an appropriate HTTP status (`400` validation, `404` not found, `409` conflict e.g.
approving while another approval is in flight, `502` upstream n8n failure, `504` upstream n8n
timeout, `409 REQUEST_IN_PROGRESS` for a `requestId` still being processed — see idempotency
section below).

`GET /api/data/discovery-plan-versions` (and any other `DiscoveryPlanVersion` Data Explorer
view) must surface `parentVersionId` as a plain column alongside `versionNumber` — this is the
only UI requirement for plan lineage in this delivery; no branching/tree view is built, just a
correctly readable `parentVersionId` per row (see [05-data-model.md](05-data-model.md)).

### `POST /api/discovery-plans/:versionId/manual-revision`

Request:
```json
{
  "requestId": "uuid",
  "editedPlan": { "...": "the full DiscoveryPlanV1 object as edited client-side (copy of the current version with the user's item edits/toggles/removals applied), excluding changeSummary/warnings" },
  "changeNote": "optional string — a short free-text note the user may add; never required"
}
```

The user is **never required** to write a changelog entry for a manual edit. Instead, the app
builds `changeSummary` itself, mechanically, from a structural diff between the parent version's
`planJson` and `editedPlan` — no LLM call is involved. The diff walks each `id`-keyed array
(`seedQueries`, `discoveryStrategies`, `candidateProductTypes`, `initialTaxonomy`, `constraints`,
`saturationCriteria`, `openUnknowns`) and produces one line per detected change, for example:

- `Disabled seed query "organic dog treats"`
- `Added seed query "grain-free dog treats"`
- `Changed priority of "organic dog treats" from medium to high`
- `Removed taxonomy item "premium pet food"`

If `changeNote` is present, it is appended after the generated bullet list (e.g. as a trailing
"Note: ..." line) — it supplements the mechanical summary, it never replaces it. If the diff
detects no structural changes at all (edge case: the user submitted an edit that nets out
identical to the parent), `changeSummary` falls back to `changeNote` if present, or to a fixed
string such as `"No structural changes."` if not — `DiscoveryPlanV1.changeSummary` stays a
required, non-null string in every case, per the schema.

App behavior: builds the candidate document as
`{ ...editedPlan, changeSummary: <generated>, warnings: [] }`, runs the same schema + stable-ID
validation as MR-01/MR-02 output (see [06-discovery-plan-contract.md](06-discovery-plan-contract.md)),
and on success persists it as a new `DiscoveryPlanVersion` with `sourceEvent=MANUAL_REVISION`
and `parentVersionId = :versionId`. **No n8n call is made for this endpoint.** On validation
failure, the request is rejected with `400` and nothing is persisted — there is no repair
attempt, since there is no LLM in this path. This is a deliberately mechanical, non-semantic
diff (no AI-assisted summarization) — keep it that way; a smarter summary is not worth an LLM
call on every checkbox toggle.

Response (`200`): the new `DiscoveryPlanVersion` (same shape as the `GET
/api/discovery-plans/:versionId` response).

## 2. App ↔ n8n contract

### Configuration (env vars the app reads — see `.env.example`)

| Variable | Example (local) | Purpose |
|---|---|---|
| `N8N_BASE_URL` | `http://127.0.0.1:5678` | Base URL, swapped for VPS migration ([04](04-future-vps-switch.md)) |
| `N8N_GENERATE_PLAN_PATH` | `/webhook/mr01-generate-plan` | MR-01 production webhook path |
| `N8N_REVISE_PLAN_PATH` | `/webhook/mr02-revise-plan` | MR-02 production webhook path |
| `N8N_REQUEST_TIMEOUT_MS` | `60000` | Client-side timeout for the whole request/response cycle |
| `LLM_MOCK_MODE` | `false` | When `true`, the app's `n8nClient` returns a canned, schema-valid `DiscoveryPlanV1` instead of calling n8n at all — for frontend/dev work without an LLM key configured, and requires zero n8n dependency (no Docker container needs to be running) |

No authentication is configured between the app and n8n in this phase — see
[09-security.md](09-security.md) for why that's fine for a loopback-only local setup, and
[04-future-vps-switch.md](04-future-vps-switch.md) for why it's explicit future work before a
VPS move.

All app code that needs to reach n8n does so through **one client module** (e.g.
`src/clients/n8nClient.ts`) that reads exactly these variables. No other module constructs an
n8n URL directly — this is what makes the VPS switch a one-file, one-config change.

### MR-01 — `POST {N8N_BASE_URL}{N8N_GENERATE_PLAN_PATH}`

Request:
```json
{
  "requestId": "uuid",
  "projectId": "uuid",
  "brief": {
    "competencies": "string",
    "qualifications": "string",
    "availableProductFormats": ["onlineCourse", "webinar"],
    "market": { "country": "PL", "language": "pl" },
    "constraints": "string",
    "exclusions": "string"
  },
  "availableDiscoveryCapabilities": [
    { "source": "META_AD_LIBRARY", "modes": ["KEYWORD_SEARCH"] }
  ]
}
```

`availableDiscoveryCapabilities` is **not a user input** — it's the app telling MR-01 what the
current collector runtime can actually execute, so the LLM only ever proposes
`discoveryStrategies[]` entries with a `source`/`mode` pair drawn from this list (see
[06-discovery-plan-contract.md](06-discovery-plan-contract.md)). The app hardcodes this array
today (only `META_AD_LIBRARY` / `KEYWORD_SEARCH` exists); it becomes meaningfully dynamic only
once more collector capabilities are actually implemented.

Response (`200`): a `DiscoveryPlanV1` object matching
[DiscoveryPlanV1.schema.json](DiscoveryPlanV1.schema.json), returned as the raw JSON body via
n8n's `Respond to Webhook` node ("JSON" response mode).

### MR-02 — `POST {N8N_BASE_URL}{N8N_REVISE_PLAN_PATH}`

Request:
```json
{
  "requestId": "uuid",
  "projectId": "uuid",
  "currentPlan": { "...": "the current DiscoveryPlanV1 object" },
  "userInstruction": "string — the latest chat message",
  "recentConversation": [
    { "role": "user", "content": "string — a prior ChatMessage.content" },
    { "role": "assistant", "content": "string — that turn's resulting changeSummary/warnings, reconstructed by the app; never a persisted row" }
  ],
  "availableDiscoveryCapabilities": [
    { "source": "META_AD_LIBRARY", "modes": ["KEYWORD_SEARCH"] }
  ]
}
```

`recentConversation` uses `user`/`assistant` roles only — never `system` (system prompts are
internal to the n8n workflow, see [08-n8n-workflows.md](08-n8n-workflows.md), and are never
part of this array). The app assembles this array fresh on every call by reading recent
`ChatMessage` rows (`user` turns) and reconstructing each `assistant` turn from that row's
`outputPlanVersionId` → `changeSummary`/`warnings` (see [05-data-model.md](05-data-model.md)) —
no separate assistant-authored row is ever stored.

Response (`200`): a new `DiscoveryPlanV1` object (same schema), with `changeSummary` and
`warnings` populated. On success the app also writes a `ChatMessage` row
(`inputPlanVersionId` = the version being revised, `outputPlanVersionId` = the new version) and
sets the new `DiscoveryPlanVersion.parentVersionId` to the version that was being revised.

## 3. Idempotency (`requestId`)

All three plan-producing calls — `POST /discovery-plans` (MR-01), `POST
/discovery-plans/:versionId/revise` (MR-02), and `POST
/discovery-plans/:versionId/manual-revision` — require a client-supplied `requestId` (a UUID
generated once per user action, e.g. once per click of "Generate"/"Send"/"Save edit"). The app
reserves a `RequestLog` row **atomically, before doing any work** — see
[05-data-model.md](05-data-model.md) for the full lifecycle. The uniqueness constraint is
**`UNIQUE(endpoint, requestId)`** — scoped per endpoint, never a bare global `UNIQUE(requestId)`;
this document and the data model must never disagree on that point.

- **First time** a `(endpoint, requestId)` pair is seen: the `PROCESSING` row insert succeeds,
  the app calls n8n / validates the manual edit, persists the new `DiscoveryPlanVersion`, then
  flips the row to `COMPLETED` (`resultPlanVersionId` set) or `FAILED`.
- **Repeated while the original is still `PROCESSING`** (near-simultaneous double-click, two
  tabs, a fast client retry racing the first attempt): the repeat's own `RequestLog` insert
  fails the unique constraint. The app makes **no** n8n call for the repeat and responds
  immediately with `409` / `REQUEST_IN_PROGRESS` — a distinct, deterministic response, not the
  eventual result.
- **Repeated after the original reached `COMPLETED`**: the app returns the same
  `DiscoveryPlanVersion` the first call produced (`200`), without calling n8n again and without
  creating a second version.
- **Repeated after the original reached `FAILED`**: the app returns the recorded failure
  (matching the original failure's status/code), still with no automatic retry. The user must
  start a genuinely new action with a **new** `requestId` — a `FAILED` `RequestLog` row is a
  dead end by design.

This is a plain unique-constraint insert/update — there is no queue, no background job, and no
automatic retry logic; the client is still fully responsible for deciding whether/when to
resend. It is also what makes "no automatic retries" (see the error taxonomy below) safe in
practice: a frontend that retries a timed-out request, or that fires the same action twice in
quick succession, can never accidentally create a duplicate plan version or double-spend an
LLM call — the atomic reservation, not just a post-hoc log, is what closes the race.

### Error / failure taxonomy (app-side handling)

| Situation | App behavior |
|---|---|
| n8n unreachable (connection refused/DNS) | Surface `502`-style error to user: "n8n is not reachable — is it running?" `RequestLog` row → `FAILED`. No retry loop. |
| n8n responds but times out before `Respond to Webhook` | Surface `504`-style error after `N8N_REQUEST_TIMEOUT_MS`. `RequestLog` row → `FAILED`. No retry loop. |
| n8n responds `200` with JSON that fails schema validation | One repair attempt (see [06](06-discovery-plan-contract.md)); if that also fails, surface a clear validation error, store nothing, `RequestLog` row → `FAILED`. |
| n8n responds non-`200` (e.g. workflow error) | Surface the error; `RequestLog` row → `FAILED`; do not attempt to interpret n8n's internal error shape beyond logging it. |
| Manual revision fails schema/stable-ID validation | `400` with a clear field-level error; no repair attempt (no LLM involved); nothing persisted; `RequestLog` row → `FAILED`. |
| Repeated `requestId` while the original is still `PROCESSING` | `409 REQUEST_IN_PROGRESS`; no new n8n call. |
| Repeated `requestId` after the original reached `COMPLETED` | Return the previously-produced `DiscoveryPlanVersion` (`200`); no new n8n call, no new version. |
| Repeated `requestId` after the original reached `FAILED` | Return the recorded failure again; no new n8n call, no automatic retry — a new `requestId` is required to try again. |

No automatic retries anywhere in this contract. Every one of these situations is a deliberate,
occasional, human-in-the-loop action — silently retrying an LLM generation risks duplicate
n8n executions and duplicate LLM spend, which is exactly what the atomic `requestId` reservation
above exists to make safe even if the client (not the app) chooses to retry.
