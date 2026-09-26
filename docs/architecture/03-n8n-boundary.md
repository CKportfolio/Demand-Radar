# 03 — n8n Boundary

n8n is the **LLM / automation layer**. Nothing more. This document exists so that scope creep
into n8n (a very easy trap, because n8n *can* technically do almost anything) gets caught in
review.

## What n8n IS in this system

- A place to call an LLM with a fixed prompt + JSON Schema and get back a validated structured
  response, synchronously, over HTTP.
- Home to exactly two workflows in this phase: **MR-01 Generate Discovery Plan** and
  **MR-02 Revise Discovery Plan** (see [08-n8n-workflows.md](08-n8n-workflows.md)).
- The single place LLM provider API keys live (n8n Credentials store, encrypted at rest).
- An abstraction boundary: the app never talks to OpenAI/Anthropic/Gemini directly. It only
  ever talks to "n8n's discovery-plan endpoint". Swapping LLM providers means changing the
  n8n workflow, not the app.

## What n8n is explicitly NOT

| Not this | Why it matters |
|---|---|
| Not the main backend | The app owns routing, auth, business logic, and orchestration. n8n has no concept of "project" or "discovery run". |
| Not the database of record | n8n's own SQLite (workflow/execution history) is n8n's *internal* bookkeeping. `DiscoveryPlanV1` versions, projects, and runs live only in the app's SQLite. |
| Not a Playwright worker | Never call Playwright, a headless browser, or `Execute Command` from n8n. Collecting ads is the app's job, running natively on Windows (see [10](10-playwright-boundary.md)). |
| Not the owner of pipeline/run status | `DiscoveryRun.status` transitions are decided and written by the app. n8n has no callback path to change run state. |
| Not allowed to write to the app's database | There is no credential, network path, or shared volume that lets an n8n workflow open `.data/market-radar.sqlite`. This is enforced by topology (different processes, different volumes), not just convention. |
| Not an async workflow (yet) | Every call the app makes to n8n today is a synchronous `POST` that blocks for a `Respond to Webhook` reply. No queues, no polling, no callbacks into the app. |

## The only two workflows in this phase

### MR-01 — Generate Discovery Plan

```
LOCAL APP  --POST /webhook/mr01-generate-plan (projectId, requestId, brief)-->  n8n
n8n --> LLM (structured output, DiscoveryPlanV1 JSON Schema)
n8n --Respond to Webhook (DiscoveryPlanV1 JSON)--> LOCAL APP
LOCAL APP: validates against schema, stores as new DiscoveryPlanVersion(status=DRAFT)
```

### MR-02 — Revise Discovery Plan

```
LOCAL APP --POST /webhook/mr02-revise-plan (currentPlan, userInstruction, recentConversation)--> n8n
n8n --> LLM (same schema, plus changeSummary + warnings)
n8n --Respond to Webhook (DiscoveryPlanV1 JSON + changeSummary + warnings)--> LOCAL APP
LOCAL APP: validates, stores as a NEW DiscoveryPlanVersion (never overwrites the previous one)
```

Both are **request/response**. The HTTP connection from the app stays open until n8n replies
or the app's timeout fires. There is no "check back later" step in this phase.

## Why not let n8n orchestrate more (e.g. drive Playwright, own run state)?

Rejected on purpose:

1. **Ownership clarity.** One system (the app) is the single source of truth for "what is a
   discovery run and what state is it in". Splitting that between the app and n8n creates two
   sources of truth that can disagree.
2. **Portability.** n8n moves to a VPS later (see [04](04-future-vps-switch.md)). Anything that
   requires n8n to reach back into the local machine (Playwright, local DB) breaks the moment
   n8n is not on the same host. Keeping n8n's job to a single, self-contained request/response
   LLM call — never owning Market Demand Radar application data — means the VPS move is a
   config change, not a redesign.
3. **Blast radius.** If n8n is compromised, misconfigured, or simply down, the worst case today
   is "can't generate/revise a plan". If n8n could drive the browser or write the DB, its
   blast radius would be the entire pipeline and all collected data.
4. **Debuggability.** A stateless request/response call is trivial to mock
   (`N8N_MOCK_MODE=true`, see [07-api-contract.md](07-api-contract.md)) and trivial to reason
   about. A stateful orchestrator is not.

## What n8n is allowed to grow into later (explicitly deferred, not designed in detail now)

- Additional LLM-only workflows (e.g. "summarize newly discovered advertiser", "classify ad
  copy tone") — same shape: stateless request → structured response.
- Possibly async workflows for long-running LLM batch jobs, **if** a real need appears. See
  [04-future-vps-switch.md](04-future-vps-switch.md) for the menu of async patterns to
  consider — none are implemented now.
