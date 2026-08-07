// Shared deck layout engine (element-canvas architecture).
//
// A slide's PERSISTED form stays semantic (layout + fields — cheap for the
// LLM, re-themable forever). At render time `materializeSlide` turns it into
// a flat list of positioned ELEMENTS that both renderers paint dumbly:
// server/decks.js maps element→pptxgenjs (native, editable PPTX — a hard
// requirement), DeckSlidePreview.jsx maps element→absolutely-positioned DOM.
// A slide becomes persisted-freeform (`layout:'freeform'` + `elements[]`)
// only when the user makes a geometric/structural edit in the Studio.
//
// Element shape (validated by sanitizeElements in server/blocks.js):
//   { id, type: 'text'|'shape'|'line'|'icon'|'image'|'chart'|'group',
//     name?,                            // layer name shown in the Studio tree
//     hidden?,                          // visibility toggle (skipped by paint)
//     box: { x, y, w, h },              // inches on the 10 × 5.625 canvas
//     rotate?,                          // degrees
//     style: { ... },                   // '#RRGGBB' or '@themeToken' colors
//     text? | shape? | icon:{assetId?,builtin?} | imageDataUrl?
//     | chart:{kind,…}                  // native pptx chart or composed grid
//     | children:[…] + stack?           // group: children relative to origin;
//                                       // stack = auto-layout (row/column) }
// Array order = z-order = paint order in BOTH renderers. Painters never
// consume the tree directly: `flattenElements` resolves tokens/stacks/groups
// into the flat absolute list they have always painted.
import { hexOr, blend, contrastOn, luminance, pickDeckIllustration, resolveThemeColor } from './deckTheme.js'

export const SLIDE_W = 10
export const SLIDE_H = 5.625

// Named grid (docs/deck-quality-gap-analysis.md §2.5) — every layout derives
// its geometry from these instead of scattering magic numbers.
export const GRID = {
  margin: 0.62,
  gutter: 0.28,
  kickerY: 0.38,
  titleY: 0.66,
  footerY: SLIDE_H - 0.42,
  bodyBottom: SLIDE_H - 0.55,
  calloutH: 0.78,
}
export const CONTENT_W = SLIDE_W - GRID.margin * 2

// Typographic scale (pt) — one scale for the whole deck, tuned to the 16:9
// 10in canvas. Content-slide sizes sit a step below cover/divider sizes.
export const TYPE = {
  coverTitle: 35,
  sectionTitle: 29,
  title: 21,
  kicker: 10,
  subheading: 12.5,
  body: 13,
  small: 10.5,
  caption: 9,
  footer: 8,
  statValue: 28,
}

// --- text fitting -----------------------------------------------------------
// pptxgenjs's `fit:'shrink'` only writes an empty <a:normAutofit/> — the
// FIRST render shows text unscaled. So overflow-prone boxes compute their own
// font size up front with a greedy word-wrap estimate. Because this runs in
// the ENGINE, the DOM preview renders the exact same size the pptx gets.
export const LINE_H = 1.2 // PowerPoint's default line height fraction
export const CHAR_W = 0.5 // average glyph advance as a fraction of font size
// PowerPoint's default text-box insets (lIns/rIns ≈ 0.1in each side)
export const TEXT_INSETS = 0.19

