#!/usr/bin/env python3
"""Builds dashboards/ai-costs.lvdash.json for AI Prism cost/usage auditing.

Two datasets:
  - ai_prism_detail: per user x model x day allocation, enriched with gateway
    token_details (cache read/creation, reasoning) + latency, scoped to AI Prism
    via usage_context and joined to system.ai_gateway.usage on request_id.
  - ai_prism_kpi:  single-row current(30d) vs previous(30d) for delta counters.

`model` = destination_model (fallback endpoint_name). Cost = DBU x list price,
allocated by each row's token share of the endpoint's daily tokens.
"""
import json

# Match the app's own chart palette (client/src/components/blocks/ChartBlock.jsx)
# so the dashboard reads as the same product. ACCENT is the app's brand color
# (--accent). Single-series charts all use ACCENT (one visual language, not a
# different color per chart); only genuinely multi-series charts use the full
# ordered palette.
ACCENT = "#ff3621"
PALETTE = ["#ff3621", "#4285F4", "#10A37F", "#FF6A00", "#7C6FF0", "#98a2b3"]

# ---- shared SQL fragments -------------------------------------------------
SCOPED = """  SELECT eu.databricks_request_id AS rid, lower(eu.requester) AS user_email,
         eu.request_time AS ts, eu.input_token_count AS inp, eu.output_token_count AS outp,
         se.endpoint_name AS endpoint_name
  FROM system.serving.endpoint_usage eu
  JOIN system.serving.served_entities se ON eu.served_entity_id = se.served_entity_id
  WHERE eu.usage_context['application'] = 'ai-prism' AND se.endpoint_name IS NOT NULL"""

# system tables carry cost only for MODEL_SERVING billed usage
COST = """  SELECT u.usage_metadata.endpoint_name AS endpoint_name, u.usage_date AS day,
         SUM(u.usage_quantity) AS dbus, SUM(u.usage_quantity * p.pricing.default) AS usd
  FROM system.billing.usage u
  JOIN system.billing.list_prices p ON u.sku_name = p.sku_name
   AND u.usage_start_time >= p.price_start_time
   AND (p.price_end_time IS NULL OR u.usage_start_time < p.price_end_time)
  WHERE u.billing_origin_product = 'MODEL_SERVING' AND u.usage_metadata.endpoint_name IS NOT NULL
  GROUP BY 1, 2"""

