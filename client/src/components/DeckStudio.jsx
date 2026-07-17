import { useCallback, useEffect, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import DeckSlidePreview, { resolvePreviewTheme } from './DeckSlidePreview.jsx'
import ElementCanvas from './deck/ElementCanvas.jsx'
import ElementInspector, { MultiSelectPanel } from './deck/ElementInspector.jsx'
import AddElementBar from './deck/AddElementBar.jsx'
import LayerTree from './deck/LayerTree.jsx'
import useDeckHistory from '../hooks/useDeckHistory.js'
import { materializeSlide, CONVERTIBLE_LAYOUTS } from '../../../shared/deckLayout.js'
import { resolveDeckTheme } from '../../../shared/deckTheme.js'
import { findNode, findParent, updateNode, removeNodes, groupNodes, ungroupNode } from '../lib/deckTree.js'
import { getJSON, patchJSON, postJSON } from '../api.js'

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
      <button onClick={onClose} className="absolute top-4 right-4 p-2 rounded-lg text-white/50 hover:text-white hover:bg-white/10" title="Sair (Esc)">
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
        {index + 1} / {n} — ← → para navegar · Esc para sair
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
  { value: 'title', label: 'Capa' },
  { value: 'section', label: 'Divisor de seção' },
  { value: 'bullets', label: 'Tópicos' },
  { value: 'two-column', label: 'Duas colunas' },
  { value: 'agenda', label: 'Lista numerada (agenda/resumo)' },
  { value: 'cards', label: 'Cards' },
  { value: 'stat-grid', label: 'KPIs / estatísticas' },
  { value: 'comparison', label: 'Comparação' },
  { value: 'timeline', label: 'Linha do tempo' },
  { value: 'table', label: 'Tabela / matriz' },
  { value: 'diagram', label: 'Diagrama / arquitetura' },
  { value: 'chart', label: 'Gráfico' },
  { value: 'image', label: 'Imagem' },
  { value: 'quote', label: 'Citação' },
  { value: 'closing', label: 'Encerramento' },
]

function emptySlide() {
  return { layout: 'bullets', heading: 'Novo slide', bullets: [] }
}

// A single compact icon slot for a cards/stat-grid/timeline item — opens a
// small grid of the active template's real icon assets (see
// resolveIconAssetId in server/blocks.js: this is the only place an item's
// iconAssetId ever gets set, never free text/emoji).
function IconPicker({ value, options, onChange }) {
  const [open, setOpen] = useState(false)
  const selected = options?.find((a) => a.id === value)
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Escolher ícone"
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
              Nenhum ícone
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
              <p className="text-[11px] text-[var(--faint)] px-1">Sem ícones no modelo selecionado</p>
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
            title="Remover"
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

// Structured editor for the `diagram` layout — one block per column: label,
// "coluna central" toggle (emphasized panel of bands) and one item/band per
// line ("!" prefix marks an accent band, e.g. the governance layer).
function DiagramEditor({ slide, onChange }) {
  const columns = slide.columns || []
  const update = (i, col) => onChange({ columns: columns.map((c, idx) => (idx === i ? col : c)) })
  const remove = (i) => onChange({ columns: columns.filter((_, idx) => idx !== i) })
  const add = () => onChange({ columns: [...columns, { label: 'Nova coluna', items: [] }] })
  return (
    <div className="flex items-start gap-2">
      <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Colunas</label>
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
                  placeholder="Rótulo da coluna"
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
                  Coluna central
                </label>
                <button type="button" onClick={() => remove(i)} className="p-1.5 rounded-md hover:bg-[var(--surface-3)] text-[var(--faint)] shrink-0" title="Remover coluna">
                  <Icon.Trash size={13} />
                </button>
              </div>
              <textarea
                value={lines.join('\n')}
                onChange={(e) => setLines(e.target.value)}
                rows={Math.max(3, lines.length)}
                placeholder={isCentral ? 'Uma faixa por linha ("!" no início = faixa de destaque)' : 'Um item por linha'}
                className="w-full text-sm rounded-lg bg-[var(--surface)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
              />
            </div>
          )
        })}
        {columns.length < 4 && (
          <button type="button" onClick={add} className="flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:brightness-110">
            <Icon.Plus size={12} /> Adicionar coluna
          </button>
        )}
      </div>
    </div>
  )
}

