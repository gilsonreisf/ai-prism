import { useMemo, useState } from 'react'
import { useT } from '../../lib/i18n.jsx'
import * as Icon from '../Icons.jsx'

// Properties panel + DOM layer tree for a pure-HTML slide — the Claude Design
// "Pro" edit surface, reproduced. A nested, selectable tree of the slide's real
// DOM nodes on top; below it a properties panel that edits the SELECTED node's
// inline style / text / attributes (Text · Sizing · Position · Padding · Margin
// · Appearance). The DOM is the model — no separate semantic tree. Selection is
// a child-index path (e.g. "1.0.2"), the exact scheme the in-iframe runtime uses,
// so tree, canvas ring and panel all address the same node(s).
//
// Multi-selection collapses the panel to a batch-ops strip (align/group/style),
// mirroring Claude Design. Style edits push to the iframe imperatively; the live
// `info` snapshot drives shown values.

function toHex(c) {
  if (!c) return '#000000'
  if (c.startsWith('#')) return c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(c)
  if (!m) return '#000000'
  return '#' + [m[1], m[2], m[3]].map((v) => Math.round(parseFloat(v)).toString(16).padStart(2, '0')).join('')
}
function hasBg(c) {
  if (!c || c === 'transparent' || c === 'none') return false
  const m = /rgba?\([^)]*?,\s*([\d.]+)\)/.exec(c)
  return !(m && parseFloat(m[1]) === 0)
}

// ---- DOM layer tree ---------------------------------------------------------
const TAG_LABEL = {
  section: 'Slide', h1: 'Título', h2: 'Título', h3: 'Subtítulo', h4: 'Subtítulo',
  p: 'Texto', span: 'Texto', ul: 'Lista', ol: 'Lista', li: 'Item',
  svg: 'Gráfico', img: 'Imagem', table: 'Tabela', tr: 'Linha', td: 'Célula', th: 'Célula',
}
function labelFor(el) {
  const tag = el.tagName.toLowerCase()
  const base = TAG_LABEL[tag]
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ')
  if ((tag === 'div' || tag === 'section') && !base) {
    const cls = el.getAttribute('class') || ''
    if (/card/i.test(cls)) return 'Card'
    const disp = el.getAttribute('style') || ''
    if (/flex|grid/i.test(disp) || /grid|row|col|flex/i.test(cls)) return 'Grupo'
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
    return { tag: el.tagName.toLowerCase(), path, label: labelFor(el), children }
  }
  return walk(root, '')
}

function TreeRow({ node, depth, selectedPaths, onSelect, expanded, toggle }) {
  const isSel = selectedPaths.includes(node.path)
  const hasKids = node.children.length > 0
  const isOpen = expanded.has(node.path)
  return (
    <div>
      <div
        onClick={(e) => onSelect(node.path, e.shiftKey || e.metaKey || e.ctrlKey)}
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
            <TreeRow key={c.path} node={c} depth={depth + 1} selectedPaths={selectedPaths} onSelect={onSelect} expanded={expanded} toggle={toggle} />
          ))}
        </div>
      )}
    </div>
  )
}

