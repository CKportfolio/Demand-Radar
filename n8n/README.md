# n8n — Market Demand Radar automation layer

This folder holds everything needed to import or rebuild the n8n workflows this project depends
on. Full design rationale lives in
[../docs/architecture/08-n8n-workflows.md](../docs/architecture/08-n8n-workflows.md) — read that
first.

## Folder contents

| Path | Purpose |
|---|---|
| `workflows/` | Exported workflow JSON (`MR-01-generate-discovery-plan.json`, `MR-02-revise-discovery-plan.json`). |
| `prompts/` | System prompt text for each workflow's LLM step, kept as separate markdown files so wording changes are diffable in git even though the workflow itself is JSON. |
| `schemas/` | A copy of `DiscoveryPlanV1.schema.json` for pasting into each workflow's Structured Output Parser node. **Must stay identical** to [../docs/architecture/DiscoveryPlanV1.schema.json](../docs/architecture/DiscoveryPlanV1.schema.json) — if you change one, change both, in the same commit. |
| `fixtures/` | Request payload fixtures for local webhook testing (`mr01-psychologist-pl.json`, `mr02-broaden-market.json`) and one intentionally invalid schema fixture for validator checks. |

## Status

Workflow exports intended for import/update in a local n8n instance:

- `workflows/MR-01 Generate Discovery Plan.json`
- `workflows/MR-02 Revise Discovery Plan.json`
- `workflows/MR03 - Meta Ads Query Planner.json`
- `workflows/MR04 - Ad Relevance Filter.json`
- `workflows/MR05 - Resolve Potential Ads.json`

Production webhook paths expected by the app contract:

- `POST /webhook/mr01-generate-plan`
- `POST /webhook/mr02-revise-plan`
- `POST /webhook/mr03-query-planner`
- `POST /webhook/mr04-filter-ads-paced-v4`
- `POST /webhook/mr05-resolve-potential-v1`

MR04 and MR05 receive one app-created batch (1–200 ads, selected in Workbench) per webhook call.
The app owns the queue, 14 RPM pacing, stop/resume control and persisted progress. Test mode sends
exactly one batch because an n8n test webhook accepts one invocation after listening starts. Do not
add another Split In Batches loop in n8n. The supplied Gemini nodes use 3 attempts with a 10-second
delay; another provider/model can replace those nodes without changing the app. After import, bind
the selected model credential in both workflows and activate/publish them.

## How to build a workflow from these files

1. Start n8n: `../scripts/n8n-up.ps1`, open `http://127.0.0.1:5678`.
2. Create a new workflow, add a **Webhook** node:
   - Method `POST`, Respond: **"Using 'Respond to Webhook' Node"**.
   - Authentication: **None** — local MVP is loopback-only and intentionally ships without
     webhook auth (see [../docs/architecture/09-security.md](../docs/architecture/09-security.md),
     ADR-15). Don't add a Header Auth credential here without a new ADR.
3. Add a validation step (Code/IF node) for required input fields, including
   `availableDiscoveryCapabilities` on the MR-01/MR-02 request.
4. Add a **Basic LLM Chain** node:
   - Paste the matching file from `prompts/` as the system prompt.
   - Attach your LLM provider credential (OpenAI/Anthropic/Gemini) to its Chat Model sub-node.
   - Turn on "Require Specific Output Format" → **Structured Output Parser**.
5. In the Structured Output Parser node, choose "Define using JSON Schema" and paste the
   contents of `schemas/DiscoveryPlanV1.schema.json`.
6. Add a **Respond to Webhook** node (happy path, Response: JSON) and a second one for the
   error path (see [../docs/architecture/08-n8n-workflows.md](../docs/architecture/08-n8n-workflows.md)).
7. **Activate/publish** the workflow — the app calls the **Production URL**, which only
   responds once the workflow is active.
8. Export the workflow (three-dot menu → **Download**) and save it into `workflows/` with the
   matching filename.

## Existing OpenAI credential (manual binding step)

If your OpenAI credential already exists in this n8n instance, do **not** create a new one.
After importing/opening each workflow, perform only this manual action:

1. Open the `OpenAI Chat Model` node.
2. Select the existing OpenAI credential from the Credentials dropdown.
3. Save the node and activate the workflow.

No API key should be written into repo files.

## Quick local test commands

MR-01:

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:5678/webhook/mr01-generate-plan" -ContentType "application/json" -InFile "n8n/fixtures/mr01-psychologist-pl.json"
```

MR-02 (after replacing `currentPlan` with a valid MR-01 response):

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:5678/webhook/mr02-revise-plan" -ContentType "application/json" -InFile "n8n/fixtures/mr02-broaden-market.json"
```

Schema validation utility:

```powershell
node scripts/validate-discovery-plan.mjs .data/test-output/mr01-response.json
node scripts/validate-discovery-plan.mjs .data/test-output/mr02-response.json
node scripts/validate-discovery-plan.mjs n8n/fixtures/invalid-discovery-plan.fixture.json
```

## Workflow portability (local ↔ VPS)

Community Edition n8n does not include Git-based Source Control (that's a paid feature —
verified against n8n's official edition-comparison docs). Move workflows between environments
using either:

- The editor's **Download** / **Import from File** / **Import from URL** menu, or
- The Server CLI inside the container:
  ```sh
  docker exec -u node -it market-radar-n8n n8n export:workflow --all --output=/home/node/.n8n/export.json
  docker exec -u node -it market-radar-n8n n8n import:workflow --input=/home/node/.n8n/export.json
  ```

After importing, **re-activate/publish** each workflow manually — activation state is not
guaranteed to carry over automatically on import.

## Credentials

Never commit real credential values. n8n's exported workflow JSON only contains credential
*references* (IDs/names), not secret values, so `workflows/*.json` is safe to commit — but the
LLM provider API key must be re-entered into n8n's Credentials store in every environment
(local, VPS) separately. No webhook credential is needed locally (see above).