export default function DeckStudio({ open, deckId, onClose, pushToast, focus = false, onToggleFocus }) {
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
  const [presenting, setPresenting] = useState(false)
  // element canvas (freeform slides): selection (multi) + open-group scope +
  // undo/redo history
  const [selectedElIds, setSelectedElIds] = useState([])
  const [scopeId, setScopeId] = useState(null)
  const history = useDeckHistory()
  const dragFrom = useRef(null)
  const saveTimer = useRef(null)
  const skipNextSave = useRef(true)

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
      .catch((e) => setLoadError(e.message || 'Falha ao carregar o deck'))
      .finally(() => setLoading(false))
  }, [open, deckId, loadTick]) // eslint-disable-line react-hooks/exhaustive-deps

  // element selection is per-slide — switching slides clears it
  useEffect(() => {
    setSelection(null)
    setSelectedElIds([])
    setScopeId(null)
  }, [activeIndex])

  // fresh deck load resets the undo history
  useEffect(() => {
    history.reset()
  }, [deckId]) // eslint-disable-line react-hooks/exhaustive-deps

  // undo/redo at the Studio level (Cmd+Z / Cmd+Shift+Z) — skipped while the
  // focus is in an input/textarea/contentEditable, where the browser's own
  // text undo must win
  useEffect(() => {
    if (!open) return
    const onKey = (ev) => {
      if (!(ev.metaKey || ev.ctrlKey) || ev.key.toLowerCase() !== 'z') return
      const t = ev.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
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
      }).catch((e) => pushToast?.(e.message))
    }, 500)
    return () => clearTimeout(saveTimer.current)
  }, [deck]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  const updateSlide = (idx, patch) => {
    setDeck((d) => {
      const slides = [...d.slides]
      slides[idx] = { ...slides[idx], ...patch }
      return { ...d, slides }
    })
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
  // the selection context, revalidates and persists — the fresh deck comes
  // back whole, so skip the next autosave (it would just re-PATCH the same)
  const submitTweak = async () => {
    const instruction = tweak.trim()
    if (!instruction || tweaking) return
    setTweaking(true)
    try {
      // freeform slides scope the tweak to the selected ELEMENT: the server
      // asks the model for that element's JSON only and splices it back, so
      // the rest of the slide is guaranteed untouched
      const elSel = selectedEl
        ? { elementId: selectedEl.id, label: selectedElLabel, text: selectedEl.text || '' }
        : null
      const r = await postJSON(`/api/decks/${deck.id}/tweak`, {
        instruction,
        slideIndex: tweakWholeDeck ? null : activeIndex,
        selection: tweakWholeDeck ? null : isFreeform ? elSel : selection,
      })
      skipNextSave.current = true
      setDeck(r.deck)
      setTweak('')
      setSelection(null)
      setSelectedElIds([])
      setScopeId(null)
    } catch (e) {
      pushToast?.(e.message || 'falha ao aplicar a alteração')
    } finally {
      setTweaking(false)
    }
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

  const slide = deck?.slides?.[activeIndex]
  const isFreeform = slide?.layout === 'freeform'

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
      ({ text: 'texto', shape: 'forma', line: 'linha', icon: 'ícone', image: 'imagem', chart: 'gráfico', group: 'grupo' }[selectedEl.type] || selectedEl.type)
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
      !window.confirm(
        'Converter este slide para edição livre? O formulário estruturado será substituído pelo canvas de elementos e o slide deixa de se re-adaptar automaticamente ao design system. Você pode reverter depois.'
      )
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

  const exportPptx = async () => {
    setExporting(true)
    try {
      const res = await fetch(`/api/decks/${deck.id}/export`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(deck.title || 'apresentacao').replace(/[^\w-]+/g, '_').slice(0, 60)}.pptx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      pushToast?.(e.message || 'Falha ao exportar PPTX')
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
                   focus
                     ? 'md:flex-1 md:min-w-0'
                     : 'md:shrink-0 md:w-[45%] md:min-w-[420px] md:max-w-[760px]'
                 }`}
    >
      {/* toolbar */}
      <header className="shrink-0 h-14 flex items-center gap-3 px-4 border-b border-[var(--border)]">
        <button onClick={onClose} className="p-2 -ml-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]">
          <Icon.Close size={20} />
        </button>
        <Icon.Presentation size={18} className="text-[var(--accent)]" />
        {deck ? (
          <input
            value={deck.title}
            onChange={(e) => setDeck((d) => ({ ...d, title: e.target.value }))}
            className="font-semibold text-sm bg-transparent outline-none border-b border-transparent focus:border-[var(--accent)] max-w-md"
          />
        ) : (
          <span className="font-semibold text-sm">Estúdio de Slides</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={onToggleFocus}
            className="hidden md:block p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]"
            title={focus ? 'Reduzir editor' : 'Expandir editor (modo foco)'}
          >
            {focus ? <Icon.Shrink size={16} /> : <Icon.Expand size={16} />}
          </button>
          <button
            onClick={() => setPresenting(true)}
            disabled={!deck}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-40"
            title="Apresentar (fullscreen)"
          >
            <Icon.Play size={16} />
          </button>
          <button
            onClick={addSlide}
            disabled={!deck}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-40"
            title="Adicionar slide"
          >
            <Icon.Plus size={17} />
          </button>
          <button
            onClick={addFreeformSlide}
            disabled={!deck}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-40"
            title="Adicionar slide livre (canvas de elementos)"
          >
            <Icon.Edit size={16} />
          </button>
          <button
            onClick={duplicateSlide}
            disabled={!deck}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-40"
            title="Duplicar slide"
          >
            <Icon.Copy size={16} />
          </button>
          <button
            onClick={deleteSlide}
            disabled={!deck || deck.slides.length <= 1}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-40"
            title="Excluir slide"
          >
            <Icon.Trash size={16} />
          </button>
          <button
            onClick={exportPptx}
            disabled={!deck || exporting}
            className="ml-2 flex items-center gap-1.5 rounded-xl bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white font-semibold text-sm px-3.5 py-2 transition"
          >
            <Icon.Download size={15} /> {exporting ? 'Exportando…' : 'Exportar PPTX'}
          </button>
        </div>
      </header>

      {loadError && !loading ? (
        <div className="flex-1 grid place-items-center">
          <div className="flex flex-col items-center gap-3 text-center px-6">
            <p className="text-sm text-[var(--muted)] max-w-sm">Não foi possível carregar o deck: {loadError}</p>
            <button
              onClick={() => setLoadTick((n) => n + 1)}
              className="rounded-xl bg-[var(--accent)] hover:brightness-110 text-white font-semibold text-sm px-4 py-2 transition"
            >
              Tentar novamente
            </button>
          </div>
        </div>
      ) : loading || !deck ? (
        <div className="flex-1 grid place-items-center text-sm text-[var(--faint)]">Carregando deck…</div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* thumbnail rail */}
          <div className="w-56 shrink-0 border-r border-[var(--border)] overflow-y-auto p-3 space-y-2">
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
                className={`relative rounded-lg cursor-pointer ring-2 transition animate-fade-in ${
                  i === activeIndex ? 'ring-[var(--accent)]' : 'ring-transparent hover:ring-[var(--border)]'
                }`}
                style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
              >
                <DeckSlidePreview
                  slide={s}
                  template={template}
                  deck={deck}
                  deckTitle={deck.title}
                  variant="thumb"
                  pageNumber={i + 1}
                  sectionNo={deck.slides.slice(0, i + 1).filter((x) => x.layout === 'section').length}
                />
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
                {isFreeform ? (
                  <ElementCanvas
                    slide={slide}
                    template={template}
                    selectedIds={selectedElIds}
                    onSelect={setSelectedElIds}
                    scopeId={scopeId}
                    onScope={setScopeId}
                    onChangeElements={changeElements}
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

            {/* selected-object style toolbar (Edit mode) */}
            <div className="shrink-0 mx-auto w-full px-6" style={{ maxWidth: 'calc((100dvh - 19rem) * 1.7778 + 3rem)' }}>
              {isFreeform ? (
                <div className="flex items-center justify-between gap-2">
                  <AddElementBar
                    theme={resolvePreviewTheme(template)}
                    onAdd={addElement}
                    canGroup={selectedElIds.length > 1}
                    canUngroup={selectedEl?.type === 'group'}
                    onGroup={groupSelectedEls}
                    onUngroup={ungroupSelectedEl}
                  />
                  <span className="text-[10px] text-[var(--faint)] hidden md:block">
                    arraste · alças = redimensionar · Del exclui · Cmd+Z desfaz
                  </span>
                </div>
              ) : selection ? (
                <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-xs">
                  <span className="font-medium text-[var(--accent)] truncate max-w-[10rem]" title={selection.path}>
                    {selection.label || selection.path}
                  </span>
                  <span className="text-[var(--faint)]">·</span>
                  <label className="flex items-center gap-1 text-[var(--muted)]">
                    Tam.
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
                    title="Cor do texto"
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
                        title={`Alinhar à ${al === 'left' ? 'esquerda' : al === 'center' ? 'centro' : 'direita'}`}
                      >
                        {al === 'left' ? '⇤' : al === 'center' ? '↔' : '⇥'}
                      </button>
                    ))}
                  </div>
                  <span className="text-[10px] text-[var(--faint)] ml-auto hidden sm:block">2 cliques no texto = editar</span>
                  <button onClick={() => setSelection(null)} className="p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--faint)]" title="Limpar seleção">
                    <Icon.Close size={12} />
                  </button>
                </div>
              ) : (
                <p className="text-[10px] text-[var(--faint)] px-1">
                  Clique em um objeto do slide (título, card, box...) para selecioná-lo — edite o estilo aqui, o texto com
                  clique duplo, ou peça uma alteração abaixo.
                </p>
              )}
            </div>

            {/* NL tweak bar */}
            <div className="shrink-0 mx-auto w-full px-6 pt-2 pb-1" style={{ maxWidth: 'calc((100dvh - 19rem) * 1.7778 + 3rem)' }}>
              <div className="flex items-center gap-2">
                <div className="flex-1 flex items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-2.5">
                  <Icon.Wand size={14} className="text-[var(--accent)] shrink-0" />
                  <input
                    value={tweak}
                    onChange={(e) => setTweak(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && submitTweak()}
                    placeholder={
                      tweakWholeDeck
                        ? 'Peça uma alteração no deck todo (ex.: "traduza para inglês")…'
                        : isFreeform && selectedEl
                          ? `Peça uma alteração na camada "${selectedElLabel}" (só ela muda)…`
                          : selection
                            ? `Peça uma alteração em "${selection.label}"…`
                            : 'Peça uma alteração neste slide (ex.: "resuma os bullets")…'
                    }
                    disabled={tweaking}
                    className="flex-1 bg-transparent text-sm py-2 outline-none placeholder:text-[var(--faint)] disabled:opacity-50"
                  />
                </div>
                <button
                  onClick={submitTweak}
                  disabled={!tweak.trim() || tweaking}
                  className="rounded-xl bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white font-semibold text-xs px-3 py-2.5 transition shrink-0 inline-flex items-center gap-1.5"
                >
                  {tweaking && (
                    <span className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" aria-hidden />
                  )}
                  Aplicar
                </button>
              </div>
              {tweaking && (
                <div className="flex items-center gap-1.5 text-[11px] text-[var(--accent)] mt-1.5 animate-fade-in">
                  <span className="w-2.5 h-2.5 rounded-full border-2 border-[var(--accent)]/40 border-t-[var(--accent)] animate-spin" aria-hidden />
                  <span>
                    {tweakWholeDeck
                      ? 'Aplicando ao deck inteiro — isso pode levar alguns segundos…'
                      : isFreeform && selectedEl
                        ? `Editando a camada “${selectedElLabel}” — só ela muda, o resto do slide fica intacto.`
                        : selection
                          ? `Editando “${selection.label}” neste slide…`
                          : 'Ajustando este slide…'}
                  </span>
                </div>
              )}
              <label className="flex items-center gap-1.5 text-[10px] text-[var(--muted)] mt-1 cursor-pointer w-fit">
                <input type="checkbox" checked={tweakWholeDeck} onChange={(e) => setTweakWholeDeck(e.target.checked)} />
                Aplicar ao deck inteiro (não só a este slide)
              </label>
            </div>
          </div>

            {/* editable fields — the only scrollable region, below the stage;
                width-matched to the stage so the inputs line up with the slide */}
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
            <div className="mx-auto w-full pb-8 space-y-3 px-6 pt-2" style={{ maxWidth: 'calc((100dvh - 19rem) * 1.7778 + 3rem)' }}>
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0">Deck</label>
                <input
                  value={deck.audience || ''}
                  onChange={(e) => setDeck((d) => ({ ...d, audience: e.target.value }))}
                  placeholder="Cliente/audiência (rodapé: Prepared for…)"
                  className="flex-1 min-w-0 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                />
                <input
                  value={deck.author || ''}
                  onChange={(e) => setDeck((d) => ({ ...d, author: e.target.value }))}
                  placeholder="Autor/time (capa)"
                  className="flex-1 min-w-0 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                />
              </div>

              {isFreeform ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0">Layout</label>
                    <div className="flex-1 flex items-center gap-2 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 text-[var(--muted)]">
                      Edição livre (canvas de elementos)
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
                          title="Descarta os elementos e volta ao layout estruturado original"
                        >
                          Reverter para layout semântico
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0">Fundo</label>
                    <input
                      type="color"
                      value={slide.background?.color || '#FFFFFF'}
                      onChange={(e) => {
                        history.commit(deck)
                        updateSlide(activeIndex, { background: { ...(slide.background || {}), color: e.target.value.toUpperCase(), plate: undefined } })
                      }}
                      className="w-7 h-7 rounded cursor-pointer border border-[var(--border)] bg-transparent"
                      title="Cor de fundo do slide"
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
                      <option value="">cor sólida</option>
                      <option value="cover">placa de capa da marca</option>
                      <option value="section">placa de divisor da marca</option>
                    </select>
                  </div>
                  {/* layer tree (Claude-Design-style) — selection shared with the canvas */}
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden">
                    <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
                      <span className="text-xs font-semibold">Camadas</span>
                      <span className="text-[9.5px] text-[var(--faint)]">arraste p/ reordenar · 2 cliques renomeia</span>
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
                      <MultiSelectPanel count={selectedElIds.length} onGroup={groupSelectedEls} onRemove={removeSelectedEls} />
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
                      Clique em um elemento no slide (ou na árvore de camadas) para editar posição, tamanho, cores,
                      auto-layout, dados de gráfico e texto — shift-click seleciona vários, Cmd+G agrupa, 2 cliques
                      entra em um grupo.
                    </p>
                  )}
                </div>
              ) : (
              <>
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0">Layout</label>
                <select
                  value={slide.layout}
                  onChange={(e) => updateSlide(activeIndex, { layout: e.target.value })}
                  className="flex-1 min-w-0 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
                >
                  {LAYOUTS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
                {canConvert && (
                  <button
                    onClick={convertToFreeform}
                    className="shrink-0 flex items-center gap-1.5 rounded-lg bg-[var(--surface-3)] hover:brightness-110 text-xs font-semibold px-2.5 py-2"
                    title="Transforma o slide em um canvas de elementos onde QUALQUER objeto pode ser movido, redimensionado e estilizado"
                  >
                    <Icon.Edit size={13} /> Converter para edição livre
                  </button>
                )}
              </div>

              {slide.layout !== 'section' && slide.layout !== 'quote' && slide.layout !== 'closing' && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Kicker</label>
                  <input
                    value={slide.kicker || ''}
                    onChange={(e) => updateSlide(activeIndex, { kicker: e.target.value })}
                    placeholder="Rótulo curto acima do título (ex.: Business case)"
                    className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                  />
                </div>
              )}

              <div className="flex items-start gap-2">
                <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Título</label>
                <input
                  value={slide.heading || ''}
                  onChange={(e) => updateSlide(activeIndex, { heading: e.target.value })}
                  className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
                />
              </div>

              <div className="flex items-start gap-2">
                <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Subtítulo</label>
                <input
                  value={slide.subheading || ''}
                  onChange={(e) => updateSlide(activeIndex, { subheading: e.target.value })}
                  className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
                />
              </div>

              {(slide.layout === 'bullets' || slide.layout === 'two-column') && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Bullets</label>
                  <textarea
                    value={(slide.bullets || []).join('\n')}
                    onChange={(e) => updateSlide(activeIndex, { bullets: e.target.value.split('\n') })}
                    rows={5}
                    placeholder="Um bullet por linha"
                    className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none"
                  />
                </div>
              )}

              {slide.layout === 'agenda' && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Itens</label>
                  <ItemListEditor
                    items={slide.items?.length ? slide.items : (slide.bullets || []).map((b) => ({ title: b }))}
                    fields={[['title', 'Título do item'], ['body', 'Linha de apoio (opcional)']]}
                    iconOptions={null}
                    onChange={(items) => updateSlide(activeIndex, { items, bullets: undefined })}
                    addLabel="Adicionar item"
                  />
                </div>
              )}

              {slide.layout === 'diagram' && (
                <DiagramEditor slide={slide} onChange={(patch) => updateSlide(activeIndex, patch)} />
              )}

              {slide.layout === 'cards' && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Cards</label>
                  <ItemListEditor
                    items={slide.cards}
                    fields={[['heading', 'Título'], ['body', 'Corpo (opcional)']]}
                    iconOptions={iconOptions}
                    onChange={(cards) => updateSlide(activeIndex, { cards })}
                    addLabel="Adicionar card"
                  />
                </div>
              )}

              {slide.layout === 'stat-grid' && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Estatísticas</label>
                  <ItemListEditor
                    items={slide.stats}
                    fields={[['value', 'Valor'], ['label', 'Legenda (opcional)']]}
                    iconOptions={iconOptions}
                    onChange={(stats) => updateSlide(activeIndex, { stats })}
                    addLabel="Adicionar estatística"
                  />
                </div>
              )}

              {slide.layout === 'comparison' && (
                <>
                  <div className="grid grid-cols-2 gap-2 pl-[5.5rem]">
                    <input
                      value={slide.leftTitle || ''}
                      onChange={(e) => updateSlide(activeIndex, { leftTitle: e.target.value })}
                      placeholder="Título esquerda"
                      className="text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                    />
                    <input
                      value={slide.rightTitle || ''}
                      onChange={(e) => updateSlide(activeIndex, { rightTitle: e.target.value })}
                      placeholder="Título direita"
                      className="text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Bullets</label>
                    <div className="flex-1 grid grid-cols-2 gap-2">
                      <textarea
                        value={(slide.leftBullets || []).join('\n')}
                        onChange={(e) => updateSlide(activeIndex, { leftBullets: e.target.value.split('\n') })}
                        rows={4}
                        placeholder="Um por linha (esquerda)"
                        className="text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
                      />
                      <textarea
                        value={(slide.rightBullets || []).join('\n')}
                        onChange={(e) => updateSlide(activeIndex, { rightBullets: e.target.value.split('\n') })}
                        rows={4}
                        placeholder="Um por linha (direita)"
                        className="text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
                      />
                    </div>
                  </div>
                </>
              )}

              {slide.layout === 'timeline' && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Fases</label>
                  <ItemListEditor
                    items={slide.phases}
                    fields={[['label', 'Fase'], ['period', 'Período (opcional)'], ['body', 'Descrição (opcional)']]}
                    iconOptions={iconOptions}
                    onChange={(phases) => updateSlide(activeIndex, { phases })}
                    addLabel="Adicionar fase"
                  />
                </div>
              )}

              {slide.layout === 'table' && (
                <>
                  <div className="flex items-start gap-2">
                    <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Colunas</label>
                    <input
                      value={(slide.columns || []).join(', ')}
                      onChange={(e) => updateSlide(activeIndex, { columns: e.target.value.split(',').map((s) => s.trim()) })}
                      placeholder="Separadas por vírgula"
                      className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                    />
                  </div>
                  <div className="flex items-start gap-2">
                    <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Linhas</label>
                    <textarea
                      value={(slide.rows || []).map((r) => r.join(', ')).join('\n')}
                      onChange={(e) => updateSlide(activeIndex, { rows: e.target.value.split('\n').map((line) => line.split(',').map((s) => s.trim())) })}
                      rows={5}
                      placeholder="Uma linha por linha de texto, células separadas por vírgula"
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
                      Matriz de níveis (células full/partial/none viram ●◑○)
                    </label>
                    <label className="flex items-center gap-1.5">
                      Coluna destacada
                      <select
                        value={Number.isInteger(slide.highlightColumn) ? slide.highlightColumn : ''}
                        onChange={(e) =>
                          updateSlide(activeIndex, { highlightColumn: e.target.value === '' ? undefined : Number(e.target.value) })
                        }
                        className="text-xs rounded-md bg-[var(--surface-2)] border border-[var(--border)] px-1.5 py-1 outline-none focus:border-[var(--accent)]"
                      >
                        <option value="">nenhuma</option>
                        {(slide.columns || []).map((c, ci) => (
                          <option key={ci} value={ci}>
                            {c || `coluna ${ci + 1}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </>
              )}

              {slide.layout === 'chart' && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Dados</label>
                  <div className="flex-1 text-xs text-[var(--faint)] rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-2">
                    {slide.chartType && slide.series?.length ? (
                      <>
                        Tipo: <span className="text-[var(--text)]">{slide.chartType}</span> — série(s):{' '}
                        <span className="text-[var(--text)]">{slide.series.map((s) => s.name).join(', ')}</span>. Dados vêm de um
                        candidato real já usado na conversa e não são editáveis aqui.
                      </>
                    ) : (
                      'Sem dados de gráfico resolvidos — peça no chat um deck que referencie um candidato de gráfico existente.'
                    )}
                  </div>
                </div>
              )}

              {slide.layout === 'image' && (diagramOptions.length > 0 || slide.diagramSpec?.shapes?.length) && !slide.imageDataUrl ? (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Diagrama</label>
                  <div className="flex-1 flex items-center gap-2">
                    <select
                      value={slide.diagramSpec ? '__current__' : ''}
                      onChange={(e) => {
                        const chosen = diagramOptions.find((d) => d.id === e.target.value)
                        updateSlide(activeIndex, { diagramSpec: chosen ? { ...chosen } : null })
                      }}
                      className="flex-1 min-w-0 text-xs rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2 py-2 outline-none focus:border-[var(--accent)]"
                      title="Diagramas vetoriais minerados do design system ativo — redesenhados com as fontes do tema no PPTX"
                    >
                      <option value="">Sem diagrama</option>
                      {slide.diagramSpec && (
                        <option value="__current__">
                          {slide.diagramSpec.label ? `Atual — ${slide.diagramSpec.label}` : 'Diagrama atual'} (
                          {slide.diagramSpec.shapes?.length || 0} formas)
                        </option>
                      )}
                      {diagramOptions.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.label || d.id} ({d.shapes?.length || 0} formas)
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}

              {slide.layout === 'image' && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Imagem</label>
                  <div className="flex-1 flex items-center gap-3">
                    {slide.imageDataUrl ? (
                      <img src={slide.imageDataUrl} alt="" className="w-16 h-10 rounded-lg object-cover border border-[var(--border)]" />
                    ) : (
                      <div className="w-16 h-10 rounded-lg border border-dashed border-[var(--border)] grid place-items-center text-[var(--faint)]">
                        <Icon.File size={14} />
                      </div>
                    )}
                    <label className="text-xs font-medium text-[var(--accent)] hover:brightness-110 cursor-pointer">
                      {slide.imageDataUrl ? 'Trocar imagem' : 'Enviar imagem'}
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
                        Remover
                      </button>
                    )}
                  </div>
                </div>
              )}

              {(slide.layout === 'quote' || slide.layout === 'bullets' || slide.layout === 'two-column' || slide.layout === 'image') && (
                <div className="flex items-start gap-2">
                  <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">
                    {slide.layout === 'quote' ? 'Citação' : 'Texto'}
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
                    <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Callout</label>
                    <div className="flex-1 flex gap-2">
                      <input
                        value={slide.callout?.kicker || ''}
                        onChange={(e) =>
                          updateSlide(activeIndex, {
                            callout: e.target.value || slide.callout?.text ? { ...slide.callout, kicker: e.target.value } : undefined,
                          })
                        }
                        placeholder="Rótulo (ex.: Por que importa)"
                        className="w-1/3 min-w-0 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                      />
                      <input
                        value={slide.callout?.text || ''}
                        onChange={(e) =>
                          updateSlide(activeIndex, {
                            callout: e.target.value ? { ...slide.callout, text: e.target.value } : undefined,
                          })
                        }
                        placeholder="Conclusão em destaque no pé do slide (opcional)"
                        className="flex-1 min-w-0 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                      />
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Nota de pé</label>
                    <input
                      value={slide.footnote || ''}
                      onChange={(e) => updateSlide(activeIndex, { footnote: e.target.value })}
                      placeholder="Fonte/ressalva em itálico (ex.: números ilustrativos)"
                      className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                    />
                  </div>
                </>
              )}
              </>
              )}

              <div className="flex items-start gap-2">
                <label className="text-xs font-semibold text-[var(--faint)] w-20 shrink-0 pt-2">Notas</label>
                <textarea
                  value={slide.notes || ''}
                  onChange={(e) => updateSlide(activeIndex, { notes: e.target.value })}
                  rows={2}
                  placeholder="Notas do apresentador (não aparecem no slide)"
                  className="flex-1 text-sm rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
                />
              </div>
            </div>
            </div>
          </div>
        </div>
      )}
      {presenting && deck && <PresentMode deck={deck} template={template} onClose={() => setPresenting(false)} />}
    </div>
  )
}
