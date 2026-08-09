// HTML/CSS deck substrate — alternative to semantic JSON layout.
// A deck is a single-page HTML document with slides as CSS grid items,
// themed with CSS custom properties derived from the design system.
//
// Design tokens resolve to CSS variables at render time, enabling full
// re-theming without regenerating HTML. The document is self-contained:
// all CSS inlined, no external resources except (optionally) a google fonts
// link for the brand fonts.
//
// Usage:
//   const html = generateDeckHtml(slides, theme, ctx)
//   // render in iframe sandbox with CSP

import { resolveDeckTheme, THEME_COLOR_TOKENS, resolveThemeColor, blend } from './deckTheme.js'
import { flattenElements, SLIDE_W, SLIDE_H, chartPalette } from './deckLayout.js'
import { DECK_ICONS } from './deckIcons.js'

// CSS custom properties map (theme token → CSS var name)
function themeToCssVars(theme) {
  const vars = {}
  for (const token of THEME_COLOR_TOKENS) {
    if (theme[token]) {
      // store as --deck-{token}: {value}
      vars[`--deck-${token}`] = theme[token]
    }
  }
  return vars
}

function cssVarString(vars) {
  return Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')
}

// Build the CSS custom properties block from theme
function buildThemeVars(theme) {
  const vars = themeToCssVars(theme)
  return cssVarString(vars)
}

// Minimal base CSS: grid layout for slides, typography, sensible defaults
function buildBaseStyles(headingFont, bodyFont, themeVars) {
  return `
:root {
${themeVars}
  --deck-font-heading: ${headingFont}, serif;
  --deck-font-body: ${bodyFont}, sans-serif;
}

body {
  margin: 0;
  padding: 0;
  font-family: var(--deck-font-body, Helvetica, sans-serif);
  background: var(--deck-background, #FFFFFF);
  color: var(--deck-bodyText, #1A1A1A);
  line-height: 1.5;
}

.deck {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0;
  width: 100%;
}

.slide {
  aspect-ratio: 16 / 9;
  width: 100%;
  height: auto;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  padding: 0;
  margin: 0;
  border: 0;
  page-break-after: always;
  overflow: hidden;
  position: relative;
  container-type: inline-size;
}

.slide h1, .slide h2, .slide h3, .slide h4 {
  margin: 0;
  font-family: var(--deck-font-heading, Georgia, serif);
}

.slide h1 {
  font-size: 2.4rem;
  font-weight: bold;
  color: var(--deck-heading, #1A1A1A);
}

.slide h2 {
  font-size: 1.8rem;
  font-weight: bold;
  color: var(--deck-heading, #1A1A1A);
}

.slide p {
  margin: 0.5rem 0;
  font-size: 1rem;
}

.slide ul, .slide ol {
  margin: 0.5rem 0;
  padding-left: 1.5rem;
}

.slide li {
  margin: 0.3rem 0;
}

/* Flexbox utilities for layout composition */
.flex-row {
  display: flex;
  flex-direction: row;
  gap: 0.5rem;
}

.flex-col {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.flex-center {
  align-items: center;
  justify-content: center;
}

.flex-1 {
  flex: 1 1 auto;
}

/* Color utilities (theme-aware) */
.bg-primary {
  background-color: var(--deck-primary, #1A1A2E);
}

.bg-accent {
  background-color: var(--deck-accent, #E63946);
}

.bg-background {
  background-color: var(--deck-background, #FFFFFF);
}

.text-primary {
  color: var(--deck-primary, #1A1A2E);
}

.text-heading {
  color: var(--deck-heading, #1A1A1A);
}

.text-muted {
  color: var(--deck-muted, #666666);
}

.text-on-primary {
  color: var(--deck-onPrimary, #FFFFFF);
}
`
}

