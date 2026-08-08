import { useCallback, useEffect, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import DeckSlidePreview, { resolvePreviewTheme } from './DeckSlidePreview.jsx'
import ElementCanvas from './deck/ElementCanvas.jsx'
import ElementInspector, { MultiSelectPanel } from './deck/ElementInspector.jsx'
import AddElementBar from './deck/AddElementBar.jsx'
import LayerTree from './deck/LayerTree.jsx'
import HtmlSlideFrame, { buildDeckTokenStyle } from './deck/HtmlSlideFrame.jsx'
import HtmlSlideEditor from './deck/HtmlSlideEditor.jsx'
import HtmlSlideInspector from './deck/HtmlSlideInspector.jsx'
import HtmlEditToolbar from './deck/HtmlEditToolbar.jsx'
import HtmlEditContextMenu from './deck/HtmlEditContextMenu.jsx'
import { extractOpsFromSlides } from '../lib/domToSlideOps.js'
import useDeckHistory from '../hooks/useDeckHistory.js'
import { materializeSlide, CONVERTIBLE_LAYOUTS, defaultElement } from '../../../shared/deckLayout.js'
import { resolveDeckTheme } from '../../../shared/deckTheme.js'
import { findNode, findParent, updateNode, removeNodes, groupNodes, ungroupNode, alignNodes, distributeNodes, patchNodesStyle } from '../lib/deckTree.js'
import { getJSON, patchJSON, postJSON } from '../api.js'
import { useT } from '../lib/i18n.jsx'
import CostBadge from './CostBadge.jsx'

// Given a slide's <section> HTML and a list of child-index paths (e.g. "1.0.2"),
// return the outerHTML of each addressed node — used to copy/cut selected
// elements to the studio clipboard (paste re-inserts them into the live editor).
function extractNodesHtml(html, paths) {
  if (!html || !paths?.length) return []
  let doc
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return []
  }
  const root = doc.body.firstElementChild
  if (!root) return []
  const at = (path) => {
    let el = root
    for (const seg of String(path).split('.')) {
      if (!el) return null
      el = el.children[parseInt(seg, 10)]
    }
    return el || null
  }
  return paths.map(at).filter(Boolean).map((el) => el.outerHTML)
}

// "cards[2].heading" → immutable deep set into a slide object — the write
// half of the canvas' inline text editing (SelBox commits land here).
function setDeep(obj, path, value) {
  const tokens = (path.match(/[^.[\]]+/g) || []).map((t) => (/^\d+$/.test(t) ? Number(t) : t))
  if (!tokens.length) return obj
  const clone = Array.isArray(obj) ? [...obj] : { ...obj }
  let cur = clone
  for (let i = 0; i < tokens.length - 1; i++) {
    const k = tokens[i]
    const next = cur[k]
    cur[k] = Array.isArray(next) ? [...next] : { ...(next || {}) }
    cur = cur[k]
  }
  cur[tokens[tokens.length - 1]] = value
  return clone
}

// Fullscreen Present mode — arrow keys / click zones, Esc closes. Renders
// the same DeckSlidePreview the export mirrors, so "apresentar" is faithful
// to the .pptx (including the design system's webfonts).
function PresentMode({ deck, template, onClose }) {
  const t = useT()
  const [index, setIndex] = useState(0)
  const n = deck.slides.length
  const go = useCallback((d) => setIndex((i) => Math.max(0, Math.min(n - 1, i + d))), [n])
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') go(1)
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1)
      else if (e.key === 'Home') setIndex(0)
      else if (e.key === 'End') setIndex(n - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, n, onClose])
  const slide = deck.slides[index]
  return (
    <div className="fixed inset-0 z-[120] bg-black flex flex-col items-center justify-center animate-fade-in">
      <button onClick={onClose} className="absolute top-4 right-4 p-2 rounded-lg text-white/50 hover:text-white hover:bg-white/10" title={t('deckStudio.present.exit')}>
        <Icon.Close size={20} />
      </button>
      <div className="absolute inset-0 flex" aria-hidden>
        <div className="flex-1 cursor-w-resize" onClick={() => go(-1)} />
        <div className="flex-1 cursor-e-resize" onClick={() => go(1)} />
      </div>
      <div className="w-full max-w-[min(96vw,177vh)] px-6 pointer-events-none">
        <DeckSlidePreview
          slide={slide}
          template={template}
          deck={deck}
          deckTitle={deck.title}
          variant="canvas"
          className="w-full shadow-2xl"
          pageNumber={index + 1}
          sectionNo={deck.slides.slice(0, index + 1).filter((x) => x.layout === 'section').length}
        />
      </div>
      <div className="absolute bottom-4 text-white/40 text-xs tabular-nums select-none">
        {t('deckStudio.present.nav', { current: index + 1, total: n })}
      </div>
      {slide?.notes && (
        <div className="absolute bottom-10 max-w-2xl text-center text-white/50 text-xs px-6 line-clamp-2" title={slide.notes}>
          🗒 {slide.notes}
        </div>
      )}
    </div>
  )
}

const LAYOUTS = [
  { value: 'title', labelKey: 'deckStudio.layout.title' },
  { value: 'section', labelKey: 'deckStudio.layout.section' },
  { value: 'bullets', labelKey: 'deckStudio.layout.bullets' },
  { value: 'two-column', labelKey: 'deckStudio.layout.twoColumn' },
  { value: 'agenda', labelKey: 'deckStudio.layout.agenda' },
  { value: 'cards', labelKey: 'deckStudio.layout.cards' },
  { value: 'stat-grid', labelKey: 'deckStudio.layout.statGrid' },
  { value: 'comparison', labelKey: 'deckStudio.layout.comparison' },
  { value: 'timeline', labelKey: 'deckStudio.layout.timeline' },
  { value: 'table', labelKey: 'deckStudio.layout.table' },
  { value: 'diagram', labelKey: 'deckStudio.layout.diagram' },
  { value: 'chart', labelKey: 'deckStudio.layout.chart' },
  { value: 'image', labelKey: 'deckStudio.layout.image' },
  { value: 'quote', labelKey: 'deckStudio.layout.quote' },
  { value: 'closing', labelKey: 'deckStudio.layout.closing' },
]

function emptySlide() {
  return { layout: 'bullets', heading: 'Novo slide', bullets: [] }
}

