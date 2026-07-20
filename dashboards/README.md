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

One dataset (**`ai_prism_detail`**) — per user × endpoint × day, with `prompt_tokens`,
`completion_tokens`, `total_tokens`, `turns`, and the allocated `dbus` / `usd` —
feeds every widget (last 90 days).

Layout (12-column grid), matching the version curated in the dashboard editor:

- **Filters + headline KPIs** (top): a user multi-select and a period date-range
  picker (default last 30 days), plus counter cards — DBUs consumed, estimated cost
  (USD), turns, distinct users, input / output / total tokens.
- **Detail table**: user · endpoint · day with token and turn columns.
- **Four sections**, each a per-endpoint + per-day + per-user bar breakdown:
  **USD**, **Tokens**, **DBUs** and **Turns**.

Colors use the workspace theme's `visualizationColors` positions, so the dashboard
matches the app's visual language rather than a different color per chart.

> **Ingestion lag.** `system.serving.endpoint_usage` (tokens) and
> `system.billing.usage` (cost) both lag ~1 h — the dashboard is near-real-time,
> not live.

> **Regenerating.** The JSON is produced by `build.py` (declarative). When you
> edit the dashboard in the Databricks editor, re-export it and fold the changes
> back into `build.py` so the two stay in sync (the committed JSON is validated
> to match the generator).

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
