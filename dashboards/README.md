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
`system.ai_gateway.usage.request_tags` — the earlier query read the wrong
table/column and always returned "No data". Widgets: total cost / tokens / DBU /
turns KPIs, cost by user, cost per day, cost by model, and a user × model detail
table, all filtered by a period picker.

> Ingestion lag: serving usage ~1 h, billing ~1 h — the dashboard is near-real-time,
> not live.

## Files

- `ai-costs.lvdash.json` — the serialized Lakeview dashboard (versioned here).
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
