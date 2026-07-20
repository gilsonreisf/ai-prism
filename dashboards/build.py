#!/usr/bin/env python3
"""Builds dashboards/ai-costs.lvdash.json — the AI Prism cost/usage AI/BI dashboard.

This mirrors the version curated in the Databricks dashboard editor. A single
dataset (`ai_prism_detail`) feeds every widget; the layout is organized in
sections (KPIs, then USD / Tokens / DBUs / Turns), each with a per-endpoint,
per-day and per-user breakdown.

Data source (important): AI Prism scopes its traffic via the `usage_context`
stamp `server/llm.js` sets on every gateway call, which lands in
`system.serving.endpoint_usage.usage_context` (NOT `system.ai_gateway.usage`
`.request_tags`). Cost = DBU x list price from `system.billing.usage` allocated
to each user by their token share of the endpoint's daily tokens.

Edit this file and run `python3 dashboards/build.py` to regenerate the JSON.
Colors use the workspace theme's `visualizationColors` positions (kept from the
editor version) so the dashboard matches the app's visual language.
"""
import json
import os

DATASET = "ai_prism_detail"

# --- dataset SQL (scoped to AI Prism, cost allocated by token share) ----------
DETAIL_SQL = """WITH token_base AS (
  SELECT
    lower(eu.requester) AS user_email,
    se.endpoint_name,
    date(eu.request_time) AS day,
    SUM(eu.input_token_count) AS prompt_tokens,
    SUM(eu.output_token_count) AS completion_tokens,
    SUM(eu.input_token_count + eu.output_token_count) AS total_tokens,
    COUNT(*) AS turns
  FROM
    system.serving.endpoint_usage eu
      JOIN system.serving.served_entities se
        ON eu.served_entity_id = se.served_entity_id
  WHERE
    eu.usage_context['application'] = 'ai-prism'
    AND se.endpoint_name IS NOT NULL
    AND date(eu.request_time) >= date_add(current_date(), -90)
  GROUP BY
    1,
    2,
    3
),
endpoint_tokens AS (
  SELECT
    endpoint_name,
    day,
    SUM(total_tokens) AS endpoint_total_tokens
  FROM
    token_base
  GROUP BY
    1,
    2
),
endpoint_cost AS (
  SELECT
    u.usage_metadata.endpoint_name AS endpoint_name,
    u.usage_date AS day,
    SUM(u.usage_quantity) AS dbus,
    SUM(u.usage_quantity * lp.pricing.default) AS usd
  FROM
    system.billing.usage u
      JOIN system.billing.list_prices lp
        ON u.sku_name = lp.sku_name
        AND lp.price_start_time <= u.usage_start_time
        AND (
          lp.price_end_time IS NULL
          OR lp.price_end_time > u.usage_start_time
        )
  WHERE
    u.billing_origin_product = 'MODEL_SERVING'
    AND u.usage_date >= date_add(current_date(), -90)
  GROUP BY
    1,
    2
)
SELECT
  t.user_email,
  t.endpoint_name,
  t.day,
  t.prompt_tokens,
  t.completion_tokens,
  t.total_tokens,
  t.turns,
  ROUND(ec.dbus * t.total_tokens / NULLIF(et.endpoint_total_tokens, 0), 6) AS dbus,
  ROUND(ec.usd * t.total_tokens / NULLIF(et.endpoint_total_tokens, 0), 4) AS usd
FROM
  token_base t
    LEFT JOIN endpoint_tokens et
      ON t.endpoint_name = et.endpoint_name
      AND t.day = et.day
    LEFT JOIN endpoint_cost ec
      ON t.endpoint_name = ec.endpoint_name
      AND t.day = ec.day
ORDER BY
  t.day DESC,
  t.total_tokens DESC"""


def lines(sql):
    parts = sql.split("\n")
    return [p + "\n" for p in parts[:-1]] + [parts[-1]]


# --- theme color helpers ------------------------------------------------------
def vcolors(positions):
    return [{"themeColorType": "visualizationColors", "position": p} for p in positions]


