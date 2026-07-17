// Design-system BUNDLE importer (Claude Design folder/zip exports) — no React,
// no UI, browser + Node testable like pptxMining.js. A bundle is the folder a
// design tool exports: `_ds_manifest.json`, `README.md`, a tokens CSS, `fonts/
// *.ttf`, `assets/**` (SVG icons/lockups/illustrations + PNG backgrounds) and
// HTML specimen cards (`preview/`, `slides/`, `templates/`). The .pptx miner
// (pptxMining.js) reverse-engineers identity from painted slides; this module
// reads the identity the design system DECLARES, which is strictly richer:
// full named palette, self-hosted fonts, brand voice rules, and curated
// vector illustrations that generated covers/sections can reuse as-is.

// ---- entry normalization --------------------------------------------------
// Everything downstream works on a flat list of { path, text(), bytes() }
// with bundle-root-relative posix paths, so zip files, directory picks and
// drag-and-dropped folders all import identically.

const ROOT_MARKERS = ['_ds_manifest.json', 'colors_and_type.css', 'README.md']

function stripRoot(paths) {
  // find the shallowest dir containing a root marker; return its prefix
  let best = null
  for (const marker of ROOT_MARKERS) {
    for (const p of paths) {
      if (p === marker || p.endsWith('/' + marker)) {
        const prefix = p === marker ? '' : p.slice(0, -marker.length)
        if (best == null || prefix.split('/').length < best.split('/').length) best = prefix
      }
    }
    if (best != null) break
  }
  return best ?? ''
}

export async function entriesFromZip(file) {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(file)
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  const prefix = stripRoot(names)
  return names
    .filter((n) => n.startsWith(prefix))
    .map((n) => ({
      path: n.slice(prefix.length),
      text: () => zip.files[n].async('text'),
      bytes: () => zip.files[n].async('uint8array'),
    }))
}

export function entriesFromFileList(files) {
  const list = Array.from(files)
  const paths = list.map((f) => f.webkitRelativePath || f.name)
  const prefix = stripRoot(paths)
  return list
    .map((f, i) => ({ path: paths[i], file: f }))
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({
      path: e.path.slice(prefix.length),
      text: () => e.file.text(),
      bytes: async () => new Uint8Array(await e.file.arrayBuffer()),
    }))
}

/** True when a set of relative paths looks like a design-system bundle. */
export function isDesignSystemBundle(paths) {
  const set = paths.map((p) => p.split('/').pop())
  return set.includes('_ds_manifest.json') || (set.includes('README.md') && set.includes('colors_and_type.css'))
}

// ---- small helpers ---------------------------------------------------------

const b64 = (bytes) => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  return btoa(bin)
}

const MIME = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' }
const extOf = (p) => (/\.([a-z0-9]+)$/i.exec(p || '')?.[1] || '').toLowerCase()

async function toDataUrl(entry) {
  const bytes = await entry.bytes()
  const mime = MIME[extOf(entry.path)] || 'application/octet-stream'
  return `data:${mime};base64,${b64(bytes)}`
}

function hexLum(hex) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}
function hexSat(hex) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  return max === 0 ? 0 : (max - min) / max
}

