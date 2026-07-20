// AI cost/usage auditing sourced from Databricks SYSTEM TABLES (read via the SQL
// Warehouse), NOT from the app's Lakebase. This keeps analytical load off the
// app database and — crucially — reports the REAL billed cost:
//
//   • system.ai_gateway.usage      → tokens per END USER (requester), per model,
//                                     per day, plus token_details (prompt-cache
//                                     reads, reasoning tokens).
//   • system.billing.usage         → DBU consumed per serving endpoint per day
//     ⋈ system.billing.list_prices → × $/DBU (with price validity windows) = USD.
//
// Billing is per-endpoint (no user); the gateway is per-user (no dollars). To get
// USD per user we ALLOCATE each endpoint/day's billed cost by that user's share
// of the endpoint's total tokens that day:
//
//   usd_user = usd_endpoint_day × (user_tokens / endpoint_total_tokens)
//
// The denominator is the endpoint's ENTIRE traffic (every user/app in the
// workspace); the numerator is only the AI Prism-scoped slice. So the sum of the
// allocated figures equals billing × (AI Prism's fraction of the endpoint) — the
// real dollars AI Prism cost, never inheriting unrelated serving spend. Validated
// live: allocated Σ reconciles to the penny against billing.
//
// Scoping to AI Prism uses request_tags['application'] = 'ai-prism' (set on every
// gateway call via usage_context — see server/llm.js). Because that tag only
// exists going forward, `scoped` is applied with a transition-safe fallback: when
// no tagged rows exist yet for the window, we report the user's full serving
// traffic rather than an empty dashboard.
import { execStatement, warehouseId } from './warehouse.js'

// The tag key/value we stamp onto every gateway request (see llm.js applyUsageContext).
export const USAGE_TAG_KEY = 'application'
export const USAGE_TAG_VALUE = 'ai-prism'

// Ingestion lag observed live: gateway ~30-40min, billing ~1h. Surfaced to the
// UI so admins read "as of" instead of assuming real-time.
const num = (x) => (x == null ? 0 : Number(x) || 0)

// Turn the {columns, rows} shape from execStatement into array-of-objects.
function toObjects({ columns, rows }) {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])))
}

/**
 * Whether any AI Prism-tagged gateway rows exist in the window. Drives the
 * transition fallback: until the tag has propagated (ingestion lag + rollout),
 * we don't want to strand the dashboard on an empty result.
 */
async function hasTaggedRows(token, fromExpr, toExpr) {
  const sql = `
    SELECT COUNT(*) AS n
    FROM system.ai_gateway.usage
    WHERE requester_type = 'USER'
      AND request_tags['${USAGE_TAG_KEY}'] = '${USAGE_TAG_VALUE}'
      AND event_time >= ${fromExpr}
      AND event_time <  ${toExpr}`
  const { rows } = await execStatement(token, sql, [], { warehouseId: warehouseId() })
  return num(rows?.[0]?.[0]) > 0
}

/**
 * Fetch usage/cost aggregated by user+model and by user+day+model, priced with
 * real billed DBU. Returns the same shape /api/admin/usage already emits, plus
 * `dbus` and `cacheReadTokens` per row and a `meta` block (freshness, scope).
 *
 * @param userToken  the admin's OBO token (system tables are read under their grants)
 * @param opts.from/opts.to  ISO timestamps; default = last 30 days
 * @param opts.scoped        true → only AI Prism-tagged traffic (with fallback)
 */