// Wrap slides in a container HTML doc
function wrapDocument(slideHtml, theme) {
  const cssVars = buildThemeVars(theme)
  const fontHeading = theme.headingFont || 'Georgia'
  const fontBody = theme.bodyFont || 'Helvetica'
  const baseStyles = buildBaseStyles(fontHeading, fontBody, cssVars)

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Deck</title>
  <style>
${baseStyles}

@media print {
  body { margin: 0; padding: 0; }
  .slide { margin: 0; padding: 0; page-break-after: always; }
}
  </style>
</head>
<body>
  <div class="deck">
${slideHtml}
  </div>
</body>
</html>`
}

// Generate a minimal slide HTML from a semantic slide definition
// Handles both semantic layouts (heading/bullets/stats) and freeform (element canvas)
export function generateSlideHtml(slide, theme, ctx = {}) {
  if (!slide || !slide.layout) return ''

  // Freeform slides: render positioned elements
  if (slide.layout === 'freeform') {
    return generateFreeformSlide(slide, theme, ctx)
  }

  // Map semantic layouts to HTML generators
  const generators = {
    title: generateTitleSlide,
    section: generateSectionSlide,
    bullets: generateBulletsSlide,
    closing: generateClosingSlide,
    cards: generateCardsSlide,
    'stat-grid': generateStatGridSlide,
    quote: generateQuoteSlide,
    agenda: generateAgendaSlide,
    comparison: generateComparisonSlide,
    timeline: generateTimelineSlide,
    // TODO: other layouts
  }

  const gen = generators[slide.layout]
  if (!gen) {
    // Fallback: generic bullet list
    return generateBulletsSlide(slide, theme, ctx)
  }

  return gen(slide, theme, ctx)
}

// Render a freeform slide (element canvas) — mirrors DeckSlidePreview.jsx's
// approach: absolutely-positioned divs for each element, converted from inches
// to CSS percentages (x/10*100%, y/5.625*100%, etc.). Element styles resolve
// '@token' references via resolveThemeColor. Supports text, shape, line, icon
// (fallbacks), image, and chart (approximation); groups are flattened.
function generateFreeformSlide(slide, theme, ctx = {}) {
  if (!slide.elements?.length) {
    // Empty freeform slide — render with bg only
    const bgColor = slide.background?.color
      ? resolveThemeColor(theme, slide.background.color, theme.background)
      : theme.background
    return `
  <div class="slide" style="background-color: ${bgColor}; position: relative;">
  </div>`
  }

  // Flatten elements (resolves tokens, stacks, groups, expands heatmap/gantt)
  const flat = flattenElements(slide.elements, theme, {
    background: resolveThemeColor(theme, slide.background?.color, theme.background),
  })

  // Render each element (with z-index = index to preserve layer order)
  const elementHtmls = flat.map((el, i) => renderElement(el, theme, i)).filter(Boolean)

  const bgColor = slide.background?.color
    ? resolveThemeColor(theme, slide.background.color, theme.background)
    : theme.background

  return `
  <div class="slide" style="background-color: ${bgColor}; position: relative;">
${elementHtmls.map((html) => '    ' + html).join('\n')}
  </div>`
}

// Render a single element to HTML. Box is in inches; convert to % of the slide.
// Returns a positioned <div> or <svg>, or null for unsupported types.
// zIndex preserves layer order from the element list (later elements on top).
function renderElement(el, theme, zIndex = 0) {
  if (!el || !el.box) return null

  const { x, y, w, h } = el.box
  // Convert inches to percentage (slide is 10in wide × 5.625in tall)
  const left = (x / SLIDE_W) * 100
  const top = (y / SLIDE_H) * 100
  const width = (w / SLIDE_W) * 100
  const height = (h / SLIDE_H) * 100

  // Text elements render on top of images/shapes to ensure legibility when overlapping.
  // Other elements respect document order for stacking (zIndex = order in flat list).
  const zIdx = el.type === 'text' ? 1000 + zIndex : zIndex
  const baseStyle = `
position: absolute;
left: ${left.toFixed(1)}%;
top: ${top.toFixed(1)}%;
width: ${width.toFixed(1)}%;
height: ${height.toFixed(1)}%;
z-index: ${zIdx};
${el.rotate ? `transform: rotate(${el.rotate}deg);` : ''}
`

  switch (el.type) {
    case 'text':
      return renderTextElement(el, baseStyle, theme)
    case 'shape':
      return renderShapeElement(el, baseStyle, theme)
    case 'line':
      return renderLineElement(el, baseStyle, theme)
    case 'icon':
      return renderIconElement(el, baseStyle, theme)
    case 'image':
      return renderImageElement(el, baseStyle, theme)
    case 'chart':
      return renderChartElement(el, baseStyle, theme)
    default:
      return null
  }
}

function renderTextElement(el, baseStyle, theme) {
  const st = el.style || {}
  const color = typeof st.color === 'string' ? st.color : theme.bodyText
  const fontFamily = st.fontFamily || (st.fontRole === 'heading' ? theme.headingFont : theme.bodyFont)
  // Canvas is 10in wide = 72pt → font in pt converts to cqw
  // (pt / 72 * 10 = pt / 7.2, but then as cqw since slide has container-type)
  const fontSize = st.fontSize ? `${st.fontSize / 7.2}cqw` : '1rem'

  const textStyle = `
${baseStyle}
font-family: ${fontFamily};
font-size: ${fontSize};
color: ${color};
font-weight: ${st.bold ? 700 : 400};
font-style: ${st.italic ? 'italic' : 'normal'};
text-decoration: ${st.underline ? 'underline' : 'none'};
text-align: ${st.align || 'left'};
text-transform: ${st.uppercase ? 'uppercase' : 'none'};
line-height: ${st.lineHeight || 1.2};
letter-spacing: ${st.letterSpacing ? `${st.letterSpacing / 7.2}cqw` : '0'};
padding: ${st.padding ? `${st.padding / 7.2}cqw` : '0.25cqw'};
white-space: pre-wrap;
word-wrap: break-word;
overflow: ${st.overflow === 'hidden' ? 'hidden' : 'visible'};
background-color: ${st.fill && st.fill !== 'none' ? st.fill : 'transparent'};
border-radius: ${st.radius ? `${(st.radius / SLIDE_W) * 100}%` : '0'};
border: ${st.borderColor ? `${(st.borderWidth || 1) / 7.2}cqw solid ${st.borderColor}` : 'none'};
opacity: ${st.opacity != null ? st.opacity / 100 : 1};
`

  const text = escapeHtml(el.text || '')
  if (st.bullet) {
    const lines = (el.text || '').split('\n')
    const bullets = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')
    return `<div style="${textStyle}"><ul style="margin: 0; padding-left: 1.2em;">${bullets}</ul></div>`
  }

  return `<div style="${textStyle}">${text}</div>`
}

function renderShapeElement(el, baseStyle, theme) {
  const st = el.style || {}
  const shape = el.shape || 'rect'
  const fill = st.fill === 'none' ? 'transparent' : st.fill || theme.accentSoft
  const borderColor = st.borderColor || 'none'
  const borderWidth = st.borderWidth || 1
  const radius = st.radius || 0

  let shapeStyle = `
${baseStyle}
background-color: ${fill};
border: ${borderColor !== 'none' ? `${borderWidth / 7.2}cqw solid ${borderColor}` : 'none'};
opacity: ${st.opacity != null ? st.opacity / 100 : 1};
`

  // Apply border-radius for roundRect/ellipse
  if (shape === 'ellipse') {
    shapeStyle += 'border-radius: 50%;'
  } else if (shape === 'roundRect') {
    shapeStyle += `border-radius: ${(radius / SLIDE_W) * 100}%;`
  }

  // TODO: Other shapes (triangle, diamond, etc.) would need clip-path or SVG
  // For now, render as generic rect with appropriate styling

  return `<div style="${shapeStyle}"></div>`
}

function renderLineElement(el, baseStyle, theme) {
  const st = el.style || {}
  const color = st.lineColor || theme.accent
  const { h } = el.box

  // Render as SVG for precise line handling
  const svg = `
<svg style="${baseStyle} overflow: visible;" preserveAspectRatio="none" viewBox="0 0 100 100">
  <line x1="${el.flipH ? 100 : 0}" y1="${h === 0 ? 50 : el.flipV ? 100 : 0}" x2="${el.flipH ? 0 : 100}" y2="${h === 0 ? 50 : el.flipV ? 0 : 100}"
    stroke="${color}" stroke-width="2" stroke-dasharray="${st.dash === 'dash' ? '5,5' : st.dash === 'dot' ? '2,3' : 'none'}" vector-effect="non-scaling-stroke" />
</svg>`

  return svg
}

function renderIconElement(el, baseStyle, theme) {
  const st = el.style || {}
  const hasPlate = st.fill && st.fill !== 'none'
  const bgColor = hasPlate ? st.fill : 'transparent'
  const paths = el.icon?.builtin ? DECK_ICONS[el.icon.builtin] : null
  const iconColor = resolveThemeColor(theme, st.color, theme.accent)

  if (!paths) {
    // Fallback: empty box (icon not found)
    const iconStyle = `
${baseStyle}
background-color: ${bgColor};
border-radius: ${st.radius ? `${(st.radius / SLIDE_W) * 100}%` : '22%'};
opacity: ${st.opacity != null ? st.opacity / 100 : 1};
`
    return `<div style="${iconStyle}"></div>`
  }

  // Render SVG icon
  const pathsSvg = paths.map((d) => `<path d="${d}"/>`).join('')
  const svgSize = hasPlate ? '60%' : '100%'
  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="width:${svgSize};height:${svgSize}" fill="none" stroke="${iconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${pathsSvg}</svg>`

  const iconStyle = `
${baseStyle}
background-color: ${bgColor};
border-radius: ${st.radius ? `${(st.radius / SLIDE_W) * 100}%` : hasPlate ? '22%' : 0};
display: flex;
align-items: center;
justify-content: center;
opacity: ${st.opacity != null ? st.opacity / 100 : 1};
overflow: hidden;
`

  return `<div style="${iconStyle}">${svgStr}</div>`
}

