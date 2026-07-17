#!/usr/bin/env node
// Generates shared/deckIconsLucide.js from the lucide-static package (devDep):
// a curated subset of generic business/tech line icons that complements the
// hand-drawn pictograms in shared/deckIcons.js. Lucide is ISC-licensed (no
// attribution required) and draws 24×24 stroke-2 line art — the exact visual
// grammar the built-in set already uses, so both renderers inherit these
// without any style seam.
//
// Usage: node scripts/gen-lucide-icons.mjs
// Re-run after changing CURATED below or upgrading lucide-static.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ICONS_DIR = join(ROOT, 'node_modules', 'lucide-static', 'icons')
const OUT = join(ROOT, 'shared', 'deckIconsLucide.js')

// Curated by deck-content themes (data/AI, cloud/infra, security, finance,
// people, process, industry, misc). Names are lucide's own kebab-case ids —
// the LLM picks from this exact list in the prompt (server/blocks.js).
const CURATED = [
  // dados & IA
  'brain', 'brain-circuit', 'bot', 'cpu', 'binary', 'code', 'terminal', 'server',
  'hard-drive', 'network', 'workflow', 'git-branch', 'git-merge', 'bug', 'blocks',
  'boxes', 'box', 'package', 'puzzle', 'table', 'layout-dashboard', 'layout-grid',
  'file-text', 'files', 'folder-open', 'archive', 'clipboard-list', 'clipboard-check',
  'book-open', 'library', 'newspaper', 'scan-line', 'qr-code', 'variable', 'sigma',
  // nuvem & conectividade
  'cloud-upload', 'cloud-download', 'plug', 'plug-zap', 'cable', 'wifi', 'radio',
  'satellite', 'link', 'share-2', 'download', 'upload', 'send', 'rss',
  // segurança & governança
  'shield-check', 'shield-alert', 'key', 'key-round', 'fingerprint', 'eye', 'eye-off',
  'badge-check', 'user-check', 'lock-open', 'scale', 'gavel', 'landmark',
  // finanças & negócio
  'banknote', 'coins', 'credit-card', 'wallet', 'piggy-bank', 'receipt', 'calculator',
  'percent', 'trending-up', 'trending-down', 'bar-chart-3', 'line-chart', 'pie-chart',
  'area-chart', 'gauge', 'briefcase', 'handshake', 'circle-dollar-sign', 'shopping-cart',
  'shopping-bag', 'tag', 'tags', 'ticket', 'trophy', 'award', 'medal', 'crown', 'gem', 'gift',
  // pessoas & comunicação
  'users', 'user-plus', 'contact', 'message-square', 'messages-square', 'mail', 'phone',
  'megaphone', 'presentation', 'mic', 'headphones', 'thumbs-up', 'heart-handshake', 'smile',
  'building', 'building-2', 'graduation-cap', 'school',
  // processo & tempo
  'timer', 'hourglass', 'alarm-clock', 'calendar-days', 'calendar-check', 'list-checks',
  'check-circle-2', 'alert-circle', 'info', 'help-circle', 'sliders-horizontal', 'filter',
  'route', 'map', 'map-pin', 'compass', 'navigation', 'milestone', 'signpost', 'crosshair',
  'rocket', 'repeat', 'shuffle', 'split', 'merge', 'move', 'maximize-2', 'goal',
  // indústria & domínios
  'factory', 'store', 'warehouse', 'truck', 'ship', 'plane', 'car', 'tractor', 'wheat',
  'leaf', 'sprout', 'recycle', 'sun', 'zap', 'flame', 'droplet', 'snowflake', 'mountain',
  'anchor', 'hammer', 'wrench', 'hard-hat', 'pill', 'stethoscope', 'syringe', 'ambulance',
  'dna', 'microscope', 'flask-conical', 'test-tube', 'atom', 'lightbulb', 'home',
  // dispositivos & mídia
  'monitor', 'smartphone', 'tablet', 'laptop', 'keyboard', 'tv', 'printer', 'camera',
  'image', 'film', 'music', 'gamepad-2', 'palette', 'paintbrush', 'ruler', 'scissors',
  'utensils', 'coffee', 'dumbbell', 'bike', 'umbrella', 'glasses',
]