function Field({ label, children, dot }) {
  return (
    <div className="flex items-center gap-2 min-h-8">
      <label className="text-[11px] text-[var(--muted)] w-[4.5rem] shrink-0 flex items-center gap-1">
        {dot && <span className="w-1 h-1 rounded-full bg-[var(--accent)] shrink-0" title="Definido neste elemento" />}
        {label}
      </label>
      <div className="flex-1 flex items-center gap-1.5 min-w-0 flex-wrap">{children}</div>
    </div>
  )
}
function SectionHead({ children, onReset }) {
  return (
    <div className="flex items-center justify-between">
      <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--faint)]">{children}</h4>
      {onReset && (
        <button onClick={onReset} className="text-[10px] text-[var(--faint)] hover:text-[var(--text)]">
          Reset
        </button>
      )}
    </div>
  )
}
const inputCls = 'min-w-0 text-[12px] rounded-md bg-[var(--surface)] border border-[var(--border)] px-2 py-1 outline-none focus:border-[var(--accent)]'
// a small segmented toggle (Hug/Fixed/Fill, None/All/…)
function Seg({ options, value, onChange }) {
  return (
    <div className="flex rounded-md border border-[var(--border)] overflow-hidden text-[11px]">
      {options.map((o, i) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-2 h-6 whitespace-nowrap ${i ? 'border-l border-[var(--border)]' : ''} ${
            value === o.value ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export default function HtmlSlideInspector({
  html,
  selectedPaths = [],
  selectedInfo,
  onSelectPath,
  onStyle,
  onText,
  onAttr,
  onOp,
  onUploadImage,
}) {
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
  const multi = info?.multi
  const c = info?.computed || {}
  const inl = info?.inline || {}
  const sz = info?.sizing || {}
  const isBold = parseInt(c.fontWeight, 10) >= 600
  const set = (style) => onStyle?.(style)
  // padding/margin box modes
  const padMode = inl.padding ? (c.paddingTop === c.paddingRight && c.paddingRight === c.paddingBottom && c.paddingBottom === c.paddingLeft ? 'all' : 'individual') : 'none'
  const marMode = inl.margin ? (c.marginTop === c.marginRight && c.marginRight === c.marginBottom && c.marginBottom === c.marginLeft ? 'all' : 'individual') : 'none'

  const sizingSeg = [
    { value: 'hug', label: 'Hug' },
    { value: 'fixed', label: 'Fixed' },
    { value: 'fill', label: 'Fill' },
  ]
  const setWidth = (mode) => set({ width: mode === 'hug' ? null : mode === 'fill' ? '100%' : `${Math.round(c.width)}px` })
  const setHeight = (mode) => set({ height: mode === 'hug' ? null : mode === 'fill' ? '100%' : `${Math.round(c.height)}px` })

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* DOM layer tree */}
      <div className="shrink-0 border-b border-[var(--border)]">
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
          <span className="text-xs font-semibold">{t('deckStudio.htmlEdit.layers')}</span>
          <span className="text-[9.5px] text-[var(--faint)]">{t('deckStudio.htmlEdit.layersHint')}</span>
        </div>
        <div className="max-h-44 overflow-y-auto px-1.5 pb-1.5">
          {tree ? (
            <TreeRow node={tree} depth={0} selectedPaths={selectedPaths} onSelect={onSelectPath} expanded={expanded} toggle={toggle} />
          ) : (
            <p className="text-[11px] text-[var(--faint)] px-2 py-1.5">{t('deckStudio.htmlEdit.noTree')}</p>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {!info ? (
          <div className="h-full grid place-items-center text-center px-4">
            <p className="text-[11px] text-[var(--faint)] leading-relaxed">{t('deckStudio.htmlEdit.selectHint')}</p>
          </div>
        ) : multi ? (
          // ---- multi-selection: batch structural ops --------------------------
          <div className="space-y-3">
            <p className="text-[11px] text-[var(--muted)]">{t('deckStudio.htmlEdit.multiCount', { n: info.count })}</p>
            <div className="grid grid-cols-2 gap-1.5">
              <button onClick={() => onOp?.('group')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[12px] py-1.5 flex items-center justify-center gap-1.5">
                <Icon.Copy size={12} /> {t('deckStudio.htmlEdit.group')}
              </button>
              <button onClick={() => onOp?.('wrapFlex')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[12px] py-1.5">
                {t('deckStudio.htmlEdit.wrapFlex')}
              </button>
              <button onClick={() => onOp?.('duplicate')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[12px] py-1.5 flex items-center justify-center gap-1.5">
                <Icon.Copy size={12} /> {t('deckStudio.htmlEdit.duplicate')}
              </button>
              <button onClick={() => onOp?.('delete')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[12px] py-1.5 flex items-center justify-center gap-1.5 text-[var(--danger,#e5484d)]">
                <Icon.Trash size={12} /> {t('common.delete')}
              </button>
            </div>
            {/* shared color for a quick multi-restyle */}
            <Field label={t('deckStudio.htmlEdit.color')}>
              <input type="color" defaultValue="#FFFFFF" onChange={(e) => set({ color: e.target.value.toUpperCase() })} className="w-6 h-6 rounded cursor-pointer border border-[var(--border)] bg-transparent" />
              <span className="text-[10px] text-[var(--faint)]">{t('deckStudio.htmlEdit.applyAll')}</span>
            </Field>
          </div>
        ) : (
          <div className="space-y-4">
            {/* content: text or image source */}
            {info.textLeaf && (
              <section className="space-y-1.5">
                <SectionHead>{t('deckStudio.htmlEdit.content')}</SectionHead>
                <textarea value={info.text || ''} onChange={(e) => onText?.(e.target.value)} rows={2} className={`${inputCls} w-full resize-none leading-snug`} />
              </section>
            )}
            {info.isImage && (
              <section className="space-y-1.5">
                <SectionHead>{t('deckStudio.htmlEdit.image')}</SectionHead>
                <Field label={t('deckStudio.htmlEdit.source')}>
                  <label className="text-[11px] text-[var(--accent)] hover:brightness-110 cursor-pointer flex items-center gap-1">
                    <Icon.Upload size={12} /> {t('deckStudio.htmlEdit.replaceImage')}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (!f) return
                        const r = new FileReader()
                        r.onload = () => onAttr?.('src', r.result)
                        r.readAsDataURL(f)
                      }}
                    />
                  </label>
                </Field>
                <Field label={t('deckStudio.htmlEdit.fit')}>
                  <select value={c.objectFit || 'fill'} onChange={(e) => set({ objectFit: e.target.value })} className={inputCls}>
                    <option value="contain">contain</option>
                    <option value="cover">cover</option>
                    <option value="fill">fill</option>
                    <option value="none">none</option>
                  </select>
                </Field>
              </section>
            )}

            {/* typography (text leaves) */}
            {info.textLeaf && (
              <section className="space-y-1">
                <SectionHead>{t('deckStudio.htmlEdit.typography')}</SectionHead>
                <Field label={t('deckStudio.htmlEdit.size')} dot={inl.fontSize}>
                  <input type="number" min={6} max={200} value={c.fontSize ?? ''} onChange={(e) => set({ fontSize: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} w-16`} />
                  <span className="text-[10px] text-[var(--faint)]">px</span>
                  <button onClick={() => set({ fontSize: null })} className="ml-auto text-[10px] text-[var(--faint)] hover:text-[var(--text)]" title={t('deckStudio.htmlEdit.reset')}>
                    <Icon.Eraser size={12} />
                  </button>
                </Field>
                <Field label={t('deckStudio.htmlEdit.color')} dot={inl.color}>
                  <input type="color" value={toHex(c.color)} onChange={(e) => set({ color: e.target.value.toUpperCase() })} className="w-6 h-6 rounded cursor-pointer border border-[var(--border)] bg-transparent shrink-0" />
                  <input value={toHex(c.color).toUpperCase()} onChange={(e) => /^#[0-9a-fA-F]{6}$/.test(e.target.value) && set({ color: e.target.value.toUpperCase() })} className={`${inputCls} w-24 font-mono`} />
                </Field>
                <Field label={t('deckStudio.htmlEdit.weight')} dot={inl.fontWeight || inl.fontStyle || inl.textDecoration}>
                  <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
                    <button onClick={() => set({ fontWeight: isBold ? '400' : '700' })} className={`w-7 h-6 grid place-items-center font-bold text-[12px] ${isBold ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'}`} title={t('deckStudio.htmlEdit.bold')}>
                      B
                    </button>
                    <button onClick={() => set({ fontStyle: c.fontStyle === 'italic' ? 'normal' : 'italic' })} className={`w-7 h-6 grid place-items-center italic text-[12px] border-l border-[var(--border)] ${c.fontStyle === 'italic' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'}`} title={t('deckStudio.htmlEdit.italic')}>
                      I
                    </button>
                    <button onClick={() => set({ textDecoration: /underline/.test(c.textDecorationLine) ? 'none' : 'underline' })} className={`w-7 h-6 grid place-items-center underline text-[12px] border-l border-[var(--border)] ${/underline/.test(c.textDecorationLine) ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'}`} title="Underline">
                      U
                    </button>
                  </div>
                  <select value={c.textTransform && c.textTransform !== 'none' ? c.textTransform : ''} onChange={(e) => set({ textTransform: e.target.value || 'none' })} className={`${inputCls} ml-1`} title={t('deckStudio.htmlEdit.transform')}>
                    <option value="">{t('deckStudio.htmlEdit.caseNormal')}</option>
                    <option value="uppercase">ABC</option>
                    <option value="lowercase">abc</option>
                    <option value="capitalize">Abc</option>
                  </select>
                </Field>
                <Field label={t('deckStudio.htmlEdit.align')} dot={inl.textAlign}>
                  <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
                    {['left', 'center', 'right', 'justify'].map((al) => (
                      <button key={al} onClick={() => set({ textAlign: al })} className={`px-2 h-6 text-[12px] ${al !== 'left' ? 'border-l border-[var(--border)]' : ''} ${c.textAlign === al ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'}`} title={al}>
                        {al === 'left' ? '⇤' : al === 'center' ? '↔' : al === 'right' ? '⇥' : '≣'}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label={t('deckStudio.htmlEdit.spacing')} dot={inl.letterSpacing || inl.lineHeight}>
                  <input type="number" step={0.1} value={c.letterSpacing ?? 0} onChange={(e) => set({ letterSpacing: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} w-14`} title={t('deckStudio.htmlEdit.letterSpacing')} />
                  <span className="text-[10px] text-[var(--faint)]">ls</span>
                  <input type="number" step={0.05} min={0.7} max={3} value={c.lineHeight ?? ''} placeholder="auto" onChange={(e) => set({ lineHeight: e.target.value === '' ? null : e.target.value })} className={`${inputCls} w-14 ml-1`} title={t('deckStudio.htmlEdit.lineHeight')} />
                  <span className="text-[10px] text-[var(--faint)]">lh</span>
                </Field>
              </section>
            )}

            {/* sizing */}
            <section className="space-y-1">
              <SectionHead onReset={() => set({ width: null, height: null, flexGrow: null, alignSelf: null })}>{t('deckStudio.htmlEdit.sizing')}</SectionHead>
              <Field label={t('deckStudio.htmlEdit.width')} dot={inl.width}>
                <input type="number" value={Math.round(c.width) || ''} onChange={(e) => set({ width: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} w-16`} disabled={sz.width === 'hug'} />
                <Seg options={sizingSeg} value={sz.width} onChange={setWidth} />
              </Field>
              <Field label={t('deckStudio.htmlEdit.height')} dot={inl.height}>
                <input type="number" value={Math.round(c.height) || ''} onChange={(e) => set({ height: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} w-16`} disabled={sz.height === 'hug'} />
                <Seg options={sizingSeg} value={sz.height} onChange={setHeight} />
              </Field>
            </section>

            {/* position */}
            <section className="space-y-1">
              <SectionHead>{t('deckStudio.htmlEdit.position')}</SectionHead>
              <Field label={t('deckStudio.htmlEdit.mode')} dot={inl.position}>
                <Seg
                  options={[
                    { value: 'static', label: t('deckStudio.htmlEdit.inline') },
                    { value: 'absolute', label: 'Absolute' },
                    { value: 'fixed', label: 'Fixed' },
                    { value: 'sticky', label: 'Sticky' },
                  ]}
                  value={c.position === 'relative' || c.position === 'static' ? 'static' : c.position}
                  onChange={(v) => set({ position: v === 'static' ? null : v })}
                />
              </Field>
              {c.position === 'absolute' || c.position === 'fixed' || c.position === 'sticky' ? (
                <>
                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
                      T
                      <input type="number" value={parseFloat(c.top) || ''} placeholder="auto" onChange={(e) => set({ top: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} flex-1`} />
                    </label>
                    <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
                      L
                      <input type="number" value={parseFloat(c.left) || ''} placeholder="auto" onChange={(e) => set({ left: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} flex-1`} />
                    </label>
                    <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
                      R
                      <input type="number" value={parseFloat(c.right) || ''} placeholder="auto" onChange={(e) => set({ right: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} flex-1`} />
                    </label>
                    <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
                      B
                      <input type="number" value={parseFloat(c.bottom) || ''} placeholder="auto" onChange={(e) => set({ bottom: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} flex-1`} />
                    </label>
                  </div>
                  <Field label="Z-index" dot={inl.zIndex}>
                    <input type="number" value={c.zIndex || ''} placeholder="auto" onChange={(e) => set({ zIndex: e.target.value === '' ? null : e.target.value })} className={`${inputCls} w-16`} />
                  </Field>
                </>
              ) : null}
            </section>

            {/* padding + margin */}
            <section className="space-y-1">
              <SectionHead>{t('deckStudio.htmlEdit.spacingBox')}</SectionHead>
              <Field label={t('deckStudio.htmlEdit.padding')} dot={inl.padding}>
                <Seg
                  options={[
                    { value: 'none', label: t('deckStudio.htmlEdit.none') },
                    { value: 'all', label: t('deckStudio.htmlEdit.all') },
                  ]}
                  value={padMode === 'none' ? 'none' : 'all'}
                  onChange={(v) => (v === 'none' ? set({ padding: null }) : set({ padding: '16px' }))}
                />
                {padMode !== 'none' && (
                  <input type="number" min={0} value={c.paddingTop ?? 0} onChange={(e) => set({ padding: `${e.target.value || 0}px` })} className={`${inputCls} w-14`} />
                )}
              </Field>
              <Field label={t('deckStudio.htmlEdit.margin')} dot={inl.margin}>
                <Seg
                  options={[
                    { value: 'none', label: t('deckStudio.htmlEdit.none') },
                    { value: 'all', label: t('deckStudio.htmlEdit.all') },
                  ]}
                  value={marMode === 'none' ? 'none' : 'all'}
                  onChange={(v) => (v === 'none' ? set({ margin: null }) : set({ margin: '16px' }))}
                />
                {marMode !== 'none' && (
                  <input type="number" value={c.marginTop ?? 0} onChange={(e) => set({ margin: `${e.target.value || 0}px` })} className={`${inputCls} w-14`} />
                )}
              </Field>
            </section>

            {/* appearance */}
            <section className="space-y-1">
              <SectionHead onReset={() => set({ background: null, borderRadius: null, opacity: null, boxShadow: null, overflow: null })}>{t('deckStudio.htmlEdit.appearance')}</SectionHead>
              <Field label={t('deckStudio.htmlEdit.background')} dot={inl.background}>
                {hasBg(c.backgroundColor) ? (
                  <>
                    <input type="color" value={toHex(c.backgroundColor)} onChange={(e) => set({ background: e.target.value.toUpperCase() })} className="w-6 h-6 rounded cursor-pointer border border-[var(--border)] bg-transparent shrink-0" />
                    <input value={toHex(c.backgroundColor).toUpperCase()} onChange={(e) => /^#[0-9a-fA-F]{6}$/.test(e.target.value) && set({ background: e.target.value.toUpperCase() })} className={`${inputCls} w-24 font-mono`} />
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
                <input type="number" min={0} max={400} value={c.borderRadius ?? 0} onChange={(e) => set({ borderRadius: e.target.value === '' ? null : `${e.target.value}px` })} className={`${inputCls} w-16`} />
                <span className="text-[10px] text-[var(--faint)]">px</span>
              </Field>
              <Field label={t('deckStudio.htmlEdit.overflow')} dot={inl.overflow}>
                <select value={c.overflow || 'visible'} onChange={(e) => set({ overflow: e.target.value })} className={inputCls}>
                  <option value="visible">visible</option>
                  <option value="hidden">hidden</option>
                  <option value="auto">auto</option>
                </select>
              </Field>
              <Field label={t('deckStudio.htmlEdit.opacity')} dot={inl.opacity}>
                <input type="range" min={0} max={1} step={0.05} value={parseFloat(c.opacity ?? 1)} onChange={(e) => set({ opacity: e.target.value })} className="flex-1 accent-[var(--accent)]" />
                <span className="text-[10px] text-[var(--faint)] tabular-nums w-8 text-right">{Math.round(parseFloat(c.opacity ?? 1) * 100)}%</span>
              </Field>
              <Field label={t('deckStudio.htmlEdit.shadow')} dot={inl.boxShadow}>
                {c.boxShadow && c.boxShadow !== 'none' ? (
                  <button onClick={() => set({ boxShadow: null })} className="text-[11px] text-[var(--faint)] hover:text-[var(--text)] flex items-center gap-1">
                    <Icon.Eraser size={11} /> {t('deckStudio.htmlEdit.removeShadow')}
                  </button>
                ) : (
                  <button onClick={() => set({ boxShadow: '0 8px 24px rgba(0,0,0,.18)' })} className="text-[11px] text-[var(--accent)] hover:brightness-110 flex items-center gap-1">
                    <Icon.Plus size={11} /> {t('deckStudio.htmlEdit.addShadow')}
                  </button>
                )}
              </Field>
            </section>

            {/* structural ops for a single element */}
            <section className="pt-1 border-t border-[var(--border)]">
              <div className="grid grid-cols-2 gap-1.5 pt-2">
                <button onClick={() => onOp?.('duplicate')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[11px] py-1.5 flex items-center justify-center gap-1.5">
                  <Icon.Copy size={11} /> {t('deckStudio.htmlEdit.duplicate')}
                </button>
                <button onClick={() => onOp?.('delete')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[11px] py-1.5 flex items-center justify-center gap-1.5 text-[var(--danger,#e5484d)]">
                  <Icon.Trash size={11} /> {t('common.delete')}
                </button>
                <button onClick={() => onOp?.('front')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[11px] py-1.5">
                  {t('deckStudio.htmlEdit.toFront')}
                </button>
                <button onClick={() => onOp?.('back')} className="rounded-md border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[11px] py-1.5">
                  {t('deckStudio.htmlEdit.toBack')}
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