DETAIL_SQL = f"""-- AI Prism LLM cost/usage & performance, from Databricks SYSTEM TABLES.
-- Scope: usage_context['application']='ai-prism' in system.serving.endpoint_usage
-- (server/llm.js stamps it). Enriched with system.ai_gateway.usage (joined on
-- databricks_request_id = request_id) for destination_model, token_details
-- (cache read/creation, reasoning) and latency. Cost = DBU x list price,
-- allocated to each user by their token share of the endpoint's daily tokens.
WITH scoped AS (
{SCOPED}
),
gw AS (
  -- Enrichment: destination_model, token_details and latency live ONLY in
  -- system.ai_gateway.usage. Joined to our scoped rows by request_id (the only
  -- key that scopes gateway metrics to AI Prism precisely). LEFT JOIN below, so
  -- rows degrade gracefully to endpoint_name / null latency until the gateway
  -- side ingests (its lag is longer than serving.endpoint_usage's). 180d bound
  -- keeps the scan bounded.
  SELECT request_id AS rid, destination_model, latency_ms, time_to_first_byte_ms,
         token_details.cache_read_input_tokens     AS cache_read,
         token_details.cache_creation_input_tokens AS cache_creation,
         token_details.output_reasoning_tokens     AS reasoning
  FROM system.ai_gateway.usage
  WHERE event_time > current_date() - INTERVAL 180 DAYS
),
enriched AS (
  SELECT s.user_email, s.endpoint_name, date(s.ts) AS day, s.inp, s.outp,
         COALESCE(g.destination_model, s.endpoint_name) AS model,
         g.latency_ms, g.time_to_first_byte_ms, g.cache_read, g.cache_creation, g.reasoning
  FROM scoped s LEFT JOIN gw g ON s.rid = g.rid
),
agg AS (
  SELECT user_email, model, endpoint_name, day,
         SUM(inp) AS prompt_tokens, SUM(outp) AS completion_tokens,
         SUM(COALESCE(cache_read,0))     AS cache_read_tokens,
         SUM(COALESCE(cache_creation,0)) AS cache_creation_tokens,
         SUM(COALESCE(reasoning,0))      AS reasoning_tokens,
         COUNT(*) AS turns,
         SUM(latency_ms) AS sum_latency, COUNT(latency_ms) AS lat_n,
         SUM(time_to_first_byte_ms) AS sum_ttft, COUNT(time_to_first_byte_ms) AS ttft_n
  FROM enriched GROUP BY 1,2,3,4
),
total AS (
  SELECT se.endpoint_name AS endpoint_name, date(eu.request_time) AS day,
         SUM(eu.input_token_count + eu.output_token_count) AS ep_tokens
  FROM system.serving.endpoint_usage eu
  JOIN system.serving.served_entities se ON eu.served_entity_id = se.served_entity_id
  WHERE se.endpoint_name IS NOT NULL GROUP BY 1,2
),
cost AS (
{COST}
)
SELECT a.user_email, a.model, a.day,
       a.prompt_tokens, a.completion_tokens,
       a.cache_read_tokens, a.cache_creation_tokens, a.reasoning_tokens,
       a.turns, a.sum_latency, a.lat_n, a.sum_ttft, a.ttft_n,
       COALESCE(c.dbus,0) * (a.prompt_tokens+a.completion_tokens)/NULLIF(t.ep_tokens,0) AS dbus,
       COALESCE(c.usd, 0) * (a.prompt_tokens+a.completion_tokens)/NULLIF(t.ep_tokens,0) AS usd
FROM agg a
JOIN total t ON t.endpoint_name = a.endpoint_name AND t.day = a.day
LEFT JOIN cost c ON c.endpoint_name = a.endpoint_name AND c.day = a.day"""

KPI_SQL = f"""-- Single-row KPI dataset: current 30 days vs previous 30 days, for delta
-- counters (value vs target). Same scope/enrichment as ai_prism_detail. NOT
-- wired to the period filter (the windows are fixed by definition).
WITH scoped AS (
{SCOPED}
    AND eu.request_time > current_date() - INTERVAL 60 DAYS
),
gw AS (
  SELECT request_id AS rid, latency_ms, time_to_first_byte_ms
  FROM system.ai_gateway.usage WHERE event_time > current_date() - INTERVAL 60 DAYS
),
total AS (
  SELECT se.endpoint_name AS endpoint_name, date(eu.request_time) AS day,
         SUM(eu.input_token_count + eu.output_token_count) AS ep_tokens
  FROM system.serving.endpoint_usage eu
  JOIN system.serving.served_entities se ON eu.served_entity_id = se.served_entity_id
  WHERE se.endpoint_name IS NOT NULL AND eu.request_time > current_date() - INTERVAL 60 DAYS
  GROUP BY 1,2
),
cost AS (
{COST.replace("GROUP BY 1, 2", "AND u.usage_date > current_date() - INTERVAL 60 DAYS\n  GROUP BY 1, 2")}
),
j AS (
  SELECT s.user_email, date(s.ts) AS day, s.inp, s.outp, s.endpoint_name,
         g.latency_ms, g.time_to_first_byte_ms,
         CASE WHEN s.ts >= current_date() - INTERVAL 30 DAYS THEN 'cur'
              WHEN s.ts >= current_date() - INTERVAL 60 DAYS THEN 'prev' END AS bucket
  FROM scoped s LEFT JOIN gw g ON s.rid = g.rid
),
alloc AS (
  SELECT j.*, COALESCE(c.dbus,0)*(j.inp+j.outp)/NULLIF(t.ep_tokens,0) AS dbu_row,
              COALESCE(c.usd, 0)*(j.inp+j.outp)/NULLIF(t.ep_tokens,0) AS usd_row
  FROM j JOIN total t ON t.endpoint_name=j.endpoint_name AND t.day=j.day
         LEFT JOIN cost c ON c.endpoint_name=j.endpoint_name AND c.day=j.day
),
agg AS (
  SELECT bucket, SUM(usd_row) usd, SUM(dbu_row) dbu, SUM(inp) inp, SUM(outp) outp,
         COUNT(*) turns, COUNT(DISTINCT user_email) users,
         AVG(latency_ms) lat, AVG(time_to_first_byte_ms) ttft
  FROM alloc WHERE bucket IS NOT NULL GROUP BY 1
)
SELECT
  MAX(CASE WHEN bucket='cur'  THEN usd   END) AS usd_cur,   MAX(CASE WHEN bucket='prev' THEN usd   END) AS usd_prev,
  MAX(CASE WHEN bucket='cur'  THEN dbu   END) AS dbu_cur,   MAX(CASE WHEN bucket='prev' THEN dbu   END) AS dbu_prev,
  MAX(CASE WHEN bucket='cur'  THEN inp   END) AS inp_cur,   MAX(CASE WHEN bucket='prev' THEN inp   END) AS inp_prev,
  MAX(CASE WHEN bucket='cur'  THEN outp  END) AS outp_cur,  MAX(CASE WHEN bucket='prev' THEN outp  END) AS outp_prev,
  MAX(CASE WHEN bucket='cur'  THEN turns END) AS turns_cur, MAX(CASE WHEN bucket='prev' THEN turns END) AS turns_prev,
  MAX(CASE WHEN bucket='cur'  THEN users END) AS users_cur, MAX(CASE WHEN bucket='prev' THEN users END) AS users_prev,
  MAX(CASE WHEN bucket='cur'  THEN lat   END) AS lat_cur,   MAX(CASE WHEN bucket='prev' THEN lat   END) AS lat_prev,
  MAX(CASE WHEN bucket='cur'  THEN ttft  END) AS ttft_cur,  MAX(CASE WHEN bucket='prev' THEN ttft  END) AS ttft_prev
FROM agg"""


