#!/usr/bin/env node
// End-to-end QA for the design-system miner (client/src/lib/pptxMining.js):
// builds a synthetic .pptx with pptxgenjs, mines it in Node (DOMParser
// polyfilled with @xmldom/xmldom — the same code path the browser runs), and
// asserts the three contracts this pipeline promises:
//
//   1. media reused on >40% of slides is classified `watermark` and NEVER
//      reaches the model (usableIconAssets/usableImageAssets);
//   2. a slide made of labeled boxes + arrowed connectors is mined as a
//      vector diagram spec (minedStyle.diagrams);
//   3. a deck referencing that diagram via `diagramRef` gets the spec baked
//      by sanitizeDeck and renders to a valid .pptx buffer.
//
//   node scripts/mine-pptx-qa.mjs
import { DOMParser } from '@xmldom/xmldom'
globalThis.DOMParser = DOMParser

import { mkdirSync, writeFileSync } from 'node:fs'
import PptxGenJS from 'pptxgenjs'
import { extractPptxTheme, mergeTemplate } from '../client/src/lib/pptxMining.js'
import { sanitizeDeck, usableIconAssets, usableImageAssets, buildBlocksInstruction } from '../server/blocks.js'
import { renderPptx, diagramPlateColor } from '../server/decks.js'

const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exitCode = 1
  } else {
    console.log('ok  :', msg)
  }
}

// tiny valid PNGs (1x1) in two colors so the two media files are distinct
const PNG_RED =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_BLUE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

async function buildSyntheticPptx() {
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'W', width: 13.333, height: 7.5 })
  pptx.layout = 'W'
  for (let i = 0; i < 10; i++) {
    const s = pptx.addSlide()
    if (i !== 6) s.addText(`Slide title ${i + 1}`, { x: 0.5, y: 0.3, w: 8, h: 0.6, fontSize: 28 })
    // "watermark": the same logo on 9 of 10 slides, icon-sized
    if (i !== 4) s.addImage({ data: PNG_RED, x: 12.3, y: 6.9, w: 0.5, h: 0.4 })
    // a real concept icon: appears on only 2 slides
    if (i === 2 || i === 5) s.addImage({ data: PNG_BLUE, x: 1, y: 2, w: 0.6, h: 0.6 })
    if (i === 6) {
      // diagram slide: 3 labeled boxes + platform bands + 2 arrowed connectors
      s.addText('Arquitetura da plataforma', { x: 0.5, y: 0.3, w: 9, h: 0.6, fontSize: 28 })
      s.addShape('roundRect', { x: 0.8, y: 2.0, w: 2.4, h: 1.0, fill: { color: 'DDE3EA' }, line: { color: '335577' } })
      s.addText('Fontes', { x: 0.8, y: 2.0, w: 2.4, h: 1.0, fontSize: 14, align: 'center', color: '223344' })
      s.addShape('roundRect', { x: 0.8, y: 3.4, w: 2.4, h: 1.0, fill: { color: 'DDE3EA' } })
      s.addText('Aplicações', { x: 0.8, y: 3.4, w: 2.4, h: 1.0, fontSize: 14, align: 'center' })
      s.addShape('rect', { x: 5.0, y: 1.8, w: 3.6, h: 3.0, fill: { color: '1A1A2E' } })
      s.addText('Plataforma', { x: 5.0, y: 1.8, w: 3.6, h: 0.6, fontSize: 16, align: 'center', color: 'FFFFFF', bold: true })
      s.addShape('rect', { x: 5.3, y: 2.6, w: 3.0, h: 0.6, fill: { color: 'E63946' } })
      s.addText('Governança', { x: 5.3, y: 2.6, w: 3.0, h: 0.6, fontSize: 12, align: 'center', color: 'FFFFFF' })
      s.addShape('rect', { x: 5.3, y: 3.5, w: 3.0, h: 0.6, fill: { color: '4A4E69' } })
      s.addText('Processamento', { x: 5.3, y: 3.5, w: 3.0, h: 0.6, fontSize: 12, align: 'center', color: 'FFFFFF' })
      s.addShape('roundRect', { x: 10.2, y: 2.6, w: 2.4, h: 1.0, fill: { color: 'DDE3EA' } })
      s.addText('Consumo', { x: 10.2, y: 2.6, w: 2.4, h: 1.0, fontSize: 14, align: 'center' })
      s.addShape('line', { x: 3.3, y: 2.9, w: 1.6, h: 0.4, line: { color: '335577', width: 2, endArrowType: 'triangle' } })
      s.addShape('line', { x: 8.7, y: 3.1, w: 1.4, h: 0, line: { color: '335577', width: 2, endArrowType: 'triangle' } })
    }
  }
  return pptx.write({ outputType: 'nodebuffer' })
}