function renderImageElement(el, baseStyle, theme) {
  const st = el.style || {}
  // Prefer an inline data URL; otherwise resolve a DS asset referenced by id
  // (e.g. the cover's nodal illustration) the same way the Tree renderer does.
  const data = el.imageDataUrl || (el.imageAssetId ? theme.assetsById?.get(el.imageAssetId)?.dataUrl : null)

  if (data) {
    // Render actual image
    const imageStyle = `
${baseStyle}
border-radius: ${st.radius ? `${(st.radius / SLIDE_W) * 100}%` : '0'};
overflow: hidden;
opacity: ${st.opacity != null ? st.opacity / 100 : 1};
`
    const imgStyle = `width: 100%; height: 100%; object-fit: ${st.objectFit || 'contain'}; display: block;`
    return `<div style="${imageStyle}"><img src="${escapeHtml(data)}" alt="" style="${imgStyle}"/></div>`
  }

  // Placeholder: subtle background, no gritty text
  const imageStyle = `
${baseStyle}
background-color: ${theme.accentSoft};
border-radius: ${st.radius ? `${(st.radius / SLIDE_W) * 100}%` : '0'};
opacity: ${st.opacity != null ? st.opacity / 100 : 1};
`

  return `<div style="${imageStyle}"></div>`
}

