import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as Icon from './Icons.jsx'
import TemplateSlidePreview from './TemplateSlidePreview.jsx'
import { MinedDiagramSvg, resolvePreviewTheme, useTemplateFonts } from './DeckSlidePreview.jsx'
import { getJSON } from '../api.js'
import { useT } from '../lib/i18n.jsx'

// Read-only "Design System" viewer for a single template — mirrors the
// browsing experience of Claude Design's own Design System page: a sidebar of
// grouped entries (Readme, Templates, Brand, Colors, Components, Slides,
// Type, …) and a main panel rendering each card. Bundle imports (dsImport.js)
// provide README/palette/fonts/specimen HTML; plain .pptx-mined templates
// fall back to the mined sections (colors, icons, diagrams, preview slides).
// No section is a fixed reproduction of any reference bundle — a template
// without that data simply doesn't show the section.

// ---- specimen card (self-contained HTML from the bundle) --------------------

// Sandboxed iframe (scripts allowed for <deck-stage>, but NO same-origin so
// bundle JS can never touch the app). Slides/templates author at a fixed
// 1280×720 stage → scaled to fit; free-flowing preview cards get a natural
// height with internal scrolling.
function SpecimenFrame({ card }) {
  const isStage = card.group === 'Slides' || card.group === 'Templates' || card.group === 'UI Kit — Website'
  const wrapRef = useRef(null)
  const [scale, setScale] = useState(0.5)
  useEffect(() => {
    if (!isStage || !wrapRef.current) return
    const el = wrapRef.current
    const update = () => setScale(el.clientWidth / 1280)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [isStage])

  if (isStage) {
    return (
      <div ref={wrapRef} className="w-full overflow-hidden rounded-b-xl" style={{ aspectRatio: '16/9', background: '#0e1a1f' }}>
        <iframe
          title={card.title}
          sandbox="allow-scripts"
          srcDoc={card.html}
          className="border-0 origin-top-left"
          style={{ width: 1280, height: 720, transform: `scale(${scale})` }}
        />
      </div>
    )
  }
  return (
    <iframe
      title={card.title}
      sandbox="allow-scripts"
      srcDoc={card.html}
      className="w-full border-0 rounded-b-xl bg-white"
      style={{ height: 340 }}
    />
  )
}

function CardShell({ title, description, children }) {
  return (
    <div className="rounded-xl border border-[var(--border)] overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-baseline gap-2">
        <span className="text-sm font-semibold">{title}</span>
        {description && <span className="text-[11px] text-[var(--faint)] truncate">{description}</span>}
      </div>
      {children}
    </div>
  )
}

// ---- sections ---------------------------------------------------------------

function ReadmeSection({ template }) {
  // Reading column centered in the panel (with comfortable side gutters on wide
  // screens) instead of hugging the left edge — the readme is a prose page, so
  // the negative space reads better balanced around the text than pooled on the right.
  return (
    <div className="prose-chat text-sm max-w-3xl mx-auto lg:px-6 [&_h1]:text-xl [&_h2]:text-base [&_h2]:mt-6 [&_table]:text-xs">
      <Markdown remarkPlugins={[remarkGfm]}>{template.readme}</Markdown>
    </div>
  )
}

const coreSwatches = (t) => [
  ['primaryColor', t('templateInspector.colorPrimary')],
  ['secondaryColor', t('templateInspector.colorSecondary')],
  ['accentColor', t('templateInspector.colorAccent')],
  ['backgroundColor', t('templateInspector.colorBackground')],
]

function Swatch({ name, value, sub }) {
  const light = (() => {
    const c = (value || '#CCCCCC').replace('#', '')
    return (0.299 * parseInt(c.slice(0, 2), 16) + 0.587 * parseInt(c.slice(2, 4), 16) + 0.114 * parseInt(c.slice(4, 6), 16)) / 255 > 0.62
  })()
  return (
    <div className="rounded-xl overflow-hidden border border-[var(--border)]">
      <div className="h-16 flex flex-col justify-end p-2" style={{ background: value || '#CCCCCC', color: light ? '#1A1A1A' : '#FFFFFF' }}>
        <div className="text-[11px] font-bold leading-tight">{name}</div>
        <div className="text-[10px] font-mono opacity-80 uppercase">{value}</div>
      </div>
      {sub && <div className="px-2 py-1 text-[10px] text-[var(--faint)] font-mono truncate">{sub}</div>}
    </div>
  )
}

function ColorsSection({ template, cards }) {
  const t = useT()
  const palette = template.palette || []
  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <div className="text-xs font-semibold text-[var(--faint)] mb-2">{t('templateInspector.colorsApplied')}</div>
        <div className="grid grid-cols-4 gap-2.5">
          {coreSwatches(t).map(([key, label]) => (
            <Swatch key={key} name={label} value={template[key] || '#CCCCCC'} />
          ))}
        </div>
      </div>
      {palette.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-[var(--faint)] mb-2">{t('templateInspector.fullPalette', { n: palette.length })}</div>
          <div className="grid grid-cols-5 gap-2.5">
            {palette.map((t) => (
              <Swatch key={t.varName} name={t.name} value={t.value} sub={t.varName} />
            ))}
          </div>
        </div>
      )}
      <CardsList cards={cards} />
    </div>
  )
}

