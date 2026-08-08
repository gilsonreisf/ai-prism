// DOM → slide paint-ops extractor for the pure-HTML deck export (task #29).
// The Claude Design .pptx export is DOM→native shapes, element by element (we
// dissected their file: every div/h2/td becomes a positioned <p:sp>, text a
// real <a:t>, backgrounds rect/roundRect solidFill — no rasterization). The
// rendered geometry only exists in the browser, so we walk each slide's live
// iframe here and emit a flat list of ops the server turns into pptxgenjs
// shapes. See project_pure_html_deck_engine.
//
// Coordinates are in px on the fixed 1280×720 stage; the server scales to the
// 10×5.625in canvas. Everything stays editable in PowerPoint.

const STAGE_W = 1280
const STAGE_H = 720
// px (on the 1280-wide stage) → points on the 10in-wide pptx canvas:
// 10in × 72pt/in ÷ 1280px = 0.5625. Using the screen 0.75 (=72/96) made every
// font 1.33× too big → text overflowed its measured box and collided. This is
// the correct stage-relative factor.
const PX_TO_PT = (10 * 72) / STAGE_W

// parse "rgb(a)(…)" → { hex, a }; returns null for transparent/none.
function parseColor(c) {
  if (!c) return null
  const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c)
  if (!m) return null
  const a = m[4] != null ? parseFloat(m[4]) : 1
  if (a === 0) return null
  const hex = [m[1], m[2], m[3]].map((v) => Math.round(parseFloat(v)).toString(16).padStart(2, '0')).join('')
  return { hex: hex.toUpperCase(), a }
}

// Universal-font mapping (matches the Claude Design "Universal fonts" option we
// saw map DM Sans→Arial, DM Mono→Courier New): any family → a web-safe face so
// the .pptx opens identically on any machine. Brand fidelity is a future toggle.
function universalFont(family) {
  const f = (family || '').toLowerCase()
  if (/mono|courier|consolas|menlo/.test(f)) return 'Courier New'
  if (/georgia|times|serif/.test(f) && !/sans/.test(f)) return 'Georgia'
  return 'Arial'
}

const weightToBold = (w) => {
  const n = parseInt(w, 10)
  return Number.isFinite(n) ? n >= 600 : w === 'bold' || w === 'bolder'
}

// Is this element a leaf text container? — it has non-whitespace text and no
// BLOCK-level element children (only text nodes / inline formatting like span,
// b, i, a). Those get one text op with inline runs; block containers instead
// contribute their background as a rect and recurse.
function isTextLeaf(el, win) {
  let hasText = false
  for (const node of el.childNodes) {
    if (node.nodeType === 3 && node.textContent.trim()) hasText = true
    else if (node.nodeType === 1) {
      const d = win.getComputedStyle(node).display
      if (d && !/inline/.test(d)) return false // a block child → not a leaf
    }
  }
  return hasText
}

// Apply CSS text-transform to the raw text so an uppercased eyebrow exports
// uppercased (we read textContent, which is the SOURCE case).
function applyTransform(text, transform) {
  if (transform === 'uppercase') return text.toUpperCase()
  if (transform === 'lowercase') return text.toLowerCase()
  if (transform === 'capitalize') return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase())
  return text
}

// Build inline runs (text + per-run color/weight/italic) from a text-leaf's
// descendants, so a heading with a colored <span> keeps that color in the pptx.
function buildRuns(el, win) {
  const runs = []
  const styleOf = (cs) => ({
    font: universalFont(cs.fontFamily),
    size: Math.round(parseFloat(cs.fontSize) * PX_TO_PT * 10) / 10, // px→pt (stage-relative)
    color: parseColor(cs.color)?.hex || '000000',
    bold: weightToBold(cs.fontWeight),
    italic: cs.fontStyle === 'italic',
    transform: cs.textTransform, // uppercase/lowercase/capitalize/none
    // letter-spacing px → points (pptxgenjs charSpacing is in points)
    tracking: cs.letterSpacing && cs.letterSpacing !== 'normal' ? Math.round(parseFloat(cs.letterSpacing) * PX_TO_PT * 10) / 10 : 0,
  })
  const walk = (node, inherited) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = applyTransform(child.textContent, inherited.transform)
        if (text) runs.push({ text, ...inherited })
      } else if (child.nodeType === 1) {
        const cs = win.getComputedStyle(child)
        walk(child, { ...inherited, ...styleOf(cs) })
      }
    }
  }
  const base = win.getComputedStyle(el)
  walk(el, styleOf(base))
  // merge adjacent runs with identical styling (fewer <a:r> in the pptx)
  const merged = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (last && last.font === r.font && last.size === r.size && last.color === r.color && last.bold === r.bold && last.italic === r.italic && last.tracking === r.tracking) {
      last.text += r.text
    } else merged.push({ ...r })
  }
  return merged.filter((r) => r.text.length)
}

