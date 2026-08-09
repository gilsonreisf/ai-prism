#!/usr/bin/env node
/**
 * Test deck HTML generation with real data from postgres
 * Extracts slides, theme, and generates HTML to diagnose rendering issues
 */
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..')

// Import shared modules
const { generateDeckHtml } = await import(path.join(projectRoot, 'shared/deckHtml.js'))
const { resolveDeckTheme, THEME_COLOR_TOKENS } = await import(path.join(projectRoot, 'shared/deckTheme.js'))

// Query postgres for real deck data
function queryDb(sql) {
  try {
    const cmd = `PGPASSWORD=ai_prism psql -h 127.0.0.1 -p 55432 -U ai_prism -d ai_prism -tAc "${sql}"`
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
  } catch (e) {
    console.error('DB query failed:', e.message)
    return null
  }
}

// Get the latest deck from session 8
const slidesJson = queryDb(
  `select slides from chat_decks where session_id=8 order by created_at desc limit 1;`
)
const templateJson = queryDb(
  `select template from chat_decks where session_id=8 order by created_at desc limit 1;`
)

if (!slidesJson) {
  console.error('No deck found in database')
  process.exit(1)
}

let slides, template
try {
  slides = JSON.parse(slidesJson)
  template = templateJson ? JSON.parse(templateJson) : { primaryColor: '#1B3139', accentColor: '#FF3621', backgroundColor: '#F9F7F4' }
} catch (e) {
  console.error('JSON parse error:', e.message)
  process.exit(1)
}

console.log(`Found ${slides?.length || 0} slides`)
if (template) {
  console.log(`Template: primary=${template.primaryColor}, accent=${template.accentColor}, bg=${template.backgroundColor}`)
}

// Generate HTML
let html
try {
  html = generateDeckHtml(slides, template)
} catch (e) {
  console.error('HTML generation error:', e.message, e.stack)
  process.exit(1)
}

// Save to /tmp for inspection
const outPath = '/tmp/test-deck.html'
fs.writeFileSync(outPath, html)
console.log(`\nHTML saved to ${outPath}`)

// Diagnostic checks
console.log('\n=== DIAGNOSTICS ===')

// Check 1: CSS problem
const cssMatch = html.match(/:root\s*{([^}]+)}/s)
if (cssMatch) {
  const cssVars = cssMatch[1]
  const hasFont = cssVars.includes('--deck-font-heading') && cssVars.includes('--deck-font-body')
  console.log(`[CSS] :root found. Font vars inline: ${hasFont ? 'YES' : 'NO (PROBLEM 2!)'}`)
  if (!hasFont) {
    const fontMatch = html.match(/--deck-font-heading.*?;/s)
    if (fontMatch) console.log(`  Font declaration found outside :root: ${fontMatch[0]}`)
  }
} else {
  console.log('[CSS] :root NOT FOUND (CRITICAL!)')
}

// Check 2: Slide content
const slideMatches = html.match(/<div\s+class="slide[^>]*>/g) || []
console.log(`[Slides] ${slideMatches.length} divs with class="slide"`)

// Check each slide for content
slides?.forEach((slide, i) => {
  const isFreeform = slide.layout === 'freeform'
  const elementCount = slide.elements?.length || 0
  console.log(`  Slide ${i}: layout=${slide.layout}, elements=${elementCount}`)
})

// Check 3: Theme colors in HTML
const themeCheck = {
  primary: template?.primaryColor?.toUpperCase().replace('#', ''),
  accent: template?.accentColor?.toUpperCase().replace('#', ''),
  background: template?.backgroundColor?.toUpperCase().replace('#', ''),
}
let colorMatches = 0
for (const [name, color] of Object.entries(themeCheck)) {
  if (color && (html.includes(`#${color}`) || html.includes(color))) {
    colorMatches++
    console.log(`[Theme] ${name}: FOUND (#${color})`)
  } else {
    console.log(`[Theme] ${name}: NOT FOUND (#${color}) - may use tokens`)
  }
}

console.log(`\n✓ HTML written to ${outPath}`)
console.log('Open in browser or run: open ' + outPath)
