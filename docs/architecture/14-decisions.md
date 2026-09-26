# 14 — Decisions (ADR log)

Format per entry: Problem, Variants considered, Decision, Arguments, Consequences.

---

## ADR-01: Single Docker container, everything else native

**Problem**: How much of the system should run in Docker vs. natively on the developer's
Windows machine?

**Variants considered**:
- (a) Everything in Docker (app, n8n, Playwright) via a multi-service compose file.
- (b) Only n8n in Docker; app + Playwright native on Windows.
- (c) Nothing in Docker; run n8n via npm as well.

**Decision**: (b) — only n8n in Docker.

**Arguments**: Playwright needs headed-mode debugging and a persistent profile, both easier
natively than in Docker Desktop's Linux VM on Windows. The app owns SQLite and Playwright, so
keeping it native avoids a second execution/debugging model. n8n itself is explicitly
recommended by its own docs to run via Docker for isolation and simpler upgrades, and doesn't
need native OS access.

**Consequences**: Only one Docker Compose file to maintain (`docker-compose.n8n.yml`). Windows
Docker networking is limited to the single n8n container, minimizing exposure to Docker
Desktop/WSL2 quirks. The app's setup docs must cover native Node.js + Playwright install steps
in addition to Docker steps.

---

## ADR-02: SQLite, not PostgreSQL, for application data

**Problem**: What database should the app use for projects, plans, runs?

**Variants considered**: (a) SQLite file; (b) PostgreSQL (in Docker or native).

**Decision**: (a) SQLite.

**Arguments**: Single local user, single writer process, no concurrency requirement, zero ops
overhead, trivial backup (copy one file). Postgres would add a second Docker service and
operational surface with no corresponding requirement today.

**Consequences**: If real concurrent-write or multi-machine access needs ever appear, this
decision must be revisited explicitly (tracked as risk #10 in
[11-risk-register.md](11-risk-register.md)) — don't silently work around SQLite's limits
instead of reopening this ADR.

---

## ADR-03: n8n is an LLM sidecar with no Market Demand Radar application data, never the app's backend

**Problem**: How much orchestration/business logic should live in n8n vs. the app?

**Variants considered**:
- (a) n8n as the primary backend, driving Playwright, owning run state, calling back into a
  thin app/frontend.
- (b) n8n as a request/response LLM utility, called synchronously by an app that owns all
  domain state and orchestration.

**Decision**: (b).

**Arguments**: Keeps a single source of truth for pipeline/run state (the app). Makes the
"swap local n8n for VPS n8n" migration a config change instead of a redesign, since nothing
requires n8n to reach back into the local machine. Limits n8n's blast radius if it's
down/misconfigured/compromised. See [03-n8n-boundary.md](03-n8n-boundary.md) for the full
reasoning.

**Wording note**: earlier drafts called n8n "stateless", which is not literally true — n8n has
its own persistent state (workflows, credentials, settings, execution logs in the `n8n_data`
volume). The precise claim is narrower and is the one that actually matters here: **n8n owns
none of Market Demand Radar's application/domain data** (no projects, no plans, no runs); every
call it handles is a single, self-contained request/response with no session state carried
between calls. Use "LLM sidecar with no application data" or "stateless-per-call", not a bare
claim that n8n itself is stateless.

**Consequences**: Every new LLM-only capability added later should default to "a new
synchronous, request/response n8n workflow", not "give n8n more responsibility". Async/callback
patterns are deliberately deferred (see ADR-06).

---

## ADR-04: Basic LLM Chain + Structured Output Parser over AI Agent

**Problem**: Which n8n LLM node pattern should MR-01/MR-02 use?

**Variants considered**: (a) AI Agent (Tools Agent) node; (b) Basic LLM Chain node with
Structured Output Parser.

**Decision**: (b).

**Arguments**: MR-01/MR-02 are single-shot, deterministic "fixed input → schema-valid JSON
output" tasks with no multi-step tool use. AI Agent's tool-calling loop adds latency, cost, and
non-determinism with no corresponding benefit for this use case. Verified from n8n's own node
docs that AI Agent requires at least one connected tool and is designed for autonomous,
multi-step reasoning — not what this task needs.