def lines(sql):
    parts = sql.split("\n")
    return [p + "\n" for p in parts[:-1]] + [parts[-1]]


def field(name, expr):
    return {"name": name, "expression": expr}


def q(dataset, fields, disagg=False, name="main_query"):
    return [{"name": name, "query": {"datasetName": dataset, "fields": fields, "disaggregated": disagg}}]


def counter(name, value_field, target_field, title, fmt, higher_is_good):
    """Delta counter: value vs target (previous period). Conditional coloring:
    positive-when-good uses green up / red down; inverted for cost/latency."""
    val = {"fieldName": value_field, "displayName": title, "format": fmt}
    tgt = {"fieldName": target_field, "displayName": "Período anterior", "format": fmt}
    return {
        "widget": {
            "name": name,
            "queries": q("ai_prism_kpi", [field(value_field, f"`{value_field}`"),
                                          field(target_field, f"`{target_field}`")], disagg=True),
            "spec": {
                "version": 2, "widgetType": "counter",
                "encodings": {
                    "value": val,
                    "target": tgt,
                    "trend": {"type": "percentage-change",
                              "positiveIsGood": bool(higher_is_good)},
                },
                "frame": {"showTitle": True, "title": title},
            },
        }
    }


NUM = {"type": "number-plain", "abbreviation": "compact", "decimalPlaces": {"type": "max", "places": 1}}
USD = {"type": "number-currency", "currencyCode": "USD", "decimalPlaces": {"type": "max", "places": 2}}
MS = {"type": "number-plain", "abbreviation": "none", "decimalPlaces": {"type": "max", "places": 0}}

layout = []


def add(widget, x, y, w, h):
    # Widget constructors already return {"widget": {...}}; unwrap so we don't
    # double-nest. Accept either shape defensively.
    inner = widget["widget"] if set(widget.keys()) == {"widget"} else widget
    layout.append({"widget": inner, "position": {"x": x, "y": y, "width": w, "height": h}})


