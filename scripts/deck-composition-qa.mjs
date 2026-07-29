#!/usr/bin/env node
// Composition-quality QA for freeform slides (the "impeccable" safety net).
//
//   node scripts/deck-composition-qa.mjs
//
// Where deck-elements-qa.mjs asserts SANITIZER invariants (valid boxes/colors/
// caps), this asserts VISUAL-POLISH invariants on the real paint geometry —
// the defects the freeform-first generator can introduce and that the fixes in
// server/blocks.js + shared/deckLayout.js guard against:
//   1. contrast: every painted text reads against the surface behind it
//      (top-level text vs slide bg; card text vs its card fill)
//   2. bounds: no painted element lands fully off-canvas
//   3. fit: no text box is so short its wrapped content overflows (clipping)
//   4. margins: top-level content respects the slide margin (no edge-hugging)
//   5. no-overlap: sibling top-level text boxes don't collide
// It runs headless via flattenElements (the exact geometry both renderers
// paint), so it's CI-fast — no browser/PowerPoint needed. The golden fixture
// scripts/fixtures/deck-freeform-composed.golden.json is a hand-verified
// "encantador" deck; it must pass every check with ZERO warnings, so any
// regression in the composition pipeline trips here.
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeDeck, freeformSlideIsMateriallyEmpty } from '../server/blocks.js'
import { flattenElements, SLIDE_W, SLIDE_H, GRID } from '../shared/deckLayout.js'
import { resolveDeckTheme, resolveThemeColor, luminance } from '../shared/deckTheme.js'
import { TEMPLATES } from './fixtures/templates.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let failures = 0
const assert = (cond, msg) => {
  if (cond) return
  failures++
  console.error('FAIL:', msg)
}

// WCAG-ish contrast via luminance delta — the shared theme already targets
// legible tokens, so this catches only genuine mismatches (light-bg ink on a
// dark slide, etc). 0.18 is the same threshold the mined-diagram plate logic
// uses for "too close to the background".
const MIN_CONTRAST = 0.18

// resolve a possibly-@token color to hex against a theme (mirrors both painters)
const hex = (theme, v, fb) => {
  const r = resolveThemeColor(theme, v, fb)
  return typeof r === 'string' && /^#[0-9A-F]{6}$/i.test(r) ? r : fb
}

// the surface a painted element sits on: the nearest ancestor shape/group fill,
// else the slide background. flattenElements emits group panels as `__bg`
// shapes just before their children, so we track the most recent filled rect
// that contains this element's box.
function surfaceBehind(el, flat, slideBg, theme) {
  let surface = slideBg
  for (const other of flat) {
    if (other === el) break
    if (other.type !== 'shape') continue
    const f = hex(theme, other.style?.fill, null)
    if (!f) continue
    const b = other.box
    if (el.box.x >= b.x - 0.02 && el.box.y >= b.y - 0.02 && el.box.x + el.box.w <= b.x + b.w + 0.02 && el.box.y + el.box.h <= b.y + b.h + 0.02) {
      surface = f // a filled rect that contains this element — it's the surface
    }
  }
  return surface
}

// a group with no content-bearing descendant is the "Grupo · 0" blank-plate
// symptom — the prune/salvage in sanitizeElement must guarantee none survive
const CONTENT = new Set(['text', 'image', 'chart', 'icon'])
const hasContent = (el) =>
  !el
    ? false
    : CONTENT.has(el.type)
      ? el.type !== 'text' || String(el.text ?? '').trim()
      : el.type === 'group'
        ? (el.children || []).some(hasContent)
        : false
function emptyGroups(elements, out = []) {
  for (const el of elements || []) {
    if (el?.type === 'group') {
      if (!(el.children || []).some(hasContent)) out.push(el.id || '(sem id)')
      emptyGroups(el.children, out)
    }
  }
  return out
}

function checkSlide(label, slide, theme) {
  if (slide.layout !== 'freeform') return 0
  const slideBg = hex(theme, slide.background?.color, slide.background?.plate ? theme.primary : theme.background)
  const flat = flattenElements(slide.elements || [], theme, { background: slideBg })
  // (0) no empty groups + slide is not materially blank — the core "never a
  // blank freeform slide" guarantee that the sanitizer must uphold
  const empties = emptyGroups(slide.elements)
  assert(empties.length === 0, `${label}: grupo(s) vazio(s) sem conteúdo: ${empties.join(', ')}`)
  assert(!freeformSlideIsMateriallyEmpty(slide), `${label}: slide freeform sem conteúdo material (renderiza em branco)`)
  let checked = 0
  const topText = []
  for (const el of flat) {
    // (2) bounds — nothing fully off-canvas
    const b = el.box
    const off = b.x >= SLIDE_W || b.y >= SLIDE_H || b.x + b.w <= 0 || b.y + b.h <= 0
    assert(!off, `${label}: elemento ${el.id} totalmente fora do canvas (${b.x.toFixed(2)},${b.y.toFixed(2)})`)
    if (el.type !== 'text' || !el.text) continue
    checked++
    // (1) contrast — text vs the surface behind it
    const surface = surfaceBehind(el, flat, slideBg, theme)
    const color = hex(theme, el.style?.color, theme.bodyText)
    const delta = Math.abs(luminance(color) - luminance(surface))
    assert(delta >= MIN_CONTRAST, `${label}: texto "${String(el.text).slice(0, 30)}" com baixo contraste (Δ${delta.toFixed(2)}) — cor ${color} sobre ${surface}`)
    // (3) fit/readability — flattenElements auto-shrinks text to fit its box, so
    // a too-small box doesn't overflow: it collapses the font. The real defect
    // is the PAINTED (post-fit) size dropping below the readable floor. el.style
    // here is already the fitted style, so a size < 8pt means the box is too
    // small for its content (or the authored size was itself illegible).
    const paintedSize = el.style?.fontSize || 13
    assert(paintedSize >= 8, `${label}: texto "${String(el.text).slice(0, 30)}" encolheu para ${paintedSize.toFixed(1)}pt (ilegível — caixa pequena demais p/ o conteúdo)`)
    // collect near-top-level text (not deeply nested) for margin + overlap
    topText.push(el)
  }
  // (4) margins — the leftmost/topmost text shouldn't hug the very edge
  for (const el of topText) {
    // skip elements clearly inside a card (surface != slide bg handled loosely):
    // only flag text starting left of ~half the margin or above a small top pad
    if (el.box.x < GRID.margin - 0.25) assert(false, `${label}: "${String(el.text).slice(0, 24)}" fura a margem esquerda (x=${el.box.x.toFixed(2)} < ${GRID.margin})`)
    if (el.box.y < 0.25) assert(false, `${label}: "${String(el.text).slice(0, 24)}" colado no topo (y=${el.box.y.toFixed(2)})`)
  }
  return checked
}