**Consequences**: If a genuinely multi-step, tool-using LLM task appears later (e.g. an agent
that needs to decide which of several sub-searches to run), that would warrant its own ADR
revisiting AI Agent for that specific workflow — not a blanket switch for MR-01/MR-02.

---

## ADR-05: DiscoveryPlanV1 schema is fully flattened (no `$ref`)

**Problem**: How should the JSON Schema for the plan contract be structured?

**Variants considered**: (a) Use `$ref`/`$defs` for shared shapes (e.g. a common
`id`/`label`/`description` object type reused across arrays); (b) inline every object shape
fully, accepting duplication.

**Decision**: (b).

**Arguments**: Verified that n8n's Structured Output Parser node, in "Define using JSON
Schema" mode, does not resolve `$ref`. A schema using `$ref` would silently fail or behave
unexpectedly inside the actual n8n workflow, which is the schema's primary consumer.

**Consequences**: Some repetition across `candidateProductTypes`, `initialTaxonomy`,
`discoveryStrategies`, `constraints`, `saturationCriteria` item shapes (all
`id`/`label or description`-shaped). Accepted as a deliberate trade-off; do not "clean this up"
with `$ref` without re-verifying n8n's parser support first.

---

## ADR-06: Synchronous request/response only; no async/callback n8n patterns yet

**Problem**: Should app↔n8n calls be synchronous or support async/long-running jobs?

**Variants considered**: (a) Synchronous HTTP request/response via `Respond to Webhook`;
(b) polling; (c) public callback endpoint; (d) tunnel; (e) queue; (f) outbound WebSocket.

**Decision**: (a) only, for this phase.

**Arguments**: MR-01/MR-02 are deliberate, occasional, human-in-the-loop actions where waiting
for a response is acceptable UX. A VPS-hosted n8n cannot call back into a developer's local
machine without extra infrastructure the brief explicitly says not to build yet. Async patterns
(b)-(f) are real options but each adds infrastructure/complexity unjustified by today's need.

**Consequences**: A menu of async options is documented in
[04-future-vps-switch.md](04-future-vps-switch.md) for future reference; none are built now.
If a genuinely long-running job appears later, pick from that menu based on concrete
requirements at that time, and record the choice as a new ADR.

---

## ADR-07: n8n encryption key fixed via `.env.n8n`, not left to auto-generation

> **Superseded by ADR-11.** This decision was reversed in the correction round that introduced
> ADR-11 — the local MVP now lets n8n auto-generate and manage its own key, and no `.env.n8n`
> file exists. Kept below for history; do not follow this ADR's decision going forward.

**Problem**: Should `N8N_ENCRYPTION_KEY` be auto-generated by n8n or explicitly set?

**Variants considered**: (a) let n8n auto-generate and store it inside the Docker volume;
(b) generate it once and fix it via the `N8N_ENCRYPTION_KEY` environment variable.

**Decision (superseded, see ADR-11)**: (b).

**Arguments (as originally reasoned)**: Ties credential decryptability to a value under our
control and backup strategy (`.env.n8n`), not solely to a specific Docker volume's survival.
Directly needed for a future VPS migration where exported credentials must be decryptable with
a known key.

