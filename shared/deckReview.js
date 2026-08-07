// Deterministic visual review of a freeform deck — the "render → look → fix"
// loop, minus the render. A literal screenshot+vision pass isn't deployable in
// the app runtime (the only rasterizer we have, scripts/pptx-to-png.sh, drives
// macOS PowerPoint via AppleScript; the Linux Databricks App has no headless
// renderer and we take on no browser dependency). But the defects the benchmark
// caught in a generated deck — a title clipped/shrunk to illegibility, an
// element off-canvas, text with no contrast against its surface, colliding
// boxes — are all computable from the SAME paint geometry both renderers use
// (flattenElements). So we inspect that geometry directly and hand the model a
// precise, per-slide defect list to repair, then re-inspect. Same defect class
// the vision loop would catch, but exact, instant, and runnable anywhere.
//
// This is the single source of truth: scripts/deck-composition-qa.mjs asserts
// against these same findings so CI and the runtime loop never drift.
import { flattenElements, SLIDE_W, SLIDE_H, GRID } from './deckLayout.js'
import { resolveThemeColor, luminance } from './deckTheme.js'

// WCAG-ish contrast floor via luminance delta — matches the mined-plate logic
// and the composition-QA threshold. Below this, text reads as "on top of a
// same-tone surface" (e.g. light ink on a light slide).
export const MIN_CONTRAST = 0.18
// Painted font floor. flattenElements auto-shrinks text to fit its box, so a
// box too small for its content collapses the font instead of overflowing;
// a painted size under this means the content was clipped to illegibility.
export const MIN_LEGIBLE_PT = 8

const hex = (theme, v, fb) => {
  const r = resolveThemeColor(theme, v, fb)
  return typeof r === 'string' && /^#[0-9A-F]{6}$/i.test(r) ? r : fb
}

// The surface a painted element sits on: the nearest ancestor filled rect that
// contains it, else the slide background. flattenElements emits group panels as
// `__bg` shapes just before their children, so the most recent containing
// filled rect is the surface. (Mirrors surfaceBehind in deck-composition-qa.)
function surfaceBehind(el, flat, slideBg, theme) {
  let surface = slideBg
  for (const other of flat) {
    if (other === el) break
    if (other.type !== 'shape') continue
    const f = hex(theme, other.style?.fill, null)
    if (!f) continue
    const b = other.box
    if (
      el.box.x >= b.x - 0.02 &&
      el.box.y >= b.y - 0.02 &&
      el.box.x + el.box.w <= b.x + b.w + 0.02 &&
      el.box.y + el.box.h <= b.y + b.h + 0.02
    ) {
      surface = f
    }
  }
  return surface
}

// axis-aligned box overlap area (in²), 0 if disjoint
function overlapArea(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return ix * iy
}

/**
 * Inspects one freeform slide's real paint geometry and returns a list of
 * human-readable defect strings (empty = clean). Non-freeform slides are
 * templated and pre-validated, so they return []. `theme` is a resolved deck
 * theme (resolveDeckTheme output).
 */
export function reviewSlide(slide, theme) {
  if (!slide || slide.layout !== 'freeform') return []
  const findings = []
  const slideBg = hex(theme, slide.background?.color, slide.background?.plate ? theme.primary : theme.background)
  const flat = flattenElements(slide.elements || [], theme, { background: slideBg })

  const texts = []
  for (const el of flat) {
    const b = el.box
    // (1) bounds — fully off-canvas
    if (b.x >= SLIDE_W || b.y >= SLIDE_H || b.x + b.w <= 0 || b.y + b.h <= 0) {
      findings.push(`elemento "${labelOf(el)}" está fora do slide (posição ${b.x.toFixed(2)},${b.y.toFixed(2)}).`)
    }
    // (1b) bleeds past an edge (partially off-canvas — clipping at the border)
    else if (b.x < -0.05 || b.y < -0.05 || b.x + b.w > SLIDE_W + 0.05 || b.y + b.h > SLIDE_H + 0.05) {
      findings.push(`elemento "${labelOf(el)}" ultrapassa a borda do slide (vai até ${(b.x + b.w).toFixed(2)},${(b.y + b.h).toFixed(2)}; o slide é ${SLIDE_W}×${SLIDE_H}).`)
    }
    if (el.type !== 'text' || !String(el.text ?? '').trim()) continue
    texts.push(el)
    // (2) legibility / clipping — painted size collapsed below the floor
    const paintedSize = el.style?.fontSize || 13
    if (paintedSize < MIN_LEGIBLE_PT) {
      findings.push(`o texto "${snippet(el.text)}" encolheu para ${paintedSize.toFixed(1)}pt (ilegível — a caixa é pequena demais para o conteúdo; aumente a caixa ou reduza o texto).`)
    }
    // (3) contrast — text vs the surface behind it
    const surface = surfaceBehind(el, flat, slideBg, theme)
    const color = hex(theme, el.style?.color, theme.bodyText)
    const delta = Math.abs(luminance(color) - luminance(surface))
    if (delta < MIN_CONTRAST) {
      findings.push(`o texto "${snippet(el.text)}" tem baixo contraste (cor ${color} sobre fundo ${surface}); troque a cor do texto ou do fundo.`)
    }
    // (4) margin — top-level text hugging the very edge
    if (b.x < GRID.margin - 0.25) {
      findings.push(`o texto "${snippet(el.text)}" fura a margem esquerda (x=${b.x.toFixed(2)}, margem ${GRID.margin}).`)
    }
    if (b.y < 0.25) {
      findings.push(`o texto "${snippet(el.text)}" está colado no topo (y=${b.y.toFixed(2)}).`)
    }
  }

  // (5) overlap — two top-level text boxes colliding on a meaningful area.
  // Only flag substantial overlaps (>15% of the smaller box) so touching
  // baselines don't trip it.
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i].box
      const c = texts[j].box
      const inter = overlapArea(a, c)
      if (inter <= 0) continue
      const smaller = Math.min(a.w * a.h, c.w * c.h)
      if (smaller > 0 && inter / smaller > 0.15) {
        findings.push(`os textos "${snippet(texts[i].text)}" e "${snippet(texts[j].text)}" se sobrepõem; separe-os.`)
      }
    }
  }
  return findings
}

/**
 * Reviews every slide of a deck. Returns { clean, slides } where slides is an
 * array of { index, title, findings } for slides that have at least one defect.
 */
export function reviewDeck(deck, theme) {
  const slides = []
  ;(deck?.slides || []).forEach((s, index) => {
    const findings = reviewSlide(s, theme)
    if (findings.length) slides.push({ index, title: s.title || s.heading || `slide ${index + 1}`, findings })
  })
  return { clean: slides.length === 0, slides }
}

/** Formats a deck review into a compact instruction the model can act on. */
export function formatReviewForModel(review) {
  if (review.clean) return ''
  const lines = review.slides.map((s) => {
    const bullets = s.findings.map((f) => `  - ${f}`).join('\n')
    return `Slide ${s.index + 1} ("${s.title}"):\n${bullets}`
  })
  return lines.join('\n')
}

function labelOf(el) {
  if (el.type === 'text') return snippet(el.text)
  return el.id || el.type || 'elemento'
}
function snippet(t) {
  return String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
}
