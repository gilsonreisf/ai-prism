#!/usr/bin/env node
// QA harness for the element-canvas pipeline (shared/deckLayout.js +
// sanitizeDeck freeform branch + both painters):
//
//   node scripts/deck-elements-qa.mjs [--write-golden]
//
// Asserts: sanitizer invariants (boxes inside limits, valid colors, caps),
// sanitize idempotence (sanitize(sanitize(x)) === sanitize(x)), materialize
// pass-through for freeform, legacy layouts still return null (until ported),
// and renderPptx accepts a mixed legacy+freeform deck for every template
// profile. Golden: scripts/fixtures/deck-freeform.golden.json.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeDeck } from '../server/blocks.js'
import { renderPptx } from '../server/decks.js'
import { materializeSlide, CONVERTIBLE_LAYOUTS, BOX_LIMITS, MAX_ELEMENTS_PER_SLIDE } from '../shared/deckLayout.js'
import { resolveDeckTheme } from '../shared/deckTheme.js'
import { TEMPLATES } from './fixtures/templates.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN = join(HERE, 'fixtures', 'deck-freeform.golden.json')
const writeGolden = process.argv.includes('--write-golden')

let failures = 0
const assert = (cond, msg) => {
  if (cond) return
  failures++
  console.error('FAIL:', msg)
}