# The editor left each bar with a 10-slot theme palette; the first slot varies
# per section (it's the accent the section leads with), the rest are 2..10.
PALETTE_DEFAULT = vcolors([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])   # tokens section
PALETTE_TURNS = vcolors([4, 2, 3, 4, 5, 6, 7, 8, 9, 10])     # turns section
PALETTE_DBU = vcolors([2, 2, 3, 4, 5, 6, 7, 8, 9, 10])       # DBUs section
PALETTE_USD = vcolors([3, 2, 3, 4, 5, 6, 7, 8, 9, 10])       # USD section

NUM1 = {"type": "number-plain", "abbreviation": "compact", "decimalPlaces": {"type": "max", "places": 1}}
NUM0 = {"type": "number-plain", "abbreviation": "compact", "decimalPlaces": {"type": "max", "places": 0}}
NUM2E = {"type": "number-plain", "abbreviation": "compact", "decimalPlaces": {"type": "exact", "places": 2}}
USD2E = {"type": "number-currency", "abbreviation": "compact", "currencyCode": "USD", "decimalPlaces": {"type": "exact", "places": 2}}
USD_AXIS = {"type": "number-currency", "currencyCode": "USD", "abbreviation": "compact", "decimalPlaces": {"type": "max", "places": 2}}

layout = []


def add(widget, x, y, w, h):
    layout.append({"widget": widget, "position": {"x": x, "y": y, "width": w, "height": h}})


def counter(name, expr, field_name, title, display, fmt):
    return {
        "name": name,
        "queries": [{"name": "main_query", "query": {
            "datasetName": DATASET,
            "fields": [{"name": field_name, "expression": expr}],
            "disaggregated": False}}],
        "spec": {
            "frame": {"showTitle": True, "title": title},
            "version": 2, "widgetType": "counter",
            "encodings": {"value": {"fieldName": field_name, "format": fmt, "displayName": display}},
            "data": {"queryName": "main_query"},
        },
    }


def bar_metric(name, title, x_expr, x_field, x_display, x_fmt, y_field, y_display, colors):
    """Horizontal bar: measure on x, category on y (sorted desc)."""
    x_enc = {"fieldName": x_field, "displayName": x_display, "scale": {"type": "quantitative"}}
    if x_fmt:
        x_enc["format"] = x_fmt
    return {
        "name": name,
        "queries": [{"name": "main_query", "query": {
            "datasetName": DATASET,
            "fields": [{"name": x_field, "expression": x_expr},
                       {"name": y_field, "expression": f"`{y_field}`"}],
            "disaggregated": False}}],
        "spec": {
            "frame": {"showTitle": True, "title": title},
            "version": 3, "mark": {"colors": colors}, "widgetType": "bar",
            "encodings": {
                "x": x_enc,
                "y": {"fieldName": y_field, "displayName": y_display,
                      "scale": {"type": "categorical", "sort": {"by": "x-reversed"}}},
                "label": {"show": True},
            },
            "data": {"queryName": "main_query"},
        },
    }


def bar_day(name, title, y_expr, y_field, y_display, y_fmt, colors):
    """Time bar: day on x (temporal), measure on y. `y_fmt` optional — when None,
    the y-encoding carries no explicit format/axis (matches the editor version,
    where only the USD-per-day chart was formatted)."""
    y_enc = {"fieldName": y_field, "displayName": y_display, "scale": {"type": "quantitative"}}
    if y_fmt:
        y_enc = {"fieldName": y_field, "format": y_fmt,
                 "axis": {"hideGrid": False, "hideLabels": False},
                 "displayName": y_display, "scale": {"type": "quantitative"}}
    return {
        "name": name,
        "queries": [{"name": "main_query", "query": {
            "datasetName": DATASET,
            "fields": [{"name": "day", "expression": "`day`"},
                       {"name": y_field, "expression": y_expr}],
            "disaggregated": False}}],
        "spec": {
            "version": 3, "frame": {"title": title, "showTitle": True},
            "mark": {"colors": colors}, "widgetType": "bar",
            "encodings": {
                "x": {"fieldName": "day", "displayName": "Dia", "scale": {"type": "temporal"}},
                "y": y_enc,
                "label": {"show": True},
            },
            "data": {"queryName": "main_query"},
        },
    }


