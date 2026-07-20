import { Fragment, useEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n.jsx'
import { DECK_ICONS } from '../../../shared/deckIcons.js'
import { flattenElements, chartPalette, materializeSlide, ENGINE_LAYOUTS } from '../../../shared/deckLayout.js'
import {
  resolveDeckTheme,
  pickDeckIllustration,
  hexOr as themeHexOr,
  luminance as themeLuminance,
  blend,
  contrastOn,
  resolveThemeColor,
} from '../../../shared/deckTheme.js'

// Self-hosted design-system webfonts (template.fontAssets, from a bundle
// import) registered once per family/weight/style — the preview and Present
// mode then render in the REAL brand font instead of a system fallback. The
// .pptx references fonts by name; viewers with the font installed match 1:1.
const loadedFonts = new Set()
export function useTemplateFonts(template) {
  useEffect(() => {
    if (typeof FontFace === 'undefined') return
    for (const f of template?.fontAssets || []) {
      const key = `${f.family}|${f.weight}|${f.style}`
      if (!f.dataUrl || loadedFonts.has(key)) continue
      loadedFonts.add(key)
      try {
        const face = new FontFace(f.family, `url(${f.dataUrl})`, { weight: f.weight || '400', style: f.style || 'normal' })
        face.load().then((ff) => document.fonts.add(ff)).catch(() => {})
      } catch {
        // malformed font data — preview falls back to the system stack
      }
    }
  }, [template])
}

// Shared "what will render in the .pptx" preview — used both as the tiny
// thumbnail strip on the chat card and the thumbnail rail / main canvas in
// the Deck Studio, so what the user edits always matches what gets exported.
// Mirrors server/decks.js: same derived color tokens (blend math), same slide
// chrome (kicker / assertion title / hairline / footer / callout), same
// layouts — sizes are expressed in container-query units so every variant
// (thumb/canvas) is an exact proportional scale of the 10in-wide pptx canvas.
// Theme resolution lives in shared/deckTheme.js (one source for BOTH
// renderers — the pptx side adapts the same tokens to bare hex). The only
// client-side touch: CSS font stacks get web-safe fallbacks when the template
// doesn't declare fonts.
export function resolvePreviewTheme(template) {
  const t = resolveDeckTheme(template)
  return {
    ...t,
    headingFont: template?.headingFont ? t.headingFont : 'Georgia, serif',
    bodyFont: template?.bodyFont ? t.bodyFont : 'Helvetica, Arial, sans-serif',
  }
}

export function pickPreviewIllustration(theme, seed = 0) {
  return pickDeckIllustration(theme, seed)
}

function hexOr(c, fallback) {
  return themeHexOr(c, fallback)
}

function luminance(hexColor) {
  return themeLuminance(hexColor)
}

// Per-element style overrides a user sets in the Studio (slide.styles[path]
// — see sanitizeSlideStyles in server/blocks.js). The pptx renderer applies
// the same overrides via applyOv in server/decks.js.
export function ovStyle(slide, path) {
  const o = slide?.styles?.[path]
  if (!o) return null
  const st = {}
  if (o.fontSize) st.fontSize = `${o.fontSize / 7.2}cqw`
  if (o.color) st.color = o.color
  if (o.bold != null) st.fontWeight = o.bold ? 700 : 400
  if (o.italic != null) st.fontStyle = o.italic ? 'italic' : 'normal'
  if (o.align) st.textAlign = o.align
  return st
}

// pptx canvas is 10in wide → 1in = 10cqw; font pt → pt/72 in → pt/7.2 cqw
const inch = (v) => `${v * 10}cqw`
const pt = (v) => `${v / 7.2}cqw`
const M = 0.62 // GRID.margin

// the template's OWN mined decorative motif (see mineSlideTheme), re-drawn at
// its original slide position — same as addMinedMotif in server/decks.js;
// templates without one get nothing
function MinedMotif({ theme }) {
  const m = theme.motif
  if (!m?.shapes?.length) return null
  const dotPct = Math.max(m.dotW * 100, 0.3)
  const fallback = blend(theme.onPrimary, theme.primary, 0.35)
  return (
    <div
      className="absolute"
      style={{
        left: `${m.box.x * 100}%`, top: `${m.box.y * 100}%`,
        width: `${m.box.w * 100}%`, height: `${m.box.h * 100}%`,
      }}
      aria-hidden
    >
      {m.shapes.map((sh, i) => (
        <span
          key={i}
          className="absolute"
          style={{
            left: `${sh.x * 100}%`, top: `${sh.y * 100}%`,
            width: `${dotPct}cqw`, height: `${dotPct}cqw`,
            borderRadius: m.geom === 'ellipse' ? '50%' : '10%',
            background: hexOr(sh.color, fallback),
          }}
        />
      ))}
    </div>
  )
}

// A selectable (and, when selected, double-click-editable) slide element —
// the bridge between the visual preview and the Studio's "click an object to
// tweak it" flow. `ctx` is null outside the Studio canvas, which reduces this
// to a plain positioned div with zero overhead in chat cards/thumbnails.
// `text` present ⇒ the element is a text node editable in place; the commit
// goes through ctx.onEditText(path, value) into the deck JSON.
export function SelBox({ ctx, path, label, text, children, style, className = '', ...rest }) {
  const [editing, setEditing] = useState(false)
  const ref = useRef(null)
  const selected = ctx && ctx.selectedPath === path
  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      const range = document.createRange()
      range.selectNodeContents(ref.current)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }, [editing])
  if (!ctx) {
    return (
      <div className={className} style={style} {...rest}>
        {children ?? text}
      </div>
    )
  }
  const commit = () => {
    setEditing(false)
    const v = ref.current?.innerText ?? ''
    if (text != null && v !== text) ctx.onEditText?.(path, v)
  }
  return (
    <div
      className={`${className} ${selected ? 'prism-sel-selected' : 'prism-sel'}`}
      style={{ ...style, cursor: editing ? 'text' : 'pointer' }}
      onClick={(e) => {
        e.stopPropagation()
        if (!editing) ctx.onSelect?.(path, label, text)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (text != null) setEditing(true)
      }}
      {...rest}
    >
      {editing ? (
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          className="outline-none min-w-[1ch]"
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commit()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(false)
            }
            e.stopPropagation()
          }}
        >
          {text}
        </div>
      ) : (
        children ?? text
      )}
    </div>
  )
}

function Kicker({ text, color, theme, ctx, path = 'kicker', slide }) {
  const t = useT()
  return (
    <div className="flex items-center" style={{ gap: inch(0.1) }}>
      <div style={{ width: inch(0.34), height: inch(0.038), background: color, flexShrink: 0 }} />
      <SelBox
        ctx={ctx}
        path={path}
        label={t('deckPreview.kicker')}
        text={text}
        className="uppercase truncate"
        style={{ color, fontSize: pt(10), fontWeight: 700, letterSpacing: '0.18em', fontFamily: theme.bodyFont, ...ovStyle(slide, path) }}
      />
    </div>
  )
}

function Callout({ callout, theme, ctx, slide }) {
  const t = useT()
  return (
    <div
      style={{
        background: theme.primary, borderRadius: inch(0.06), padding: `${inch(0.09)} ${inch(0.24)}`,
        minHeight: inch(0.7), display: 'flex', flexDirection: 'column', justifyContent: 'center',
      }}
    >
      {callout.kicker && (
        <SelBox
          ctx={ctx}
          path="callout.kicker"
          label={t('deckPreview.calloutKicker')}
          text={callout.kicker}
          className="uppercase"
          style={{ color: theme.accent, fontSize: pt(8.5), fontWeight: 700, letterSpacing: '0.16em', fontFamily: theme.bodyFont, ...ovStyle(slide, 'callout.kicker') }}
        />
      )}
      <SelBox
        ctx={ctx}
        path="callout.text"
        label={t('deckPreview.calloutText')}
        text={callout.text}
        style={{ color: theme.onPrimary, fontSize: pt(12.5), fontWeight: 700, fontFamily: theme.headingFont, lineHeight: 1.15, ...ovStyle(slide, 'callout.text') }}
      />
    </div>
  )
}

const LEVEL_GLYPHS = { full: '●', partial: '◑', none: '○' }

