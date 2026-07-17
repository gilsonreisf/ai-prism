import { useRef } from 'react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import * as Icon from '../Icons.jsx'
import { downloadChartAsPng } from '../../chartExport.js'

// Palette anchored on the app's accent color, with neutral steps for extra series.
const COLORS = ['#ff3621', '#4285F4', '#10A37F', '#FF6A00', '#7C6FF0', '#98a2b3']

// Tooltip/cursor themed to match the app instead of Recharts' default
// white-on-white box and the oversized light-grey hover bar behind bars.
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-xl text-xs max-w-[220px]">
      {label != null && <div className="font-semibold text-[var(--text)] mb-1 truncate">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
          <span className="text-[var(--muted)] truncate">{p.name}:</span>
          <span className="font-semibold text-[var(--text)] ml-auto">
            {typeof p.value === 'number' ? p.value.toLocaleString('pt-BR') : p.value}
          </span>
        </div>
      ))}
    </div>
  )
}

const CURSOR_FILL = { fill: 'var(--border)', opacity: 0.4 }
const CURSOR_LINE = { stroke: 'var(--faint)', strokeDasharray: '4 4' }

function toRows(series) {
  // Recharts wants one row per label with a key per series: [{label, s0, s1, ...}]
  const labels = series[0]?.data.map((d) => d.label) || []
  return labels.map((label, i) => {
    const row = { label }
    series.forEach((s, si) => {
      row[`s${si}`] = s.data[i]?.value ?? null
    })
    return row
  })
}

export default function ChartBlock({ block }) {
  const { chartType, title, series, caption } = block
  const rows = toRows(series)
  const containerRef = useRef(null)

  return (
    <div ref={containerRef} className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 my-3">
      <div className="flex items-start justify-between gap-2 mb-2">
        {title && <div className="text-sm font-semibold">{title}</div>}
        <button
          onClick={() => downloadChartAsPng(containerRef.current, title)}
          className="shrink-0 p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--faint)] hover:text-[var(--text)] transition"
          title="Exportar como imagem (PNG)"
        >
          <Icon.Download size={14} />
        </button>
      </div>
      <div style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer>
          {chartType === 'pie' ? (
            <PieChart>
              <Pie
                data={rows}
                dataKey="s0"
                nameKey="label"
                cx="50%"
                cy="50%"
                outerRadius={90}
                label={({ label }) => label}
              >
                {rows.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip />} />
            </PieChart>
          ) : chartType === 'line' ? (
            <LineChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--faint)' }} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--faint)' }} />
              <Tooltip content={<ChartTooltip />} cursor={CURSOR_LINE} />
              {series.length > 1 && <Legend />}
              {series.map((s, i) => (
                <Line key={i} type="monotone" dataKey={`s${i}`} name={s.name} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          ) : chartType === 'area' ? (
            <AreaChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--faint)' }} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--faint)' }} />
              <Tooltip content={<ChartTooltip />} cursor={CURSOR_LINE} />
              {series.map((s, i) => (
                <Area key={i} type="monotone" dataKey={`s${i}`} name={s.name} stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={0.25} />
              ))}
            </AreaChart>
          ) : (
            <BarChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--faint)' }} interval={0} angle={rows.length > 6 ? -30 : 0} textAnchor={rows.length > 6 ? 'end' : 'middle'} height={rows.length > 6 ? 50 : 30} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--faint)' }} />
              <Tooltip content={<ChartTooltip />} cursor={CURSOR_FILL} />
              {series.length > 1 && <Legend />}
              {series.map((s, i) => (
                <Bar key={i} dataKey={`s${i}`} name={s.name} fill={COLORS[i % COLORS.length]} radius={[6, 6, 0, 0]} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
      {caption && <div className="text-xs text-[var(--muted)] mt-2">{caption}</div>}
    </div>
  )
}