def textbox(name, text):
    return {"name": name, "multilineTextboxSpec": {"lines": [text]}}


def filter_date(name, title):
    qn = "flt_day_day"
    return {
        "name": name,
        "queries": [{"name": qn, "query": {
            "datasetName": DATASET,
            "fields": [{"name": "day", "expression": "`day`"},
                       {"name": "day_associativity", "expression": "COUNT_IF(`associative_filter_predicate_group`)"}],
            "disaggregated": False}}],
        "spec": {
            "version": 2, "frame": {"showTitle": True, "title": title},
            "selection": {"defaultSelection": {"range": {"dataType": "DATE",
                          "min": {"value": "now-30d/d"}, "max": {"value": "now/d"}}}},
            "widgetType": "filter-date-range-picker",
            "encodings": {"fields": [{"fieldName": "day", "queryName": qn}]},
        },
    }


def filter_user(name, title):
    qn = "flt_user_user_email"
    return {
        "name": name,
        "queries": [{"name": qn, "query": {
            "datasetName": DATASET,
            "fields": [{"name": "user_email", "expression": "`user_email`"},
                       {"name": "user_email_associativity", "expression": "COUNT_IF(`associative_filter_predicate_group`)"}],
            "disaggregated": False}}],
        "spec": {
            "version": 2, "frame": {"showTitle": True, "title": title},
            "widgetType": "filter-multi-select",
            "encodings": {"fields": [{"fieldName": "user_email", "queryName": qn}]},
        },
    }


def users_table(name):
    cols = [
        ("user_email", "Email do Usuário", None, True),
        ("endpoint_name", "Endpoint", None, False),
        ("day", "Data", {"type": "date", "date": "locale-short-month", "leadingZeros": True}, None),
        ("total_tokens", "Tokens Totais", None, None),
        ("prompt_tokens", "Input Tokens", None, None),
        ("completion_tokens", "Output Tokens", None, None),
        ("turns", "Turns", None, None),
    ]
    out = []
    for fn, disp, fmt, search in cols:
        c = {"fieldName": fn}
        if fmt:
            c["format"] = fmt
        if search is not None:
            c["useForSearch"] = search
        c["displayName"] = disp
        out.append(c)
    return {
        "name": name,
        "queries": [{"name": "main_query", "query": {
            "datasetName": DATASET,
            "fields": [{"name": fn, "expression": f"`{fn}`"} for fn, _, _, _ in cols],
            "disaggregated": True}}],
        "spec": {
            "version": 2, "frame": {"title": "Detalhe por usuário · endpoint · dia", "showTitle": True},
            "widgetType": "table", "encodings": {"columns": out},
            "data": {"queryName": "main_query"},
        },
    }


# ============================ layout ==========================================
# Row 0: filters + headline cost KPIs
add(filter_user("flt_user", "Usuário"), 0, 0, 4, 2)
add(counter("kpi_dbu", "SUM(`dbus`)", "sum(dbus)", "DBUs consumidos", "DBUs", NUM2E), 4, 0, 4, 2)
add(counter("kpi_usd", "SUM(`usd`)", "sum(usd)", "Custo estimado (USD)", "USD", USD2E), 8, 0, 4, 2)
# Row 2: period filter + usage KPIs
add(filter_date("flt_day", "Período"), 0, 2, 2, 2)
add(counter("kpi_turns", "SUM(`turns`)", "sum(turns)", "Turns", "Turns", NUM1), 2, 2, 2, 2)
add(counter("kpi_users", "COUNT(DISTINCT `user_email`)", "countdistinct(user_email)", "Usuários distintos", "Usuários", NUM0), 4, 2, 2, 2)
add(counter("kpi_inp", "SUM(`prompt_tokens`)", "sum(prompt_tokens)", "Tokens de input", "Input tokens", NUM1), 6, 2, 2, 2)
add(counter("kpi_completion", "SUM(`completion_tokens`)", "sum(completion_tokens)", "Tokens de output", "Output tokens", NUM1), 8, 2, 2, 2)
add(counter("kpi_outp", "SUM(`total_tokens`)", "sum(total_tokens)", "Total de tokens", "Total tokens", NUM1), 10, 2, 2, 2)
# Row 4: detail table
add(users_table("tbl_users"), 0, 4, 12, 7)