function TypeSection({ template, cards }) {
  const t = useT()
  useTemplateFonts(template)
  const families = [...new Set((template.fontAssets || []).map((f) => f.family))]
  return (
    <div className="space-y-4 max-w-3xl">
      {[
        ['headingFont', t('templateInspector.headingFont')],
        ['bodyFont', t('templateInspector.bodyFont')],
      ].map(([key, label]) => (
        <div key={key} className="rounded-xl border border-[var(--border)] p-4">
          <div className="text-xs font-semibold text-[var(--faint)] mb-2">
            {label} — {template[key] || t('templateInspector.fontUndefined')}
            {families.includes(template[key]) && ` · ${t('templateInspector.webfontLoaded')}`}
          </div>
          <div style={{ fontFamily: template[key] || 'inherit' }} className="text-2xl">
            Aa Bb Cc — do more with your data
          </div>
          <div style={{ fontFamily: template[key] || 'inherit' }} className="text-sm mt-1 text-[var(--muted)]">
            abcdefghijklmnopqrstuvwxyz · 0123456789 · R$ 1.234,56
          </div>
        </div>
      ))}
      {(template.fontAssets || []).length > 0 && (
        <div className="text-[11px] text-[var(--faint)]">
          {t('templateInspector.fontFilesPrefix', { n: template.fontAssets.length })} {families.join(', ')}{t('templateInspector.fontFilesSuffix')}
        </div>
      )}
      <CardsList cards={cards} />
    </div>
  )
}

const brandGroups = (t) => [
  ['icon', t('templateInspector.brandIcons')],
  ['lockup', t('templateInspector.brandLockups')],
  ['illustration', t('templateInspector.brandIllustrations')],
  ['background', t('templateInspector.brandBackgrounds')],
  ['image', t('templateInspector.brandImages')],
  ['watermark', t('templateInspector.brandWatermarks')],
]