// A single compact icon slot for a cards/stat-grid/timeline item — opens a
// small grid of the active template's real icon assets (see
// resolveIconAssetId in server/blocks.js: this is the only place an item's
// iconAssetId ever gets set, never free text/emoji).
function IconPicker({ value, options, onChange }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const selected = options?.find((a) => a.id === value)
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t('deckStudio.iconPicker.choose')}
        className="w-8 h-8 rounded-lg border border-dashed border-[var(--border)] grid place-items-center overflow-hidden bg-[var(--surface-2)] hover:border-[var(--accent)]"
      >
        {selected ? (
          <img src={selected.dataUrl} alt="" className="w-5 h-5 object-contain" />
        ) : (
          <Icon.Plus size={12} className="text-[var(--faint)]" />
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 top-full left-0 mt-1 w-48 max-h-48 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg p-1.5">
            <button
              type="button"
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
              className="w-full text-left text-[11px] text-[var(--faint)] hover:text-[var(--text)] py-1 px-1 border-b border-[var(--border)] mb-1"
            >
              {t('deckStudio.iconPicker.none')}
            </button>
            {options?.length ? (
              <div className="grid grid-cols-6 gap-1">
                {options.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    onClick={() => {
                      onChange(a.id)
                      setOpen(false)
                    }}
                    title={a.label || a.id}
                    className={`w-7 h-7 rounded-md border grid place-items-center ${
                      a.id === value ? 'border-[var(--accent)]' : 'border-[var(--border)]'
                    }`}
                  >
                    <img src={a.dataUrl} alt="" className="w-5 h-5 object-contain" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-[var(--faint)] px-1">{t('deckStudio.iconPicker.empty')}</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// One row per item (icon slot + a text input per field) instead of the
// pipe-delimited textarea used for simpler layouts — icons are picked, not
// typed, so a free-text row format no longer fits cards/stat-grid/timeline.
function ItemListEditor({ items, fields, iconOptions, onChange, addLabel }) {
  const t = useT()
  const list = items || []
  const update = (i, patch) => onChange(list.map((it, idx) => (idx === i ? { ...it, ...patch } : it)))
  const remove = (i) => onChange(list.filter((_, idx) => idx !== i))
  const add = () => onChange([...list, {}])
  return (
    <div className="flex-1 space-y-1.5">
      {list.map((item, i) => (
        <div key={i} className="flex items-center gap-1.5">
          {iconOptions && (
            <IconPicker value={item.iconAssetId} options={iconOptions} onChange={(id) => update(i, { iconAssetId: id })} />
          )}
          {fields.map(([key, placeholder]) => (
            <input
              key={key}
              value={item[key] || ''}
              onChange={(e) => update(i, { [key]: e.target.value })}
              placeholder={placeholder}
              className="flex-1 min-w-0 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
            />
          ))}
          <button
            type="button"
            onClick={() => remove(i)}
            className="p-1.5 rounded-md hover:bg-[var(--surface-3)] text-[var(--faint)] shrink-0"
            title={t('common.delete')}
          >
            <Icon.Trash size={13} />
          </button>
        </div>
      ))}
      <button type="button" onClick={add} className="flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:brightness-110">
        <Icon.Plus size={12} /> {addLabel}
      </button>
    </div>
  )
}

// Shown on the stage while a pure-HTML deck is streaming and the current slide
// hasn't arrived yet — a shimmering 16:9 placeholder (title bar + content
// blocks) so the auto-opened Studio reads as "building", not a blank white box.
function HtmlSlideSkeleton({ streaming, label }) {
  return (
    <div className="w-full rounded-lg shadow-lg overflow-hidden border border-[var(--border)]" style={{ aspectRatio: '16/9', background: '#F9F7F4' }}>
      <div className="h-full w-full p-[6%] flex flex-col gap-[3%]">
        <div className="h-[4%] w-[22%] rounded animate-pulse" style={{ background: 'rgba(0,0,0,0.10)' }} />
        <div className="h-[9%] w-[70%] rounded animate-pulse" style={{ background: 'rgba(0,0,0,0.13)' }} />
        <div className="flex-1 grid grid-cols-3 gap-[3%] mt-[2%]">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg animate-pulse" style={{ background: 'rgba(0,0,0,0.06)', animationDelay: `${i * 150}ms` }} />
          ))}
        </div>
        {streaming && label && (
          <div className="text-center text-xs text-[var(--muted)] pt-[1%]">{label}</div>
        )}
      </div>
    </div>
  )
}

// Structured editor for the `diagram` layout — one block per column: label,
// "coluna central" toggle (emphasized panel of bands) and one item/band per
// line ("!" prefix marks an accent band, e.g. the governance layer).
function DiagramEditor({ slide, onChange }) {
  const t = useT()
  const columns = slide.columns || []
  const update = (i, col) => onChange({ columns: columns.map((c, idx) => (idx === i ? col : c)) })
  const remove = (i) => onChange({ columns: columns.filter((_, idx) => idx !== i) })
  const add = () => onChange({ columns: [...columns, { label: t('deckStudio.diagram.newColumn'), items: [] }] })
  return (
    <div className="flex items-start gap-2">
      <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.columns')}</label>
      <div className="flex-1 space-y-2">
        {columns.map((col, i) => {
          const isCentral = !!(col.emphasis || col.bands?.length)
          const lines = isCentral
            ? (col.bands || []).map((b) => `${b.tone === 'accent' ? '!' : ''}${b.label}`)
            : (col.items || []).map((it) => it.label)
          const setLines = (text) => {
            const parsed = text.split('\n')
            if (isCentral) {
              update(i, {
                ...col,
                emphasis: true,
                items: undefined,
                bands: parsed.map((l) => (l.startsWith('!') ? { label: l.slice(1), tone: 'accent' } : { label: l })),
              })
            } else {
              update(i, { ...col, bands: undefined, emphasis: undefined, items: parsed.map((l) => ({ label: l })) })
            }
          }
          return (
            <div key={i} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <input
                  value={col.label || ''}
                  onChange={(e) => update(i, { ...col, label: e.target.value })}
                  placeholder={t('deckStudio.diagram.columnLabel')}
                  className="flex-1 min-w-0 text-sm rounded-lg bg-[var(--surface)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                />
                <label className="flex items-center gap-1 text-[11px] text-[var(--muted)] shrink-0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isCentral}
                    onChange={(e) => {
                      const central = e.target.checked
                      const labels = isCentral ? (col.bands || []).map((b) => b.label) : (col.items || []).map((it) => it.label)
                      update(
                        i,
                        central
                          ? { label: col.label, emphasis: true, bands: labels.map((l) => ({ label: l })) }
                          : { label: col.label, items: labels.map((l) => ({ label: l })) }
                      )
                    }}
                  />
                  {t('deckStudio.diagram.centralColumn')}
                </label>
                <button type="button" onClick={() => remove(i)} className="p-1.5 rounded-md hover:bg-[var(--surface-3)] text-[var(--faint)] shrink-0" title={t('deckStudio.diagram.removeColumn')}>
                  <Icon.Trash size={13} />
                </button>
              </div>
              <textarea
                value={lines.join('\n')}
                onChange={(e) => setLines(e.target.value)}
                rows={Math.max(3, lines.length)}
                placeholder={isCentral ? t('deckStudio.diagram.bandsPlaceholder') : t('deckStudio.diagram.itemsPlaceholder')}
                className="w-full text-sm rounded-lg bg-[var(--surface)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
              />
            </div>
          )
        })}
        {columns.length < 4 && (
          <button type="button" onClick={add} className="flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:brightness-110">
            <Icon.Plus size={12} /> {t('deckStudio.diagram.addColumn')}
          </button>
        )}
      </div>
    </div>
  )
}

export default function DeckStudio({ open, deckId, streamingDeck, onClose, pushToast, focus = false, onToggleFocus, onEditModeChange, models, model }) {
  const t = useT()
  const [deck, setDeck] = useState(null)
  const [template, setTemplate] = useState(null)
  const [loading, setLoading] = useState(false)
  // deck/template fetch failure (timeout, expired session…) — surfaced with a
  // retry button instead of an eternal "Carregando deck…"; loadTick re-runs
  // the load effect
  const [loadError, setLoadError] = useState(null)
  const [loadTick, setLoadTick] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [exporting, setExporting] = useState(false)
  // canvas object selection (SelBox path) + NL tweak state
  const [selection, setSelection] = useState(null) // null | { path, label, text }
  const [tweak, setTweak] = useState('')
  const [tweakWholeDeck, setTweakWholeDeck] = useState(false)
  const [tweaking, setTweaking] = useState(false)
  // AI tweak preview: a pending edit shown in the canvas with Accept/Discard,
  // so an AI change is reversible before it lands. `before` is the deck to
  // restore on discard; `label` describes the edit for the history log.
  const [tweakPreview, setTweakPreview] = useState(null) // null | { before, label }
  const tweakPreviewRef = useRef(null) // mirror for cleanup on slide switch
  tweakPreviewRef.current = tweakPreview
  const [tweakHistory, setTweakHistory] = useState([]) // [{ label, at }] applied edits
  const [tweakCost, setTweakCost] = useState(null) // { usage, model } of the last AI edit
  const [presenting, setPresenting] = useState(false)
  // element canvas (freeform slides): selection (multi) + open-group scope +
  // undo/redo history
  const [selectedElIds, setSelectedElIds] = useState([])
  const [scopeId, setScopeId] = useState(null)
  // armed drag-to-create tool for the freeform canvas: { type, extra? } | null
  const [tool, setTool] = useState(null)
  const history = useDeckHistory()
  const dragFrom = useRef(null)
  const saveTimer = useRef(null)
  const skipNextSave = useRef(true)
  // pure-HTML deck manual editing (Claude Design "Pro" parity): Edit mode turns
  // the slide into a full design surface (select/create/restyle). Selection is a
  // list of child-index paths into the current slide's <section>, plus the live
  // style snapshot the iframe reports.
  const [htmlEditMode, setHtmlEditMode] = useState(false)
  const [htmlSel, setHtmlSel] = useState(null) // null | { paths:[...], info }
  const [htmlTool, setHtmlTool] = useState('select') // armed create tool
  const [htmlMenu, setHtmlMenu] = useState(null) // right-click menu {x,y,paths}
  const [htmlClip, setHtmlClip] = useState(null) // clipboard: outerHTML string(s)
  const htmlEditorRef = useRef(null)
  // per-slide undo/redo stacks for the raw HTML string, keyed by slide index.
  // Kept in refs (mutable, no re-render needed until we read length for toolbar).
  const htmlHist = useRef({ past: [], future: [] })
  const [htmlHistTick, setHtmlHistTick] = useState(0) // bump to refresh can-undo/redo
  const htmlEditPreview = useRef(null) // { before } for AI tweak preview on HTML

  useEffect(() => {
    if (!open || !deckId) return
    skipNextSave.current = true
    setLoading(true)
    setLoadError(null)
    setActiveIndex(0)
    Promise.all([getJSON(`/api/decks/${deckId}`), getJSON('/api/deck-templates/selected')])
      .then(([d, t]) => {
        setDeck(d.deck)
        setTemplate(t.template || null)
      })
      .catch((e) => setLoadError(e.message || t('deckStudio.loadError')))
      .finally(() => setLoading(false))
  }, [open, deckId, loadTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live-streaming deck (pure-HTML engine): no deckId yet — the slides arrive
  // via SSE and are handed in as `streamingDeck`. Mirror them into `deck` so the
  // rail + stage build up live. The template is loaded once; saves are disabled
  // while streaming (there's nothing persisted to PATCH yet).
  useEffect(() => {
    if (!open || !streamingDeck) return
    skipNextSave.current = true
    setDeck(streamingDeck)
    setLoading(false)
    setLoadError(null)
  }, [open, streamingDeck])

  useEffect(() => {
    if (!open || !streamingDeck || template) return
    getJSON('/api/deck-templates/selected')
      .then((t) => setTemplate(t.template || null))
      .catch(() => {})
  }, [open, streamingDeck, template])

  // element selection is per-slide — switching slides clears it. A pending AI
  // preview is auto-discarded (revert to before) so it never leaks across slides
  useEffect(() => {
    setSelection(null)
    setSelectedElIds([])
    setScopeId(null)
    setTool(null)
    setHtmlSel(null)
    setHtmlTool('select')
    setHtmlMenu(null)
    htmlHist.current = { past: [], future: [] } // per-slide undo history
    setHtmlHistTick((n) => n + 1)
    if (tweakPreviewRef.current) {
      skipNextSave.current = true
      setDeck(tweakPreviewRef.current.before)
      setTweakPreview(null)
    }
  }, [activeIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  // fresh deck load resets the undo history
  useEffect(() => {
    history.reset()
  }, [deckId]) // eslint-disable-line react-hooks/exhaustive-deps

  // tell App to hide the chat while manual HTML editing (max canvas room)
  useEffect(() => {
    onEditModeChange?.(htmlEditMode)
  }, [htmlEditMode, onEditModeChange])
  // leaving the studio or switching away from an HTML deck exits Edit mode
  useEffect(() => {
    if (!open) setHtmlEditMode(false)
  }, [open])

  // undo/redo at the Studio level (Cmd+Z / Cmd+Shift+Z) — skipped while the
  // focus is in an input/textarea/contentEditable, where the browser's own
  // text undo must win. In HTML Edit mode, ALL editor hotkeys route through
  // hotkeysRef (undo/redo/copy/cut/paste/duplicate/delete) instead of the
  // semantic-tree history.
  const hotkeysRef = useRef({})
  useEffect(() => {
    if (!open) return
    const onKey = (ev) => {
      const t = ev.target
      const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      const meta = ev.metaKey || ev.ctrlKey
      const hk = hotkeysRef.current
      // HTML Edit mode: full editor hotkey set (but never steal from a field)
      if (hk.htmlActive && !inField) {
        const k = ev.key.toLowerCase()
        if (meta && k === 'z') {
          ev.preventDefault()
          ev.shiftKey ? hk.redo?.() : hk.undo?.()
          return
        }
        if (meta && k === 'c') {
          ev.preventDefault()
          hk.op?.('copy')
          return
        }
        if (meta && k === 'x') {
          ev.preventDefault()
          hk.op?.('cut')
          return
        }
        if (meta && k === 'v') {
          ev.preventDefault()
          hk.op?.('paste')
          return
        }
        if (meta && k === 'd') {
          ev.preventDefault()
          hk.op?.('duplicate')
          return
        }
        if (meta && ev.shiftKey && k === 'g') {
          ev.preventDefault()
          hk.op?.('ungroup')
          return
        }
        if (meta && k === 'g') {
          ev.preventDefault()
          hk.op?.('group')
          return
        }
        if ((k === 'delete' || k === 'backspace') && hk.hasSel) {
          ev.preventDefault()
          hk.op?.('delete')
          return
        }
        if (k === 'escape') {
          hk.clearSel?.()
          return
        }
        return
      }
      // semantic-tree slides: original Cmd+Z / Cmd+Shift+Z
      if (!meta || ev.key.toLowerCase() !== 'z' || inField) return
      ev.preventDefault()
      setDeck((cur) => {
        if (!cur) return cur
        const next = ev.shiftKey ? history.redo(cur) : history.undo(cur)
        return next || cur
      })
      setSelectedElIds([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, history])

  // debounced autosave — skips the initial load so opening the studio never
  // fires a needless PATCH
  useEffect(() => {
    if (!deck) return
    // a live-streaming deck has no persisted id yet — never PATCH it
    if (deck.streaming || !deck.id) return
    if (skipNextSave.current) {
      skipNextSave.current = false
      return
    }
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      patchJSON(`/api/decks/${deck.id}`, {
        title: deck.title,
        slides: deck.slides,
        audience: deck.audience,
        author: deck.author,
        narrative: deck.narrative,
      })
        // Let the chat's deck card (DeckBlock) know its persisted deck changed so
        // it can re-fetch and reflect live edits (its block.slides is a snapshot
        // frozen at generation time). Fire only after the write lands.
        .then(() =>
          window.dispatchEvent(new CustomEvent('prism:deck-saved', { detail: { deckId: deck.id } }))
        )
        .catch((e) => pushToast?.(e.message))
    }, 500)
    return () => clearTimeout(saveTimer.current)
  }, [deck]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  const slide = deck?.slides?.[activeIndex]
  const isFreeform = slide?.layout === 'freeform'
  // pure-HTML deck (deck-html engine): slides are self-contained <section>
  // strings. Its own Studio layout (rail + stage + inspector) and manual editor
  // apply instead of the semantic/freeform chrome.
  const isHtmlDeck = deck?.meta?.format === 'html' || typeof deck?.slides?.[0] === 'string'

  const updateSlide = (idx, patch) => {
    setDeck((d) => {
      const slides = [...d.slides]
      const cur = slides[idx]
      // an HTML slide stored as a bare string must become {html,…} to carry
      // notes/patches (e.g. manual speaker notes on an HTML deck)
      slides[idx] = typeof cur === 'string' ? { html: cur, ...patch } : { ...cur, ...patch }
      return { ...d, slides }
    })
  }

  // read the raw <section> HTML string of a slide (string or {html} form)
  const slideHtml = (s) => (typeof s === 'string' ? s : s?.html || '')

  // Pure-HTML deck: write the edited <section> string back into the current
  // slide, preserving whether the slide entry was a bare string or a {html,notes}
  // object. `pushHistory` snapshots the PREVIOUS html for undo (skipped for
  // history-driven writes so undo/redo don't stack on themselves).
  const setHtmlSlide = (idx, newHtml, { pushHistory = true } = {}) => {
    setDeck((d) => {
      const slides = [...d.slides]
      const cur = slides[idx]
      const prev = slideHtml(cur)
      if (prev === newHtml) return d
      if (pushHistory) {
        htmlHist.current.past.push(prev)
        if (htmlHist.current.past.length > 100) htmlHist.current.past.shift()
        htmlHist.current.future = []
        setHtmlHistTick((n) => n + 1)
      }
      slides[idx] = typeof cur === 'string' ? newHtml : { ...cur, html: newHtml }
      return { ...d, slides }
    })
  }

  // undo/redo the current slide's HTML — pushes the inverse onto the other stack
  // and pushes the restored html into the live editor (setHtml replaces <section>)
  const htmlUndo = () => {
    const h = htmlHist.current
    if (!h.past.length) return
    const cur = slideHtml(deck.slides[activeIndex])
    const prev = h.past.pop()
    h.future.push(cur)
    setHtmlHistTick((n) => n + 1)
    setHtmlSlide(activeIndex, prev, { pushHistory: false })
    htmlEditorRef.current?.setHtml(prev, true)
    setHtmlSel(null)
  }
  const htmlRedo = () => {
    const h = htmlHist.current
    if (!h.future.length) return
    const cur = slideHtml(deck.slides[activeIndex])
    const next = h.future.pop()
    h.past.push(cur)
    setHtmlHistTick((n) => n + 1)
    setHtmlSlide(activeIndex, next, { pushHistory: false })
    htmlEditorRef.current?.setHtml(next, true)
    setHtmlSel(null)
  }

  // right-click / hotkey structural ops routed to the iframe runtime
  const htmlOp = (op) => {
    if (op === 'copy' || op === 'cut') {
      // copy the selected nodes' outerHTML from the current slide's DOM
      const paths = htmlSel?.paths || []
      const clips = extractNodesHtml(slideHtml(deck.slides[activeIndex]), paths)
      if (clips.length) setHtmlClip(clips)
      if (op === 'cut') htmlEditorRef.current?.op('delete')
      return
    }
    if (op === 'paste') {
      if (!htmlClip?.length) return
      htmlEditorRef.current?.paste(htmlClip)
      return
    }
    htmlEditorRef.current?.op(op, htmlSel?.paths)
  }

  // AI tweak for HTML decks: scope = whole deck / this slide / selected element.
  // Runs in PREVIEW mode; the returned deck is shown with Accept/Discard. On
  // discard we restore the pre-edit deck AND push the original HTML back into the
  // live editor iframe so the canvas reverts too.
  const submitHtmlTweak = async () => {
    const instruction = tweak.trim()
    if (!instruction || tweaking || !deck?.id) return
    setTweaking(true)
    try {
      const single = htmlSel?.paths?.length === 1 && !htmlSel.info?.multi
      const selPayload = single
        ? { path: htmlSel.paths[0], htmlOuter: extractNodesHtml(slideHtml(deck.slides[activeIndex]), htmlSel.paths)[0] || null }
        : null
      const r = await postJSON(`/api/decks/${deck.id}/tweak`, {
        instruction,
        slideIndex: tweakWholeDeck ? null : activeIndex,
        selection: tweakWholeDeck ? null : selPayload,
        preview: true,
        model,
      })
      htmlEditPreview.current = { before: deck }
      setTweakPreview({ before: deck, label: instruction })
      skipNextSave.current = true
      setDeck(r.deck)
      // reflect the edited HTML on the live canvas
      const editedHtml = slideHtml(r.deck.slides[activeIndex])
      htmlEditorRef.current?.setHtml(editedHtml, true)
      setHtmlSel(null)
      if (r.usage) setTweakCost({ usage: r.usage, model: r.model })
      setTweak('')
    } catch (e) {
      pushToast?.(e.message || t('deckStudio.tweakError'))
    } finally {
      setTweaking(false)
    }
  }
  const acceptHtmlTweak = () => {
    if (!tweakPreview) return
    patchJSON(`/api/decks/${deck.id}`, { title: deck.title, slides: deck.slides, audience: deck.audience, author: deck.author }).catch((e) => pushToast?.(e.message))
    skipNextSave.current = true
    setTweakHistory((h) => [{ label: tweakPreview.label, at: Date.now() }, ...h].slice(0, 20))
    setTweakPreview(null)
    htmlEditPreview.current = null
    // history checkpoint so the accepted AI edit is itself undoable
    htmlHist.current.past.push(slideHtml(tweakPreview.before.slides[activeIndex]))
    setHtmlHistTick((n) => n + 1)
  }
  const discardHtmlTweak = () => {
    if (!tweakPreview) return
    skipNextSave.current = true
    setDeck(tweakPreview.before)
    htmlEditorRef.current?.setHtml(slideHtml(tweakPreview.before.slides[activeIndex]), true)
    setTweakPreview(null)
    htmlEditPreview.current = null
  }

  // keep the global hotkey handler pointed at the live HTML-edit closures
  hotkeysRef.current = {
    htmlActive: htmlEditMode && isHtmlDeck,
    hasSel: !!htmlSel?.paths?.length,
    undo: htmlUndo,
    redo: htmlRedo,
    op: htmlOp,
    clearSel: () => {
      setHtmlSel(null)
      htmlEditorRef.current?.clear()
    },
  }

  // inline canvas text edit (SelBox double-click commit)
  const editSlideText = (path, value) => {
    setDeck((d) => {
      const slides = [...d.slides]
      slides[activeIndex] = setDeep(slides[activeIndex], path, value)
      return { ...d, slides }
    })
    setSelection((sel) => (sel && sel.path === path ? { ...sel, text: value } : sel))
  }

  // per-element style override (Edit-mode toolbar → slide.styles[path])
  const patchSelStyle = (patch) => {
    if (!selection) return
    setDeck((d) => {
      const slides = [...d.slides]
      const slide = slides[activeIndex]
      const cur = slide.styles?.[selection.path] || {}
      const next = { ...cur, ...patch }
      for (const k of Object.keys(next)) if (next[k] == null) delete next[k]
      const styles = { ...(slide.styles || {}) }
      if (Object.keys(next).length) styles[selection.path] = next
      else delete styles[selection.path]
      slides[activeIndex] = { ...slide, styles: Object.keys(styles).length ? styles : undefined }
      return { ...d, slides }
    })
  }

  // NL tweak: the server calls the model with the slide (or deck) JSON plus
  // the selection context and revalidates. We run in PREVIEW mode (nothing
  // persists yet): the returned deck is shown in the canvas and the user
  // Accepts (persist) or Discards (restore `before`). `overrideInstruction`
  // lets the recompose button run a canned instruction.
  const runTweak = async (instructionArg, { label } = {}) => {
    const instruction = (instructionArg ?? tweak).trim()
    if (!instruction || tweaking) return
    setTweaking(true)
    try {
      // freeform slides scope the tweak to the selection: a MULTI selection is
      // a region (server edits only those elements), a single is one element;
      // the server splices the answer back so the rest of the slide is safe
      const elSel =
        isFreeform && !tweakWholeDeck
          ? selectedElIds.length > 1
            ? { elementIds: selectedElIds }
            : selectedEl
              ? { elementId: selectedEl.id, label: selectedElLabel, text: selectedEl.text || '' }
              : null
          : null
      const r = await postJSON(`/api/decks/${deck.id}/tweak`, {
        instruction,
        slideIndex: tweakWholeDeck ? null : activeIndex,
        selection: tweakWholeDeck ? null : isFreeform ? elSel : selection,
        preview: true,
      })
      // stash the pre-edit deck so Discard is a one-click revert
      setTweakPreview({ before: deck, label: label || instruction })
      skipNextSave.current = true // preview never autosaves until accepted
      setDeck(r.deck)
      if (r.usage) setTweakCost({ usage: r.usage, model: r.model })
      setTweak('')
    } catch (e) {
      pushToast?.(e.message || t('deckStudio.tweakError'))
    } finally {
      setTweaking(false)
    }
  }
  const submitTweak = () => runTweak()

  const acceptTweak = () => {
    if (!tweakPreview) return
    // persist the previewed deck as-is
    patchJSON(`/api/decks/${deck.id}`, {
      title: deck.title,
      slides: deck.slides,
      audience: deck.audience,
      author: deck.author,
      narrative: deck.narrative,
    }).catch((e) => pushToast?.(e.message))
    skipNextSave.current = true
    setTweakHistory((h) => [{ label: tweakPreview.label, at: Date.now() }, ...h].slice(0, 20))
    setTweakPreview(null)
    setSelection(null)
    setSelectedElIds([])
    setScopeId(null)
  }

  const discardTweak = () => {
    if (!tweakPreview) return
    skipNextSave.current = true // restoring the old deck must not PATCH
    setDeck(tweakPreview.before)
    setTweakPreview(null)
  }

  // canned "improve this slide's layout" recomposition — runs through the
  // same preview flow so the user sees it before it lands
  const recomposeSlide = () => {
    runTweak(
      'Melhore a COMPOSIÇÃO visual deste slide mantendo exatamente o mesmo conteúdo (textos, números e dados idênticos): melhore alinhamento, hierarquia, espaçamento e agrupamento dos elementos para um layout denso e profissional, no estilo do design system. Não invente dados novos nem remova informação.',
      { label: t('deckStudio.tweak.recompose') }
    )
  }

  const addSlide = () => {
    setDeck((d) => {
      const slides = [...d.slides]
      slides.splice(activeIndex + 1, 0, emptySlide())
      return { ...d, slides }
    })
    setActiveIndex((i) => i + 1)
  }

  const addFreeformSlide = () => {
    setDeck((d) => {
      const slides = [...d.slides]
      slides.splice(activeIndex + 1, 0, { layout: 'freeform', elements: [] })
      return { ...d, slides }
    })
    setActiveIndex((i) => i + 1)
  }

  // --- element canvas handlers (freeform slides) -----------------------------

  const changeElements = (nextElements, { commit = false } = {}) => {
    if (commit) history.commit(deck)
    updateSlide(activeIndex, { elements: nextElements })
  }

  // tree-aware selection: nodes may live nested inside groups
  const selectedEl =
    slide?.layout === 'freeform' && selectedElIds.length === 1 ? findNode(slide.elements || [], selectedElIds[0]) : null
  const selectedElLabel = selectedEl
    ? selectedEl.name ||
      ({ text: t('deckStudio.elType.text'), shape: t('deckStudio.elType.shape'), line: t('deckStudio.elType.line'), icon: t('deckStudio.elType.icon'), image: t('deckStudio.elType.image'), chart: t('deckStudio.elType.chart'), group: t('deckStudio.elType.group') }[selectedEl.type] || selectedEl.type)
    : null

  const patchSelectedEl = (patch, commit = true) => {
    if (!selectedEl) return
    if (commit) history.commit(deck)
    updateSlide(activeIndex, {
      elements: updateNode(slide.elements || [], selectedEl.id, (n) => {
        const next = { ...n, ...patch }
        for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
        return next
      }),
    })
  }

  const patchSelectedElStyle = (patch, commit = true) => {
    if (!selectedEl) return
    const style = { ...(selectedEl.style || {}), ...patch }
    for (const k of Object.keys(style)) if (style[k] === undefined) delete style[k]
    patchSelectedEl({ style }, commit)
  }

  // patch the PARENT group of the selected element (e.g. to free its children
  // from auto-layout so they become individually draggable) — the inspector
  // surfaces this on a stack child; no-op if the element is top-level
  const patchSelectedElParent = (patch, commit = true) => {
    if (!selectedEl) return
    const { parent } = findParent(slide.elements || [], selectedEl.id)
    if (!parent) return
    if (commit) history.commit(deck)
    updateSlide(activeIndex, {
      elements: updateNode(slide.elements || [], parent.id, (n) => {
        const next = { ...n, ...patch }
        for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
        return next
      }),
    })
  }

  const reorderSelectedEl = (dir) => {
    if (!selectedEl) return
    const { parent, index } = findParent(slide.elements || [], selectedEl.id)
    const list = parent ? [...(parent.children || [])] : [...(slide.elements || [])]
    const j = Math.max(0, Math.min(list.length - 1, index + dir))
    if (index === j || index === -1) return
    const [node] = list.splice(index, 1)
    list.splice(j, 0, node)
    changeElements(parent ? updateNode(slide.elements, parent.id, (g) => ({ ...g, children: list })) : list, { commit: true })
  }

  const removeSelectedEls = () => {
    if (!selectedElIds.length) return
    changeElements(removeNodes(slide.elements || [], selectedElIds), { commit: true })
    setSelectedElIds([])
  }

  const groupSelectedEls = () => {
    if (selectedElIds.length < 2) return
    const { elements: next, groupId } = groupNodes(slide.elements || [], selectedElIds, resolvePreviewTheme(template))
    if (!groupId) return
    changeElements(next, { commit: true })
    setSelectedElIds([groupId])
  }

  const ungroupSelectedEl = () => {
    if (selectedEl?.type !== 'group') return
    const { elements: next, ids } = ungroupNode(slide.elements || [], selectedEl.id, resolvePreviewTheme(template))
    changeElements(next, { commit: true })
    setSelectedElIds(ids)
    if (scopeId === selectedEl.id) setScopeId(null)
  }

  // multi-selection batch ops (align/distribute operate on absolute boxes;
  // batch style merges one patch into every selected node) — one undo step
  const alignSelectedEls = (edge) => {
    if (selectedElIds.length < 2) return
    changeElements(alignNodes(slide.elements || [], selectedElIds, edge, resolvePreviewTheme(template)), { commit: true })
  }
  const distributeSelectedEls = (axis) => {
    if (selectedElIds.length < 3) return
    changeElements(distributeNodes(slide.elements || [], selectedElIds, axis, resolvePreviewTheme(template)), { commit: true })
  }
  const batchStyleSelectedEls = (patch) => {
    if (selectedElIds.length < 2) return
    changeElements(patchNodesStyle(slide.elements || [], selectedElIds, patch), { commit: true })
  }

  const addElement = (el) => {
    history.commit(deck)
    // adding inside the open group keeps the flow "drill in, keep building"
    if (scopeId) {
      const scoped = updateNode(slide?.elements || [], scopeId, (g) => ({ ...g, children: [...(g.children || []), el] }))
      updateSlide(activeIndex, { elements: scoped })
    } else {
      updateSlide(activeIndex, { elements: [...(slide?.elements || []), el] })
    }
    setSelectedElIds([el.id])
  }

  // drag-to-create: the canvas hands back the drawn frame (or just x/y for a
  // click); we seed a themed default element, override its box, add it, and
  // return the id so the canvas can jump into text editing
  const createElement = (type, box, extra = {}) => {
    const el = { ...defaultElement(type, resolvePreviewTheme(template)), ...extra }
    if (box) el.box = { ...el.box, ...box }
    addElement(el)
    return el.id
  }

  // one-shot semantic → freeform conversion (shared/deckLayout.js generators);
  // the original semantic fields ride along as `source` so reverting is free
  const canConvert = (() => {
    if (!slide || isFreeform || !CONVERTIBLE_LAYOUTS.has(slide.layout)) return false
    // composites (table/diagram/mined diagramSpec) may decline when the grid
    // would blow the per-slide element budget — probe the real materialization
    if (slide.layout === 'table' || slide.layout === 'diagram' || slide.diagramSpec) {
      try {
        return !!materializeSlide(slide, resolveDeckTheme(template), {})
      } catch {
        return false
      }
    }
    return true
  })()
  const convertToFreeform = () => {
    if (!canConvert) return
    if (
      !window.confirm(t('deckStudio.convertConfirm'))
    )
      return
    const mat = materializeSlide(slide, resolveDeckTheme(template), {
      index: activeIndex,
      total: deck.slides.length,
      pageNumber: activeIndex + 1,
      sectionNo: deck.slides.slice(0, activeIndex + 1).filter((x) => x.layout === 'section').length,
      meta: deck.audience || deck.title || '',
      audience: deck.audience || '',
      deckTitle: deck.title,
      author: deck.author || '',
    })
    if (!mat) return
    history.commit(deck)
    const { styles: _styles, ...source } = slide
    setDeck((d) => {
      const slides = [...d.slides]
      slides[activeIndex] = {
        layout: 'freeform',
        elements: mat.elements,
        ...(mat.background ? { background: mat.background } : {}),
        ...(slide.notes ? { notes: slide.notes } : {}),
        source,
      }
      return { ...d, slides }
    })
    setSelectedElIds([])
    setScopeId(null)
    setSelection(null)
  }

  const duplicateSlide = () => {
    setDeck((d) => {
      const slides = [...d.slides]
      slides.splice(activeIndex + 1, 0, JSON.parse(JSON.stringify(slides[activeIndex])))
      return { ...d, slides }
    })
    setActiveIndex((i) => i + 1)
  }

  const deleteSlide = () => {
    setDeck((d) => {
      if (d.slides.length <= 1) return d
      const slides = d.slides.filter((_, i) => i !== activeIndex)
      return { ...d, slides }
    })
    setActiveIndex((i) => Math.max(0, Math.min(i, (deck?.slides.length || 2) - 2)))
  }

  const reorder = (from, to) => {
    if (from === to) return
    setDeck((d) => {
      const slides = [...d.slides]
      const [moved] = slides.splice(from, 1)
      slides.splice(to, 0, moved)
      return { ...d, slides }
    })
    setActiveIndex(to)
  }

  const triggerDownload = (blob) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(deck.title || 'apresentacao').replace(/[^\w-]+/g, '_').slice(0, 60)}.pptx`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const exportPptx = async () => {
    setExporting(true)
    try {
      if (isHtmlDeck) {
        // Pure-HTML deck: export native editable shapes (like Claude Design).
        // Render every slide full-size off-screen, extract paint-ops off the DOM,
        // and POST them; the server assembles the .pptx with pptxgenjs.
        const slidesHtml = (deck.slides || []).map((s) => (typeof s === 'string' ? s : s?.html))
        const slidesOps = await extractOpsFromSlides(slidesHtml, () => buildDeckTokenStyle(template))
        const res = await fetch(`/api/decks/${deck.id}/export-html`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slides: slidesOps }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        triggerDownload(await res.blob())
        return
      }
      const res = await fetch(`/api/decks/${deck.id}/export`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      triggerDownload(await res.blob())
    } catch (e) {
      pushToast?.(e.message || t('deckStudio.exportError'))
    } finally {
      setExporting(false)
    }
  }

  // watermarks never usable, same gate as usableIconAssets in server/blocks.js
  const iconOptions = (template?.iconAssets || []).filter((a) => !a.kind || a.kind === 'icon')
  // mined vector diagrams from the active design system (see pptxMining.js) —
  // user-pickable onto `image` slides; the PATCH revalidates via sanitizeDiagramSpec
  const diagramOptions = (template?.minedStyle?.diagrams || []).filter((d) => d?.shapes?.length)

  return (
    <div
      className={`fixed inset-0 z-[70] flex flex-col bg-[var(--bg)] animate-fade-in
                 md:static md:inset-auto md:z-auto md:h-full
                 md:border-l md:border-[var(--border)] ${
                   focus || (htmlEditMode && isHtmlDeck)
                     ? 'md:flex-1 md:min-w-0'
                     : 'md:shrink-0 md:w-[45%] md:min-w-[420px] md:max-w-[760px]'
                 }`}
    >
      {/* toolbar */}
      <header className="shrink-0 h-14 flex items-center gap-2 md:gap-3 px-3 md:px-4 border-b border-[var(--border)]">
        <button onClick={onClose} className="p-2 -ml-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]">
          <Icon.Close size={20} />
        </button>
        <Icon.Presentation size={18} className="text-[var(--accent)]" />
        {deck ? (
          <input
            value={deck.title}
            onChange={(e) => setDeck((d) => ({ ...d, title: e.target.value }))}
            className="font-semibold text-sm bg-transparent outline-none border-b border-transparent focus:border-[var(--accent)] min-w-0 flex-1 md:flex-none md:max-w-md"
          />
        ) : (
          <span className="font-semibold text-sm">{t('deckStudio.title')}</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {isHtmlDeck && deck && !deck.streaming && (
            <button
              onClick={() => {
                setHtmlEditMode((v) => {
                  const next = !v
                  if (!next) {
                    setHtmlSel(null)
                    htmlEditorRef.current?.clear()
                  }
                  return next
                })
              }}
              className={`flex items-center gap-1.5 rounded-lg font-semibold text-xs px-2.5 py-1.5 transition ${
                htmlEditMode
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]'
                  : 'text-[var(--muted)] hover:bg-[var(--surface-3)] border border-transparent'
              }`}
              title={t('deckStudio.htmlEdit.toggleTitle')}
            >
              <Icon.Pencil size={14} /> <span className="hidden sm:inline">{t('deckStudio.htmlEdit.toggle')}</span>
            </button>
          )}
          <button
            onClick={onToggleFocus}
            className="hidden md:block p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]"
            title={focus ? t('deckStudio.toolbar.shrink') : t('deckStudio.toolbar.expand')}
          >
            {focus ? <Icon.Shrink size={16} /> : <Icon.Expand size={16} />}
          </button>
          <button
            onClick={() => setPresenting(true)}
            disabled={!deck}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-40"
            title={t('deckStudio.toolbar.present')}
          >
            <Icon.Play size={16} />
          </button>
          <button
            onClick={addSlide}
            disabled={!deck}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-40"
            title={t('deckStudio.toolbar.addSlide')}
          >
            <Icon.Plus size={17} />
          </button>
          <button
            onClick={addFreeformSlide}
            disabled={!deck}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-40"
            title={t('deckStudio.toolbar.addFreeform')}
          >
            <Icon.Edit size={16} />
          </button>
          <button
            onClick={duplicateSlide}
            disabled={!deck}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-40"
            title={t('deckStudio.toolbar.duplicate')}
          >
            <Icon.Copy size={16} />
          </button>
          <button
            onClick={deleteSlide}
            disabled={!deck || deck.slides.length <= 1}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-40"
            title={t('deckStudio.toolbar.deleteSlide')}
          >
            <Icon.Trash size={16} />
          </button>
          <button
            onClick={exportPptx}
            disabled={!deck || exporting}
            className="ml-1 md:ml-2 shrink-0 flex items-center gap-1.5 rounded-xl bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white font-semibold text-sm px-3 md:px-3.5 py-2 transition"
          >
            <Icon.Download size={15} /> <span className="hidden sm:inline">{exporting ? t('deckStudio.exporting') : t('deckStudio.exportPptx')}</span>
          </button>
        </div>
      </header>

      {loadError && !loading ? (
        <div className="flex-1 grid place-items-center">
          <div className="flex flex-col items-center gap-3 text-center px-6">
            <p className="text-sm text-[var(--muted)] max-w-sm">{t('deckStudio.loadFailed', { error: loadError })}</p>
            <button
              onClick={() => setLoadTick((n) => n + 1)}
              className="rounded-xl bg-[var(--accent)] hover:brightness-110 text-white font-semibold text-sm px-4 py-2 transition"
            >
              {t('deckStudio.retry')}
            </button>
          </div>
        </div>
      ) : loading || !deck ? (
        <div className="flex-1 grid place-items-center text-sm text-[var(--faint)]">{t('deckStudio.loading')}</div>
      ) : isHtmlDeck ? (
        // Pure-HTML deck layout (Claude-Design-style): thumbnail rail · stage +
        // speaker notes · (Edit mode) DOM inspector. The stage swaps between the
        // read-only frame and the directly-editable one based on htmlEditMode.
        <div className="flex-1 flex flex-col md:flex-row min-h-0">
          {/* thumbnail rail */}
          <div className="flex md:block shrink-0 md:w-52 gap-2 md:gap-0 border-b md:border-b-0 md:border-r border-[var(--border)] overflow-x-auto md:overflow-x-visible md:overflow-y-auto p-3 md:space-y-2">
            {deck.slides.map((s, i) => (
              <div
                key={i}
                draggable
                onDragStart={() => (dragFrom.current = i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  reorder(dragFrom.current, i)
                  dragFrom.current = null
                }}
                onClick={() => setActiveIndex(i)}
                className={`relative rounded-lg cursor-pointer ring-2 transition animate-fade-in shrink-0 w-32 md:w-auto ${
                  i === activeIndex ? 'ring-[var(--accent)]' : 'ring-transparent hover:ring-[var(--border)]'
                }`}
                style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
              >
                <HtmlSlideFrame html={typeof s === 'string' ? s : s?.html} template={template} title={`${deck.title} — ${i + 1}`} className="rounded-lg" />
                <span className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-[var(--surface-3)] border border-[var(--border)] text-[10px] font-semibold grid place-items-center">
                  {i + 1}
                </span>
              </div>
            ))}
          </div>

          {/* stage + create toolbar + AI bar + speaker notes */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            {/* create-asset toolbar (Edit mode only) */}
            {htmlEditMode && slide && (
              <div className="shrink-0 flex items-center justify-center gap-2 px-6 pt-3 pb-1 animate-fade-in">
                <HtmlEditToolbar
                  tool={htmlTool}
                  onTool={(tName) => {
                    setHtmlTool(tName)
                    htmlEditorRef.current?.setTool(tName)
                  }}
                  onImage={(dataUrl) => htmlEditorRef.current?.createImage(dataUrl)}
                  onUndo={htmlUndo}
                  onRedo={htmlRedo}
                  canUndo={htmlHist.current.past.length > 0}
                  canRedo={htmlHist.current.future.length > 0}
                />
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-2 pb-2">
              <div className="mx-auto w-full" style={{ maxWidth: 'calc((100dvh - 15rem) * 1.7778)' }}>
                {slide ? (
                  htmlEditMode ? (
                    <HtmlSlideEditor
                      ref={htmlEditorRef}
                      html={slideHtml(slide)}
                      template={template}
                      tool={htmlTool}
                      title={`${deck.title} — ${activeIndex + 1}`}
                      className={`w-full rounded-lg shadow-lg ring-1 ring-[var(--accent)]/40 ${htmlTool !== 'select' ? 'cursor-crosshair' : ''}`}
                      onSelect={(paths, info) => setHtmlSel({ paths, info })}
                      onDeselect={() => setHtmlSel(null)}
                      onChange={(newHtml) => setHtmlSlide(activeIndex, newHtml)}
                      onContextMenu={(m) => setHtmlMenu(m)}
                      onToolDone={() => setHtmlTool('select')}
                    />
                  ) : (
                    <HtmlSlideFrame
                      html={slideHtml(slide)}
                      template={template}
                      title={`${deck.title} — ${activeIndex + 1}`}
                      className="w-full rounded-lg shadow-lg"
                    />
                  )
                ) : (
                  <HtmlSlideSkeleton streaming={deck.streaming} label={t('deckStudio.building')} />
                )}
                {htmlEditMode && slide && (
                  <p className="text-[11px] text-[var(--faint)] text-center mt-2">
                    {htmlTool === 'select' ? t('deckStudio.htmlEdit.canvasHint') : t('deckStudio.htmlEdit.drawHint')}
                  </p>
                )}
              </div>
            </div>

            {/* AI edit bar (Edit mode) — slide / deck / selected element, with a
                reversible preview (Accept / Discard). */}
            {htmlEditMode && slide && (
              <div className="shrink-0 px-6 pb-1">
                <div className="mx-auto w-full" style={{ maxWidth: 'calc((100dvh - 15rem) * 1.7778)' }}>
                  {tweakPreview ? (
                    <div className="flex items-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2 animate-fade-in">
                      <Icon.Wand size={14} className="text-[var(--accent)] shrink-0" />
                      <span className="text-xs text-[var(--text)] flex-1 min-w-0 truncate" title={tweakPreview.label}>
                        {t('deckStudio.tweak.previewLabel', { label: tweakPreview.label })}
                      </span>
                      {tweakCost && <CostBadge usage={tweakCost.usage} model={tweakCost.model} models={models} className="text-[11px] shrink-0" />}
                      <button onClick={discardHtmlTweak} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[var(--muted)] font-semibold text-xs px-2.5 py-1.5 shrink-0">
                        {t('deckStudio.tweak.discard')}
                      </button>
                      <button onClick={acceptHtmlTweak} className="rounded-lg bg-[var(--accent)] hover:brightness-110 text-white font-semibold text-xs px-2.5 py-1.5 shrink-0">
                        {t('deckStudio.tweak.accept')}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 flex items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-2.5">
                        <Icon.Wand size={14} className="text-[var(--accent)] shrink-0" />
                        <input
                          value={tweak}
                          onChange={(e) => setTweak(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && submitHtmlTweak()}
                          placeholder={
                            tweakWholeDeck
                              ? t('deckStudio.tweak.placeholderDeck')
                              : htmlSel && !htmlSel.info?.multi
                                ? t('deckStudio.htmlEdit.aiPlaceholderEl')
                                : t('deckStudio.tweak.placeholderSlide')
                          }
                          disabled={tweaking}
                          className="flex-1 bg-transparent text-sm py-2 outline-none placeholder:text-[var(--faint)] disabled:opacity-50"
                        />
                      </div>
                      <button
                        onClick={submitHtmlTweak}
                        disabled={!tweak.trim() || tweaking}
                        className="rounded-xl bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white font-semibold text-xs px-3 py-2.5 transition shrink-0 inline-flex items-center gap-1.5"
                      >
                        {tweaking && <span className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden />}
                        {t('deckStudio.tweak.apply')}
                      </button>
                    </div>
                  )}
                  {!tweakPreview && (
                    <label className="flex items-center gap-1.5 text-[10px] text-[var(--muted)] cursor-pointer w-fit mt-1">
                      <input type="checkbox" checked={tweakWholeDeck} onChange={(e) => setTweakWholeDeck(e.target.checked)} />
                      {t('deckStudio.tweak.wholeDeckToggle')}
                    </label>
                  )}
                </div>
              </div>
            )}

            {/* speaker notes — always editable (converts a string slide to {html,notes}) */}
            <div className="shrink-0 border-t border-[var(--border)] px-6 py-2.5">
              <div className="mx-auto w-full flex items-start gap-2" style={{ maxWidth: 'calc((100dvh - 15rem) * 1.7778)' }}>
                <label className="text-[10px] font-semibold uppercase tracking-wide text-[var(--faint)] w-20 shrink-0 pt-1.5">
                  {t('deckStudio.field.notes')}
                </label>
                <textarea
                  value={(typeof slide === 'object' && slide?.notes) || ''}
                  onChange={(e) => updateSlide(activeIndex, { notes: e.target.value })}
                  rows={1}
                  disabled={!slide}
                  placeholder={t('deckStudio.field.notesPlaceholder')}
                  className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)] disabled:opacity-50"
                />
              </div>
            </div>
          </div>

          {/* DOM inspector — only in Edit mode */}
          {htmlEditMode && slide && (
            <div className="shrink-0 md:w-72 border-t md:border-t-0 md:border-l border-[var(--border)] bg-[var(--surface-2)] flex flex-col min-h-0 max-h-[45vh] md:max-h-none animate-fade-in">
              <HtmlSlideInspector
                html={slideHtml(slide)}
                selectedPaths={htmlSel?.paths ?? []}
                selectedInfo={htmlSel?.info ?? null}
                onSelectPath={(path, additive) => {
                  const cur = htmlSel?.paths || []
                  const next = additive ? (cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]) : [path]
                  htmlEditorRef.current?.select(next)
                }}
                onStyle={(style) => htmlEditorRef.current?.applyStyle(htmlSel?.paths, style)}
                onText={(text) => {
                  const p = htmlSel?.paths?.[0]
                  if (!p) return
                  setHtmlSel((s) => (s ? { ...s, info: { ...s.info, text } } : s))
                  htmlEditorRef.current?.setText(p, text)
                }}
                onAttr={(attr, value) => {
                  const p = htmlSel?.paths?.[0]
                  if (p) htmlEditorRef.current?.setAttr(p, attr, value)
                }}
                onOp={(op) => htmlOp(op)}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col md:flex-row min-h-0">
          {/* thumbnail rail: horizontal filmstrip on mobile, vertical rail on md+ */}
          <div className="flex md:block shrink-0 md:w-56 gap-2 md:gap-0 border-b md:border-b-0 md:border-r border-[var(--border)] overflow-x-auto md:overflow-x-visible md:overflow-y-auto p-3 md:space-y-2">
            {deck.slides.map((s, i) => (
              <div
                key={i}
                draggable
                onDragStart={() => (dragFrom.current = i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  reorder(dragFrom.current, i)
                  dragFrom.current = null
                }}
                onClick={() => setActiveIndex(i)}
                className={`relative rounded-lg cursor-pointer ring-2 transition animate-fade-in shrink-0 w-32 md:w-auto ${
                  i === activeIndex ? 'ring-[var(--accent)]' : 'ring-transparent hover:ring-[var(--border)]'
                }`}
                style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
              >
                {isHtmlDeck ? (
                  <HtmlSlideFrame html={typeof s === 'string' ? s : s?.html} template={template} title={`${deck.title} — ${i + 1}`} className="rounded-lg" />
                ) : (
                  <DeckSlidePreview
                    slide={s}
                    template={template}
                    deck={deck}
                    deckTitle={deck.title}
                    variant="thumb"
                    pageNumber={i + 1}
                    sectionNo={deck.slides.slice(0, i + 1).filter((x) => x.layout === 'section').length}
                  />
                )}
                <span className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-[var(--surface-3)] border border-[var(--border)] text-[10px] font-semibold grid place-items-center">
                  {i + 1}
                </span>
              </div>
            ))}
          </div>

          {/* canvas area: the slide stage and its action bars stay pinned
              (the active slide is always 100% visible); only the editing
              panel, below the stage, scrolls. The stage takes 100% of the
              studio's remaining width, capped only so the whole 16:9 slide
              still fits the viewport height (rem budget = header + action
              bars + paddings + a sliver of the fields panel). */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="contents">
            <div className="shrink-0 px-6 pt-4 pb-2">
              <div
                className="mx-auto w-full"
                style={{ maxWidth: 'calc((100dvh - 19rem) * 1.7778)' }}
                onClick={() => !isFreeform && setSelection(null)}
              >
                {isHtmlDeck ? (
                  slide ? (
                    <HtmlSlideFrame
                      html={typeof slide === 'string' ? slide : slide?.html}
                      template={template}
                      title={`${deck.title} — ${activeIndex + 1}`}
                      className="w-full rounded-lg shadow-lg"
                    />
                  ) : (
                    <HtmlSlideSkeleton streaming={deck.streaming} label={t('deckStudio.building')} />
                  )
                ) : isFreeform ? (
                  <ElementCanvas
                    slide={slide}
                    template={template}
                    selectedIds={selectedElIds}
                    onSelect={setSelectedElIds}
                    scopeId={scopeId}
                    onScope={setScopeId}
                    onChangeElements={changeElements}
                    tool={tool}
                    onCreateElement={createElement}
                    onToolDone={() => setTool(null)}
                    className="w-full shadow-lg"
                  />
                ) : (
                  <DeckSlidePreview
                    slide={slide}
                    template={template}
                    deck={deck}
                    deckTitle={deck.title}
                    variant="canvas"
                    className="w-full shadow-lg"
                    pageNumber={activeIndex + 1}
                    sectionNo={deck.slides.slice(0, activeIndex + 1).filter((x) => x.layout === 'section').length}
                    selectable
                    selectedPath={selection?.path || null}
                    onSelectElement={(path, label, text) => setSelection({ path, label, text })}
                    onEditText={editSlideText}
                  />
                )}
              </div>
            </div>

            {/* selected-object style toolbar (Edit mode) — not shown for HTML
                decks, which have no element/selection model (edits via NL bar). */}
            <div className="shrink-0 mx-auto w-full px-6" style={{ maxWidth: 'calc((100dvh - 19rem) * 1.7778 + 3rem)' }}>
              {isHtmlDeck ? null : isFreeform ? (
                <div className="flex items-center justify-between gap-2">
                  <AddElementBar
                    theme={resolvePreviewTheme(template)}
                    onAdd={addElement}
                    tool={tool}
                    onArmTool={(next) => setTool((cur) => (cur?.type === next?.type ? null : next))}
                    canGroup={selectedElIds.length > 1}
                    canUngroup={selectedEl?.type === 'group'}
                    onGroup={groupSelectedEls}
                    onUngroup={ungroupSelectedEl}
                  />
                  <span className="text-[10px] text-[var(--faint)] hidden md:block">
                    {t('deckStudio.canvasHint')}
                  </span>
                </div>
              ) : selection ? (
                <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-xs">
                  <span className="font-medium text-[var(--accent)] truncate max-w-[10rem]" title={selection.path}>
                    {selection.label || selection.path}
                  </span>
                  <span className="text-[var(--faint)]">·</span>
                  <label className="flex items-center gap-1 text-[var(--muted)]">
                    {t('deckStudio.styleBar.size')}
                    <input
                      type="number"
                      min={6}
                      max={96}
                      step={0.5}
                      value={slide.styles?.[selection.path]?.fontSize ?? ''}
                      placeholder="auto"
                      onChange={(e) => patchSelStyle({ fontSize: e.target.value === '' ? null : Number(e.target.value) })}
                      className="w-14 rounded-md bg-[var(--surface)] border border-[var(--border)] px-1.5 py-0.5 outline-none focus:border-[var(--accent)]"
                    />
                  </label>
                  <input
                    type="color"
                    value={slide.styles?.[selection.path]?.color || '#000000'}
                    onChange={(e) => patchSelStyle({ color: e.target.value.toUpperCase() })}
                    className="w-6 h-6 rounded cursor-pointer border border-[var(--border)] bg-transparent"
                    title={t('deckStudio.styleBar.textColor')}
                  />
                  {[
                    ['bold', 'B', 'font-bold'],
                    ['italic', 'I', 'italic'],
                  ].map(([key, glyph, cls]) => (
                    <button
                      key={key}
                      onClick={() => patchSelStyle({ [key]: slide.styles?.[selection.path]?.[key] ? null : true })}
                      className={`w-6 h-6 rounded-md border grid place-items-center ${cls} ${
                        slide.styles?.[selection.path]?.[key] ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] text-[var(--muted)]'
                      }`}
                    >
                      {glyph}
                    </button>
                  ))}
                  <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
                    {['left', 'center', 'right'].map((al) => (
                      <button
                        key={al}
                        onClick={() => patchSelStyle({ align: slide.styles?.[selection.path]?.align === al ? null : al })}
                        className={`px-1.5 py-0.5 ${slide.styles?.[selection.path]?.align === al ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'}`}
                        title={al === 'left' ? t('deckStudio.align.left') : al === 'center' ? t('deckStudio.align.center') : t('deckStudio.align.right')}
                      >
                        {al === 'left' ? '⇤' : al === 'center' ? '↔' : '⇥'}
                      </button>
                    ))}
                  </div>
                  <span className="text-[10px] text-[var(--faint)] ml-auto hidden sm:block">{t('deckStudio.styleBar.editHint')}</span>
                  <button onClick={() => setSelection(null)} className="p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--faint)]" title={t('deckStudio.styleBar.clearSelection')}>
                    <Icon.Close size={12} />
                  </button>
                </div>
              ) : (
                <p className="text-[10px] text-[var(--faint)] px-1">
                  {t('deckStudio.styleBar.selectHint')}
                </p>
              )}
            </div>

            {/* NL tweak bar */}
            <div className="shrink-0 mx-auto w-full px-6 pt-2 pb-1" style={{ maxWidth: 'calc((100dvh - 19rem) * 1.7778 + 3rem)' }}>
              {tweakPreview ? (
                // preview banner: the shown deck is a pending AI edit — Accept
                // persists it, Discard restores the pre-edit deck
                <div className="flex items-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2 animate-fade-in">
                  <Icon.Wand size={14} className="text-[var(--accent)] shrink-0" />
                  <span className="text-xs text-[var(--text)] flex-1 min-w-0 truncate" title={tweakPreview.label}>
                    {t('deckStudio.tweak.previewLabel', { label: tweakPreview.label })}
                  </span>
                  {tweakCost && (
                    <CostBadge usage={tweakCost.usage} model={tweakCost.model} models={models} className="text-[11px] shrink-0" />
                  )}
                  <button onClick={discardTweak} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:brightness-110 text-[var(--muted)] font-semibold text-xs px-2.5 py-1.5 shrink-0">
                    {t('deckStudio.tweak.discard')}
                  </button>
                  <button onClick={acceptTweak} className="rounded-lg bg-[var(--accent)] hover:brightness-110 text-white font-semibold text-xs px-2.5 py-1.5 shrink-0">
                    {t('deckStudio.tweak.accept')}
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 flex items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-2.5">
                      <Icon.Wand size={14} className="text-[var(--accent)] shrink-0" />
                      <input
                        value={tweak}
                        onChange={(e) => setTweak(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && submitTweak()}
                        placeholder={
                          tweakWholeDeck
                            ? t('deckStudio.tweak.placeholderDeck')
                            : isFreeform && selectedElIds.length > 1
                              ? t('deckStudio.tweak.placeholderRegion', { n: selectedElIds.length })
                              : isFreeform && selectedEl
                                ? t('deckStudio.tweak.placeholderLayer', { label: selectedElLabel })
                                : selection
                                  ? t('deckStudio.tweak.placeholderSelection', { label: selection.label })
                                  : t('deckStudio.tweak.placeholderSlide')
                        }
                        disabled={tweaking}
                        className="flex-1 bg-transparent text-sm py-2 outline-none placeholder:text-[var(--faint)] disabled:opacity-50"
                      />
                    </div>
                    {isFreeform && !tweakWholeDeck && (
                      <button
                        onClick={recomposeSlide}
                        disabled={tweaking}
                        title={t('deckStudio.tweak.recomposeTitle')}
                        className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] hover:brightness-110 disabled:opacity-50 text-[var(--muted)] font-semibold text-xs px-3 py-2.5 transition shrink-0 inline-flex items-center gap-1.5"
                      >
                        <Icon.Sparkle size={13} /> <span className="hidden sm:inline">{t('deckStudio.tweak.recompose')}</span>
                      </button>
                    )}
                    <button
                      onClick={submitTweak}
                      disabled={!tweak.trim() || tweaking}
                      className="rounded-xl bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white font-semibold text-xs px-3 py-2.5 transition shrink-0 inline-flex items-center gap-1.5"
                    >
                      {tweaking && (
                        <span className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden />
                      )}
                      {t('deckStudio.tweak.apply')}
                    </button>
                  </div>
                  {tweaking && (
                    <div className="flex items-center gap-1.5 text-[11px] text-[var(--accent)] mt-1.5 animate-fade-in">
                      <span className="w-2.5 h-2.5 rounded-full border-2 border-[var(--accent)]/40 border-t-[var(--accent)] animate-spin" aria-hidden />
                      <span>
                        {tweakWholeDeck
                          ? t('deckStudio.tweak.applyingDeck')
                          : isFreeform && selectedElIds.length > 1
                            ? t('deckStudio.tweak.editingRegion', { n: selectedElIds.length })
                            : isFreeform && selectedEl
                              ? t('deckStudio.tweak.editingLayer', { label: selectedElLabel })
                              : selection
                                ? t('deckStudio.tweak.editingSelection', { label: selection.label })
                                : t('deckStudio.tweak.applyingSlide')}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between mt-1">
                    <label className="flex items-center gap-1.5 text-[10px] text-[var(--muted)] cursor-pointer w-fit">
                      <input type="checkbox" checked={tweakWholeDeck} onChange={(e) => setTweakWholeDeck(e.target.checked)} />
                      {t('deckStudio.tweak.wholeDeckToggle')}
                    </label>
                    {tweakHistory.length > 0 && (
                      <span className="text-[10px] text-[var(--faint)] truncate max-w-[60%]" title={tweakHistory.map((h) => `• ${h.label}`).join('\n')}>
                        {t('deckStudio.tweak.historyLast', { label: tweakHistory[0].label })}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

            {/* editable fields — the only scrollable region, below the stage;
                width-matched to the stage so the inputs line up with the slide */}
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
            <div className="mx-auto w-full pb-8 space-y-3 px-6 pt-2" style={{ maxWidth: 'calc((100dvh - 19rem) * 1.7778 + 3rem)' }}>
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0">{t('deckStudio.field.deck')}</label>
                <input
                  value={deck.audience || ''}
                  onChange={(e) => setDeck((d) => ({ ...d, audience: e.target.value }))}
                  placeholder={t('deckStudio.field.audiencePlaceholder')}
                  className="flex-1 min-w-0 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                />
                <input
                  value={deck.author || ''}
                  onChange={(e) => setDeck((d) => ({ ...d, author: e.target.value }))}
                  placeholder={t('deckStudio.field.authorPlaceholder')}
                  className="flex-1 min-w-0 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                />
              </div>

              {!slide ? null : isHtmlDeck ? (
                <div className="text-xs text-[var(--faint)] rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 leading-relaxed">
                  {t('deckStudio.htmlSlideNote')}
                </div>
              ) : isFreeform ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0">{t('deckStudio.field.layout')}</label>
                    <div className="flex-1 flex items-center gap-2 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 text-[var(--muted)]">
                      {t('deckStudio.freeformLayout')}
                      {slide.source && (
                        <button
                          onClick={() => {
                            history.commit(deck)
                            setDeck((d) => {
                              const slides = [...d.slides]
                              slides[activeIndex] = slide.source
                              return { ...d, slides }
                            })
                            setSelectedElIds([])
                            setScopeId(null)
                          }}
                          className="ml-auto text-[11px] underline text-[var(--accent)]"
                          title={t('deckStudio.revertSemanticTitle')}
                        >
                          {t('deckStudio.revertSemantic')}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0">{t('deckStudio.field.background')}</label>
                    <input
                      type="color"
                      value={slide.background?.color || '#FFFFFF'}
                      onChange={(e) => {
                        history.commit(deck)
                        updateSlide(activeIndex, { background: { ...(slide.background || {}), color: e.target.value.toUpperCase(), plate: undefined } })
                      }}
                      className="w-7 h-7 rounded cursor-pointer border border-[var(--border)] bg-transparent"
                      title={t('deckStudio.backgroundColorTitle')}
                    />
                    <select
                      value={slide.background?.plate || ''}
                      onChange={(e) => {
                        history.commit(deck)
                        const plate = e.target.value || undefined
                        updateSlide(activeIndex, { background: plate ? { plate } : slide.background?.color ? { color: slide.background.color } : undefined })
                      }}
                      className="text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none"
                    >
                      <option value="">{t('deckStudio.plate.solid')}</option>
                      <option value="cover">{t('deckStudio.plate.cover')}</option>
                      <option value="section">{t('deckStudio.plate.section')}</option>
                    </select>
                  </div>
                  {/* layer tree (Claude-Design-style) — selection shared with the canvas */}
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden">
                    <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
                      <span className="text-xs font-semibold">{t('deckStudio.layers')}</span>
                      <span className="text-[9.5px] text-[var(--faint)]">{t('deckStudio.layersHint')}</span>
                    </div>
                    <div className="max-h-64 overflow-y-auto px-1.5 pb-1.5">
                      <LayerTree
                        elements={slide.elements || []}
                        selectedIds={selectedElIds}
                        onSelect={setSelectedElIds}
                        onChangeElements={changeElements}
                        template={template}
                      />
                    </div>
                  </div>
                  {selectedElIds.length > 1 ? (
                    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden">
                      <MultiSelectPanel
                        count={selectedElIds.length}
                        onGroup={groupSelectedEls}
                        onRemove={removeSelectedEls}
                        onAlign={alignSelectedEls}
                        onDistribute={distributeSelectedEls}
                        onBatchStyle={batchStyleSelectedEls}
                        theme={resolvePreviewTheme(template)}
                      />
                    </div>
                  ) : selectedEl ? (
                    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden">
                      <ElementInspector
                        element={selectedEl}
                        elements={slide.elements || []}
                        template={template}
                        onPatch={(patch, commit) => patchSelectedEl(patch, commit)}
                        onPatchStyle={(patch, commit) => patchSelectedElStyle(patch, commit)}
                        onPatchParent={(patch, commit) => patchSelectedElParent(patch, commit)}
                        onReorder={reorderSelectedEl}
                        onRemove={removeSelectedEls}
                        onUngroup={ungroupSelectedEl}
                      />
                    </div>
                  ) : (
                    <p className="text-[11px] text-[var(--faint)]">
                      {t('deckStudio.elementHint')}
                    </p>
                  )}
                </div>
              ) : (
              <>
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0">{t('deckStudio.field.layout')}</label>
                <select
                  value={slide.layout}
                  onChange={(e) => updateSlide(activeIndex, { layout: e.target.value })}
                  className="flex-1 min-w-0 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
                >
                  {LAYOUTS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {t(l.labelKey)}
                    </option>
                  ))}
                </select>
                {canConvert && (
                  <button
                    onClick={convertToFreeform}
                    className="shrink-0 flex items-center gap-1.5 rounded-lg bg-[var(--surface-3)] hover:brightness-110 text-xs font-semibold px-2.5 py-2"
                    title={t('deckStudio.convertTitle')}
                  >
                    <Icon.Edit size={13} /> {t('deckStudio.convertToFreeform')}
                  </button>
                )}
              </div>

              {slide.layout !== 'section' && slide.layout !== 'quote' && slide.layout !== 'closing' && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.kicker')}</label>
                  <input
                    value={slide.kicker || ''}
                    onChange={(e) => updateSlide(activeIndex, { kicker: e.target.value })}
                    placeholder={t('deckStudio.field.kickerPlaceholder')}
                    className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                  />
                </div>
              )}

              <div className="flex items-start gap-2">
                <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.heading')}</label>
                <input
                  value={slide.heading || ''}
                  onChange={(e) => updateSlide(activeIndex, { heading: e.target.value })}
                  className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
                />
              </div>

              <div className="flex items-start gap-2">
                <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.subheading')}</label>
                <input
                  value={slide.subheading || ''}
                  onChange={(e) => updateSlide(activeIndex, { subheading: e.target.value })}
                  className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
                />
              </div>

              {(slide.layout === 'bullets' || slide.layout === 'two-column') && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.bullets')}</label>
                  <textarea
                    value={(slide.bullets || []).join('\n')}
                    onChange={(e) => updateSlide(activeIndex, { bullets: e.target.value.split('\n') })}
                    rows={5}
                    placeholder={t('deckStudio.field.bulletsPlaceholder')}
                    className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none"
                  />
                </div>
              )}

              {slide.layout === 'agenda' && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.items')}</label>
                  <ItemListEditor
                    items={slide.items?.length ? slide.items : (slide.bullets || []).map((b) => ({ title: b }))}
                    fields={[['title', t('deckStudio.items.title')], ['body', t('deckStudio.items.body')]]}
                    iconOptions={null}
                    onChange={(items) => updateSlide(activeIndex, { items, bullets: undefined })}
                    addLabel={t('deckStudio.items.add')}
                  />
                </div>
              )}

              {slide.layout === 'diagram' && (
                <DiagramEditor slide={slide} onChange={(patch) => updateSlide(activeIndex, patch)} />
              )}

              {slide.layout === 'cards' && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.cards')}</label>
                  <ItemListEditor
                    items={slide.cards}
                    fields={[['heading', t('deckStudio.cards.heading')], ['body', t('deckStudio.cards.body')]]}
                    iconOptions={iconOptions}
                    onChange={(cards) => updateSlide(activeIndex, { cards })}
                    addLabel={t('deckStudio.cards.add')}
                  />
                </div>
              )}

              {slide.layout === 'stat-grid' && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.stats')}</label>
                  <ItemListEditor
                    items={slide.stats}
                    fields={[['value', t('deckStudio.stats.value')], ['label', t('deckStudio.stats.label')]]}
                    iconOptions={iconOptions}
                    onChange={(stats) => updateSlide(activeIndex, { stats })}
                    addLabel={t('deckStudio.stats.add')}
                  />
                </div>
              )}

              {slide.layout === 'comparison' && (
                <>
                  <div className="grid grid-cols-2 gap-2 pl-0 md:pl-[5.5rem]">
                    <input
                      value={slide.leftTitle || ''}
                      onChange={(e) => updateSlide(activeIndex, { leftTitle: e.target.value })}
                      placeholder={t('deckStudio.comparison.leftTitle')}
                      className="text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                    />
                    <input
                      value={slide.rightTitle || ''}
                      onChange={(e) => updateSlide(activeIndex, { rightTitle: e.target.value })}
                      placeholder={t('deckStudio.comparison.rightTitle')}
                      className="text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.bullets')}</label>
                    <div className="flex-1 grid grid-cols-2 gap-2">
                      <textarea
                        value={(slide.leftBullets || []).join('\n')}
                        onChange={(e) => updateSlide(activeIndex, { leftBullets: e.target.value.split('\n') })}
                        rows={4}
                        placeholder={t('deckStudio.comparison.leftBullets')}
                        className="text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
                      />
                      <textarea
                        value={(slide.rightBullets || []).join('\n')}
                        onChange={(e) => updateSlide(activeIndex, { rightBullets: e.target.value.split('\n') })}
                        rows={4}
                        placeholder={t('deckStudio.comparison.rightBullets')}
                        className="text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
                      />
                    </div>
                  </div>
                </>
              )}

              {slide.layout === 'timeline' && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.phases')}</label>
                  <ItemListEditor
                    items={slide.phases}
                    fields={[['label', t('deckStudio.phases.label')], ['period', t('deckStudio.phases.period')], ['body', t('deckStudio.phases.body')]]}
                    iconOptions={iconOptions}
                    onChange={(phases) => updateSlide(activeIndex, { phases })}
                    addLabel={t('deckStudio.phases.add')}
                  />
                </div>
              )}

              {slide.layout === 'table' && (
                <>
                  <div className="flex items-start gap-2">
                    <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.columns')}</label>
                    <input
                      value={(slide.columns || []).join(', ')}
                      onChange={(e) => updateSlide(activeIndex, { columns: e.target.value.split(',').map((s) => s.trim()) })}
                      placeholder={t('deckStudio.table.columnsPlaceholder')}
                      className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.rows')}</label>
                    <textarea
                      value={(slide.rows || []).map((r) => r.join(', ')).join('\n')}
                      onChange={(e) => updateSlide(activeIndex, { rows: e.target.value.split('\n').map((line) => line.split(',').map((s) => s.trim())) })}
                      rows={5}
                      placeholder={t('deckStudio.table.rowsPlaceholder')}
                      className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
                    />
                  </div>
                  <div className="flex items-center gap-4 pl-[5.5rem] text-[11px] text-[var(--muted)]">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={slide.cellStyle === 'level'}
                        onChange={(e) => updateSlide(activeIndex, { cellStyle: e.target.checked ? 'level' : undefined })}
                      />
                      {t('deckStudio.table.levelMatrix')}
                    </label>
                    <label className="flex items-center gap-1.5">
                      {t('deckStudio.table.highlightColumn')}
                      <select
                        value={Number.isInteger(slide.highlightColumn) ? slide.highlightColumn : ''}
                        onChange={(e) =>
                          updateSlide(activeIndex, { highlightColumn: e.target.value === '' ? undefined : Number(e.target.value) })
                        }
                        className="text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
                      >
                        <option value="">{t('deckStudio.table.noHighlight')}</option>
                        {(slide.columns || []).map((c, ci) => (
                          <option key={ci} value={ci}>
                            {c || t('deckStudio.table.columnN', { n: ci + 1 })}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </>
              )}

              {slide.layout === 'chart' && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.data')}</label>
                  <div className="flex-1 text-xs text-[var(--faint)] rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-2">
                    {slide.chartType && slide.series?.length ? (
                      <>
                        {t('deckStudio.chart.type')} <span className="text-[var(--text)]">{slide.chartType}</span> {t('deckStudio.chart.seriesLabel')}{' '}
                        <span className="text-[var(--text)]">{slide.series.map((s) => s.name).join(', ')}</span>. {t('deckStudio.chart.dataFromCandidate')}
                      </>
                    ) : (
                      t('deckStudio.chart.noData')
                    )}
                  </div>
                </div>
              )}

              {slide.layout === 'image' && (diagramOptions.length > 0 || slide.diagramSpec?.shapes?.length) && !slide.imageDataUrl ? (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.diagram')}</label>
                  <div className="flex-1 flex items-center gap-2">
                    <select
                      value={slide.diagramSpec ? '__current__' : ''}
                      onChange={(e) => {
                        const chosen = diagramOptions.find((d) => d.id === e.target.value)
                        updateSlide(activeIndex, { diagramSpec: chosen ? { ...chosen } : null })
                      }}
                      className="flex-1 min-w-0 text-xs rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2 py-2 outline-none focus:border-[var(--accent)]"
                      title={t('deckStudio.diagramSelectTitle')}
                    >
                      <option value="">{t('deckStudio.noDiagram')}</option>
                      {slide.diagramSpec && (
                        <option value="__current__">
                          {slide.diagramSpec.label ? t('deckStudio.diagramCurrentLabel', { label: slide.diagramSpec.label }) : t('deckStudio.diagramCurrent')} (
                          {t('deckStudio.shapesCount', { n: slide.diagramSpec.shapes?.length || 0 })})
                        </option>
                      )}
                      {diagramOptions.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.label || d.id} ({t('deckStudio.shapesCount', { n: d.shapes?.length || 0 })})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}

              {slide.layout === 'image' && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.image')}</label>
                  <div className="flex-1 flex items-center gap-3">
                    {slide.imageDataUrl ? (
                      <img src={slide.imageDataUrl} alt="" className="w-16 h-10 rounded-lg object-cover border border-[var(--border)]" />
                    ) : (
                      <div className="w-16 h-10 rounded-lg border border-dashed border-[var(--border)] grid place-items-center text-[var(--faint)]">
                        <Icon.File size={14} />
                      </div>
                    )}
                    <label className="text-xs font-medium text-[var(--accent)] hover:brightness-110 cursor-pointer">
                      {slide.imageDataUrl ? t('deckStudio.image.change') : t('deckStudio.image.upload')}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          const reader = new FileReader()
                          reader.onload = () => updateSlide(activeIndex, { imageDataUrl: reader.result })
                          reader.readAsDataURL(file)
                        }}
                      />
                    </label>
                    {slide.imageDataUrl && (
                      <button
                        onClick={() => updateSlide(activeIndex, { imageDataUrl: '' })}
                        className="text-xs text-[var(--faint)] hover:text-[var(--text)]"
                      >
                        {t('common.delete')}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {(slide.layout === 'quote' || slide.layout === 'bullets' || slide.layout === 'two-column' || slide.layout === 'image') && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">
                    {slide.layout === 'quote' ? t('deckStudio.field.quote') : t('deckStudio.field.text')}
                  </label>
                  <textarea
                    value={slide.body || ''}
                    onChange={(e) => updateSlide(activeIndex, { body: e.target.value })}
                    rows={2}
                    className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none"
                  />
                </div>
              )}

              {slide.layout !== 'title' && slide.layout !== 'section' && slide.layout !== 'quote' && slide.layout !== 'closing' && (
                <>
                  <div className="flex items-start gap-2">
                    <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.callout')}</label>
                    <div className="flex-1 flex gap-2">
                      <input
                        value={slide.callout?.kicker || ''}
                        onChange={(e) =>
                          updateSlide(activeIndex, {
                            callout: e.target.value || slide.callout?.text ? { ...slide.callout, kicker: e.target.value } : undefined,
                          })
                        }
                        placeholder={t('deckStudio.callout.kickerPlaceholder')}
                        className="w-1/3 min-w-0 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                      />
                      <input
                        value={slide.callout?.text || ''}
                        onChange={(e) =>
                          updateSlide(activeIndex, {
                            callout: e.target.value ? { ...slide.callout, text: e.target.value } : undefined,
                          })
                        }
                        placeholder={t('deckStudio.callout.textPlaceholder')}
                        className="flex-1 min-w-0 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                      />
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.footnote')}</label>
                    <input
                      value={slide.footnote || ''}
                      onChange={(e) => updateSlide(activeIndex, { footnote: e.target.value })}
                      placeholder={t('deckStudio.field.footnotePlaceholder')}
                      className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                    />
                  </div>
                </>
              )}
              </>
              )}

              <div className="flex items-start gap-2" style={{ display: slide ? undefined : 'none' }}>
                <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">{t('deckStudio.field.notes')}</label>
                <textarea
                  value={slide?.notes || ''}
                  onChange={(e) => updateSlide(activeIndex, { notes: e.target.value })}
                  rows={2}
                  placeholder={t('deckStudio.field.notesPlaceholder')}
                  className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
                />
              </div>
            </div>
            </div>
          </div>
        </div>
      )}
      {presenting && deck && <PresentMode deck={deck} template={template} onClose={() => setPresenting(false)} />}
      <HtmlEditContextMenu
        menu={htmlMenu}
        canPaste={!!htmlClip?.length}
        onAction={(action) => htmlOp(action)}
        onClose={() => setHtmlMenu(null)}
      />
    </div>
  )
}
