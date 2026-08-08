import { useMemo, useState } from 'react'
import { useT } from '../../lib/i18n.jsx'
import * as Icon from '../Icons.jsx'

// Properties panel + DOM layer tree for a pure-HTML slide (task #28). This is
// the Claude-Design "Edit" surface: a nested, selectable tree of the slide's
// real DOM nodes on top, and a properties panel below that edits the SELECTED
// node's inline style / text. The DOM is the model — there's no separate
// semantic tree. Selection is a child-index path string (e.g. "1.0.2"), the
// exact scheme HtmlSlideEditor's in-iframe runtime uses, so the tree, the canvas
// ring and the panel all address the same node.
//
// Style edits are pushed to the iframe imperatively (editorRef.applyStyle); the
// live `info` snapshot the iframe sends back on every select drives the shown
// values, so the panel always reflects the true computed look.

// rgb()/rgba() → #rrggbb for the color inputs (which only accept hex).
function toHex(c) {
  if (!c) return '#000000'
  if (c.startsWith('#')) return c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(c)
  if (!m) return '#000000'
  return '#' + [m[1], m[2], m[3]].map((v) => Math.round(parseFloat(v)).toString(16).padStart(2, '0')).join('')
}
// is a computed background actually painted? (transparent/none reads as unset)
function hasBg(c) {
  if (!c || c === 'transparent' || c === 'none') return false
  const m = /rgba?\([^)]*?,\s*([\d.]+)\)/.exec(c)
  return !(m && parseFloat(m[1]) === 0)
}

// ---- DOM layer tree ---------------------------------------------------------
// Parse the <section> HTML into a lightweight node tree carrying each node's
// child-index path + a readable label. We DON'T render the DOM here — just the
// structure — so this stays cheap and re-parses only when the HTML changes.
const TAG_LABEL = {
  section: 'Slide',
  h1: 'Título',
  h2: 'Título',
  h3: 'Subtítulo',
  h4: 'Subtítulo',
  p: 'Texto',
  span: 'Texto',
  ul: 'Lista',
  ol: 'Lista',
  li: 'Item',
  svg: 'Gráfico',
  img: 'Imagem',
  table: 'Tabela',
  tr: 'Linha',
  td: 'Célula',
  th: 'Célula',
}
function labelFor(el) {
  const tag = el.tagName.toLowerCase()
  const base = TAG_LABEL[tag]
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ')
  if ((tag === 'div' || tag === 'section') && !base) {
    // a container div → name it by its role hint if any, else "Bloco"
    const cls = el.getAttribute('class') || ''
    if (/card/i.test(cls)) return 'Card'
    if (/grid|row|col|flex/i.test(cls)) return 'Grupo'
    return 'Bloco'
  }
  if (base && text && text.length <= 42 && /^(h1|h2|h3|h4|p|span|li|td|th)$/.test(tag)) {
    return `${base} · ${text.slice(0, 34)}${text.length > 34 ? '…' : ''}`
  }
  return base || tag
}
function buildTree(html) {
  if (!html) return null
  let doc
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }
  const root = doc.body.firstElementChild
  if (!root) return null
  const walk = (el, path) => {
    const children = []
    let i = 0
    for (const c of el.children) {
      children.push(walk(c, path === '' ? String(i) : `${path}.${i}`))
      i++
    }
    const tag = el.tagName.toLowerCase()
    // don't descend into leaf-ish tags whose children are just glyphs
    const isLeaf = children.length === 0
    return { tag, path, label: labelFor(el), children, isLeaf, hasText: !!(el.textContent || '').trim() }
  }
  return walk(root, '')
}

function TreeRow({ node, depth, selectedPath, onSelect, expanded, toggle }) {
  const isSel = node.path === selectedPath
  const hasKids = node.children.length > 0
  const isOpen = expanded.has(node.path)
  return (
    <div>
      <div
        onClick={() => onSelect(node.path)}
        className={`group/row flex items-center gap-1.5 h-7 rounded-md pr-1.5 cursor-pointer select-none transition-colors ${
          isSel ? 'bg-[var(--accent-soft)] text-[var(--text)]' : 'text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]'
        }`}
        style={{ paddingLeft: `${8 + depth * 13}px` }}
      >
        {hasKids ? (
          <button
            onClick={(e) => {
              e.stopPropagation()
              toggle(node.path)
            }}
            className="shrink-0 w-4 h-4 grid place-items-center text-[var(--faint)] hover:text-[var(--text)]"
          >
            <Icon.ChevronRight size={10} className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <span className="shrink-0 w-4" />
        )}
        <span className="flex-1 min-w-0 truncate text-[11px]" title={node.label}>
          {node.label}
        </span>
        <span className="shrink-0 text-[9px] text-[var(--faint)] font-mono hidden lg:block">{node.tag}</span>
      </div>
      {hasKids && isOpen && (
        <div>
          {node.children.map((c) => (
            <TreeRow key={c.path} node={c} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} expanded={expanded} toggle={toggle} />
          ))}
        </div>
      )}
    </div>
  )
}

