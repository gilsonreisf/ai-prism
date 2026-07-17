// Deterministic parsing of spreadsheets/CSVs into chart-ready structures.
// Chart *data* always comes from here, never from the model — this keeps
// numbers trustworthy (the LLM only narrates/selects among real candidates).
import * as XLSX from 'xlsx'

const MAX_ROWS_SCANNED = 5000
const MAX_CATEGORIES = 20

function ext(name) {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function inferType(values) {
  const sample = values.filter((v) => v !== null && v !== undefined && v !== '').slice(0, 200)
  if (!sample.length) return 'empty'
  const numeric = sample.filter((v) => typeof v === 'number' || (!isNaN(v) && v !== '')).length
  if (numeric / sample.length > 0.8) return 'numeric'
  const dates = sample.filter((v) => v instanceof Date || !isNaN(Date.parse(v))).length
  if (dates / sample.length > 0.8) return 'date'
  return 'categorical'
}

function summarizeColumn(name, values) {
  const type = inferType(values)
  const col = { name, type }
  // distinctCount is computed for every type, not just categorical — it's
  // what lets a numeric-looking column (year, month, a region code) be
  // recognized as a grouping dimension instead of a continuous metric below.
  col.distinctCount = new Set(values.filter((v) => v !== null && v !== undefined && v !== '')).size
  if (type === 'numeric') {
    const nums = values.map(Number).filter((n) => !isNaN(n))
    col.stats = {
      count: nums.length,
      min: nums.length ? Math.min(...nums) : null,
      max: nums.length ? Math.max(...nums) : null,
      sum: nums.reduce((a, b) => a + b, 0),
      avg: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
    }
  }
  return col
}

// SQL/spreadsheet column names are rarely presentable as-is ("numero_pedidos",
// "ticket_medio") — chart titles need natural-language phrases instead. A
// small dictionary of exact, known metric names (from this app's own demo
// datasets) gives a perfect phrase for the common cases; anything else falls
// back to a generic underscore-to-space + accent-restoration pass so a raw
// identifier is never dumped straight into a title.
const KNOWN_METRIC_PHRASES = {
  regiao: 'região',
  estado: 'estado',
  receita_total: 'receita total',
  receita_total_reais: 'receita total',
  numero_pedidos: 'número de pedidos',
  quantidade_pedidos: 'número de pedidos',
  numero_clientes_unicos: 'número de clientes únicos',
  ticket_medio: 'ticket médio',
  nota_media_avaliacao: 'nota média de avaliação',
  nota_media: 'nota média',
}
const WORD_ACCENTS = {
  numero: 'número',
  numeros: 'números',
  regiao: 'região',
  regioes: 'regiões',
  medio: 'médio',
  media: 'média',
  avaliacao: 'avaliação',
  avaliacoes: 'avaliações',
  unicos: 'únicos',
  unico: 'único',
  unica: 'única',
  unicas: 'únicas',
  preco: 'preço',
  precos: 'preços',
  pais: 'país',
}

function humanize(raw) {
  const key = String(raw).toLowerCase().trim()
  const known = KNOWN_METRIC_PHRASES[key]
  const phrase = known || key.split(/[_\s]+/).filter(Boolean).map((w) => WORD_ACCENTS[w] || w).join(' ')
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

// SQL aggregations routinely GROUP BY a column that's numeric-typed but is
// really a dimension (year, month, a region/category id) — not a continuous
// metric. inferType alone can't tell them apart, so this name heuristic
// backstops it: if it looks like a time unit, prefer treating it as one.
const TIME_LIKE_NAME_RE = /^(ano|year|m[eê]s|month|dia|day|data|date|trimestre|quarter|semana|week|semestre)/i

// Builds up to a handful of real, aggregated chart candidates from a sheet's
// (or a Genie query's) rows — an array of objects keyed by column name.
// A "dimension" is anything usable as a chart's x-axis/category: text
// columns, date columns, and low-cardinality numeric columns (year, month,
// a region code) that are clearly a grouping key, not a measure, because
// they repeat across rows. Dimension x measure -> bar/pie; a time-like or
// date dimension x measure -> line, sorted chronologically.
function buildChartCandidates(sheetName, headers, rows, columns) {
  const candidates = []
  const isRepeatingDimension = (c) =>
    c.distinctCount != null && c.distinctCount >= 2 && c.distinctCount <= MAX_CATEGORIES && c.distinctCount < rows.length

  const timeCols = columns
    .filter((c) => c.type === 'date' || (c.type === 'numeric' && TIME_LIKE_NAME_RE.test(c.name) && isRepeatingDimension(c)))
    .map((c) => c.name)
  const categoricalCols = columns
    .filter((c) => !timeCols.includes(c.name) && (c.type === 'categorical' || (c.type === 'numeric' && isRepeatingDimension(c))))
    .map((c) => c.name)
  const measureCols = columns
    .filter((c) => c.type === 'numeric' && !timeCols.includes(c.name) && !categoricalCols.includes(c.name))
    .map((c) => c.name)

  const aggregateBy = (keyCol, valueCol) => {
    const agg = new Map()
    for (const r of rows) {
      const key = String(r[keyCol] ?? '—').trim() || '—'
      const val = Number(r[valueCol])
      if (isNaN(val)) continue
      agg.set(key, (agg.get(key) || 0) + val)
    }
    return [...agg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_CATEGORIES)
      .map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 }))
  }

  for (const keyCol of categoricalCols.slice(0, 2)) {
    for (const valueCol of measureCols.slice(0, 5)) {
      const data = aggregateBy(keyCol, valueCol)
      if (data.length < 2) continue
      const id = `c${candidates.length + 1}`
      candidates.push({
        id,
        chartType: 'bar',
        title: `${humanize(valueCol)} por ${humanize(keyCol)}`,
        series: [{ name: valueCol, data }],
      })
      if (data.length <= 8) {
        candidates.push({
          id: `c${candidates.length + 1}`,
          chartType: 'pie',
          title: `Distribuição de ${humanize(valueCol)} por ${humanize(keyCol)}`,
          series: [{ name: valueCol, data }],
        })
      }
    }
  }

  for (const timeCol of timeCols.slice(0, 1)) {
    for (const valueCol of measureCols.slice(0, 5)) {
      const data = aggregateBy(timeCol, valueCol).sort((a, b) => (a.label > b.label ? 1 : -1))
      if (data.length < 2) continue
      candidates.push({
        id: `c${candidates.length + 1}`,
        chartType: 'line',
        title: `${humanize(valueCol)} ao longo do tempo`,
        series: [{ name: valueCol, data }],
      })
    }
  }

  return candidates.slice(0, 15)
}