// "unity-catalog-icon-full-color" → "Unity Catalog"; camelCase namespaces split too
function humanize(name) {
  return name
    .replace(/\.(svg|png|jpe?g|gif|webp|html)$/i, '')
    // prefix-style families ("primary-icon-lakeflow-jobs-orange") name the
    // product AFTER the marker — pull it forward before suffix stripping
    .replace(/^(?:primary|secondary)-icon-(.+?)(?:-(?:navy|orange|white|black|gray))?$/i, '$1')
    .replace(/-(icon|lockup|logo)(-.*)?$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .trim()
}

// ---- palette / tokens -------------------------------------------------------

const HEX_RE = /^#?[0-9a-f]{6}$/i
const normHex = (v) => '#' + v.replace('#', '').toUpperCase()

function paletteFromManifest(manifest) {
  const tokens = (manifest?.tokens || []).filter((t) => t.kind === 'color' && HEX_RE.test(String(t.value || '').trim()))
  return tokens.map((t) => ({
    varName: t.name || '',
    name: humanize(String(t.name || '').replace(/^--/, '').replace(/^[a-z]{1,4}-/, '')),
    value: normHex(String(t.value).trim()),
  }))
}

function paletteFromCss(css) {
  const out = []
  const re = /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g
  let m
  while ((m = re.exec(css))) {
    out.push({ varName: m[1], name: humanize(m[1].replace(/^--/, '').replace(/^[a-z]{1,4}-/, '')), value: normHex(m[2]) })
  }
  return out
}

// Map the declared palette onto the 4 theme slots the renderer consumes.
// Name hints first (bundles name their tokens meaningfully), value heuristics
// as fallback — always user-editable afterwards in the template form.
function pickThemeColors(palette) {
  const find = (re, pred = () => true) => palette.find((t) => re.test(t.varName) && pred(t.value))?.value
  const light = (v) => hexLum(v) > 0.8
  const dark = (v) => hexLum(v) < 0.35
  const byLum = [...palette].sort((a, b) => hexLum(a.value) - hexLum(b.value))
  const background =
    find(/(oat|bg|background|paper|surface)[-\w]*light|light[-\w]*(bg|background)/i, light) ||
    find(/(oat|bg|background|paper|surface|white)/i, light) ||
    byLum[byLum.length - 1]?.value
  const primary =
    find(/(navy|primary|brand)[-\w]*$/i, dark) ||
    find(/(ink|navy|primary|dark)/i, dark) ||
    byLum[0]?.value
  const saturated = palette
    .filter((t) => hexSat(t.value) > 0.55 && hexLum(t.value) > 0.25 && hexLum(t.value) < 0.75 && t.value !== primary)
    .sort((a, b) => hexSat(b.value) - hexSat(a.value))
  const accent = find(/(lava|accent|cta)[-\w]*$/i) || saturated[0]?.value
  const secondary = find(/(coral|secondary)[-\w]*$/i) || saturated.find((t) => t.value !== accent)?.value
  return { background, primary, accent, secondary }
}

// ---- README → model-facing brand rules --------------------------------------

// The README is the same context a human designer reads: voice, casing,
// color/type rules. The full text is stored for the viewer; the model gets a
// condensed cut (headline sections only) so every deck turn carries the brand
// rules without ballooning the prompt.
const RULE_SECTIONS = /content fundamentals|visual foundations|iconography|quick reference|voice|tone/i

export function condenseReadme(readme, cap = 3800) {
  if (!readme) return ''
  const lines = readme.split('\n')
  const kept = []
  let keep = false
  for (const line of lines) {
    const h = /^#{1,3}\s+(.*)/.exec(line)
    if (h) keep = RULE_SECTIONS.test(h[1])
    if (keep) kept.push(line)
  }
  let out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!out) out = readme.slice(0, 2000)
  return out.length > cap ? out.slice(0, cap) + '…' : out
}

// ---- brand asset classification ---------------------------------------------

const ASSET_CAPS = { icon: 48, lockup: 24, illustration: 16, background: 12, image: 16 }
const ASSET_MAX_B64 = { icon: 400_000, lockup: 400_000, illustration: 700_000, background: 2_400_000, image: 900_000 }
// full-bleed backgrounds ship as multi-MB PNGs; a 1440px JPEG keeps them
// visually identical on a 10in slide while cutting the template payload ~10×
const BACKGROUND_MAX_W = 1440
const DOWNSCALE_OVER_B64 = 450_000