// A compact labeled control row in the properties panel.
function Field({ label, children, dot }) {
  return (
    <div className="flex items-center gap-2 h-8">
      <label className="text-[11px] text-[var(--muted)] w-[4.5rem] shrink-0 flex items-center gap-1">
        {dot && <span className="w-1 h-1 rounded-full bg-[var(--accent)] shrink-0" title="Definido neste elemento" />}
        {label}
      </label>
      <div className="flex-1 flex items-center gap-1.5 min-w-0">{children}</div>
    </div>
  )
}

const inputCls =
  'min-w-0 text-[12px] rounded-md bg-[var(--surface)] border border-[var(--border)] px-2 py-1 outline-none focus:border-[var(--accent)]'

export default function HtmlSlideInspector({ html, selectedPath, selectedInfo, onSelectPath, onStyle, onText }) {
  const t = useT()
  const tree = useMemo(() => buildTree(html), [html])
  const [expanded, setExpanded] = useState(() => new Set(['', '0', '1']))
  const toggle = (p) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(p) ? next.delete(p) : next.add(p)
      return next
    })

  const info = selectedInfo
  const c = info?.computed || {}
  const inl = info?.inline || {}
  const isBold = parseInt(c.fontWeight, 10) >= 600
  const set = (style) => onStyle?.(style)

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* DOM layer tree */}
      <div className="shrink-0 border-b border-[var(--border)]">
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
          <span className="text-xs font-semibold">{t('deckStudio.htmlEdit.layers')}</span>
          <span className="text-[9.5px] text-[var(--faint)]">{t('deckStudio.htmlEdit.layersHint')}</span>
        </div>
        <div className="max-h-52 overflow-y-auto px-1.5 pb-1.5">
          {tree ? (
            <TreeRow node={tree} depth={0} selectedPath={selectedPath} onSelect={onSelectPath} expanded={expanded} toggle={toggle} />
          ) : (
            <p className="text-[11px] text-[var(--faint)] px-2 py-1.5">{t('deckStudio.htmlEdit.noTree')}</p>
          )}
        </div>
      </div>

      {/* properties for the selected node */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {!info ? (
          <div className="h-full grid place-items-center text-center px-4">
            <p className="text-[11px] text-[var(--faint)] leading-relaxed">{t('deckStudio.htmlEdit.selectHint')}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* text content (leaves only) */}
            {info.textLeaf && (
              <section className="space-y-1.5">
                <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--faint)]">{t('deckStudio.htmlEdit.content')}</h4>
                <textarea
                  value={info.text || ''}
                  onChange={(e) => onText?.(e.target.value)}
                  rows={2}
                  className={`${inputCls} w-full resize-none leading-snug`}
                />
              </section>
            )}

            {/* typography */}
            <section className="space-y-1">
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--faint)]">{t('deckStudio.htmlEdit.typography')}</h4>
              <Field label={t('deckStudio.htmlEdit.size')} dot={inl.fontSize}>
                <input
                  type="number"
                  min={6}
                  max={200}
                  step={1}
                  value={c.fontSize ?? ''}
                  onChange={(e) => set({ fontSize: e.target.value === '' ? null : `${e.target.value}px` })}
                  className={`${inputCls} w-16`}
                />
                <span className="text-[10px] text-[var(--faint)]">px</span>
                <button
                  onClick={() => set({ fontSize: null })}
                  className="ml-auto text-[10px] text-[var(--faint)] hover:text-[var(--text)]"
                  title={t('deckStudio.htmlEdit.reset')}
                >
                  <Icon.Eraser size={12} />
                </button>
              </Field>
              <Field label={t('deckStudio.htmlEdit.color')} dot={inl.color}>
                <input
                  type="color"
                  value={toHex(c.color)}
                  onChange={(e) => set({ color: e.target.value.toUpperCase() })}
                  className="w-6 h-6 rounded cursor-pointer border border-[var(--border)] bg-transparent shrink-0"
                />
                <input
                  value={toHex(c.color).toUpperCase()}
                  onChange={(e) => /^#[0-9a-fA-F]{6}$/.test(e.target.value) && set({ color: e.target.value.toUpperCase() })}
                  className={`${inputCls} w-24 font-mono`}
                />
              </Field>
              <Field label={t('deckStudio.htmlEdit.weight')} dot={inl.fontWeight || inl.fontStyle}>
                <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
                  <button
                    onClick={() => set({ fontWeight: isBold ? '400' : '700' })}
                    className={`w-7 h-6 grid place-items-center font-bold text-[12px] ${isBold ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'}`}
                    title={t('deckStudio.htmlEdit.bold')}
                  >
                    B
                  </button>
                  <button
                    onClick={() => set({ fontStyle: c.fontStyle === 'italic' ? 'normal' : 'italic' })}
                    className={`w-7 h-6 grid place-items-center italic text-[12px] border-l border-[var(--border)] ${c.fontStyle === 'italic' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'}`}
                    title={t('deckStudio.htmlEdit.italic')}
                  >
                    I
                  </button>
                </div>
                <select
                  value={c.textTransform && c.textTransform !== 'none' ? c.textTransform : ''}
                  onChange={(e) => set({ textTransform: e.target.value || 'none' })}
                  className={`${inputCls} ml-1`}
                  title={t('deckStudio.htmlEdit.transform')}
                >
                  <option value="">{t('deckStudio.htmlEdit.caseNormal')}</option>
                  <option value="uppercase">ABC</option>
                  <option value="lowercase">abc</option>
                  <option value="capitalize">Abc</option>
                </select>
              </Field>
              <Field label={t('deckStudio.htmlEdit.align')} dot={inl.textAlign}>
                <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
                  {['left', 'center', 'right', 'justify'].map((al) => (
                    <button
                      key={al}
                      onClick={() => set({ textAlign: al })}
                      className={`px-2 h-6 text-[12px] ${al !== 'left' ? 'border-l border-[var(--border)]' : ''} ${
                        c.textAlign === al ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'
                      }`}
                      title={al}
                    >
                      {al === 'left' ? '⇤' : al === 'center' ? '↔' : al === 'right' ? '⇥' : '≣'}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label={t('deckStudio.htmlEdit.spacing')} dot={inl.letterSpacing || inl.lineHeight}>
                <input
                  type="number"
                  step={0.1}
                  value={c.letterSpacing ?? 0}
                  onChange={(e) => set({ letterSpacing: e.target.value === '' ? null : `${e.target.value}px` })}
                  className={`${inputCls} w-14`}
                  title={t('deckStudio.htmlEdit.letterSpacing')}
                />
                <span className="text-[10px] text-[var(--faint)]">ls</span>
                <input
                  type="number"
                  step={0.05}
                  min={0.7}
                  max={3}
                  value={c.lineHeight ?? ''}
                  placeholder="auto"
                  onChange={(e) => set({ lineHeight: e.target.value === '' ? null : e.target.value })}
                  className={`${inputCls} w-14 ml-1`}
                  title={t('deckStudio.htmlEdit.lineHeight')}
                />
                <span className="text-[10px] text-[var(--faint)]">lh</span>
              </Field>
            </section>

            {/* appearance */}
            <section className="space-y-1">
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--faint)]">{t('deckStudio.htmlEdit.appearance')}</h4>
              <Field label={t('deckStudio.htmlEdit.background')} dot={inl.background}>
                {hasBg(c.backgroundColor) ? (
                  <>
                    <input
                      type="color"
                      value={toHex(c.backgroundColor)}
                      onChange={(e) => set({ background: e.target.value.toUpperCase() })}
                      className="w-6 h-6 rounded cursor-pointer border border-[var(--border)] bg-transparent shrink-0"
                    />
                    <input
                      value={toHex(c.backgroundColor).toUpperCase()}
                      onChange={(e) => /^#[0-9a-fA-F]{6}$/.test(e.target.value) && set({ background: e.target.value.toUpperCase() })}
                      className={`${inputCls} w-24 font-mono`}
                    />
                    <button onClick={() => set({ background: null })} className="ml-auto text-[10px] text-[var(--faint)] hover:text-[var(--text)]" title={t('deckStudio.htmlEdit.reset')}>
                      <Icon.Eraser size={12} />
                    </button>
                  </>
                ) : (
                  <button onClick={() => set({ background: '#FFFFFF' })} className="text-[11px] text-[var(--accent)] hover:brightness-110 flex items-center gap-1">
                    <Icon.Plus size={11} /> {t('deckStudio.htmlEdit.addFill')}
                  </button>
                )}
              </Field>
              <Field label={t('deckStudio.htmlEdit.radius')} dot={inl.borderRadius}>
                <input
                  type="number"
                  min={0}
                  max={200}
                  value={c.borderRadius ?? 0}
                  onChange={(e) => set({ borderRadius: e.target.value === '' ? null : `${e.target.value}px` })}
                  className={`${inputCls} w-16`}
                />
                <span className="text-[10px] text-[var(--faint)]">px</span>
              </Field>
              <Field label={t('deckStudio.htmlEdit.opacity')} dot={inl.opacity}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={parseFloat(c.opacity ?? 1)}
                  onChange={(e) => set({ opacity: e.target.value })}
                  className="flex-1 accent-[var(--accent)]"
                />
                <span className="text-[10px] text-[var(--faint)] tabular-nums w-8 text-right">{Math.round(parseFloat(c.opacity ?? 1) * 100)}%</span>
              </Field>
              <Field label={t('deckStudio.htmlEdit.padding')} dot={inl.padding}>
                <input
                  type="number"
                  min={0}
                  value={c.paddingTop ?? 0}
                  onChange={(e) => {
                    const v = e.target.value === '' ? null : `${e.target.value}px`
                    set({ paddingTop: v, paddingRight: v, paddingBottom: v, paddingLeft: v })
                  }}
                  className={`${inputCls} w-16`}
                />
                <span className="text-[10px] text-[var(--faint)]">px · {t('deckStudio.htmlEdit.allSides')}</span>
              </Field>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