// a deliberately dirty freeform slide: out-of-range boxes, bad colors,
// unknown props, duplicate ids — everything the sanitizer must normalize
const rawDeck = {
  title: 'QA — canvas de elementos',
  slides: [
    { layout: 'bullets', heading: 'Slide legado', bullets: ['a', 'b'] },
    {
      layout: 'freeform',
      title: 'Slide livre',
      background: { color: '#1b3139', plate: 'nope' },
      notes: 'nota',
      elements: [
        { id: 'shape1', type: 'shape', shape: 'roundRect', box: { x: 0.62, y: 1.2, w: 4.2, h: 2 }, style: { fill: '#1B3139', radius: 0.14, opacity: 250, borderColor: 'red', shadow: { blur: 999, offset: -5 } } },
        { id: 'shape1', type: 'shape', shape: 'weird', box: { x: 99, y: -99, w: 0, h: 0.5 }, style: { fill: 'none' } },
        { id: 'txt', type: 'text', box: { x: 1, y: 1, w: 3, h: 1 }, text: 'Olá\nmundo', style: { fontRole: 'heading', fontSize: 500, color: '#FF3621', align: 'center', valign: 'middle', lineHeight: 9, bullet: true } },
        { id: 'ln', type: 'line', box: { x: 1, y: 3, w: 4, h: 0 }, flipH: true, style: { lineColor: '#FF3621', lineWidth: 100, dash: 'dash', arrowEnd: true } },
        { id: 'ic', type: 'icon', box: { x: 6, y: 1, w: 0.8, h: 0.8 }, icon: { builtin: 'rocket' }, style: { fill: '#FAE4DF' } },
        { id: 'ic2', type: 'icon', box: { x: 7, y: 1, w: 0.8, h: 0.8 }, icon: { builtin: 'not-an-icon' } },
        { id: 'im', type: 'image', box: { x: 6, y: 2.5, w: 2.5, h: 1.8 }, imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
        { type: 'bogus', box: { x: 1, y: 1, w: 1, h: 1 } },
      ],
    },
  ],
}

const deck = sanitizeDeck(rawDeck)
assert(deck, 'sanitizeDeck aceitou o deck misto')
const ff = deck.slides[1]
assert(deck.slides[0].layout === 'bullets', 'slide legado preservado')
assert(ff.layout === 'freeform', 'slide freeform preservado')
assert(ff.background?.color === '#1B3139' && !ff.background.plate, 'background validado (cor ok, plate inválido caiu)')
assert(ff.elements.length === 7, `elementos válidos mantidos, bogus descartado (${ff.elements.length})`)
assert(new Set(ff.elements.map((e) => e.id)).size === ff.elements.length, 'ids únicos após dedupe')

// box/style invariants
for (const el of ff.elements) {
  const { x, y, w, h } = el.box
  assert(x >= BOX_LIMITS.xMin && x <= BOX_LIMITS.xMax, `x dentro dos limites (${el.id})`)
  assert(y >= BOX_LIMITS.yMin && y <= BOX_LIMITS.yMax, `y dentro dos limites (${el.id})`)
  assert(w >= 0 && w <= BOX_LIMITS.maxSize && h >= 0 && h <= BOX_LIMITS.maxSize, `tamanho dentro dos limites (${el.id})`)
  for (const k of ['fill', 'color', 'borderColor', 'lineColor']) {
    const v = el.style?.[k]
    assert(v === undefined || v === 'none' || /^#[0-9A-F]{6}$/.test(v), `cor válida em ${k} (${el.id}): ${v}`)
  }
}
const sh = ff.elements[0].style
assert(sh.opacity === undefined || (sh.opacity >= 0 && sh.opacity < 100), 'opacity clampada')
assert(sh.shadow && sh.shadow.blur <= 40 && sh.shadow.offset >= 0, 'shadow clampada')
assert(ff.elements[2].style.fontSize <= 120 && ff.elements[2].style.lineHeight <= 3, 'texto clampado')
assert(!('builtin' in (ff.elements[5].icon || {})), 'builtin desconhecido descartado')

// cap
const many = sanitizeDeck({
  title: 'caps',
  slides: [{ layout: 'freeform', elements: Array.from({ length: 200 }, (_, i) => ({ type: 'shape', box: { x: 1, y: 1, w: 1, h: 1 }, id: `e${i}` })) }],
})
assert(many.slides[0].elements.length === MAX_ELEMENTS_PER_SLIDE, `cap de ${MAX_ELEMENTS_PER_SLIDE} elementos aplicado`)

// idempotence
const twice = sanitizeDeck(JSON.parse(JSON.stringify(deck)))
assert(JSON.stringify(twice) === JSON.stringify(deck), 'sanitize é idempotente')

// materialization
const theme = resolveDeckTheme(TEMPLATES.rich)
assert(materializeSlide(deck.slides[0], theme)?.elements?.length > 0, 'layout semântico suportado materializa em elementos')
assert(materializeSlide({ layout: 'table', columns: ['a', 'b'], rows: [['1', '2']] }, theme)?.elements?.length > 0, 'table materializa em grade de células')
assert(materializeSlide({ layout: 'diagram', columns: [{ label: 'x', items: [{ label: 'a' }] }] }, theme)?.elements?.length > 0, 'diagram materializa em chips')
assert(
  materializeSlide({ layout: 'table', columns: Array.from({ length: 8 }, (_, i) => `c${i}`), rows: Array.from({ length: 9 }, () => Array(8).fill('x')) }, theme) === null,
  'table densa demais para o orçamento de elementos permanece legada (null)'
)
assert(materializeSlide({ layout: 'chart', chartType: 'bar', series: [{ name: 's', data: [{ label: 'a', value: 1 }] }] }, theme) === null, 'chart permanece no caminho legado (gráfico nativo do pptx é superior)')
const mat = materializeSlide(ff, theme)
assert(mat && mat.elements.length === ff.elements.length, 'freeform materializa por pass-through')

// golden snapshot of the sanitized deck (diff = intentional change or regression)
if (writeGolden) {
  writeFileSync(GOLDEN, JSON.stringify(deck, null, 1))
  console.log('golden escrito em', GOLDEN)
} else if (existsSync(GOLDEN)) {
  const gold = readFileSync(GOLDEN, 'utf8')
  assert(JSON.stringify(deck, null, 1) === gold, 'deck sanitizado bate com o golden (rode --write-golden se a mudança for intencional)')
}

// both painters accept the mixed deck (pptx smoke for every template profile),
// through the unified engine path AND the forced-legacy path
for (const [name, tpl] of Object.entries(TEMPLATES)) {
  for (const engine of [true, false]) {
    try {
      const buf = await renderPptx(deck, tpl, { engine })
      assert(buf.length > 10_000, `renderPptx (${name}, engine=${engine}) gerou arquivo plausível`)
    } catch (e) {
      failures++
      console.error(`FAIL: renderPptx (${name}, engine=${engine}) lançou:`, e.message)
    }
  }
}

// --- materialization (semantic → elements, "converter para edição livre") ----
// every fixture deck × every template profile: supported layouts materialize
// into valid, sanitizer-round-trippable element lists; composites stay null
const fixtures = readdirSync(join(HERE, 'fixtures')).filter((f) => /^deck-.*\.json$/.test(f) && !f.includes('golden'))
const colorOk = (v) => v === undefined || v === 'none' || /^#[0-9A-F]{6}$/.test(v)
let matChecked = 0
for (const fix of fixtures) {
  const raw = JSON.parse(readFileSync(join(HERE, 'fixtures', fix), 'utf8'))
  const fixDeck = sanitizeDeck(raw)
  if (!fixDeck) continue
  for (const [prof, tpl] of Object.entries(TEMPLATES)) {
    const theme = resolveDeckTheme(tpl)
    let sectionNo = 0
    fixDeck.slides.forEach((sl, i) => {
      if (sl.layout === 'section') sectionNo++
      const ctx = {
        index: i, total: fixDeck.slides.length, pageNumber: i + 1, sectionNo,
        meta: fixDeck.audience || fixDeck.title || '', audience: fixDeck.audience || '',
        deckTitle: fixDeck.title, author: fixDeck.author || '',
      }
      const mat = materializeSlide(sl, theme, ctx)
      const label = `${fix}#${i} (${sl.layout}, ${prof})`
      if (sl.layout === 'chart') {
        assert(mat === null, `chart retorna null (mantém o gráfico nativo): ${label}`)
        return
      }
      if (!CONVERTIBLE_LAYOUTS.has(sl.layout)) return
      // table/diagram/diagramSpec may decline (element budget) — that's legal
      if (mat === null && (sl.layout === 'table' || sl.layout === 'diagram' || sl.diagramSpec)) return
      matChecked++
      assert(mat && mat.elements.length > 0 && mat.elements.length <= MAX_ELEMENTS_PER_SLIDE, `materializa com 1..80 elementos: ${label} (${mat?.elements?.length})`)
      for (const el of mat.elements) {
        const { x, y, w, h } = el.box
        assert(
          x >= BOX_LIMITS.xMin && x <= BOX_LIMITS.xMax && y >= BOX_LIMITS.yMin && y <= BOX_LIMITS.yMax && w >= 0 && w <= BOX_LIMITS.maxSize && h >= 0 && h <= BOX_LIMITS.maxSize,
          `box dentro dos limites: ${label} el=${el.id} (${x},${y},${w},${h})`
        )
        if (el.type === 'text') assert((el.style?.fontSize ?? 13) >= 5, `fontSize resolvido: ${label} el=${el.id}`)
        for (const k of ['fill', 'color', 'borderColor', 'lineColor']) assert(colorOk(el.style?.[k]), `cor concreta em ${k}: ${label} el=${el.id} (${el.style?.[k]})`)
      }
      const round = sanitizeDeck({ title: 'x', slides: [{ layout: 'freeform', background: mat.background || undefined, elements: mat.elements }] })
      assert(round?.slides?.[0]?.elements?.length === mat.elements.length, `round-trip pelo sanitizer preserva os elementos: ${label} (${round?.slides?.[0]?.elements?.length} vs ${mat.elements.length})`)
    })
  }
}
assert(matChecked > 0, 'a seção de materialização exercitou pelo menos um slide')
console.log(`materialização: ${matChecked} slides × perfis verificados`)

if (failures) {
  console.error(`\n${failures} falha(s)`)
  process.exit(1)
}
console.log('deck-elements-qa: OK')