# ---- Row: period note + delta KPI cards (fixed 30d vs prev 30d) -----------
# 8 delta counters, 3 per row (width 2) => 3 rows
kpis = [
    ("kpi_cost",   "usd_cur",   "usd_prev",   "Custo (USD)",        USD, False),
    ("kpi_turns",  "turns_cur", "turns_prev", "Turns",              NUM, True),
    ("kpi_users",  "users_cur", "users_prev", "Usuários distintos", NUM, True),
    ("kpi_inp",    "inp_cur",   "inp_prev",   "Tokens de input",    NUM, True),
    ("kpi_outp",   "outp_cur",  "outp_prev",  "Tokens de output",   NUM, True),
    ("kpi_dbu",    "dbu_cur",   "dbu_prev",   "DBU",                NUM, False),
    ("kpi_lat",    "lat_cur",   "lat_prev",   "Latência média (ms)", MS, False),
    ("kpi_ttft",   "ttft_cur",  "ttft_prev",  "TTFT médio (ms)",     MS, False),
]
y = 0
for i, (nm, vc, vp, title, fmt, good) in enumerate(kpis):
    col = (i % 3) * 2
    row = y + (i // 3) * 3
    add(counter(nm, vc, vp, title, fmt, good), col, row, 2, 3)
kpi_rows = (len(kpis) + 2) // 3  # 3
y = y + kpi_rows * 3  # 9

# ---- Period filter (applies to detail-backed widgets below) --------------
flt = {
    "widget": {
        "name": "flt_day",
        "queries": [{"name": "filter_flt_day_day", "query": {
            "datasetName": "ai_prism_detail",
            "fields": [field("day", "`day`"),
                       field("day_associativity", "COUNT_IF(`associative_filter_predicate_group`)")],
            "disaggregated": False}}],
        "spec": {"version": 2, "widgetType": "filter-date-range-picker",
                 "encodings": {"fields": [{"fieldName": "day", "displayName": "Período",
                                           "queryName": "filter_flt_day_day"}]},
                 "frame": {"showTitle": True, "title": "Período (afeta tabelas e gráficos abaixo)"}}},
}
add(flt, 0, y, 6, 2)
y += 2  # 11

# ---- User KPI table (the main analytical table) --------------------------
user_tbl = {
    "widget": {
        "name": "tbl_users",
        "queries": q("ai_prism_detail", [
            field("user_email", "`user_email`"),
            field("turns", "SUM(`turns`)"),
            field("days_active", "COUNT(DISTINCT `day`)"),
            field("models", "COUNT(DISTINCT `model`)"),
            field("prompt_tokens", "SUM(`prompt_tokens`)"),
            field("completion_tokens", "SUM(`completion_tokens`)"),
            field("cache_read_tokens", "SUM(`cache_read_tokens`)"),
            field("dbus", "SUM(`dbus`)"),
            field("usd", "SUM(`usd`)"),
            field("usd_per_turn", "SUM(`usd`)/NULLIF(SUM(`turns`),0)"),
            field("avg_latency", "SUM(`sum_latency`)/NULLIF(SUM(`lat_n`),0)"),
            field("avg_ttft", "SUM(`sum_ttft`)/NULLIF(SUM(`ttft_n`),0)"),
        ]),
        "spec": {
            "version": 1, "widgetType": "table",
            "encodings": {"columns": [
                {"fieldName": "user_email", "type": "string", "displayAs": "string", "title": "Usuário"},
                {"fieldName": "turns", "type": "integer", "displayAs": "number", "title": "Turns", "alignContent": "right"},
                {"fieldName": "days_active", "type": "integer", "displayAs": "number", "title": "Dias ativos", "alignContent": "right"},
                {"fieldName": "models", "type": "integer", "displayAs": "number", "title": "Modelos", "alignContent": "right"},
                {"fieldName": "prompt_tokens", "type": "integer", "displayAs": "number", "title": "Input tok", "alignContent": "right"},
                {"fieldName": "completion_tokens", "type": "integer", "displayAs": "number", "title": "Output tok", "alignContent": "right"},
                {"fieldName": "cache_read_tokens", "type": "integer", "displayAs": "number", "title": "Cache read tok", "alignContent": "right"},
                {"fieldName": "dbus", "type": "float", "displayAs": "number", "numberFormat": "0.000", "title": "DBU", "alignContent": "right"},
                {"fieldName": "usd", "type": "float", "displayAs": "number", "numberFormat": "$0.0000", "title": "Custo", "alignContent": "right"},
                {"fieldName": "usd_per_turn", "type": "float", "displayAs": "number", "numberFormat": "$0.0000", "title": "Custo/turn", "alignContent": "right"},
                {"fieldName": "avg_latency", "type": "float", "displayAs": "number", "numberFormat": "0", "title": "Latência méd (ms)", "alignContent": "right"},
                {"fieldName": "avg_ttft", "type": "float", "displayAs": "number", "numberFormat": "0", "title": "TTFT méd (ms)", "alignContent": "right"},
            ]},
            "frame": {"showTitle": True, "title": "KPIs por usuário"},
        },
    }
}
add(user_tbl, 0, y, 6, 7)
y += 7  # 18

# ---- Charts row: cost by user (bar) | cost per day (line) ----------------
bar_user = {
    "widget": {"name": "bar_by_user",
               "queries": q("ai_prism_detail", [field("user_email", "`user_email`"), field("sum_usd", "SUM(`usd`)")]),
               "spec": {"version": 3, "widgetType": "bar",
                        "encodings": {
                            "x": {"fieldName": "sum_usd", "scale": {"type": "quantitative"}, "displayName": "Custo", "format": USD},
                            "y": {"fieldName": "user_email", "scale": {"type": "categorical", "sort": {"by": "x-reversed"}}, "displayName": "Usuário"},
                            "label": {"show": True}},
                        "frame": {"showTitle": True, "title": "Custo por usuário"},
                        "mark": {"colors": [ACCENT]}}}}
add(bar_user, 0, y, 3, 6)

line_day = {
    "widget": {"name": "line_by_day",
               "queries": q("ai_prism_detail", [field("day", "`day`"), field("sum_usd", "SUM(`usd`)"), field("sum_turns", "SUM(`turns`)")]),
               "spec": {"version": 3, "widgetType": "line",
                        "encodings": {
                            "x": {"fieldName": "day", "scale": {"type": "temporal"}, "displayName": "Dia"},
                            "y": {"fieldName": "sum_usd", "scale": {"type": "quantitative"}, "displayName": "Custo", "format": USD}},
                        "frame": {"showTitle": True, "title": "Custo por dia"},
                        "mark": {"colors": [ACCENT]}}}}
add(line_day, 3, y, 3, 6)
y += 6  # 24

# ---- Charts row: cost by model (bar) | token composition by model (stacked) --
bar_model = {
    "widget": {"name": "bar_by_model",
               "queries": q("ai_prism_detail", [field("model", "`model`"), field("sum_usd", "SUM(`usd`)")]),
               "spec": {"version": 3, "widgetType": "bar",
                        "encodings": {
                            "x": {"fieldName": "sum_usd", "scale": {"type": "quantitative"}, "displayName": "Custo", "format": USD},
                            "y": {"fieldName": "model", "scale": {"type": "categorical", "sort": {"by": "x-reversed"}}, "displayName": "Modelo (destination)"},
                            "label": {"show": True}},
                        "frame": {"showTitle": True, "title": "Custo por modelo"},
                        "mark": {"colors": [ACCENT]}}}}
add(bar_model, 0, y, 3, 6)

# token_details composition: input / output / cache_read / cache_creation / reasoning per model (stacked)
tok_stack = {
    "widget": {"name": "tok_by_model",
               "queries": [{"name": "main_query", "query": {
                   "datasetName": "ai_prism_detail",
                   "fields": [
                       field("model", "`model`"),
                       field("input", "SUM(`prompt_tokens`)"),
                       field("output", "SUM(`completion_tokens`)"),
                       field("cache_read", "SUM(`cache_read_tokens`)"),
                       field("cache_creation", "SUM(`cache_creation_tokens`)"),
                       field("reasoning", "SUM(`reasoning_tokens`)"),
                   ], "disaggregated": False}}],
               "spec": {"version": 3, "widgetType": "bar",
                        "encodings": {
                            "x": {"fieldName": "model", "scale": {"type": "categorical"}, "displayName": "Modelo"},
                            "y": {"scale": {"type": "quantitative"}, "displayName": "Tokens",
                                  "fields": [
                                      {"fieldName": "input", "displayName": "Input"},
                                      {"fieldName": "output", "displayName": "Output"},
                                      {"fieldName": "cache_read", "displayName": "Cache read"},
                                      {"fieldName": "cache_creation", "displayName": "Cache creation"},
                                      {"fieldName": "reasoning", "displayName": "Reasoning"},
                                  ]},
                            "label": {"show": False}},
                        "frame": {"showTitle": True, "title": "Composição de tokens por modelo (token_details)"},
                        "mark": {"colors": PALETTE}}}}
add(tok_stack, 3, y, 3, 6)
y += 6

# ---- Detail table (user x model) with performance -------------------------
tbl_detail = {
    "widget": {"name": "tbl_detail",
               "queries": q("ai_prism_detail", [
                   field("user_email", "`user_email`"), field("model", "`model`"),
                   field("sum_turns", "SUM(`turns`)"),
                   field("sum_prompt", "SUM(`prompt_tokens`)"), field("sum_completion", "SUM(`completion_tokens`)"),
                   field("sum_cache_read", "SUM(`cache_read_tokens`)"),
                   field("sum_cache_creation", "SUM(`cache_creation_tokens`)"),
                   field("sum_reasoning", "SUM(`reasoning_tokens`)"),
                   field("avg_latency", "SUM(`sum_latency`)/NULLIF(SUM(`lat_n`),0)"),
                   field("avg_ttft", "SUM(`sum_ttft`)/NULLIF(SUM(`ttft_n`),0)"),
                   field("sum_dbu", "SUM(`dbus`)"), field("sum_usd", "SUM(`usd`)")]),
               "spec": {"version": 1, "widgetType": "table",
                        "encodings": {"columns": [
                            {"fieldName": "user_email", "type": "string", "displayAs": "string", "title": "Usuário"},
                            {"fieldName": "model", "type": "string", "displayAs": "string", "title": "Modelo"},
                            {"fieldName": "sum_turns", "type": "integer", "displayAs": "number", "title": "Turns", "alignContent": "right"},
                            {"fieldName": "sum_prompt", "type": "integer", "displayAs": "number", "title": "Input tok", "alignContent": "right"},
                            {"fieldName": "sum_completion", "type": "integer", "displayAs": "number", "title": "Output tok", "alignContent": "right"},
                            {"fieldName": "sum_cache_read", "type": "integer", "displayAs": "number", "title": "Cache read", "alignContent": "right"},
                            {"fieldName": "sum_cache_creation", "type": "integer", "displayAs": "number", "title": "Cache creation", "alignContent": "right"},
                            {"fieldName": "sum_reasoning", "type": "integer", "displayAs": "number", "title": "Reasoning", "alignContent": "right"},
                            {"fieldName": "avg_latency", "type": "float", "displayAs": "number", "numberFormat": "0", "title": "Latência méd (ms)", "alignContent": "right"},
                            {"fieldName": "avg_ttft", "type": "float", "displayAs": "number", "numberFormat": "0", "title": "TTFT méd (ms)", "alignContent": "right"},
                            {"fieldName": "sum_dbu", "type": "float", "displayAs": "number", "numberFormat": "0.000", "title": "DBU", "alignContent": "right"},
                            {"fieldName": "sum_usd", "type": "float", "displayAs": "number", "numberFormat": "$0.0000", "title": "Custo", "alignContent": "right"},
                        ]},
                        "frame": {"showTitle": True, "title": "Detalhe (usuário × modelo)"}}}}
add(tbl_detail, 0, y, 6, 6)

dashboard = {
    "datasets": [
        {"name": "ai_prism_detail", "displayName": "AI Prism — uso, custo e performance", "queryLines": lines(DETAIL_SQL)},
        {"name": "ai_prism_kpi", "displayName": "AI Prism — KPIs período atual vs anterior", "queryLines": lines(KPI_SQL)},
    ],
    "pages": [{"name": "ai_costs_overview", "displayName": "AI costs", "pageType": "PAGE_TYPE_CANVAS", "layout": layout}],
    "uiSettings": {"theme": {"widgetHeaderAlignment": "ALIGNMENT_UNSPECIFIED"}},
}

import os
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai-costs.lvdash.json")
with open(out, "w") as f:
    json.dump(dashboard, f, indent=2, ensure_ascii=False)
    f.write("\n")
print("Wrote", out, "| widgets:", len(layout))