// Browser default for opts.downscaleImage — Node callers (QA harness) get
// null and keep originals under the per-kind byte caps instead.
function browserDownscale(dataUrl, maxW = BACKGROUND_MAX_W, quality = 0.82) {
  if (typeof document === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxW / (img.width || maxW))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round((img.width || maxW) * scale)
      canvas.height = Math.round((img.height || maxW) * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}

function classifyBrandAsset(path) {
  const file = path.split('/').pop().toLowerCase()
  const ext = extOf(file)
  if (!MIME[ext] || ext === 'ttf' || ext === 'otf' || ext === 'woff' || ext === 'woff2') return null
  if (/illustration|nodal/.test(file)) return 'illustration'
  if (/(^|-)bg[-_]|background|bg-pattern|industry-/.test(file)) return 'background'
  if (/lockup/.test(file)) return 'lockup'
  if (/-icon(-|\.)/.test(file)) return 'icon'
  if (/logo|symbol/.test(file)) return 'lockup'
  return 'image'
}

// primary variant filter: skip -alt/-container/-white duplicates when the
// plain full-color exists — the icon library needs one canonical entry per
// product, not 6 variants that all label the same
function isPrimaryVariant(file, kind) {
  if (kind === 'icon') {
    // prefix families ship one file per color — keep only the brand-accent
    // one so the library has one canonical entry per product
    if (/^(?:primary|secondary)-icon-/.test(file)) return /-orange\.svg$/.test(file)
    return /-icon-full-color\.svg$/.test(file) || (!/-(alt|container|white)/.test(file) && /icon/.test(file))
  }
  if (kind === 'lockup') return !/-(container|alt|navy-alt|white)/.test(file)
  return true
}

function labelFor(file, kind) {
  const base = humanize(file.split('/').pop())
  if (kind === 'illustration') {
    const n = /nodal-([\d]+)/.exec(file)?.[1]
    const gray = /gray/.test(file) ? ' (cinza)' : ''
    return n ? `Ilustração nodal ${n}${gray}` : `Ilustração — ${base}`
  }
  if (kind === 'lockup') return `${base} (lockup)`
  if (kind === 'background') return `Fundo — ${base}`
  return base
}

// ---- HTML specimen cards ----------------------------------------------------

const CARD_MAX_HTML = 600_000
const CARDS_TOTAL_BUDGET = 9_000_000

// Rewrites a specimen card into a fully self-contained document: the tokens
// CSS is inlined (with @font-face srcs swapped to data-URL fonts and remote
// @imports dropped — iframes must not depend on network/CSP), relative asset
// and script references become data URLs / inline scripts.
async function inlineCardHtml(html, cardPath, ctx) {
  const dir = cardPath.includes('/') ? cardPath.slice(0, cardPath.lastIndexOf('/') + 1) : ''
  const resolve = (ref) => {
    let p = ref.replace(/^\.\//, '')
    let d = dir
    while (p.startsWith('../')) {
      p = p.slice(3)
      d = d.replace(/[^/]+\/$/, '')
    }
    return d + p
  }

  let out = html
  // stylesheet links → inline <style>
  out = await replaceAsync(out, /<link[^>]+rel=["']stylesheet["'][^>]*>/gi, async (tag) => {
    const href = /href=["']([^"']+)["']/.exec(tag)?.[1]
    if (!href || /^https?:/.test(href)) return ''
    const css = ctx.cssByPath.get(resolve(href)) ?? (await ctx.readText(resolve(href)))
    return css != null ? `<style>${css}</style>` : ''
  })
  // scripts → inline. The HTML parser ends a <script> at the first literal
  // "</script" in its text, so any such sequence inside the JS body (e.g. a
  // "</script>" in a doc comment, as deck-stage.js has) would truncate the
  // element and dump the rest of the file as visible page text — the custom
  // element then never registers and `:not(:defined)` hides the real slide.
  // Escaping it to "<\/script" is inert inside JS strings/comments/regex.
  out = await replaceAsync(out, /<script[^>]+src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, async (tag, src) => {
    if (/^https?:/.test(src)) return ''
    const js = await ctx.readText(resolve(src))
    return js != null ? `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>` : ''
  })
  // img/src + inline url(...) asset references → data URLs
  out = await replaceAsync(out, /(src|href)=["']([^"']+\.(?:svg|png|jpe?g|gif|webp))["']/gi, async (m, attr, ref) => {
    if (/^(https?:|data:)/.test(ref)) return m
    const url = await ctx.readDataUrl(resolve(ref))
    return url ? `${attr}="${url}"` : m
  })
  out = await replaceAsync(out, /url\((['"]?)([^'")]+\.(?:svg|png|jpe?g|gif|webp|ttf|otf|woff2?))\1\)/gi, async (m, q, ref) => {
    if (/^(https?:|data:)/.test(ref)) return m
    const url = await ctx.readDataUrl(resolve(ref))
    return url ? `url(${url})` : m
  })
  return out
}

async function replaceAsync(str, re, fn) {
  const jobs = []
  str.replace(re, (...args) => {
    jobs.push(fn(...args.slice(0, -2)))
    return ''
  })
  const results = await Promise.all(jobs)
  let i = 0
  return str.replace(re, () => results[i++])
}

// ---- main -------------------------------------------------------------------

let dsAssetCounter = 0
const nextId = (prefix) => `${prefix}_ds_${++dsAssetCounter}`

/**
 * Parses a design-system bundle into a deck-template patch (same shape the
 * pptx miner produces, plus the bundle-only fields: readme/brandRules/
 * palette/fontAssets/dsCards and iconAssets kinds illustration/background/
 * lockup). Pure: `entries` come from entriesFromZip/entriesFromFileList.
 */
export async function importDesignSystemBundle(entries, { onProgress, downscaleImage = browserDownscale } = {}) {
  const byPath = new Map(entries.map((e) => [e.path, e]))
  const readText = async (p) => {
    try {
      return byPath.has(p) ? await byPath.get(p).text() : null
    } catch {
      return null
    }
  }
  const dataUrlCache = new Map()
  const readDataUrl = async (p) => {
    if (!byPath.has(p)) return null
    if (!dataUrlCache.has(p)) dataUrlCache.set(p, await toDataUrl(byPath.get(p)))
    return dataUrlCache.get(p)
  }
  const progress = (msg) => onProgress?.(msg)

  // import report: everything the classifier decided, so the review form can
  // show the user exactly what entered, what was skipped (and why), and which
  // files fell into the generic-'image' catch-all (the usual sign of a
  // misnamed asset). Never persisted — stripped before POST/PATCH.
  const report = {
    manifestFound: false,
    manifestError: '',
    paletteSource: 'none',
    paletteCount: 0,
    fontCount: 0,
    fontsSkipped: [],
    readmeFound: false,
    readmeChars: 0,
    brandRulesChars: 0,
    cardCount: 0,
    cardsSkipped: [],
    counts: null,
    catchAllImages: [],
    skippedAssets: [],
  }

  // manifest + tokens css
  let manifest = null
  try {
    const raw = await readText('_ds_manifest.json')
    if (raw) manifest = JSON.parse(raw)
    report.manifestFound = !!manifest
  } catch (e) {
    manifest = null
    report.manifestError = e.message || 'JSON inválido'
  }
  const cssPaths = manifest?.globalCssPaths?.length ? manifest.globalCssPaths : ['colors_and_type.css']
  const cssByPath = new Map()
  for (const p of cssPaths) {
    const css = await readText(p)
    if (css != null) cssByPath.set(p, css)
  }
  const cssAll = Array.from(cssByPath.values()).join('\n')

  progress('Lendo paleta e tokens…')
  let palette = paletteFromManifest(manifest)
  report.paletteSource = palette.length ? 'manifest' : 'css'
  if (!palette.length) palette = paletteFromCss(cssAll)
  if (!palette.length) report.paletteSource = 'none'
  // dedupe by varName keeping first
  const seenVar = new Set()
  palette = palette.filter((t) => (seenVar.has(t.varName) ? false : (seenVar.add(t.varName), true))).slice(0, 64)
  const themeColors = pickThemeColors(palette)

  // fonts: manifest entries win (they carry family/weight/style), css @font-face fallback
  progress('Carregando fontes…')
  const fontAssets = []
  const manifestFonts = manifest?.fonts || []
  for (const f of manifestFonts.slice(0, 16)) {
    const file = f.files?.[0]
    if (!file || !byPath.has(file)) {
      if (file) report.fontsSkipped.push({ path: file, reason: 'arquivo não encontrado no bundle' })
      continue
    }
    const url = await readDataUrl(file)
    if (!url || url.length > 1_500_000) {
      report.fontsSkipped.push({ path: file, reason: 'acima de 1.5MB' })
      continue
    }
    fontAssets.push({ family: f.family, weight: String(f.weight || '400'), style: f.style || 'normal', dataUrl: url })
  }
  if (!fontAssets.length) {
    const faceRe = /@font-face\s*{[^}]*font-family\s*:\s*['"]?([^'";]+)['"]?[^}]*font-weight\s*:\s*(\d+)[^}]*src\s*:\s*url\(['"]?([^'")]+)['"]?\)[^}]*}/gi
    let m
    while ((m = faceRe.exec(cssAll)) && fontAssets.length < 16) {
      const url = await readDataUrl(m[3])
      if (url && url.length <= 1_500_000) fontAssets.push({ family: m[1].trim(), weight: m[2], style: /italic/i.test(m[0]) ? 'italic' : 'normal', dataUrl: url })
    }
  }
  const brandFamilies = (manifest?.brandFonts || []).map((f) => f.family).filter(Boolean)
  const mainFamily = brandFamilies[0] || fontAssets[0]?.family || ''

  // readme
  const readme = ((await readText('README.md')) || '').slice(0, 60_000)
  const brandRules = condenseReadme(readme)

  // brand assets
  progress('Importando assets de marca…')
  const assetPaths = entries.filter((e) => e.path.startsWith('assets/')).map((e) => e.path)
  const counts = { icon: 0, lockup: 0, illustration: 0, background: 0, image: 0 }
  const iconAssets = []
  let logoDataUrl = ''
  let logoLightDataUrl = ''
  // main logo detection (brand-level, not product lockups)
  const logoCandidates = assetPaths
    .filter((p) => /(^|\/)(?:[\w-]*-)?(logo|symbol)[\w-]*\.(svg|png)$/i.test(p) && !/lockup/.test(p))
    // horizontal lockup beats stacked/mono/symbol-only when both exist
    .sort((a, b) => /stacked|mono|symbol/.test(a) - /stacked|mono|symbol/.test(b))
  const preferLogo = (re) => logoCandidates.find((p) => re.test(p.split('/').pop()))
  const whiteLogo = preferLogo(/logo[\w-]*white(?!-mono)/i) || preferLogo(/white/i)
  const colorLogo = preferLogo(/full-color(?!-white)/i) || logoCandidates[0]
  if (whiteLogo) logoDataUrl = (await readDataUrl(whiteLogo)) || ''
  if (colorLogo) logoLightDataUrl = (await readDataUrl(colorLogo)) || ''
  if (!logoDataUrl) logoDataUrl = logoLightDataUrl

  for (const path of assetPaths) {
    const file = path.split('/').pop()
    if (path === whiteLogo || path === colorLogo) continue
    const kind = classifyBrandAsset(path)
    if (!kind) {
      report.skippedAssets.push({ path, reason: 'extensão não suportada' })
      continue
    }
    if (!isPrimaryVariant(file, kind)) {
      report.skippedAssets.push({ path, reason: 'variante secundária (-alt/-container/-white)' })
      continue
    }
    if (counts[kind] >= ASSET_CAPS[kind]) {
      report.skippedAssets.push({ path, reason: `acima do limite de ${ASSET_CAPS[kind]} por tipo (${kind})` })
      continue
    }
    let url = await readDataUrl(path)
    if (!url) continue
    // heavy raster backgrounds/photos → downscaled JPEG (see BACKGROUND_MAX_W)
    if ((kind === 'background' || kind === 'image') && url.length > DOWNSCALE_OVER_B64 && !url.startsWith('data:image/svg') && downscaleImage) {
      url = (await downscaleImage(url)) || url
    }
    if (url.length > ASSET_MAX_B64[kind]) {
      report.skippedAssets.push({ path, reason: 'arquivo grande demais para o tipo' })
      continue
    }
    counts[kind]++
    // 'image' is the catch-all for names no regex recognized — surface these
    // by name so a misnamed icon/background is one glance away from the fix
    if (kind === 'image') report.catchAllImages.push(file)
    iconAssets.push({ id: nextId(kind), kind, label: labelFor(file, kind), dataUrl: url, sourcePath: path })
  }

  // specimen cards (viewer): manifest groups + templates
  progress('Preparando cartões do design system…')
  const ctx = { cssByPath, readText, readDataUrl }
  const dsCards = []
  let cardsBudget = CARDS_TOTAL_BUDGET
  const pushCard = async (group, title, path, description = '') => {
    if (cardsBudget <= 0) {
      report.cardsSkipped.push({ path, reason: 'orçamento total de cartões esgotado (9MB)' })
      return
    }
    const raw = await readText(path)
    if (raw == null) {
      report.cardsSkipped.push({ path, reason: 'arquivo não encontrado no bundle' })
      return
    }
    let html
    try {
      html = await inlineCardHtml(raw, path, ctx)
    } catch {
      report.cardsSkipped.push({ path, reason: 'falha ao processar o HTML' })
      return
    }
    if (html.length > CARD_MAX_HTML || html.length > cardsBudget) {
      report.cardsSkipped.push({ path, reason: 'cartão acima de 600KB (após inline dos assets)' })
      return
    }
    cardsBudget -= html.length
    dsCards.push({ id: nextId('card'), group, title, description, html })
  }
  for (const card of manifest?.cards || []) {
    const title = humanize(card.path.split('/').pop())
    await pushCard(card.group || 'Outros', title, card.path)
  }
  for (const tpl of manifest?.templates || []) {
    if (tpl.entryPath) await pushCard('Templates', tpl.name || humanize(tpl.folder || tpl.entryPath), tpl.entryPath, tpl.description || '')
  }

  const name = manifest?.namespace
    ? humanize(manifest.namespace.replace(/_[0-9a-f]{4,}$/i, ''))
    : humanize((entries[0]?.path.split('/')[0] || 'Design System'))

  report.paletteCount = palette.length
  report.fontCount = fontAssets.length
  report.readmeFound = !!readme
  report.readmeChars = readme.length
  report.brandRulesChars = brandRules.length
  report.cardCount = dsCards.length
  report.counts = counts

  return {
    _importReport: report,
    name,
    ...(themeColors.background ? { backgroundColor: themeColors.background } : {}),
    ...(themeColors.primary ? { primaryColor: themeColors.primary } : {}),
    ...(themeColors.accent ? { accentColor: themeColors.accent } : {}),
    ...(themeColors.secondary ? { secondaryColor: themeColors.secondary } : {}),
    ...(mainFamily ? { headingFont: mainFamily, bodyFont: mainFamily } : {}),
    logoDataUrl,
    logoLightDataUrl,
    readme,
    brandRules,
    palette,
    fontAssets,
    dsCards,
    iconAssets,
    styleNotes: '',
  }
}
