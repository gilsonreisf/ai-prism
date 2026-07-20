import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from 'recharts'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import { getJSON } from '../api.js'

// Same brand palette the chat charts use, so the admin dashboard reads as one system.
const COLORS = ['#ff3621', '#4285F4', '#10A37F', '#FF6A00', '#7C6FF0', '#98a2b3']

const fmtUSD = (n) =>
  n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : '$0'
const fmtTokens = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0)
const fmtDBU = (n) => (n >= 1 ? n.toFixed(1) : n > 0 ? n.toFixed(3) : '0')

// Period presets → ISO from/to. "all" sends no window.
function rangeFor(preset) {
  if (preset === 'all') return {}
  const now = new Date()
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90
  const from = new Date(now.getTime() - days * 24 * 3600 * 1000)
  return { from: from.toISOString(), to: now.toISOString() }
}

// "2h atrás" style relative age for the freshness banner.
function ageLabel(iso, t) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (mins < 60) return t('costs.ageMin', { n: mins })
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return t('costs.ageHour', { n: hrs })
  return t('costs.ageDay', { n: Math.round(hrs / 24) })
}

// Module-level cache of the last fetched result per period. Because the tab
// unmounts on every Settings tab switch, this lets a previously loaded view come
// back instantly (no warehouse hit) while still requiring an explicit refresh to
// pull new numbers — the warehouse is only queried on a deliberate click.
const clientCache = new Map() // preset -> { data, fetchedAt }

function KpiTile({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-[var(--faint)]">{label}</div>
      <div className="text-2xl font-semibold text-[var(--text)] mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-[var(--muted)] mt-0.5">{sub}</div>}
    </div>
  )
}

function CostTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs shadow-lg">
      <div className="font-medium text-[var(--text)] mb-1">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 text-[var(--muted)]">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: p.color || p.fill }} />
          {p.name}: <span className="tabular-nums text-[var(--text)]">{fmtUSD(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

// A lightweight combobox: text input + suggestion list, matching the admins
// autocomplete pattern. Options are the users/models seen in the data itself.
function FilterCombo({ icon, value, onChange, options, placeholder }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef(null)
  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  const ql = q.trim().toLowerCase()
  const matches = options
    .filter((o) => !ql || o.label.toLowerCase().includes(ql) || o.value.toLowerCase().includes(ql))
    .slice(0, 40)
  const Ic = icon
  const selectedLabel = value ? (options.find((o) => o.value === value)?.label ?? value) : ''
  return (
    <div className="relative w-full sm:w-64" ref={ref}>
      <Ic size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)] pointer-events-none" />
      <input
        value={open ? q : selectedLabel}
        onChange={(e) => {
          setQ(e.target.value)
          if (!open) setOpen(true)
        }}
        onFocus={() => {
          setQ('')
          setOpen(true)
        }}
        placeholder={placeholder}
        className="w-full pl-8 pr-7 py-1.5 text-xs rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] placeholder:text-[var(--faint)] outline-none focus:border-[var(--accent)] truncate"
      />
      {value && (
        <button
          onClick={() => {
            onChange('')
            setQ('')
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--faint)] hover:text-[var(--text)]"
          aria-label="clear"
        >
          <Icon.Close size={13} />
        </button>
      )}
      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[280px] max-h-72 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl shadow-black/50 py-1">
          {matches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-[var(--faint)]">—</div>
          ) : (
            matches.map((o) => (
              <button
                key={o.value}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-[var(--surface-3)] flex items-center justify-between gap-3 ${
                  o.value === value ? 'bg-[var(--surface-3)] text-[var(--text)]' : 'text-[var(--text)]'
                }`}
              >
                <span className="truncate flex-1" title={o.label}>{o.label}</span>
                {o.hint != null && <span className="text-[var(--muted)] tabular-nums shrink-0">{o.hint}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// Admin cost/usage dashboard: audit LLM spend by user, model and period. Numbers
// come from /api/admin/usage, which reads Databricks SYSTEM TABLES via the SQL
// Warehouse — real billed cost (DBU × list price), allocated per user by token
// share. Nothing hits the app's Lakebase.
export default function CostsTab({ open }) {
  const t = useT()
  const [data, setData] = useState(null)
  const [fetchedAt, setFetchedAt] = useState(null) // when the shown data was pulled
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0) // seconds the current query has run
  const [preset, setPreset] = useState('30d')
  const [userFilter, setUserFilter] = useState('')
  const [modelFilter, setModelFilter] = useState('')
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 15

  // Tick a seconds counter while loading so a multi-minute cold-warehouse query
  // never looks frozen. Reset on each new load.
  useEffect(() => {
    if (!loading) return
    setElapsed(0)
    const id = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [loading])

  // Query the warehouse. Only ever called from an explicit click (or restored
  // from the client cache) — never on mount/tab-open, to spare the warehouse.
  const load = async (p, { force = false } = {}) => {
    setLoading(true)
    setError('')
    try {
      const { from, to } = rangeFor(p)
      const qs = new URLSearchParams()
      if (from) qs.set('from', from)
      if (to) qs.set('to', to)
      if (force) qs.set('refresh', '1')
      const r = await getJSON(`/api/admin/usage${qs.toString() ? `?${qs}` : ''}`)
      const stamp = r.meta?.fetchedAt || new Date().toISOString()
      setData(r)
      setFetchedAt(stamp)
      clientCache.set(p, { data: r, fetchedAt: stamp })
      setError('')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // On open / period change: restore from cache if we have it, but never auto-hit
  // the warehouse — the admin must click to load or refresh.
  useEffect(() => {
    if (!open) return
    const cached = clientCache.get(preset)
    if (cached) {
      setData(cached.data)
      setFetchedAt(cached.fetchedAt)
    } else {
      setData(null)
      setFetchedAt(null)
    }
    setError('')
  }, [open, preset])

  // ---- derive the filtered/aggregated views the UI renders ----
  const view = useMemo(() => {
    const rows = data?.byUserModel || []
    const filtered = rows.filter(
      (r) => (!userFilter || r.userEmail === userFilter) && (!modelFilter || r.model === modelFilter)
    )

    // per-user totals (cost desc) — the headline ranking
    const byUser = new Map()
    for (const r of filtered) {
      const u = byUser.get(r.userEmail) || {
        userEmail: r.userEmail, cost: 0, promptTokens: 0, completionTokens: 0,
        cacheReadTokens: 0, dbus: 0, turns: 0,
      }
      u.cost += r.cost
      u.promptTokens += r.promptTokens
      u.completionTokens += r.completionTokens
      u.cacheReadTokens += r.cacheReadTokens || 0
      u.dbus += r.dbus || 0
      u.turns += r.turns
      byUser.set(r.userEmail, u)
    }
    const users = [...byUser.values()].sort((a, b) => b.cost - a.cost)

    // per-model totals
    const byModel = new Map()
    for (const r of filtered) {
      const m = byModel.get(r.model) || { model: r.model, modelLabel: r.modelLabel, cost: 0, turns: 0 }
      m.cost += r.cost
      m.turns += r.turns
      byModel.set(r.model, m)
    }
    const models = [...byModel.values()].sort((a, b) => b.cost - a.cost)

    // daily cost trend (respecting the filters)
    const dayMap = new Map()
    for (const d of data?.daily || []) {
      if (userFilter && d.userEmail !== userFilter) continue
      if (modelFilter && d.model !== modelFilter) continue
      dayMap.set(d.day, (dayMap.get(d.day) || 0) + d.cost)
    }
    const trend = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, cost]) => ({ day, cost }))

    const totalCost = users.reduce((s, u) => s + u.cost, 0)
    const totalTokens = filtered.reduce((s, r) => s + r.promptTokens + r.completionTokens, 0)
    const totalCacheTokens = filtered.reduce((s, r) => s + (r.cacheReadTokens || 0), 0)
    const totalDbus = filtered.reduce((s, r) => s + (r.dbus || 0), 0)
    const totalTurns = filtered.reduce((s, r) => s + r.turns, 0)

    return { filtered, users, models, trend, totalCost, totalTokens, totalCacheTokens, totalDbus, totalTurns }
  }, [data, userFilter, modelFilter])

  // options for the filter combos, built from the data (all rows, so the user
  // can always pick anyone/any model regardless of the current filter)
  const userOptions = useMemo(() => {
    const m = new Map()
    for (const r of data?.byUserModel || []) m.set(r.userEmail, (m.get(r.userEmail) || 0) + r.cost)
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([email, cost]) => ({ value: email, label: email, hint: fmtUSD(cost) }))
  }, [data])
  const modelOptions = useMemo(() => {
    const m = new Map()
    for (const r of data?.byUserModel || []) {
      if (!m.has(r.model)) m.set(r.model, r.modelLabel)
    }
    return [...m.entries()].map(([value, label]) => ({ value, label }))
  }, [data])

  // paginated detail rows (cost desc). Reset to page 0 whenever the underlying
  // filter set changes so we never land on an out-of-range page.
  const sortedRows = useMemo(
    () => [...view.filtered].sort((a, b) => b.cost - a.cost),
    [view.filtered]
  )
  useEffect(() => setPage(0), [userFilter, modelFilter, preset, data])
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE))
  const pageStart = page * PAGE_SIZE
  const pageRows = sortedRows.slice(pageStart, pageStart + PAGE_SIZE)

  const presets = [
    { id: '7d', label: t('costs.range.7d') },
    { id: '30d', label: t('costs.range.30d') },
    { id: '90d', label: t('costs.range.90d') },
    { id: 'all', label: t('costs.range.all') },
  ]

  const topUsersChart = view.users.slice(0, 12).map((u) => ({
    name: u.userEmail.split('@')[0],
    email: u.userEmail,
    cost: Number(u.cost.toFixed(4)),
  }))

  const meta = data?.meta || {}

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
          <Icon.Monitor size={16} /> {t('costs.title')}
        </h3>
        <p className="text-xs text-[var(--muted)] mt-1">{t('costs.subtitle')}</p>
      </div>

      {/* filters: period presets + user/model combos */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-[var(--border)] overflow-hidden">
          {presets.map((p) => (
            <button
              key={p.id}
              onClick={() => setPreset(p.id)}
              className={`px-3 py-1.5 text-xs transition ${
                preset === p.id ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)] hover:bg-[var(--surface-3)]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <FilterCombo
          icon={Icon.Search}
          value={userFilter}
          onChange={setUserFilter}
          options={userOptions}
          placeholder={t('costs.filterUser')}
        />
        <FilterCombo
          icon={Icon.Sparkle}
          value={modelFilter}
          onChange={setModelFilter}
          options={modelOptions}
          placeholder={t('costs.filterModel')}
        />
        {/* explicit load/refresh — the ONLY thing that queries the warehouse */}
        <button
          onClick={() => load(preset, { force: !!data })}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text)] hover:bg-[var(--surface-3)] disabled:opacity-40"
        >
          <Icon.Regenerate size={13} className={loading ? 'animate-spin' : ''} />
          {data ? t('costs.refresh') : t('costs.loadData')}
        </button>
      </div>

      {/* freshness + scope banner */}
      {data && !loading && (fetchedAt || meta.gatewayLatest || meta.scopeFellBack) && (
        <div className="text-[11px] text-[var(--faint)] flex flex-wrap items-center gap-x-3 gap-y-1">
          {fetchedAt && <span>{t('costs.fetchedAt', { age: ageLabel(fetchedAt, t) })}</span>}
          {meta.gatewayLatest && <span>{t('costs.asOf', { age: ageLabel(meta.gatewayLatest, t) })}</span>}
          {meta.scopeFellBack && <span className="text-[var(--warning,#FF6A00)]">{t('costs.scopeFallback')}</span>}
        </div>
      )}

      {error && !loading && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-[var(--danger,#ff3621)]">{error}</span>
          <button
            onClick={() => load(preset, { force: true })}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border)] text-[var(--text)] hover:bg-[var(--surface-3)]"
          >
            <Icon.Regenerate size={12} /> {t('costs.retry')}
          </button>
        </div>
      )}

      {/* warehouse can be cold — a multi-minute query must not look frozen, so we
          show elapsed seconds and warn once it's clearly a cold start */}
      {loading && (
        <div className="flex items-center gap-2 text-xs text-[var(--muted)] py-6">
          <span className="block w-3.5 h-3.5 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
          <span>
            {t('costs.loadingWarehouse')}
            {elapsed >= 3 && <span className="tabular-nums text-[var(--faint)]"> · {elapsed}s</span>}
            {elapsed >= 20 && <span className="text-[var(--faint)]"> — {t('costs.coldHint')}</span>}
          </span>
        </div>
      )}

      {/* nothing loaded yet: invite the click instead of auto-querying */}
      {!data && !loading && !error && (
        <div className="text-xs text-[var(--muted)] py-10 text-center">{t('costs.notLoaded')}</div>
      )}

      {data && !loading && (
        <>
          {/* KPI tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KpiTile label={t('costs.totalCost')} value={fmtUSD(view.totalCost)} sub={t('costs.billedPrice')} />
            <KpiTile label={t('costs.totalTokens')} value={fmtTokens(view.totalTokens)} sub={view.totalCacheTokens > 0 ? t('costs.cacheSub', { n: fmtTokens(view.totalCacheTokens) }) : undefined} />
            <KpiTile label={t('costs.totalDbu')} value={fmtDBU(view.totalDbus)} sub="DBU" />
            <KpiTile label={t('costs.turns')} value={view.totalTurns.toLocaleString()} sub={t('costs.usersN', { n: view.users.length })} />
          </div>

          {view.users.length === 0 ? (
            <div className="text-xs text-[var(--muted)] py-8 text-center">{t('costs.empty')}</div>
          ) : (
            <>
              {/* cost by user */}
              <div>
                <div className="text-xs font-medium text-[var(--muted)] mb-2">{t('costs.byUser')}</div>
                <div style={{ width: '100%', height: Math.max(160, topUsersChart.length * 28) }}>
                  <ResponsiveContainer>
                    <BarChart data={topUsersChart} layout="vertical" margin={{ left: 8, right: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--faint)' }} tickFormatter={fmtUSD} />
                      <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11, fill: 'var(--faint)' }} />
                      <Tooltip content={<CostTooltip />} cursor={{ fill: 'var(--surface-3)', opacity: 0.4 }} />
                      <Bar dataKey="cost" name={t('costs.cost')} radius={[0, 6, 6, 0]}>
                        {topUsersChart.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* daily trend */}
              {view.trend.length > 1 && (
                <div>
                  <div className="text-xs font-medium text-[var(--muted)] mb-2">{t('costs.trend')}</div>
                  <div style={{ width: '100%', height: 200 }}>
                    <ResponsiveContainer>
                      <LineChart data={view.trend}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                        <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--faint)' }} />
                        <YAxis tick={{ fontSize: 11, fill: 'var(--faint)' }} tickFormatter={fmtUSD} />
                        <Tooltip content={<CostTooltip />} />
                        <Line type="monotone" dataKey="cost" name={t('costs.cost')} stroke={COLORS[0]} strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* detailed table (user × model), paginated */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-medium text-[var(--muted)]">{t('costs.detail')}</div>
                  <div className="text-[11px] text-[var(--faint)] tabular-nums">
                    {t('costs.rowsRange', {
                      from: sortedRows.length ? pageStart + 1 : 0,
                      to: Math.min(pageStart + PAGE_SIZE, sortedRows.length),
                      total: sortedRows.length,
                    })}
                  </div>
                </div>
                <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-[var(--surface-3)] text-[var(--muted)] text-left">
                        <th className="px-3 py-2 font-medium">{t('costs.col.user')}</th>
                        <th className="px-3 py-2 font-medium">{t('costs.col.model')}</th>
                        <th className="px-3 py-2 font-medium text-right">{t('costs.col.turns')}</th>
                        <th className="px-3 py-2 font-medium text-right">{t('costs.col.in')}</th>
                        <th className="px-3 py-2 font-medium text-right">{t('costs.col.out')}</th>
                        <th className="px-3 py-2 font-medium text-right">{t('costs.col.dbu')}</th>
                        <th className="px-3 py-2 font-medium text-right">{t('costs.col.cost')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((r, i) => (
                        <tr key={pageStart + i} className="border-t border-[var(--border)] text-[var(--text)]">
                          <td className="px-3 py-2">{r.userEmail}</td>
                          <td className="px-3 py-2 text-[var(--muted)]">{r.modelLabel}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.turns.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(r.promptTokens)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(r.completionTokens)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-[var(--muted)]">{fmtDBU(r.dbus || 0)}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtUSD(r.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {pageCount > 1 && (
                  <div className="flex items-center justify-end gap-2 mt-2">
                    <button
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0}
                      className="p-1.5 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-3)] disabled:opacity-40 disabled:hover:bg-transparent"
                      aria-label="previous page"
                    >
                      <Icon.ChevronLeft size={14} />
                    </button>
                    <span className="text-[11px] text-[var(--muted)] tabular-nums">
                      {t('costs.pageOf', { page: page + 1, total: pageCount })}
                    </span>
                    <button
                      onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                      disabled={page >= pageCount - 1}
                      className="p-1.5 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-3)] disabled:opacity-40 disabled:hover:bg-transparent"
                      aria-label="next page"
                    >
                      <Icon.ChevronRight size={14} />
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
