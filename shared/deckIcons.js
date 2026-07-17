// Built-in neutral concept icons for decks (gap analysis §4.3) — the third
// fallback layer between "real template icon" and "no icon at all". Shared by
// the pptx renderer (server/decks.js) and the React preview
// (DeckSlidePreview.jsx) so both draw the exact same geometry.
//
// Each icon is a list of SVG path `d` strings on a 24×24 grid, drawn as
// 2px-stroke line art (no fills) — deliberately generic and geometric so they
// inherit any brand's accent color without fighting it. Never emoji.
//
// The hand-drawn set below is complemented by a much larger curated Lucide
// subset (same 24×24 stroke-2 grammar, ISC license) generated into
// deckIconsLucide.js by scripts/gen-lucide-icons.mjs — merged at the bottom;
// on a name clash the hand-drawn version wins so existing decks never change.
import { LUCIDE_DECK_ICONS } from './deckIconsLucide.js'

const BASE_DECK_ICONS = {
  growth: ['M3 17 L9 11 L13 15 L21 7', 'M15 7 L21 7 L21 13'],
  decline: ['M3 7 L9 13 L13 9 L21 17', 'M15 17 L21 17 L21 11'],
  money: ['M3 7 L21 7 L21 17 L3 17 Z', 'M12 9.5 a2.5 2.5 0 1 0 0 5 a2.5 2.5 0 1 0 0 -5'],
  time: ['M12 3 a9 9 0 1 0 0 18 a9 9 0 1 0 0 -18', 'M12 7 L12 12 L15 14'],
  shield: ['M12 3 L20 6 L20 11 C20 16 16.5 19.5 12 21 C7.5 19.5 4 16 4 11 L4 6 Z'],
  lock: ['M5 11 L19 11 L19 21 L5 21 Z', 'M8 11 L8 7 a4 4 0 0 1 8 0 L16 11'],
  gear: [
    'M12 9 a3 3 0 1 0 0 6 a3 3 0 1 0 0 -6',
    'M12 2 L12 5', 'M12 19 L12 22', 'M2 12 L5 12', 'M19 12 L22 12',
    'M4.9 4.9 L7 7', 'M17 17 L19.1 19.1', 'M19.1 4.9 L17 7', 'M7 17 L4.9 19.1',
  ],
  data: ['M4 6 C4 3.8 20 3.8 20 6 L20 18 C20 20.2 4 20.2 4 18 Z', 'M4 6 C4 8.2 20 8.2 20 6', 'M4 12 C4 14.2 20 14.2 20 12'],
  cloud: ['M7 18 L17 18 A4 4 0 0 0 17 10 A5.5 5.5 0 0 0 6.5 11.5 A3.5 3.5 0 0 0 7 18 Z'],
  people: [
    'M9 5 a3 3 0 1 0 0 6 a3 3 0 1 0 0 -6',
    'M3 20 C3 16 6.5 14.5 9 14.5 C11.5 14.5 15 16 15 20',
    'M16.5 6.5 a2.5 2.5 0 1 0 0 5 a2.5 2.5 0 1 0 0 -5',
    'M17.5 14.8 C19.7 15.3 21 16.9 21 19.5',
  ],
  target: ['M12 3 a9 9 0 1 0 0 18 a9 9 0 1 0 0 -18', 'M12 7 a5 5 0 1 0 0 10 a5 5 0 1 0 0 -10', 'M12 11 a1 1 0 1 0 0 2 a1 1 0 1 0 0 -2'],
  risk: ['M12 3 L22 20 L2 20 Z', 'M12 9 L12 14', 'M12 16.5 L12 17'],
  check: ['M12 3 a9 9 0 1 0 0 18 a9 9 0 1 0 0 -18', 'M8 12 L11 15 L16 9'],
  globe: ['M12 3 a9 9 0 1 0 0 18 a9 9 0 1 0 0 -18', 'M3 12 L21 12', 'M12 3 C8.5 7 8.5 17 12 21 C15.5 17 15.5 7 12 3'],
  industry: ['M3 20 L3 8 L9 12 L9 8 L15 12 L15 8 L21 12 L21 20 Z'],
  health: ['M12 20 C5.5 14.5 4 9.5 7 6.8 C9 5.2 11 5.7 12 7.2 C13 5.7 15 5.2 17 6.8 C20 9.5 18.5 14.5 12 20 Z'],
  document: ['M6 2 L14 2 L20 8 L20 22 L6 22 Z', 'M14 2 L14 8 L20 8', 'M9 13 L17 13', 'M9 17 L15 17'],
  connect: ['M6 10 a2.5 2.5 0 1 0 0 5 a2.5 2.5 0 1 0 0 -5', 'M18 10 a2.5 2.5 0 1 0 0 5 a2.5 2.5 0 1 0 0 -5', 'M8.5 12.5 L15.5 12.5'],
  search: ['M11 5 a6 6 0 1 0 0 12 a6 6 0 1 0 0 -12', 'M16 16 L21 21'],
  refresh: ['M20 12 a8 8 0 1 1 -2.7 -6', 'M20 3 L20 8 L15 8'],
  layers: ['M12 3 L22 8 L12 13 L2 8 Z', 'M2 13 L12 18 L22 13'],
  energy: ['M13 2 L4 14 L11 14 L9 22 L20 9 L13 9 Z'],
  calendar: ['M3 6 L21 6 L21 21 L3 21 Z', 'M8 2 L8 6', 'M16 2 L16 6', 'M3 10 L21 10'],
  flag: ['M5 3 L5 21', 'M5 4.5 C9 2.5 12 6.5 19 4.5 L19 12.5 C12 14.5 9 10.5 5 12.5'],
  star: ['M12 3 L14.5 8.8 L20.8 9.3 L16 13.5 L17.6 19.7 L12 16.3 L6.4 19.7 L8 13.5 L3.2 9.3 L9.5 8.8 Z'],
  idea: ['M12 3 A6.2 6.2 0 0 0 8.2 14 C9 14.8 9.2 15.3 9.2 16.2 L14.8 16.2 C14.8 15.3 15 14.8 15.8 14 A6.2 6.2 0 0 0 12 3 Z', 'M9.5 19 L14.5 19', 'M10.5 21.5 L13.5 21.5'],
}

export const DECK_ICONS = { ...LUCIDE_DECK_ICONS, ...BASE_DECK_ICONS }

export const DECK_ICON_NAMES = Object.keys(DECK_ICONS)

// Renders one icon as a standalone SVG string, stroke in the given color —
// used to build data URLs for pptxgenjs and <img>/<svg> previews.
export function deckIconSvg(name, colorHex, strokeWidth = 2) {
  const paths = DECK_ICONS[name]
  if (!paths) return null
  const d = paths.map((p) => `<path d="${p}"/>`).join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${colorHex}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
  )
}
