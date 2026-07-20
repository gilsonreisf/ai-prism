import { useEffect, useMemo, useState } from 'react'
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
  Legend,
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
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)

// Period presets → ISO from/to. "all" sends no window.
function rangeFor(preset) {
  if (preset === 'all') return {}
  const now = new Date()
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90
  const from = new Date(now.getTime() - days * 24 * 3600 * 1000)
  return { from: from.toISOString(), to: now.toISOString() }
}

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
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-xs shadow-lg">
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

// Admin cost/usage dashboard: audit LLM spend by user, model and period. All
// numbers come from /api/admin/usage (tokens × list price, computed server-side).
export default function CostsTab({ open }) {
  const t = useT()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [preset, setPreset] = useState('30d')
  const [userQuery, setUserQuery] = useState('')

  const load = async (p) => {
    setLoading(true)
    try {
      const { from, to } = rangeFor(p)
      const qs = new URLSearchParams()
      if (from) qs.set('from', from)
      if (to) qs.set('to', to)
      const r = await getJSON(`/api/admin/usage${qs.toString() ? `?${qs}` : ''}`)
      setData(r)
      setError('')
    } catch (e) {
      setError(e.message)
      setData({ byUserModel: [], daily: [] })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) load(preset)
  }, [open, preset]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- derive the filtered/aggregated views the UI renders ----
  const view = useMemo(() => {
    const rows = data?.byUserModel || []
    const q = userQuery.trim().toLowerCase()
    const filtered = q ? rows.filter((r) => r.userEmail.toLowerCase().includes(q)) : rows

    // per-user totals (cost desc) — the headline ranking
    const byUser = new Map()
    for (const r of filtered) {
      const u = byUser.get(r.userEmail) || { userEmail: r.userEmail, cost: 0, promptTokens: 0, completionTokens: 0, turns: 0 }
      u.cost += r.cost
      u.promptTokens += r.promptTokens
      u.completionTokens += r.completionTokens
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

    // daily cost trend (respecting the user filter)
    const dayMap = new Map()
    for (const d of data?.daily || []) {
      if (q && !d.userEmail.toLowerCase().includes(q)) continue
      dayMap.set(d.day, (dayMap.get(d.day) || 0) + d.cost)
    }
    const trend = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, cost]) => ({ day, cost }))

    const totalCost = users.reduce((s, u) => s + u.cost, 0)
    const totalTokens = filtered.reduce((s, r) => s + r.promptTokens + r.completionTokens, 0)
    const totalTurns = filtered.reduce((s, r) => s + r.turns, 0)

    return { filtered, users, models, trend, totalCost, totalTokens, totalTurns }
  }, [data, userQuery])

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

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text)] flex items-center gap-2">
          <Icon.Monitor size={16} /> {t('costs.title')}
        </h3>
        <p className="text-xs text-[var(--muted)] mt-1">{t('costs.subtitle')}</p>
      </div>

      {/* filters: period presets + user search */}
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
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Icon.Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
          <input
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
            placeholder={t('costs.filterUser')}
            className="w-full pl-8 pr-2 py-1.5 text-xs rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] placeholder:text-[var(--faint)]"
          />
        </div>
      </div>

      {error && <div className="text-xs text-[var(--danger,#ff3621)]">{error}</div>}
      {loading && !data && <div className="text-xs text-[var(--muted)]">{t('costs.loading')}</div>}

      {data && (
        <>
          {/* KPI tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KpiTile label={t('costs.totalCost')} value={fmtUSD(view.totalCost)} sub={t('costs.listPrice')} />
            <KpiTile label={t('costs.totalTokens')} value={fmtTokens(view.totalTokens)} />
            <KpiTile label={t('costs.turns')} value={view.totalTurns.toLocaleString()} />
            <KpiTile label={t('costs.users')} value={String(view.users.length)} />
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

              {/* per-model breakdown */}
              <div>
                <div className="text-xs font-medium text-[var(--muted)] mb-2">{t('costs.byModel')}</div>
                <div className="flex flex-wrap gap-2">
                  {view.models.map((m, i) => (
                    <div
                      key={m.model}
                      className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs"
                    >
                      <span className="inline-block w-2 h-2 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                      <span className="text-[var(--text)]">{m.modelLabel}</span>
                      <span className="text-[var(--muted)] tabular-nums">{fmtUSD(m.cost)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* detailed table (user × model) */}
              <div>
                <div className="text-xs font-medium text-[var(--muted)] mb-2">{t('costs.detail')}</div>
                <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-[var(--surface-3)] text-[var(--muted)] text-left">
                        <th className="px-3 py-2 font-medium">{t('costs.col.user')}</th>
                        <th className="px-3 py-2 font-medium">{t('costs.col.model')}</th>
                        <th className="px-3 py-2 font-medium text-right">{t('costs.col.turns')}</th>
                        <th className="px-3 py-2 font-medium text-right">{t('costs.col.in')}</th>
                        <th className="px-3 py-2 font-medium text-right">{t('costs.col.out')}</th>
                        <th className="px-3 py-2 font-medium text-right">{t('costs.col.cost')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...view.filtered]
                        .sort((a, b) => b.cost - a.cost)
                        .map((r, i) => (
                          <tr key={i} className="border-t border-[var(--border)] text-[var(--text)]">
                            <td className="px-3 py-2">{r.userEmail}</td>
                            <td className="px-3 py-2 text-[var(--muted)]">
                              {r.modelLabel}
                              {r.unpriced && (
                                <span className="ml-1.5 text-[10px] text-[var(--faint)]" title={t('costs.unpricedHint')}>
                                  ({t('costs.unpriced')})
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{r.turns.toLocaleString()}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(r.promptTokens)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmtTokens(r.completionTokens)}</td>
                            <td className="px-3 py-2 text-right tabular-nums font-medium">
                              {r.unpriced ? <span className="text-[var(--faint)]">—</span> : fmtUSD(r.cost)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