// Serialize an inline <svg> with its COMPUTED colors baked in, so token-based
// fills (var(--accent) etc.) survive as concrete rgb when the SVG is lifted out
// of the document (where :root vars no longer resolve → would render black).
function serializeSvgWithComputedColors(svg, win, w, h) {
  const clone = svg.cloneNode(true)
  // walk original + clone in lockstep; copy computed paint props onto the clone
  const origNodes = [svg, ...svg.querySelectorAll('*')]
  const cloneNodes = [clone, ...clone.querySelectorAll('*')]
  const PAINT = ['fill', 'stroke', 'stopColor', 'stop-color', 'color', 'strokeWidth', 'opacity', 'fillOpacity', 'strokeOpacity']
  for (let i = 0; i < origNodes.length; i++) {
    const cs = win.getComputedStyle(origNodes[i])
    const c = cloneNodes[i]
    if (!c.setAttribute) continue
    // resolve fill/stroke to concrete values (computed style already resolves var())
    const fill = cs.fill
    if (fill && fill !== 'none') c.setAttribute('fill', fill)
    const stroke = cs.stroke
    if (stroke && stroke !== 'none') c.setAttribute('stroke', stroke)
    const sw = cs.strokeWidth
    if (sw && sw !== '0px') c.setAttribute('stroke-width', parseFloat(sw))
    const stop = cs.stopColor
    if (stop && stop !== 'rgb(0, 0, 0)') c.setAttribute('stop-color', stop)
    // strip inline style so the baked attributes win (style referenced var())
    if (c.hasAttribute('style')) c.removeAttribute('style')
  }
  clone.setAttribute('width', w)
  clone.setAttribute('height', h)
  const xml = new win.XMLSerializer().serializeToString(clone)
  return 'data:image/svg+xml;base64,' + win.btoa(unescape(encodeURIComponent(xml)))
}

// Walk one slide's root element, producing ops in paint order (DOM order ≈
// z-order for static flow; absolutely-positioned nodes still come out in tree
// order, which matches how they were authored).
export function extractSlideOps(slideRoot, win) {
  const ops = []
  const rootRect = slideRoot.getBoundingClientRect()
  const sx = STAGE_W / rootRect.width
  const sy = STAGE_H / rootRect.height
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return {
      x: Math.round((r.left - rootRect.left) * sx),
      y: Math.round((r.top - rootRect.top) * sy),
      w: Math.round(r.width * sx),
      h: Math.round(r.height * sy),
    }
  }

  const visit = (el) => {
    const cs = win.getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return
    const b = box(el)
    if (b.w <= 0 || b.h <= 0) return

    // 1) background / border → rect (roundRect when border-radius)
    const bg = parseColor(cs.backgroundColor)
    const bw = parseFloat(cs.borderTopWidth) || 0
    const border = bw > 0 ? parseColor(cs.borderTopColor) : null
    if (bg || border) {
      const radius = parseFloat(cs.borderTopLeftRadius) || 0
      ops.push({
        type: 'rect',
        ...b,
        fill: bg?.hex || null,
        radius: Math.round(radius * sx),
        line: border ? { color: border.hex, width: Math.max(0.5, bw * sx) } : null,
      })
    }

    // 2) <img> → image (only real embedded data; DS asset URLs resolve at
    // render — captured as their src when it's a data URI)
    if (el.tagName === 'IMG') {
      const src = el.currentSrc || el.src || ''
      if (src.startsWith('data:image')) ops.push({ type: 'image', ...b, dataUrl: src })
      return
    }
    // inline SVG (charts/icons) → serialize to a data URI, drawn as one image.
    // CRITICAL: the SVG uses var(--accent)/var(--primary) tokens that resolve
    // via the document ':root'. Serialized standalone, those vars are undefined
    // and the shapes render BLACK. So we bake each element's COMPUTED fill/
    // stroke (concrete rgb) onto a clone before serializing. Also stamp explicit
    // width/height so the standalone SVG has intrinsic size.
    if (el.tagName === 'svg') {
      try {
        const dataUrl = serializeSvgWithComputedColors(el, win, b.w, b.h)
        if (dataUrl) ops.push({ type: 'image', ...b, dataUrl })
      } catch {
        /* unserializable — skip */
      }
      return
    }

    // 3) text leaf → text op; else recurse into children
    if (isTextLeaf(el, win)) {
      const runs = buildRuns(el, win)
      if (runs.length) {
        // inset the text box by the element's padding, so a table cell's text
        // sits with the same breathing room it has on screen (14–16px pads).
        const pl = (parseFloat(cs.paddingLeft) || 0) * sx
        const pr = (parseFloat(cs.paddingRight) || 0) * sx
        const pt = (parseFloat(cs.paddingTop) || 0) * sy
        const pb = (parseFloat(cs.paddingBottom) || 0) * sy
        // vertical centering matches CSS line-box centering in cells/kickers
        const valign = /middle|center/.test(cs.display) || cs.display === 'flex' || cs.alignItems === 'center' ? 'middle' : 'top'
        ops.push({
          type: 'text',
          x: Math.round(b.x + pl),
          y: Math.round(b.y + pt),
          w: Math.max(Math.round(b.w - pl - pr), 8),
          h: Math.max(Math.round(b.h - pt - pb), 8),
          runs,
          align: cs.textAlign === 'center' ? 'center' : cs.textAlign === 'right' || cs.textAlign === 'end' ? 'right' : 'left',
          valign,
          lineHeight: cs.lineHeight && cs.lineHeight !== 'normal' ? parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) : 1.15,
        })
      }
      return
    }
    for (const child of el.children) visit(child)
  }

  // start from the slide root's children (the root itself is the full-bleed bg,
  // handled as its own rect if colored)
  const rootCs = win.getComputedStyle(slideRoot)
  const rootBg = parseColor(rootCs.backgroundColor)
  ops.push({ type: 'rect', x: 0, y: 0, w: STAGE_W, h: STAGE_H, fill: rootBg?.hex || 'FFFFFF', radius: 0, line: null })
  for (const child of slideRoot.children) visit(child)
  return ops
}

