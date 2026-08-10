#!/usr/bin/env node
// Offline QA for the pure-HTML deck engine (the only deck engine).
//
//   node scripts/deck-html-qa.mjs
//
// Covers the two server-side guarantees the HTML deck path relies on:
//   1. sanitizeHtmlDeck (server/blocks.js) — the shape gate + <script> strip that
//      every generated/edited deck round-trips through before it's persisted.
//   2. renderPptxFromOps (server/decks.js) — the native .pptx assembler that
//      turns the paint-ops the client extracts off the rendered DOM into a real
//      PowerPoint of editable shapes, incl. the brand-font embedding option.
//
// The live browser rendering/editing (HtmlSlideFrame, HtmlSlideEditor,
// domToSlideOps) is exercised by the app itself; this script guards the two
// pure, dependency-light server functions that a broken refactor would silently
// break.
import JSZip from 'jszip'
import { sanitizeHtmlDeck, clientWorkingSlides } from '../server/blocks.js'
import { renderPptxFromOps } from '../server/decks.js'
import { resolveDeckAssets } from '../client/src/lib/deckAssets.js'

let failures = 0
const assert = (cond, msg) => {
  if (cond) {
    console.log('ok  -', msg)
    return
  }
  failures++
  console.error('FAIL:', msg)
}

// ---- 1. sanitizeHtmlDeck ---------------------------------------------------

// a valid deck survives, title is trimmed, slides come back as strings
{
  const out = sanitizeHtmlDeck({
    title: '  Minha apresentação  ',
    audience: 'diretoria',
    slides: ['<section class="slide"><h1>Um</h1></section>', { html: '<section class="slide">Dois</section>' }],
  })
  assert(out && out.title === 'Minha apresentação', 'sanitizeHtmlDeck trims the title')
  assert(out && out.slides.length === 2, 'sanitizeHtmlDeck keeps both string and {html} slides')
  assert(out && out.slides.every((s) => typeof s === 'string'), 'sanitizeHtmlDeck normalizes slides to strings')
  assert(out && out.audience === 'diretoria', 'sanitizeHtmlDeck preserves audience')
}

// <script> is always stripped (defense-in-depth), inline content kept
{
  const out = sanitizeHtmlDeck({
    title: 'x',
    slides: ['<section><script>alert(1)</script><p>oi</p></section>'],
  })
  assert(out && !/‹?script/i.test(out.slides[0]) && !out.slides[0].includes('<script'), 'sanitizeHtmlDeck strips <script>')
  assert(out && out.slides[0].includes('<p>oi</p>'), 'sanitizeHtmlDeck keeps the non-script markup')
}

// empty / malformed inputs are rejected (return null, never throw)
{
  assert(sanitizeHtmlDeck(null) === null, 'sanitizeHtmlDeck(null) → null')
  assert(sanitizeHtmlDeck({ title: '', slides: ['<section/>'] }) === null, 'empty title → null')
  assert(sanitizeHtmlDeck({ title: 'x', slides: [] }) === null, 'no slides → null')
  assert(sanitizeHtmlDeck({ title: 'x', slides: ['   ', ''] }) === null, 'blank-only slides → null')
}

// slide count is capped
{
  const many = Array.from({ length: 80 }, (_, i) => `<section>${i}</section>`)
  const out = sanitizeHtmlDeck({ title: 'x', slides: many })
  assert(out && out.slides.length <= 40, `slide count capped (got ${out?.slides.length})`)
}

// ---- 1b. resolveDeckAssets: replaced images survive to export --------------
// Regression for the "replaced image reverts to the original in the exported
// .pptx" bug. The editor drops the data-ds-asset-id marker when the user swaps
// an <img>'s src (see HtmlSlideEditor setAttr), so serialize() keeps the custom
// src. resolveDeckAssets — which runs on the off-screen export frame too — must
// then leave that custom <img> alone and only re-resolve still-symbolic ones.
{
  const map = new Map([['icon_1', 'data:image/svg+xml;base64,ORIGINAL']])

  // a still-symbolic asset (untouched by the user) resolves to the DS art
  const symbolic = resolveDeckAssets('<section><img data-ds-asset-id="icon_1"></section>', map)
  assert(symbolic.includes('ORIGINAL'), 'resolveDeckAssets resolves a symbolic data-ds-asset-id to the template art')

  // a user-customized <img> (marker already stripped) keeps its own src and is
  // NOT re-resolved to the template original — this is the export-side guarantee
  const customized = resolveDeckAssets('<section><img src="data:image/png;base64,USERIMG"></section>', map)
  assert(customized.includes('USERIMG'), 'resolveDeckAssets preserves a replaced image src')
  assert(!customized.includes('ORIGINAL'), 'resolveDeckAssets does not re-inject the original DS art over a replaced image')

  // belt-and-suspenders: even if a stale marker somehow lingers, an id with no
  // matching asset must never blank out; and idempotency holds on a resolved img
  const twice = resolveDeckAssets(resolveDeckAssets('<section><img data-ds-asset-id="icon_1"></section>', map), map)
  assert(twice.includes('ORIGINAL') && (twice.match(/ORIGINAL/g) || []).length === 1, 'resolveDeckAssets is idempotent on a resolved asset')
}