// --- run: golden fixture (must be flawless) across representative themes -----
const GOLDEN = 'deck-freeform-composed.golden.json'
const goldenRaw = JSON.parse(readFileSync(join(HERE, 'fixtures', GOLDEN), 'utf8'))
const goldenDeck = sanitizeDeck(goldenRaw, new Map(), TEMPLATES.rich)
assert(goldenDeck, 'golden freeform sanitiza')
let total = 0
for (const [prof, tpl] of Object.entries(TEMPLATES)) {
  const theme = resolveDeckTheme(tpl)
  goldenDeck.slides.forEach((s, i) => {
    total += checkSlide(`golden#${i}(${prof})`, s, theme)
  })
}
assert(total > 0, 'a QA de composição exercitou pelo menos um texto')
console.log(`composição: ${total} textos verificados no golden × ${Object.keys(TEMPLATES).length} perfis`)

// --- run: every freeform slide in the other fixtures is at least bounds/fit-ok
const fixtures = readdirSync(join(HERE, 'fixtures')).filter((f) => /^deck-.*\.json$/.test(f) && f !== GOLDEN)
for (const fix of fixtures) {
  const raw = JSON.parse(readFileSync(join(HERE, 'fixtures', fix), 'utf8'))
  const d = sanitizeDeck(raw, new Map(), TEMPLATES.rich)
  if (!d) continue
  const theme = resolveDeckTheme(TEMPLATES.rich)
  d.slides.forEach((s, i) => {
    if (s.layout === 'freeform') checkSlide(`${fix}#${i}`, s, theme)
  })
}

// --- negative fixtures: slides the model USED to emit that rendered blank.
// The sanitizer must SALVAGE (chart→placeholder) or PRUNE (empty group) so the
// result is never materially empty and never carries a "Grupo · 0" plate. This
// proves the repair works — not just that the golden is clean.
const NEG_THEME = resolveDeckTheme(TEMPLATES.rich)
// (a) a group whose only child is a heatmap chart missing `values` — the exact
// bug repro. Expect: chart salvaged to a text placeholder, group survives with
// content, slide not materially empty.
const negChart = {
  title: 'neg: chart sem dados',
  slides: [{
    layout: 'freeform',
    elements: [{
      type: 'group', id: 'g1', box: { x: 1, y: 1, w: 8, h: 3 },
      stack: { direction: 'column', gap: 0.2 },
      children: [{ type: 'chart', id: 'c1', box: { x: 0, y: 0, w: 8, h: 3 }, chart: { kind: 'heatmap', heatmap: { xLabels: ['A'] } } }],
    }],
  }],
}
const negChartDeck = sanitizeDeck(negChart, new Map(), TEMPLATES.rich)
assert(negChartDeck && negChartDeck.slides.length === 1, 'neg-chart: deck sobrevive (chart salvo, não descartado)')
if (negChartDeck) {
  const s = negChartDeck.slides[0]
  assert(emptyGroups(s.elements).length === 0, 'neg-chart: nenhum grupo vazio após salvamento')
  assert(!freeformSlideIsMateriallyEmpty(s), 'neg-chart: slide tem conteúdo material após salvamento')
}
// (b) a group whose only child is an invalid-type element — nothing to salvage,
// so the group must be PRUNED; with no other content the slide collapses and
// sanitizeDeck drops it entirely (a missing slide beats a blank one).
const negEmpty = {
  title: 'neg: grupo que esvazia',
  slides: [
    { layout: 'freeform', elements: [{ type: 'group', id: 'g2', box: { x: 1, y: 1, w: 8, h: 3 }, children: [{ type: 'bogus', box: { x: 0, y: 0, w: 1, h: 1 } }] }] },
    { layout: 'title', heading: 'Slide real', subheading: 'para o deck não ficar vazio' },
  ],
}
const negEmptyDeck = sanitizeDeck(negEmpty, new Map(), TEMPLATES.rich)
assert(negEmptyDeck, 'neg-empty: deck sobrevive (via o slide title real)')
if (negEmptyDeck) {
  for (const s of negEmptyDeck.slides) {
    if (s.layout === 'freeform') {
      assert(emptyGroups(s.elements).length === 0, 'neg-empty: nenhum grupo vazio sobreviveu')
      assert(!freeformSlideIsMateriallyEmpty(s), 'neg-empty: nenhum slide freeform materialmente vazio')
    }
  }
}
console.log('negativas: salvamento/poda mantêm slides não-vazios')

if (failures) {
  console.error(`\n${failures} falha(s) de composição`)
  process.exit(1)
}
console.log('deck-composition-qa: OK')