**Why it was reversed**: This added a mandatory manual secret-generation step to first-run setup
for a benefit (backup/restore key portability) that has no concrete need yet, and the
VPS-migration argument doesn't actually hold — see ADR-11 and
[04-future-vps-switch.md](04-future-vps-switch.md) ("credential migration is not workflow
migration"): the VPS instance was never going to share the local instance's key anyway, so
fixing the local key bought no real portability.

---

## ADR-08: Manual JSON export/import for workflow portability, not Git Source Control

**Problem**: How should MR-01/MR-02 workflow definitions move between local and VPS n8n
instances?

**Variants considered**: (a) n8n's Git-based Source Control / Environments feature; (b) manual
JSON export/import via the editor UI (**Download** / **Import from File**) or the Server CLI
(`n8n export:workflow` / `import:workflow`).

**Decision**: (b).

**Arguments**: Verified from n8n's official edition-comparison docs that Git-based Source
Control / Environments is a **paid (Business/Enterprise) feature**, not available on the
Community Edition this project uses. Manual JSON export/import is fully supported on Community
Edition and sufficient for a two-workflow, infrequently-changed automation layer.

**Consequences**: Workflow JSON files are committed to `n8n/workflows/` and must be manually
re-imported (and re-activated/published — activation state doesn't necessarily survive import,
see [08-n8n-workflows.md](08-n8n-workflows.md)) whenever they change or move environments. No
automatic Git-diff-driven sync exists; this is an accepted manual step, documented in
`n8n/README.md`.

---

## ADR-09: Pin an explicit n8n image tag, not `latest`

**Problem**: Which n8n Docker image tag should `docker-compose.n8n.yml` use?

**Variants considered**: (a) `docker.n8n.io/n8nio/n8n:latest`/`:stable`;
(b) an explicit pinned version tag, updated manually.

**Decision**: (b).

**Arguments**: `latest`/`stable` floating tags mean an unreviewed `docker compose pull` can
silently introduce a breaking change (n8n ships new minor versions most weeks per its own
docs). Pinning makes upgrades an explicit, reviewable action.

**Consequences**: The operator must periodically check the n8n Docker Hub tags / release notes
and deliberately bump the pinned tag, following the documented update procedure
(`docker compose pull` → `docker compose down` → `docker compose up -d`). The exact tag chosen
at scaffold time should be treated as "the current stable tag at setup time" and re-verified
rather than assumed correct indefinitely — n8n's docs are the source of truth for what's
current at any point in time, not this document.

---

## ADR-10: Vanilla frontend (HTML/CSS/JS), no framework, for now

**Problem**: What frontend technology should the app use?

**Variants considered**: (a) React/Next.js or similar framework; (b) vanilla HTML/CSS/JS
served by the same Node.js process.

**Decision**: (b).

**Arguments**: The UI described in [01-product-model.md](01-product-model.md) (project list,
brief form, plan viewer, plan chat, data explorer) doesn't require component-framework
complexity, client-side routing, or a build pipeline. Matches the brief's explicit preference
against unnecessary complexity.

**Consequences**: If UI complexity grows substantially (e.g. real-time collaborative editing,
complex client state), this decision should be revisited with a concrete justification, not
swapped opportunistically mid-project.

---

## ADR-11: n8n auto-generates its own encryption key (supersedes ADR-07)

**Problem**: Should the local n8n container require a pre-set `N8N_ENCRYPTION_KEY`, or manage
its own?

**Variants considered**: (a) fix the key via `.env.n8n` (the original ADR-07 decision);
(b) let n8n auto-generate and store its own key inside the `n8n_data` volume, no env var, no
`.env.n8n` file at all.

**Decision**: (b).

**Arguments**: The local MVP is single-user, single-machine, loopback-only. A pre-set key's only
real benefit (portability across a volume loss, or sharing credentials across instances) isn't
a genuine requirement today, and the VPS-migration case it was meant to support doesn't actually
need it either — see [04-future-vps-switch.md](04-future-vps-switch.md): credential migration
across instances with *different* encryption keys means re-creating credentials manually in the
new instance's GUI regardless, so a fixed key bought no real portability, only an extra
mandatory setup step (generate a key, keep `.env.n8n` in sync) for every new contributor.
`docker-compose.n8n.yml` and first-run setup ([README.md](../../README.md)) now require zero
secrets to start.

**Consequences**: If the `n8n_data` volume is lost, the key is lost with it and any credentials
must be re-entered (tracked as risk #6 in [11-risk-register.md](11-risk-register.md)) —
accepted, since re-entering one LLM API key takes under a minute. If a genuine backup/restore or
cross-instance credential-portability need appears later, revisit with a new ADR; don't
silently reintroduce `N8N_ENCRYPTION_KEY`.

---

## ADR-12: Manual plan revision is a first-class alternative to LLM revision

**Problem**: Should editing a `DiscoveryPlanV1` outside of a chat instruction (MR-02) be
supported, and if so, how?

**Variants considered**: (a) all plan changes must go through MR-02 (natural-language
instruction only); (b) a separate, LLM-free manual-edit path that is an equal, first-class way
to produce a new plan version, alongside MR-02.

**Decision**: (b).

**Arguments**: Not every edit a user wants ("turn off this one query", "fix a typo", "remove
this taxonomy item") is naturally phrased as a chat instruction, and routing trivial edits
through an LLM call adds latency, cost, and a chance of the LLM changing something the user
didn't ask about. A direct edit path keeps the versioning/audit-trail model (see
[05-data-model.md](05-data-model.md)) uniform: every version, however produced, is immutable and
append-only.

**Consequences**: `DiscoveryPlanVersion.sourceEvent` gained a third value, `MANUAL_REVISION`,
alongside `LLM_GENERATION`/`LLM_REVISION`. A new endpoint,
`POST /discovery-plans/:versionId/manual-revision`, was added
([07-api-contract.md](07-api-contract.md)). Manual revisions do not produce a `ChatMessage` row
(there is no natural-language instruction to record) and run through the same schema +
stable-ID validation as LLM-produced versions, with no LLM repair-attempt step (there's no LLM
to re-invoke) — a validation failure is a hard, immediate rejection.

---

## ADR-13: `discoveryStrategies` are capability-gated and executable, not aspirational

**Problem**: How should the plan's advertiser/campaign-discovery strategies relate to what the
collector can actually run?

**Variants considered**: (a) let the LLM freely describe any discovery approach in prose
(`id`/`label`/`description` only, as originally shaped); (b) constrain each strategy to a
`source`/`mode` pair drawn from a fixed, collector-verified capability list, sent to the LLM as
`availableDiscoveryCapabilities` on every MR-01/MR-02 request.

**Decision**: (b).

**Arguments**: Under (a), the LLM could (and, observed in practice, would) propose strategies
like "hashtag/community sweep" or "web search for reviews" that no part of this system can
execute — a plan that reads as actionable but silently isn't. Constraining `source`/`mode` to
enums matching real, implemented collector capabilities makes a non-executable plan
structurally impossible to produce, the same way the schema already makes a sales/ROAS claim
structurally impossible (see [06-discovery-plan-contract.md](06-discovery-plan-contract.md)).

**Consequences**: `advertiserDiscoveryStrategies[]` was renamed to `discoveryStrategies[]` and
restricted to `{ id, source: "META_AD_LIBRARY", mode: "KEYWORD_SEARCH", label, description }`
today (`schemaVersion` bumped `1.0` → `1.1`). Adding a new source/mode (`WEB_SEARCH`,
`ADVERTISER_PAGE`, `LANDING_PAGE`, `SOCIAL_PUBLIC_CONTENT`, ...) requires the matching collector
capability to actually exist first, then a schema/enum update — never the reverse.

---

## ADR-14: `requestId` + atomically-reserved `RequestLog`, not a job queue, for idempotency

**Problem**: How should the app protect against duplicate plan generations/revisions from a
double-click, a dropped-connection retry, two near-simultaneous identical requests, or a resent
request?

**Variants considered**: (a) no idempotency handling, rely on the frontend to disable buttons;
(b) a client-supplied `requestId` recorded in a `RequestLog` table **after** the operation
completes, keyed however happens to be convenient; (c) a client-supplied `requestId` reserved
**atomically, before** the operation starts, via an insert guarded by a
`UNIQUE(endpoint, requestId)` constraint, with an explicit `PROCESSING → COMPLETED | FAILED`
status; (d) a full job queue with request deduplication.

**Decision**: (c).

**Arguments**: (a) is fragile — it only protects against the specific UI interaction it was
built for (double-click) and does nothing for a frontend-initiated retry after a timeout. (b)
looks equivalent to (c) at first glance but has a real race: if a log row is only written after
the operation finishes, two requests carrying the same `requestId` that arrive close together
can both pass the "have I seen this before?" check before either has written anything, and
both proceed to call n8n / persist a version. Only reserving the row **atomically before** doing
any work, backed by a database-enforced unique constraint on the insert itself, actually closes
that race — exactly one of the two concurrent inserts can succeed. (d) is real infrastructure
with no justified need (no long-running/async jobs exist in this system, see ADR-06). The
constraint is scoped **`UNIQUE(endpoint, requestId)`**, not a bare `UNIQUE(requestId)` —
`requestId` is an idempotency key scoped to one endpoint, not a system-wide key; every document
referencing this must say "per `(endpoint, requestId)`" consistently.

**Consequences**: A `RequestLog` table with an explicit `status` (`PROCESSING | COMPLETED |
FAILED`), `resultPlanVersionId` (nullable until `COMPLETED`), and `completedAt` (nullable until
`COMPLETED`/`FAILED`) was added to the data model ([05-data-model.md](05-data-model.md)); all
three plan-producing endpoints (`generate-plan`/MR-01, `revise-plan`/MR-02, `manual-revision`)
reserve their `RequestLog` row before calling n8n or validating a manual edit, and document
identical behavior for a repeat while `PROCESSING` (`409 REQUEST_IN_PROGRESS`, no n8n call),
after `COMPLETED` (return the prior result, no n8n call), and after `FAILED` (return the
recorded failure, no auto-retry — a new `requestId` is required)
([07-api-contract.md](07-api-contract.md)). This is what makes "no automatic retries" (ADR-06's
sibling rule) safe even when the *client* retries on its own initiative, including the
genuinely concurrent case a write-after-the-fact log could not have protected against.

---

## ADR-15: No app↔n8n authentication in local MVP; deferred to the VPS phase

**Problem**: Should the local app↔n8n webhook calls be authenticated (shared secret, HMAC,
etc.) from the start?

**Variants considered**: (a) Header Auth credential + shared secret from day one, upgradeable to
HMAC later (the original design); (b) no authentication at all for local, loopback-only use;
design real authentication only when/if a VPS move actually happens.

**Decision**: (b).

**Arguments**: n8n is published as `127.0.0.1:5678:5678` (see
[02-local-topology.md](02-local-topology.md)); nothing off the developer's machine can reach the
webhook regardless of auth mode. A shared-secret scheme adds a mandatory setup step (generate a
secret, sync it between `.env` and n8n's Credentials store) that protects against a threat that
doesn't exist at this exposure level. Designing real authentication properly (header secret vs.
HMAC vs. mTLS vs. a fronting reverse-proxy allowlist) deserves an actual decision made against
the real VPS threat model, not a placeholder chosen now and forgotten.

**Consequences**: `docker-compose.n8n.yml`, `.env.example`, and the MR-01/MR-02 Webhook nodes
carry no auth-related configuration. [04-future-vps-switch.md](04-future-vps-switch.md) flags
authentication as explicit **FUTURE WORK** that must be resolved, with its own ADR, before any
VPS exposure — this is a deferral with a tripwire, not a decision to never add auth.

---

## ADR-16: Plan lineage is an explicit `parentVersionId`, never inferred from `versionNumber`

**Problem**: How should the app record which prior version a given `DiscoveryPlanVersion` was
actually derived from?

**Variants considered**: (a) infer ancestry implicitly — assume version *N* was derived from
version *N-1*; (b) an explicit, nullable `parentVersionId` column set once at creation time from
the `:versionId` the revise/manual-revision call was actually made against.

**Decision**: (b).

**Arguments**: (a) silently breaks the moment two versions are ever created against the same
parent (e.g. a user opens a draft, doesn't approve it, and later revises the still-`APPROVED`
parent again instead) — `versionNumber - 1` would then point at the wrong row. `versionNumber`
is genuinely useful as a simple, monotonically increasing "how many versions has this project
had" counter, but it answers a different question than "what was this derived from", and
conflating the two is a latent correctness bug waiting for a branching scenario. (b) costs one
nullable foreign-key column and is trivial to set correctly at write time (see
[07-api-contract.md](07-api-contract.md): `null` for MR-01, the revised/edited `:versionId`
otherwise).

**Consequences**: `DiscoveryPlanVersion.parentVersionId` was added to the data model
([05-data-model.md](05-data-model.md)) and is surfaced read-only in the Data Explorer and the
`GET /api/discovery-plans/:versionId` response. No branching UI (compare-branches view, tree
picker) is built in this delivery — the only requirement satisfied here is that lineage is
correctly persisted and readable as a plain column.

---

## ADR-17: `ChatMessage` has no `role` column — only user turns are persisted

**Problem**: What should `ChatMessage.role` be allowed to contain, given that "system" is
normally reserved for an LLM system prompt (which must never be confused with app-level chat
history)?

**Variants considered**: (a) keep a `role` column with values `user | system` (the original,
misleading shape); (b) rename to `user | assistant` and persist one row per side of every chat
turn; (c) drop `role` entirely — persist only the user's instruction per turn, and reconstruct
the "assistant" reply at render/prompt time from the resulting `DiscoveryPlanVersion`'s
`changeSummary`/`warnings`.

**Decision**: (c).

**Arguments**: (a) is actively misleading — "system" reads as "LLM system prompt", which is a
completely different thing and must never be persisted as app data (system prompts live in
`n8n/prompts/*.md`, never in the database). (b) would work but stores an assistant-authored row
that duplicates data already sitting on `DiscoveryPlanVersion.changeSummary`/`.warningsJson` for
no benefit — every MR-02 turn already produces exactly one new version with exactly the
information an "assistant message" would contain. (c) is the simplest model that satisfies the
Plan Chat UI: one row per user instruction, no `role` field needed because every row is
unambiguously a user turn, and the assistant-facing half of a turn is reconstructed on demand
(both for UI rendering and for the `recentConversation` array sent to MR-02, see
[07-api-contract.md](07-api-contract.md)) by joining through `outputPlanVersionId`.

**Consequences**: `ChatMessage.role` was removed from the data model
([05-data-model.md](05-data-model.md)). `recentConversation` sent to MR-02 uses `user`/
`assistant` roles when the app reconstructs it for the LLM prompt, but this is a request-shaping
detail, not a stored column — `system` never appears anywhere `ChatMessage` data flows through.

---

## ADR-18: Manual-revision `changeSummary` is a mechanical structural diff, never LLM-generated or user-required

**Problem**: Who/what produces the required `changeSummary` for a `MANUAL_REVISION` version, and
must the user type one?

**Variants considered**: (a) require the user to type a `changeSummary` for every manual edit
(the original design); (b) call an LLM to summarize the diff (consistent with MR-02's style, but
introduces cost/latency/non-determinism into a path explicitly designed to have none); (c) the
app computes `changeSummary` mechanically from a structural, `id`-keyed diff between the parent
version's `planJson` and the submitted `editedPlan` — no LLM call — with an optional free-text
`changeNote` the user may append.

**Decision**: (c).

**Arguments**: (a) is exactly the UX friction this ADR exists to remove — requiring a changelog
entry for toggling one checkbox is disproportionate and users will write low-effort or
inaccurate summaries under that pressure. (b) reintroduces an LLM call, latency, and cost into
the one revision path that was explicitly designed to need none of those (see ADR-12) — a
mechanical diff of an `id`-keyed array is a solved, deterministic problem that doesn't need a
language model. (c) keeps the path fully LLM-free while still producing a genuinely useful,
specific summary (e.g. 'Disabled seed query "..."', 'Changed priority of "..." from medium to
high').

**Consequences**: `POST /discovery-plans/:versionId/manual-revision` no longer accepts a
required `changeSummary` from the client; it accepts an optional `changeNote` instead (see
[07-api-contract.md](07-api-contract.md)). `DiscoveryPlanV1.changeSummary` remains a required,
schema-enforced field — only its *source* changed, not its presence. This is deliberately a
structural diff, not a semantic one (see "Stable IDs" in
[06-discovery-plan-contract.md](06-discovery-plan-contract.md)) — no AI-assisted summarization
of *why* something changed, only *what* changed.

