# AI Prism — AI/BI cost dashboard

Admins audit AI Prism's LLM cost/usage through a **Databricks AI/BI (Lakeview)
dashboard**, not inside the app. The heavy system-table scans run in AI/BI's own
compute, so a cold SQL Warehouse never blocks the app UI (the in-app "AI costs"
tab was removed in favor of this).

## What it shows

Real **billed** cost — `DBU × list price` from `system.billing.usage` ⋈
`system.billing.list_prices` — allocated to each user by their share of the
endpoint's daily tokens (`system.serving.endpoint_usage` ⋈
`system.serving.served_entities` for the endpoint name). Scoped to AI Prism via
the `usage_context['application'] = 'ai-prism'` stamp set on every gateway call
(see `server/llm.js`). **Note:** `usage_context` lands in
`system.serving.endpoint_usage.usage_context`, *not* in
`system.ai_gateway.usage.request_tags` — an earlier query read the wrong
table/column and always returned "No data".

Two datasets:

- **`ai_prism_detail`** — per user × model × day. Enriched from
  `system.ai_gateway.usage` (LEFT JOIN on `databricks_request_id = request_id`)
  for **`destination_model`** (the model shown, per request), **`token_details`**
  (cache-read / cache-creation / reasoning tokens), **`latency_ms`** and
  **`time_to_first_byte_ms`**.
- **`ai_prism_kpi`** — a single row of current-30-days vs previous-30-days totals
  that drives the delta counters.

Widgets: **delta KPI cards** (cost, turns, distinct users, input tokens, output
tokens, DBU, avg latency, avg TTFT — each with % change vs the previous 30 days
and green/red conditional coloring, cost & latency treated as "lower is better");
a **per-user KPI table** (turns, days active, models used, in/out/cache tokens,
DBU, cost, cost/turn, avg latency & TTFT); cost by user; cost per day; cost by
model; **token composition by model** (input/output/cache/reasoning, stacked);
and a user × model detail table. Everything below the KPI cards is filtered by a
period picker (the cards are fixed 30-day windows by definition). Charts use the
app's own palette (accent `#ff3621`) for a consistent visual language.

> **Ingestion lag.** `system.serving.endpoint_usage` (tokens, cost scoping) lags
> ~1 h; `system.ai_gateway.usage` (latency, `token_details`, `destination_model`)
> lags longer and, depending on endpoint type, may not carry a joinable
> `request_id` for every foundation-model call. The enrichment is a LEFT JOIN, so
> **cost/tokens/turns are always populated**; latency and `token_details` columns
> fill in as the gateway table catches up (and show blank where it never lands).
> `destination_model` falls back to the serving endpoint name until enriched.

## Files

- `build.py` — **generates** `ai-costs.lvdash.json` (datasets + widgets). Edit
  this, then run `python3 dashboards/build.py`; don't hand-edit the JSON.
- `ai-costs.lvdash.json` — the serialized Lakeview dashboard (generated artifact,
  versioned here so the bundle can ship it without a build step).
- `deploy.sh` — create or update it in a workspace via the Lakeview API.

## Deploy

Requires an authenticated `databricks` CLI profile and `jq`.

```bash
# First time (creates a new dashboard, prints its id):
PROFILE=E2_Demo \
WAREHOUSE_ID=75718e4268126449 \
PARENT_PATH=/Users/pedro.ramos@databricks.com \
  ./dashboards/deploy.sh

# Update in place afterwards (idempotent):
PROFILE=E2_Demo \
WAREHOUSE_ID=75718e4268126449 \
DASHBOARD_ID=<id-from-create> \
  ./dashboards/deploy.sh
```

Then open the dashboard in the workspace and **Publish** it so other admins can
view it. Each customer workspace running AI Prism deploys its own copy — the
`.lvdash.json` is portable; only `WAREHOUSE_ID` / `PARENT_PATH` differ.

### Deployed instances

| Workspace | `DASHBOARD_ID` |
| --- | --- |
| E2_Demo (`e2-demo-field-eng`) | `01f18403ca66179695f18e0f591cc0d0` |
