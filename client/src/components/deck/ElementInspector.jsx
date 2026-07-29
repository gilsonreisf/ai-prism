import { useMemo, useState } from 'react'
import { useT } from '../../lib/i18n.jsx'
import * as Icon from '../Icons.jsx'
import { DECK_ICONS, DECK_ICON_NAMES } from '../../../../shared/deckIcons.js'
import { CHART_KINDS } from '../../../../shared/deckLayout.js'
import { resolvePreviewTheme } from '../DeckSlidePreview.jsx'
import { findParent, typeLabel } from '../../lib/deckTree.js'

// Appearance panel for the element canvas, styled after Claude Design's
// inspector: stacked sections (Aparência, Dimensionamento, Posição, …)
// separated by hairlines, each control a rounded "pill" with the label
// inside-left and the value inside-right, segmented controls for toggles.
// Writes patches to the selected element; each control change is one undo
// step (commit: true).

const num = (v) => {
  const n = parseFloat(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

function Section({ title, children, action }) {
  return (
    <div className="px-3 py-3 space-y-1.5">
      <div className="flex items-center justify-between pb-0.5">
        <span className="text-xs font-semibold text-[var(--text)]">{title}</span>
        {action}
      </div>
      {children}
    </div>
  )
}

const Grid2 = ({ children }) => <div className="grid grid-cols-2 gap-1.5">{children}</div>

// one Claude-Design-style pill: label inside-left, control inside-right
function Pill({ label, children, title }) {
  return (
    <label
      title={title}
      className="flex items-center gap-2 h-8 rounded-lg bg-[var(--surface)] border border-[var(--border-soft)] px-2.5 min-w-0"
    >
      <span className="text-[11px] text-[var(--muted)] shrink-0">{label}</span>
      <span className="flex-1 min-w-0 flex items-center justify-end gap-1.5">{children}</span>
    </label>
  )
}

function NumInput({ value, onCommit, step = 0.05, suffix }) {
  const [draft, setDraft] = useState(null)
  return (
    <>
      <input
        type="number"
        step={step}
        value={draft ?? (value ?? '')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft != null && num(draft) != null) onCommit(num(draft))
          setDraft(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className="w-full min-w-0 bg-transparent text-right text-xs tabular-nums outline-none
                   [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      {suffix && <span className="text-[10px] text-[var(--faint)] shrink-0">{suffix}</span>}
    </>
  )
}

// theme tokens offered in the mini-palette — a token keeps the element
// re-theming with the design system; picking a hex freezes the color
const COLOR_TOKENS = ['accent', 'primary', 'secondary', 'heading', 'bodyText', 'muted', 'accentSoft', 'cardFill', 'background', 'onPrimary']

// hex OR '@token' swatch + code, Claude-Design-style ("Background  #1B3139 ▪")
function ColorControl({ value, onCommit, allowNone = false, theme }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const isToken = typeof value === 'string' && value[0] === '@'
  const hex = /^#[0-9a-fA-F]{6}$/.test(value || '') ? value.toUpperCase() : null
  const resolved = isToken ? theme?.[value.slice(1)] || '#888888' : hex
  return (
    <>
      <span className="text-xs tabular-nums text-[var(--muted)] truncate max-w-[6.5rem]" title={isToken ? t('inspector.themeToken', { token: value }) : undefined}>
        {value === 'none' ? t('inspector.colorNone') : isToken ? value : hex || t('inspector.colorAuto')}
      </span>
      {theme && (
        <span className="relative shrink-0">
          <button
            onClick={() => setOpen((o) => !o)}
            className="w-5 h-5 rounded border border-[var(--border)] grid place-items-center text-[9px] text-[var(--faint)] hover:text-[var(--text)] hover:border-[var(--accent)]"
            title={t('inspector.themeColorsTitle')}
          >
            @
          </button>
          {open && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
              <div className="absolute z-20 bottom-full right-0 mb-1 w-44 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl shadow-black/40 p-1.5 grid grid-cols-5 gap-1">
                {COLOR_TOKENS.map((t) => (
                  <button
                    key={t}
                    title={`@${t}`}
                    onClick={() => {
                      onCommit(`@${t}`)
                      setOpen(false)
                    }}
                    className={`aspect-square rounded-md border ${value === `@${t}` ? 'border-[var(--accent)]' : 'border-[var(--border)]'}`}
                    style={{ background: theme[t] || '#888' }}
                  />
                ))}
              </div>
            </>
          )}
        </span>
      )}
      <span className="relative w-5 h-5 rounded border border-[var(--border)] overflow-hidden shrink-0" style={{ background: resolved || 'transparent' }}>
        {!resolved && <span className="absolute inset-0 grid place-items-center text-[10px] text-[var(--faint)]">∅</span>}
        <input
          type="color"
          value={resolved || '#888888'}
          onChange={(e) => onCommit(e.target.value.toUpperCase())}
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
      </span>
      {allowNone && (
        <button
          onClick={() => onCommit('none')}
          className={`shrink-0 px-1.5 h-5 rounded text-[10px] border ${value === 'none' ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--border)] text-[var(--faint)] hover:text-[var(--text)]'}`}
          title={t('inspector.noFill')}
        >
          ∅
        </button>
      )}
    </>
  )
}

// segmented control (Hug/Fixed/Fill-style): equal-width options, active one lit
function Segmented({ options, value, onChange }) {
  return (
    <div className="flex rounded-lg bg-[var(--surface)] border border-[var(--border-soft)] p-0.5 gap-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          title={o.title}
          className={`flex-1 min-w-0 h-6 rounded-md text-[11px] grid place-items-center transition ${
            value === o.value ? 'bg-[var(--surface-3)] text-[var(--text)] font-semibold' : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
          style={o.css}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const bareSelect =
  'w-full min-w-0 bg-transparent text-right text-xs outline-none cursor-pointer appearance-none pr-0.5'

export function IconGlyph({ name, size = 18, className = '' }) {
  const paths = DECK_ICONS[name]
  if (!paths) return null
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  )
}

// searchable visual gallery of the 200+ builtin pictograms — replaces the
// old name-only <select> (nobody knows what "waypoints" looks like)
export function IconGallery({ value, onPick }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const names = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? DECK_ICON_NAMES.filter((n) => n.includes(q)) : DECK_ICON_NAMES
  }, [query])
  return (
    <div className="relative min-w-0 flex-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 h-8 rounded-lg bg-[var(--surface)] border border-[var(--border-soft)] px-2.5 hover:border-[var(--accent)] transition"
      >
        {value ? <IconGlyph name={value} size={16} className="shrink-0 text-[var(--accent)]" /> : null}
        <span className="flex-1 text-left text-xs truncate">{value || t('inspector.choosePictogram')}</span>
        <Icon.ChevronRight size={12} className={`shrink-0 text-[var(--faint)] transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 bottom-full left-0 right-0 mb-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl shadow-black/40 p-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('inspector.searchIcon')}
              className="w-full mb-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
            />
            <div className="grid grid-cols-8 gap-1 max-h-48 overflow-y-auto">
              {names.map((n) => (
                <button
                  key={n}
                  title={n}
                  onClick={() => {
                    onPick(n)
                    setOpen(false)
                  }}
                  className={`aspect-square rounded-md grid place-items-center border transition ${
                    n === value
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-transparent text-[var(--muted)] hover:border-[var(--border)] hover:text-[var(--text)]'
                  }`}
                >
                  <IconGlyph name={n} size={16} />
                </button>
              ))}
              {names.length === 0 && (
                <p className="col-span-8 text-center text-[11px] text-[var(--faint)] py-3">{t('inspector.nothingFound')}</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// --- chart data editors: compact pipe-separated text formats ----------------

const numLoose = (v) => {
  const n = parseFloat(String(v ?? '').trim().replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const splitPipes = (line) => line.split('|').map((s) => s.trim())

const catToText = (series = []) => {
  const head = series.map((s) => s.name).join(' | ')
  const cats = series[0]?.data || []
  return [head, ...cats.map((d, i) => [d.label, ...series.map((s) => s.data?.[i]?.value ?? '')].join(' | '))].join('\n')
}
const textToCat = (text) => {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return null
  const names = splitPipes(lines[0]).filter(Boolean)
  if (!names.length) return null
  const series = names.map((name) => ({ name, data: [] }))
  for (const line of lines.slice(1)) {
    const cells = splitPipes(line)
    names.forEach((_, i) => series[i].data.push({ label: cells[0] || '', value: numLoose(cells[i + 1]) ?? 0 }))
  }
  return series
}

const scatterToText = (series = []) => (series[0]?.points || []).map((p) => `${p.x}, ${p.y}`).join('\n')
const textToScatter = (text, name = 'Série') => {
  const points = text
    .split('\n')
    .map((l) => l.split(/[,;|]/).map(numLoose))
    .filter((c) => c[0] != null && c[1] != null)
    .map(([x, y]) => ({ x, y }))
  return points.length ? [{ name, points }] : null
}

const heatmapToText = (hm = {}) =>
  [
    (hm.xLabels || []).join(' | '),
    ...(hm.yLabels || []).map((yl, r) => [yl, ...((hm.values || [])[r] || [])].join(' | ')),
  ].join('\n')
const textToHeatmap = (text) => {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return null
  const xLabels = splitPipes(lines[0]).filter(Boolean)
  const yLabels = []
  const values = []
  for (const line of lines.slice(1)) {
    const cells = splitPipes(line)
    yLabels.push(cells[0] || '')
    values.push(xLabels.map((_, c) => numLoose(cells[c + 1]) ?? 0))
  }
  return xLabels.length && yLabels.length ? { xLabels, yLabels, values } : null
}

const ganttToText = (g = {}) =>
  (g.tasks || []).map((t) => [t.label, t.start, t.end, ...(t.milestone ? ['marco'] : [])].join(' | ')).join('\n')
const textToGantt = (text, axis) => {
  const tasks = text
    .split('\n')
    .map((l) => splitPipes(l))
    .filter((c) => c[0] && numLoose(c[1]) != null)
    .map((c) => ({
      label: c[0],
      start: numLoose(c[1]),
      end: numLoose(c[2]) ?? numLoose(c[1]),
      ...(String(c[3] || '').toLowerCase().startsWith('m') ? { milestone: true } : {}),
    }))
  if (!tasks.length) return null
  return { tasks, ...(axis?.length ? { axis } : {}) }
}

const CHART_KIND_LABEL_KEYS = {
  bar: 'inspector.chartKind.bar', barH: 'inspector.chartKind.barH', line: 'inspector.chartKind.line', area: 'inspector.chartKind.area',
  pie: 'inspector.chartKind.pie', doughnut: 'inspector.chartKind.doughnut', scatter: 'inspector.chartKind.scatter', heatmap: 'inspector.chartKind.heatmap', gantt: 'inspector.chartKind.gantt',
}
const DEFAULT_SERIES = [{ name: 'Série 1', data: [{ label: 'A', value: 4 }, { label: 'B', value: 7 }, { label: 'C', value: 5 }] }]

function DataTextarea({ value, onCommit, rows = 5, hint }) {
  const [draft, setDraft] = useState(null)
  return (
    <div className="space-y-1">
      <textarea
        value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft != null) onCommit(draft)
          setDraft(null)
        }}
        rows={rows}
        spellCheck={false}
        className="w-full font-mono text-[10.5px] leading-relaxed rounded-lg bg-[var(--surface)] border border-[var(--border-soft)] px-2 py-1.5 outline-none focus:border-[var(--accent)] resize-y"
      />
      {hint && <p className="text-[9.5px] text-[var(--faint)] leading-snug">{hint}</p>}
    </div>
  )
}

function ChartSection({ element, onPatch }) {
  const t = useT()
  const c = element.chart || {}
  const patchChart = (patch) => onPatch({ chart: { ...c, ...patch } })
  const setKind = (kind) => {
    const next = { ...c, kind }
    // seed compatible data when switching families
    if (kind === 'heatmap') {
      if (!next.heatmap) next.heatmap = { xLabels: ['T1', 'T2'], yLabels: ['A', 'B'], values: [[1, 2], [3, 4]] }
    } else if (kind === 'gantt') {
      if (!next.gantt) next.gantt = { tasks: [{ label: 'Fase 1', start: 0, end: 2 }, { label: 'Fase 2', start: 2, end: 4 }], axis: ['M1', 'M2', 'M3', 'M4'] }
    } else if (kind === 'scatter') {
      if (!next.series?.[0]?.points) next.series = [{ name: 'Série', points: [{ x: 1, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 2.5 }] }]
    } else if (!next.series?.[0]?.data) {
      next.series = DEFAULT_SERIES
    }
    onPatch({ chart: next })
  }
  return (
    <Section title={t('inspector.section.chart')}>
      <Pill label={t('inspector.chartType')}>
        <select value={c.kind || 'bar'} onChange={(e) => setKind(e.target.value)} className={bareSelect}>
          {CHART_KINDS.map((k) => (
            <option key={k} value={k}>
              {CHART_KIND_LABEL_KEYS[k] ? t(CHART_KIND_LABEL_KEYS[k]) : k}
            </option>
          ))}
        </select>
      </Pill>
      {c.kind === 'heatmap' ? (
        <DataTextarea
          value={heatmapToText(c.heatmap)}
          onCommit={(text) => {
            const heatmap = textToHeatmap(text)
            if (heatmap) patchChart({ heatmap })
          }}
          hint={t('inspector.hint.heatmap')}
        />
      ) : c.kind === 'gantt' ? (
        <>
          <DataTextarea
            value={ganttToText(c.gantt)}
            onCommit={(text) => {
              const gantt = textToGantt(text, c.gantt?.axis)
              if (gantt) patchChart({ gantt })
            }}
            hint={t('inspector.hint.gantt')}
          />
          <Pill label={t('inspector.axis')}>
            <input
              defaultValue={(c.gantt?.axis || []).join(', ')}
              onBlur={(e) => {
                const axis = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                patchChart({ gantt: { ...(c.gantt || { tasks: [] }), axis } })
              }}
              placeholder="M1, M2, M3…"
              className="w-full min-w-0 bg-transparent text-right text-xs outline-none placeholder:text-[var(--faint)]"
            />
          </Pill>
        </>
      ) : c.kind === 'scatter' ? (
        <DataTextarea
          value={scatterToText(c.series)}
          onCommit={(text) => {
            const series = textToScatter(text, c.series?.[0]?.name)
            if (series) patchChart({ series })
          }}
          hint={t('inspector.hint.scatter')}
        />
      ) : (
        <DataTextarea
          value={catToText(c.series)}
          onCommit={(text) => {
            const series = textToCat(text)
            if (series) patchChart({ series })
          }}
          hint={t('inspector.hint.category')}
        />
      )}
      <Grid2>
        <Pill label={t('inspector.legend')}>
          <input
            type="checkbox"
            checked={c.showLegend !== false}
            onChange={(e) => patchChart({ showLegend: e.target.checked ? undefined : false })}
            className="accent-[var(--accent)]"
          />
        </Pill>
        {c.kind !== 'heatmap' && c.kind !== 'gantt' && (
          <Pill label={t('inspector.values')}>
            <input
              type="checkbox"
              checked={!!c.showValues}
              onChange={(e) => patchChart({ showValues: e.target.checked || undefined })}
              className="accent-[var(--accent)]"
            />
          </Pill>
        )}
      </Grid2>
    </Section>
  )
}

// compact panel for multi-selection (rendered by the Studio in place of the
// single-element inspector): count + group/delete, plus align/distribute and
// batch-styling (fill/text color applied to every selected node at once).
export function MultiSelectPanel({ count, onGroup, onRemove, onAlign, onDistribute, onBatchStyle, theme }) {
  const t = useT()
  const alignBtns = [
    ['left', '⇤', t('inspector.alignLeftEdge')],
    ['hcenter', '⇔', t('inspector.alignHCenter')],
    ['right', '⇥', t('inspector.alignRightEdge')],
    ['top', '⤒', t('inspector.alignTopEdge')],
    ['vcenter', '⇳', t('inspector.alignVCenter')],
    ['bottom', '⤓', t('inspector.alignBottomEdge')],
  ]
  const btn = 'flex-1 min-w-0 h-7 rounded-md grid place-items-center text-[13px] text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--surface-3)] transition'
  return (
    <div className="divide-y divide-[var(--border-soft)]">
      <div className="flex items-center gap-2 px-3 py-2.5 text-sm">
        <span className="text-xs font-bold flex-1">{t('inspector.selectedCount', { n: count })}</span>
        <button
          onClick={onGroup}
          className="flex items-center gap-1 rounded-lg bg-[var(--surface-3)] hover:brightness-110 text-[11px] font-semibold px-2 py-1.5"
          title={t('inspector.groupSelection')}
        >
          ▣ {t('inspector.group')}
        </button>
        <button onClick={onRemove} className="w-7 h-7 rounded-md grid place-items-center hover:bg-[var(--surface-3)] text-[var(--muted)]" title={t('inspector.deleteSelection')}>
          <Icon.Trash size={13} />
        </button>
      </div>
      <Section title={t('inspector.align')}>
        <div className="flex rounded-lg bg-[var(--surface)] border border-[var(--border-soft)] p-0.5 gap-0.5">
          {alignBtns.map(([edge, glyph, title]) => (
            <button key={edge} className={btn} title={title} onClick={() => onAlign?.(edge)}>
              {glyph}
            </button>
          ))}
        </div>
        <Grid2>
          <button className="h-7 rounded-md bg-[var(--surface)] border border-[var(--border-soft)] text-[11px] text-[var(--muted)] hover:text-[var(--text)]" title={t('inspector.distributeH')} onClick={() => onDistribute?.('x')}>
            ⇿ {t('inspector.distribute')}
          </button>
          <button className="h-7 rounded-md bg-[var(--surface)] border border-[var(--border-soft)] text-[11px] text-[var(--muted)] hover:text-[var(--text)]" title={t('inspector.distributeV')} onClick={() => onDistribute?.('y')}>
            ⇕ {t('inspector.distribute')}
          </button>
        </Grid2>
      </Section>
      <Section title={t('inspector.batchStyle')}>
        <Pill label={t('inspector.batchFill')}>
          <ColorControl value={undefined} onCommit={(v) => onBatchStyle?.({ fill: v })} allowNone theme={theme} />
        </Pill>
        <Pill label={t('inspector.batchText')}>
          <ColorControl value={undefined} onCommit={(v) => onBatchStyle?.({ color: v })} theme={theme} />
        </Pill>
        <p className="text-[9.5px] text-[var(--faint)] leading-snug">{t('inspector.batchHint')}</p>
      </Section>
    </div>
  )
}

export default function ElementInspector({ element, elements, template, onPatch, onPatchStyle, onPatchParent, onReorder, onRemove, onUngroup }) {
  const t = useT()
  if (!element) return null
  const st = element.style || {}
  const b = element.box || {}
  const theme = resolvePreviewTheme(template)
  const { parent, index: zIndex } = findParent(elements, element.id)
  const siblings = parent ? parent.children || [] : elements
  const stackChild = !!parent?.stack
  const isGroup = element.type === 'group'

  return (
    <div className="divide-y divide-[var(--border-soft)] text-sm">
      {/* header: name + visibility + layer + delete */}
      <div className="flex items-center gap-1.5 px-3 py-2.5">
        <input
          value={element.name || ''}
          placeholder={typeLabel(element.type)}
          onChange={(e) => onPatch({ name: e.target.value.slice(0, 60) || undefined }, false)}
          onBlur={(e) => onPatch({ name: e.target.value.trim().slice(0, 60) || undefined })}
          className="flex-1 min-w-0 text-xs font-bold bg-transparent outline-none border-b border-transparent focus:border-[var(--accent)] placeholder:text-[var(--text)] placeholder:font-bold"
          title={t('inspector.layerNameTitle')}
        />
        <button
          onClick={() => onPatch({ hidden: element.hidden ? undefined : true })}
          className={`w-6 h-6 rounded-md grid place-items-center hover:bg-[var(--surface-3)] ${element.hidden ? 'text-[var(--accent)]' : 'text-[var(--muted)]'}`}
          title={element.hidden ? t('inspector.showElement') : t('inspector.hideElement')}
        >
          <Icon.Eye size={13} />
        </button>
        <span className="text-[10px] text-[var(--faint)] tabular-nums">
          {t('inspector.layerN', { n: zIndex + 1, total: siblings.length })}
        </span>
        <button onClick={() => onReorder(-1)} className="w-6 h-6 rounded-md bg-[var(--surface)] border border-[var(--border-soft)] text-[11px] hover:text-[var(--text)] text-[var(--muted)]" title={t('inspector.sendBackward')}>
          ↓
        </button>
        <button onClick={() => onReorder(1)} className="w-6 h-6 rounded-md bg-[var(--surface)] border border-[var(--border-soft)] text-[11px] hover:text-[var(--text)] text-[var(--muted)]" title={t('inspector.bringForward')}>
          ↑
        </button>
        <button onClick={onRemove} className="w-6 h-6 rounded-md grid place-items-center hover:bg-[var(--surface-3)] text-[var(--muted)]" title={t('inspector.deleteElement')}>
          <Icon.Trash size={13} />
        </button>
      </div>

      <Section title={t('inspector.section.appearance')}>
        {element.type !== 'line' && (
          <Pill label={t('inspector.fill')}>
            <ColorControl value={st.fill} onCommit={(v) => onPatchStyle({ fill: v })} allowNone theme={theme} />
          </Pill>
        )}
        <Grid2>
          {element.type !== 'line' && (
            <Pill label={t('inspector.radius')}>
              <NumInput value={st.radius ?? 0} onCommit={(v) => onPatchStyle({ radius: v || undefined })} suffix={t('inspector.unit.in')} />
            </Pill>
          )}
          <Pill label={t('inspector.rotation')}>
            <NumInput value={element.rotate || 0} step={1} onCommit={(v) => onPatch({ rotate: Math.round(v) || undefined })} suffix="°" />
          </Pill>
        </Grid2>
        <Pill label={t('inspector.opacity')}>
          <input
            type="range"
            min="0"
            max="100"
            value={st.opacity ?? 100}
            onChange={(e) => onPatchStyle({ opacity: Number(e.target.value) }, false)}
            onMouseUp={(e) => onPatchStyle({ opacity: Number(e.currentTarget.value) })}
            className="flex-1 min-w-0 accent-[var(--accent)]"
          />
          <span className="text-xs tabular-nums w-7 text-right text-[var(--muted)]">{st.opacity ?? 100}</span>
        </Pill>
        {element.type === 'text' && (
          <Pill label={t('inspector.overflow')} title={t('inspector.overflowTitle')}>
            <select
              value={st.overflow || 'visible'}
              onChange={(e) => onPatchStyle({ overflow: e.target.value === 'visible' ? undefined : e.target.value })}
              className={bareSelect}
            >
              <option value="visible">{t('inspector.overflowVisible')}</option>
              <option value="hidden">{t('inspector.overflowHidden')}</option>
            </select>
          </Pill>
        )}
      </Section>

      {isGroup && (
        <Section
          title={t('inspector.section.autoLayout')}
          action={
            <div className="flex items-center gap-2">
              <button onClick={onUngroup} className="text-[10px] text-[var(--faint)] underline hover:text-[var(--text)]" title={t('inspector.ungroupTitle')}>
                {t('inspector.ungroup')}
              </button>
              <button
                onClick={() => onPatch({ stack: element.stack ? undefined : { direction: 'column', gap: 0.15, padding: 0.2 } })}
                className={`w-8 h-[18px] rounded-full transition relative ${element.stack ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`}
                title={element.stack ? t('inspector.autoLayoutOff') : t('inspector.autoLayoutOn')}
              >
                <span className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${element.stack ? 'translate-x-[14px]' : ''}`} />
              </button>
            </div>
          }
        >
          {element.stack && (
            <>
              <Segmented
                options={[
                  { value: 'column', label: t('inspector.stackColumn'), title: t('inspector.stackColumnTitle') },
                  { value: 'row', label: t('inspector.stackRow'), title: t('inspector.stackRowTitle') },
                ]}
                value={element.stack.direction || 'column'}
                onChange={(direction) => onPatch({ stack: { ...element.stack, direction } })}
              />
              <Grid2>
                <Pill label={t('inspector.gap')}>
                  <NumInput value={element.stack.gap ?? 0.15} onCommit={(v) => onPatch({ stack: { ...element.stack, gap: Math.max(v, 0) } })} suffix={t('inspector.unit.in')} />
                </Pill>
                <Pill label={t('inspector.padding')}>
                  <NumInput value={element.stack.padding ?? 0} onCommit={(v) => onPatch({ stack: { ...element.stack, padding: Math.max(v, 0) || undefined } })} suffix={t('inspector.unit.in')} />
                </Pill>
              </Grid2>
              <Grid2>
                <Pill label={t('inspector.align')}>
                  <select
                    value={element.stack.align || 'stretch'}
                    onChange={(e) => onPatch({ stack: { ...element.stack, align: e.target.value === 'stretch' ? undefined : e.target.value } })}
                    className={bareSelect}
                  >
                    <option value="stretch">{t('inspector.alignStretch')}</option>
                    <option value="start">{t('inspector.alignStart')}</option>
                    <option value="center">{t('inspector.alignCenter')}</option>
                    <option value="end">{t('inspector.alignEnd')}</option>
                  </select>
                </Pill>
                <Pill label={t('inspector.justify')}>
                  <select
                    value={element.stack.justify || 'start'}
                    onChange={(e) => onPatch({ stack: { ...element.stack, justify: e.target.value === 'start' ? undefined : e.target.value } })}
                    className={bareSelect}
                  >
                    <option value="start">{t('inspector.justifyStart')}</option>
                    <option value="center">{t('inspector.justifyCenter')}</option>
                    <option value="end">{t('inspector.justifyEnd')}</option>
                    <option value="between">{t('inspector.justifyBetween')}</option>
                  </select>
                </Pill>
              </Grid2>
            </>
          )}
          {!element.stack && (
            <p className="text-[10px] text-[var(--faint)] leading-snug">
              {t('inspector.freePositionsHint')}
            </p>
          )}
        </Section>
      )}

      {element.type === 'chart' && <ChartSection element={element} onPatch={onPatch} />}

      <Section title={t('inspector.section.positionSize')}>
        {stackChild && (
          <p className="text-[10px] text-[var(--faint)] leading-snug pb-1">
            {t('inspector.stackChildHint')}
            {onPatchParent && (
              <>
                {' '}{t('inspector.stackChildHintMove')}{' '}
                <button
                  onClick={() => onPatchParent({ stack: undefined })}
                  className="text-[var(--accent)] underline hover:brightness-110"
                  title={t('inspector.turnOffGroupAutoLayoutTitle')}
                >
                  {t('inspector.turnOffGroupAutoLayout')}
                </button>
                .
              </>
            )}
          </p>
        )}
        <Grid2>
          {!stackChild && (
            <>
              <Pill label={t('inspector.posX')}>
                <NumInput value={b.x} onCommit={(v) => onPatch({ box: { ...b, x: v } })} suffix={t('inspector.unit.in')} />
              </Pill>
              <Pill label={t('inspector.posY')}>
                <NumInput value={b.y} onCommit={(v) => onPatch({ box: { ...b, y: v } })} suffix={t('inspector.unit.in')} />
              </Pill>
            </>
          )}
          <Pill label={t('inspector.width')}>
            <NumInput value={b.w} onCommit={(v) => onPatch({ box: { ...b, w: Math.max(v, 0.02) } })} suffix={t('inspector.unit.in')} />
          </Pill>
          <Pill label={t('inspector.height')}>
            <NumInput value={b.h} onCommit={(v) => onPatch({ box: { ...b, h: Math.max(v, element.type === 'line' ? 0 : 0.02) } })} suffix={t('inspector.unit.in')} />
          </Pill>
          {stackChild && (
            <Pill label={t('inspector.grow')} title={t('inspector.growTitle')}>
              <NumInput value={element.grow ?? 0} step={1} onCommit={(v) => onPatch({ grow: Math.max(v, 0) || undefined })} />
            </Pill>
          )}
        </Grid2>
      </Section>

      {element.type !== 'line' && (
        <Section
          title={t('inspector.section.border')}
          action={
            st.borderColor ? (
              <button
                onClick={() => onPatchStyle({ borderColor: undefined, borderWidth: undefined, borderDash: undefined })}
                className="text-[10px] text-[var(--faint)] underline hover:text-[var(--text)]"
              >
                {t('inspector.remove')}
              </button>
            ) : null
          }
        >
          <Pill label={t('inspector.color')}>
            <ColorControl value={st.borderColor} onCommit={(v) => onPatchStyle({ borderColor: v })} theme={theme} />
          </Pill>
          {st.borderColor && (
            <Grid2>
              <Pill label={t('inspector.thickness')}>
                <NumInput value={st.borderWidth ?? 1} step={0.25} onCommit={(v) => onPatchStyle({ borderWidth: v })} suffix={t('inspector.unit.pt')} />
              </Pill>
              <Pill label={t('inspector.dash')}>
                <select
                  value={st.borderDash || 'solid'}
                  onChange={(e) => onPatchStyle({ borderDash: e.target.value === 'solid' ? undefined : e.target.value })}
                  className={bareSelect}
                >
                  <option value="solid">{t('inspector.dashSolid')}</option>
                  <option value="dash">{t('inspector.dashDashed')}</option>
                  <option value="dot">{t('inspector.dashDotted')}</option>
                </select>
              </Pill>
            </Grid2>
          )}
        </Section>
      )}

      {element.type !== 'line' && (
        <Section
          title={t('inspector.section.shadow')}
          action={
            <button
              onClick={() => onPatchStyle({ shadow: st.shadow ? undefined : { blur: 6, offset: 2, opacity: 35 } })}
              className={`w-8 h-[18px] rounded-full transition relative ${st.shadow ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`}
              title={st.shadow ? t('inspector.shadowRemove') : t('inspector.shadowAdd')}
            >
              <span className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${st.shadow ? 'translate-x-[14px]' : ''}`} />
            </button>
          }
        >
          {st.shadow && typeof st.shadow === 'object' && (
            <Grid2>
              <Pill label={t('inspector.blur')}>
                <NumInput value={st.shadow.blur ?? 6} step={1} onCommit={(v) => onPatchStyle({ shadow: { ...st.shadow, blur: v } })} suffix={t('inspector.unit.pt')} />
              </Pill>
              <Pill label={t('inspector.distance')}>
                <NumInput value={st.shadow.offset ?? 2} step={1} onCommit={(v) => onPatchStyle({ shadow: { ...st.shadow, offset: v } })} suffix={t('inspector.unit.pt')} />
              </Pill>
            </Grid2>
          )}
        </Section>
      )}

      {element.type === 'text' && (
        <Section title={t('inspector.section.text')}>
          <Grid2>
            <Pill label={t('inspector.font')}>
              <select value={st.fontRole || 'body'} onChange={(e) => onPatchStyle({ fontRole: e.target.value })} className={bareSelect}>
                <option value="heading">{t('inspector.fontHeading')}</option>
                <option value="body">{t('inspector.fontBody')}</option>
              </select>
            </Pill>
            <Pill label={t('inspector.fontSize')}>
              <NumInput value={st.fontSize ?? 13} step={0.5} onCommit={(v) => onPatchStyle({ fontSize: v })} suffix={t('inspector.unit.pt')} />
            </Pill>
          </Grid2>
          <Pill label={t('inspector.color')}>
            <ColorControl value={st.color} onCommit={(v) => onPatchStyle({ color: v })} theme={theme} />
          </Pill>
          {/* independent style toggles (not mutually exclusive) */}
          <div className="flex rounded-lg bg-[var(--surface)] border border-[var(--border-soft)] p-0.5 gap-0.5">
            {[
              ['bold', 'B', t('inspector.bold'), { fontWeight: 700 }],
              ['italic', 'I', t('inspector.italic'), { fontStyle: 'italic' }],
              ['underline', 'S', t('inspector.underline'), { textDecoration: 'underline' }],
              ['uppercase', 'AA', t('inspector.uppercase'), {}],
              ['bullet', '••', t('inspector.bulletList'), {}],
            ].map(([key, label, title, css]) => (
              <button
                key={key}
                onClick={() => onPatchStyle({ [key]: st[key] ? undefined : true })}
                title={title}
                style={css}
                className={`flex-1 min-w-0 h-6 rounded-md text-[11px] grid place-items-center transition ${
                  st[key] ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-semibold' : 'text-[var(--muted)] hover:text-[var(--text)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <Grid2>
            <Segmented
              options={[
                { value: 'left', label: '⟸', title: t('inspector.alignLeft') },
                { value: 'center', label: '≡', title: t('inspector.alignCenterText') },
                { value: 'right', label: '⟹', title: t('inspector.alignRight') },
              ]}
              value={st.align || 'left'}
              onChange={(a) => onPatchStyle({ align: a === 'left' ? undefined : a })}
            />
            <Pill label={t('inspector.vertical')}>
              <select
                value={st.valign || 'top'}
                onChange={(e) => onPatchStyle({ valign: e.target.value === 'top' ? undefined : e.target.value })}
                className={bareSelect}
              >
                <option value="top">{t('inspector.valignTop')}</option>
                <option value="middle">{t('inspector.valignMiddle')}</option>
                <option value="bottom">{t('inspector.valignBottom')}</option>
              </select>
            </Pill>
          </Grid2>
          <Grid2>
            <Pill label={t('inspector.lineHeight')}>
              <NumInput value={st.lineHeight ?? 1.2} step={0.05} onCommit={(v) => onPatchStyle({ lineHeight: v })} />
            </Pill>
            <Pill label={t('inspector.tracking')}>
              <NumInput value={st.letterSpacing ?? 0} step={0.1} onCommit={(v) => onPatchStyle({ letterSpacing: v || undefined })} suffix={t('inspector.unit.pt')} />
            </Pill>
          </Grid2>
        </Section>
      )}

      {element.type === 'line' && (
        <Section title={t('inspector.section.line')}>
          <Pill label={t('inspector.color')}>
            <ColorControl value={st.lineColor} onCommit={(v) => onPatchStyle({ lineColor: v })} theme={theme} />
          </Pill>
          <Grid2>
            <Pill label={t('inspector.thickness')}>
              <NumInput value={st.lineWidth ?? 2} step={0.25} onCommit={(v) => onPatchStyle({ lineWidth: v })} suffix={t('inspector.unit.pt')} />
            </Pill>
            <Pill label={t('inspector.dash')}>
              <select value={st.dash || 'solid'} onChange={(e) => onPatchStyle({ dash: e.target.value === 'solid' ? undefined : e.target.value })} className={bareSelect}>
                <option value="solid">{t('inspector.dashSolid')}</option>
                <option value="dash">{t('inspector.dashDashed')}</option>
                <option value="dot">{t('inspector.dashDotted')}</option>
              </select>
            </Pill>
          </Grid2>
          <Grid2>
            <Pill label={t('inspector.arrowStart')}>
              <input type="checkbox" checked={!!st.arrowStart} onChange={(e) => onPatchStyle({ arrowStart: e.target.checked || undefined })} className="accent-[var(--accent)]" />
            </Pill>
            <Pill label={t('inspector.arrowEnd')}>
              <input type="checkbox" checked={!!st.arrowEnd} onChange={(e) => onPatchStyle({ arrowEnd: e.target.checked || undefined })} className="accent-[var(--accent)]" />
            </Pill>
          </Grid2>
        </Section>
      )}

      {element.type === 'icon' && (
        <Section title={t('inspector.section.icon')}>
          <Pill label={t('inspector.color')}>
            <ColorControl value={st.color} onCommit={(v) => onPatchStyle({ color: v })} theme={theme} />
          </Pill>
          <div className="flex">
            <IconGallery value={element.icon?.builtin || ''} onPick={(n) => onPatch({ icon: { builtin: n || undefined } })} />
          </div>
        </Section>
      )}
    </div>
  )
}
