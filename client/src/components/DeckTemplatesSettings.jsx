import { useEffect, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import DeckSlidePreview from './DeckSlidePreview.jsx'
import DeckTemplateInspector from './DeckTemplateInspector.jsx'
import { getJSON, postJSON, patchJSON, del } from '../api.js'
import { EMPTY_TEMPLATE, extractFromFiles, mergeTemplate, stripExt, rasterizeToPng } from '../lib/pptxMining.js'

const FONT_SUGGESTIONS = [
  'DM Sans', 'Georgia', 'Helvetica', 'Arial', 'Calibri', 'Verdana', 'Times New Roman', 'Garamond', 'Trebuchet MS', 'Barlow',
]


const KIND_LABELS = { icon: 'Ícone', image: 'Imagem', watermark: "Marca d'água" }

function isValidHex(v) {
  return /^#[0-9a-fA-F]{6}$/.test(v || '')
}

// Mined labels are often useless for steering the model ("Imagem 12",
// "Gráfico 37", empty) — those are the ones worth sending to the vision
// labeler; a human-written or already-descriptive label is never overwritten.
function isGenericLabel(label) {
  return !label || /^(imagem|image|picture|gr[aá]fico|graphic|icon|[ií]cone|shape|forma|logo)?[\s_-]*\d*$/i.test(label.trim())
}

// "Relatório da importação" — what the classifier decided for this import:
// counts of what entered, what was ignored (and why) and which files fell
// into the generic-'image' catch-all (the usual sign of a misnamed asset,
// reclassifiable one click away in the asset editor).
function ImportReportPanel({ report }) {
  if (!report) return null
  const c = report.counts || {}
  const parts = [
    c.icon ? `${c.icon} ícone${c.icon > 1 ? 's' : ''}` : null,
    c.lockup ? `${c.lockup} lockup${c.lockup > 1 ? 's' : ''}` : null,
    c.illustration ? `${c.illustration} ilustraç${c.illustration > 1 ? 'ões' : 'ão'}` : null,
    c.background ? `${c.background} fundo${c.background > 1 ? 's' : ''}` : null,
    c.image ? `${c.image} imagem(ns) genérica(s)` : null,
    report.paletteCount ? `${report.paletteCount} tokens de cor` : null,
    report.fontCount ? `${report.fontCount} fonte${report.fontCount > 1 ? 's' : ''}` : null,
    report.cardCount ? `${report.cardCount} cartõe${report.cardCount > 1 ? 's' : ''} HTML` : null,
    report.readmeFound ? 'guia da marca (readme)' : null,
  ].filter(Boolean)
  const skipped = [
    ...(report.skippedAssets || []),
    ...(report.fontsSkipped || []),
    ...(report.cardsSkipped || []),
  ]
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 space-y-1.5">
      <div className="text-xs font-semibold flex items-center gap-1.5">
        <Icon.FileText size={13} /> Relatório da importação
      </div>
      {parts.length > 0 && <p className="text-[11px] text-[var(--muted)]">{parts.join(' · ')}</p>}
      {!report.manifestFound && (
        <p className="text-[11px] text-[var(--faint)]">
          ⚠ Bundle sem <code>_ds_manifest.json</code>
          {report.manifestError ? ` (${report.manifestError})` : ''} — a classificação usou apenas os
          nomes dos arquivos.
        </p>
      )}
      {report.catchAllImages?.length > 0 && (
        <p className="text-[11px] text-[var(--faint)]">
          ⚠ {report.catchAllImages.length} arquivo(s) sem padrão de nome reconhecido viraram
          &quot;imagem&quot; genérica — confira se deveriam ser ícone/fundo/ilustração:{' '}
          <span className="font-mono">{report.catchAllImages.slice(0, 8).join(', ')}</span>
          {report.catchAllImages.length > 8 ? '…' : ''}
        </p>
      )}
      {skipped.length > 0 && (
        <details className="text-[11px] text-[var(--faint)]">
          <summary className="cursor-pointer">{skipped.length} arquivo(s) ignorado(s) — ver motivos</summary>
          <ul className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
            {skipped.slice(0, 40).map((s, i) => (
              <li key={i} className="font-mono truncate">
                {s.path.split('/').pop()} <span className="font-sans">— {s.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function TemplateForm({ initial, onCancel, onSave, saving, onCreateNew }) {
  const [tpl, setTpl] = useState(initial)
  const [selectedAsset, setSelectedAsset] = useState(null) // asset id being edited
  const [enriching, setEnriching] = useState(false)
  const [enrichError, setEnrichError] = useState('')
  const [labeling, setLabeling] = useState(false)

  // assets/diagrams still carrying a generic mined label ("Imagem 3", empty)
  const unlabeled = (tpl.iconAssets || []).filter((a) => isGenericLabel(a.label))
  const unlabeledDiagrams = (tpl.minedStyle?.diagrams || []).filter((d) => isGenericLabel(d.label))

  // Vision labeling (server route /api/deck-templates/label-assets): sends
  // 128px thumbnails, merges the returned semantic labels into the draft.
  const onLabelAssets = async () => {
    setEnrichError('')
    setLabeling(true)
    try {
      const assets = []
      for (const a of unlabeled.slice(0, 40)) {
        try {
          assets.push({ id: a.id, kind: a.kind || 'icon', dataUrl: await rasterizeToPng(a.dataUrl) })
        } catch {
          // un-rasterizable asset — skip it
        }
      }
      const diagrams = unlabeledDiagrams.slice(0, 8).map((d) => ({
        id: d.id,
        texts: (d.shapes || []).map((s) => s.text).filter(Boolean).slice(0, 20),
      }))
      const r = await postJSON('/api/deck-templates/label-assets', { assets, diagrams })
      const labels = r.labels || {}
      if (Object.keys(labels).length) {
        setTpl((t) => ({
          ...t,
          iconAssets: (t.iconAssets || []).map((a) => (labels[a.id] ? { ...a, label: labels[a.id] } : a)),
          minedStyle: t.minedStyle
            ? {
                ...t.minedStyle,
                diagrams: (t.minedStyle.diagrams || []).map((d) => (labels[d.id] ? { ...d, label: labels[d.id] } : d)),
              }
            : t.minedStyle,
        }))
      }
    } catch (e) {
      setEnrichError(e.message || 'falha ao rotular assets')
    } finally {
      setLabeling(false)
    }
  }

  const onLogoFile = (file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setTpl((t) => ({ ...t, logoDataUrl: reader.result }))
    reader.readAsDataURL(file)
  }

  // Feeds MORE source files into this design system (another .pptx, loose
  // icon/logo images…) — collections append, review-ready fields stay put.
  // When the new import would REPLACE heavy fields the draft already has
  // (richer-wins rule), the user decides instead of losing them silently.
  const [pendingEnrich, setPendingEnrich] = useState(null) // { patch, replaces: [{label, from, to}] }
  const onEnrichFiles = async (files) => {
    const list = Array.from(files || [])
    if (!list.length) return
    setEnrichError('')
    setEnriching(true)
    try {
      const patch = await extractFromFiles(list, null)
      const HEAVY = [
        ['palette', 'paleta de cores'],
        ['fontAssets', 'fontes'],
        ['dsCards', 'cartões do design system'],
      ]
      const replaces = HEAVY.filter(
        ([k]) => (tpl[k]?.length || 0) > 0 && (patch[k]?.length || 0) > (tpl[k]?.length || 0)
      ).map(([k, label]) => ({ label, from: tpl[k].length, to: patch[k].length }))
      if (replaces.length) setPendingEnrich({ patch, replaces })
      else setTpl((t) => mergeTemplate(t, patch))
    } catch (e) {
      setEnrichError(e.message || 'falha ao importar arquivos')
    } finally {
      setEnriching(false)
    }
  }

  const patchAsset = (id, patch) => {
    setTpl((t) => ({ ...t, iconAssets: (t.iconAssets || []).map((a) => (a.id === id ? { ...a, ...patch } : a)) }))
  }

  const removeIconAsset = (id) => {
    if (selectedAsset === id) setSelectedAsset(null)
    setTpl((t) => ({ ...t, iconAssets: (t.iconAssets || []).filter((a) => a.id !== id) }))
  }

  const activeAsset = (tpl.iconAssets || []).find((a) => a.id === selectedAsset)
  const diagramCount = tpl.minedStyle?.diagrams?.length || 0

  return (
    <div className="rounded-xl border border-[var(--accent)]/40 bg-[var(--surface-2)] p-3.5 space-y-3">
      <input
        value={tpl.name}
        onChange={(e) => setTpl((t) => ({ ...t, name: e.target.value }))}
        placeholder="Nome do design system (ex.: Marca da empresa)"
        className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          ['primaryColor', 'Primária'],
          ['secondaryColor', 'Secundária'],
          ['accentColor', 'Destaque'],
          ['backgroundColor', 'Fundo'],
        ].map(([key, label]) => (
          <div key={key} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <input
                type="color"
                value={isValidHex(tpl[key]) ? tpl[key] : '#000000'}
                onChange={(e) => setTpl((t) => ({ ...t, [key]: e.target.value.toUpperCase() }))}
                className="w-5 h-5 rounded shrink-0 border-none bg-transparent cursor-pointer"
              />
              <span className="text-[10px] text-[var(--muted)] truncate">{label}</span>
            </div>
            <input
              value={tpl[key] || ''}
              onChange={(e) => {
                let v = e.target.value.trim().toUpperCase()
                if (v && !v.startsWith('#')) v = '#' + v
                setTpl((t) => ({ ...t, [key]: v }))
              }}
              placeholder="#RRGGBB"
              spellCheck={false}
              className={`mt-1 w-full text-[11px] font-mono rounded-md border bg-transparent px-1.5 py-0.5 outline-none uppercase ${
                !tpl[key] || isValidHex(tpl[key]) ? 'border-transparent focus:border-[var(--accent)]' : 'border-red-500/60'
              }`}
            />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <input
          list="deck-font-suggestions"
          value={tpl.headingFont}
          onChange={(e) => setTpl((t) => ({ ...t, headingFont: e.target.value }))}
          placeholder="Fonte dos títulos"
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
        />
        <input
          list="deck-font-suggestions"
          value={tpl.bodyFont}
          onChange={(e) => setTpl((t) => ({ ...t, bodyFont: e.target.value }))}
          placeholder="Fonte do corpo"
          className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
        />
        <datalist id="deck-font-suggestions">
          {FONT_SUGGESTIONS.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </div>

      <div className="flex items-center gap-3">
        {tpl.logoDataUrl ? (
          <img src={tpl.logoDataUrl} alt="Logo" className="w-10 h-10 rounded-lg object-contain border border-[var(--border)] bg-[var(--surface)]" />
        ) : (
          <div className="w-10 h-10 rounded-lg border border-dashed border-[var(--border)] grid place-items-center text-[var(--faint)]">
            <Icon.File size={16} />
          </div>
        )}
        <label className="text-xs font-medium text-[var(--accent)] hover:brightness-110 cursor-pointer">
          {tpl.logoDataUrl ? 'Trocar logo' : 'Enviar logo'}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => onLogoFile(e.target.files?.[0])} />
        </label>
        {tpl.logoDataUrl && (
          <button
            onClick={() => setTpl((t) => ({ ...t, logoDataUrl: '' }))}
            className="text-xs text-[var(--faint)] hover:text-[var(--text)]"
          >
            Remover
          </button>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold text-[var(--faint)]">
            Assets do design system{' '}
            {tpl.iconAssets?.length ? `(${tpl.iconAssets.length})` : ''}
          </span>
          <div className="flex items-center gap-3">
            {(unlabeled.length > 0 || unlabeledDiagrams.length > 0) && (
              <button
                type="button"
                onClick={onLabelAssets}
                disabled={labeling}
                className="text-xs font-medium text-[var(--accent)] hover:brightness-110 disabled:opacity-60"
                title="Usa um modelo de visão para descrever ícones, imagens e diagramas sem rótulo — rótulos bons melhoram a escolha de assets pela IA"
              >
                {labeling ? 'Rotulando…' : `Rotular com IA (${unlabeled.length + unlabeledDiagrams.length})`}
              </button>
            )}
            <label className="text-xs font-medium text-[var(--accent)] hover:brightness-110 cursor-pointer">
              {enriching ? 'Importando…' : 'Adicionar arquivos (.pptx, imagens)'}
              <input
                type="file"
                accept=".pptx,.json,image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                multiple
                className="hidden"
                disabled={enriching}
                onChange={(e) => {
                  onEnrichFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
          </div>
        </div>
        {tpl.iconAssets?.length ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2.5 space-y-2">
            <div className="flex flex-wrap gap-2">
              {tpl.iconAssets.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSelectedAsset((cur) => (cur === a.id ? null : a.id))}
                  className={`relative w-11 h-11 shrink-0 rounded-lg border transition ${
                    selectedAsset === a.id ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--border)] hover:border-[var(--muted)]'
                  }`}
                  title={`${a.label || a.id} · ${KIND_LABELS[a.kind] || 'Ícone'}`}
                >
                  <img
                    src={a.dataUrl}
                    alt={a.label || ''}
                    className={`w-full h-full rounded-lg object-contain ${
                      a.kind === 'image' ? 'p-0.5 opacity-80' : a.kind === 'watermark' ? 'p-1 opacity-40' : 'p-1.5'
                    }`}
                  />
                  {a.kind === 'watermark' && (
                    <span className="absolute -bottom-1 -right-1 grid place-items-center w-4 h-4 rounded-full bg-[var(--surface-3)] border border-[var(--border)] text-[var(--faint)]" title="Marca d'água — nunca usada nos decks">
                      <Icon.Close size={9} />
                    </span>
                  )}
                </button>
              ))}
            </div>
            {activeAsset && (
              <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5">
                <input
                  value={activeAsset.label || ''}
                  onChange={(e) => patchAsset(activeAsset.id, { label: e.target.value })}
                  placeholder="Rótulo (ajuda a IA a escolher bem)"
                  className="flex-1 min-w-0 text-xs rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
                />
                <select
                  value={activeAsset.kind || 'icon'}
                  onChange={(e) => patchAsset(activeAsset.id, { kind: e.target.value })}
                  className="text-xs rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 py-1 outline-none"
                  title="Ícones entram em cards/KPIs; imagens em slides de imagem; marcas d'água nunca são usadas"
                >
                  {Object.entries(KIND_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>{l}</option>
                  ))}
                </select>
                <button
                  onClick={() => removeIconAsset(activeAsset.id)}
                  className="p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--faint)] hover:text-[var(--text)]"
                  title="Remover asset"
                >
                  <Icon.Trash size={13} />
                </button>
              </div>
            )}
            <p className="text-[10px] text-[var(--faint)]">
              Clique em um asset para renomear ou reclassificar. Marcas d'água ficam registradas,
              mas nunca aparecem em decks gerados.
            </p>
          </div>
        ) : (
          <p className="text-xs text-[var(--faint)] rounded-xl border border-dashed border-[var(--border)] px-3 py-2">
            Nenhum asset ainda — importe um .pptx da marca ou envie ícones/logos avulsos. Tudo é
            opcional: quanto mais assets (ícones, fotos, diagramas), maior a aderência dos decks ao
            design system (nunca emoji nos slides gerados).
          </p>
        )}
        {enrichError && <p className="text-xs text-[var(--accent)] mt-1.5">{enrichError}</p>}
        {(diagramCount > 0 || tpl.coverPlateDataUrl) && (
          <p className="text-[10px] text-[var(--faint)] mt-1.5">
            Também minerados: {[
              diagramCount ? `${diagramCount} diagrama${diagramCount > 1 ? 's' : ''} vetoria${diagramCount > 1 ? 'is' : 'l'}` : null,
              tpl.coverPlateDataUrl ? 'placa de capa' : null,
              tpl.minedStyle?.sectionPlateDataUrl ? 'placa de divisor' : null,
              tpl.minedStyle?.motif ? 'motivo decorativo' : null,
            ].filter(Boolean).join(' · ')} — visíveis no inspetor do design system.
          </p>
        )}
      </div>

      <textarea
        value={tpl.styleNotes}
        onChange={(e) => setTpl((t) => ({ ...t, styleNotes: e.target.value }))}
        rows={2}
        placeholder="Notas de estilo (ex.: sempre fundo escuro, sem emojis, tom formal…)"
        className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-sm outline-none focus:border-[var(--accent)] resize-none placeholder:text-[var(--faint)]"
      />

      <ImportReportPanel report={tpl._importReport} />

      {pendingEnrich && (
        <div className="rounded-xl border border-[var(--accent)]/60 bg-[var(--surface)] px-3 py-2.5 space-y-2">
          <p className="text-xs">
            <span className="font-semibold">Este import substituiria conteúdo já presente:</span>{' '}
            {pendingEnrich.replaces.map((r) => `${r.label} (${r.from} → ${r.to})`).join(', ')}. O que
            fazer?
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setTpl((t) => mergeTemplate(t, pendingEnrich.patch, { preferBase: true }))
                setPendingEnrich(null)
              }}
              className="rounded-lg bg-[var(--surface-3)] hover:brightness-110 text-xs font-semibold px-3 py-1.5"
            >
              Manter os atuais
            </button>
            <button
              onClick={() => {
                setTpl((t) => mergeTemplate(t, pendingEnrich.patch))
                setPendingEnrich(null)
              }}
              className="rounded-lg bg-[var(--surface-3)] hover:brightness-110 text-xs font-semibold px-3 py-1.5"
            >
              Substituir
            </button>
            {onCreateNew && (
              <button
                onClick={() => {
                  const patch = pendingEnrich.patch
                  setPendingEnrich(null)
                  onCreateNew(patch)
                }}
                className="rounded-lg bg-[var(--surface-3)] hover:brightness-110 text-xs font-semibold px-3 py-1.5"
              >
                Criar novo modelo em vez disso
              </button>
            )}
            <button
              onClick={() => setPendingEnrich(null)}
              className="rounded-lg text-xs font-medium px-3 py-1.5 text-[var(--muted)] hover:bg-[var(--surface-3)]"
            >
              Descartar import
            </button>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-xl px-3.5 py-2 text-sm font-medium text-[var(--muted)] hover:bg-[var(--surface-3)] transition"
        >
          Cancelar
        </button>
        <button
          onClick={() => onSave(tpl)}
          disabled={saving || !tpl.name.trim()}
          className="rounded-xl bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white font-semibold text-sm px-3.5 py-2 transition"
        >
          {saving ? 'Salvando…' : 'Salvar modelo'}
        </button>
      </div>
    </div>
  )
}

const PREVIEW_TITLE = { layout: 'title', heading: null }
const PREVIEW_BULLETS = { layout: 'bullets', heading: 'Título do slide', bullets: ['Primeiro ponto', 'Segundo ponto'] }

export default function DeckTemplatesSettings({ open, isAdmin = false }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(null) // null | { id?, ...fields }
  const [inspecting, setInspecting] = useState(null) // null | template
  const [savingId, setSavingId] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState('')
  const [importError, setImportError] = useState('')
  const fileInputRef = useRef(null)
  const folderInputRef = useRef(null)

  const load = async () => {
    setLoading(true)
    try {
      const r = await getJSON('/api/deck-templates')
      setTemplates(r.templates || [])
    } catch {
      // surfaced implicitly by the empty-state below
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open])

  const select = async (id) => {
    if (templates.find((t) => t.id === id)?.isSelected) return
    setTemplates((prev) => prev.map((t) => ({ ...t, isSelected: t.id === id })))
    try {
      await postJSON(`/api/deck-templates/${id}/select`, {})
    } catch {
      load()
    }
  }

  // deletion keeps the grid in place: the card shows a spinner while the
  // DELETE is in flight and only disappears when the server confirms — the
  // rest of the list never refetches/flashes
  const remove = async (id) => {
    if (templates.length <= 1 || deletingId) return
    setDeletingId(id)
    try {
      await del(`/api/deck-templates/${id}`)
      setTemplates((prev) => {
        const wasSelected = prev.find((t) => t.id === id)?.isSelected
        const next = prev.filter((t) => t.id !== id)
        if (!wasSelected || !next.length) return next
        // mirror the server's promotion rule (most recent remaining wins)
        const promoted = next.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a))
        return next.map((t) => ({ ...t, isSelected: t.id === promoted.id }))
      })
    } catch {
      load()
    } finally {
      setDeletingId(null)
    }
  }

  const duplicate = (t) => {
    // a copy is always a PERSONAL template, even when duplicating a global one
    setEditing({ ...t, id: undefined, scope: undefined, canEdit: undefined, name: `${t.name} (cópia)` })
  }

  // publish/unpublish org-wide (admin only; server re-checks)
  const setScope = async (t, scope) => {
    setTemplates((prev) => prev.map((x) => (x.id === t.id ? { ...x, scope } : x)))
    try {
      await postJSON(`/api/deck-templates/${t.id}/scope`, { scope })
    } catch {
      load()
    }
  }

  // the grid holds summary rows — keep local updates summary-shaped so a
  // just-imported bundle (readme/dsCards can be several MB) doesn't sit in
  // the list state after saving
  const toSummary = (t) => {
    if (!t) return t
    const { readme, dsCards, _importReport, ...rest } = t
    return {
      ...rest,
      hasReadme: !!readme || !!t.hasReadme,
      hasDsCards: !!(dsCards && dsCards.length) || !!t.hasDsCards,
    }
  }

  const saveEditing = async (rawTpl) => {
    // the import report is review-UI-only, never persisted
    const { _importReport, ...tpl } = rawTpl
    setSavingId(true)
    try {
      if (editing?.id) {
        await patchJSON(`/api/deck-templates/${editing.id}`, tpl)
        setTemplates((prev) => prev.map((t) => (t.id === editing.id ? toSummary({ ...t, ...tpl }) : t)))
      } else {
        const r = await postJSON('/api/deck-templates', tpl)
        const created = toSummary(r?.template)
        if (created?.id) {
          setTemplates((prev) => {
            const next = created.isSelected ? prev.map((t) => ({ ...t, isSelected: false })) : prev
            return [...next, created]
          })
        } else {
          await load()
        }
      }
      setEditing(null)
    } finally {
      setSavingId(false)
    }
  }

  // A design system can arrive as SEVERAL files at once — slide templates
  // (.pptx), a saved .json, loose logos/icons, a bundle FOLDER or .zip
  // exported by a design tool (Claude Design) — mined and merged into one
  // reviewable draft (see extractFromFiles / dsImport.js).
  const onImportFiles = async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setImportError('')
    setImporting(true)
    try {
      const extracted = await extractFromFiles(files, null, { onProgress: setImportStatus })
      setEditing({
        ...EMPTY_TEMPLATE,
        ...extracted,
        name: extracted.name || stripExt(files[0].name),
      })
    } catch (e) {
      setImportError(e.message || 'falha ao importar')
    } finally {
      setImporting(false)
      setImportStatus('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      if (folderInputRef.current) folderInputRef.current.value = ''
    }
  }

  return (
    <div>
      <label className="text-sm font-semibold flex items-center gap-2">
        <Icon.Presentation size={16} /> Modelos de apresentação
      </label>
      <p className="text-xs text-[var(--faint)] mt-1">
        Design systems para os decks (.pptx) que a IA cria a partir das suas conversas — o modelo
        selecionado aplica automaticamente cores (HEX), fontes, logo, ícones, fotos e diagramas.
        Importe quantos arquivos quiser (.pptx da marca, logos e ícones avulsos): tudo é opcional,
        mas quanto mais completo o design system, maior a aderência do resultado.
      </p>

      {loading ? (
        <p className="text-xs text-[var(--faint)] mt-3">Carregando…</p>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2.5">
            {templates.map((t) => (
              <div
                key={t.id}
                className={`rounded-xl border p-2 transition ${
                  t.isSelected ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] hover:bg-[var(--surface-2)]'
                } ${deletingId === t.id ? 'opacity-60' : ''}`}
              >
                <button onClick={() => select(t.id)} className="w-full text-left">
                  <div className="grid grid-cols-2 gap-1">
                    <DeckSlidePreview slide={PREVIEW_TITLE} template={t} deckTitle={t.name || 'Sem título'} variant="card" />
                    <DeckSlidePreview slide={PREVIEW_BULLETS} template={t} variant="card" />
                  </div>
                  <div className="flex items-center gap-1.5 mt-1.5 px-0.5">
                    {t.isSelected && <Icon.Check size={13} className="text-[var(--accent)] shrink-0" />}
                    <span className="text-xs font-medium truncate flex-1">{t.name || 'Sem nome'}</span>
                  </div>
                  {t.scope === 'global' && (
                    <div className="flex items-center gap-1 mt-1 px-0.5 text-[10px] text-[var(--accent)]">
                      <Icon.Globe2 size={11} className="shrink-0" />
                      <span className="truncate">Padrão da organização</span>
                    </div>
                  )}
                </button>
                <div className="flex items-center gap-1 mt-1 px-0.5">
                  <button
                    onClick={() => setInspecting(t)}
                    className="p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--muted)]"
                    title="Inspecionar design system"
                  >
                    <Icon.Eye size={13} />
                  </button>
                  {t.canEdit !== false && (
                    <button
                      onClick={() => setEditing(t)}
                      className="p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--muted)]"
                      title="Editar"
                    >
                      <Icon.Pencil size={13} />
                    </button>
                  )}
                  <button
                    onClick={() => duplicate(t)}
                    className="p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--muted)]"
                    title="Duplicar"
                  >
                    <Icon.Copy size={13} />
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => setScope(t, t.scope === 'global' ? 'user' : 'global')}
                      className={`p-1 rounded-md hover:bg-[var(--surface-3)] ${
                        t.scope === 'global' ? 'text-[var(--accent)]' : 'text-[var(--muted)]'
                      }`}
                      title={
                        t.scope === 'global'
                          ? 'Tornar pessoal (deixa de ser padrão da organização)'
                          : 'Disponibilizar para todos (padrão da organização)'
                      }
                    >
                      <Icon.Globe2 size={13} />
                    </button>
                  )}
                  {t.canEdit !== false && (
                    <button
                      onClick={() => remove(t.id)}
                      disabled={templates.length <= 1 || deletingId === t.id}
                      className="p-1 rounded-md hover:bg-[var(--surface-3)] text-[var(--muted)] disabled:opacity-30"
                      title={deletingId === t.id ? 'Excluindo…' : 'Excluir'}
                    >
                      {deletingId === t.id ? (
                        <span className="block w-[13px] h-[13px] rounded-full border-2 border-[var(--muted)] border-t-transparent animate-spin" />
                      ) : (
                        <Icon.Trash size={13} />
                      )}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {editing ? (
            <TemplateForm
              initial={editing}
              saving={savingId}
              onCancel={() => setEditing(null)}
              onSave={saveEditing}
              onCreateNew={(patch) =>
                setEditing({ ...EMPTY_TEMPLATE, ...patch, name: patch.name || 'Novo design system' })
              }
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                onClick={() => setEditing({ ...EMPTY_TEMPLATE })}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-[var(--surface-3)] hover:brightness-110 text-[13px] font-semibold px-3 py-2.5 transition whitespace-nowrap"
              >
                <Icon.Plus size={15} className="shrink-0" /> Novo modelo
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-[var(--surface-3)] hover:brightness-110 disabled:opacity-60 text-[13px] font-semibold px-3 py-2.5 transition whitespace-nowrap"
                title="Importe arquivos: .pptx da marca, .zip de design system, .json exportado, logos e ícones avulsos"
              >
                <Icon.Upload size={15} className="shrink-0" /> {importing ? 'Importando…' : 'Importar arquivos'}
              </button>
              <button
                onClick={() => folderInputRef.current?.click()}
                disabled={importing}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-[var(--surface-3)] hover:brightness-110 disabled:opacity-60 text-[13px] font-semibold px-3 py-2.5 transition whitespace-nowrap"
                title="Importe a PASTA exportada do design system (README, tokens, fontes, SVGs, specimens) — ex.: export do Claude Design"
              >
                <Icon.Folder size={15} className="shrink-0" /> {importing ? 'Importando…' : 'Importar pasta'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.pptx,.zip,image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                multiple
                className="hidden"
                onChange={(e) => onImportFiles(e.target.files)}
              />
              <input
                ref={folderInputRef}
                type="file"
                webkitdirectory=""
                className="hidden"
                onChange={(e) => onImportFiles(e.target.files)}
              />
            </div>
          )}
          {!editing && (
            <p className="text-[11px] text-[var(--faint)]">
              Quer montar um design system completo?{' '}
              <button
                onClick={async () => {
                  try {
                    await (await import('../lib/starterKit.js')).downloadStarterKit()
                  } catch (e) {
                    setImportError(e.message || 'falha ao baixar o kit')
                  }
                }}
                className="underline hover:text-[var(--text)]"
              >
                Baixe o kit inicial (.zip)
              </button>{' '}
              — uma pasta-exemplo com instruções de preenchimento, convenções de nome e limites.
            </p>
          )}
          {importing && importStatus && <p className="text-xs text-[var(--faint)]">{importStatus}</p>}
          {importError && <p className="text-xs text-[var(--accent)]">{importError}</p>}
        </div>
      )}

      <DeckTemplateInspector template={inspecting} onClose={() => setInspecting(null)} />
    </div>
  )
}
