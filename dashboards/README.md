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

> **Editing.** `ai-costs.lvdash.json` is the exact export from the Databricks
> dashboard editor — edit there and re-export to update it; don't hand-edit the
> JSON. `deploy.sh` pushes it to a workspace and the bundle ships it as-is.

## Files

- `ai-costs.lvdash.json` — the serialized Lakeview dashboard (source of truth),
  exported from the Databricks dashboard editor and versioned here so the bundle
  can ship it as-is. To change the dashboard, edit it in the editor, then export
  and overwrite this file (File → Export, or the Lakeview API).
- `deploy.sh` — create or update it in a workspace via the Lakeview API.

## Deploy

Usually you don't run this by hand: the **bundle deploys the dashboard for you**
(`databricks.yml` references `./dashboards/ai-costs.lvdash.json`), so a normal
`databricks bundle deploy` ships it into your own workspace. Use `deploy.sh` only
when you want to push the dashboard on its own, outside the bundle.

`deploy.sh` needs an authenticated `databricks` CLI profile and `jq`. Set these
to your own values (nothing here is tied to a specific account):

| Variable | What to set it to |
| --- | --- |
| `PROFILE` | Your `databricks` CLI profile (from `databricks auth login`). |
| `WAREHOUSE_ID` | Any SQL Warehouse in your workspace that can query the system tables. |
| `PARENT_PATH` | The workspace folder to create the dashboard in, e.g. `/Users/<you>@<company>.com`. |
| `DASHBOARD_ID` | Only when updating in place — the id printed on first create. |

```bash
# First time (creates a new dashboard in your workspace, prints its id):
PROFILE=<your-cli-profile> \
WAREHOUSE_ID=<your-warehouse-id> \
PARENT_PATH=/Users/<you>@<company>.com \
  ./dashboards/deploy.sh

# Update in place afterwards (idempotent):
PROFILE=<your-cli-profile> \
WAREHOUSE_ID=<your-warehouse-id> \
DASHBOARD_ID=<id-from-create> \
  ./dashboards/deploy.sh
```

Then open the dashboard in your workspace and **Publish** it so other admins can
view it. Each workspace running AI Prism deploys its own copy — the `.lvdash.json`
is fully portable, and the system tables it reads (`system.billing.*`,
`system.serving.*`) exist in every Unity Catalog workspace. Nothing in this
folder is bound to a particular account, warehouse, or user.