function sheetToRows(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true })
  return rows.slice(0, MAX_ROWS_SCANNED)
}

function analyzeWorkbook(wb) {
  const sheets = []
  const chartCandidates = []
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    const rows = sheetToRows(ws)
    if (!rows.length) {
      sheets.push({ name, headers: [], rowCount: 0, columns: [] })
      continue
    }
    const headers = Object.keys(rows[0])
    const columns = headers.map((h) => summarizeColumn(h, rows.map((r) => r[h])))
    sheets.push({ name, headers, rowCount: rows.length, columns })
    for (const cand of buildChartCandidates(name, headers, rows, columns)) {
      chartCandidates.push(cand)
    }
  }
  // re-number ids globally so refs are unambiguous across sheets
  chartCandidates.forEach((c, i) => (c.id = `candidate_${i + 1}`))
  return { sheets, chartCandidates }
}

export function analyzeSpreadsheet(filename, buffer) {
  const e = ext(filename)
  const wb =
    e === 'csv'
      ? XLSX.read(buffer.toString('utf-8'), { type: 'string', raw: true })
      : XLSX.read(buffer, { type: 'buffer' })
  return analyzeWorkbook(wb)
}

export function isSpreadsheet(filename) {
  return ['xlsx', 'xls', 'csv'].includes(ext(filename))
}

// Same deterministic candidate-building heuristic as analyzeSpreadsheet, but
// for tabular data that didn't come from an uploaded file — e.g. rows a
// Genie Space query returned mid-conversation. `rows` is an array of plain
// objects keyed by column name; ids are local (`c1`, `c2`, ...) and must be
// re-numbered by the caller into the shared `candidate_N` namespace.
export function chartCandidatesFromRows(sourceLabel, rows) {
  if (!rows?.length) return []
  const headers = Object.keys(rows[0])
  const columns = headers.map((h) => summarizeColumn(h, rows.map((r) => r[h])))
  return buildChartCandidates(sourceLabel, headers, rows, columns)
}

// Compact, LLM-facing description of chart candidates: enough to pick/narrate,
// never the raw data points a model could copy verbatim into hallucinated text.
export function describeCandidates(candidates) {
  return candidates
    .map(
      (c) =>
        `- ${c.id} (${c.chartType}): "${c.title}" — ${c.series[0]?.data.length ?? 0} categorias, ` +
        `top: ${c.series[0]?.data.slice(0, 3).map((d) => `${d.label}=${d.value}`).join(', ')}`
    )
    .join('\n')
}