const num = (v) => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? +n.toFixed(3) : 0
}

// Lucide draws with primitives; the shared icon model is path-`d`-only, so
// every primitive is converted to equivalent path data (arc-pair circles match
// the hand-drawn set's own idiom).
function elementToPaths(tag, attrs) {
  const a = attrs
  switch (tag) {
    case 'path':
      return a.d ? [a.d] : []
    case 'circle': {
      const cx = num(a.cx), cy = num(a.cy), r = num(a.r)
      return [`M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0`]
    }
    case 'ellipse': {
      const cx = num(a.cx), cy = num(a.cy), rx = num(a.rx), ry = num(a.ry)
      return [`M${cx - rx} ${cy} a${rx} ${ry} 0 1 0 ${2 * rx} 0 a${rx} ${ry} 0 1 0 ${-2 * rx} 0`]
    }
    case 'rect': {
      const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height)
      const rx = Math.min(num(a.rx ?? a.ry ?? 0), w / 2)
      const ry = Math.min(num(a.ry ?? a.rx ?? 0), h / 2)
      if (!rx && !ry) return [`M${x} ${y} L${x + w} ${y} L${x + w} ${y + h} L${x} ${y + h} Z`]
      return [
        `M${x + rx} ${y} L${x + w - rx} ${y} A${rx} ${ry} 0 0 1 ${x + w} ${y + ry} ` +
          `L${x + w} ${y + h - ry} A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} ` +
          `L${x + rx} ${y + h} A${rx} ${ry} 0 0 1 ${x} ${y + h - ry} ` +
          `L${x} ${y + ry} A${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`,
      ]
    }
    case 'line':
      return [`M${num(a.x1)} ${num(a.y1)} L${num(a.x2)} ${num(a.y2)}`]
    case 'polyline':
    case 'polygon': {
      const pts = (a.points || '').trim().split(/[\s,]+/).map(num)
      if (pts.length < 4) return []
      let d = `M${pts[0]} ${pts[1]}`
      for (let i = 2; i < pts.length - 1; i += 2) d += ` L${pts[i]} ${pts[i + 1]}`
      return [tag === 'polygon' ? `${d} Z` : d]
    }
    default:
      return []
  }
}

function svgToPaths(svg) {
  const paths = []
  const re = /<(path|circle|rect|line|polyline|polygon|ellipse)\b([^>]*?)\/?>(?:<\/\1>)?/g
  let m
  while ((m = re.exec(svg))) {
    const attrs = {}
    const attrRe = /([\w-]+)="([^"]*)"/g
    let am
    while ((am = attrRe.exec(m[2]))) attrs[am[1]] = am[2]
    paths.push(...elementToPaths(m[1], attrs))
  }
  return paths
}

const icons = {}
const missing = []
for (const name of CURATED) {
  const file = join(ICONS_DIR, `${name}.svg`)
  if (!existsSync(file)) {
    missing.push(name)
    continue
  }
  const paths = svgToPaths(readFileSync(file, 'utf8'))
  if (paths.length) icons[name] = paths
  else missing.push(name)
}

const body = Object.entries(icons)
  .map(([name, paths]) => `  '${name}': [${paths.map((p) => JSON.stringify(p)).join(', ')}],`)
  .join('\n')

writeFileSync(
  OUT,
  `// GENERATED by scripts/gen-lucide-icons.mjs — do not edit by hand.\n` +
    `// Curated subset of Lucide (https://lucide.dev, ISC license) converted to\n` +
    `// the shared path-\`d\` icon model; merged into DECK_ICONS in deckIcons.js.\n` +
    `export const LUCIDE_DECK_ICONS = {\n${body}\n}\n`
)

console.log(`wrote ${Object.keys(icons).length} icons to shared/deckIconsLucide.js`)
if (missing.length) console.warn(`MISSING in lucide-static (fix CURATED): ${missing.join(', ')}`)