// ---- 1c. clientWorkingSlides: AI edits the working copy, safely ------------
// The tweak endpoint edits the client's in-memory slides (unsaved manual edits)
// when the body carries a usable `slides` array, else falls back to the DB copy
// (item 4). A malformed payload must never become the thing we edit/persist.
{
  const good = clientWorkingSlides(['<section>Um</section>', { html: '<section>Dois</section>', notes: 'n' }])
  assert(good && good.length === 2, 'clientWorkingSlides accepts a valid working copy')
  assert(good && good[0] === '<section>Um</section>', 'clientWorkingSlides keeps a bare string slide')
  assert(good && good[1] && good[1].notes === 'n', 'clientWorkingSlides preserves per-slide notes')

  assert(clientWorkingSlides(undefined) === null, 'clientWorkingSlides(undefined) → null (fall back to DB)')
  assert(clientWorkingSlides([]) === null, 'clientWorkingSlides([]) → null')
  assert(clientWorkingSlides(['<div>not a section</div>']) === null, 'clientWorkingSlides rejects a slide with no <section>')
  assert(clientWorkingSlides([{ html: '   ' }]) === null, 'clientWorkingSlides rejects a blank slide')
  assert(clientWorkingSlides('nope') === null, 'clientWorkingSlides rejects a non-array')
}

// ---- 2. renderPptxFromOps --------------------------------------------------

// paint-ops (px on a 1280×720 stage) → a real .pptx zip with the expected parts
{
  const slides = [
    {
      w: 1280,
      h: 720,
      ops: [
        { type: 'rect', x: 0, y: 0, w: 1280, h: 720, fill: '0E1A1F' },
        { type: 'rect', x: 80, y: 80, w: 300, h: 120, radius: 16, fill: 'FFFFFF', line: { color: 'CCCCCC', width: 1 } },
        {
          type: 'text',
          x: 80,
          y: 240,
          w: 1120,
          h: 120,
          align: 'left',
          valign: 'top',
          lineHeight: 1.15,
          runs: [{ text: 'Título do slide', font: 'Arial', size: 40, color: 'FFFFFF', bold: true }],
        },
      ],
    },
    {
      w: 1280,
      h: 720,
      ops: [{ type: 'text', x: 80, y: 80, w: 1120, h: 80, runs: [{ text: 'Segundo slide', size: 24, color: '111111' }] }],
    },
  ]
  const buf = await renderPptxFromOps({ title: 'Deck de teste' }, slides)
  assert(Buffer.isBuffer(buf) && buf.length > 10_000, `renderPptxFromOps produces a .pptx buffer (${buf?.length} bytes)`)

  const zip = await JSZip.loadAsync(buf)
  assert(!!zip.file('ppt/presentation.xml'), '.pptx contains ppt/presentation.xml')
  assert(!!zip.file('ppt/slides/slide1.xml'), '.pptx contains slide1.xml')
  assert(!!zip.file('ppt/slides/slide2.xml'), '.pptx contains slide2.xml (one part per slide)')
  const slide1 = await zip.file('ppt/slides/slide1.xml').async('string')
  assert(slide1.includes('Título do slide'), 'slide1 carries the text run verbatim')
}

// a malformed op must never abort the whole export (best-effort per op)
{
  const buf = await renderPptxFromOps({ title: 'x' }, [
    { w: 1280, h: 720, ops: [{ type: 'text' /* no runs */ }, { type: 'rect', x: 0, y: 0, w: 100, h: 100, fill: '000000' }] },
  ])
  assert(Buffer.isBuffer(buf) && buf.length > 5_000, 'renderPptxFromOps tolerates a malformed op and still exports')
}

// brand-font embedding: a TTF data-URI ends up embedded in the zip
{
  // a tiny (invalid-as-a-font but well-formed data-URI) TTF payload is enough to
  // exercise the embed plumbing — the function only base64-decodes and stores it.
  const fakeTtf = 'data:font/ttf;base64,' + Buffer.from('not-a-real-font-but-bytes').toString('base64')
  const buf = await renderPptxFromOps({ title: 'x' }, [{ w: 1280, h: 720, ops: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '000000' }] }], {
    embedFonts: true,
    fontAssets: [{ family: 'BrandSans', weight: '400', style: 'normal', dataUrl: fakeTtf }],
  })
  const zip = await JSZip.loadAsync(buf)
  const hasFont = Object.keys(zip.files).some((p) => /ppt\/fonts\/font\d+\.fntdata/.test(p))
  assert(hasFont, 'embedFonts embeds the DS font bytes at ppt/fonts/*.fntdata')
  const pres = await zip.file('ppt/presentation.xml').async('string')
  assert(pres.includes('embeddedFontLst') && pres.includes('BrandSans'), 'presentation.xml declares the embedded brand font')
}

// embedding is best-effort: a non-embeddable asset must not corrupt the file
{
  const buf = await renderPptxFromOps({ title: 'x' }, [{ w: 1280, h: 720, ops: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '000000' }] }], {
    embedFonts: true,
    fontAssets: [{ family: 'X', dataUrl: 'not-a-data-uri' }],
  })
  assert(Buffer.isBuffer(buf) && buf.length > 5_000, 'renderPptxFromOps falls back cleanly when a font asset is unembeddable')
}

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\ndeck-html QA passed')