function renderChartElement(el, baseStyle, theme) {
  const st = el.style || {}
  const c = el.chart || {}
  const palette = chartPalette(theme)

  // Convert box dimensions to pixels for SVG (1in = 72pt)
  const W = Math.max(el.box.w, 0.5) * 72
  const H = Math.max(el.box.h, 0.5) * 72

  const series = c.series || []
  if (!series.length) {
    // No data: fallback text
    const chartStyle = `
${baseStyle}
background-color: ${theme.cardFill};
border: 1px solid ${theme.hairline};
border-radius: 0.25vw;
display: flex;
align-items: center;
justify-content: center;
color: ${theme.muted};
font-size: 0.9rem;
opacity: ${st.opacity != null ? st.opacity / 100 : 1};
`
    return `<div style="${chartStyle}">[Chart]</div>`
  }

  // Build SVG paths for the chart
  const round = c.kind === 'pie' || c.kind === 'doughnut'
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

  const paths = []
  const texts = []

  // Render chart body
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
      const arcPath = arcPathSvg(cx, cy, r0, r, a, Math.min(a1, a + Math.PI * 1.999))
      paths.push(`<path d="${arcPath}" fill="${palette[i % palette.length]}" stroke="${theme.background}" stroke-width="1" />`)
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
      paths.push(`<line x1="${plot.x}" y1="${gy}" x2="${plot.x + plot.w}" y2="${gy}" stroke="${theme.hairline}" stroke-width="0.5" />`)
    }
    pts.forEach((p, i) => {
      const px = plot.x + ((p.x - x0) / (x1 - x0 || 1)) * plot.w
      const py = plot.y + plot.h - ((p.y - y0) / (y1 - y0 || 1)) * plot.h
      paths.push(`<circle cx="${px}" cy="${py}" r="2.6" fill="${palette[p.si % palette.length]}" />`)
    })
  } else if (c.kind === 'barH') {
    const n = Math.max(cats.length, 1)
    const slot = plot.h / n
    const barH = (slot * 0.66) / Math.max(series.length, 1)
    cats.forEach((cat, ci) => {
      texts.push(`<text x="${plot.x - 4}" y="${plot.y + ci * slot + slot / 2 + 2.6}" font-size="7.5" fill="${theme.muted}" text-anchor="end" font-family="${theme.bodyFont}">${escapeHtml(String(cat))}</text>`)
      series.forEach((s, si) => {
        const v = s.data?.[ci]?.value || 0
        const bw = (Math.max(v - Math.min(vMin, 0), 0) / span) * plot.w
        paths.push(`<rect x="${plot.x}" y="${plot.y + ci * slot + (slot - barH * series.length) / 2 + si * barH}" width="${bw}" height="${barH * 0.92}" fill="${palette[si % palette.length]}" rx="1" />`)
      })
    })
  } else {
    // bar / line / area share the category grid
    for (let g = 1; g <= 3; g++) {
      const gy = plot.y + (plot.h * g) / 4
      paths.push(`<line x1="${plot.x}" y1="${gy}" x2="${plot.x + plot.w}" y2="${gy}" stroke="${theme.hairline}" stroke-width="0.5" />`)
    }
    paths.push(`<line x1="${plot.x}" y1="${plot.y + plot.h}" x2="${plot.x + plot.w}" y2="${plot.y + plot.h}" stroke="${theme.hairline}" stroke-width="0.75" />`)
    const n = Math.max(cats.length, 1)
    const slot = plot.w / n
    const Y = (v) => plot.y + plot.h - ((v - Math.min(vMin, 0)) / span) * plot.h
    if (c.kind === 'bar') {
      const barW = (slot * 0.62) / Math.max(series.length, 1)
      series.forEach((s, si) => {
        ;(s.data || []).forEach((d, ci) => {
          const x = plot.x + ci * slot + (slot - barW * series.length) / 2 + si * barW
          paths.push(`<rect x="${x}" y="${Y(Math.max(d.value, 0))}" width="${barW * 0.92}" height="${Math.abs(Y(0) - Y(d.value))}" fill="${palette[si % palette.length]}" rx="1" />`)
        })
      })
    } else {
      series.forEach((s, si) => {
        const pts = (s.data || []).map((d, ci) => `${plot.x + ci * slot + slot / 2},${Y(d.value)}`)
        if (c.kind === 'area') {
          paths.push(`<polygon points="${plot.x + slot / 2},${Y(0)} ${pts.join(' ')} ${plot.x + (n - 1) * slot + slot / 2},${Y(0)}" fill="${palette[si % palette.length]}" opacity="0.25" />`)
        }
        paths.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${palette[si % palette.length]}" stroke-width="1.75" stroke-linejoin="round" />`)
      })
    }
    cats.forEach((cat, ci) => {
      texts.push(`<text x="${plot.x + ci * slot + slot / 2}" y="${plot.y + plot.h + 8.5}" font-size="7.5" fill="${theme.muted}" text-anchor="middle" font-family="${theme.bodyFont}">${escapeHtml(String(cat))}</text>`)
    })
  }

  // Legend
  if (showLegend) {
    const itemW = Math.min(legendItems.length ? (W - 8) / legendItems.length : W, 90)
    const startX = (W - itemW * legendItems.length) / 2
    legendItems.forEach(([name, color], i) => {
      paths.push(`<rect x="${startX + i * itemW}" y="${H - 9.5}" width="6" height="6" rx="1" fill="${color}" />`)
      texts.push(`<text x="${startX + i * itemW + 9}" y="${H - 4}" font-size="7" fill="${theme.muted}" font-family="${theme.bodyFont}">${escapeHtml(String(name).slice(0, 18))}</text>`)
    })
  }

  const svgContent = [...paths, ...texts].join('\n')
  const chartSvg = `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${svgContent}</svg>`

  const chartStyle = `
${baseStyle}
background-color: ${theme.cardFill};
border: 1px solid ${theme.hairline};
border-radius: 0.25vw;
opacity: ${st.opacity != null ? st.opacity / 100 : 1};
`

  return `<div style="${chartStyle}">${chartSvg}</div>`
}