function BrandSection({ template, cards }) {
  const t = useT()
  const assets = template.iconAssets || []
  const byKind = (k) => assets.filter((a) => (a.kind || 'icon') === k)
  return (
    <div className="space-y-6">
      {(template.logoDataUrl || template.logoLightDataUrl) && (
        <div>
          <div className="text-xs font-semibold text-[var(--faint)] mb-2">{t('templateInspector.logo')}</div>
          <div className="flex gap-2.5">
            {template.logoDataUrl && (
              <div className="rounded-xl border border-[var(--border)] p-4 flex items-center justify-center" style={{ background: template.primaryColor || '#1A1A2E', minWidth: 180 }}>
                <img src={template.logoDataUrl} alt={t('templateInspector.logoDarkAlt')} className="h-8 object-contain" />
              </div>
            )}
            {template.logoLightDataUrl && (
              <div className="rounded-xl border border-[var(--border)] p-4 flex items-center justify-center" style={{ background: template.backgroundColor || '#FFFFFF', minWidth: 180 }}>
                <img src={template.logoLightDataUrl} alt={t('templateInspector.logoLightAlt')} className="h-8 object-contain" />
              </div>
            )}
          </div>
        </div>
      )}
      {brandGroups(t).map(([kind, label]) => {
        const items = byKind(kind)
        if (!items.length) return null
        const dark = kind === 'illustration'
        const wide = kind === 'background' || kind === 'lockup'
        return (
          <div key={kind}>
            <div className="text-xs font-semibold text-[var(--faint)] mb-2">
              {label} ({items.length})
            </div>
            <div className={`grid gap-2.5 ${wide ? 'grid-cols-4' : 'grid-cols-6'}`}>
              {items.map((a) => (
                <div
                  key={a.id}
                  className={`rounded-lg border border-[var(--border)] p-2 flex flex-col items-center gap-1 ${kind === 'watermark' ? 'opacity-60' : ''}`}
                  style={dark ? { background: template.primaryColor || '#1A1A2E' } : undefined}
                  title={a.label || a.id}
                >
                  <img src={a.dataUrl} alt="" className={`object-contain ${wide ? 'w-full h-14' : 'w-9 h-9'}`} />
                  <span className={`text-[10px] truncate w-full text-center ${dark ? 'text-white/70' : 'text-[var(--faint)]'}`}>{a.label || '—'}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
      <CardsList cards={cards} />
    </div>
  )
}

function CardsList({ cards }) {
  if (!cards?.length) return null
  return (
    <div className="space-y-4">
      {cards.map((c) => (
        <CardShell key={c.id} title={c.title} description={c.description}>
          <SpecimenFrame card={c} />
        </CardShell>
      ))}
    </div>
  )
}

// Vector diagrams mined from the template's own slides (minedStyle.diagrams)
// — the exact art the model can drop into generated decks via `diagramRef`.
function DiagramsSection({ template }) {
  const t = useT()
  const diagrams = template.minedStyle?.diagrams || []
  const theme = resolvePreviewTheme(template)
  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-[11px] text-[var(--faint)]">
        {t('templateInspector.diagramsIntro')}
      </p>
      {diagrams.map((d) => (
        <div key={d.id} className="rounded-xl border border-[var(--border)] overflow-hidden">
          <div
            className="w-full flex items-center justify-center p-4"
            style={{ background: template.backgroundColor || '#FFFFFF', aspectRatio: '16/7' }}
          >
            <MinedDiagramSvg spec={d} theme={theme} className="w-full h-full" />
          </div>
          <div className="px-3 py-2 border-t border-[var(--border)]">
            <div className="text-xs font-semibold truncate">{d.label || d.id}</div>
            <div className="text-[10px] text-[var(--faint)]">
              {t('templateInspector.diagramShapes', { shapes: d.shapes?.length || 0, connectors: d.connectors?.length || 0 })}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function MinedSlidesSection({ template }) {
  const t = useT()
  const slides = template.previewSlides || []
  const [index, setIndex] = useState(0)
  const active = slides[index] || slides[0]
  return (
    <div className="flex gap-4 h-full">
      <div className="w-32 shrink-0 space-y-2 overflow-y-auto">
        {slides.map((s, i) => (
          <button key={i} onClick={() => setIndex(i)} className="block w-full">
            <TemplateSlidePreview
              slide={s}
              template={template}
              variant="thumb"
              className={`ring-2 transition ${i === index ? 'ring-[var(--accent)]' : 'ring-transparent hover:ring-[var(--border)]'}`}
            />
          </button>
        ))}
      </div>
      <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-3">
        <div className="w-full max-w-xl flex items-center gap-2">
          <button
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
            className="p-1.5 rounded-lg hover:bg-[var(--surface-3)] disabled:opacity-30 text-[var(--muted)]"
          >
            <Icon.ChevronLeft size={18} />
          </button>
          <span className="text-xs text-[var(--faint)] flex-1 text-center">
            {t('templateInspector.slideOf', { current: index + 1, total: slides.length })}
          </span>
          <button
            onClick={() => setIndex((i) => Math.min(slides.length - 1, i + 1))}
            disabled={index === slides.length - 1}
            className="p-1.5 rounded-lg hover:bg-[var(--surface-3)] disabled:opacity-30 text-[var(--muted)]"
          >
            <Icon.ChevronRight size={18} />
          </button>
        </div>
        <TemplateSlidePreview slide={active} template={template} variant="canvas" className="w-full max-w-xl shadow-lg" />
      </div>
    </div>
  )
}

// ---- main -------------------------------------------------------------------

export default function DeckTemplateInspector({ template: summary, onClose }) {
  const t = useT()
  // list rows are summaries (no readme/specimen cards) — hydrate on open
  const [full, setFull] = useState(null)
  useEffect(() => {
    setFull(null)
    if (!summary?.id) return
    getJSON(`/api/deck-templates/${summary.id}`)
      .then((r) => setFull(r.template))
      .catch(() => setFull(summary))
  }, [summary?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const template = full || summary
  const cardsByGroup = useMemo(() => {
    const map = new Map()
    for (const c of template?.dsCards || []) {
      if (!map.has(c.group)) map.set(c.group, [])
      map.get(c.group).push(c)
    }
    return map
  }, [template])

  const sections = useMemo(() => {
    if (!template) return []
    const list = []
    const assets = template.iconAssets || []
    // labels exibidos em pt-BR; os ids e as CHAVES de grupo (`c.group`, vindas
    // do manifest do bundle) permanecem originais — só o texto é traduzido
    if (template.readme) list.push({ id: 'readme', label: t('templateInspector.sectionReadme') })
    if (cardsByGroup.has('Templates')) list.push({ id: 'templates', label: t('templateInspector.sectionTemplates') })
    if (assets.length || template.logoDataUrl) list.push({ id: 'brand', label: t('templateInspector.sectionBrand') })
    list.push({ id: 'colors', label: t('templateInspector.sectionColors') })
    if (cardsByGroup.has('Components')) list.push({ id: 'components', label: t('templateInspector.sectionComponents') })
    if (cardsByGroup.has('Slides')) list.push({ id: 'slides', label: t('templateInspector.sectionSlides') })
    list.push({ id: 'type', label: t('templateInspector.sectionType') })
    if (cardsByGroup.has('Spacing')) list.push({ id: 'spacing', label: t('templateInspector.sectionSpacing') })
    if (template.minedStyle?.diagrams?.length) list.push({ id: 'diagramas', label: t('templateInspector.sectionDiagrams') })
    if (template.previewSlides?.length) list.push({ id: 'slides-modelo', label: t('templateInspector.sectionModelSlides') })
    return list
  }, [template, cardsByGroup, t])

  const [section, setSection] = useState('readme')
  useEffect(() => {
    if (summary) setSection(summary.hasReadme || summary.readme ? 'readme' : 'colors')
  }, [summary?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!summary) return null

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-[var(--bg)] animate-fade-in">
      <header className="shrink-0 h-14 flex items-center gap-3 px-4 border-b border-[var(--border)]">
        <button onClick={onClose} className="p-2 -ml-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]">
          <Icon.Close size={20} />
        </button>
        <Icon.Eye size={18} className="text-[var(--accent)]" />
        <span className="font-semibold text-sm">{t('templateInspector.headerTitle', { name: template.name || t('templateInspector.defaultName') })}</span>
        {!full && <span className="text-xs text-[var(--faint)]">{t('templateInspector.loadingShort')}</span>}
      </header>

      <div className="flex-1 flex min-h-0">
        <div className="w-52 shrink-0 border-r border-[var(--border)] p-3 space-y-1 overflow-y-auto">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`w-full text-left text-sm rounded-lg px-3 py-2 transition ${
                section === s.id ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium' : 'hover:bg-[var(--surface-3)] text-[var(--muted)]'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
          {section === 'readme' && template.readme && <ReadmeSection template={template} />}
          {section === 'templates' && <CardsList cards={cardsByGroup.get('Templates')} />}
          {section === 'brand' && <BrandSection template={template} cards={cardsByGroup.get('Brand')} />}
          {section === 'colors' && <ColorsSection template={template} cards={cardsByGroup.get('Colors')} />}
          {section === 'components' && <CardsList cards={cardsByGroup.get('Components')} />}
          {section === 'slides' && <CardsList cards={cardsByGroup.get('Slides')} />}
          {section === 'type' && <TypeSection template={template} cards={cardsByGroup.get('Type')} />}
          {section === 'spacing' && <CardsList cards={cardsByGroup.get('Spacing')} />}
          {section === 'diagramas' && <DiagramsSection template={template} />}
          {section === 'slides-modelo' && <MinedSlidesSection template={template} />}
        </div>
      </div>
    </div>
  )
}
