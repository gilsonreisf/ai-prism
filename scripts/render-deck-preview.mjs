#!/usr/bin/env node
// Visual QA harness for the deck renderer (docs/deck-quality-gap-analysis.md §5.2).
// Renders fixture decks against synthetic template profiles into .pptx files:
//
//   node scripts/render-deck-preview.mjs <fixture.json> [outDir] [profile]
//
// profile: rich | poor | none | all (default: all)
// Then convert to PNGs for eyeballing (macOS + PowerPoint):
//   scripts/pptx-to-png.sh <outDir>/<file>.pptx
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPptx } from '../server/decks.js'
import { TEMPLATES } from './fixtures/templates.mjs'

const [fixturePath, outDir = 'scratch-decks', profileArg = 'all'] = process.argv.slice(2)
if (!fixturePath) {
  console.error('usage: node scripts/render-deck-preview.mjs <fixture.json> [outDir] [profile]')
  process.exit(1)
}

const deck = JSON.parse(readFileSync(fixturePath, 'utf8'))
const profiles = profileArg === 'all' ? Object.keys(TEMPLATES) : [profileArg]
mkdirSync(outDir, { recursive: true })

const stem = basename(fixturePath).replace(/\.json$/, '')
for (const p of profiles) {
  const buf = await renderPptx(deck, TEMPLATES[p])
  const out = join(outDir, `${stem}--${p}.pptx`)
  writeFileSync(out, buf)
  console.log('wrote', out)
}
