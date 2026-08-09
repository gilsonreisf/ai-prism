#!/usr/bin/env node
// QA for the deck visual self-review detector (shared/deckReview.js), the
// engine behind the runtime render→inspect→repair loop in server/index.js.
//
//   node scripts/deck-review-qa.mjs
//
// Two directions prove the detector is trustworthy on the hot path:
//   1. the hand-verified golden freeform deck reports CLEAN across every theme
//      profile (no false positives that would trigger needless repair rounds);
//   2. decks with each defect class the benchmark caught — a title clipped to
//      illegibility, an element off-canvas, text with no contrast — are FLAGGED
//      with a finding that names the offending slide (no false negatives).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeDeck } from '../server/blocks.js'
import { reviewDeck } from '../shared/deckReview.js'
import { resolveDeckTheme } from '../shared/deckTheme.js'
import { TEMPLATES } from './fixtures/templates.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let failures = 0
const assert = (cond, msg) => {
  if (cond) return
  failures++
  console.error('FAIL:', msg)
}

// 1) golden must be flawless across every theme (no false positives)
const goldenRaw = JSON.parse(readFileSync(join(HERE, 'fixtures', 'deck-freeform-composed.golden.json'), 'utf8'))
const goldenDeck = sanitizeDeck(goldenRaw, new Map(), TEMPLATES.rich)
assert(goldenDeck, 'golden freeform sanitiza')
for (const [prof, tpl] of Object.entries(TEMPLATES)) {
  const theme = resolveDeckTheme(tpl)
  const review = reviewDeck(goldenDeck, theme)
  assert(
    review.clean,
    `golden deve estar limpo no perfil "${prof}", mas achou: ${review.slides
      .map((s) => `s${s.index}: ${s.findings.join('; ')}`)
      .join(' | ')}`
  )
}
console.log(`review: golden limpo em ${Object.keys(TEMPLATES).length} perfis de tema`)

// 2) negative fixtures — each isolates one defect the loop must catch.
const theme = resolveDeckTheme(TEMPLATES.rich)

// (a) element that bleeds past the right edge of the 10×5.625in canvas. A
// FULLY off-canvas element is legitimately pruned by the sanitizer (the runtime
// only ever reviews sanitized decks), so the realistic defect the loop must
// catch is a box that starts on-canvas and overruns an edge — clipped at paint.
// A second content element keeps the slide from collapsing to empty (→ pruned).
const edgeBleed = {
  title: 'edge-bleed',
  slides: [{
    layout: 'freeform',
    elements: [
      { type: 'text', id: 't1', box: { x: 8.5, y: 2, w: 4, h: 1 }, text: 'Título que vaza pela borda direita do slide', style: { fontSize: 18 } },
      { type: 'text', id: 't2', box: { x: 1, y: 0.8, w: 6, h: 0.6 }, text: 'Âncora de conteúdo', style: { fontSize: 16 } },
    ],
  }],
}
{
  const d = sanitizeDeck(edgeBleed, new Map(), TEMPLATES.rich)
  const review = d ? reviewDeck(d, theme) : { clean: true, slides: [] }
  assert(!review.clean, 'edge-bleed: deveria acusar elemento que ultrapassa a borda')
  const hasBoundsFinding = review.slides.some((s) => s.findings.some((f) => /borda|fora do slide/i.test(f)))
  assert(hasBoundsFinding, 'edge-bleed: o achado deveria mencionar a borda do slide')
}

// (b) low-contrast: near-background ink on the oat slide bg
const lowContrast = {
  title: 'low-contrast',
  slides: [{
    layout: 'freeform',
    background: { color: '#F9F7F4' },
    elements: [{ type: 'text', id: 't1', box: { x: 1, y: 2, w: 6, h: 1 }, text: 'Quase invisível', style: { fontSize: 18, color: '#F8F6F3' } }],
  }],
}
{
  const d = sanitizeDeck(lowContrast, new Map(), TEMPLATES.rich)
  const review = d ? reviewDeck(d, theme) : { clean: true, slides: [] }
  assert(!review.clean, 'low-contrast: deveria acusar texto de baixo contraste')
  const hasContrastFinding = review.slides.some((s) => s.findings.some((f) => /contraste/i.test(f)))
  assert(hasContrastFinding, 'low-contrast: o achado deveria mencionar contraste')
}

// (c) clipping: a long title forced into a tiny box shrinks below the legible floor
const clipped = {
  title: 'clipped',
  slides: [{
    layout: 'freeform',
    elements: [{
      type: 'text', id: 't1', box: { x: 1, y: 1, w: 1.2, h: 0.35 },
      text: 'Um título executivo bem longo que jamais caberia nesta caixa minúscula sem encolher demais',
      style: { fontSize: 40 },
    }],
  }],
}
{
  const d = sanitizeDeck(clipped, new Map(), TEMPLATES.rich)
  const review = d ? reviewDeck(d, theme) : { clean: true, slides: [] }
  assert(!review.clean, 'clipping: deveria acusar texto encolhido/ilegível')
}

console.log('review: 3 defeitos negativos detectados (off-canvas, contraste, clipping)')

if (failures) {
  console.error(`\n${failures} falha(s) na QA de revisão visual`)
  process.exit(1)
}
console.log('deck-review-qa: OK')