const buf = await buildSyntheticPptx()
const tpl = await extractPptxTheme(buf)

// --- 1. watermark classification --------------------------------------
const kinds = (tpl.iconAssets || []).map((a) => a.kind)
assert(kinds.includes('watermark'), `logo repetido em 90% dos slides classificado como watermark (kinds: ${kinds.join(',')})`)
assert(kinds.includes('icon'), 'ícone usado em 2 slides continua classificado como icon')
const usable = [...usableIconAssets(tpl), ...usableImageAssets(tpl)]
assert(!usable.some((a) => a.kind === 'watermark'), 'nenhuma marca d’água é utilizável pelo modelo')
const hint = buildBlocksInstruction([], tpl)
const wmIds = (tpl.iconAssets || []).filter((a) => a.kind === 'watermark').map((a) => a.id)
assert(wmIds.every((id) => !hint.includes(`- ${id}:`)), 'ids de watermark não aparecem no prompt do modelo')

// --- 2. diagram mining --------------------------------------------------
const diagrams = tpl.minedStyle?.diagrams || []
assert(diagrams.length >= 1, `slide de arquitetura minerado como diagrama (${diagrams.length} encontrados)`)
const diag = diagrams[0]
assert(diag && diag.shapes.length >= 5, `diagrama tem as formas esperadas (${diag?.shapes?.length})`)
assert(diag && diag.connectors.length >= 2, `diagrama tem os conectores (${diag?.connectors?.length})`)
assert(diag && diag.shapes.some((s) => s.text === 'Governança'), 'labels das formas capturados')
assert(diag && diag.label.includes('Arquitetura'), `título do slide vira rótulo do diagrama ("${diag?.label}")`)
assert(hint.includes('diagramRef') && hint.includes(diag.id), 'diagramas listados no prompt do modelo')

// --- 3. diagramRef → baked spec → renderPptx ----------------------------
const deck = sanitizeDeck(
  {
    type: 'deck',
    title: 'QA sintético',
    audience: 'Preparado para QA',
    narrative: 'contexto → arquitetura → decisão',
    slides: [
      { layout: 'title', heading: 'QA sintético', kicker: 'Teste' },
      { layout: 'image', heading: 'A plataforma conecta fontes a consumo', diagramRef: diag?.id },
      { layout: 'closing', heading: 'Aprovar QA' },
    ],
  },
  new Map(),
  tpl
)
assert(deck?.slides?.[1]?.diagramSpec?.shapes?.length >= 5, 'diagramRef cozido em diagramSpec pelo sanitizeDeck')

// merge: importing the same pptx twice must not duplicate assets
const merged = mergeTemplate(tpl, await extractPptxTheme(buf))
assert(merged.iconAssets.length === tpl.iconAssets.length, 'merge do mesmo arquivo não duplica assets')
assert((merged.minedStyle.diagrams || []).length <= 8, 'merge respeita o teto de diagramas')

// --- 4. contrast plate for mined diagrams --------------------------------
const darkSpec = { shapes: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.2, color: '#1A1A2E' }] }
assert(diagramPlateColor(darkSpec, '15161F') != null, 'arte escura em fundo escuro ganha placa de contraste')
assert(diagramPlateColor(darkSpec, 'FFFFFF') == null, 'arte escura em fundo claro não ganha placa')
assert(
  diagramPlateColor({ ...darkSpec, bg: '#F5F0E8' }, '15161F') === 'F5F0E8',
  'placa usa o fundo original minerado (spec.bg) quando disponível'
)

const out = await renderPptx(deck, tpl)
assert(out?.length > 10_000, `renderPptx gera um .pptx válido (${out?.length} bytes)`)
mkdirSync('scratch-decks', { recursive: true })
writeFileSync('scratch-decks/mine-qa.pptx', out)
console.log(process.exitCode ? '\nQA FALHOU' : '\nQA passou — scratch-decks/mine-qa.pptx gerado')
