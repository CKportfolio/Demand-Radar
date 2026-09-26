# 01 — Product Model

## The core inversion

Traditional competitor-research tools assume: *"I have product X, show me who else sells X."*

Market Demand Radar assumes the opposite: *"I have a set of capabilities and constraints. I do
not know the product, topic, or audience yet. Discover which topics/products/audiences
currently show market signals worth pursuing."*

This inversion drives almost every architectural decision:

- The intake form never asks for "topic", "target customer", or "problem solved" as required
  fields — those are **outputs**, not inputs (see [09 Project Brief](../..) form spec below).
- `DiscoveryPlanV1.seedQueries` are explicitly documented as **first probes**, not confirmed
  product hypotheses.
- The system is built to widen or narrow its own search taxonomy over iterations
  (`queryExpansionPolicy`), because the "right" market segment is not known on day one.

## What the system observes vs. what it must never claim

The system can observe, from public ad libraries and web presence, things like:

- an ad (or ad concept) has run continuously for a long period,
- an advertiser maintains many concurrent creatives for what looks like the same offer,
- an advertiser adds new creatives to an existing offer over time,
- the same offer/campaign reappears across multiple time windows,
- multiple, seemingly unrelated advertisers invest in a similar topic/offer,
- an advertiser's funnel (ad → landing page → upsell) appears to deepen over time.

None of this proves revenue, profit, conversion rate, or customer count. The system **must
not** produce or store any field, label, or copy implying sales, profitability, or conversion.

### Approved vocabulary (use everywhere: prompts, schema, UI, docs)

- `signal_trakcji` / "traction signal"
- "strong demand signal"
- "probable traction"
- "scaling signal"
- "advertising longevity" / "creative multiplication" / "funnel expansion"

### Forbidden vocabulary (reject in review of prompts, schema, and UI copy)

- "confirmed sale(s)"
- "the product sells" / "produkt się sprzedaje"
- "profitable ad" / "rentowna reklama"
- "conversion rate", "ROAS", "revenue", "customers acquired" — unless explicitly qualified as
  *not observed, not available to this system*.

This distinction is a **product-integrity requirement**, not a copywriting nicety: it is the
difference between a legally/ethically defensible research tool and a tool that misrepresents
what it knows. It belongs in the LLM system prompts (`n8n/prompts/*.md`), in the JSON Schema
`description` fields, and in a lint/review checklist for frontend copy.

## The user brief (capability boundary, not a topic request)

The **Project Brief** captures the *boundary of what the user is able and willing to create* —
never the product idea itself. Required/optional fields (see also
[07-api-contract.md](07-api-contract.md) for the wire shape):

| Field | Required | Notes |
|---|---|---|
| Project name | yes | free text, e.g. "Psychologia — Polska" |
| Competencies (`competencies`) | yes | large free-text field: what the creator knows/can teach |
| Qualifications / experience (`qualifications`) | no | free text |
| Product formats the creator can produce (`availableProductFormats`) | yes | checkbox set: recorded training, online course, webinar, workshop, educational program, digital materials, other |
| Market: country + language (`market`) | yes | e.g. `{ country: "PL", language: "pl" }` |
| Constraints (`constraints`) | no | free text, e.g. "no accreditation-requiring products" |
| Things the user does *not* want to build (`exclusions`) | no | free text |

Explicitly **not** asked for, and must not be presented as required in any future UI: topic,
target customer, or problem the product should solve. If a future contributor adds a "topic"
required field to the brief form, that is a regression against the product's core premise and
should be rejected in review.

## Screens (target shape, not built yet)

1. **Projects** — list of projects, "NEW MARKET RESEARCH" button.
2. **Project Brief** — the form above; "GENERATE DISCOVERY PLAN" button.
3. **Discovery Plan** — the `DiscoveryPlanV1` rendered as editable, human-readable sections
   (not raw JSON): capability understanding, market breadth, initial search probes, product
   types, initial taxonomy, advertiser-discovery strategies, expansion policy, unknowns,
   constraints, discovery limits, saturation criteria. Every list item is individually
   editable/removable/toggleable and carries a stable `id`.
4. **Plan chat** — free-text revision instructions next to the plan (MR-02). Produces a new
   plan *version*; never overwrites.
5. **Data Explorer** (`/data`) — developer-grade record browser: list, filter, JSON preview,
   relations, delete record / delete project / clear test data. Destructive actions require
   confirmation. Not a SQL console.

## Non-goals for this phase (explicitly out of scope — see [12-mvp-roadmap.md](12-mvp-roadmap.md))

Playwright Meta collector implementation, iterative AI discovery loop, landing-page analysis,
product/offer clustering, audience inference, traction scoring, analytics dashboard,
scheduling, multi-user/SaaS, logins, cloud hosting, Redis, PostgreSQL, Kubernetes.