export function estimateLines(text, fontSize, boxWIn, charW = CHAR_W) {
  const perLine = Math.max(Math.floor(boxWIn / ((fontSize / 72) * charW)), 4)
  let lines = 0
  for (const para of String(text || '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    let cur = 0
    lines++
    for (const w of words) {
      const wl = Math.min(w.length, perLine) + 1
      if (cur && cur + wl > perLine) {
        lines++
        cur = wl
      } else cur += wl
    }
  }
  return Math.max(lines, 1)
}

export function textHeightIn(text, fontSize, boxWIn, lineSpacing = 1, charW = CHAR_W) {
  return estimateLines(text, fontSize, boxWIn, charW) * (fontSize / 72) * LINE_H * lineSpacing
}

// Largest font size (from `base`, floored at `min`) whose estimated wrapped
// height fits the box. Bold display faces run wider — pass a higher charW.
// `fitWord` additionally requires the longest word to fit on one line.
export function fitFont(text, boxWIn, boxHIn, base, { lineSpacing = 1, min = 8, charW = CHAR_W, fitWord = false, insets = TEXT_INSETS } = {}) {
  const w = Math.max(boxWIn - insets, 0.1)
  const longestWord = fitWord
    ? Math.max(...String(text || '').split(/\s+/).map((x) => x.length), 1)
    : 0
  for (let size = base; size > min; size -= 0.5) {
    if (fitWord && longestWord * (size / 72) * charW > w) continue
    if (textHeightIn(text, size, w, lineSpacing, charW) <= boxHIn) return size
  }
  return min
}

// Same idea for a bullet list: total height includes per-paragraph spacing.
export function fitListFont(items, boxWIn, boxHIn, base, { lineSpacing = 1.12, min = 9 } = {}) {
  const w = Math.max(boxWIn - TEXT_INSETS, 0.3)
  for (let size = base; size > min; size -= 0.5) {
    let h = 0
    for (const item of items) {
      h += textHeightIn(item, size, w, lineSpacing) + (Math.max(8, size * 0.85) / 72)
    }
    if (h <= boxHIn) return size
  }
  return min
}

// --- element model ------------------------------------------------------------

export const ELEMENT_TYPES = ['text', 'shape', 'line', 'icon', 'image', 'chart', 'group']
export const SHAPE_KINDS = ['rect', 'roundRect', 'ellipse', 'triangle', 'diamond', 'chevron', 'rightArrow']
// bar/barH/line/area/pie/doughnut/scatter export as NATIVE pptx charts (data
// editable in PowerPoint); heatmap/gantt have no native pptx equivalent and
// are composed from primitive shapes/text at flatten time — still fully
// editable objects, never an image.
export const CHART_KINDS = ['bar', 'barH', 'line', 'area', 'pie', 'doughnut', 'scatter', 'heatmap', 'gantt']
export const NATIVE_CHART_KINDS = new Set(['bar', 'barH', 'line', 'area', 'pie', 'doughnut', 'scatter'])
export const MAX_GROUP_DEPTH = 4

// box clamps: elements may bleed slightly off-canvas (full-bleed art) but
// never live entirely in outer space
export const BOX_LIMITS = { xMin: -2, xMax: 12, yMin: -2, yMax: 7.6, minSize: 0.02, maxSize: 12 }
export const MAX_ELEMENTS_PER_SLIDE = 80

let elementCounter = 0
export function newElementId(prefix = 'e') {
  return `${prefix}_${Date.now().toString(36)}_${(++elementCounter).toString(36)}`
}

export function defaultElement(type, theme) {
  const accent = theme?.accent || '#E63946'
  const bodyText = theme?.bodyText || '#1A1A1A'
  const base = { id: newElementId(), type, box: { x: 3.5, y: 2.2, w: 3, h: 1.2 }, style: {} }
  switch (type) {
    case 'text':
      return { ...base, text: 'Texto', style: { fontRole: 'body', fontSize: 14, color: bodyText, align: 'left', valign: 'top' } }
    case 'shape':
      return { ...base, shape: 'roundRect', style: { fill: accent, radius: 0.08, opacity: 100 } }
    case 'line':
      return { ...base, box: { x: 3.5, y: 2.8, w: 3, h: 0 }, style: { lineColor: accent, lineWidth: 2 } }
    case 'icon':
      return { ...base, box: { x: 4.6, y: 2.4, w: 0.8, h: 0.8 }, icon: { builtin: 'star' }, style: {} }
    case 'image':
      return { ...base, box: { x: 3.2, y: 1.8, w: 3.6, h: 2.0 }, imageDataUrl: '', style: {} }
    case 'chart':
      return {
        ...base,
        box: { x: 2.4, y: 1.5, w: 5.2, h: 2.7 },
        chart: {
          kind: 'bar',
          series: [{ name: 'Série 1', data: [{ label: 'A', value: 4 }, { label: 'B', value: 7 }, { label: 'C', value: 5 }] }],
        },
        style: {},
      }
    case 'group':
      return {
        ...base,
        box: { x: 3, y: 1.7, w: 4, h: 2.2 },
        children: [],
        stack: { direction: 'column', gap: 0.15, padding: 0.2 },
        style: {},
      }
    default:
      return base
  }
}

// --- element tree: theme tokens, auto-layout stacks, flattening ---------------
//
// Freeform slides persist a TREE: `group` elements carry `children` (boxes
// relative to the group's origin) and optionally `stack` — auto-layout that
// positions children in a row/column with gap/padding/align, so neither the
// LLM nor the user does coordinate arithmetic for composed blocks. Style
// colors may be '@token' references into the resolved theme (see
// THEME_COLOR_TOKENS in deckTheme.js), so generated freeform slides keep
// re-theming with the design system. Both painters stay dumb:
// `flattenElements` resolves everything into the flat absolute list.
//
// Stack child sizing rules (deterministic on purpose):
//  - column stack: a text child's HEIGHT is always computed from its wrapped
//    content (hug); other types use their own box.h. Width stretches to the
//    stack's inner width unless stack.align positions a narrower box.w.
//  - row stack: mirrored (text width hugs box.w or a single-line estimate).
//  - `grow` (number, default 0) on a child absorbs leftover main-axis space
//    proportionally; with no growers, stack.justify places the group
//    (start|center|end|between).
//  - overflow compresses non-text children proportionally — text never
//    shrinks below its computed height (legibility beats clipping).

const TOKEN_STYLE_KEYS = ['fill', 'color', 'borderColor', 'lineColor']

export function resolveStyleTokens(style, theme) {
  if (!style) return {}
  let out = style
  const set = (k, v) => {
    if (out === style) out = { ...style }
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  for (const k of TOKEN_STYLE_KEYS) {
    if (typeof style[k] === 'string' && style[k][0] === '@') set(k, resolveThemeColor(theme, style[k]))
  }
  const sh = style.shadow
  if (sh && typeof sh === 'object' && typeof sh.color === 'string' && sh.color[0] === '@') {
    set('shadow', { ...sh, color: resolveThemeColor(theme, sh.color, '#000000') })
  }
  return out
}

// measured content size {w,h} of a node given the space the parent offers —
// the "hug" half of the auto-layout contract
function measureNode(el, avail, theme, depth) {
  const st = el.style || {}
  if (el.type === 'text') {
    const size = st.fontSize || TYPE.body
    const text = String(el.text || '')
    // width: explicit box.w wins; otherwise hug a single-line estimate so a
    // text child in a ROW stack doesn't starve its siblings (column stacks
    // stretch it back to the inner width via align:'stretch')
    const longest = Math.max(...text.split('\n').map((l) => l.length), 1)
    const est = longest * (size / 72) * CHAR_W + TEXT_INSETS
    const w = el.box?.w != null ? Math.min(el.box.w, avail.w) : Math.min(est, avail.w)
    let h = textHeightIn(text, size, Math.max(w - TEXT_INSETS, 0.2), st.lineHeight || 1)
    if (st.bullet) h += text.split('\n').filter(Boolean).length * (Math.max(8, size * 0.85) / 72)
    return { w, h: Math.max(h + 0.08, 0.22) }
  }
  if (el.type === 'group' && el.stack && depth < MAX_GROUP_DEPTH) {
    // hug BOTH axes the group doesn't size explicitly: probe the layout with
    // a generous frame (grow/justify skipped while measuring) — usedMain hugs
    // the stack's own direction, usedCross the perpendicular one
    const own = el.stack.direction === 'row' ? 'row' : 'column'
    const probe = layoutStack(
      el,
      {
        x: 0, y: 0,
        w: el.box?.w ?? (own === 'row' ? Math.max(avail.w, 40) : avail.w),
        h: el.box?.h ?? (own === 'column' ? Math.max(avail.h, 40) : avail.h),
      },
      theme,
      depth,
      true
    )
    return {
      w: el.box?.w ?? Math.min(own === 'row' ? probe.usedMain : probe.usedCross, avail.w),
      h: el.box?.h ?? Math.min(own === 'column' ? probe.usedMain : probe.usedCross, avail.h),
    }
  }
  return { w: el.box?.w ?? 1, h: el.box?.h ?? 0.5 }
}

// height of a text child at a given font size — the same strict estimator the
// flatten-time fit uses (uppercase/bold/tracking-aware), so a box measured
// here never forces fitTextStyle below the size it was measured at
function stackTextHeight(el, w, size) {
  const st = el.style || {}
  const raw = String(el.text || '')
  const text = st.uppercase ? raw.toUpperCase() : raw
  const charW = CHAR_W + (st.bold ? 0.05 : 0) + (st.letterSpacing > 1 ? 0.05 : 0)
  let h = textHeightIn(text, size, Math.max(w - TEXT_INSETS, 0.2), st.lineHeight || 1, charW)
  if (st.bullet) h += text.split('\n').filter(Boolean).length * (Math.max(8, size * 0.85) / 72)
  return Math.max(h + 0.08, 0.22)
}

// positions the children of a stack group inside `frame` (absolute inches).
// Returns { placed: [{ el, box, fontFit? }], usedMain } — usedMain is the
// content extent used by measureNode to hug nested stacks; fontFit is the
// uniform overflow font scale result for text children (see stage 2 below).
function layoutStack(group, frame, theme, depth, measuring = false) {
  const s = group.stack || {}
  const dir = s.direction === 'row' ? 'row' : 'column'
  const main = dir === 'column' ? 'h' : 'w'
  const cross = dir === 'column' ? 'w' : 'h'
  const pad = s.padding || 0
  const gap = s.gap ?? 0.15
  const innerCross = Math.max(frame[cross] - pad * 2, 0.05)
  const innerMain = Math.max(frame[main] - pad * 2, 0.05)
  const kids = (group.children || []).filter((c) => c && !c.hidden)
  const avail = dir === 'column' ? { w: innerCross, h: innerMain } : { w: innerMain, h: innerCross }

  // icon normalization: if multiple children are groups with icons, measure all
  // and find the max icon size — then force all to that size for visual consistency
  let iconNorm = null
  const childGroups = kids.filter((c) => c.type === 'group')
  if (childGroups.length > 1) {
    const groupsWithIcons = childGroups.filter((g) => {
      const anyIcon = (g.children || []).some((c) => c.type === 'icon')
      return anyIcon
    })
    if (groupsWithIcons.length > 1) {
      // collect the icons and find the largest
      const icons = []
      for (const g of groupsWithIcons) {
        for (const c of g.children || []) {
          if (c.type === 'icon') icons.push(c)
        }
      }
      if (icons.length > 1) {
        const maxSize = Math.max(...icons.map((ic) => Math.min(ic.box?.w || 0.4, ic.box?.h || 0.4)))
        iconNorm = { size: maxSize, groupIds: new Set(groupsWithIcons.map((g) => g.id)) }
      }
    }
  }

  const measures = kids.map((el) => {
    let m = measureNode(el, avail, theme, depth + 1)
    // if this child is a group with icons and we have a norm, adjust the measured
    // cross-size to reflect the normalized icon
    if (iconNorm && el.type === 'group' && iconNorm.groupIds.has(el.id)) {
      const hasIcon = (el.children || []).some((c) => c.type === 'icon')
      if (hasIcon && dir === 'row') {
        // in a row, icon normalization affects the cross-size (height)
        m = { ...m, cross: iconNorm.size }
      } else if (hasIcon && dir === 'column') {
        // in a column, it might affect the main-size; we'll handle in flattenElements
      }
    }
    // flex-basis:0 semantics — a grow child without an explicit main size is
    // sized purely by distribution (grow:1 on three cards = three equal
    // cards, whatever their content), never by its measured content
    const basis = (Number(el.grow) || 0) > 0 && el.box?.[main] == null ? 0.05 : m[main]
    return { el, main: basis, cross: m[cross] }
  })
  const gapsTotal = gap * Math.max(kids.length - 1, 0)
  let leftover = innerMain - measures.reduce((a, m) => a + m.main, 0) - gapsTotal
  if (!measuring) {
    if (leftover < -0.01) {
      // overflow stage 1: compress everything except text proportionally
      const squish = measures.filter((m) => m.el.type !== 'text')
      const squishTotal = squish.reduce((a, m) => a + m.main, 0)
      if (squishTotal > 0.01) {
        const factor = Math.max((squishTotal + leftover) / squishTotal, 0.25)
        for (const m of squish) m.main *= factor
        leftover = innerMain - measures.reduce((a, m) => a + m.main, 0) - gapsTotal
      }
      // overflow stage 2 — column stacks: scale the FONT of every text child
      // by ONE shared factor, re-measuring the wrap at each step. Compressing
      // the boxes and letting the flatten-time fit shrink each text
      // independently quantized siblings authored at the same size to
      // DIFFERENT painted sizes (line-break rounding); the shared scale keeps
      // them equal. fontFit rides the placed entry so the flatten paints
      // exactly the size the box was measured at.
      if (leftover < -0.01) {
        const texts = measures.filter((m) => m.el.type === 'text')
        if (dir === 'column' && texts.length) {
          const others = measures.reduce((a, m) => a + (m.el.type === 'text' ? 0 : m.main), 0)
          const budget = innerMain - others - gapsTotal
          for (let s = 1; s >= 0.55; s -= 0.05) {
            let total = 0
            for (const m of texts) {
              m.fontFit = Math.max(Math.round((m.el.style?.fontSize || TYPE.body) * s * 2) / 2, 7)
              m.main = stackTextHeight(m.el, m.cross, m.fontFit)
              total += m.main
            }
            if (total <= budget + 0.005 || texts.every((m) => m.fontFit <= 7)) break
          }
        } else if (texts.length) {
          // row stacks: squeeze text widths (floor 0.7 — was 0.6 which broke legibility).
          // The flatten-time fitTextStyle will protect against absurd wrapping by
          // truncating if needed, so we can be somewhat aggressive here.
          const textTotal = texts.reduce((a, m) => a + m.main, 0)
          if (textTotal > 0.01) {
            const factor = Math.max((textTotal + leftover) / textTotal, 0.7)
            for (const m of texts) m.main *= factor
          }
        }
      }
      leftover = 0
    } else if (leftover > 0) {
      const growTotal = kids.reduce((a, c) => a + (Number(c.grow) || 0), 0)
      if (growTotal > 0) {
        for (const m of measures) {
          const g = Number(m.el.grow) || 0
          if (g) m.main += (leftover * g) / growTotal
        }
        leftover = 0
      }
    }
  }
  let cursor = pad
  let extraGap = 0
  if (!measuring && leftover > 0.005) {
    const j = s.justify || 'start'
    if (j === 'center') cursor += leftover / 2
    else if (j === 'end') cursor += leftover
    else if (j === 'between' && kids.length > 1) extraGap = leftover / (kids.length - 1)
  }


  const align = s.align || 'stretch'
  const placed = measures.map((m) => {
    // icons/images keep their intrinsic cross size (stretching distorts art)
    const stretchable = m.el.type !== 'icon' && m.el.type !== 'image'
    const crossSize =
      align === 'stretch' && stretchable && m.el.box?.[cross] == null
        ? innerCross
        : Math.min(m.cross, innerCross)
    const crossOff =
      align === 'center' ? (innerCross - crossSize) / 2 : align === 'end' ? innerCross - crossSize : 0
    const box =
      dir === 'column'
        ? { x: frame.x + pad + crossOff, y: frame.y + cursor, w: crossSize, h: m.main }
        : { x: frame.x + cursor, y: frame.y + pad + crossOff, w: m.main, h: crossSize }
    cursor += m.main + gap + extraGap
    return { el: m.el, box: rbox(box), ...(m.fontFit ? { fontFit: m.fontFit } : {}) }
  })
  return {
    placed,
    usedMain: Math.max(cursor - gap - extraGap + pad, pad * 2),
    usedCross: Math.max(...measures.map((m) => m.cross), 0) + pad * 2,
  }
}

// deck-wide chart palette — mirrored by the pptx chart options (CHART_EXTRA
// in server/decks.js predates this; the extras must stay identical)
export function chartPalette(theme) {
  return [theme.accent, theme.primary, theme.secondary, '#618794', '#00A972', '#FFAB00', '#98102A']
}

// --- composed charts (heatmap / gantt): primitives, never an image ----------

// label colors picked against the SLIDE background (a heatmap on a dark
// @primary slide must not use the light-background heading/muted inks)
function chartLabelColors(theme, background) {
  const bg = background || theme.background
  if (luminance(bg) < 0.55) {
    return {
      heading: theme.onPrimary,
      muted: theme.onPrimaryMuted,
      faint: theme.onPrimaryFaint,
      hairline: blend('#FFFFFF', bg, 0.78),
    }
  }
  return { heading: theme.heading, muted: theme.muted, faint: theme.faint, hairline: theme.hairline }
}

function heatmapPrimitives(el, box, theme, ink) {
  const hm = el.chart?.heatmap || {}
  const xs = (hm.xLabels || []).slice(0, 14)
  const ys = (hm.yLabels || []).slice(0, 12)
  const values = hm.values || []
  if (!xs.length || !ys.length) return []
  const flat = ys.flatMap((_, r) => xs.map((_, c) => values[r]?.[c])).filter((v) => typeof v === 'number')
  const min = typeof hm.min === 'number' ? hm.min : Math.min(...flat, 0)
  const max = typeof hm.max === 'number' ? hm.max : Math.max(...flat, min + 1)
  const showValues = hm.showValues !== false
  const labelW = Math.min(box.w * 0.26, 1.8)
  const headH = 0.26
  const cw = (box.w - labelW) / xs.length
  const ch = (box.h - headH) / ys.length
  const cellFont = Math.max(Math.min(ch * 46, 10), 5.5)
  const out = []
  const accent = resolveThemeColor(theme, '@accent', theme.accent)
  xs.forEach((xl, c) => {
    out.push({
      id: `${el.id}_hx${c}`, type: 'text', box: rbox({ x: box.x + labelW + c * cw, y: box.y, w: cw, h: headH }),
      style: { fontRole: 'body', fontSize: Math.min(cellFont, 8.5), bold: true, color: ink.muted, align: 'center', valign: 'middle' },
      text: String(xl),
    })
  })
  ys.forEach((yl, r) => {
    out.push({
      id: `${el.id}_hy${r}`, type: 'text', box: rbox({ x: box.x, y: box.y + headH + r * ch, w: labelW - 0.06, h: ch }),
      style: { fontRole: 'body', fontSize: Math.min(cellFont, 8.5), bold: true, color: ink.heading, align: 'right', valign: 'middle' },
      text: String(yl),
    })
    xs.forEach((_, c) => {
      const v = values[r]?.[c]
      const t = typeof v === 'number' && max > min ? Math.min(Math.max((v - min) / (max - min), 0), 1) : 0
      const fill = blend(accent, theme.background, 1 - (0.07 + 0.93 * t))
      out.push({
        id: `${el.id}_c${r}_${c}`, type: 'shape', shape: 'rect',
        box: rbox({ x: box.x + labelW + c * cw + 0.015, y: box.y + headH + r * ch + 0.015, w: cw - 0.03, h: ch - 0.03 }),
        style: { fill },
      })
      if (showValues && typeof v === 'number') {
        out.push({
          id: `${el.id}_v${r}_${c}`, type: 'text',
          box: rbox({ x: box.x + labelW + c * cw, y: box.y + headH + r * ch, w: cw, h: ch }),
          style: { fontRole: 'body', fontSize: cellFont, color: contrastOn(fill), align: 'center', valign: 'middle' },
          text: String(v),
        })
      }
    })
  })
  return out
}

function ganttPrimitives(el, box, theme, ink) {
  const g = el.chart?.gantt || {}
  const tasks = (g.tasks || []).slice(0, 12)
  if (!tasks.length) return []
  const d0 = Math.min(...tasks.map((t) => t.start))
  const d1 = Math.max(...tasks.map((t) => t.end), d0 + 1)
  const axis = (g.axis || []).slice(0, 16)
  const axisH = axis.length ? 0.26 : 0.08
  const labelW = Math.min(box.w * 0.28, 2.3)
  const laneH = (box.h - axisH) / tasks.length
  const chartW = box.w - labelW
  const X = (v) => box.x + labelW + (Math.min(Math.max((v - d0) / (d1 - d0), 0), 1)) * chartW
  const out = []
  const accent = resolveThemeColor(theme, '@accent', theme.accent)
  // vertical grid + axis labels: axis strings label the equal segments of the
  // domain (e.g. months/quarters); boundaries get a hairline
  if (axis.length) {
    const seg = chartW / axis.length
    axis.forEach((label, i) => {
      out.push({
        id: `${el.id}_ax${i}`, type: 'text',
        box: rbox({ x: box.x + labelW + i * seg, y: box.y, w: seg, h: axisH }),
        style: { fontRole: 'body', fontSize: 7.5, bold: true, color: ink.faint, uppercase: true, letterSpacing: 1, align: 'center', valign: 'middle' },
        text: String(label),
      })
      if (i > 0) {
        out.push({
          id: `${el.id}_gl${i}`, type: 'line',
          box: rbox({ x: box.x + labelW + i * seg, y: box.y + axisH, w: 0, h: box.h - axisH }),
          style: { lineColor: ink.hairline, lineWidth: 0.75 },
        })
      }
    })
  }
  tasks.forEach((t, i) => {
    const y = box.y + axisH + i * laneH
    if (i > 0) {
      out.push({
        id: `${el.id}_rl${i}`, type: 'line',
        box: rbox({ x: box.x, y, w: box.w, h: 0 }),
        style: { lineColor: ink.hairline, lineWidth: 0.5 },
      })
    }
    out.push({
      id: `${el.id}_tl${i}`, type: 'text',
      box: rbox({ x: box.x, y, w: labelW - 0.12, h: laneH }),
      style: { fontRole: 'body', fontSize: Math.max(Math.min(laneH * 40, 9.5), 6), bold: true, color: ink.heading, align: 'right', valign: 'middle' },
      text: String(t.label || ''),
    })
    const fill = resolveThemeColor(theme, t.color, accent) || accent
    const barH = Math.min(laneH * 0.52, 0.3)
    if (t.milestone) {
      out.push({
        id: `${el.id}_ms${i}`, type: 'shape', shape: 'diamond',
        box: rbox({ x: X(t.start) - barH / 2, y: y + (laneH - barH) / 2, w: barH, h: barH }),
        style: { fill },
      })
    } else {
      out.push({
        id: `${el.id}_bar${i}`, type: 'shape', shape: 'roundRect',
        box: rbox({ x: X(t.start), y: y + (laneH - barH) / 2, w: Math.max(X(t.end) - X(t.start), 0.08), h: barH }),
        style: { fill, radius: Math.min(barH / 2, 0.08) },
      })
    }
  })
  return out
}

// Flattens a persisted element tree into the flat absolute list both dumb
// painters consume: resolves '@' theme tokens, group offsets, stack layout,
// and expands composed charts (heatmap/gantt) into primitives. Native chart
// kinds survive as one 'chart' element (server maps it to addChart, the
// preview draws an SVG approximation). Each output element carries `srcId`
// (the persisted node it came from); pass `boxes` (a Map) to also collect the
// resolved absolute box of EVERY node including groups — the editor's
// hit-testing/selection frames read layout truth from here instead of
// re-implementing it.
export function flattenElements(elements, theme, { boxes = null, background = null } = {}) {
  const out = []
  const ink = chartLabelColors(theme, background)
  const walk = (el, ox, oy, frame, depth, fontFit = null) => {
    if (!el || el.hidden) return
    let box = frame
    if (!box) {
      let { w, h } = el.box || {}
      // an absolutely-placed stack group without explicit dims hugs its
      // content, same as it would inside another stack
      if (el.type === 'group' && el.stack && (w == null || h == null)) {
        const m = measureNode(el, { w: w ?? SLIDE_W, h: h ?? SLIDE_H }, theme, depth)
        w = w ?? m.w
        h = h ?? m.h
      }
      box = rbox({ x: ox + (el.box?.x || 0), y: oy + (el.box?.y || 0), w: w ?? 1, h: h ?? 0.5 })
    }
    if (boxes) boxes.set(el.id, box)
    if (el.type === 'group') {
      if (depth >= MAX_GROUP_DEPTH) return
      const st = resolveStyleTokens(el.style, theme)
      if (st.fill || st.borderColor || st.shadow) {
        out.push({ id: `${el.id}__bg`, type: 'shape', shape: st.radius ? 'roundRect' : 'rect', box, style: st, srcId: el.id })
      }
      if (el.stack) {
        const { placed } = layoutStack(el, box, theme, depth)
        for (const p of placed) walk(p.el, 0, 0, p.box, depth + 1, p.fontFit)
      } else {
        for (const c of el.children || []) walk(c, box.x, box.y, null, depth + 1)
      }
      return
    }
    if (el.type === 'chart' && (el.chart?.kind === 'heatmap' || el.chart?.kind === 'gantt')) {
      const prims = el.chart.kind === 'heatmap' ? heatmapPrimitives(el, box, theme, ink) : ganttPrimitives(el, box, theme, ink)
      for (const p of prims) out.push({ ...p, style: resolveStyleTokens(p.style, theme), srcId: el.id })
      return
    }
    const style = el.type === 'text' ? fitTextStyle(el, box, theme, fontFit) : resolveStyleTokens(el.style, theme)

    // if fitTextStyle returned a modified text, update it on the output
    let outEl = { ...el, box, style, srcId: el.id }
    if (style.text && style.text !== el.text) {
      outEl.text = style.text
      // delete the text override from style (it was only used to return it here)
      const { text, ...cleanStyle } = style
      outEl.style = cleanStyle
    }

    out.push(outEl)
  }
  for (const el of elements || []) walk(el, 0, 0, null, 0)
  return out
}

// Freeform text auto-fit (same philosophy as the semantic engine's fitFont
// everywhere): the authored fontSize is a MAXIMUM — when the wrapped text
// would overflow its box, the paint size shrinks until it fits (floor 8pt).
// This is what keeps LLM-authored freeform slides from ever painting a title
// over the subtitle below it, and it composes with layoutStack's stage-2
// overflow compression (smaller frame → smaller font).
//
// HARDENING: two scenarios are now protected:
// 1. If a box is SO narrow that text would wrap excessively (>6 lines at current size),
//    truncate/ellipsize to avoid illegible wrapping.
// 2. If a box is too tall relative to width (content could sprawl vertically forever),
//    cap the effective box height to prevent runaway layouts. This handles freeform
//    slides where LLM-authored boxes have absurd dimensions.
function fitTextStyle(el, box, theme, stackFit = null) {
  const st = resolveStyleTokens(el.style, theme)
  const size = st.fontSize || TYPE.body
  if (!box || box.h < 0.08 || box.w < 0.2) return st
  const raw = String(el.text || '')
  const text = st.uppercase ? raw.toUpperCase() : raw

  // PROTECTION 1: unreasonable narrowness leading to absurd wrapping.
  // This check comes BEFORE the stackFit early return so it catches even
  // texts that were pre-fitted by layoutStack's overflow stage 2.
  const boxW = Math.max(box.w - TEXT_INSETS, 0.15)
  const estLines = estimateLines(text, size, boxW)
  if (estLines > 6 && boxW < 1.2) {
    // box is too narrow for legible wrapping; truncate to fit 1-2 lines max
    const charW = CHAR_W + (st.bold ? 0.05 : 0) + (st.letterSpacing > 1 ? 0.05 : 0)
    const charsPerLine = Math.max(Math.floor(boxW / ((size / 72) * charW)), 3)
    const truncated = text.slice(0, charsPerLine * 2).trimEnd() + (text.length > charsPerLine * 2 ? '…' : '')
    return { ...st, fontSize: size, text: truncated }
  }

  // a column stack that ran uniform overflow scaling already measured this
  // box at exactly `stackFit` — paint that size; re-fitting per box would
  // re-introduce the per-sibling quantization the shared scale removed
  if (stackFit) return stackFit < size ? { ...st, fontSize: stackFit } : st

  // PROTECTION 2: unreasonable tallness. If box.h is way larger than needed
  // for the text (e.g., 2.6in for a label), clamp it to prevent the flatten-time
  // fitFont from creating a legitimate 2.6in tall rendered text (which breaks layout)
  let effectiveBoxH = box.h
  const estimatedH = textHeightIn(text, size, boxW, st.lineHeight || 1)
  if (estimatedH > 0 && effectiveBoxH / estimatedH > 3.5) {
    // box is way taller than needed; use a more reasonable height (~2× text height)
    effectiveBoxH = Math.max(estimatedH * 2, 0.4)
  }

  let fitted
  if (st.bullet) {
    fitted = fitListFont(text.split('\n').filter(Boolean), box.w, effectiveBoxH, size, { lineSpacing: st.lineHeight || 1.12, min: 8 })
  } else {
    // bold/tracked type runs wider than the average glyph advance
    const charW = CHAR_W + (st.bold ? 0.05 : 0) + (st.letterSpacing > 1 ? 0.05 : 0)
    fitted = fitFont(text, box.w, effectiveBoxH + 0.02, size, { lineSpacing: st.lineHeight || 1, min: 8, charW })
  }
  return fitted < size ? { ...st, fontSize: fitted } : st
}

// --- materialization ----------------------------------------------------------
//
// Semantic slide → { background, elements }: the one-shot conversion behind
// the Studio's "Converter para edição livre". Geometry is ported from the
// pptx builders in server/decks.js (the visual source of truth) — after
// conversion the slide is a plain element list, uniformly editable, and no
// longer re-themes with the design system (colors are baked concrete).
//
// `chart` has no generator on purpose: the export uses a NATIVE pptx chart
// (data editable in PowerPoint) — baking it into dumb rectangles would
// degrade the deliverable. table / diagram / image-with-diagramSpec DO
// materialize (cell grids, chip columns, mined vector shapes); each returns
// null instead when the result would blow the per-slide element budget, and
// those slides simply stay on the legacy path.

const r2 = (v) => Math.round(v * 100) / 100
const rbox = (b) => ({ x: r2(b.x), y: r2(b.y), w: r2(b.w), h: r2(b.h) })

// slide.styles[path] overrides (user restyles on the semantic slide) merge
// onto the generated element so the conversion is WYSIWYG; the styles map
// itself does not survive — elements carry the result.
function ovStyle(style, slide, path) {
  const o = slide?.styles?.[path]
  return o ? { ...style, ...o } : style
}

function pushText(out, id, text, box, style, slide = null, path = null) {
  if (text == null || text === '') return
  const el = { id, type: 'text', box: rbox(box), style: path ? ovStyle(style, slide, path) : style, text: String(text) }
  // `editPath` is the slide-JSON path this text maps back to (heading,
  // cards[2].body, ...). Inert on the pptx export (paintElements reads only
  // whitelisted fields) — it exists so the React preview can paint semantic
  // slides through this same materialization and still offer click-to-select /
  // double-click-to-edit on each field, keyed by this path.
  if (path) el.editPath = path
  out.push(el)
}

// same soft-plate look as addItemIcon in server/decks.js; nothing when the
// item carries no icon (never a synthesized fallback)
function pushItemIcon(out, id, item, x, y, size, theme) {
  const icon = item.iconAssetId ? { assetId: item.iconAssetId } : item.icon ? { builtin: item.icon } : null
  if (!icon) return false
  out.push({
    id,
    type: 'icon',
    box: rbox({ x, y, w: size, h: size }),
    // exact 22% plate radius (addIconImage/addBuiltinIcon parity) — r2 here
    // would drift the roundRect adj a visually-nil but measurable 0.5%
    style: { fill: theme.accentSoft, radius: size * 0.22, color: theme.accent },
    icon,
  })
  return true
}

function pushKickerRow(out, idPrefix, text, { x, y, color, ruleColor, w = CONTENT_W }, slide = null, path = 'kicker') {
  out.push({
    id: `${idPrefix}_rule`,
    type: 'shape',
    shape: 'rect',
    box: rbox({ x, y: y + 0.075, w: 0.34, h: 0.038 }),
    style: { fill: ruleColor },
  })
  // valign middle: pptxgenjs's addText default is anchor="ctr" — the legacy
  // builders relied on it for every no-valign text, so the generators must
  // say it explicitly (paintElements defaults to top)
  pushText(
    out,
    idPrefix,
    text,
    { x: x + 0.44, y: y - 0.06, w: w - 0.44, h: 0.3 },
    { fontRole: 'body', fontSize: TYPE.kicker, bold: true, color, uppercase: true, letterSpacing: 2.4, valign: 'middle' },
    slide,
    path
  )
}

// one bullet-list text element ('\n'-separated, style.bullet) — the element
// model has no per-paragraph styling, so per-item overrides don't survive
// conversion (the fitted size/color apply to the whole list)
function pushBullets(out, id, bullets, box, size, theme) {
  if (!bullets?.length) return
  out.push({
    id,
    type: 'text',
    box: rbox(box),
    style: { fontRole: 'body', fontSize: size, color: theme.bodyText, bullet: true, lineHeight: 1.12, valign: 'top' },
    text: bullets.join('\n'),
  })
}

function bulletSizeFor(bullets, boxWIn, boxHIn) {
  const n = (bullets || []).length
  const base = n <= 3 ? 15 : n <= 5 ? TYPE.body : 12
  return fitListFont(bullets || [], boxWIn, boxHIn, base)
}

// mined decorative motif re-drawn as shape elements (dark family without a
// plate/illustration) — skipped when the mined cluster is too dense to spend
// element budget on decoration
function pushMotif(out, theme) {
  const m = theme.motif
  if (!m?.shapes?.length || m.shapes.length > 24) return
  const box = { x: m.box.x * SLIDE_W, y: m.box.y * SLIDE_H, w: m.box.w * SLIDE_W, h: m.box.h * SLIDE_H }
  const dot = Math.max(m.dotW * SLIDE_W, 0.03)
  const geom = m.geom === 'ellipse' ? 'ellipse' : m.geom === 'diamond' ? 'diamond' : 'rect'
  m.shapes.forEach((sh, i) => {
    out.push({
      id: `motif${i + 1}`,
      type: 'shape',
      shape: geom,
      box: rbox({ x: box.x + sh.x * box.w, y: box.y + sh.y * box.h, w: dot, h: dot }),
      style: { fill: hexOr(sh.color, blend(theme.onPrimary, theme.primary, 0.35)) },
    })
  })
}

function pushCoverArt(out, theme, { variant = 'cover', seed = 0 } = {}) {
  const hasPlate = variant === 'section' ? theme.sectionPlate || theme.coverPlate : theme.coverPlate
  const art = hasPlate ? null : pickDeckIllustration(theme, seed)
  if (!art) {
    if (!hasPlate) pushMotif(out, theme)
    return
  }
  const box =
    variant === 'section'
      ? { x: SLIDE_W - 2.55, y: SLIDE_H - 2.5, w: 2.0, h: 2.0 }
      : { x: SLIDE_W - 2.9, y: 0.75, w: 2.25, h: 2.25 }
  out.push({ id: 'cover_art', type: 'image', box: rbox(box), style: {}, imageDataUrl: art.dataUrl })
}

function pushLogo(out, theme, { y = 0.42, h = 0.34 } = {}) {
  if (!theme.logoDataUrl) return
  out.push({
    id: 'logo',
    type: 'image',
    box: rbox({ x: GRID.margin, y, w: h * 2.6, h }),
    style: {},
    imageDataUrl: theme.logoDataUrl,
  })
}

function pushCoverFooter(out, theme, ctx) {
  // covers show audience/author only — NEVER the ctx.meta fallback to the
  // deck title (the title is already the headline of this very slide);
  // mirrors coverFooter vs footerMeta in server/decks.js
  const meta = [ctx.audience || null, ctx.author || null].filter(Boolean).join(' · ')
  if (meta) {
    pushText(out, 'footer_meta', meta, { x: GRID.margin, y: GRID.footerY, w: CONTENT_W - 1, h: 0.3 }, {
      fontRole: 'body', fontSize: TYPE.footer, color: theme.onPrimaryFaint, valign: 'middle',
    })
  }
  pushText(out, 'footer_year', String(new Date().getFullYear()), { x: SLIDE_W - GRID.margin - 0.8, y: GRID.footerY, w: 0.8, h: 0.3 }, {
    fontRole: 'body', fontSize: TYPE.footer, color: theme.onPrimaryFaint, align: 'right', valign: 'middle',
  })
}

// shared content-slide chrome, mirroring slideChrome in server/decks.js —
// returns the body box the layout draws in
function pushChrome(out, slide, theme, ctx) {
  let y = GRID.titleY
  if (slide.kicker) {
    pushKickerRow(out, 'kicker', slide.kicker, { x: GRID.margin, y: GRID.kickerY, color: theme.accent, ruleColor: theme.accent }, slide)
  } else {
    y = GRID.kickerY + 0.1
  }
  const titleH = 0.86
  const titleSize = fitFont(slide.heading, CONTENT_W, titleH, TYPE.title * theme.typeScale, { lineSpacing: 1.04, min: 14 })
  pushText(out, 'heading', slide.heading || '', { x: GRID.margin, y, w: CONTENT_W, h: titleH }, {
    fontRole: 'heading', fontSize: titleSize, bold: true, color: theme.heading, valign: 'top', lineHeight: 1.04,
  }, slide, 'heading')
  y += titleH
  if (slide.subheading) {
    pushText(out, 'subheading', slide.subheading, { x: GRID.margin, y: y - 0.12, w: CONTENT_W, h: 0.34 }, {
      fontRole: 'body', fontSize: fitFont(slide.subheading, CONTENT_W, 0.34, TYPE.subheading, { min: 9 }), color: theme.muted, valign: 'top',
    }, slide, 'subheading')
    y += 0.26
  }
  out.push({
    id: 'title_rule',
    type: 'line',
    box: rbox({ x: GRID.margin, y: y + 0.02, w: CONTENT_W, h: 0 }),
    style: { lineColor: theme.hairline, lineWidth: 1 },
  })

  if (ctx.meta) {
    pushText(out, 'footer_meta', ctx.meta, { x: GRID.margin, y: GRID.footerY, w: CONTENT_W - 0.8, h: 0.3 }, {
      fontRole: 'body', fontSize: TYPE.footer, color: theme.faint, valign: 'middle',
    })
  }
  if (ctx.pageNumber != null) {
    pushText(out, 'page_no', String(ctx.pageNumber), { x: SLIDE_W - GRID.margin - 0.5, y: GRID.footerY, w: 0.5, h: 0.3 }, {
      fontRole: 'body', fontSize: TYPE.footer, color: theme.faint, align: 'right', valign: 'middle',
    })
  }

  let bottom = GRID.bodyBottom
  if (slide.footnote) {
    bottom -= 0.24
    pushText(out, 'footnote', slide.footnote, { x: GRID.margin, y: bottom + 0.02, w: CONTENT_W, h: 0.24 }, {
      fontRole: 'body', fontSize: TYPE.footer, italic: true, color: theme.faint, valign: 'bottom',
    }, slide, 'footnote')
  }
  if (slide.callout?.text) {
    bottom -= GRID.calloutH + 0.12
    const cy = bottom + 0.12
    out.push({
      id: 'callout_panel',
      type: 'shape',
      shape: 'roundRect',
      box: rbox({ x: GRID.margin, y: cy, w: CONTENT_W, h: GRID.calloutH }),
      style: { fill: theme.primary, radius: 0.06 },
    })
    const hasKicker = !!slide.callout.kicker
    if (hasKicker) {
      pushText(out, 'callout_kicker', slide.callout.kicker, { x: GRID.margin + 0.24, y: cy + 0.08, w: CONTENT_W - 0.48, h: 0.22 }, {
        fontRole: 'body', fontSize: 8.5, bold: true, color: theme.accent, uppercase: true, letterSpacing: 2, valign: 'middle',
      }, slide, 'callout.kicker')
    }
    const boxH = GRID.calloutH - (hasKicker ? 0.34 : 0.14)
    pushText(out, 'callout_text', slide.callout.text, { x: GRID.margin + 0.24, y: cy + (hasKicker ? 0.28 : 0.06), w: CONTENT_W - 0.48, h: boxH }, {
      fontRole: 'heading', fontSize: fitFont(slide.callout.text, CONTENT_W - 0.48, boxH, 12.5, { lineSpacing: 1.05, min: 9 }),
      bold: true, color: theme.onPrimary, valign: 'middle', lineHeight: 1.05,
    }, slide, 'callout.text')
  }
  return { top: y + 0.22, bottom, h: bottom - (y + 0.22) }
}

// --- per-layout generators (geometry ported from server/decks.js) ------------

function genTitle(slide, theme, ctx) {
  const out = []
  pushLogo(out, theme, { y: 0.5, h: 0.4 })
  pushCoverArt(out, theme, { variant: 'cover', seed: 0 })
  if (slide.kicker) {
    pushKickerRow(out, 'kicker', slide.kicker, { x: GRID.margin, y: 1.38, color: theme.accent, ruleColor: theme.accent, w: SLIDE_W - 4 }, slide)
  }
  const hasArt = !theme.coverPlate && pickDeckIllustration(theme, 0)
  const heading = slide.heading || ctx.deckTitle || ''
  const coverW = hasArt ? SLIDE_W - 3.55 : SLIDE_W - 2.2
  pushText(out, 'heading', heading, { x: GRID.margin, y: 2.55, w: coverW, h: 1.55 }, {
    fontRole: 'heading',
    fontSize: fitFont(heading, coverW, 1.55, TYPE.coverTitle * theme.typeScale, { lineSpacing: 1.02, min: 20, charW: 0.6 }),
    bold: true, color: theme.onPrimary, valign: 'bottom', lineHeight: 1.02,
  }, slide, 'heading')
  if (slide.subheading) {
    pushText(out, 'subheading', slide.subheading, { x: GRID.margin, y: 4.18, w: SLIDE_W - 3, h: 0.72 }, {
      fontRole: 'body',
      fontSize: fitFont(slide.subheading, SLIDE_W - 3, 0.72, 13.5, { lineSpacing: 1.15, min: 9 }),
      color: theme.onPrimaryMuted, valign: 'top', lineHeight: 1.15,
    }, slide, 'subheading')
  }
  pushCoverFooter(out, theme, ctx)
  return { background: theme.coverPlate ? { plate: 'cover' } : { color: theme.primary }, elements: out }
}

function genSection(slide, theme, ctx) {
  const out = []
  pushCoverArt(out, theme, { variant: 'section', seed: ctx.sectionNo || 0 })
  pushText(out, 'section_no', String(ctx.sectionNo || 1).padStart(2, '0'), { x: GRID.margin, y: 1.62, w: 2, h: 0.5 }, {
    fontRole: 'body', fontSize: 15, bold: true, color: theme.accent, letterSpacing: 3, valign: 'middle',
  })
  const secW = SLIDE_W - 2.6
  const secSize = fitFont(slide.heading, secW, 0.85, TYPE.sectionTitle * theme.typeScale, { lineSpacing: 1.03, min: 18, charW: 0.6 })
  pushText(out, 'heading', slide.heading || '', { x: GRID.margin, y: 2.15, w: secW, h: 1.15 }, {
    fontRole: 'heading', fontSize: secSize, bold: true, color: theme.onPrimary, valign: 'top', lineHeight: 1.03,
  }, slide, 'heading')
  if (slide.subheading) {
    const headH = Math.min(textHeightIn(slide.heading, secSize, secW - TEXT_INSETS, 1.03, 0.6), 1.15)
    pushText(out, 'subheading', slide.subheading, { x: GRID.margin, y: 2.15 + headH + 0.12, w: SLIDE_W - 3.4, h: 0.7 }, {
      fontRole: 'body', fontSize: 12.5, color: theme.onPrimaryMuted, valign: 'top', lineHeight: 1.15,
    }, slide, 'subheading')
  }
  if (ctx.pageNumber != null) {
    pushText(out, 'page_no', String(ctx.pageNumber), { x: SLIDE_W - GRID.margin - 0.5, y: GRID.footerY, w: 0.5, h: 0.3 }, {
      fontRole: 'body', fontSize: TYPE.footer, color: theme.onPrimaryFaint, align: 'right', valign: 'middle',
    })
  }
  return {
    background: theme.sectionPlate || theme.coverPlate ? { plate: 'section' } : { color: theme.primary },
    elements: out,
  }
}

function genClosing(slide, theme, ctx) {
  const out = []
  pushLogo(out, theme, { y: 0.5, h: 0.4 })
  if (!theme.illustrations.length) pushMotif(out, theme)
  out.push({
    id: 'accent_rule',
    type: 'shape',
    shape: 'rect',
    box: rbox({ x: GRID.margin, y: 1.98, w: 0.5, h: 0.05 }),
    style: { fill: theme.accent },
  })
  const heading = slide.heading || 'Obrigado'
  const closeW = SLIDE_W - 2.2
  const closeSize = fitFont(heading, closeW, 1.2, 30 * theme.typeScale, { lineSpacing: 1.03, min: 18, charW: 0.6 })
  pushText(out, 'heading', heading, { x: GRID.margin, y: 2.2, w: closeW, h: 1.2 }, {
    fontRole: 'heading', fontSize: closeSize, bold: true, color: theme.onPrimary, valign: 'top', lineHeight: 1.03,
  }, slide, 'heading')
  if (slide.subheading || slide.body) {
    const headH = Math.min(textHeightIn(heading, closeSize, closeW - TEXT_INSETS, 1.03, 0.6), 1.4)
    pushText(out, 'message', slide.subheading || slide.body, { x: GRID.margin, y: Math.max(3.4, 2.2 + headH + 0.18), w: SLIDE_W - 3.2, h: 0.9 }, {
      fontRole: 'body', fontSize: 13, color: theme.onPrimaryMuted, valign: 'top', lineHeight: 1.15,
    }, slide, slide.subheading ? 'subheading' : 'body')
  }
  pushCoverFooter(out, theme, ctx)
  return { background: theme.coverPlate ? { plate: 'cover' } : { color: theme.primary }, elements: out }
}

function genQuote(slide, theme) {
  const out = []
  const onDeep = contrastOn(theme.deep)
  pushText(out, 'quote_mark', '“', { x: GRID.margin - 0.08, y: 0.75, w: 1.6, h: 1.2 }, {
    fontRole: 'heading', fontSize: 76, bold: true, color: theme.accent, valign: 'middle',
  })
  const quoteText = slide.body || slide.subheading || ''
  pushText(out, 'quote', quoteText, { x: GRID.margin + 0.25, y: 1.7, w: SLIDE_W - 2.6, h: 2.1 }, {
    fontRole: 'heading',
    fontSize: fitFont(quoteText, SLIDE_W - 2.6, 2.1, 21, { lineSpacing: 1.2, min: 12 }),
    color: onDeep, valign: 'middle', lineHeight: 1.2,
  }, slide, 'body')
  if (slide.heading) {
    out.push({
      id: 'author_rule',
      type: 'shape',
      shape: 'rect',
      box: rbox({ x: GRID.margin + 0.25, y: 4.1, w: 0.34, h: 0.035 }),
      style: { fill: theme.accent },
    })
    pushText(out, 'author', slide.heading, { x: GRID.margin + 0.72, y: 3.95, w: SLIDE_W - 3, h: 0.35 }, {
      fontRole: 'body', fontSize: 10, bold: true, color: blend(onDeep, theme.deep, 0.3), uppercase: true, letterSpacing: 2, valign: 'middle',
    }, slide, 'heading')
  }
  return { background: { color: theme.deep }, elements: out }
}

function genBullets(slide, theme, ctx) {
  const out = []
  const box = pushChrome(out, slide, theme, ctx)
  let top = box.top
  if (slide.body) {
    pushText(out, 'body', slide.body, { x: GRID.margin, y: top, w: CONTENT_W, h: 0.55 }, {
      fontRole: 'body', fontSize: TYPE.body, color: theme.muted, lineHeight: 1.15, valign: 'middle',
    }, slide, 'body')
    top += 0.68
  }
  if (slide.bullets?.length) {
    const h = Math.max(box.bottom - top, 0.5)
    pushBullets(out, 'bullets', slide.bullets, { x: GRID.margin + 0.08, y: top, w: CONTENT_W - 0.16, h }, bulletSizeFor(slide.bullets, CONTENT_W - 0.16, h), theme)
  }
  return { background: { color: theme.background }, elements: out }
}

function genTwoColumn(slide, theme, ctx) {
  const out = []
  const box = pushChrome(out, slide, theme, ctx)
  const bullets = slide.bullets || []
  const mid = Math.ceil(bullets.length / 2)
  const colW = (CONTENT_W - GRID.gutter) / 2
  const h = Math.max(box.h, 0.5)
  const size = Math.min(bulletSizeFor(bullets.slice(0, mid), colW - 0.16, h), bulletSizeFor(bullets.slice(mid), colW - 0.16, h))
  pushBullets(out, 'bullets_left', bullets.slice(0, mid), { x: GRID.margin + 0.08, y: box.top, w: colW - 0.16, h }, size, theme)
  pushBullets(out, 'bullets_right', bullets.slice(mid), { x: GRID.margin + colW + GRID.gutter, y: box.top, w: colW - 0.16, h }, size, theme)
  if (slide.body) {
    pushText(out, 'body', slide.body, { x: GRID.margin, y: box.bottom - 0.4, w: CONTENT_W, h: 0.4 }, {
      fontRole: 'body', fontSize: TYPE.small, italic: true, color: theme.faint, valign: 'bottom',
    }, slide, 'body')
  }
  return { background: { color: theme.background }, elements: out }
}

function genAgenda(slide, theme, ctx) {
  const out = []
  const box = pushChrome(out, { heading: 'Agenda', ...slide }, theme, ctx)
  const items = (slide.items?.length ? slide.items : (slide.bullets || []).map((b) => ({ title: b }))).slice(0, 7)
  const n = Math.max(items.length, 1)
  const rowH = Math.min(0.78, box.h / n)
  items.forEach((item, i) => {
    const y = box.top + i * rowH
    pushText(out, `item${i + 1}_no`, String(i + 1).padStart(2, '0'), { x: GRID.margin, y, w: 0.55, h: rowH }, {
      fontRole: 'heading', fontSize: 15, bold: true, color: theme.accent, valign: 'middle', letterSpacing: 1,
    })
    const hasBody = !!item.body
    const itemW = CONTENT_W - 0.8
    pushText(out, `item${i + 1}_title`, item.title || '', { x: GRID.margin + 0.72, y: y + (hasBody ? rowH * 0.06 : 0), w: itemW, h: hasBody ? rowH * 0.5 : rowH }, {
      fontRole: 'heading', fontSize: fitFont(item.title, itemW, hasBody ? rowH * 0.5 : rowH, 13.5, { min: 9 }),
      bold: true, color: theme.heading, valign: hasBody ? 'bottom' : 'middle',
    }, slide, `items[${i}].title`)
    if (hasBody) {
      pushText(out, `item${i + 1}_body`, item.body, { x: GRID.margin + 0.72, y: y + rowH * 0.56, w: itemW, h: rowH * 0.4 }, {
        fontRole: 'body', fontSize: fitFont(item.body, itemW, rowH * 0.4, TYPE.small, { min: 8 }), color: theme.muted, valign: 'top',
      }, slide, `items[${i}].body`)
    }
    if (i < items.length - 1) {
      out.push({
        id: `item${i + 1}_rule`,
        type: 'line',
        box: rbox({ x: GRID.margin + 0.72, y: y + rowH, w: CONTENT_W - 0.8, h: 0 }),
        style: { lineColor: theme.hairline, lineWidth: 0.75 },
      })
    }
  })
  return { background: { color: theme.background }, elements: out }
}

function genCards(slide, theme, ctx) {
  const out = []
  const box = pushChrome(out, slide, theme, ctx)
  const cards = (slide.cards || []).slice(0, 6)
  const cols = cards.length <= 1 ? 1 : cards.length === 2 || cards.length === 4 ? 2 : 3
  const rows = Math.ceil(cards.length / cols) || 1
  const cardW = (CONTENT_W - GRID.gutter * (cols - 1)) / cols
  const cardH = (box.h - GRID.gutter * (rows - 1)) / rows
  cards.forEach((card, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = GRID.margin + col * (cardW + GRID.gutter)
    const y = box.top + row * (cardH + GRID.gutter)
    out.push({
      id: `card${i + 1}_box`,
      type: 'shape',
      shape: 'roundRect',
      box: rbox({ x, y, w: cardW, h: cardH }),
      style: { fill: theme.cardFill, radius: 0.07, borderColor: theme.hairline, borderWidth: 0.75 },
    })
    const pad = 0.22
    const iconSize = Math.min(0.42, cardH * 0.28)
    const hasIcon = pushItemIcon(out, `card${i + 1}_icon`, card, x + pad, y + pad, iconSize, theme)
    const headingY = hasIcon ? y + pad + iconSize + 0.1 : y + pad
    const innerW = cardW - pad * 2
    const headingSize = fitFont(card.heading, innerW, cardH * 0.45, 12.5, { lineSpacing: 1.05, min: 9, charW: 0.58 })
    const headingH = Math.min(textHeightIn(card.heading, headingSize, innerW - 0.19, 1.05, 0.58) + 0.06, cardH * 0.55)
    pushText(out, `card${i + 1}_heading`, card.heading, { x: x + pad, y: headingY, w: innerW, h: headingH }, {
      fontRole: 'heading', fontSize: headingSize, bold: true, color: theme.heading, valign: 'top', lineHeight: 1.05,
    }, slide, `cards[${i}].heading`)
    if (card.body) {
      const bodyH = Math.max(y + cardH - pad - (headingY + headingH + 0.02), 0.2)
      pushText(out, `card${i + 1}_body`, card.body, { x: x + pad, y: headingY + headingH + 0.02, w: innerW, h: bodyH }, {
        fontRole: 'body', fontSize: fitFont(card.body, innerW, bodyH, 10, { lineSpacing: 1.15, min: 7.5 }),
        color: theme.muted, valign: 'top', lineHeight: 1.15,
      }, slide, `cards[${i}].body`)
    }
  })
  return { background: { color: theme.background }, elements: out }
}

function genStatGrid(slide, theme, ctx) {
  const out = []
  const box = pushChrome(out, slide, theme, ctx)
  const stats = (slide.stats || []).slice(0, 4)
  const cols = Math.max(stats.length, 1)
  const colW = (CONTENT_W - GRID.gutter * (cols - 1)) / cols
  const cardH = Math.min(box.h, 2.1)
  const top = box.top + (box.h - cardH) / 2
  stats.forEach((stat, i) => {
    const x = GRID.margin + i * (colW + GRID.gutter)
    out.push({
      id: `stat${i + 1}_box`,
      type: 'shape',
      shape: 'roundRect',
      box: rbox({ x, y: top, w: colW, h: cardH }),
      style: { fill: theme.cardFill, radius: 0.07, borderColor: theme.hairline, borderWidth: 0.75 },
    })
    const pad = 0.22
    out.push({
      id: `stat${i + 1}_tick`,
      type: 'shape',
      shape: 'rect',
      box: rbox({ x: x + pad, y: top + pad, w: 0.42, h: 0.05 }),
      style: { fill: theme.accent },
    })
    const hasIcon = pushItemIcon(out, `stat${i + 1}_icon`, stat, x + colW - pad - 0.36, top + pad - 0.06, 0.36, theme)
    const valueW = colW - pad * 2 - (hasIcon ? 0.34 : 0)
    pushText(out, `stat${i + 1}_value`, stat.value, { x: x + pad - 0.02, y: top + pad + 0.14, w: valueW, h: cardH * 0.42 }, {
      fontRole: 'heading',
      fontSize: fitFont(stat.value, valueW, cardH * 0.42, TYPE.statValue, { min: 12, charW: 0.72, fitWord: true }),
      bold: true, color: theme.heading, valign: 'middle',
    }, slide, `stats[${i}].value`)
    if (stat.label) {
      const lh = cardH - pad * 2 - 0.14 - cardH * 0.42
      pushText(out, `stat${i + 1}_label`, stat.label, { x: x + pad, y: top + pad + 0.2 + cardH * 0.42, w: colW - pad * 2, h: lh }, {
        fontRole: 'body', fontSize: fitFont(stat.label, colW - pad * 2, lh, TYPE.small, { lineSpacing: 1.12, min: 8 }),
        color: theme.muted, valign: 'top', lineHeight: 1.12,
      }, slide, `stats[${i}].label`)
    }
  })
  return { background: { color: theme.background }, elements: out }
}

function genComparison(slide, theme, ctx) {
  const out = []
  const box = pushChrome(out, slide, theme, ctx)
  const colW = (CONTENT_W - GRID.gutter) / 2
  const sides = [
    { key: 'left', x: GRID.margin, title: slide.leftTitle, bullets: slide.leftBullets, fill: theme.cardFill, titleColor: theme.muted, bar: theme.hairline, border: theme.hairline, borderW: 0.75 },
    { key: 'right', x: GRID.margin + colW + GRID.gutter, title: slide.rightTitle, bullets: slide.rightBullets, fill: theme.accentSoft, titleColor: theme.heading, bar: theme.accent, border: theme.accent, borderW: 1 },
  ]
  for (const side of sides) {
    out.push({
      id: `${side.key}_box`,
      type: 'shape',
      shape: 'roundRect',
      box: rbox({ x: side.x, y: box.top, w: colW, h: box.h }),
      style: { fill: side.fill, radius: 0.07, borderColor: side.border, borderWidth: side.borderW },
    })
    const pad = 0.24
    out.push({
      id: `${side.key}_rule`,
      type: 'shape',
      shape: 'rect',
      box: rbox({ x: side.x + pad, y: box.top + pad + 0.02, w: 0.34, h: 0.045 }),
      style: { fill: side.bar },
    })
    pushText(out, `${side.key}_title`, side.title || '', { x: side.x + pad + 0.44, y: box.top + pad - 0.12, w: colW - pad * 2 - 0.44, h: 0.32 }, {
      fontRole: 'heading', fontSize: 12.5, bold: true, color: side.titleColor, valign: 'middle',
    }, slide, `${side.key}Title`)
    if (side.bullets?.length) {
      const bh = box.h - pad * 2 - 0.3
      pushBullets(out, `${side.key}_bullets`, side.bullets, { x: side.x + pad, y: box.top + pad + 0.3, w: colW - pad * 2, h: bh }, fitListFont(side.bullets, colW - pad * 2, bh, 11.5), theme)
    }
  }
  return { background: { color: theme.background }, elements: out }
}

function genTimeline(slide, theme, ctx) {
  const out = []
  const box = pushChrome(out, slide, theme, ctx)
  const phases = (slide.phases || []).slice(0, 5)
  const n = Math.max(phases.length, 1)
  const gap = 0.22
  const colW = (CONTENT_W - gap * (n - 1)) / n
  const nodeY = box.top + 0.42
  if (phases.length > 1) {
    out.push({
      id: 'axis',
      type: 'line',
      box: rbox({ x: GRID.margin + colW / 2, y: nodeY, w: CONTENT_W - colW, h: 0 }),
      style: { lineColor: theme.hairline, lineWidth: 1.25 },
    })
  }
  phases.forEach((phase, i) => {
    const x = GRID.margin + i * (colW + gap)
    const cx = x + colW / 2
    const nodeR = 0.17
    if (!pushItemIcon(out, `phase${i + 1}_icon`, phase, cx - 0.21, nodeY - 0.21, 0.42, theme)) {
      out.push({
        id: `phase${i + 1}_node`,
        type: 'shape',
        shape: 'ellipse',
        box: rbox({ x: cx - nodeR, y: nodeY - nodeR, w: nodeR * 2, h: nodeR * 2 }),
        style: { fill: theme.accent },
      })
      pushText(out, `phase${i + 1}_no`, String(i + 1), { x: cx - nodeR, y: nodeY - nodeR, w: nodeR * 2, h: nodeR * 2 }, {
        fontRole: 'heading', fontSize: 11, bold: true, color: theme.onAccent, align: 'center', valign: 'middle',
      })
    }
    let y = nodeY + 0.34
    if (phase.period) {
      pushText(out, `phase${i + 1}_period`, phase.period, { x, y, w: colW, h: 0.24 }, {
        fontRole: 'body', fontSize: 8.5, bold: true, color: theme.accent, align: 'center', uppercase: true, letterSpacing: 1.5, valign: 'middle',
      }, slide, `phases[${i}].period`)
      y += 0.26
    }
    pushText(out, `phase${i + 1}_label`, phase.label, { x, y, w: colW, h: 0.42 }, {
      fontRole: 'heading', fontSize: 12.5, bold: true, color: theme.heading, align: 'center', valign: 'top',
    }, slide, `phases[${i}].label`)
    if (phase.body) {
      const bh = Math.max(box.bottom - (y + 0.44), 0.3)
      pushText(out, `phase${i + 1}_body`, phase.body, { x: x + 0.05, y: y + 0.44, w: colW - 0.1, h: bh }, {
        fontRole: 'body', fontSize: fitFont(phase.body, colW - 0.1, bh, 9.5, { lineSpacing: 1.15, min: 7.5 }),
        color: theme.muted, align: 'center', valign: 'top', lineHeight: 1.15,
      }, slide, `phases[${i}].body`)
    }
  })
  return { background: { color: theme.background }, elements: out }
}

// --- composites (table / diagram / mined diagramSpec) ------------------------

// Harvey-ball glyphs for `cellStyle:"level"` tables (same map as decks.js)
const LEVEL_GLYPHS = { full: '●', partial: '◑', none: '○' }

// geometry ported from tableSlide in server/decks.js (native addTable): one
// bordered rect + one text per cell reproduces the same grid, colors and
// type. Dense tables that would blow the element budget return null (the
// slide stays legacy/unconvertible).
function genTable(slide, theme, ctx) {
  const out = []
  const box = pushChrome(out, slide, theme, ctx)
  const columns = slide.columns || []
  if (!columns.length) return null
  const rows = slide.rows || []
  const highlight = Number.isInteger(slide.highlightColumn) ? slide.highlightColumn : -1
  const isLevel = slide.cellStyle === 'level'
  const headerSize = columns.length >= 6 ? 9 : columns.length >= 4 ? 9.5 : 10.5
  const nRows = rows.length + 1
  if (out.length + nRows * columns.length * 2 > MAX_ELEMENTS_PER_SLIDE) return null
  const rowH = Math.min(0.5, Math.max(0.3, box.h / nRows))
  const firstColW = Math.min(3.2, CONTENT_W * 0.32)
  const otherW = (CONTENT_W - firstColW) / Math.max(columns.length - 1, 1)
  const colX = (ci) => GRID.margin + (ci === 0 ? 0 : firstColW + (ci - 1) * otherW)
  const colW = (ci) => (ci === 0 ? firstColW : otherW)
  const zebra = theme.cardFill === '#FFFFFF' ? blend('#000000', theme.background, 0.985) : theme.cardFill
  const cell = (idBase, ci, y, fill, text, style) => {
    out.push({
      id: `${idBase}_bg`,
      type: 'shape',
      shape: 'rect',
      box: rbox({ x: colX(ci), y, w: colW(ci), h: rowH }),
      style: { fill, borderColor: theme.hairline, borderWidth: 0.5 },
    })
    pushText(out, idBase, text, { x: colX(ci) + 0.02, y, w: colW(ci) - 0.04, h: rowH }, {
      valign: 'middle', align: ci === 0 ? 'left' : 'center', ...style,
    })
  }
  columns.forEach((c, ci) => {
    cell(`th${ci + 1}`, ci, box.top, ci === highlight ? theme.accent : theme.primary, c, {
      fontRole: 'heading', fontSize: headerSize, bold: true, color: theme.onPrimary,
    })
  })
  rows.forEach((r, ri) => {
    const y = box.top + rowH * (ri + 1)
    columns.forEach((_, ci) => {
      const rawCell = Array.isArray(r) ? r[ci] : r?.cells?.[ci]
      const raw = String(rawCell ?? '')
      const glyph = isLevel && ci > 0 ? LEVEL_GLYPHS[raw.trim().toLowerCase()] : null
      cell(`td${ri + 1}_${ci + 1}`, ci, y, ci === highlight ? theme.accentSoft : ri % 2 ? zebra : theme.background, glyph || raw, {
        fontRole: 'body',
        fontSize: glyph ? 15 : 10,
        bold: ci === 0,
        color: glyph ? (raw.trim().toLowerCase() === 'none' ? theme.faint : theme.accent) : ci === 0 ? theme.heading : theme.bodyText,
      })
    })
  })
  return { background: { color: theme.background }, elements: out }
}

// geometry ported from diagramSlide in server/decks.js: labeled chip columns,
// optional emphasized platform panel of stacked bands, accent arrows between
function genDiagram(slide, theme, ctx) {
  const out = []
  const box = pushChrome(out, slide, theme, ctx)
  const columns = (slide.columns || []).slice(0, 4)
  if (!columns.length) return null
  const arrowW = 0.3
  const weights = columns.map((c) => (c.emphasis ? 1.9 : 1))
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const availW = CONTENT_W - arrowW * (columns.length - 1)
  const labelH = 0.3
  let x = GRID.margin
  columns.forEach((col, i) => {
    const w = (availW * weights[i]) / totalWeight
    pushText(out, `col${i + 1}_label`, col.label || '', { x, y: box.top, w, h: labelH }, {
      fontRole: 'body', fontSize: 8.5, bold: true, color: theme.muted, uppercase: true, letterSpacing: 1.8, align: 'center', valign: 'middle',
    }, slide, `columns[${i}].label`)
    const areaTop = box.top + labelH + 0.08
    const areaH = box.h - labelH - 0.08
    if (col.emphasis || col.bands?.length) {
      out.push({
        id: `col${i + 1}_panel`,
        type: 'shape',
        shape: 'roundRect',
        box: rbox({ x, y: areaTop, w, h: areaH }),
        style: { fill: theme.primary, radius: 0.08 },
      })
      const bands = (col.bands || []).slice(0, 5)
      const pad = 0.14
      if (col.sublabel) {
        pushText(out, `col${i + 1}_sublabel`, col.sublabel, { x: x + pad, y: areaTop + 0.06, w: w - pad * 2, h: 0.26 }, {
          fontRole: 'body', fontSize: 8.5, color: theme.onPrimaryMuted, align: 'center', valign: 'middle',
        })
      }
      const bandsTop = areaTop + pad + (col.sublabel ? 0.28 : 0.06)
      const bandsH = areaH - (bandsTop - areaTop) - pad
      const bandGap = 0.1
      const bandH = (bandsH - bandGap * (bands.length - 1)) / Math.max(bands.length, 1)
      bands.forEach((band, bi) => {
        const by = bandsTop + bi * (bandH + bandGap)
        const isAccent = band.tone === 'accent'
        out.push({
          id: `col${i + 1}_band${bi + 1}_bg`,
          type: 'shape',
          shape: 'roundRect',
          box: rbox({ x: x + pad, y: by, w: w - pad * 2, h: bandH }),
          style: { fill: isAccent ? theme.accent : blend(theme.onPrimary, theme.primary, 0.88), radius: 0.05 },
        })
        pushText(out, `col${i + 1}_band${bi + 1}`, band.label || '', { x: x + pad + 0.08, y: by, w: w - pad * 2 - 0.16, h: bandH }, {
          fontRole: 'heading', fontSize: fitFont(band.label || '', w - pad * 2 - 0.16, bandH, 10, { min: 6 }),
          bold: true, color: isAccent ? theme.onAccent : theme.onPrimary, align: 'center', valign: 'middle',
        }, slide, `columns[${i}].bands[${bi}].label`)
      })
    } else {
      const items = (col.items || []).slice(0, 6)
      const chipGap = 0.12
      const chipH = Math.min(0.52, (areaH - chipGap * (items.length - 1)) / Math.max(items.length, 1))
      items.forEach((item, ii) => {
        const iy = areaTop + ii * (chipH + chipGap)
        out.push({
          id: `col${i + 1}_item${ii + 1}_bg`,
          type: 'shape',
          shape: 'roundRect',
          box: rbox({ x, y: iy, w, h: chipH }),
          style: { fill: theme.cardFill, radius: 0.05, borderColor: theme.hairline, borderWidth: 0.75 },
        })
        const iconSize = Math.min(0.3, chipH - 0.14)
        const hasIcon = pushItemIcon(out, `col${i + 1}_item${ii + 1}_icon`, item, x + 0.1, iy + (chipH - iconSize) / 2, iconSize, theme)
        pushText(out, `col${i + 1}_item${ii + 1}`, item.label || '', {
          x: x + (hasIcon ? 0.1 + iconSize + 0.08 : 0.12), y: iy, w: w - (hasIcon ? 0.28 + iconSize : 0.24), h: chipH,
        }, {
          fontRole: 'body', fontSize: fitFont(item.label || '', w - (hasIcon ? 0.28 + iconSize : 0.24), chipH, 9.5, { min: 6 }),
          bold: true, color: theme.heading, valign: 'middle', lineHeight: 1.0,
        }, slide, `columns[${i}].items[${ii}].label`)
      })
    }
    if (i < columns.length - 1) {
      const ay = box.top + labelH + 0.08 + (box.h - labelH - 0.08) / 2
      out.push({
        id: `arrow${i + 1}`,
        type: 'shape',
        shape: 'triangle',
        rotate: 90,
        box: rbox({ x: x + w + 0.07, y: ay - 0.08, w: 0.16, h: 0.16 }),
        style: { fill: theme.accent },
      })
    }
    x += w + arrowW
  })
  if (out.length > MAX_ELEMENTS_PER_SLIDE) return null
  return { background: { color: theme.background }, elements: out }
}

// same plate rule as diagramPlateColor in server/decks.js / the preview —
// '#'-hex dialect (keep the math in sync across the three)
export function minedPlateColor(spec, backgroundHex) {
  const bg = luminance(backgroundHex)
  const fills = (spec.shapes || []).filter((s) => s.color)
  if (!fills.length) return null
  const area = fills.reduce((a, s) => a + s.w * s.h, 0) || 0.0001
  const wavg = (f) => fills.reduce((a, s) => a + f(s) * s.w * s.h, 0) / area
  const meanDistance = wavg((s) => Math.abs(luminance(hexOr(s.color, backgroundHex)) - bg))
  if (meanDistance >= 0.18) return null
  const designedBg = spec.bg ? hexOr(spec.bg, null) : null
  if (designedBg && Math.abs(luminance(designedBg) - bg) >= 0.18) return designedBg
  const fillLum = wavg((s) => luminance(hexOr(s.color, backgroundHex)))
  return fillLum < 0.5 ? blend('#FFFFFF', backgroundHex, 0.06) : blend('#000000', backgroundHex, 0.82)
}

// mined geoms (sanitizeDiagramSpec's DIAGRAM_GEOMS) → the element model's
// SHAPE_KINDS; directional arrows become a rotated rightArrow
const MINED_GEOM_MAP = {
  rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse', diamond: 'diamond', triangle: 'triangle',
  chevron: 'chevron', rightArrow: 'rightArrow', homePlate: 'chevron', pie: 'ellipse', can: 'roundRect',
  leftArrow: ['rightArrow', 180], upArrow: ['rightArrow', 270], downArrow: ['rightArrow', 90], leftRightArrow: 'rightArrow',
}

// geometry ported from drawMinedDiagram in server/decks.js: the template's
// own mined vector art scaled into the body box, one element per shape/label/
// connector. Returns false (→ slide stays legacy) when the spec is too dense
// for the element budget.
function pushMinedDiagram(out, spec, box, theme) {
  const shapes = spec.shapes || []
  const connectors = spec.connectors || []
  const budget = shapes.length + shapes.filter((s) => s.text).length + connectors.length + 1
  if (out.length + budget > MAX_ELEMENTS_PER_SLIDE) return false
  const aspect = spec.aspect || SLIDE_W / SLIDE_H
  const srcW = 10
  const srcH = srcW / aspect
  const all = [...shapes, ...connectors]
  if (!all.length) return false
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

  const plate = minedPlateColor(spec, theme.background)
  if (plate) {
    const pad = 0.16
    out.push({
      id: 'diag_plate',
      type: 'shape',
      shape: 'roundRect',
      box: rbox({ x: ox - pad, y: oy - pad, w: bw * k + pad * 2, h: bh * k + pad * 2 }),
      style: { fill: plate, radius: 0.08, borderColor: theme.hairline, borderWidth: 0.75 },
    })
  }
  shapes.forEach((sh, i) => {
    const b = { x: X(sh.x), y: Y(sh.y), w: sh.w * srcW * k, h: sh.h * srcH * k }
    const mapped = MINED_GEOM_MAP[sh.geom] || 'rect'
    const [geom, geomRot] = Array.isArray(mapped) ? mapped : [mapped, 0]
    const fill = sh.color ? hexOr(sh.color, theme.cardFill) : 'none'
    const el = {
      id: `diag_s${i + 1}`,
      type: 'shape',
      shape: geom,
      box: rbox(b),
      style: { fill },
    }
    const rot = ((sh.rot || 0) + geomRot) % 360
    if (rot) el.rotate = rot
    if (sh.line) {
      el.style.borderColor = hexOr(sh.line, theme.hairline)
      el.style.borderWidth = 1
    } else if (!sh.color) {
      el.style.borderColor = theme.hairline
      el.style.borderWidth = 1
    }
    out.push(el)
    if (sh.text) {
      const base = Math.max((sh.fontPt || 12) * k, 5)
      const fillHex = sh.color ? hexOr(sh.color, theme.cardFill) : plate || theme.background
      const txt = {
        id: `diag_s${i + 1}_txt`,
        type: 'text',
        box: rbox(b),
        style: {
          fontRole: 'body',
          fontSize: fitFont(sh.text, b.w, b.h, base, { lineSpacing: 1.05, min: 5, fitWord: true, insets: 0.04 }),
          bold: !!sh.bold,
          color: sh.textColor ? hexOr(sh.textColor, contrastOn(fillHex)) : contrastOn(fillHex),
          align: 'center', valign: 'middle', lineHeight: 1.05,
        },
        text: String(sh.text),
      }
      if (sh.rot) txt.rotate = sh.rot
      out.push(txt)
    }
  })
  connectors.forEach((c, i) => {
    const el = {
      id: `diag_c${i + 1}`,
      type: 'line',
      box: rbox({ x: X(c.x), y: Y(c.y), w: c.w * srcW * k, h: c.h * srcH * k }),
      style: {
        lineColor: hexOr(c.color, theme.muted),
        lineWidth: Math.round(Math.max(1, 1.25 * k) * 4) / 4,
        ...(c.arrow ? { arrowEnd: true } : {}),
      },
    }
    if (c.flipH) el.flipH = true
    if (c.flipV) el.flipV = true
    out.push(el)
  })
  return true
}

function genImage(slide, theme, ctx) {
  const out = []
  const box = pushChrome(out, slide, theme, ctx)
  // a user-uploaded image always wins over a baked mined diagram (same rule
  // as imageSlide in server/decks.js)
  if (!slide.imageDataUrl && slide.diagramSpec?.shapes?.length) {
    const ok = pushMinedDiagram(out, slide.diagramSpec, { x: GRID.margin + 0.1, y: box.top, w: CONTENT_W - 0.2, h: box.h }, theme)
    if (!ok) return null
    return { background: { color: theme.background }, elements: out }
  }
  if (slide.imageDataUrl) {
    out.push({
      id: 'picture',
      type: 'image',
      box: rbox({ x: GRID.margin + 0.2, y: box.top, w: CONTENT_W - 0.4, h: box.h }),
      style: {},
      imageDataUrl: slide.imageDataUrl,
    })
  } else {
    out.push({
      id: 'placeholder_box',
      type: 'shape',
      shape: 'roundRect',
      box: rbox({ x: GRID.margin + 0.2, y: box.top, w: CONTENT_W - 0.4, h: box.h }),
      style: { fill: 'none', radius: 0.07, borderColor: theme.hairline, borderWidth: 1, borderDash: 'dash' },
    })
    pushText(out, 'placeholder_text', slide.body || 'Imagem a adicionar no Estúdio de Slides', { x: GRID.margin + 0.4, y: box.top, w: CONTENT_W - 0.8, h: box.h }, {
      fontRole: 'body', fontSize: 12, italic: true, color: theme.faint, align: 'center', valign: 'middle',
    })
  }
  return { background: { color: theme.background }, elements: out }
}

const GENERATORS = {
  title: genTitle,
  section: genSection,
  closing: genClosing,
  quote: genQuote,
  bullets: genBullets,
  'two-column': genTwoColumn,
  agenda: genAgenda,
  cards: genCards,
  'stat-grid': genStatGrid,
  comparison: genComparison,
  timeline: genTimeline,
  image: genImage,
  table: genTable,
  diagram: genDiagram,
}

export const CONVERTIBLE_LAYOUTS = new Set(Object.keys(GENERATORS))

// Semantic layouts the export renders through the unified engine path (dumb
// painter over materializeSlide) rather than the legacy pptxgenjs builders.
// The React preview mirrors this EXACT set so what you edit on screen is
// painted by the same materialization the .pptx uses. Deliberately excluded
// (kept on the legacy/hand-JSX path both sides):
//  - table / chart: native pptx table + editable chart, richer than a shape grid
//  - diagram, and any layout carrying a mined diagramSpec: legacy typesets
//    mined labels with insets the element model doesn't carry
// A slide with user `styles` overrides also stays off the engine path (the
// export gate in server/decks.js excludes hasStyles) — the preview mirrors that.
export const ENGINE_LAYOUTS = new Set([
  'title', 'section', 'closing', 'quote', 'bullets', 'two-column',
  'agenda', 'cards', 'stat-grid', 'comparison', 'timeline', 'image',
])

// Converts one slide into { background, elements } for the dumb painters.
// - freeform slides: pass-through of their persisted elements
// - supported semantic layouts (incl. table/diagram/image-with-diagramSpec):
//   one-shot generation; a generator may return null when the composite is
//   too dense for the element budget — the slide then stays on the legacy
//   path (and the Studio hides the convert button)
// - chart: always null — the native pptx chart stays editable in PowerPoint,
//   baking it into shapes would degrade the export
export function materializeSlide(slide, theme, ctx = {}) {
  if (!slide) return null
  if (slide.layout === 'freeform' || Array.isArray(slide.elements)) {
    return { background: slide.background || null, elements: slide.elements || [] }
  }
  const gen = GENERATORS[slide.layout]
  if (!gen) return null
  const result = gen(slide, theme, ctx)
  if (!result) return null
  result.elements = result.elements.slice(0, MAX_ELEMENTS_PER_SLIDE)
  return result
}

export function materializeDeck(deck, theme, ctx = {}) {
  let sectionNo = 0
  const meta = deck?.audience || deck?.title || ''
  return (deck?.slides || []).map((s, i) => {
    if (s.layout === 'section') sectionNo++
    return materializeSlide(s, theme, {
      ...ctx,
      index: i,
      total: deck.slides.length,
      pageNumber: i + 1,
      sectionNo,
      meta,
      audience: deck?.audience || '',
      deckTitle: deck?.title || '',
      author: deck?.author || '',
    })
  })
}