// Extract ops for every slide iframe in order. `frames` = array of iframe
// elements (the Studio's rail/stage frames render the exact slides).
export function extractDeckOps(frames) {
  const slides = []
  for (const frame of frames) {
    try {
      const doc = frame.contentDocument
      const win = frame.contentWindow
      if (!doc || !win) continue
      const root = doc.querySelector('section') || doc.body
      slides.push({ w: STAGE_W, h: STAGE_H, ops: extractSlideOps(root, win) })
    } catch {
      slides.push({ w: STAGE_W, h: STAGE_H, ops: [] }) // cross-origin/blank — skip
    }
  }
  return slides
}

// Build the same srcDoc HtmlSlideFrame uses (tokens injected), so an off-screen
// export frame renders IDENTICALLY to what the Studio shows. Duplicated minimal
// wrapper here to avoid a circular import with the React component.
function exportSrcDoc(sectionHtml, tokenStyle) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style data-ds-tokens>${tokenStyle}</style>
<style>html,body{margin:0;padding:0;width:${STAGE_W}px;height:${STAGE_H}px;overflow:hidden;background:var(--background,#fff);font-family:var(--font-body,var(--font-sans,system-ui));}
section.slide,section{box-sizing:border-box;width:${STAGE_W}px;height:${STAGE_H}px;position:relative;overflow:hidden;}</style>
</head><body>${sectionHtml || ''}</body></html>`
}

// Renders each slide full-size (1280×720) in a hidden iframe, waits for load +
// webfonts, and extracts native paint-ops. Returns [{w,h,ops}] for the server.
// `tokenStyleBuilder` builds the DS token CSS (buildDeckTokenStyle from
// HtmlSlideFrame) so brand vars resolve exactly as on screen.
export async function extractOpsFromSlides(slidesHtml, tokenStyleBuilder) {
  const tokenStyle = typeof tokenStyleBuilder === 'function' ? tokenStyleBuilder() : tokenStyleBuilder || ''
  const out = []
  for (const html of slidesHtml || []) {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-same-origin')
    frame.style.cssText = `position:fixed;left:-99999px;top:0;width:${STAGE_W}px;height:${STAGE_H}px;border:0;visibility:hidden;`
    document.body.appendChild(frame)
    try {
      await new Promise((resolve) => {
        frame.onload = resolve
        frame.srcdoc = exportSrcDoc(html, tokenStyle)
      })
      const doc = frame.contentDocument
      const win = frame.contentWindow
      // let webfonts settle so geometry matches the on-screen render
      try {
        if (doc.fonts?.ready) await doc.fonts.ready
      } catch {
        /* fonts API unavailable — proceed */
      }
      await new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r)))
      const root = doc.querySelector('section') || doc.body
      out.push({ w: STAGE_W, h: STAGE_H, ops: extractSlideOps(root, win) })
    } catch {
      out.push({ w: STAGE_W, h: STAGE_H, ops: [] })
    } finally {
      frame.remove()
    }
  }
  return out
}