export async function getUsageFromSystemTables(userToken, { from = null, to = null, scoped = true } = {}) {
  // Bind the window as parameters so the warehouse plans/caches consistently.
  // NULL → sensible defaults (last 30 days .. now) computed in SQL.
  const params = [
    { name: 'from_ts', type: 'STRING', value: from },
    { name: 'to_ts', type: 'STRING', value: to },
  ]
  const fromExpr = `COALESCE(try_cast(:from_ts AS TIMESTAMP), now() - INTERVAL 30 DAY)`
  const toExpr = `COALESCE(try_cast(:to_ts AS TIMESTAMP), now())`

  // Decide scoping once: if scoped but nothing is tagged yet, fall back to all
  // traffic so the dashboard is never mysteriously empty during rollout.
  let effectiveScoped = scoped
  let scopeFellBack = false
  if (scoped) {
    const tagged = await hasTaggedRows(userToken, fromExpr, toExpr).catch(() => false)
    if (!tagged) {
      effectiveScoped = false
      scopeFellBack = true
    }
  }
  // Numerator filter: AI Prism-only rows when scoping is in effect.
  const scopeFilter = effectiveScoped
    ? `AND request_tags['${USAGE_TAG_KEY}'] = '${USAGE_TAG_VALUE}'`
    : ''

  // Shared CTEs. `cost` = billed USD+DBU per endpoint/day. `total` = the
  // endpoint's ENTIRE token volume/day (allocation denominator — unscoped on
  // purpose). `mine` = the AI Prism-scoped per-user tokens (numerator).
  const cte = `
    WITH cost AS (
      SELECT
        u.usage_metadata.endpoint_name           AS model,
        u.usage_date                              AS day,
        SUM(u.usage_quantity)                     AS dbus,
        SUM(u.usage_quantity * p.pricing.default) AS usd
      FROM system.billing.usage u
      JOIN system.billing.list_prices p
        ON u.sku_name = p.sku_name
       AND u.usage_start_time >= p.price_start_time
       AND (p.price_end_time IS NULL OR u.usage_start_time < p.price_end_time)
      WHERE u.billing_origin_product = 'MODEL_SERVING'
        AND u.usage_metadata.endpoint_name IS NOT NULL
        AND u.usage_date >= to_date(${fromExpr})
        AND u.usage_date <= to_date(${toExpr})
      GROUP BY 1, 2
    ),
    total AS (
      SELECT endpoint_name AS model, date(event_time) AS day,
             SUM(input_tokens + output_tokens) AS ep_tokens
      FROM system.ai_gateway.usage
      WHERE requester_type = 'USER'
        AND endpoint_name IS NOT NULL
        AND event_time >= ${fromExpr} AND event_time < ${toExpr}
      GROUP BY 1, 2
    ),
    mine AS (
      SELECT
        lower(requester)   AS user_email,
        endpoint_name      AS model,
        date(event_time)   AS day,
        SUM(input_tokens)  AS prompt_tokens,
        SUM(output_tokens) AS completion_tokens,
        SUM(COALESCE(try_cast(token_details.cache_read_input_tokens AS BIGINT), 0)) AS cache_read_tokens,
        COUNT(*)           AS turns
      FROM system.ai_gateway.usage
      WHERE requester_type = 'USER'
        AND endpoint_name IS NOT NULL
        AND event_time >= ${fromExpr} AND event_time < ${toExpr}
        ${scopeFilter}
      GROUP BY 1, 2, 3
    ),
    alloc AS (
      SELECT
        m.user_email, m.model, m.day,
        m.prompt_tokens, m.completion_tokens, m.cache_read_tokens, m.turns,
        COALESCE(c.dbus, 0) * (m.prompt_tokens + m.completion_tokens) / NULLIF(t.ep_tokens, 0) AS dbus,
        COALESCE(c.usd,  0) * (m.prompt_tokens + m.completion_tokens) / NULLIF(t.ep_tokens, 0) AS usd
      FROM mine m
      JOIN total t ON t.model = m.model AND t.day = m.day
      LEFT JOIN cost c ON c.model = m.model AND c.day = m.day
    )`

  // byUserModel: rolled up across days. daily: per user+day+model for the trend.
  const byUserModelSql = `${cte}
    SELECT user_email, model,
           SUM(turns)             AS turns,
           SUM(prompt_tokens)     AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens,
           SUM(dbus)              AS dbus,
           SUM(usd)               AS usd
    FROM alloc
    GROUP BY user_email, model
    ORDER BY usd DESC NULLS LAST`

  const dailySql = `${cte}
    SELECT user_email, date_format(day, 'yyyy-MM-dd') AS day, model,
           SUM(prompt_tokens)     AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(dbus)              AS dbus,
           SUM(usd)               AS usd
    FROM alloc
    GROUP BY user_email, day, model
    ORDER BY day ASC`

  const metaSql = `
    SELECT
      (SELECT MAX(event_time) FROM system.ai_gateway.usage) AS gw_latest,
      (SELECT MAX(usage_end_time) FROM system.billing.usage WHERE billing_origin_product='MODEL_SERVING') AS billing_latest,
      now() AS now_ts`

  // Run the three statements. The two big ones share the same warm warehouse.
  const [byUM, daily, meta] = await Promise.all([
    execStatement(userToken, byUserModelSql, params, { warehouseId: warehouseId(), timeoutMs: 60000 }).then(toObjects),
    execStatement(userToken, dailySql, params, { warehouseId: warehouseId(), timeoutMs: 60000 }).then(toObjects),
    execStatement(userToken, metaSql, [], { warehouseId: warehouseId(), timeoutMs: 30000 }).then(toObjects),
  ])

  const byUserModel = byUM.map((r) => ({
    userEmail: r.user_email,
    model: r.model,
    turns: num(r.turns),
    promptTokens: num(r.prompt_tokens),
    completionTokens: num(r.completion_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
    dbus: num(r.dbus),
    cost: num(r.usd),
  }))
  const dailyRows = daily.map((r) => ({
    userEmail: r.user_email,
    day: r.day,
    model: r.model,
    promptTokens: num(r.prompt_tokens),
    completionTokens: num(r.completion_tokens),
    dbus: num(r.dbus),
    cost: num(r.usd),
  }))

  const m = meta?.[0] || {}
  return {
    byUserModel,
    daily: dailyRows,
    meta: {
      source: 'system_tables',
      scoped: effectiveScoped,
      scopeFellBack, // true → tag not yet propagated; showing all serving traffic
      gatewayLatest: m.gw_latest || null,
      billingLatest: m.billing_latest || null,
      now: m.now_ts || null,
    },
  }
}