# --- USD section (y11) ---
add(textbox("2a67b7a2", "# Tokens"), 0, 11, 12, 1)   # (editor label; see build note)
add(bar_metric("cost_usd_endpoint", "USD por endpoint", "SUM(`usd`)", "sum(usd)", "USD", USD_AXIS, "endpoint_name", "Endpoint", PALETTE_USD), 0, 12, 6, 6)
add(bar_day("cost_usd_day", "USD por dia", "SUM(`usd`)", "sum(usd)", "USD", USD_AXIS, PALETTE_USD), 6, 12, 6, 6)
add(bar_metric("cost_usd_user", "USD por usuário", "SUM(`usd`)", "sum(usd)", "USD", USD_AXIS, "user_email", "Usuário", PALETTE_USD), 0, 18, 12, 6)

# --- Tokens section (y24) ---
add(textbox("6f2f7eeb", "# Tokens"), 0, 24, 12, 1)
add(bar_metric("bar_by_model", "Tokens por endpoint", "SUM(`total_tokens`)", "sum(total_tokens)", "Tokens", None, "endpoint_name", "Endpoint", PALETTE_DEFAULT), 0, 25, 6, 6)
add(bar_day("line_by_day", "Tokens por dia", "SUM(`total_tokens`)", "sum(total_tokens)", "Tokens", None, PALETTE_DEFAULT), 6, 25, 6, 6)
add(bar_metric("bar_by_user", "Tokens por usuário", "SUM(`total_tokens`)", "sum(total_tokens)", "Tokens", None, "user_email", "Usuário", PALETTE_DEFAULT), 0, 31, 12, 6)

# --- DBUs section (y37) ---
add(textbox("9c5db777", "# DBUs"), 0, 37, 12, 1)
add(bar_metric("cost_dbu_endpoint", "DBUs por endpoint", "SUM(`dbus`)", "sum(dbus)", "DBUs", None, "endpoint_name", "Endpoint", PALETTE_DBU), 0, 38, 6, 6)
add(bar_day("cost_dbu_day", "DBUs por dia", "SUM(`dbus`)", "sum(dbus)", "DBUs", None, PALETTE_DBU), 6, 38, 6, 6)
add(bar_metric("cost_dbu_user", "DBUs por usuário", "SUM(`dbus`)", "sum(dbus)", "DBUs", None, "user_email", "Usuário", PALETTE_DBU), 0, 44, 12, 6)

# --- Turns section (y50) ---
add(textbox("4485e10a", "# Turns"), 0, 50, 12, 1)
add(bar_metric("tok_by_model", "Turns por endpoint", "SUM(`turns`)", "sum(turns)", "Turns", None, "endpoint_name", "Endpoint", PALETTE_TURNS), 0, 51, 6, 6)
add(bar_day("turns_day", "Turns por dia", "SUM(`turns`)", "sum(turns)", "Turns", None, PALETTE_TURNS), 6, 51, 6, 6)
add(bar_metric("turns_user", "Turns por usuário", "SUM(`turns`)", "sum(turns)", "Turns", None, "user_email", "Usuário", PALETTE_TURNS), 0, 57, 12, 6)


dashboard = {
    "datasets": [{"name": DATASET, "displayName": "ai_prism_detail", "queryLines": lines(DETAIL_SQL)}],
    "pages": [{"name": "ai_costs_overview", "displayName": "Overview",
               "layout": layout, "pageType": "PAGE_TYPE_CANVAS"}],
    "uiSettings": {"theme": {"widgetHeaderAlignment": "ALIGNMENT_UNSPECIFIED"}},
}

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai-costs.lvdash.json")
with open(out, "w") as f:
    json.dump(dashboard, f, indent=2, ensure_ascii=False)
    f.write("\n")
print("Wrote", out, "| widgets:", len(layout))