// SVG arc path (used for pie/doughnut charts)
function arcPathSvg(cx, cy, r0, r1, a0, a1) {
  const p = (r, a) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`
}

// Title/cover slide
function generateTitleSlide(slide, theme, ctx) {
  const bgColor = theme.primary
  const onColor = theme.onPrimary

  return `
  <div class="slide bg-primary flex-col flex-center" style="background-color: ${bgColor}; color: ${onColor};">
    <div class="flex-1 flex-col flex-center" style="width: 100%; justify-content: flex-end; padding: 0 2rem 3rem;">
      ${slide.heading ? `<h1 style="color: ${onColor}; margin-bottom: 1rem;">${escapeHtml(slide.heading)}</h1>` : ''}
      ${slide.subheading ? `<p style="color: ${theme.onPrimaryMuted}; font-size: 1.2rem;">${escapeHtml(slide.subheading)}</p>` : ''}
    </div>
    ${ctx.deckTitle ? `<footer style="width: 100%; padding: 1rem 2rem; font-size: 0.8rem; color: ${theme.onPrimaryFaint}; display: flex; justify-content: space-between;">
      <span>${escapeHtml(ctx.audience || '')}</span>
      <span>${new Date().getFullYear()}</span>
    </footer>` : ''}
  </div>`
}

// Section divider slide
function generateSectionSlide(slide, theme, ctx) {
  const bgColor = theme.primary
  const onColor = theme.onPrimary
  const sectionNo = ctx.sectionNo || 1

  return `
  <div class="slide bg-primary flex-col" style="background-color: ${bgColor}; color: ${onColor}; padding: 2rem; justify-content: center; align-items: flex-start;">
    <div style="font-size: 1.5rem; font-weight: bold; letter-spacing: 0.2em; color: ${theme.accentOnPrimary}; margin-bottom: 1rem;">${String(sectionNo).padStart(2, '0')}</div>
    <h2 style="color: ${onColor}; margin: 0;">${escapeHtml(slide.heading || '')}</h2>
    ${slide.subheading ? `<p style="color: ${theme.onPrimaryMuted}; margin-top: 1rem; max-width: 70%;">${escapeHtml(slide.subheading)}</p>` : ''}
  </div>`
}

// Bullets slide
function generateBulletsSlide(slide, theme, ctx) {
  const bullets = (slide.bullets || []).map(b => `<li>${escapeHtml(b)}</li>`).join('\n')

  return `
  <div class="slide" style="background-color: ${theme.background}; color: ${theme.heading}; padding: 2rem; display: flex; flex-direction: column;">
    <header style="margin-bottom: 1.5rem;">
      ${slide.heading ? `<h1 style="color: ${theme.heading}; margin: 0 0 0.5rem;">${escapeHtml(slide.heading)}</h1>` : ''}
      ${slide.subheading ? `<p style="color: ${theme.muted}; margin: 0; font-size: 1rem;">${escapeHtml(slide.subheading)}</p>` : ''}
    </header>
    <main style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
      ${slide.body ? `<p style="color: ${theme.muted}; margin-bottom: 1rem;">${escapeHtml(slide.body)}</p>` : ''}
      ${bullets ? `<ul style="margin: 0; padding-left: 1.5rem; color: ${theme.bodyText};">${bullets}</ul>` : ''}
    </main>
    ${ctx.meta || ctx.pageNumber ? `<footer style="margin-top: 1rem; font-size: 0.8rem; color: ${theme.faint}; display: flex; justify-content: space-between;">
      <span>${escapeHtml(ctx.meta || '')}</span>
      <span>${ctx.pageNumber || ''}</span>
    </footer>` : ''}
  </div>`
}

// Closing slide
function generateClosingSlide(slide, theme, ctx) {
  const bgColor = theme.primary
  const onColor = theme.onPrimary

  return `
  <div class="slide bg-primary flex-col flex-center" style="background-color: ${bgColor}; color: ${onColor}; padding: 2rem;">
    <h1 style="color: ${onColor}; margin-bottom: 2rem;">${escapeHtml(slide.heading || 'Obrigado')}</h1>
    ${slide.subheading || slide.body ? `<p style="color: ${theme.onPrimaryMuted}; max-width: 80%; text-align: center;">${escapeHtml(slide.subheading || slide.body || '')}</p>` : ''}
  </div>`
}

// Cards slide
function generateCardsSlide(slide, theme, ctx) {
  const cards = (slide.cards || []).slice(0, 6).map(card => `
    <div style="background-color: ${theme.cardFill}; border: 1px solid ${theme.hairline}; border-radius: 0.5rem; padding: 1.5rem; flex: 1;">
      ${card.heading ? `<h3 style="color: ${theme.heading}; margin: 0 0 0.5rem;">${escapeHtml(card.heading)}</h3>` : ''}
      ${card.body ? `<p style="color: ${theme.muted}; margin: 0; font-size: 0.9rem;">${escapeHtml(card.body)}</p>` : ''}
    </div>`).join('\n')

  return `
  <div class="slide" style="background-color: ${theme.background}; padding: 2rem; display: flex; flex-direction: column;">
    <header style="margin-bottom: 1.5rem;">
      ${slide.heading ? `<h2 style="color: ${theme.heading}; margin: 0;">${escapeHtml(slide.heading)}</h2>` : ''}
    </header>
    <main style="flex: 1; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.5rem;">
      ${cards}
    </main>
  </div>`
}

// Stat grid slide
function generateStatGridSlide(slide, theme, ctx) {
  const stats = (slide.stats || []).slice(0, 4).map(stat => `
    <div style="background-color: ${theme.cardFill}; border: 1px solid ${theme.hairline}; border-radius: 0.5rem; padding: 1.5rem; text-align: center;">
      <div style="font-size: 2rem; font-weight: bold; color: ${theme.heading}; margin-bottom: 0.5rem;">${escapeHtml(stat.value || '')}</div>
      ${stat.label ? `<div style="color: ${theme.muted}; font-size: 0.9rem;">${escapeHtml(stat.label)}</div>` : ''}
    </div>`).join('\n')

  return `
  <div class="slide" style="background-color: ${theme.background}; padding: 2rem; display: flex; flex-direction: column;">
    <header style="margin-bottom: 2rem;">
      ${slide.heading ? `<h2 style="color: ${theme.heading}; margin: 0;">${escapeHtml(slide.heading)}</h2>` : ''}
    </header>
    <main style="flex: 1; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 2rem; align-items: center;">
      ${stats}
    </main>
  </div>`
}

// Quote slide
function generateQuoteSlide(slide, theme, ctx) {
  const bgColor = theme.deep
  const onColor = theme.onPrimary

  return `
  <div class="slide" style="background-color: ${bgColor}; color: ${onColor}; padding: 3rem; display: flex; flex-direction: column; justify-content: center;">
    ${slide.body ? `<blockquote style="font-size: 1.8rem; font-style: italic; margin: 0; line-height: 1.5; margin-bottom: 2rem;">"${escapeHtml(slide.body)}"</blockquote>` : ''}
    ${slide.heading ? `<div style="font-size: 1rem; font-weight: bold; color: ${theme.onPrimaryMuted}; text-align: right;">— ${escapeHtml(slide.heading)}</div>` : ''}
  </div>`
}

// Agenda slide
function generateAgendaSlide(slide, theme, ctx) {
  const items = (slide.items || []).map((item, i) => `
    <li style="margin-bottom: 1rem;">
      <strong style="color: ${theme.heading};">${String(i + 1).padStart(2, '0')}. ${escapeHtml(item.title || '')}</strong>
      ${item.body ? `<p style="color: ${theme.muted}; margin: 0.5rem 0 0; font-size: 0.9rem;">${escapeHtml(item.body)}</p>` : ''}
    </li>`).join('\n')

  return `
  <div class="slide" style="background-color: ${theme.background}; padding: 2rem; display: flex; flex-direction: column;">
    <header style="margin-bottom: 1.5rem;">
      ${slide.heading ? `<h2 style="color: ${theme.heading}; margin: 0;">${escapeHtml(slide.heading)}</h2>` : ''}
    </header>
    <main style="flex: 1;">
      <ol style="margin: 0; padding-left: 0; list-style: none; color: ${theme.bodyText};">
        ${items}
      </ol>
    </main>
  </div>`
}

// Comparison slide
function generateComparisonSlide(slide, theme, ctx) {
  const leftBullets = (slide.leftBullets || []).map(b => `<li>${escapeHtml(b)}</li>`).join('\n')
  const rightBullets = (slide.rightBullets || []).map(b => `<li>${escapeHtml(b)}</li>`).join('\n')

  return `
  <div class="slide" style="background-color: ${theme.background}; padding: 2rem; display: flex; flex-direction: column;">
    <header style="margin-bottom: 1.5rem;">
      ${slide.heading ? `<h2 style="color: ${theme.heading}; margin: 0;">${escapeHtml(slide.heading)}</h2>` : ''}
    </header>
    <main style="flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 2rem;">
      <div style="background-color: ${theme.cardFill}; border: 1px solid ${theme.hairline}; border-radius: 0.5rem; padding: 1.5rem;">
        ${slide.leftTitle ? `<h3 style="color: ${theme.muted}; margin: 0 0 1rem;">${escapeHtml(slide.leftTitle)}</h3>` : ''}
        <ul style="margin: 0; padding-left: 1.5rem; color: ${theme.bodyText}; font-size: 0.9rem;">${leftBullets}</ul>
      </div>
      <div style="background-color: ${theme.accentSoft}; border: 2px solid ${theme.accent}; border-radius: 0.5rem; padding: 1.5rem;">
        ${slide.rightTitle ? `<h3 style="color: ${theme.heading}; margin: 0 0 1rem;">${escapeHtml(slide.rightTitle)}</h3>` : ''}
        <ul style="margin: 0; padding-left: 1.5rem; color: ${theme.bodyText}; font-size: 0.9rem;">${rightBullets}</ul>
      </div>
    </main>
  </div>`
}

// Timeline slide
function generateTimelineSlide(slide, theme, ctx) {
  const phases = (slide.phases || []).map((phase, i) => `
    <div style="flex: 1; text-align: center;">
      <div style="font-size: 1.2rem; font-weight: bold; color: ${theme.accent}; margin-bottom: 0.5rem;">${escapeHtml(phase.label || '')}</div>
      ${phase.period ? `<div style="color: ${theme.muted}; font-size: 0.8rem; margin-bottom: 0.5rem;">${escapeHtml(phase.period)}</div>` : ''}
      ${phase.body ? `<p style="color: ${theme.bodyText}; font-size: 0.85rem; margin: 0;">${escapeHtml(phase.body)}</p>` : ''}
    </div>`).join('\n')

  return `
  <div class="slide" style="background-color: ${theme.background}; padding: 2rem; display: flex; flex-direction: column;">
    <header style="margin-bottom: 2rem;">
      ${slide.heading ? `<h2 style="color: ${theme.heading}; margin: 0;">${escapeHtml(slide.heading)}</h2>` : ''}
    </header>
    <main style="flex: 1; display: flex; align-items: center; gap: 1.5rem; justify-content: space-between;">
      ${phases}
    </main>
  </div>`
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// Main export: generate complete deck HTML from slides + theme
export function generateDeckHtml(slides, template, ctx = {}) {
  const theme = template ? resolveDeckTheme(template) : {}
  // DS asset lookup by id (mirrors DeckSlidePreview's iconById) so an image
  // element referencing a design-system illustration/icon by `imageAssetId`
  // resolves to its real data URL instead of the empty placeholder.
  theme.assetsById = new Map((template?.iconAssets || []).map((a) => [a.id, a]))

  let sectionNo = 0
  const slideHtmls = (slides || []).map((slide, i) => {
    if (slide.layout === 'section') sectionNo++
    return generateSlideHtml(slide, theme, {
      ...ctx,
      index: i,
      sectionNo,
    })
  })

  const slideHtml = slideHtmls.join('\n')
  return wrapDocument(slideHtml, theme)
}
