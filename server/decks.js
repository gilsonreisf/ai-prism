import PptxGenJS from 'pptxgenjs'
import { deckIconSvg } from '../shared/deckIcons.js'
import { resolveDeckTheme, pickDeckIllustration, resolveThemeColor, luminance as themeLuminance, blend as themeBlend, contrastOn, pickLogoForBg } from '../shared/deckTheme.js'

// grid/type-scale/fit math live in shared/deckLayout.js (one source for both
// renderers — see the element-canvas architecture note there)
import {
  SLIDE_W,
  SLIDE_H,
  GRID,
  CONTENT_W,
  TYPE,
  TEXT_INSETS,
  textHeightIn,
  fitFont,
  fitListFont,
  materializeSlide,
  flattenElements,
  ENGINE_LAYOUTS,
} from '../shared/deckLayout.js'

function hex(c, fallback) {
  const v = (c || '').replace('#', '').trim()
  return /^[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : fallback
}

// pptxgenjs's own `sizing: {type:'contain'}` is unreliable for SVG data URIs —
// it frequently stretches the image to the full box, distorting square icons /
// illustrations into tall or wide blobs (the app's <img object-fit:contain>
// does NOT have this problem, so preview and export diverged). So we compute
// the aspect-preserved, centered rectangle OURSELVES from the source's
// intrinsic aspect and hand pptxgenjs exact x/y/w/h — no `sizing` needed.
// Returns null when the intrinsic aspect can't be read (raster w/o dims): the
// caller then falls back to pptxgenjs contain sizing.
function intrinsicAspect(dataUrl) {
  if (typeof dataUrl !== 'string') return null
  // SVG: read viewBox (preferred) or width/height attributes
  if (/^data:image\/svg\+xml/i.test(dataUrl)) {
    try {
      const comma = dataUrl.indexOf(',')
      const body = /;base64/i.test(dataUrl.slice(0, comma))
        ? Buffer.from(dataUrl.slice(comma + 1), 'base64').toString('utf8')
        : decodeURIComponent(dataUrl.slice(comma + 1))
      const svgTag = (body.match(/<svg[^>]*>/i) || [''])[0]
      const vb = svgTag.match(/viewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i)
      if (vb) return Number(vb[1]) / Number(vb[2])
      const w = svgTag.match(/\bwidth\s*=\s*["']?([\d.]+)/i)
      const h = svgTag.match(/\bheight\s*=\s*["']?([\d.]+)/i)
      if (w && h) return Number(w[1]) / Number(h[1])
    } catch {
      // unreadable → fall through
    }
  }
  return null
}

// Given a target box and a source aspect (w/h), returns the largest centered
// sub-rectangle with that aspect that fits inside the box (CSS object-fit:
// contain). Aspect null → returns the box unchanged.
function containRect({ x, y, w, h }, aspect) {
  if (!aspect || !(aspect > 0)) return { x, y, w, h }
  const boxAspect = w / h
  let fw = w
  let fh = h
  if (boxAspect > aspect) fw = h * aspect // box wider than art → limit width
  else fh = w / aspect // box taller than art → limit height
  return { x: x + (w - fw) / 2, y: y + (h - fh) / 2, w: fw, h: fh }
}

// bare-hex adapters over shared/deckTheme.js (pptxgenjs wants no '#')
const stripHash = (v) => (typeof v === 'string' && v[0] === '#' ? v.slice(1) : v)
function luminance(hexColor) {
  return themeLuminance(hexColor)
}
function contrastText(bgHex) {
  return stripHash(contrastOn(bgHex))
}
function blend(a, b, t) {
  return stripHash(themeBlend(a, b, t))
}
function darken(c, t) {
  return blend(c, '000000', t)
}

// Theme resolution lives in shared/deckTheme.js (one source for BOTH
// renderers); this wrapper adapts it to this file's dialect: bare hex
// (no '#'), the pptx-side token names, and the icon lookup map.
function resolveTheme(template) {
  const t = resolveDeckTheme(template)
  const out = { ...t }
  for (const k of [
    'primary', 'secondary', 'accent', 'background', 'onPrimary', 'onAccent', 'onBackground',
    'heading', 'hairline', 'accentSoft', 'cardFill', 'deep', 'onPrimaryMuted', 'onPrimaryFaint',
  ]) {
    out[k] = stripHash(t[k])
  }
  out.bodyTextColor = stripHash(t.bodyText)
  out.mutedTextColor = stripHash(t.muted)
  out.faintTextColor = stripHash(t.faint)
  delete out.bodyText
  delete out.muted
  delete out.faint
  // real icon assets mined from (or manually added to) the template —
  // resolved by id in addIconImage; never a synthesized/emoji fallback
  out.iconById = new Map(((template || {}).iconAssets || []).map((a) => [a.id, a]))
  return out
}

function pickIllustration(theme, seed = 0) {
  return pickDeckIllustration(theme, seed)
}

// The brand art on dark cover/section/closing slides: a real design-system
// illustration when the bundle provides one, else the template's own mined
// motif (never both, never a stock decoration).
function addCoverArt(s, theme, { variant = 'cover', seed = 0 } = {}) {
  // a mined full-bleed plate already carries the brand's art — keep only the
  // template's own motif on top (pre-bundle behavior), never an illustration
  const hasPlate = variant === 'section' ? theme.sectionMaster : theme.coverMaster
  const art = hasPlate ? null : pickIllustration(theme, seed)
  if (!art) {
    addMinedMotif(s, theme)
    return
  }
  const box =
    variant === 'section'
      ? { x: SLIDE_W - 2.55, y: SLIDE_H - 2.5, w: 2.0, h: 2.0 }
      : { x: SLIDE_W - 2.9, y: 0.75, w: 2.25, h: 2.25 }
  try {
    s.addImage({ data: art.dataUrl, ...box, sizing: { type: 'contain', w: box.w, h: box.h } })
  } catch {
    // unsupported data URL — leave the slide clean rather than fail the export
  }
}

// NOTE: never combine pptxgenjs `shadow` on shapes with `fit: 'shrink'` text
// anywhere in the same deck — PowerPoint (macOS) hangs opening the file.
// Cards read as elevated objects via fill + hairline border instead.

// --- server-side text fitting: shared engine (shared/deckLayout.js) ------

function addLogo(slide, theme, opts = {}) {
  // pick the variant that contrasts with the slide bg: dark slides (the cover/
  // closing default) → white lockup; light content slides → full-color lockup.
  // `bg` defaults to theme.primary (the dark master), matching the legacy callers.
  const { x = GRID.margin, y = 0.42, h = 0.34, bg = theme.primary } = opts
  const data = pickLogoForBg(theme, bg)
  if (!data) return
  try {
    slide.addImage({ data, x, y, w: h * 2.6, h, sizing: { type: 'contain', w: h * 2.6, h } })
  } catch {
    // malformed/unsupported data URL — skip the logo rather than fail the export
  }
}

// Renders a real icon asset (see resolveIconAssetId in server/blocks.js) as a
// small image on a soft accent-tinted plate — never emoji. Silently draws
// nothing if the id doesn't resolve (no template, stale id after the user
// edited the template's icon library, etc.) rather than falling back to a
// synthesized glyph.
function addIconImage(s, iconAssetId, x, y, size, theme) {
  const asset = iconAssetId ? theme.iconById.get(iconAssetId) : null
  if (!asset) return false
  const pad = size * 0.18
  s.addShape('roundRect', { x, y, w: size, h: size, rectRadius: size * 0.22, fill: { color: theme.accentSoft } })
  try {
    s.addImage({
      data: asset.dataUrl,
      x: x + pad, y: y + pad, w: size - pad * 2, h: size - pad * 2,
      sizing: { type: 'contain', w: size - pad * 2, h: size - pad * 2 },
    })
  } catch {
    // malformed/unsupported data URL — leave just the plate rather than fail the export
  }
  return true
}

// Neutral built-in concept icon (shared/deckIcons.js) tinted with the theme's
// accent — the fallback when the template has no suitable real icon. Drawn on
// the same soft plate as real icons so both read as one system.
function addBuiltinIcon(s, name, x, y, size, theme) {
  const svg = deckIconSvg(name, '#' + theme.accent)
  if (!svg) return false
  const pad = size * 0.2
  s.addShape('roundRect', { x, y, w: size, h: size, rectRadius: size * 0.22, fill: { color: theme.accentSoft } })
  try {
    s.addImage({
      data: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'),
      x: x + pad, y: y + pad, w: size - pad * 2, h: size - pad * 2,
    })
  } catch {
    // unsupported — leave just the plate
  }
  return true
}

// Fallback chain for any icon-bearing item: real template icon (best) →
// built-in neutral icon (good) → nothing (fine, never emoji).
function addItemIcon(s, item, x, y, size, theme) {
  if (addIconImage(s, item.iconAssetId, x, y, size, theme)) return true
  return item.icon ? addBuiltinIcon(s, item.icon, x, y, size, theme) : false
}

// Per-element style overrides from the Studio's Edit mode (slide.styles[path]
// — validated by sanitizeSlideStyles in server/blocks.js; the preview mirror
// is ovStyle in DeckSlidePreview.jsx). Merged LAST so the user's explicit
// choice beats computed styling; an explicit fontSize also disables the
// fit-shrink belt for that box — the user chose that size deliberately.
function applyOv(opts, slide, path) {
  const o = slide?.styles?.[path]
  if (!o) return opts
  const out = { ...opts }
  if (o.fontSize) {
    out.fontSize = o.fontSize
    delete out.fit
  }
  if (o.color) out.color = o.color.replace('#', '')
  if (o.bold != null) out.bold = o.bold
  if (o.italic != null) out.italic = o.italic
  if (o.align) out.align = o.align
  return out
}

// The template's OWN decorative motif (a dot grid, dash row, etc.), mined as
// a normalized vector spec from the imported .pptx (see mineSlideTheme) and
// re-drawn here at its original slide position. Templates without a mined
// motif get none — never a stock/house decoration.
function addMinedMotif(s, theme) {
  const m = theme.motif
  if (!m?.shapes?.length) return
  const box = {
    x: m.box.x * SLIDE_W,
    y: m.box.y * SLIDE_H,
    w: m.box.w * SLIDE_W,
    h: m.box.h * SLIDE_H,
  }
  const dot = Math.max(m.dotW * SLIDE_W, 0.03)
  const fallback = blend(theme.onPrimary, theme.primary, 0.35)
  for (const sh of m.shapes) {
    s.addShape(m.geom === 'ellipse' ? 'ellipse' : m.geom === 'diamond' ? 'diamond' : 'rect', {
      x: box.x + sh.x * box.w,
      y: box.y + sh.y * box.h,
      w: dot,
      h: dot,
      fill: { color: hex(sh.color, fallback) },
    })
  }
}

// Full-bleed plates live on slide MASTERS (photo + the template's own
// overlay layer + a primary veil for headline contrast) so the multi-MB
// image is embedded once in the file no matter how many covers/dividers use
// it — exactly how a hand-built template ships it. Sections get their own
// distinct plate when one was mined.
function defineBrandMasters(pptx, theme) {
  const veil = (transparency) => ({
    rect: { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, fill: { color: theme.primary, transparency } },
  })
  if (theme.coverPlate) {
    const objects = []
    if (theme.coverOverlay) objects.push({ image: { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, data: theme.coverOverlay } })
    objects.push(veil(theme.coverOverlay ? 55 : 26))
    pptx.defineSlideMaster({ title: 'PRISM_COVER', background: { data: theme.coverPlate }, objects })
    theme.coverMaster = 'PRISM_COVER'
  }
  if (theme.sectionPlate) {
    pptx.defineSlideMaster({ title: 'PRISM_SECTION', background: { data: theme.sectionPlate }, objects: [veil(26)] })
    theme.sectionMaster = 'PRISM_SECTION'
  } else {
    theme.sectionMaster = theme.coverMaster
  }
}

// New dark slide (cover/divider/closing family): on the brand-plate master
// when the template has one, else flat primary.
function addDarkSlide(pptx, theme, kind = 'cover') {
  const master = kind === 'section' ? theme.sectionMaster : theme.coverMaster
  if (master) return pptx.addSlide({ masterName: master })
  const s = pptx.addSlide()
  s.background = { color: theme.primary }
  return s
}

function kickerRow(s, text, theme, { x, y, color, ruleColor, w = CONTENT_W, slide = null, path = 'kicker' }) {
  s.addShape('rect', { x, y: y + 0.075, w: 0.34, h: 0.038, fill: { color: ruleColor } })
  s.addText(
    String(text).toUpperCase(),
    applyOv(
      {
        x: x + 0.44, y: y - 0.06, w: w - 0.44, h: 0.3,
        fontFace: theme.bodyFont, fontSize: TYPE.kicker, bold: true, color, charSpacing: 2.4,
      },
      slide,
      path
    )
  )
}

// Footer meta is the deck's `audience` VERBATIM (the model writes it already
// localized — "Preparado para o C-Level · Grupo Capitale"), never an
// English-hardcoded prefix that would leak into non-English decks.
function footerMeta(deck) {
  return deck.audience || deck.title || ''
}

// Shared slide "chrome" for every content layout (gap analysis §2.1):
// kicker + assertion title + optional subheading + hairline divider on top,
// footnote + footer meta + page number at the bottom, optional dark callout
// band above the footer. Returns the body box every layout should draw in.
function slideChrome(s, slide, theme, deck, ctx) {
  if (slide.notes) s.addNotes(slide.notes)
  let y = GRID.titleY
  if (slide.kicker) {
    kickerRow(s, slide.kicker, theme, { x: GRID.margin, y: GRID.kickerY, color: theme.accent, ruleColor: theme.accent, slide })
  } else {
    y = GRID.kickerY + 0.1
  }
  const titleH = 0.86
  const titleSize = fitFont(slide.heading, CONTENT_W, titleH, TYPE.title * theme.typeScale, { lineSpacing: 1.04, min: 14 })
  s.addText(
    slide.heading || '',
    applyOv(
      {
        x: GRID.margin, y, w: CONTENT_W, h: titleH,
        fontFace: theme.headingFont, fontSize: titleSize, bold: true, color: theme.heading,
        valign: 'top', fit: 'shrink', lineSpacingMultiple: 1.04,
      },
      slide,
      'heading'
    )
  )
  y += titleH
  if (slide.subheading) {
    s.addText(
      slide.subheading,
      applyOv(
        {
          x: GRID.margin, y: y - 0.12, w: CONTENT_W, h: 0.34,
          fontFace: theme.bodyFont, fontSize: fitFont(slide.subheading, CONTENT_W, 0.34, TYPE.subheading, { min: 9 }),
          color: theme.mutedTextColor, valign: 'top', fit: 'shrink',
        },
        slide,
        'subheading'
      )
    )
    y += 0.26
  }
  s.addShape('line', { x: GRID.margin, y: y + 0.02, w: CONTENT_W, h: 0, line: { color: theme.hairline, width: 1 } })

  // footer: meta left, page number right — always the same position/size
  const meta = footerMeta(deck)
  if (meta) {
    s.addText(meta, {
      x: GRID.margin, y: GRID.footerY, w: CONTENT_W - 0.8, h: 0.3,
      fontFace: theme.bodyFont, fontSize: TYPE.footer, color: theme.faintTextColor,
    })
  }
  if (ctx?.index != null) {
    s.addText(String(ctx.index + 1), {
      x: SLIDE_W - GRID.margin - 0.5, y: GRID.footerY, w: 0.5, h: 0.3, align: 'right',
      fontFace: theme.bodyFont, fontSize: TYPE.footer, color: theme.faintTextColor,
    })
  }
  // subtle brand footer logo on content slides (bottom-left, next to the meta):
  // gives the deck brand presence throughout, not just on the cover/closing —
  // the "chrome de marca" gap vs. Claude Design. bg is the light content
  // surface, so pickLogoForBg returns the full-color lockup (never invisible).
  const contentBg = theme.background || '#FFFFFF'
  const footerLogo = pickLogoForBg(theme, contentBg)
  if (footerLogo && !footerMeta(deck)) {
    // only when the footer-left meta slot is free, so we never overlap it
    try {
      const lh = 0.22
      s.addImage({ data: footerLogo, x: GRID.margin, y: GRID.footerY + 0.02, w: lh * 2.6, h: lh, sizing: { type: 'contain', w: lh * 2.6, h: lh } })
    } catch {
      // malformed logo → skip, never fail the export
    }
  }

  let bottom = GRID.bodyBottom
  if (slide.footnote) {
    bottom -= 0.24
    s.addText(slide.footnote, {
      x: GRID.margin, y: bottom + 0.02, w: CONTENT_W, h: 0.24,
      fontFace: theme.bodyFont, fontSize: TYPE.footer, italic: true, color: theme.faintTextColor, valign: 'bottom',
    })
  }
  if (slide.callout?.text) {
    bottom -= GRID.calloutH + 0.12
    drawCallout(s, slide.callout, theme, bottom + 0.12, slide)
  }
  return { top: y + 0.22, bottom, h: bottom - (y + 0.22) }
}

// The "so what" band (strategy-deck insight callout): a dark rounded panel
// with an accent kicker and a single bold takeaway sentence.
function drawCallout(s, callout, theme, y, slide = null) {
  s.addShape('roundRect', { x: GRID.margin, y, w: CONTENT_W, h: GRID.calloutH, rectRadius: 0.06, fill: { color: theme.primary } })
  const hasKicker = !!callout.kicker
  if (hasKicker) {
    s.addText(
      String(callout.kicker).toUpperCase(),
      applyOv(
        {
          x: GRID.margin + 0.24, y: y + 0.08, w: CONTENT_W - 0.48, h: 0.22,
          fontFace: theme.bodyFont, fontSize: 8.5, bold: true, color: theme.accent, charSpacing: 2,
        },
        slide,
        'callout.kicker'
      )
    )
  }
  const boxH = GRID.calloutH - (hasKicker ? 0.34 : 0.14)
  s.addText(
    callout.text,
    applyOv(
      {
        x: GRID.margin + 0.24, y: y + (hasKicker ? 0.28 : 0.06), w: CONTENT_W - 0.48, h: boxH,
        fontFace: theme.headingFont, fontSize: fitFont(callout.text, CONTENT_W - 0.48, boxH, 12.5, { lineSpacing: 1.05, min: 9 }),
        bold: true, color: theme.onPrimary,
        valign: 'middle', fit: 'shrink', lineSpacingMultiple: 1.05,
      },
      slide,
      'callout.text'
    )
  )
}

function coverFooter(s, theme, deck) {
  const meta = [deck.audience || null, deck.author || null].filter(Boolean).join(' · ')
  if (meta) {
    s.addText(meta, {
      x: GRID.margin, y: GRID.footerY, w: CONTENT_W - 1, h: 0.3,
      fontFace: theme.bodyFont, fontSize: TYPE.footer, color: theme.onPrimaryFaint,
    })
  }
  s.addText(String(new Date().getFullYear()), {
    x: SLIDE_W - GRID.margin - 0.8, y: GRID.footerY, w: 0.8, h: 0.3, align: 'right',
    fontFace: theme.bodyFont, fontSize: TYPE.footer, color: theme.onPrimaryFaint,
  })
}

function titleSlide(pptx, theme, deck, slide) {
  const s = addDarkSlide(pptx, theme)
  if (slide.notes) s.addNotes(slide.notes)
  addLogo(s, theme, { y: 0.5, h: 0.4 })
  addCoverArt(s, theme, { variant: 'cover' })
  if (slide.kicker) {
    kickerRow(s, slide.kicker, theme, { x: GRID.margin, y: 1.38, color: theme.accent, ruleColor: theme.accent, w: SLIDE_W - 4, slide })
  }
  // with a bundle illustration on the right, the headline must stop short of
  // the art zone (x ≈ 7.1) — without one it can run wider
  const hasArt = !theme.coverMaster && pickIllustration(theme, 0)
  const coverHeading = slide.heading || deck.title
  const coverW = hasArt ? SLIDE_W - 3.55 : SLIDE_W - 2.2
  s.addText(
    coverHeading,
    applyOv(
      {
        x: GRID.margin, y: 2.55, w: coverW, h: 1.55,
        fontFace: theme.headingFont,
        fontSize: fitFont(coverHeading, coverW, 1.55, TYPE.coverTitle * theme.typeScale, { lineSpacing: 1.02, min: 20, charW: 0.6 }),
        bold: true, color: theme.onPrimary,
        valign: 'bottom', fit: 'shrink', lineSpacingMultiple: 1.02,
      },
      slide,
      'heading'
    )
  )
  if (slide.subheading) {
    s.addText(
      slide.subheading,
      applyOv(
        {
          x: GRID.margin, y: 4.18, w: SLIDE_W - 3, h: 0.72,
          fontFace: theme.bodyFont,
          fontSize: fitFont(slide.subheading, SLIDE_W - 3, 0.72, 13.5, { lineSpacing: 1.15, min: 9 }),
          color: theme.onPrimaryMuted, valign: 'top', fit: 'shrink', lineSpacingMultiple: 1.15,
        },
        slide,
        'subheading'
      )
    )
  }
  coverFooter(s, theme, deck)
}

function sectionSlide(pptx, theme, deck, slide, ctx) {
  const s = addDarkSlide(pptx, theme, 'section')
  if (slide.notes) s.addNotes(slide.notes)
  addCoverArt(s, theme, { variant: 'section', seed: ctx.sectionNo || 0 })
  s.addText(String(ctx.sectionNo).padStart(2, '0'), {
    x: GRID.margin, y: 1.62, w: 2, h: 0.5,
    fontFace: theme.bodyFont, fontSize: 15, bold: true, color: theme.accent, charSpacing: 3,
  })
  const secW = SLIDE_W - 2.6
  const secSize = fitFont(slide.heading, secW, 0.85, TYPE.sectionTitle * theme.typeScale, { lineSpacing: 1.03, min: 18, charW: 0.6 })
  s.addText(
    slide.heading || '',
    applyOv(
      {
        x: GRID.margin, y: 2.15, w: secW, h: 1.15,
        fontFace: theme.headingFont,
        fontSize: secSize,
        bold: true, color: theme.onPrimary,
        valign: 'top', fit: 'shrink', lineSpacingMultiple: 1.03,
      },
      slide,
      'heading'
    )
  )
  if (slide.subheading) {
    // below the heading's REAL wrapped height — a two-line section title must
    // never run into its own subheading (fixed y did exactly that)
    const headH = Math.min(textHeightIn(slide.heading, secSize, secW - TEXT_INSETS, 1.03, 0.6), 1.15)
    s.addText(
      slide.subheading,
      applyOv(
        {
          x: GRID.margin, y: 2.15 + headH + 0.12, w: SLIDE_W - 3.4, h: 0.7,
          fontFace: theme.bodyFont, fontSize: 12.5, color: theme.onPrimaryMuted, valign: 'top', fit: 'shrink', lineSpacingMultiple: 1.15,
        },
        slide,
        'subheading'
      )
    )
  }
  if (ctx?.index != null) {
    s.addText(String(ctx.index + 1), {
      x: SLIDE_W - GRID.margin - 0.5, y: GRID.footerY, w: 0.5, h: 0.3, align: 'right',
      fontFace: theme.bodyFont, fontSize: TYPE.footer, color: theme.onPrimaryFaint,
    })
  }
}

function closingSlide(pptx, theme, deck, slide) {
  const s = addDarkSlide(pptx, theme)
  if (slide.notes) s.addNotes(slide.notes)
  addLogo(s, theme, { y: 0.5, h: 0.4 })
  // closing stays clean when the bundle has real illustrations (the
  // benchmark "thank you" is deliberately restrained) — mined-motif
  // templates keep their motif for continuity with cover/sections
  if (!theme.illustrations.length) addMinedMotif(s, theme)
  s.addShape('rect', { x: GRID.margin, y: 1.98, w: 0.5, h: 0.05, fill: { color: theme.accent } })
  const closeHeading = slide.heading || 'Obrigado'
  const closeW = SLIDE_W - 2.2
  const closeSize = fitFont(closeHeading, closeW, 1.2, 30 * theme.typeScale, { lineSpacing: 1.03, min: 18, charW: 0.6 })
  s.addText(
    closeHeading,
    applyOv(
      {
        x: GRID.margin, y: 2.2, w: closeW, h: 1.2,
        fontFace: theme.headingFont,
        fontSize: closeSize,
        bold: true, color: theme.onPrimary,
        valign: 'top', fit: 'shrink', lineSpacingMultiple: 1.03,
      },
      slide,
      'heading'
    )
  )
  if (slide.subheading || slide.body) {
    // same wrapped-height guard as sectionSlide — long call-to-action
    // headlines were overlapping this block at the old fixed y
    const headH = Math.min(textHeightIn(closeHeading, closeSize, closeW - TEXT_INSETS, 1.03, 0.6), 1.4)
    s.addText(
      slide.subheading || slide.body,
      applyOv(
        {
          x: GRID.margin, y: Math.max(3.4, 2.2 + headH + 0.18), w: SLIDE_W - 3.2, h: 0.9,
          fontFace: theme.bodyFont, fontSize: 13, color: theme.onPrimaryMuted, valign: 'top', fit: 'shrink', lineSpacingMultiple: 1.15,
        },
        slide,
        slide.subheading ? 'subheading' : 'body'
      )
    )
  }
  coverFooter(s, theme, deck)
}

function quoteSlide(pptx, theme, deck, slide, ctx) {
  const s = pptx.addSlide()
  if (slide.notes) s.addNotes(slide.notes)
  s.background = { color: theme.deep }
  const onDeep = contrastText(theme.deep)
  s.addText('“', {
    x: GRID.margin - 0.08, y: 0.75, w: 1.6, h: 1.2,
    fontFace: theme.headingFont, fontSize: 76, bold: true, color: theme.accent,
  })
  const quoteText = slide.body || slide.subheading || ''
  s.addText(quoteText, {
    x: GRID.margin + 0.25, y: 1.7, w: SLIDE_W - 2.6, h: 2.1,
    fontFace: theme.headingFont,
    fontSize: fitFont(quoteText, SLIDE_W - 2.6, 2.1, 21, { lineSpacing: 1.2, min: 12 }),
    color: onDeep, valign: 'middle', fit: 'shrink', lineSpacingMultiple: 1.2,
  })
  if (slide.heading) {
    s.addShape('rect', { x: GRID.margin + 0.25, y: 4.1, w: 0.34, h: 0.035, fill: { color: theme.accent } })
    s.addText(String(slide.heading).toUpperCase(), {
      x: GRID.margin + 0.72, y: 3.95, w: SLIDE_W - 3, h: 0.35,
      fontFace: theme.bodyFont, fontSize: 10, bold: true, color: blend(onDeep, theme.deep, 0.3), charSpacing: 2,
    })
  }
}

// `slide`/`pathBase` wire the Studio's per-element overrides into individual
// bullet paragraphs ("bullets[2]", "leftBullets[0]", …) — see applyOv.
function bulletsBody(bullets, theme, size = TYPE.body, slide = null, pathBase = 'bullets', offset = 0) {
  return (bullets || []).map((b, i) => ({
    text: b,
    options: applyOv(
      {
        bullet: { code: '2022', indent: 16 },
        color: theme.bodyTextColor, fontFace: theme.bodyFont, fontSize: size,
        breakLine: true, paraSpaceAfter: Math.max(8, size * 0.85), lineSpacingMultiple: 1.12,
      },
      slide,
      `${pathBase}[${offset + i}]`
    ),
  }))
}

// Preferred size by count, then shrunk further if the estimated wrapped
// height still overflows the box (long bullets, small boxes).
function bulletSize(bullets, boxWIn, boxHIn) {
  const n = (bullets || []).length
  const base = n <= 3 ? 15 : n <= 5 ? TYPE.body : 12
  return fitListFont(bullets || [], boxWIn, boxHIn, base)
}

function bulletsSlide(pptx, theme, deck, slide, ctx) {
  const s = pptx.addSlide()
  s.background = { color: theme.background }
  const box = slideChrome(s, slide, theme, deck, ctx)
  let top = box.top
  if (slide.body) {
    s.addText(
      slide.body,
      applyOv(
        {
          x: GRID.margin, y: top, w: CONTENT_W, h: 0.55,
          fontFace: theme.bodyFont, fontSize: TYPE.body, color: theme.mutedTextColor, fit: 'shrink', lineSpacingMultiple: 1.15,
        },
        slide,
        'body'
      )
    )
    top += 0.68
  }
  if (slide.bullets?.length) {
    const h = Math.max(box.bottom - top, 0.5)
    s.addText(bulletsBody(slide.bullets, theme, bulletSize(slide.bullets, CONTENT_W - 0.16, h), slide), {
      x: GRID.margin + 0.08, y: top, w: CONTENT_W - 0.16, h, valign: 'top', fit: 'shrink',
    })
  }
}

function twoColumnSlide(pptx, theme, deck, slide, ctx) {
  const s = pptx.addSlide()
  s.background = { color: theme.background }
  const box = slideChrome(s, slide, theme, deck, ctx)
  const bullets = slide.bullets || []
  const mid = Math.ceil(bullets.length / 2)
  const colW = (CONTENT_W - GRID.gutter) / 2
  const h = Math.max(box.h, 0.5)
  const size = Math.min(
    bulletSize(bullets.slice(0, mid), colW - 0.16, h),
    bulletSize(bullets.slice(mid), colW - 0.16, h)
  )
  if (bullets.length) {
    s.addText(bulletsBody(bullets.slice(0, mid), theme, size, slide), { x: GRID.margin + 0.08, y: box.top, w: colW - 0.16, h, valign: 'top', fit: 'shrink' })
    s.addText(bulletsBody(bullets.slice(mid), theme, size, slide, 'bullets', mid), { x: GRID.margin + colW + GRID.gutter, y: box.top, w: colW - 0.16, h, valign: 'top', fit: 'shrink' })
  }
  if (slide.body) {
    s.addText(slide.body, {
      x: GRID.margin, y: box.bottom - 0.4, w: CONTENT_W, h: 0.4,
      fontFace: theme.bodyFont, fontSize: TYPE.small, italic: true, color: theme.faintTextColor, valign: 'bottom',
    })
  }
}

// Editorial numbered list (gap analysis §2.3) — agenda/summary/ranked
// takeaways. Items may be plain strings or {title, body} pairs; rows are
// separated by hairlines, numbers set in the accent color.
function agendaSlide(pptx, theme, deck, slide, ctx) {
  const s = pptx.addSlide()
  s.background = { color: theme.background }
  const box = slideChrome(s, { heading: 'Agenda', ...slide }, theme, deck, ctx)
  const items = (slide.items?.length ? slide.items : (slide.bullets || []).map((b) => ({ title: b }))).slice(0, 7)
  const n = Math.max(items.length, 1)
  const rowH = Math.min(0.78, box.h / n)
  items.forEach((item, i) => {
    const y = box.top + i * rowH
    s.addText(String(i + 1).padStart(2, '0'), {
      x: GRID.margin, y, w: 0.55, h: rowH,
      fontFace: theme.headingFont, fontSize: 15, bold: true, color: theme.accent, valign: 'middle', charSpacing: 1,
    })
    const hasBody = !!item.body
    const itemW = CONTENT_W - 0.8
    s.addText(
      item.title || '',
      applyOv(
        {
          x: GRID.margin + 0.72, y: y + (hasBody ? rowH * 0.06 : 0), w: itemW, h: hasBody ? rowH * 0.5 : rowH,
          fontFace: theme.headingFont,
          fontSize: fitFont(item.title, itemW, hasBody ? rowH * 0.5 : rowH, 13.5, { min: 9 }),
          bold: true, color: theme.heading, valign: hasBody ? 'bottom' : 'middle', fit: 'shrink',
        },
        slide,
        `items[${i}].title`
      )
    )
    if (hasBody) {
      s.addText(
        item.body,
        applyOv(
          {
            x: GRID.margin + 0.72, y: y + rowH * 0.56, w: itemW, h: rowH * 0.4,
            fontFace: theme.bodyFont,
            fontSize: fitFont(item.body, itemW, rowH * 0.4, TYPE.small, { min: 8 }),
            color: theme.mutedTextColor, valign: 'top', fit: 'shrink',
          },
          slide,
          `items[${i}].body`
        )
      )
    }
    if (i < items.length - 1) {
      s.addShape('line', { x: GRID.margin + 0.72, y: y + rowH, w: CONTENT_W - 0.8, h: 0, line: { color: theme.hairline, width: 0.75 } })
    }
  })
}

function cardsSlide(pptx, theme, deck, slide, ctx) {
  const s = pptx.addSlide()
  s.background = { color: theme.background }
  const box = slideChrome(s, slide, theme, deck, ctx)
  const cards = (slide.cards || []).slice(0, 6)
  // 3-up reads best for 3/5/6 cards; 2×2 for 4; side-by-side for 2
  const cols = cards.length <= 1 ? 1 : cards.length === 2 || cards.length === 4 ? 2 : 3
  const rows = Math.ceil(cards.length / cols) || 1
  const cardW = (CONTENT_W - GRID.gutter * (cols - 1)) / cols
  const cardH = (box.h - GRID.gutter * (rows - 1)) / rows
  cards.forEach((card, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = GRID.margin + col * (cardW + GRID.gutter)
    const y = box.top + row * (cardH + GRID.gutter)
    s.addShape('roundRect', {
      x, y, w: cardW, h: cardH, rectRadius: 0.07,
      fill: { color: theme.cardFill }, line: { color: theme.hairline, width: 0.75 },
    })
    const pad = 0.22
    const iconSize = Math.min(0.42, cardH * 0.28)
    const hasIcon = addItemIcon(s, card, x + pad, y + pad, iconSize, theme)
    const headingY = hasIcon ? y + pad + iconSize + 0.1 : y + pad
    const innerW = cardW - pad * 2
    // heading height follows its real (estimated) wrapped height so a long
    // heading never overlaps the body text below it
    const headingSize = fitFont(card.heading, innerW, cardH * 0.45, 12.5, { lineSpacing: 1.05, min: 9, charW: 0.58 })
    const headingH = Math.min(textHeightIn(card.heading, headingSize, innerW - 0.19, 1.05, 0.58) + 0.06, cardH * 0.55)
    s.addText(
      card.heading,
      applyOv(
        {
          x: x + pad, y: headingY, w: innerW, h: headingH,
          fontFace: theme.headingFont, fontSize: headingSize, bold: true, color: theme.heading, valign: 'top', fit: 'shrink', lineSpacingMultiple: 1.05,
        },
        slide,
        `cards[${i}].heading`
      )
    )
    if (card.body) {
      const bodyH = Math.max(y + cardH - pad - (headingY + headingH + 0.02), 0.2)
      s.addText(
        card.body,
        applyOv(
          {
            x: x + pad, y: headingY + headingH + 0.02, w: innerW, h: bodyH,
            fontFace: theme.bodyFont,
            fontSize: fitFont(card.body, innerW, bodyH, 10, { lineSpacing: 1.15, min: 7.5 }),
            color: theme.mutedTextColor, valign: 'top', fit: 'shrink', lineSpacingMultiple: 1.15,
          },
          slide,
          `cards[${i}].body`
        )
      )
    }
  })
}

// KPI stat blocks — card surface, accent tick, brand-primary number, muted
// label (the reference deck's KPI pattern; value in accent read as "AI slop").
function statGridSlide(pptx, theme, deck, slide, ctx) {
  const s = pptx.addSlide()
  s.background = { color: theme.background }
  const box = slideChrome(s, slide, theme, deck, ctx)
  const stats = (slide.stats || []).slice(0, 4)
  const cols = Math.max(stats.length, 1)
  const colW = (CONTENT_W - GRID.gutter * (cols - 1)) / cols
  const cardH = Math.min(box.h, 2.1)
  const top = box.top + (box.h - cardH) / 2
  stats.forEach((stat, i) => {
    const x = GRID.margin + i * (colW + GRID.gutter)
    s.addShape('roundRect', {
      x, y: top, w: colW, h: cardH, rectRadius: 0.07,
      fill: { color: theme.cardFill }, line: { color: theme.hairline, width: 0.75 },
    })
    const pad = 0.22
    s.addShape('rect', { x: x + pad, y: top + pad, w: 0.42, h: 0.05, fill: { color: theme.accent } })
    const hasIcon = addItemIcon(s, stat, x + colW - pad - 0.36, top + pad - 0.06, 0.36, theme)
    // keep the value clear of the icon corner; charW 0.72 on the word check
    // because bold display faces run wide — a KPI value must never break
    // inside a word
    const valueW = colW - pad * 2 - (hasIcon ? 0.34 : 0)
    s.addText(
      stat.value,
      applyOv(
        {
          x: x + pad - 0.02, y: top + pad + 0.14, w: valueW, h: cardH * 0.42,
          fontFace: theme.headingFont,
          fontSize: fitFont(stat.value, valueW, cardH * 0.42, TYPE.statValue, { min: 12, charW: 0.72, fitWord: true }),
          bold: true, color: theme.heading, valign: 'middle', fit: 'shrink',
        },
        slide,
        `stats[${i}].value`
      )
    )
    if (stat.label) {
      const lh = cardH - pad * 2 - 0.14 - cardH * 0.42
      s.addText(
        stat.label,
        applyOv(
          {
            x: x + pad, y: top + pad + 0.2 + cardH * 0.42, w: colW - pad * 2, h: lh,
            fontFace: theme.bodyFont,
            fontSize: fitFont(stat.label, colW - pad * 2, lh, TYPE.small, { lineSpacing: 1.12, min: 8 }),
            color: theme.mutedTextColor, valign: 'top', fit: 'shrink', lineSpacingMultiple: 1.12,
          },
          slide,
          `stats[${i}].label`
        )
      )
    }
  })
}

function comparisonSlide(pptx, theme, deck, slide, ctx) {
  const s = pptx.addSlide()
  s.background = { color: theme.background }
  const box = slideChrome(s, slide, theme, deck, ctx)
  const colW = (CONTENT_W - GRID.gutter) / 2
  const sides = [
    { key: 'left', x: GRID.margin, title: slide.leftTitle, bullets: slide.leftBullets, fill: theme.cardFill, titleColor: theme.mutedTextColor, bar: theme.hairline },
    { key: 'right', x: GRID.margin + colW + GRID.gutter, title: slide.rightTitle, bullets: slide.rightBullets, fill: theme.accentSoft, titleColor: theme.heading, bar: theme.accent },
  ]
  for (const side of sides) {
    s.addShape('roundRect', {
      x: side.x, y: box.top, w: colW, h: box.h, rectRadius: 0.07,
      fill: { color: side.fill }, line: { color: side.bar === theme.accent ? theme.accent : theme.hairline, width: side.bar === theme.accent ? 1 : 0.75 },
    })
    const pad = 0.24
    s.addShape('rect', { x: side.x + pad, y: box.top + pad + 0.02, w: 0.34, h: 0.045, fill: { color: side.bar } })
    s.addText(
      side.title || '',
      applyOv(
        {
          x: side.x + pad + 0.44, y: box.top + pad - 0.12, w: colW - pad * 2 - 0.44, h: 0.32,
          fontFace: theme.headingFont, fontSize: 12.5, bold: true, color: side.titleColor, valign: 'middle', fit: 'shrink',
        },
        slide,
        `${side.key}Title`
      )
    )
    if (side.bullets?.length) {
      const bh = box.h - pad * 2 - 0.3
      s.addText(bulletsBody(side.bullets, theme, fitListFont(side.bullets, colW - pad * 2, bh, 11.5), slide, `${side.key}Bullets`), {
        x: side.x + pad, y: box.top + pad + 0.3, w: colW - pad * 2, h: bh, valign: 'top', fit: 'shrink',
      })
    }
  }
}

function timelineSlide(pptx, theme, deck, slide, ctx) {
  const s = pptx.addSlide()
  s.background = { color: theme.background }
  const box = slideChrome(s, slide, theme, deck, ctx)
  const phases = (slide.phases || []).slice(0, 5)
  const n = Math.max(phases.length, 1)
  const gap = 0.22
  const colW = (CONTENT_W - gap * (n - 1)) / n
  const nodeY = box.top + 0.42
  if (phases.length > 1) {
    s.addShape('line', {
      x: GRID.margin + colW / 2, y: nodeY, w: CONTENT_W - colW, h: 0,
      line: { color: theme.hairline, width: 1.25 },
    })
  }
  phases.forEach((phase, i) => {
    const x = GRID.margin + i * (colW + gap)
    const cx = x + colW / 2
    const nodeR = 0.17
    if (!addItemIcon(s, phase, cx - 0.21, nodeY - 0.21, 0.42, theme)) {
      s.addShape('ellipse', { x: cx - nodeR, y: nodeY - nodeR, w: nodeR * 2, h: nodeR * 2, fill: { color: theme.accent } })
      s.addText(String(i + 1), {
        x: cx - nodeR, y: nodeY - nodeR, w: nodeR * 2, h: nodeR * 2, align: 'center', valign: 'middle',
        fontFace: theme.headingFont, fontSize: 11, bold: true, color: theme.onAccent,
      })
    }
    let y = nodeY + 0.34
    if (phase.period) {
      s.addText(
        String(phase.period).toUpperCase(),
        applyOv(
          {
            x, y, w: colW, h: 0.24, align: 'center',
            fontFace: theme.bodyFont, fontSize: 8.5, bold: true, color: theme.accent, charSpacing: 1.5,
          },
          slide,
          `phases[${i}].period`
        )
      )
      y += 0.26
    }
    s.addText(
      phase.label,
      applyOv(
        {
          x, y, w: colW, h: 0.42, align: 'center',
          fontFace: theme.headingFont, fontSize: 12.5, bold: true, color: theme.heading, valign: 'top', fit: 'shrink',
        },
        slide,
        `phases[${i}].label`
      )
    )
    if (phase.body) {
      const bh = Math.max(box.bottom - (y + 0.44), 0.3)
      s.addText(
        phase.body,
        applyOv(
          {
            x: x + 0.05, y: y + 0.44, w: colW - 0.1, h: bh, align: 'center',
            fontFace: theme.bodyFont,
            fontSize: fitFont(phase.body, colW - 0.1, bh, 9.5, { lineSpacing: 1.15, min: 7.5 }),
            color: theme.mutedTextColor, valign: 'top', fit: 'shrink', lineSpacingMultiple: 1.15,
          },
          slide,
          `phases[${i}].body`
        )
      )
    }
  })
}

// Capability levels for `cellStyle: "level"` tables — Harvey-ball glyphs
// (text, not emoji) so a comparison matrix reads at a glance.
const LEVEL_GLYPHS = { full: '●', partial: '◑', none: '○' }

function tableSlide(pptx, theme, deck, slide, ctx) {
  const s = pptx.addSlide()
  s.background = { color: theme.background }
  const box = slideChrome(s, slide, theme, deck, ctx)
  const columns = slide.columns || []
  if (!columns.length) return
  const highlight = Number.isInteger(slide.highlightColumn) ? slide.highlightColumn : -1
  const isLevel = slide.cellStyle === 'level'
  const headerSize = columns.length >= 6 ? 9 : columns.length >= 4 ? 9.5 : 10.5
  const header = columns.map((c, ci) => ({
    text: c,
    options: {
      bold: true, color: theme.onPrimary, fill: { color: ci === highlight ? theme.accent : theme.primary },
      fontFace: theme.headingFont, fontSize: headerSize, valign: 'middle', align: ci === 0 ? 'left' : 'center',
    },
  }))
  const bodyRows = (slide.rows || []).map((r, ri) =>
    columns.map((_, ci) => {
      const rawCell = Array.isArray(r) ? r[ci] : r?.cells?.[ci]
      const raw = String(rawCell ?? '')
      const glyph = isLevel && ci > 0 ? LEVEL_GLYPHS[raw.trim().toLowerCase()] : null
      return {
        text: glyph || raw,
        options: {
          color: glyph ? (raw.trim().toLowerCase() === 'none' ? theme.faintTextColor : theme.accent) : ci === 0 ? theme.heading : theme.bodyTextColor,
          bold: ci === 0,
          fontFace: theme.bodyFont,
          fontSize: glyph ? 15 : 10,
          valign: 'middle',
          align: ci === 0 ? 'left' : 'center',
          fill: { color: ci === highlight ? theme.accentSoft : ri % 2 ? (theme.cardFill === 'FFFFFF' ? blend('000000', theme.background, 0.985) : theme.cardFill) : theme.background },
        },
      }
    })
  )
  const nRows = bodyRows.length + 1
  const rowH = Math.min(0.5, Math.max(0.3, box.h / nRows))
  const firstColW = Math.min(3.2, CONTENT_W * 0.32)
  const otherW = (CONTENT_W - firstColW) / Math.max(columns.length - 1, 1)
  s.addTable([header, ...bodyRows], {
    x: GRID.margin, y: box.top, w: CONTENT_W, rowH, autoPage: false,
    colW: [firstColW, ...Array(Math.max(columns.length - 1, 0)).fill(otherW)],
    border: { type: 'solid', color: theme.hairline, pt: 0.5 },
    margin: [0.04, 0.08, 0.04, 0.08],
  })
}

const CHART_EXTRA = ['618794', '00A972', 'FFAB00', '98102A']

function chartSlide(pptx, theme, deck, slide, ctx) {
  const s = pptx.addSlide()
  s.background = { color: theme.background }
  const box = slideChrome(s, slide, theme, deck, ctx)
  if (!slide.chartType || !slide.series?.length) {
    s.addText('Gráfico indisponível', {
      x: GRID.margin, y: box.top + box.h / 2 - 0.3, w: CONTENT_W, h: 0.6, align: 'center',
      color: theme.faintTextColor, fontFace: theme.bodyFont, fontSize: 13,
    })
    return
  }
  const chartType = pptx.ChartType[slide.chartType] || pptx.ChartType.bar
  const data = slide.series.map((ser) => ({
    name: ser.name,
    labels: ser.data.map((d) => d.label),
    values: ser.data.map((d) => d.value),
  }))
  s.addChart(chartType, data, {
    x: GRID.margin, y: box.top + 0.05, w: CONTENT_W, h: box.h - 0.1,
    showTitle: false, showLegend: data.length > 1, legendPos: 'b', legendColor: theme.mutedTextColor, legendFontSize: 9,
    chartColors: [theme.accent, theme.primary, theme.secondary, ...CHART_EXTRA],
    chartColorsOpacity: 100,
    catAxisLabelColor: theme.mutedTextColor, catAxisLabelFontSize: 9, catAxisLineColor: theme.hairline,
    valAxisLabelColor: theme.faintTextColor, valAxisLabelFontSize: 8.5, valAxisLineShow: false,
    valGridLine: { color: theme.hairline, style: 'solid', size: 0.5 },
    catGridLine: { style: 'none' },
    dataLabelColor: theme.mutedTextColor, dataLabelFontSize: 8.5,
    barGapWidthPct: 60,
  })
}

// Re-draws a mined vector diagram spec (see mineSlideDiagram in
// DeckTemplatesSettings.jsx / sanitizeDiagramSpec in server/blocks.js) inside
// a content box: the template's own architecture/flow art, scaled to fit and
// re-typeset with the theme's fonts. Colors stay the mined originals — they
// ARE the design system — with theme fallbacks only where mining found none.
// The mined art was drawn against ITS slide's background; on a template whose
// background sits close to the spec's dominant fills, shapes would melt away.
// When that happens, a plate approximating the background the art was
// designed on (dark fills → light plate, light fills → dark plate) goes
// behind it. Returns null when the diagram already reads fine. Mirrored by
// diagramPlateColor in DeckSlidePreview.jsx — keep the math in sync.
export function diagramPlateColor(spec, backgroundHex) {
  const bg = luminance(backgroundHex)
  const fills = (spec.shapes || []).filter((s) => s.color)
  if (!fills.length) return null
  const area = fills.reduce((a, s) => a + s.w * s.h, 0) || 0.0001
  const wavg = (f) => fills.reduce((a, s) => a + f(s) * s.w * s.h, 0) / area
  const meanDistance = wavg((s) => Math.abs(luminance(hex(s.color, backgroundHex)) - bg))
  if (meanDistance >= 0.18) return null
  // best plate: the background the art was actually designed on (mined as
  // spec.bg), as long as it isn't itself close to the deck background
  const designedBg = spec.bg ? hex(spec.bg, null) : null
  if (designedBg && Math.abs(luminance(designedBg) - bg) >= 0.18) return designedBg
  const fillLum = wavg((s) => luminance(hex(s.color, backgroundHex)))
  return fillLum < 0.5 ? blend('FFFFFF', backgroundHex, 0.06) : blend('000000', backgroundHex, 0.82)
}

function drawMinedDiagram(s, spec, box, theme) {
  const aspect = spec.aspect || SLIDE_W / SLIDE_H
  // source canvas nominally 10in wide (fontPt was normalized to that)
  const srcW = 10
  const srcH = srcW / aspect
  const all = [...spec.shapes, ...spec.connectors]
  const minX = Math.min(...all.map((p) => p.x)) * srcW
  const minY = Math.min(...all.map((p) => p.y)) * srcH
  const maxX = Math.max(...all.map((p) => p.x + p.w)) * srcW
  const maxY = Math.max(...all.map((p) => p.y + p.h)) * srcH
  const bw = Math.max(maxX - minX, 0.5)
  const bh = Math.max(maxY - minY, 0.5)
  const k = Math.min(box.w / bw, box.h / bh)
  const ox = box.x + (box.w - bw * k) / 2
  const oy = box.y + (box.h - bh * k) / 2
  const X = (v) => ox + (v * srcW - minX) * k
  const Y = (v) => oy + (v * srcH - minY) * k

  const plate = diagramPlateColor(spec, theme.background)
  if (plate) {
    const pad = 0.16
    s.addShape('roundRect', {
      x: ox - pad, y: oy - pad, w: bw * k + pad * 2, h: bh * k + pad * 2, rectRadius: 0.08,
      fill: { color: plate }, line: { color: theme.hairline, width: 0.75 },
    })
  }

  for (const sh of spec.shapes) {
    const x = X(sh.x)
    const y = Y(sh.y)
    const w = sh.w * srcW * k
    const h = sh.h * srcH * k
    const opts = { x, y, w, h }
    if (sh.rot) opts.rotate = sh.rot
    opts.fill = sh.color ? { color: hex(sh.color, theme.cardFill) } : { color: theme.background, transparency: 100 }
    if (sh.line) opts.line = { color: hex(sh.line, theme.hairline), width: 1 }
    else if (!sh.color) opts.line = { color: theme.hairline, width: 1 }
    try {
      s.addShape(sh.geom, opts)
    } catch {
      s.addShape('rect', opts)
    }
    if (sh.text) {
      const base = Math.max((sh.fontPt || 12) * k, 5)
      const fillHexV = sh.color ? hex(sh.color, theme.cardFill) : plate || theme.background
      const textOpts = {
        x, y, w, h, align: 'center', valign: 'middle',
        fontFace: theme.bodyFont,
        // margin 0 kills PowerPoint's default text insets (diagram chips are
        // tiny — the default 0.1in/side would eat the whole line); fitWord so
        // a mined label ("2013", "Governança") never breaks inside the word
        margin: 0,
        fontSize: fitFont(sh.text, w, h, base, { lineSpacing: 1.05, min: 5, fitWord: true, insets: 0.04 }),
        bold: !!sh.bold,
        color: sh.textColor ? hex(sh.textColor, contrastText(fillHexV)) : contrastText(fillHexV),
        fit: 'shrink', lineSpacingMultiple: 1.05,
      }
      // text rides its shape's rotation (a rotated chip keeps its label aligned)
      if (sh.rot) textOpts.rotate = sh.rot
      s.addText(sh.text, textOpts)
    }
  }
  for (const c of spec.connectors) {
    s.addShape('line', {
      x: X(c.x), y: Y(c.y), w: c.w * srcW * k, h: c.h * srcH * k,
      flipH: !!c.flipH, flipV: !!c.flipV,
      line: {
        color: hex(c.color, theme.mutedTextColor), width: Math.max(1, 1.25 * k),
        ...(c.arrow ? { endArrowType: 'triangle' } : {}),
      },
    })
  }
}

function imageSlide(pptx, theme, deck, slide, ctx) {
  const s = pptx.addSlide()
  s.background = { color: theme.background }
  const box = slideChrome(s, slide, theme, deck, ctx)
  // a user-uploaded image (Studio) always wins over a baked mined diagram
  if (!slide.imageDataUrl && slide.diagramSpec?.shapes?.length) {
    drawMinedDiagram(s, slide.diagramSpec, { x: GRID.margin + 0.1, y: box.top, w: CONTENT_W - 0.2, h: box.h }, theme)
    return
  }
  let placed = false
  if (slide.imageDataUrl) {
    try {
      s.addImage({ data: slide.imageDataUrl, x: GRID.margin + 0.2, y: box.top, w: CONTENT_W - 0.4, h: box.h, sizing: { type: 'contain', w: CONTENT_W - 0.4, h: box.h } })
      placed = true
    } catch {
      // malformed/unsupported data URL — fall through to the placeholder below
    }
  }
  if (!placed) {
    s.addShape('roundRect', { x: GRID.margin + 0.2, y: box.top, w: CONTENT_W - 0.4, h: box.h, rectRadius: 0.07, fill: { color: theme.background, transparency: 100 }, line: { color: theme.hairline, width: 1, dashType: 'dash' } })
    s.addText(slide.body || 'Imagem a adicionar no Estúdio de Slides', {
      x: GRID.margin + 0.4, y: box.top, w: CONTENT_W - 0.8, h: box.h, align: 'center', valign: 'middle',
      fontFace: theme.bodyFont, fontSize: 12, italic: true, color: theme.faintTextColor,
    })
  }
}

// Architecture/flow diagram (gap analysis §3.1): labeled columns of chips
// with an optional emphasized platform panel of stacked bands, connected by
// accent arrows. Entirely generic — nothing here assumes any specific
// product or medallion naming.
function diagramSlide(pptx, theme, deck, slide, ctx) {
  const s = pptx.addSlide()
  s.background = { color: theme.background }
  const box = slideChrome(s, slide, theme, deck, ctx)
  const columns = (slide.columns || []).slice(0, 4)
  if (!columns.length) return
  const arrowW = 0.3
  const weights = columns.map((c) => (c.emphasis ? 1.9 : 1))
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const availW = CONTENT_W - arrowW * (columns.length - 1)
  const labelH = 0.3
  let x = GRID.margin
  const colBoxes = []
  columns.forEach((col, i) => {
    const w = (availW * weights[i]) / totalWeight
    colBoxes.push({ x, w })
    s.addText(String(col.label || '').toUpperCase(), {
      x, y: box.top, w, h: labelH, align: 'center',
      fontFace: theme.bodyFont, fontSize: 8.5, bold: true, color: theme.mutedTextColor, charSpacing: 1.8, valign: 'middle',
    })
    const areaTop = box.top + labelH + 0.08
    const areaH = box.h - labelH - 0.08
    if (col.emphasis || col.bands?.length) {
      // emphasized platform panel with stacked bands
      s.addShape('roundRect', {
        x, y: areaTop, w, h: areaH, rectRadius: 0.08,
        fill: { color: theme.primary },
      })
      const bands = (col.bands || []).slice(0, 5)
      const pad = 0.14
      if (col.sublabel) {
        s.addText(col.sublabel, {
          x: x + pad, y: areaTop + 0.06, w: w - pad * 2, h: 0.26, align: 'center',
          fontFace: theme.bodyFont, fontSize: 8.5, color: theme.onPrimaryMuted, valign: 'middle', fit: 'shrink',
        })
      }
      const bandsTop = areaTop + pad + (col.sublabel ? 0.28 : 0.06)
      const bandsH = areaH - (bandsTop - areaTop) - pad
      const bandGap = 0.1
      const bandH = (bandsH - bandGap * (bands.length - 1)) / Math.max(bands.length, 1)
      bands.forEach((band, bi) => {
        const by = bandsTop + bi * (bandH + bandGap)
        const isAccent = band.tone === 'accent'
        s.addShape('roundRect', {
          x: x + pad, y: by, w: w - pad * 2, h: bandH, rectRadius: 0.05,
          fill: isAccent ? { color: theme.accent } : { color: blend(theme.onPrimary, theme.primary, 0.88) },
        })
        s.addText(band.label || '', {
          x: x + pad + 0.08, y: by, w: w - pad * 2 - 0.16, h: bandH, align: 'center', valign: 'middle',
          fontFace: theme.headingFont, fontSize: 10, bold: true,
          color: isAccent ? theme.onAccent : theme.onPrimary, fit: 'shrink',
        })
      })
    } else {
      // side rail: vertical stack of chips with optional icons
      const items = (col.items || []).slice(0, 6)
      const chipGap = 0.12
      const chipH = Math.min(0.52, (areaH - chipGap * (items.length - 1)) / Math.max(items.length, 1))
      items.forEach((item, ii) => {
        const iy = areaTop + ii * (chipH + chipGap)
        s.addShape('roundRect', {
          x, y: iy, w, h: chipH, rectRadius: 0.05,
          fill: { color: theme.cardFill }, line: { color: theme.hairline, width: 0.75 },
        })
        const iconSize = Math.min(0.3, chipH - 0.14)
        const hasIcon = addItemIcon(s, item, x + 0.1, iy + (chipH - iconSize) / 2, iconSize, theme)
        s.addText(item.label || '', {
          x: x + (hasIcon ? 0.1 + iconSize + 0.08 : 0.12), y: iy, w: w - (hasIcon ? 0.28 + iconSize : 0.24), h: chipH,
          fontFace: theme.bodyFont, fontSize: 9.5, bold: true, color: theme.heading, valign: 'middle', fit: 'shrink', lineSpacingMultiple: 1.0,
        })
      })
    }
    if (i < columns.length - 1) {
      const ay = box.top + labelH + 0.08 + (box.h - labelH - 0.08) / 2
      s.addShape('triangle', {
        x: x + w + 0.07, y: ay - 0.08, w: 0.16, h: 0.16, rotate: 90,
        fill: { color: theme.accent },
      })
    }
    x += w + arrowW
  })
}

// --- freeform (element canvas): dumb painter over shared/deckLayout.js ------
// Elements map 1:1 to native pptxgenjs objects (NEVER rasterized — the
// exported deck stays editable in PowerPoint, a hard requirement). Array
// order = z-order = call order.
const DASH_MAP = { solid: 'solid', dash: 'dash', dot: 'sysDot' }

function elementShadow(st) {
  if (!st.shadow) return undefined
  const sh = st.shadow === true ? {} : st.shadow
  return {
    type: 'outer',
    color: stripHash(sh.color || '#000000'),
    blur: sh.blur ?? 6,
    offset: sh.offset ?? 2,
    angle: 90,
    opacity: (sh.opacity ?? 35) / 100,
  }
}

function elementFill(st, fallback) {
  if (st.fill === 'none') return { color: 'FFFFFF', transparency: 100 }
  const color = stripHash(st.fill) || fallback
  if (!color) return undefined
  return { color, transparency: st.opacity != null ? 100 - st.opacity : 0 }
}

function elementLine(st) {
  if (!st.borderColor || !(st.borderWidth ?? 1)) return undefined
  return { color: stripHash(st.borderColor), width: st.borderWidth ?? 1, dashType: DASH_MAP[st.borderDash] || 'solid' }
}

// Native chart mapping for freeform chart elements (heatmap/gantt never get
// here — flattenElements already expanded them into primitive shapes/text).
// Options mirror chartSlide below so freeform and semantic charts read as one
// system; the palette extras must stay identical to chartPalette in
// shared/deckLayout.js.
const CHART_TYPE_MAP = { bar: 'bar', barH: 'bar', line: 'line', area: 'area', pie: 'pie', doughnut: 'doughnut', scatter: 'scatter' }

function addChartElement(s, el, theme) {
  const c = el.chart || {}
  const type = CHART_TYPE_MAP[c.kind]
  if (!type || !c.series?.length) return
  const { x, y, w, h } = el.box
  const round = c.kind === 'pie' || c.kind === 'doughnut'
  const base = {
    x, y, w, h,
    showTitle: false,
    showLegend: c.showLegend !== false && (round || c.series.length > 1),
    legendPos: 'b', legendColor: theme.mutedTextColor, legendFontSize: 9,
    chartColors: [theme.accent, theme.primary, theme.secondary, ...CHART_EXTRA],
    chartColorsOpacity: 100,
    catAxisLabelColor: theme.mutedTextColor, catAxisLabelFontSize: 9, catAxisLineColor: theme.hairline,
    valAxisLabelColor: theme.faintTextColor, valAxisLabelFontSize: 8.5, valAxisLineShow: false,
    valGridLine: { color: theme.hairline, style: 'solid', size: 0.5 },
    catGridLine: { style: 'none' },
    dataLabelColor: theme.mutedTextColor, dataLabelFontSize: 8.5,
  }
  if (c.showValues) base.showValue = true
  if (c.kind === 'bar' || c.kind === 'barH') base.barGapWidthPct = 60
  if (c.kind === 'barH') base.barDir = 'bar'
  if (c.kind === 'doughnut') base.holeSize = 60
  if (c.kind === 'scatter') {
    // pptxgenjs scatter: first data set = shared X values, the rest = Y series
    const xs = c.series[0]?.points?.map((p) => p.x) || []
    const data = [
      { name: 'X', values: xs },
      ...c.series.map((ser) => ({ name: ser.name, values: (ser.points || []).map((p) => p.y) })),
    ]
    s.addChart('scatter', data, { ...base, lineSize: 0, lineDataSymbol: 'circle', lineDataSymbolSize: 7 })
    return
  }
  const data = c.series.map((ser) => ({
    name: ser.name,
    labels: ser.data.map((d) => d.label),
    values: ser.data.map((d) => d.value),
  }))
  s.addChart(type, data, base)
}

function paintElements(s, elements, theme) {
  for (const el of elements || []) {
    const st = el.style || {}
    const { x, y, w, h } = el.box
    const rotate = el.rotate ? { rotate: el.rotate } : {}
    try {
      if (el.type === 'shape') {
        const geom = el.shape === 'roundRect' || (el.shape === 'rect' && st.radius) ? 'roundRect' : el.shape
        s.addShape(geom, {
          x, y, w, h, ...rotate,
          fill: elementFill(st, theme.accentSoft),
          line: elementLine(st),
          ...(geom === 'roundRect' ? { rectRadius: st.radius ?? 0.08 } : {}),
          shadow: elementShadow(st),
        })
      } else if (el.type === 'text') {
        const text = st.uppercase ? String(el.text || '').toUpperCase() : String(el.text || '')
        const opts = {
          x, y, w, h, ...rotate,
          fontFace: st.fontFamily || (st.fontRole === 'heading' ? theme.headingFont : theme.bodyFont),
          fontSize: st.fontSize || TYPE.body,
          color: stripHash(st.color) || theme.bodyTextColor,
          bold: !!st.bold,
          italic: !!st.italic,
          underline: st.underline ? { style: 'sng' } : undefined,
          align: st.align || 'left',
          valign: st.valign || 'top',
          shadow: elementShadow(st),
        }
        if (st.lineHeight) opts.lineSpacingMultiple = st.lineHeight
        if (st.letterSpacing) opts.charSpacing = st.letterSpacing
        const fill = st.fill && st.fill !== 'none' ? elementFill(st) : undefined
        if (fill) opts.fill = fill
        const line = elementLine(st)
        if (line) opts.line = line
        if ((fill || line) && st.radius) {
          opts.shape = 'roundRect'
          opts.rectRadius = st.radius
        }
        if (st.bullet) {
          // one paragraph per line, in the exact shape bulletsBody() emits for
          // the legacy builders (indent 16 + paraSpaceAfter) — bullet lists
          // render identically whether the slide is semantic or freeform
          const size = st.fontSize || TYPE.body
          const paras = text.split('\n').map((t) => ({
            text: t,
            options: {
              bullet: { code: '2022', indent: 16 },
              color: opts.color,
              fontFace: opts.fontFace,
              fontSize: size,
              ...(st.bold ? { bold: true } : {}),
              ...(st.italic ? { italic: true } : {}),
              breakLine: true,
              paraSpaceAfter: Math.max(8, size * 0.85),
              lineSpacingMultiple: st.lineHeight || 1.12,
            },
          }))
          const boxOpts = { x, y, w, h, ...rotate, valign: opts.valign, shadow: opts.shadow }
          if (fill) boxOpts.fill = fill
          if (line) boxOpts.line = line
          s.addText(paras, boxOpts)
        } else {
          s.addText(text, opts)
        }
      } else if (el.type === 'line') {
        s.addShape('line', {
          x, y, w: Math.max(w, 0.01), h, ...rotate,
          flipH: !!el.flipH, flipV: !!el.flipV,
          line: {
            color: stripHash(st.lineColor) || theme.accent,
            width: st.lineWidth ?? 2,
            dashType: DASH_MAP[st.dash] || 'solid',
            ...(st.arrowStart ? { beginArrowType: 'triangle' } : {}),
            ...(st.arrowEnd ? { endArrowType: 'triangle' } : {}),
          },
        })
      } else if (el.type === 'icon') {
        // canvas icons draw bare by default (the user positions them freely);
        // a fill produces the familiar soft plate behind the glyph
        if (st.fill && st.fill !== 'none') {
          s.addShape('roundRect', { x, y, w, h, rectRadius: st.radius ?? Math.min(w, h) * 0.22, fill: elementFill(st) })
        }
        const asset = el.icon?.assetId ? theme.iconById.get(el.icon.assetId) : null
        // plate insets mirror the legacy icon helpers: 0.18 for real assets
        // (addIconImage), 0.2 for builtin glyphs (addBuiltinIcon)
        const pad = st.fill && st.fill !== 'none' ? Math.min(w, h) * (asset ? 0.18 : 0.2) : 0
        const inner = { x: x + pad, y: y + pad, w: w - pad * 2, h: h - pad * 2 }
        if (asset) {
          const fit = containRect(inner, intrinsicAspect(asset.dataUrl))
          s.addImage({ data: asset.dataUrl, ...fit })
        } else if (el.icon?.builtin) {
          const svg = deckIconSvg(el.icon.builtin, st.color || '#' + theme.accent)
          if (svg) {
            // builtin glyphs are square (24×24 viewBox) — contain to a square
            // inside the box so a non-square icon box never stretches the glyph
            const fit = containRect(inner, 1)
            s.addImage({ data: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), ...fit })
          }
        }
      } else if (el.type === 'image') {
        const data = el.imageDataUrl || (el.imageAssetId ? theme.iconById.get(el.imageAssetId)?.dataUrl : null)
        if (data) {
          // compute the contained rect ourselves (pptxgenjs SVG contain is
          // unreliable); fall back to its sizing only when aspect is unknown
          const aspect = intrinsicAspect(data)
          if (aspect) s.addImage({ data, ...containRect({ x, y, w, h }, aspect), ...rotate })
          else s.addImage({ data, x, y, w, h, ...rotate, sizing: { type: 'contain', w, h } })
        }
      } else if (el.type === 'chart') {
        addChartElement(s, el, theme)
      }
    } catch {
      // one malformed element must never fail the whole export
    }
  }
}

function freeformSlide(pptx, theme, deck, slide, ctx) {
  const bg = slide.background || {}
  let s
  if (bg.plate) {
    s = addDarkSlide(pptx, theme, bg.plate === 'section' ? 'section' : 'cover')
  } else {
    s = pptx.addSlide()
    const bgColor = ctx?.sharedTheme ? resolveThemeColor(ctx.sharedTheme, bg.color) : bg.color
    s.background = { color: stripHash(bgColor) || theme.background }
  }
  // persisted freeform is a TREE (groups/stacks/tokens/charts) — flatten to
  // the absolute list the dumb painter understands (pre-flattened once by
  // renderPptx; the fallback covers direct builder calls)
  const flat = ctx?.flatElements || (ctx?.sharedTheme ? flattenElements(slide.elements, ctx.sharedTheme) : slide.elements)
  paintElements(s, flat, theme)
  if (slide.notes) s.addNotes(slide.notes)
}

// Unified path (renderer unification over the element engine): a semantic
// slide whose materialization is available renders through the same dumb
// painter as freeform slides — one code path, verified XML-identical to the
// legacy builders for the ENGINE_LAYOUTS set.
function engineSlide(pptx, theme, slide, mat) {
  const bg = mat.background || {}
  let s
  if (bg.plate) {
    s = addDarkSlide(pptx, theme, bg.plate === 'section' ? 'section' : 'cover')
  } else {
    s = pptx.addSlide()
    s.background = { color: stripHash(bg.color) || theme.background }
  }
  paintElements(s, mat.elements, theme)
  if (slide.notes) s.addNotes(slide.notes)
}

// ENGINE_LAYOUTS (the set of layouts this export renders through the unified
// engine path vs. the legacy builders below) now lives in shared/deckLayout.js
// so the React preview can gate on the exact same set — re-exported here for
// any existing importers.
export { ENGINE_LAYOUTS }

const BUILDERS = {
  freeform: freeformSlide,
  title: titleSlide,
  section: sectionSlide,
  bullets: bulletsSlide,
  'two-column': twoColumnSlide,
  quote: quoteSlide,
  closing: closingSlide,
  agenda: agendaSlide,
  cards: cardsSlide,
  'stat-grid': statGridSlide,
  comparison: comparisonSlide,
  timeline: timelineSlide,
  table: tableSlide,
  chart: chartSlide,
  image: imageSlide,
  diagram: diagramSlide,
}

// Renders a deck spec (see server/blocks.js sanitizeDeck for shape) into a
// real .pptx file, styled with the user's registered template (or sober
// defaults). The model itself never produces raster images/icons — real
// photos/diagrams come from the user (Estúdio de Slides upload, `image`
// layout), icons come from the template's own mined/uploaded icon library
// (never emoji, see addIconImage), and charts are native pptxgenjs charts
// fed by already-resolved, trustworthy series data (never invented).
// Pure-HTML deck export (task #29): assemble a .pptx of NATIVE, editable shapes
// from paint-ops the client extracted off the rendered DOM (see
// client/lib/domToSlideOps.js). This mirrors how Claude Design exports — every
// element becomes a positioned <p:sp>/text/image, nothing rasterized. Ops carry
// px coords on a 1280×720 stage; we scale to the 10×5.625in canvas.
export function renderPptxFromOps(deck, slides) {
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'PRISM_16x9', width: SLIDE_W, height: SLIDE_H })
  pptx.layout = 'PRISM_16x9'
  pptx.author = 'AI Prism'
  pptx.title = deck?.title || 'Apresentação'

  for (const slide of slides || []) {
    const s = pptx.addSlide()
    const stageW = slide.w || 1280
    const stageH = slide.h || 720
    const kx = SLIDE_W / stageW // px → inches
    const ky = SLIDE_H / stageH
    const IN = (v, k) => Math.round(v * k * 1000) / 1000
    for (const op of slide.ops || []) {
      const x = IN(op.x, kx)
      const y = IN(op.y, ky)
      const w = Math.max(IN(op.w, kx), 0.02)
      const h = Math.max(IN(op.h, ky), 0.02)
      try {
        if (op.type === 'rect') {
          if (!op.fill && !op.line) continue
          const shape = op.radius > 0 ? 'roundRect' : 'rect'
          const opts = { x, y, w, h }
          if (op.fill) opts.fill = { color: op.fill }
          else opts.fill = { type: 'none' }
          if (op.line) opts.line = { color: op.line.color, width: op.line.width }
          if (shape === 'roundRect') opts.rectRadius = Math.min(IN(op.radius, kx), Math.min(w, h) / 2)
          s.addShape(shape, opts)
        } else if (op.type === 'image' && op.dataUrl) {
          // opacity from the DOM extractor → pptxgenjs `transparency` (0..100 %)
          s.addImage({ data: op.dataUrl, x, y, w, h, ...(op.transparency ? { transparency: op.transparency } : {}) })
        } else if (op.type === 'text' && op.runs?.length) {
          const runs = op.runs.map((r) => ({
            text: r.text,
            options: {
              fontFace: r.font || 'Arial',
              fontSize: r.size || 12,
              color: r.color || '000000',
              bold: !!r.bold,
              italic: !!r.italic,
              ...(r.tracking ? { charSpacing: r.tracking } : {}),
            },
          }))
          s.addText(runs, {
            x, y, w, h,
            align: op.align || 'left',
            valign: op.valign || 'top',
            margin: 0,
            lineSpacingMultiple: op.lineHeight || 1.15,
            wrap: true,
          })
        }
      } catch {
        // one malformed op must never abort the whole export
      }
    }
  }
  return pptx.write('nodebuffer')
}

export function renderPptx(deck, template, { engine = true } = {}) {
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'PRISM_16x9', width: SLIDE_W, height: SLIDE_H })
  pptx.layout = 'PRISM_16x9'
  pptx.author = 'AI Prism'
  pptx.title = deck.title

  const theme = resolveTheme(template)
  defineBrandMasters(pptx, theme)

  // Renderer unification: pre-materialize (once — reused by the shadow scan
  // AND the paint loop) every slide the engine path covers. Slides with
  // Studio style overrides stay legacy: per-bullet paths ("bullets[2]") have
  // no element equivalent, so applyOv must keep handling them.
  const sharedTheme = resolveDeckTheme(template)
  const hasStyles = (sl) => !!sl.styles && Object.keys(sl.styles).length > 0
  let matSectionNo = 0
  const mats = deck.slides.map((slide, index) => {
    if (slide.layout === 'section') matSectionNo++
    if (!engine || slide.layout === 'freeform') return null
    if (!ENGINE_LAYOUTS.has(slide.layout) || slide.diagramSpec || hasStyles(slide)) return null
    try {
      return materializeSlide(slide, sharedTheme, {
        index,
        total: deck.slides.length,
        pageNumber: index + 1,
        sectionNo: matSectionNo,
        meta: footerMeta(deck),
        audience: deck.audience || '',
        deckTitle: deck.title,
        author: deck.author || '',
      })
    } catch {
      return null // any engine hiccup falls back to the proven legacy builder
    }
  })

  // freeform slides flatten ONCE here (tree → absolute list, tokens resolved,
  // composed charts expanded) — reused by the shadow scan and the paint loop
  const freeformFlats = deck.slides.map((sl) => {
    if (sl.layout !== 'freeform') return null
    try {
      const bg = sl.background?.plate
        ? sharedTheme.primary
        : resolveThemeColor(sharedTheme, sl.background?.color) || sharedTheme.background
      return flattenElements(sl.elements || [], sharedTheme, { background: bg })
    } catch {
      return sl.elements || []
    }
  })

  // pptxgenjs `shadow` + `fit:'shrink'` ANYWHERE in the same deck hangs
  // PowerPoint on macOS (see the note above the fit-math section). Elements
  // may carry user-chosen shadows (freeform slides today, engine-rendered
  // slides if generators ever emit them), so when any exist the legacy
  // builders' shrink belt is stripped deck-wide — safe, because the engine's
  // computed font sizes are authoritative and shrink is only a belt.
  const deckHasShadow = deck.slides.some((sl, i) =>
    ((freeformFlats[i] || mats[i]?.elements) || []).some((e) => e.style?.shadow)
  )
  if (deckHasShadow) {
    const origAddSlide = pptx.addSlide.bind(pptx)
    pptx.addSlide = (...args) => {
      const s = origAddSlide(...args)
      const origAddText = s.addText.bind(s)
      s.addText = (txt, opts) => {
        if (opts && opts.fit === 'shrink') {
          opts = { ...opts }
          delete opts.fit
        }
        return origAddText(txt, opts)
      }
      return s
    }
  }

  let sectionNo = 0
  deck.slides.forEach((slide, index) => {
    if (slide.layout === 'section') sectionNo++
    if (mats[index]) {
      engineSlide(pptx, theme, slide, mats[index])
      return
    }
    const build = BUILDERS[slide.layout] || BUILDERS.bullets
    build(pptx, theme, deck, slide, {
      index,
      total: deck.slides.length,
      sectionNo,
      sharedTheme,
      flatElements: freeformFlats[index],
    })
  })

  return pptx.write({ outputType: 'nodebuffer' })
}