// Same rule as diagramPlateColor in server/decks.js: when the mined art's
// dominant fills sit too close to the deck background, a plate approximating
// the background it was designed on goes behind it. Keep the math in sync.
function diagramPlateColor(spec, backgroundHex) {
  const bg = luminance(backgroundHex)
  const fills = (spec.shapes || []).filter((s) => s.color)
  if (!fills.length) return null
  const area = fills.reduce((a, s) => a + s.w * s.h, 0) || 0.0001
  const wavg = (f) => fills.reduce((a, s) => a + f(s) * s.w * s.h, 0) / area
  const meanDistance = wavg((s) => Math.abs(luminance(s.color) - bg))
  if (meanDistance >= 0.18) return null
  // prefer the background the art was designed on (mined as spec.bg)
  if (spec.bg && Math.abs(luminance(spec.bg) - bg) >= 0.18) return spec.bg
  const fillLum = wavg((s) => luminance(s.color))
  return fillLum < 0.5 ? blend('#FFFFFF', backgroundHex, 0.06) : blend('#000000', backgroundHex, 0.82)
}

// Mined vector diagram (design system asset baked into an `image` slide as
// `diagramSpec` — see drawMinedDiagram in server/decks.js): re-drawn as SVG
// with the same crop-to-content + scale-to-fit math as the pptx renderer.
// Colors are the mined originals; text uses the theme's body font.
export function MinedDiagramSvg({ spec, theme, className = '', style }) {
  if (!spec?.shapes?.length) return null
  const plate = diagramPlateColor(spec, theme.background)
  const aspect = spec.aspect || 16 / 9
  const srcW = 1000
  const srcH = srcW / aspect
  const all = [...spec.shapes, ...(spec.connectors || [])]
  const minX = Math.min(...all.map((p) => p.x)) * srcW
  const minY = Math.min(...all.map((p) => p.y)) * srcH
  const maxX = Math.max(...all.map((p) => p.x + p.w)) * srcW
  const maxY = Math.max(...all.map((p) => p.y + p.h)) * srcH
  const pad = 8
  const contrast = (hexColor) => (hexColor && luminance(hexColor) < 0.55 ? '#FFFFFF' : '#1A1A1A')
  return (
    <svg
      viewBox={`${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`}
      className={className}
      style={style}
      preserveAspectRatio="xMidYMid meet"
    >
      {plate && (
        <rect
          x={minX - pad} y={minY - pad} width={maxX - minX + pad * 2} height={maxY - minY + pad * 2}
          rx={10} fill={plate} stroke={theme.hairline} strokeWidth={1}
        />
      )}
      {spec.shapes.map((sh, i) => {
        const x = sh.x * srcW
        const y = sh.y * srcH
        const w = sh.w * srcW
        const h = sh.h * srcH
        const fill = sh.color || 'transparent'
        const stroke = sh.line || (!sh.color ? theme.hairline : 'none')
        const rot = sh.rot ? `rotate(${sh.rot} ${x + w / 2} ${y + h / 2})` : undefined
        const common = { fill, stroke, strokeWidth: 1.5, transform: rot }
        return (
          <g key={i}>
            {sh.geom === 'ellipse' || sh.geom === 'pie' ? (
              <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />
            ) : sh.geom === 'diamond' ? (
              <polygon points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`} {...common} />
            ) : sh.geom === 'triangle' ? (
              <polygon points={`${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}`} {...common} />
            ) : (
              <rect x={x} y={y} width={w} height={h} rx={sh.geom === 'roundRect' || sh.geom === 'can' ? Math.min(w, h) * 0.15 : 0} {...common} />
            )}
            {sh.text && (
              <foreignObject x={x} y={y} width={w} height={h} transform={rot}>
                <div
                  xmlns="http://www.w3.org/1999/xhtml"
                  style={{
                    width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    textAlign: 'center', overflow: 'hidden', lineHeight: 1.1,
                    fontFamily: theme.bodyFont,
                    fontWeight: sh.bold ? 700 : 400,
                    // fontPt was normalized to a 10in canvas → 1pt ≈ srcW/720 px here
                    fontSize: `${Math.max(((sh.fontPt || 12) * srcW) / 720, 7)}px`,
                    color: sh.textColor || contrast(sh.color || plate || theme.background),
                    padding: '2%',
                  }}
                >
                  {sh.text}
                </div>
              </foreignObject>
            )}
          </g>
        )
      })}
      {(spec.connectors || []).map((c, i) => {
        const x = c.x * srcW
        const y = c.y * srcH
        const w = c.w * srcW
        const h = c.h * srcH
        // flips mirror the line inside its bounding box, same as PowerPoint
        const x1 = c.flipH ? x + w : x
        const y1 = c.flipV ? y + h : y
        const x2 = c.flipH ? x : x + w
        const y2 = c.flipV ? y : y + h
        const stroke = c.color || theme.muted
        return (
          <g key={`c${i}`}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={2} />
            {c.arrow && (
              <polygon
                points="0,-5 10,0 0,5"
                fill={stroke}
                transform={`translate(${x2} ${y2}) rotate(${(Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI})`}
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}

// --- freeform (element canvas): dumb DOM painter over shared/deckLayout.js --
// Mirrors paintElements in server/decks.js element-for-element; the Studio
// wraps each element with selection/drag handles via `ctx.el*` callbacks (F1).
const SHAPE_CLIPS = {
  triangle: 'polygon(50% 0, 100% 100%, 0 100%)',
  diamond: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)',
  chevron: 'polygon(0 0, 75% 0, 100% 50%, 75% 100%, 0 100%, 25% 50%)',
  rightArrow: 'polygon(0 30%, 60% 30%, 60% 0, 100% 50%, 60% 100%, 60% 70%, 0 70%)',
}
const DASH_CSS = { solid: 'solid', dash: 'dashed', dot: 'dotted' }

function elementBoxStyle(el) {
  const { x, y, w, h } = el.box
  return {
    position: 'absolute',
    left: inch(x),
    top: inch(y),
    width: inch(Math.max(w, 0.01)),
    height: inch(Math.max(h, 0.01)),
    transform: el.rotate ? `rotate(${el.rotate}deg)` : undefined,
  }
}

function elementShadowCss(st) {
  if (!st.shadow) return undefined
  const sh = st.shadow === true ? {} : st.shadow
  const op = ((sh.opacity ?? 35) / 100).toFixed(2)
  const c = (sh.color || '#000000').replace('#', '')
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16)
  return `0 ${(sh.offset ?? 2) / 7.2}cqw ${(sh.blur ?? 6) / 7.2}cqw rgba(${r},${g},${b},${op})`
}

export function ElementView({ el, theme, iconById }) {
  const t = useT()
  const st = el.style || {}
  const box = elementBoxStyle(el)
  const opacity = st.opacity != null ? st.opacity / 100 : 1
  if (el.type === 'shape') {
    const clip = SHAPE_CLIPS[el.shape]
    return (
      <div
        style={{
          ...box,
          background: st.fill === 'none' ? 'transparent' : st.fill || theme.accentSoft,
          borderRadius: el.shape === 'ellipse' ? '50%' : st.radius || el.shape === 'roundRect' ? inch(st.radius ?? 0.08) : 0,
          border: st.borderColor ? `${(st.borderWidth ?? 1) / 7.2}cqw ${DASH_CSS[st.borderDash] || 'solid'} ${st.borderColor}` : undefined,
          clipPath: clip,
          opacity,
          boxShadow: clip ? undefined : elementShadowCss(st),
        }}
      />
    )
  }
  if (el.type === 'text') {
    const lines = String(el.text || '').split('\n')
    return (
      <div
        style={{
          ...box,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: st.valign === 'middle' ? 'center' : st.valign === 'bottom' ? 'flex-end' : 'flex-start',
          background: st.fill && st.fill !== 'none' ? st.fill : undefined,
          borderRadius: st.radius ? inch(st.radius) : undefined,
          border: st.borderColor ? `${(st.borderWidth ?? 1) / 7.2}cqw ${DASH_CSS[st.borderDash] || 'solid'} ${st.borderColor}` : undefined,
          overflow: st.overflow === 'hidden' ? 'hidden' : 'visible',
          opacity,
          boxShadow: elementShadowCss(st),
          // PowerPoint's default text-box insets (~0.1in nas laterais)
          padding: `${inch(0.04)} ${inch(0.095)}`,
          fontFamily: st.fontFamily || (st.fontRole === 'heading' ? theme.headingFont : theme.bodyFont),
          fontSize: pt(st.fontSize || 13),
          color: st.color || theme.bodyText,
          fontWeight: st.bold ? 700 : 400,
          fontStyle: st.italic ? 'italic' : 'normal',
          textDecoration: st.underline ? 'underline' : undefined,
          textAlign: st.align || 'left',
          lineHeight: st.lineHeight || 1.2,
          letterSpacing: st.letterSpacing ? pt(st.letterSpacing) : undefined,
          textTransform: st.uppercase ? 'uppercase' : undefined,
          whiteSpace: 'pre-wrap',
        }}
      >
        {st.bullet ? (
          // gap mirrors the pptx side's paraSpaceAfter (max(8, size*0.85)pt in
          // paintElements/bulletsBody) so both renderers space lists equally
          <ul style={{ display: 'flex', flexDirection: 'column', gap: pt(Math.max(8, (st.fontSize || 13) * 0.85)) }}>
            {lines.map((l, i) => (
              <li key={i} style={{ display: 'flex', gap: '0.45em' }}>
                <span>•</span>
                <span style={{ minWidth: 0 }}>{l}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span>{el.text}</span>
        )}
      </div>
    )
  }
  if (el.type === 'line') {
    const { w, h } = el.box
    // flips mirror the line inside its box, same as the pptx side
    const x1 = el.flipH ? 100 : 0
    const y1 = el.flipV ? 100 : 0
    const x2 = el.flipH ? 0 : 100
    const y2 = el.flipV ? 0 : 100
    const stroke = st.lineColor || theme.accent
    const strokeWidth = `${(st.lineWidth ?? 2) / 7.2}cqw`
    const dash = st.dash === 'dash' ? '6 4' : st.dash === 'dot' ? '2 3' : undefined
    return (
      <svg style={{ ...box, overflow: 'visible', opacity }} preserveAspectRatio="none" viewBox="0 0 100 100">
        <line
          x1={x1} y1={h === 0 ? 50 : y1} x2={x2} y2={h === 0 ? 50 : y2}
          stroke={stroke} strokeDasharray={dash}
          style={{ strokeWidth, vectorEffect: 'non-scaling-stroke' }}
          markerStart={st.arrowStart ? `url(#as-${el.id})` : undefined}
          markerEnd={st.arrowEnd ? `url(#ae-${el.id})` : undefined}
        />
        <defs>
          <marker id={`ae-${el.id}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill={stroke} />
          </marker>
          <marker id={`as-${el.id}`} viewBox="0 0 10 10" refX="2" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M10 0 L0 5 L10 10 z" fill={stroke} />
          </marker>
        </defs>
      </svg>
    )
  }
  if (el.type === 'icon') {
    const asset = el.icon?.assetId ? iconById.get(el.icon.assetId) : null
    const paths = !asset && el.icon?.builtin ? DECK_ICONS[el.icon.builtin] : null
    const hasPlate = st.fill && st.fill !== 'none'
    return (
      <div
        style={{
          ...box,
          background: hasPlate ? st.fill : 'transparent',
          borderRadius: st.radius ? inch(st.radius) : hasPlate ? '22%' : 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity,
        }}
      >
        {asset ? (
          <img src={asset.dataUrl} alt="" style={{ width: hasPlate ? '68%' : '100%', height: hasPlate ? '68%' : '100%', objectFit: 'contain' }} />
        ) : paths ? (
          <svg viewBox="0 0 24 24" style={{ width: hasPlate ? '60%' : '100%', height: hasPlate ? '60%' : '100%' }} fill="none" stroke={st.color || theme.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {paths.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </svg>
        ) : null}
      </div>
    )
  }
  if (el.type === 'chart') {
    return <ChartElView el={el} theme={theme} />
  }
  if (el.type === 'image') {
    const data = el.imageDataUrl || (el.imageAssetId ? iconById.get(el.imageAssetId)?.dataUrl : null)
    return (
      <div style={{ ...box, opacity, borderRadius: st.radius ? inch(st.radius) : undefined, overflow: 'hidden' }}>
        {data ? (
          <img src={data} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <div
            style={{
              width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `1px dashed ${theme.hairline}`, borderRadius: inch(0.07), color: theme.faint, fontSize: pt(10), fontStyle: 'italic',
            }}
          >
            {t('deckPreview.image')}
          </div>
        )}
      </div>
    )
  }
  return null
}

// SVG approximation of the NATIVE pptx chart kinds (bar/barH/line/area/pie/
// doughnut/scatter) for freeform `chart` elements — heatmap/gantt never get
// here, flattenElements already expanded them into primitives. Coordinates
// live in a viewBox where 1in = 72 units, so font sizes are real points and
// the drawing scales with the slide exactly like everything else.
function arcPath(cx, cy, r0, r1, a0, a1) {
  const p = (r, a) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`
}

export function ChartElView({ el, theme }) {
  const c = el.chart || {}
  const palette = chartPalette(theme)
  const W = Math.max(el.box.w, 0.5) * 72
  const H = Math.max(el.box.h, 0.5) * 72
  const round = c.kind === 'pie' || c.kind === 'doughnut'
  const series = c.series || []
  const cats = series[0]?.data?.map((d) => d.label) || []
  const showLegend = c.showLegend !== false && (round || series.length > 1)
  const legendItems = round ? cats.map((l, i) => [l, palette[i % palette.length]]) : series.map((s, i) => [s.name, palette[i % palette.length]])
  const legendH = showLegend ? 13 : 0
  const catLabelH = round || c.kind === 'scatter' ? 0 : c.kind === 'barH' ? 0 : 11
  const plot = { x: c.kind === 'barH' ? Math.min(W * 0.26, 90) : 2, y: 3, w: 0, h: 0 }
  plot.w = W - plot.x - 2
  plot.h = H - plot.y - catLabelH - legendH - 2
  const allVals = series.flatMap((s) => (s.data || []).map((d) => d.value))
  const vMax = Math.max(...allVals, 0) || 1
  const vMin = Math.min(...allVals, 0)
  const span = vMax - vMin || 1
  const label = (x, y, t, anchor = 'middle', size = 8) => (
    <text key={`l${x}_${y}_${t}`} x={x} y={y} fontSize={size} fill={theme.muted} textAnchor={anchor} fontFamily={theme.bodyFont}>
      {t}
    </text>
  )
  const body = []
  if (round) {
    const data = series[0]?.data || []
    const total = data.reduce((a, d) => a + Math.max(d.value, 0), 0) || 1
    const cx = W / 2
    const cy = plot.y + plot.h / 2
    const r = Math.max(Math.min(plot.w, plot.h) / 2 - 2, 8)
    const r0 = c.kind === 'doughnut' ? r * 0.6 : 0.01
    let a = -Math.PI / 2
    data.forEach((d, i) => {
      const a1 = a + (Math.max(d.value, 0) / total) * Math.PI * 2
      body.push(<path key={i} d={arcPath(cx, cy, r0, r, a, Math.min(a1, a + Math.PI * 1.999))} fill={palette[i % palette.length]} stroke={theme.background} strokeWidth="1" />)
      a = a1
    })
  } else if (c.kind === 'scatter') {
    const pts = series.flatMap((s, si) => (s.points || []).map((p) => ({ ...p, si })))
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const x0 = Math.min(...xs, 0)
    const x1 = Math.max(...xs, 1)
    const y0 = Math.min(...ys, 0)
    const y1 = Math.max(...ys, 1)
    for (let g = 1; g <= 3; g++) {
      const gy = plot.y + (plot.h * g) / 4
      body.push(<line key={`g${g}`} x1={plot.x} y1={gy} x2={plot.x + plot.w} y2={gy} stroke={theme.hairline} strokeWidth="0.5" />)
    }
    pts.forEach((p, i) => {
      const px = plot.x + ((p.x - x0) / (x1 - x0 || 1)) * plot.w
      const py = plot.y + plot.h - ((p.y - y0) / (y1 - y0 || 1)) * plot.h
      body.push(<circle key={`p${i}`} cx={px} cy={py} r="2.6" fill={palette[p.si % palette.length]} />)
    })
  } else if (c.kind === 'barH') {
    const n = Math.max(cats.length, 1)
    const slot = plot.h / n
    const barH = (slot * 0.66) / Math.max(series.length, 1)
    cats.forEach((cat, ci) => {
      body.push(label(plot.x - 4, plot.y + ci * slot + slot / 2 + 2.6, String(cat), 'end', 7.5))
      series.forEach((s, si) => {
        const v = s.data?.[ci]?.value || 0
        const bw = (Math.max(v - Math.min(vMin, 0), 0) / span) * plot.w
        body.push(
          <rect key={`b${ci}_${si}`} x={plot.x} y={plot.y + ci * slot + (slot - barH * series.length) / 2 + si * barH} width={bw} height={barH * 0.92} fill={palette[si % palette.length]} rx="1" />
        )
      })
    })
  } else {
    // bar / line / area share the category grid
    for (let g = 1; g <= 3; g++) {
      const gy = plot.y + (plot.h * g) / 4
      body.push(<line key={`g${g}`} x1={plot.x} y1={gy} x2={plot.x + plot.w} y2={gy} stroke={theme.hairline} strokeWidth="0.5" />)
    }
    body.push(<line key="base" x1={plot.x} y1={plot.y + plot.h} x2={plot.x + plot.w} y2={plot.y + plot.h} stroke={theme.hairline} strokeWidth="0.75" />)
    const n = Math.max(cats.length, 1)
    const slot = plot.w / n
    const Y = (v) => plot.y + plot.h - ((v - Math.min(vMin, 0)) / span) * plot.h
    if (c.kind === 'bar') {
      const barW = (slot * 0.62) / Math.max(series.length, 1)
      series.forEach((s, si) => {
        ;(s.data || []).forEach((d, ci) => {
          const x = plot.x + ci * slot + (slot - barW * series.length) / 2 + si * barW
          body.push(<rect key={`b${si}_${ci}`} x={x} y={Y(Math.max(d.value, 0))} width={barW * 0.92} height={Math.abs(Y(0) - Y(d.value))} fill={palette[si % palette.length]} rx="1" />)
        })
      })
    } else {
      series.forEach((s, si) => {
        const pts = (s.data || []).map((d, ci) => `${plot.x + ci * slot + slot / 2},${Y(d.value)}`)
        if (c.kind === 'area') {
          body.push(
            <polygon key={`a${si}`} points={`${plot.x + slot / 2},${Y(0)} ${pts.join(' ')} ${plot.x + (n - 1) * slot + slot / 2},${Y(0)}`} fill={palette[si % palette.length]} opacity="0.25" />
          )
        }
        body.push(<polyline key={`s${si}`} points={pts.join(' ')} fill="none" stroke={palette[si % palette.length]} strokeWidth="1.75" strokeLinejoin="round" />)
      })
    }
    cats.forEach((cat, ci) => {
      body.push(label(plot.x + ci * slot + slot / 2, plot.y + plot.h + 8.5, String(cat), 'middle', 7.5))
    })
  }
  if (showLegend) {
    const itemW = Math.min(legendItems.length ? (W - 8) / legendItems.length : W, 90)
    const startX = (W - itemW * legendItems.length) / 2
    legendItems.forEach(([name, color], i) => {
      body.push(<rect key={`lg${i}`} x={startX + i * itemW} y={H - 9.5} width="6" height="6" rx="1" fill={color} />)
      body.push(
        <text key={`lt${i}`} x={startX + i * itemW + 9} y={H - 4} fontSize="7" fill={theme.muted} fontFamily={theme.bodyFont}>
          {String(name).slice(0, 18)}
        </text>
      )
    })
  }
  return (
    <svg style={{ ...elementBoxStyle(el), opacity: el.style?.opacity != null ? el.style.opacity / 100 : 1 }} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {body}
    </svg>
  )
}

// A materialized element that maps back to a slide-JSON field (el.editPath,
// stamped by pushText in the shared generators) becomes selectable + inline-
// editable, exactly like SelBox does for the hand-JSX layouts. This is what
// lets the engine-painted preview keep the Studio's click-an-object-to-tweak
// flow. Elements without an editPath (plates, rules, motif, page numbers) are
// painted straight through, non-interactive. The absolutely-positioned element
// box IS the hit target, so selection lands on the same geometry the .pptx
// paints — no drift between what you click and what exports.
function SelectableElementView({ el, theme, iconById, ctx }) {
  const path = el.editPath
  const editable = el.type === 'text' && typeof el.text === 'string'
  const [editing, setEditing] = useState(false)
  const ref = useRef(null)
  const selected = ctx && path && ctx.selectedPath === path
  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus()
      const range = document.createRange()
      range.selectNodeContents(ref.current)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }, [editing])
  // outside the Studio (no ctx) or non-mapped decoration: plain paint
  if (!ctx || !path) return <ElementView el={el} theme={theme} iconById={iconById} />
  const commit = () => {
    setEditing(false)
    const v = ref.current?.innerText ?? ''
    if (editable && v !== el.text) ctx.onEditText?.(path, v)
  }
  if (editing) {
    // paint the text box chrome, but swap its content for a contentEditable so
    // the caret sits exactly where the glyphs render (same box, same insets)
    return (
      <div
        style={{ ...elementBoxStyleForEdit(el, theme), cursor: 'text' }}
        className="prism-sel-selected"
      >
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          className="outline-none w-full h-full"
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commit()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(false)
            }
            e.stopPropagation()
          }}
        >
          {el.text}
        </div>
      </div>
    )
  }
  // a transparent hit-target box at the element's exact geometry, layered just
  // over the painted element — clicking selects, double-click edits text
  return (
    <>
      <ElementView el={el} theme={theme} iconById={iconById} />
      <div
        className={selected ? 'prism-sel-selected' : 'prism-sel'}
        style={{ ...elementBoxStyle(el), cursor: 'pointer', background: 'transparent' }}
        onClick={(e) => {
          e.stopPropagation()
          ctx.onSelect?.(path, el.editLabel || path, editable ? el.text : undefined)
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (editable) setEditing(true)
        }}
      />
    </>
  )
}

// The engine paints text with pptx-style box insets; when a text element goes
// into inline edit we reuse the SAME visual box (absolute, sized in cqw) so the
// contentEditable overlays the glyphs 1:1 with no jump.
function elementBoxStyleForEdit(el, theme) {
  const st = el.style || {}
  return {
    ...elementBoxStyle(el),
    display: 'flex',
    flexDirection: 'column',
    justifyContent: st.valign === 'middle' ? 'center' : st.valign === 'bottom' ? 'flex-end' : 'flex-start',
    padding: `${inch(0.04)} ${inch(0.095)}`,
    fontFamily: st.fontFamily || (st.fontRole === 'heading' ? theme.headingFont : theme.bodyFont),
    fontSize: pt(st.fontSize || 13),
    color: st.color || theme.bodyText,
    fontWeight: st.bold ? 700 : 400,
    fontStyle: st.italic ? 'italic' : 'normal',
    textAlign: st.align || 'left',
    lineHeight: st.lineHeight || 1.2,
    textTransform: st.uppercase ? 'uppercase' : undefined,
    whiteSpace: 'pre-wrap',
  }
}

// Semantic slide painted through the shared materializeSlide + the same dumb
// ElementView the freeform canvas and the .pptx export use — one geometry, so
// the preview and the export can no longer drift. Each mapped field stays
// selectable/editable via SelectableElementView. The engine box's absolute
// children position themselves; the wrapper divs are absolute:inset-0 shells
// so selection outlines hug the real element geometry.
function EngineLayer({ mat, theme, iconById, ctx }) {
  const flat = flattenElements(mat.elements, theme)
  return (
    <>
      {flat.map((el) => (
        <SelectableElementView key={el.id} el={el} theme={theme} iconById={iconById} ctx={ctx} />
      ))}
    </>
  )
}

export function ElementsLayer({ elements, theme, iconById }) {
  // persisted freeform is a TREE (groups/stacks/tokens/composed charts) —
  // flatten to the absolute primitives ElementView paints, exactly like the
  // pptx side does before paintElements
  const flat = flattenElements(elements, theme)
  return (
    <>
      {flat.map((el) => (
        <ElementView key={el.id} el={el} theme={theme} iconById={iconById} />
      ))}
    </>
  )
}

export default function DeckSlidePreview({
  slide,
  template,
  deckTitle,
  deck,
  variant = 'thumb',
  pageNumber,
  sectionNo,
  className = '',
  // Studio canvas selection/edit wiring (see SelBox) — absent everywhere else
  selectable = false,
  selectedPath = null,
  onSelectElement,
  onEditText,
}) {
  const t = useT()
  const theme = resolvePreviewTheme(template)
  useTemplateFonts(template)
  const ctx = selectable ? { selectedPath, onSelect: onSelectElement, onEditText } : null
  const ov = (path) => ovStyle(slide, path)
  const iconById = new Map((template?.iconAssets || []).map((a) => [a.id, a]))
  // same fallback chain as addItemIcon in server/decks.js: real template
  // icon → neutral built-in pictogram (accent-tinted line art) → nothing
  const Icon = ({ iconAssetId, icon, size = 0.3 }) => {
    const asset = iconAssetId ? iconById.get(iconAssetId) : null
    const paths = !asset && icon ? DECK_ICONS[icon] : null
    if (!asset && !paths) return null
    return (
      <span
        style={{
          width: inch(size), height: inch(size), background: theme.accentSoft, borderRadius: '22%',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}
      >
        {asset ? (
          <img src={asset.dataUrl} alt="" style={{ width: '68%', height: '68%', objectFit: 'contain' }} />
        ) : (
          <svg viewBox="0 0 24 24" style={{ width: '64%', height: '64%' }} fill="none" stroke={theme.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {paths.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </svg>
        )}
      </span>
    )
  }

  const layout = slide?.layout || 'bullets'
  const isFreeform = layout === 'freeform'
  const d = deck || { title: deckTitle }
  const heading = slide?.heading || (layout === 'title' ? d.title : '') || ''
  const isDark = layout === 'title' || layout === 'section' || layout === 'closing' || layout === 'quote'
  // audience is verbatim, already localized by the model (see footerMeta in
  // server/decks.js) — never an English-hardcoded prefix
  const meta = d.audience || d.title || ''

  // UNIFIED ENGINE PATH (renderer unification, Fase 2a): a semantic slide that
  // the .pptx export renders through materializeSlide is painted here through
  // the SAME materialization + the same dumb ElementView. This is the fix for
  // preview↔export drift — one geometry, one fit-math, one source of truth.
  // Gate mirrors the export's exactly (server/decks.js): ENGINE_LAYOUTS, and
  // NOT a slide carrying a mined diagramSpec or user `styles` overrides (those
  // stay on the legacy hand-JSX path both sides). Any materialization hiccup
  // falls back to the hand-JSX below — never a blank slide.
  const engineMat = (() => {
    if (isFreeform || !ENGINE_LAYOUTS.has(layout)) return null
    if (slide?.diagramSpec || (slide?.styles && Object.keys(slide.styles).length > 0)) return null
    try {
      return materializeSlide(slide, theme, {
        index: (pageNumber ?? 1) - 1,
        total: deck?.slides?.length ?? 1,
        pageNumber: pageNumber ?? null,
        sectionNo: sectionNo ?? 0,
        meta,
        audience: d.audience || '',
        deckTitle: d.title || '',
        author: d.author || '',
      })
    } catch {
      return null
    }
  })()

  const body = () => {
    switch (layout) {
      case 'bullets':
      case 'two-column': {
        const bullets = slide?.bullets || []
        const size = bullets.length <= 3 ? 15 : bullets.length <= 5 ? 13 : 12
        const List = ({ items, offset = 0 }) => (
          <ul className="flex-1 min-w-0" style={{ fontSize: pt(size), color: theme.bodyText, display: 'flex', flexDirection: 'column', gap: pt(size * 0.7) }}>
            {items.map((b, i) => (
              <li key={i} className="flex" style={{ gap: inch(0.12) }}>
                <span style={{ color: theme.bodyText }}>•</span>
                <SelBox ctx={ctx} path={`bullets[${offset + i}]`} label={t('deckPreview.bulletN', { n: offset + i + 1 })} text={b} style={{ lineHeight: 1.15, ...ov(`bullets[${offset + i}]`) }} />
              </li>
            ))}
          </ul>
        )
        const mid = Math.ceil(bullets.length / 2)
        return (
          <div className="flex flex-col h-full" style={{ gap: inch(0.12) }}>
            {slide?.body && layout === 'bullets' && (
              <SelBox ctx={ctx} path="body" label={t('deckPreview.supportText')} text={slide.body} style={{ fontSize: pt(13), color: theme.muted, lineHeight: 1.2, ...ov('body') }} />
            )}
            {layout === 'two-column' ? (
              <div className="flex" style={{ gap: inch(0.28) }}>
                <List items={bullets.slice(0, mid)} />
                <List items={bullets.slice(mid)} offset={mid} />
              </div>
            ) : (
              <List items={bullets} />
            )}
          </div>
        )
      }
      case 'agenda': {
        const items = (slide?.items?.length ? slide.items : (slide?.bullets || []).map((b) => ({ title: b }))).slice(0, 7)
        return (
          <div className="flex flex-col justify-start h-full">
            {items.map((item, i) => (
              <div
                key={i}
                className="flex items-center min-h-0"
                style={{ gap: inch(0.18), flex: 1, borderBottom: i < items.length - 1 ? `1px solid ${theme.hairline}` : 'none' }}
              >
                <div style={{ fontFamily: theme.headingFont, fontWeight: 700, color: theme.accent, fontSize: pt(15), width: inch(0.55), flexShrink: 0 }}>
                  {String(i + 1).padStart(2, '0')}
                </div>
                <div className="min-w-0">
                  <SelBox
                    ctx={ctx}
                    path={`items[${i}].title`}
                    label={t('deckPreview.itemTitle', { n: i + 1 })}
                    text={item.title}
                    className="truncate"
                    style={{ fontFamily: theme.headingFont, fontWeight: 700, fontSize: pt(13.5), color: theme.heading, ...ov(`items[${i}].title`) }}
                  />
                  {item.body && (
                    <SelBox ctx={ctx} path={`items[${i}].body`} label={t('deckPreview.itemBody', { n: i + 1 })} text={item.body} className="truncate" style={{ fontSize: pt(10.5), color: theme.muted, ...ov(`items[${i}].body`) }} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      }
      case 'cards': {
        const cards = (slide?.cards || []).slice(0, 6)
        // same column rule as cardsSlide in server/decks.js
        const cols = cards.length <= 1 ? 1 : cards.length === 2 || cards.length === 4 ? 2 : 3
        return (
          <div className="grid h-full" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gap: inch(0.28) }}>
            {cards.map((c, i) => (
              <div
                key={i}
                className="min-w-0 overflow-hidden"
                style={{ background: theme.cardFill, border: `1px solid ${theme.hairline}`, borderRadius: inch(0.07), padding: inch(0.2) }}
              >
                <Icon iconAssetId={c.iconAssetId} icon={c.icon} size={0.36} />
                <SelBox
                  ctx={ctx}
                  path={`cards[${i}].heading`}
                  label={t('deckPreview.cardHeading', { n: i + 1 })}
                  text={c.heading}
                  style={{ fontFamily: theme.headingFont, fontWeight: 700, fontSize: pt(12.5), color: theme.heading, lineHeight: 1.1, marginTop: c.iconAssetId ? inch(0.08) : 0, ...ov(`cards[${i}].heading`) }}
                />
                {c.body && (
                  <SelBox ctx={ctx} path={`cards[${i}].body`} label={t('deckPreview.cardBody', { n: i + 1 })} text={c.body} style={{ fontSize: pt(10), color: theme.muted, lineHeight: 1.18, marginTop: inch(0.04), ...ov(`cards[${i}].body`) }} />
                )}
              </div>
            ))}
          </div>
        )
      }
      case 'stat-grid': {
        const stats = (slide?.stats || []).slice(0, 4)
        return (
          <div className="flex items-center h-full" style={{ gap: inch(0.28) }}>
            {stats.map((st, i) => (
              <div
                key={i}
                className="flex-1 min-w-0"
                style={{
                  background: theme.cardFill, border: `1px solid ${theme.hairline}`, borderRadius: inch(0.07),
                  padding: inch(0.2), height: '92%', display: 'flex', flexDirection: 'column',
                }}
              >
                <div style={{ width: inch(0.42), height: inch(0.05), background: theme.accent, marginBottom: inch(0.14) }} />
                <SelBox
                  ctx={ctx}
                  path={`stats[${i}].value`}
                  label={t('deckPreview.kpiValue', { n: i + 1 })}
                  text={st.value}
                  className="truncate"
                  style={{ fontFamily: theme.headingFont, fontWeight: 700, fontSize: pt(26), color: theme.heading, ...ov(`stats[${i}].value`) }}
                />
                {st.label && (
                  <SelBox ctx={ctx} path={`stats[${i}].label`} label={t('deckPreview.kpiLabel', { n: i + 1 })} text={st.label} style={{ fontSize: pt(10), color: theme.muted, lineHeight: 1.18, ...ov(`stats[${i}].label`) }} />
                )}
              </div>
            ))}
          </div>
        )
      }
      case 'comparison': {
        const sides = [
          { key: 'left', title: slide?.leftTitle, bullets: slide?.leftBullets, fill: theme.cardFill, border: theme.hairline, bar: theme.hairline, titleColor: theme.muted },
          { key: 'right', title: slide?.rightTitle, bullets: slide?.rightBullets, fill: theme.accentSoft, border: theme.accent, bar: theme.accent, titleColor: theme.heading },
        ]
        return (
          <div className="flex h-full" style={{ gap: inch(0.28) }}>
            {sides.map((side, i) => (
              <div
                key={i}
                className="flex-1 min-w-0 overflow-hidden"
                style={{ background: side.fill, border: `1px solid ${side.border}`, borderRadius: inch(0.07), padding: inch(0.22) }}
              >
                <div className="flex items-center" style={{ gap: inch(0.1), marginBottom: inch(0.12) }}>
                  <div style={{ width: inch(0.34), height: inch(0.045), background: side.bar, flexShrink: 0 }} />
                  <SelBox
                    ctx={ctx}
                    path={`${side.key}Title`}
                    label={side.key === 'left' ? t('deckPreview.comparisonTitleLeft') : t('deckPreview.comparisonTitleRight')}
                    text={side.title}
                    className="truncate"
                    style={{ fontFamily: theme.headingFont, fontWeight: 700, fontSize: pt(12.5), color: side.titleColor, ...ov(`${side.key}Title`) }}
                  />
                </div>
                <ul style={{ fontSize: pt(11.5), color: theme.bodyText, display: 'flex', flexDirection: 'column', gap: pt(8) }}>
                  {(side.bullets || []).map((b, bi) => (
                    <li key={bi} className="flex" style={{ gap: inch(0.1) }}>
                      <span>•</span>
                      <SelBox
                        ctx={ctx}
                        path={`${side.key}Bullets[${bi}]`}
                        label={side.key === 'left' ? t('deckPreview.comparisonItemLeft', { n: bi + 1 }) : t('deckPreview.comparisonItemRight', { n: bi + 1 })}
                        text={b}
                        style={{ lineHeight: 1.15, ...ov(`${side.key}Bullets[${bi}]`) }}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )
      }
      case 'timeline': {
        const phases = (slide?.phases || []).slice(0, 5)
        return (
          <div className="relative flex h-full" style={{ gap: inch(0.22), paddingTop: inch(0.2) }}>
            <div
              className="absolute"
              style={{ left: `${50 / Math.max(phases.length, 1)}%`, right: `${50 / Math.max(phases.length, 1)}%`, top: inch(0.37), height: 1.5, background: theme.hairline }}
            />
            {phases.map((p, i) => (
              <div key={i} className="relative flex-1 text-center min-w-0">
                {p.iconAssetId || p.icon ? (
                  <div className="flex justify-center"><Icon iconAssetId={p.iconAssetId} icon={p.icon} size={0.4} /></div>
                ) : (
                  <div
                    className="mx-auto flex items-center justify-center"
                    style={{
                      width: inch(0.34), height: inch(0.34), borderRadius: '50%', background: theme.accent,
                      color: theme.onAccent, fontFamily: theme.headingFont, fontWeight: 700, fontSize: pt(11),
                    }}
                  >
                    {i + 1}
                  </div>
                )}
                {p.period && (
                  <SelBox
                    ctx={ctx}
                    path={`phases[${i}].period`}
                    label={t('deckPreview.phasePeriod', { n: i + 1 })}
                    text={p.period}
                    className="uppercase truncate"
                    style={{ color: theme.accent, fontWeight: 700, fontSize: pt(8.5), letterSpacing: '0.12em', marginTop: inch(0.08), ...ov(`phases[${i}].period`) }}
                  />
                )}
                <SelBox
                  ctx={ctx}
                  path={`phases[${i}].label`}
                  label={t('deckPreview.phaseName', { n: i + 1 })}
                  text={p.label}
                  className="truncate"
                  style={{ fontFamily: theme.headingFont, fontWeight: 700, fontSize: pt(12.5), color: theme.heading, marginTop: inch(0.02), ...ov(`phases[${i}].label`) }}
                />
                {p.body && (
                  <SelBox ctx={ctx} path={`phases[${i}].body`} label={t('deckPreview.phaseBody', { n: i + 1 })} text={p.body} style={{ fontSize: pt(9.5), color: theme.muted, lineHeight: 1.18, marginTop: inch(0.04), ...ov(`phases[${i}].body`) }} />
                )}
              </div>
            ))}
          </div>
        )
      }
      case 'table': {
        const columns = slide?.columns || []
        const highlight = Number.isInteger(slide?.highlightColumn) ? slide.highlightColumn : -1
        const isLevel = slide?.cellStyle === 'level'
        return (
          <table className="w-full h-fit" style={{ fontSize: pt(10), borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {columns.map((c, ci) => (
                  <th
                    key={ci}
                    className="truncate"
                    style={{
                      background: ci === highlight ? theme.accent : theme.primary,
                      color: theme.onPrimary, fontFamily: theme.headingFont, fontSize: pt(10.5),
                      padding: `${inch(0.06)} ${inch(0.08)}`, textAlign: ci === 0 ? 'left' : 'center',
                    }}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(slide?.rows || []).slice(0, 8).map((r, ri) => (
                <tr key={ri}>
                  {columns.map((_, ci) => {
                    const raw = String((Array.isArray(r) ? r[ci] : '') ?? '')
                    const glyph = isLevel && ci > 0 ? LEVEL_GLYPHS[raw.trim().toLowerCase()] : null
                    return (
                      <td
                        key={ci}
                        className="truncate"
                        style={{
                          padding: `${inch(0.045)} ${inch(0.08)}`,
                          textAlign: ci === 0 ? 'left' : 'center',
                          fontWeight: ci === 0 ? 700 : 400,
                          color: glyph ? (raw.trim().toLowerCase() === 'none' ? theme.faint : theme.accent) : ci === 0 ? theme.heading : theme.bodyText,
                          fontSize: glyph ? pt(13) : pt(10),
                          background: ci === highlight ? theme.accentSoft : ri % 2 ? blend('#000000', theme.background, 0.985) : 'transparent',
                          borderBottom: `1px solid ${theme.hairline}`,
                        }}
                      >
                        {glyph || raw}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
      case 'diagram': {
        const columns = (slide?.columns || []).slice(0, 4)
        return (
          <div className="flex items-stretch h-full" style={{ gap: inch(0.06) }}>
            {columns.map((col, i) => (
              <Fragment key={i}>
                <div
                  className="flex flex-col min-w-0"
                  style={{ flex: col.emphasis || col.bands?.length ? 1.9 : 1, gap: inch(0.08) }}
                >
                  <SelBox
                    ctx={ctx}
                    path={`columns[${i}].label`}
                    label={t('deckPreview.diagramColumn', { n: i + 1 })}
                    text={col.label}
                    className="uppercase truncate text-center"
                    style={{ fontSize: pt(8.5), fontWeight: 700, letterSpacing: '0.14em', color: theme.muted, ...ov(`columns[${i}].label`) }}
                  />
                  {col.emphasis || col.bands?.length ? (
                    <div className="flex-1 flex flex-col" style={{ background: theme.primary, borderRadius: inch(0.08), padding: inch(0.14), gap: inch(0.1) }}>
                      {col.sublabel && (
                        <div className="text-center truncate" style={{ fontSize: pt(8.5), color: theme.onPrimaryMuted }}>{col.sublabel}</div>
                      )}
                      {(col.bands || []).slice(0, 5).map((band, bi) => (
                        <SelBox
                          key={bi}
                          ctx={ctx}
                          path={`columns[${i}].bands[${bi}].label`}
                          label={t('deckPreview.diagramBand', { label: band.label })}
                          text={band.label}
                          className="flex-1 flex items-center justify-center text-center min-h-0"
                          style={{
                            background: band.tone === 'accent' ? theme.accent : blend(theme.onPrimary, theme.primary, 0.88),
                            color: band.tone === 'accent' ? theme.onAccent : theme.onPrimary,
                            borderRadius: inch(0.05), fontFamily: theme.headingFont, fontWeight: 700, fontSize: pt(10),
                            padding: `0 ${inch(0.08)}`, lineHeight: 1.1,
                            ...ov(`columns[${i}].bands[${bi}].label`),
                          }}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col" style={{ gap: inch(0.12) }}>
                      {(col.items || []).slice(0, 6).map((item, ii) => (
                        <div
                          key={ii}
                          className="flex-1 flex items-center min-h-0"
                          style={{
                            background: theme.cardFill, border: `1px solid ${theme.hairline}`, borderRadius: inch(0.05),
                            padding: `0 ${inch(0.1)}`, gap: inch(0.08), maxHeight: inch(0.52),
                          }}
                        >
                          <Icon iconAssetId={item.iconAssetId} icon={item.icon} size={0.26} />
                          <SelBox
                            ctx={ctx}
                            path={`columns[${i}].items[${ii}].label`}
                            label={t('deckPreview.diagramBox', { label: item.label })}
                            text={item.label}
                            style={{ fontSize: pt(9.5), fontWeight: 700, color: theme.heading, lineHeight: 1.1, ...ov(`columns[${i}].items[${ii}].label`) }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {i < columns.length - 1 && (
                  <div className="self-center" style={{ width: 0, height: 0, borderTop: `${inch(0.08)} solid transparent`, borderBottom: `${inch(0.08)} solid transparent`, borderLeft: `${inch(0.14)} solid ${theme.accent}`, flexShrink: 0 }} />
                )}
              </Fragment>
            ))}
          </div>
        )
      }
      case 'chart':
        return slide?.series?.[0]?.data?.length ? (
          <div className="flex items-end justify-center h-full" style={{ gap: inch(0.12) }}>
            {slide.series[0].data.slice(0, 8).map((dd, i) => {
              const max = Math.max(...slide.series[0].data.map((x) => Math.abs(x.value)), 1)
              const h = Math.max(8, Math.round((Math.abs(dd.value) / max) * 100))
              return <div key={i} style={{ height: `${h}%`, background: i ? theme.primary : theme.accent, width: inch(0.55), borderRadius: `${inch(0.03)} ${inch(0.03)} 0 0` }} />
            })}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center" style={{ fontSize: pt(12), color: theme.faint }}>
            {t('deckPreview.noChartData')}
          </div>
        )
      case 'image':
        // same precedence as imageSlide in server/decks.js: an uploaded image
        // wins; else the baked mined diagram; else the dashed placeholder
        return slide?.imageDataUrl ? (
          <img src={slide.imageDataUrl} alt="" className="w-full h-full object-contain" />
        ) : slide?.diagramSpec?.shapes?.length ? (
          <MinedDiagramSvg spec={slide.diagramSpec} theme={theme} className="w-full h-full" />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center text-center"
            style={{ border: `1px dashed ${theme.hairline}`, borderRadius: inch(0.07), color: theme.faint, fontSize: pt(12), fontStyle: 'italic', padding: inch(0.3) }}
          >
            {slide?.body || t('deckPreview.imagePlaceholder')}
          </div>
        )
      default:
        return null
    }
  }

  // freeform background.color is a THEME TOKEN (@background/@primary/…) or a
  // concrete hex — resolve the token exactly like the pptx export does
  // (resolveThemeColor in server/decks.js). Without this the raw "@background"
  // string reached CSS, resolved to nothing, and the slide showed the page
  // behind it — a dark-on-dark bug on any freeform slide using a token bg.
  const freeformBg = isFreeform
    ? resolveThemeColor(theme, slide?.background?.color, null) ||
      (slide?.background?.plate ? theme.primary : theme.background)
    : null

  // the engine's own background spec (plate vs solid) — its plate/motif/cover
  // art are already emitted as elements, so EngineLayer + this background fully
  // paint the slide, replacing every hand-JSX branch below
  const engineBg = engineMat
    ? engineMat.background?.plate
      ? theme.primary
      : resolveThemeColor(theme, engineMat.background?.color, null) || theme.background
    : null

  return (
    <div
      className={`relative aspect-video overflow-hidden rounded-md shadow-sm ${className}`}
      style={{
        background: engineMat ? engineBg : isFreeform ? freeformBg : isDark ? (layout === 'quote' ? theme.deep : theme.primary) : theme.background,
        containerType: 'inline-size',
        fontFamily: theme.bodyFont,
      }}
    >
      {(isFreeform || engineMat) && (slide?.background?.plate || engineMat?.background?.plate) && (() => {
        // same plate composition as addDarkSlide on the pptx side
        const plate = engineMat?.background?.plate || slide?.background?.plate
        const base = plate === 'section' && theme.sectionPlate ? theme.sectionPlate : theme.coverPlate
        if (!base) return null
        const hasOwnOverlay = base === theme.coverPlate && theme.coverOverlay
        return (
          <>
            <img src={base} alt="" className="absolute inset-0 w-full h-full object-cover" />
            {hasOwnOverlay && <img src={theme.coverOverlay} alt="" className="absolute inset-0 w-full h-full object-cover" />}
            <div className="absolute inset-0" style={{ background: theme.primary, opacity: hasOwnOverlay ? 0.45 : 0.74 }} />
          </>
        )
      })()}
      {isFreeform && <ElementsLayer elements={slide?.elements} theme={theme} iconById={iconById} />}
      {engineMat && <EngineLayer mat={engineMat} theme={theme} iconById={iconById} ctx={ctx} />}
      {!engineMat && (layout === 'title' || layout === 'section' || layout === 'closing') &&
        (() => {
          // same composition as addCoverArt in server/decks.js: a mined
          // full-bleed plate (+ veil) keeps the template's own motif on top;
          // otherwise a bundle illustration replaces the motif (closing stays
          // clean when illustrations exist); no illustration → mined motif
          const base = layout === 'section' && theme.sectionPlate ? theme.sectionPlate : theme.coverPlate
          const hasOwnOverlay = base === theme.coverPlate && theme.coverOverlay
          const art = base || layout === 'closing' ? null : pickPreviewIllustration(theme, layout === 'section' ? sectionNo || 0 : 0)
          const artBox =
            layout === 'section'
              ? { right: inch(0.55), bottom: inch(0.5), width: inch(2.0), height: inch(2.0) }
              : { right: inch(0.65), top: inch(0.75), width: inch(2.25), height: inch(2.25) }
          return (
            <>
              {base && (
                <>
                  <img src={base} alt="" className="absolute inset-0 w-full h-full object-cover" />
                  {hasOwnOverlay && (
                    <img src={theme.coverOverlay} alt="" className="absolute inset-0 w-full h-full object-cover" />
                  )}
                  <div className="absolute inset-0" style={{ background: theme.primary, opacity: hasOwnOverlay ? 0.45 : 0.74 }} />
                </>
              )}
              {art ? (
                <img src={art.dataUrl} alt="" className="absolute object-contain" style={artBox} aria-hidden />
              ) : layout === 'closing' && theme.illustrations.length ? null : (
                <MinedMotif theme={theme} />
              )}
            </>
          )
        })()}

      {!engineMat && layout === 'title' && (
        <div className="absolute inset-0" style={{ padding: inch(M) }}>
          {theme.logoDataUrl && (
            <img src={theme.logoDataUrl} alt="" style={{ height: inch(0.4), marginTop: inch(-0.12), objectFit: 'contain' }} />
          )}
          <div style={{ position: 'absolute', left: inch(M), top: inch(1.32), right: inch(3.4) }}>
            {slide?.kicker && <Kicker text={slide.kicker} color={theme.accent} theme={theme} ctx={ctx} slide={slide} />}
          </div>
          <div style={{ position: 'absolute', left: inch(M), top: inch(2.45), right: inch(theme.coverPlate || !theme.illustrations.length ? 2.2 : 3.55) }}>
            <SelBox
              ctx={ctx}
              path="heading"
              label={t('deckPreview.coverTitle')}
              text={heading}
              style={{ fontFamily: theme.headingFont, fontWeight: 700, fontSize: pt(35 * theme.typeScale), color: theme.onPrimary, lineHeight: 1.05, ...ov('heading') }}
            />
            {slide?.subheading && (
              <SelBox
                ctx={ctx}
                path="subheading"
                label={t('deckPreview.coverSubtitle')}
                text={slide.subheading}
                style={{ fontSize: pt(13.5), color: theme.onPrimaryMuted, marginTop: inch(0.12), lineHeight: 1.25, maxWidth: inch(7), ...ov('subheading') }}
              />
            )}
          </div>
          <div className="absolute flex justify-between" style={{ left: inch(M), right: inch(M), bottom: inch(0.22), color: theme.onPrimaryFaint, fontSize: pt(8) }}>
            <span className="truncate">{[d.audience || null, d.author].filter(Boolean).join(' · ')}</span>
            <span>{new Date().getFullYear()}</span>
          </div>
        </div>
      )}

      {!engineMat && layout === 'section' && (
        <div className="absolute inset-0" style={{ padding: inch(M) }}>
          <div style={{ position: 'absolute', left: inch(M), top: inch(1.62), letterSpacing: '0.25em', color: theme.accent, fontWeight: 700, fontSize: pt(15) }}>
            {String(sectionNo || 1).padStart(2, '0')}
          </div>
          <div style={{ position: 'absolute', left: inch(M), top: inch(2.15), right: inch(2.6) }}>
            <SelBox
              ctx={ctx}
              path="heading"
              label={t('deckPreview.sectionTitle')}
              text={heading}
              style={{ fontFamily: theme.headingFont, fontWeight: 700, fontSize: pt(29 * theme.typeScale), color: theme.onPrimary, lineHeight: 1.08, ...ov('heading') }}
            />
            {slide?.subheading && (
              <SelBox
                ctx={ctx}
                path="subheading"
                label={t('deckPreview.sectionSubtitle')}
                text={slide.subheading}
                style={{ fontSize: pt(12.5), color: theme.onPrimaryMuted, marginTop: inch(0.16), lineHeight: 1.25, maxWidth: inch(6.4), ...ov('subheading') }}
              />
            )}
          </div>
        </div>
      )}

      {!engineMat && layout === 'closing' && (
        <div className="absolute inset-0" style={{ padding: inch(M) }}>
          {theme.logoDataUrl && (
            <img src={theme.logoDataUrl} alt="" style={{ height: inch(0.4), marginTop: inch(-0.12), objectFit: 'contain' }} />
          )}
          <div style={{ position: 'absolute', left: inch(M), top: inch(1.98), right: inch(2.2) }}>
            <div style={{ width: inch(0.5), height: inch(0.05), background: theme.accent, marginBottom: inch(0.18) }} />
            <SelBox
              ctx={ctx}
              path="heading"
              label={t('deckPreview.closingTitle')}
              text={heading || t('deckPreview.thanks')}
              style={{ fontFamily: theme.headingFont, fontWeight: 700, fontSize: pt(30 * theme.typeScale), color: theme.onPrimary, lineHeight: 1.08, ...ov('heading') }}
            />
            {(slide?.subheading || slide?.body) && (
              <SelBox
                ctx={ctx}
                path={slide.subheading ? 'subheading' : 'body'}
                label={t('deckPreview.finalMessage')}
                text={slide.subheading || slide.body}
                style={{ fontSize: pt(13), color: theme.onPrimaryMuted, marginTop: inch(0.22), lineHeight: 1.25, maxWidth: inch(6.2), ...ov(slide.subheading ? 'subheading' : 'body') }}
              />
            )}
          </div>
          <div className="absolute flex justify-between" style={{ left: inch(M), right: inch(M), bottom: inch(0.22), color: theme.onPrimaryFaint, fontSize: pt(8) }}>
            <span className="truncate">{[d.audience || null, d.author].filter(Boolean).join(' · ')}</span>
            <span>{new Date().getFullYear()}</span>
          </div>
        </div>
      )}

      {!engineMat && layout === 'quote' && (
        <div className="absolute inset-0" style={{ padding: inch(M) }}>
          <div style={{ position: 'absolute', left: inch(0.54), top: inch(0.3), fontFamily: theme.headingFont, fontWeight: 700, fontSize: pt(76), color: theme.accent, lineHeight: 1 }}>
            “
          </div>
          <div style={{ position: 'absolute', left: inch(M + 0.25), top: inch(1.7), right: inch(2), height: inch(2.1), display: 'flex', alignItems: 'center' }}>
            <SelBox
              ctx={ctx}
              path="body"
              label={t('deckPreview.quote')}
              text={slide?.body || slide?.subheading || ''}
              style={{ fontFamily: theme.headingFont, fontSize: pt(21), color: contrastOn(theme.deep), lineHeight: 1.25, ...ov('body') }}
            />
          </div>
          {slide?.heading && (
            <div style={{ position: 'absolute', left: inch(M + 0.25), top: inch(4.0) }}>
              <Kicker text={slide.heading} color={blend(contrastOn(theme.deep), theme.deep, 0.3)} theme={theme} ctx={ctx} path="heading" slide={slide} />
            </div>
          )}
        </div>
      )}

      {!engineMat && !isDark && !isFreeform && (
        <div className="absolute inset-0 flex flex-col" style={{ padding: `${inch(0.38)} ${inch(M)} ${inch(0.14)}` }}>
          {slide?.kicker && <Kicker text={slide.kicker} color={theme.accent} theme={theme} ctx={ctx} slide={slide} />}
          <SelBox
            ctx={ctx}
            path="heading"
            label={t('deckPreview.heading')}
            text={heading}
            style={{ fontFamily: theme.headingFont, fontWeight: 700, fontSize: pt(21 * theme.typeScale), color: theme.heading, lineHeight: 1.08, marginTop: slide?.kicker ? inch(0.1) : 0, ...ov('heading') }}
          />
          {slide?.subheading && (
            <SelBox ctx={ctx} path="subheading" label={t('deckPreview.subheading')} text={slide.subheading} style={{ fontSize: pt(12.5), color: theme.muted, marginTop: inch(0.04), lineHeight: 1.2, ...ov('subheading') }} />
          )}
          <div style={{ borderBottom: `1px solid ${theme.hairline}`, marginTop: inch(0.14) }} />
          <div className="flex-1 min-h-0" style={{ paddingTop: inch(0.2), paddingBottom: inch(0.08) }}>{body()}</div>
          {slide?.footnote && (
            <SelBox
              ctx={ctx}
              path="footnote"
              label={t('deckPreview.footnote')}
              text={slide.footnote}
              className="truncate"
              style={{ fontSize: pt(8), fontStyle: 'italic', color: theme.faint, paddingBottom: inch(0.04), ...ov('footnote') }}
            />
          )}
          {slide?.callout?.text && (
            <div style={{ paddingBottom: inch(0.1) }}>
              <Callout callout={slide.callout} theme={theme} ctx={ctx} slide={slide} />
            </div>
          )}
          <div className="flex justify-between items-center" style={{ height: inch(0.28), color: theme.faint, fontSize: pt(8) }}>
            <span className="truncate">{meta}</span>
            {pageNumber != null && <span>{pageNumber}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
