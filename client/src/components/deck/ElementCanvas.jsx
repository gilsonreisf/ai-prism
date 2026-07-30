import { useEffect, useRef, useState } from 'react'
import { ElementView, resolvePreviewTheme, useTemplateFonts } from '../DeckSlidePreview.jsx'
import { SLIDE_W, SLIDE_H, GRID, BOX_LIMITS, flattenElements } from '../../../../shared/deckLayout.js'
import { resolveThemeColor } from '../../../../shared/deckTheme.js'
import {
  findNode,
  findParent,
  updateNode,
  removeNodes,
  insertNode,
  cloneWithNewIds,
  groupNodes,
  ungroupNode,
  isStackChild,
  alignmentTargets,
} from '../../lib/deckTree.js'
import { setClipboard, getClipboard, clipboardHasContent } from '../../lib/deckClipboard.js'

// The Figma-style editing canvas for FREEFORM slides, now TREE-aware: the
// persisted elements form a tree (groups/stacks), painting goes through the
// same flattenElements both exporters use, and the flatten-time `boxes` map
// (id → absolute box for EVERY node, groups included) is the single source of
// layout truth for hit-testing and selection frames — the canvas never
// re-implements layout math.
//
// Selection semantics (Figma): click selects the ancestor at the current
// scope level (scope null = slide root); double-click a group drills into it
// (scope) and selects the child under the pointer; double-click a text edits
// it inline wherever it lives; Esc pops one scope level, then clears; shift-
// click toggles; dragging empty canvas draws a marquee over the scope's
// children. Stack-managed children are not draggable — their position is
// computed (reorder them in the layer tree or with Cmd+]/[).
//
// View transform (Phase 1): the stage lives inside a clipping mat and carries
// a scale(zoom)·translate(pan) transform. Pointer math reads the STAGE's
// getBoundingClientRect, which already reflects the transform, so every inch
// conversion is zoom/pan-correct with no extra bookkeeping. Ctrl/⌘+wheel zooms
// toward the cursor; Space-drag or middle-drag pans.

const SNAP_IN = 1 / 16
const SNAP_THRESHOLD = 0.07
const GUIDE_SNAP = 0.05 // element-to-element alignment snap (tighter than margins)
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const ZOOM_MIN = 0.5
const ZOOM_MAX = 4
const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4]

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))
const r2 = (v) => Math.round(v * 100) / 100

function snapTo(v, targets, threshold = SNAP_THRESHOLD) {
  for (const t of targets) {
    if (Math.abs(v - t) <= threshold) return t
  }
  return Math.round(v / SNAP_IN) * SNAP_IN
}

// snap a value against alignment targets, returning the matched target (for
// drawing a guide) or null — separate from snapTo so callers can render lines
function snapAlign(v, targets, threshold = GUIDE_SNAP) {
  let best = null
  let bestD = threshold
  for (const t of targets) {
    const d = Math.abs(v - t)
    if (d <= bestD) {
      bestD = d
      best = t
    }
  }
  return best
}

// proportionally rescale a plain group's children when its frame resizes
// (stack groups skip this — their layout recomputes from the new frame)
function scaleChildren(node, fx, fy) {
  if (node.type !== 'group' || node.stack || !node.children) return node
  return {
    ...node,
    children: node.children.map((c) => {
      const scaled = {
        ...c,
        box: { x: r2((c.box?.x || 0) * fx), y: r2((c.box?.y || 0) * fy), ...(c.box?.w != null ? { w: r2(c.box.w * fx) } : {}), ...(c.box?.h != null ? { h: r2(c.box.h * fy) } : {}) },
      }
      return scaleChildren(scaled, fx, fy)
    }),
  }
}

export default function ElementCanvas({
  slide,
  template,
  selectedIds = [],
  onSelect,
  scopeId = null,
  onScope,
  onChangeElements, // (nextElements, { commit }) — commit=true snapshots history first
  tool = null, // armed create tool: { type, shape?, extra? } | null
  onCreateElement, // (type, box, extra) → adds a node, returns its id
  onToolDone, // disarm the tool after one create
  className = '',
}) {
  const theme = resolvePreviewTheme(template)
  useTemplateFonts(template)
  const iconById = new Map((template?.iconAssets || []).map((a) => [a.id, a]))
  const clipRef = useRef(null)
  const wrapRef = useRef(null) // the transformed stage — pointer math reads this
  const dragRef = useRef(null) // { mode, ids, handle, startPx, startBoxes, startAbs, moved, targets }
  const panRef = useRef(null) // { startPx, startPan }
  const createRef = useRef(null) // { x0, y0 } inches while drawing a new element
  const [createBox, setCreateBox] = useState(null) // live preview rect (inches)
  const [editingText, setEditingText] = useState(null) // source node id being inline-edited
  const [marquee, setMarquee] = useState(null) // { x0, y0, x1, y1 } inches
  const [guides, setGuides] = useState(null) // { v:[{at,from,to}], h:[...] } absolute inches
  const [menu, setMenu] = useState(null) // { x, y } clip-relative px for the context menu
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const editRef = useRef(null)

  const elements = slide?.elements || []

  // flatten once per render: paint list + absolute boxes for every node
  const boxes = new Map()
  let flat = []
  try {
    flat = flattenElements(elements, theme, { boxes })
  } catch {
    flat = []
  }

  // ancestor chains (root → node) for scope-aware click target resolution
  const chains = new Map()
  const buildChains = (list, prefix) => {
    for (const el of list || []) {
      const chain = [...prefix, el.id]
      chains.set(el.id, chain)
      if (el.children) buildChains(el.children, chain)
    }
  }
  buildChains(elements, [])

  const targetFor = (srcId) => {
    const chain = chains.get(srcId) || [srcId]
    let idx = 0
    if (scopeId) {
      const i = chain.indexOf(scopeId)
      if (i !== -1 && i < chain.length - 1) idx = i + 1
    }
    // deep selection (progressive click-through): a selected node on the
    // chain stays the click target (so pressing it drags IT, not the outer
    // group), and a selected SIBLING keeps clicks at that same depth —
    // clicking around inside an entered group doesn't pop back to the root
    for (const sid of selectedIds) {
      const schain = chains.get(sid) || []
      const parent = schain[schain.length - 2]
      const i = parent ? chain.indexOf(parent) : -1
      if (i !== -1 && i + 1 > idx && i + 1 < chain.length) idx = i + 1
      const j = chain.indexOf(sid)
      if (j > idx) idx = j
    }
    return chain[idx]
  }

  const scopeChildren = scopeId ? findNode(elements, scopeId)?.children || [] : elements

  const pxPerIn = () => (wrapRef.current?.getBoundingClientRect().width || 800) / SLIDE_W
  const toIn = (ev) => {
    const rect = wrapRef.current.getBoundingClientRect()
    return { x: ((ev.clientX - rect.left) / rect.width) * SLIDE_W, y: ((ev.clientY - rect.top) / rect.height) * SLIDE_H }
  }

  const setElements = (next, commit = false) => onChangeElements(next, { commit })

  const patchNodeBox = (els, id, boxPatch) =>
    updateNode(els, id, (n) => ({ ...n, box: { ...n.box, ...boxPatch } }))

  // --- selection ---------------------------------------------------------------

  const select = (ids) => onSelect(Array.isArray(ids) ? ids : ids ? [ids] : [])

  const clickSelect = (ev, srcId) => {
    const target = targetFor(srcId)
    // clicking outside the open group's subtree exits the scope
    if (scopeId && !(chains.get(srcId) || []).includes(scopeId)) onScope?.(null)
    if (ev.shiftKey) {
      select(selectedIds.includes(target) ? selectedIds.filter((i) => i !== target) : [...selectedIds, target])
    } else if (!selectedIds.includes(target)) {
      select([target])
    }
    return target
  }

  // --- drag / resize -----------------------------------------------------------

  const beginDrag = (ev, srcId, mode, handle = null) => {
    if (editingText) return
    if (ev.button === 1 || spaceHeld) return // middle-button / space = pan, not drag
    ev.preventDefault()
    ev.stopPropagation()
    setMenu(null)
    // clicking (without dragging) a node that is already the sole selection
    // drills one level deeper toward the clicked leaf — resolved on pointerup
    const wasSole = selectedIds.length === 1 && selectedIds[0] === targetFor(srcId)
    const target = clickSelect(ev, srcId)
    const ids = ev.shiftKey ? null : selectedIds.includes(target) ? selectedIds : [target]
    if (!ids) return // shift-click adjusts selection, never drags
    // a stack child has no free position (the auto-layout places it) —
    // dragging it REORDERS it among its siblings instead of moving a box
    const reorder = mode === 'move' && ids.length === 1 && isStackChild(elements, ids[0])
    const movable = ids.filter((id) => !isStackChild(elements, id))
    dragRef.current = {
      mode: reorder ? 'reorder' : mode,
      ids: mode === 'resize' ? [target] : reorder ? ids : movable,
      handle,
      startPx: { x: ev.clientX, y: ev.clientY },
      startBoxes: new Map(ids.map((id) => [id, { ...(findNode(elements, id)?.box || {}) }])),
      startAbs: new Map(ids.map((id) => [id, boxes.get(id)])),
      moved: false,
      // element-to-element alignment targets (everything not being dragged)
      targets: alignmentTargets(elements, theme, ids),
      deepen: mode === 'move' && !ev.shiftKey && wasSole ? { srcId, target } : null,
    }
    ev.currentTarget.setPointerCapture?.(ev.pointerId)
  }

  const onPointerMove = (ev) => {
    if (panRef.current) {
      setPan({ x: panRef.current.startPan.x + (ev.clientX - panRef.current.startPx.x), y: panRef.current.startPan.y + (ev.clientY - panRef.current.startPx.y) })
      return
    }
    if (createRef.current) {
      const p = toIn(ev)
      const { x0, y0 } = createRef.current
      const x = clamp(p.x, 0, SLIDE_W)
      const y = clamp(p.y, 0, SLIDE_H)
      setCreateBox({ x: Math.min(x0, x), y: Math.min(y0, y), w: Math.abs(x - x0), h: Math.abs(y - y0) })
      return
    }
    const d = dragRef.current
    if (d) {
      const ppi = pxPerIn()
      let dx = (ev.clientX - d.startPx.x) / ppi
      let dy = (ev.clientY - d.startPx.y) / ppi
      if (!d.moved && Math.abs(dx) < 0.02 && Math.abs(dy) < 0.02) return
      if (!d.ids.length) return
      if (!d.moved) {
        d.moved = true
        onChangeElements(elements, { commit: true, snapshotOnly: true })
      }
      const xGuides = [GRID.margin, SLIDE_W / 2, SLIDE_W - GRID.margin]
      const yGuides = [GRID.margin, SLIDE_H / 2, SLIDE_H - GRID.margin]
      if (d.mode === 'reorder') {
        // live-reorder a stack child: the cursor's main-axis position against
        // the visible siblings' midpoints picks the insertion slot
        const id = d.ids[0]
        const { parent, index } = findParent(elements, id)
        if (!parent?.stack || index === -1) return
        const dirRow = parent.stack.direction === 'row'
        const p = toIn(ev)
        const coord = dirRow ? p.x : p.y
        let slot = 0
        for (const s of parent.children || []) {
          if (s.id === id || s.hidden) continue
          const b = boxes.get(s.id)
          if (b && coord > (dirRow ? b.x + b.w / 2 : b.y + b.h / 2)) slot++
        }
        const list = (parent.children || []).filter((c) => c.id !== id)
        let li = list.length
        for (let i = 0, seen = 0; i < list.length; i++) {
          if (list[i].hidden) continue
          if (seen === slot) { li = i; break }
          seen++
        }
        const next = [...list]
        next.splice(li, 0, parent.children[index])
        if (next.every((c, i) => c === parent.children[i])) return
        setElements(updateNode(elements, parent.id, (g) => ({ ...g, children: next })))
        return
      }
      if (d.mode === 'move') {
        // snap the primary node's ABSOLUTE box against margins/centers AND the
        // other elements' edges/centers (smart guides), then apply the adjusted
        // delta to every selected node (relative boxes shift by the same delta)
        const primary = d.ids[0]
        const abs0 = d.startAbs.get(primary)
        const activeV = []
        const activeH = []
        if (abs0) {
          let x = clamp(abs0.x + dx, BOX_LIMITS.xMin, BOX_LIMITS.xMax - 0.1)
          let y = clamp(abs0.y + dy, BOX_LIMITS.yMin, BOX_LIMITS.yMax - 0.1)
          // 1) element-to-element alignment (left/center/right vs top/mid/bottom)
          const edgesX = [x, x + abs0.w / 2, x + abs0.w]
          const offX = [0, abs0.w / 2, abs0.w]
          let snappedX = null
          for (let i = 0; i < 3; i++) {
            const m = snapAlign(edgesX[i], d.targets.x)
            if (m != null) { snappedX = m - offX[i]; activeV.push(m); break }
          }
          const edgesY = [y, y + abs0.h / 2, y + abs0.h]
          const offY = [0, abs0.h / 2, abs0.h]
          let snappedY = null
          for (let i = 0; i < 3; i++) {
            const m = snapAlign(edgesY[i], d.targets.y)
            if (m != null) { snappedY = m - offY[i]; activeH.push(m); break }
          }
          // 2) fall back to slide margins/centers when no element guide caught
          x = snappedX != null ? snappedX : snapTo(x, [...xGuides, ...xGuides.map((g) => g - abs0.w), SLIDE_W / 2 - abs0.w / 2])
          y = snappedY != null ? snappedY : snapTo(y, [...yGuides, ...yGuides.map((g) => g - abs0.h), SLIDE_H / 2 - abs0.h / 2])
          dx = x - abs0.x
          dy = y - abs0.y
        }
        let next = elements
        for (const id of d.ids) {
          const b0 = d.startBoxes.get(id)
          if (!b0) continue
          next = patchNodeBox(next, id, { x: r2((b0.x || 0) + dx), y: r2((b0.y || 0) + dy) })
        }
        setElements(next)
        setGuides(activeV.length || activeH.length ? { v: activeV, h: activeH } : null)
      } else {
        const id = d.ids[0]
        const node = findNode(elements, id)
        const b = d.startBoxes.get(id)
        const abs0 = d.startAbs.get(id)
        if (!node || !b || !abs0) return
        let { x, y } = abs0
        let w = abs0.w
        let h = abs0.h
        if (d.handle.includes('e')) w = abs0.w + dx
        if (d.handle.includes('s')) h = abs0.h + dy
        if (d.handle.includes('w')) {
          x = abs0.x + dx
          w = abs0.w - dx
        }
        if (d.handle.includes('n')) {
          y = abs0.y + dy
          h = abs0.h - dy
        }
        if (ev.shiftKey && abs0.w > 0 && abs0.h > 0) {
          const ratio = abs0.w / abs0.h
          if (Math.abs(dx) > Math.abs(dy)) h = w / ratio
          else w = h * ratio
        }
        const minS = node.type === 'line' ? 0 : BOX_LIMITS.minSize
        w = clamp(w, minS, BOX_LIMITS.maxSize)
        h = clamp(h, minS, BOX_LIMITS.maxSize)
        // snap the moving edge to element guides, else grid/margins
        const activeV = []
        const activeH = []
        if (d.handle.includes('e')) { const m = snapAlign(x + w, d.targets.x); if (m != null) { w = m - x; activeV.push(m) } }
        if (d.handle.includes('w')) { const m = snapAlign(x, d.targets.x); if (m != null) { w += x - m; x = m; activeV.push(m) } }
        if (d.handle.includes('s')) { const m = snapAlign(y + h, d.targets.y); if (m != null) { h = m - y; activeH.push(m) } }
        if (d.handle.includes('n')) { const m = snapAlign(y, d.targets.y); if (m != null) { h += y - m; y = m; activeH.push(m) } }
        if (!activeV.length) x = snapTo(x, xGuides)
        if (!activeH.length) y = snapTo(y, yGuides)
        setGuides(activeV.length || activeH.length ? { v: activeV, h: activeH } : null)
        const boxPatch = { x: r2((b.x || 0) + (x - abs0.x)), y: r2((b.y || 0) + (y - abs0.y)), w: r2(w), h: r2(h) }
        let next = updateNode(elements, id, (n) => {
          const resized = { ...n, box: { ...n.box, ...boxPatch } }
          const fx = abs0.w > 0.01 ? w / abs0.w : 1
          const fy = abs0.h > 0.01 ? h / abs0.h : 1
          return scaleChildren(resized, fx, fy)
        })
        setElements(next)
      }
      return
    }
    if (marquee) {
      const p = toIn(ev)
      setMarquee((m) => ({ ...m, x1: p.x, y1: p.y }))
    }
  }

  const endDrag = () => {
    if (panRef.current) {
      panRef.current = null
      return
    }
    if (createRef.current) {
      const box = createBox
      createRef.current = null
      setCreateBox(null)
      // a click (no meaningful drag) drops a default-sized element at the point;
      // a drag sizes it to the drawn frame
      const drawn = box && (box.w > 0.15 || box.h > 0.15)
      const finalBox = drawn
        ? { x: r2(box.x), y: r2(box.y), w: r2(Math.max(box.w, 0.2)), h: r2(tool.type === 'line' ? 0 : Math.max(box.h, 0.2)) }
        : box
          ? { x: r2(box.x), y: r2(box.y) }
          : null
      const newId = onCreateElement?.(tool.type, finalBox, tool.extra)
      onToolDone?.()
      // text lands ready to type — jump straight into inline editing. Set the
      // id directly (not beginTextEdit, whose findNode would miss the just-added
      // node in this stale `elements` closure); the editor overlay resolves it
      // on the next render, when elements is fresh.
      if (newId && tool.type === 'text') setEditingText(newId)
      return
    }
    const d = dragRef.current
    dragRef.current = null
    setGuides(null)
    // progressive click-through: a clean click (no drag) on the already-
    // selected node selects the next level down the chain toward the clicked
    // leaf — successive clicks walk INTO nested groups, Escape walks back up
    if (d?.deepen && !d.moved) {
      const chain = chains.get(d.deepen.srcId) || []
      const i = chain.indexOf(d.deepen.target)
      if (i !== -1 && i < chain.length - 1) select([chain[i + 1]])
      else {
        // no deeper node: a clean click on an already-selected text enters
        // inline editing (single gesture, like Claude Design / Figma)
        const node = findNode(elements, d.deepen.target)
        if (node?.type === 'text') setEditingText(node.id)
      }
    }
    if (marquee) {
      const x0 = Math.min(marquee.x0, marquee.x1)
      const x1 = Math.max(marquee.x0, marquee.x1)
      const y0 = Math.min(marquee.y0, marquee.y1)
      const y1 = Math.max(marquee.y0, marquee.y1)
      if (x1 - x0 > 0.05 || y1 - y0 > 0.05) {
        const hit = scopeChildren
          .filter((el) => {
            const b = boxes.get(el.id)
            return b && b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0 && !el.hidden
          })
          .map((el) => el.id)
        select(hit)
      }
      setMarquee(null)
    }
  }

  // --- clipboard ---------------------------------------------------------------

  const copySelection = () => {
    const nodes = selectedIds.map((id) => findNode(elements, id)).filter(Boolean)
    if (nodes.length) setClipboard(nodes)
    return nodes.length
  }

  const pasteClipboard = () => {
    if (!clipboardHasContent()) return
    const clones = getClipboard().map((n) => cloneWithNewIds({ ...n, box: { ...n.box, x: r2((n.box?.x || 0) + 0.2), y: r2((n.box?.y || 0) + 0.2) } }))
    // paste into the open group if scoped, else at the slide root
    let next = elements
    for (const c of clones) next = insertNode(next, scopeId || null, Infinity, c)
    onChangeElements(next, { commit: true })
    select(clones.map((c) => c.id))
  }

  const duplicateSelection = () => {
    if (!selectedIds.length) return
    const selectedNodes = selectedIds.map((id) => findNode(elements, id)).filter(Boolean)
    let next = elements
    const fresh = []
    for (const n of selectedNodes) {
      const { parent, index } = findParent(next, n.id)
      const clone = cloneWithNewIds({ ...n, box: { ...n.box, x: r2((n.box?.x || 0) + 0.2), y: r2((n.box?.y || 0) + 0.2) } })
      fresh.push(clone.id)
      next = insertNode(next, parent?.id || null, index + 1, clone)
    }
    onChangeElements(next, { commit: true })
    select(fresh)
  }

  const reorderSelection = (dir, toEdge = false) => {
    if (selectedIds.length !== 1) return
    const id = selectedIds[0]
    const { parent, index } = findParent(elements, id)
    const list = parent ? [...(parent.children || [])] : [...elements]
    if (index === -1) return
    const [node] = list.splice(index, 1)
    const target = toEdge ? (dir > 0 ? list.length : 0) : clamp(index + dir, 0, list.length)
    list.splice(target, 0, node)
    const next = parent ? updateNode(elements, parent.id, (g) => ({ ...g, children: list })) : list
    onChangeElements(next, { commit: true })
  }

  // --- keyboard ------------------------------------------------------------------

  const selectedNodes = selectedIds.map((id) => findNode(elements, id)).filter(Boolean)

  const onKeyDown = (ev) => {
    if (editingText) return
    if (ev.key === ' ' && !spaceHeld) {
      setSpaceHeld(true)
      return // don't scroll; enables pan cursor
    }
    const mod = ev.metaKey || ev.ctrlKey
    if (mod && ev.key.toLowerCase() === 'c' && selectedIds.length) {
      ev.preventDefault()
      copySelection()
      return
    }
    if (mod && ev.key.toLowerCase() === 'x' && selectedIds.length) {
      ev.preventDefault()
      if (copySelection()) {
        onChangeElements(removeNodes(elements, selectedIds), { commit: true })
        select([])
      }
      return
    }
    if (mod && ev.key.toLowerCase() === 'v') {
      ev.preventDefault()
      pasteClipboard()
      return
    }
    if (mod && ev.key.toLowerCase() === 'g' && !ev.shiftKey && selectedIds.length > 1) {
      ev.preventDefault()
      const { elements: next, groupId } = groupNodes(elements, selectedIds, theme)
      if (groupId) {
        onChangeElements(next, { commit: true })
        select([groupId])
      }
      return
    }
    if (mod && ev.key.toLowerCase() === 'g' && ev.shiftKey && selectedNodes.some((n) => n.type === 'group')) {
      ev.preventDefault()
      let next = elements
      let released = []
      for (const n of selectedNodes) {
        if (n.type !== 'group') continue
        const res = ungroupNode(next, n.id, theme)
        next = res.elements
        released = [...released, ...res.ids]
      }
      onChangeElements(next, { commit: true })
      select(released)
      if (scopeId && selectedIds.includes(scopeId)) onScope?.(null)
      return
    }
    if (mod && ev.key === 'd' && selectedNodes.length) {
      ev.preventDefault()
      duplicateSelection()
      return
    }
    if (mod && (ev.key === ']' || ev.key === '[') && selectedIds.length === 1) {
      ev.preventDefault()
      reorderSelection(ev.key === ']' ? 1 : -1, ev.altKey)
      return
    }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedIds.length) {
      ev.preventDefault()
      onChangeElements(removeNodes(elements, selectedIds), { commit: true })
      select([])
      return
    }
    // Enter / F2 on a single selected text enters inline edit (single-gesture)
    if ((ev.key === 'Enter' || ev.key === 'F2') && selectedIds.length === 1 && !ev.metaKey && !ev.ctrlKey) {
      const node = findNode(elements, selectedIds[0])
      if (node?.type === 'text') {
        ev.preventDefault()
        setEditingText(node.id)
        return
      }
    }
    if (ev.key === 'Escape') {
      if (menu) { setMenu(null); return }
      if (tool) { onToolDone?.(); return }
      if (scopeId) {
        const chain = chains.get(scopeId) || []
        onScope?.(chain.length > 1 ? chain[chain.length - 2] : null)
        select([scopeId])
      } else if (selectedIds.length === 1) {
        // deep selection walks back up one level before clearing
        const { parent } = findParent(elements, selectedIds[0])
        select(parent ? [parent.id] : [])
      } else {
        select([])
      }
      return
    }
    if (ev.key.startsWith('Arrow') && selectedIds.length) {
      ev.preventDefault()
      const step = ev.shiftKey ? 0.5 : SNAP_IN
      const ddx = ev.key === 'ArrowRight' ? step : ev.key === 'ArrowLeft' ? -step : 0
      const ddy = ev.key === 'ArrowDown' ? step : ev.key === 'ArrowUp' ? -step : 0
      let next = elements
      for (const n of selectedNodes) {
        if (isStackChild(elements, n.id)) continue
        next = patchNodeBox(next, n.id, {
          x: r2(clamp((n.box?.x || 0) + ddx, BOX_LIMITS.xMin, BOX_LIMITS.xMax)),
          y: r2(clamp((n.box?.y || 0) + ddy, BOX_LIMITS.yMin, BOX_LIMITS.yMax)),
        })
      }
      onChangeElements(next, { commit: true })
    }
  }

  const onKeyUp = (ev) => {
    if (ev.key === ' ') setSpaceHeld(false)
  }

  // --- zoom / pan ----------------------------------------------------------------

  const zoomTo = (nextZoom, center) => {
    const z = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX)
    setZoom((prev) => {
      if (z === prev || !center || !clipRef.current) return z
      // keep the point under the cursor fixed while zooming
      const rect = clipRef.current.getBoundingClientRect()
      const cx = center.x - rect.left
      const cy = center.y - rect.top
      setPan((p) => ({ x: cx - ((cx - p.x) / prev) * z, y: cy - ((cy - p.y) / prev) * z }))
      return z
    })
  }

  const onWheel = (ev) => {
    if (!(ev.ctrlKey || ev.metaKey)) return
    ev.preventDefault()
    zoomTo(zoom * (ev.deltaY < 0 ? 1.1 : 0.9), { x: ev.clientX, y: ev.clientY })
  }

  const resetView = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  // reset the view when switching to a different freeform slide
  useEffect(() => {
    resetView()
    setMenu(null)
  }, [slide]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- inline text editing --------------------------------------------------------

  useEffect(() => {
    if (editingText && editRef.current) {
      editRef.current.focus()
      const range = document.createRange()
      range.selectNodeContents(editRef.current)
      range.collapse(false)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }, [editingText])

  const commitText = (node) => {
    const value = editRef.current?.innerText ?? ''
    setEditingText(null)
    if (value !== node.text) {
      onChangeElements(updateNode(elements, node.id, (n) => ({ ...n, text: value.slice(0, 2000) })), { commit: true })
    }
  }

  const beginTextEdit = (srcId) => {
    const node = findNode(elements, srcId)
    if (node?.type === 'text') {
      select([node.id])
      setEditingText(node.id)
      return true
    }
    return false
  }

  const onDoubleClick = (ev, srcId) => {
    ev.stopPropagation()
    const target = targetFor(srcId)
    const targetNode = findNode(elements, target)
    if (targetNode?.type === 'group') {
      onScope?.(target)
      const chain = chains.get(srcId) || []
      const i = chain.indexOf(target)
      const child = i !== -1 && i < chain.length - 1 ? chain[i + 1] : null
      select(child ? [child] : [])
      return
    }
    beginTextEdit(srcId)
  }

  const openMenu = (ev, srcId) => {
    ev.preventDefault()
    ev.stopPropagation()
    if (srcId) {
      const target = targetFor(srcId)
      if (!selectedIds.includes(target)) select([target])
    }
    const rect = clipRef.current.getBoundingClientRect()
    setMenu({ x: ev.clientX - rect.left, y: ev.clientY - rect.top, onElement: !!srcId })
  }

  const pctBox = (b) => ({
    left: `${(b.x / SLIDE_W) * 100}%`,
    top: `${(b.y / SLIDE_H) * 100}%`,
    width: `${(Math.max(b.w, 0.01) / SLIDE_W) * 100}%`,
    height: `${(Math.max(b.h, 0.01) / SLIDE_H) * 100}%`,
  })
  const pctLine = (at, axis) => (axis === 'x' ? `${(at / SLIDE_W) * 100}%` : `${(at / SLIDE_H) * 100}%`)

  // Background + plate MUST paint identically to the thumbnail path
  // (DeckSlidePreview's freeform branch), or the focused canvas and the rail
  // show different backgrounds for the same slide. Use the shared token
  // resolver (not a local @-prefix hack) and the same plate/veil/overlay
  // composition as addDarkSlide / DeckSlidePreview.
  const bg = slide?.background || {}
  const bgColor =
    resolveThemeColor(theme, bg.color, null) || (bg.plate ? theme.primary : theme.background)
  const plateBase = bg.plate === 'section' && theme.sectionPlate ? theme.sectionPlate : theme.coverPlate
  const plateHasOverlay = plateBase === theme.coverPlate && theme.coverOverlay
  const editingNode = editingText ? findNode(elements, editingText) : null
  const scopeBox = scopeId ? boxes.get(scopeId) : null
  const panning = spaceHeld || !!panRef.current
  const creating = !!tool

  return (
    <div
      ref={clipRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onWheel={onWheel}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onContextMenu={(ev) => { if (ev.target === ev.currentTarget) openMenu(ev, null) }}
      onPointerDown={(ev) => {
        if (ev.target !== ev.currentTarget) return
        setMenu(null)
        // space-drag / middle-button pans the view
        if (spaceHeld || ev.button === 1) {
          panRef.current = { startPx: { x: ev.clientX, y: ev.clientY }, startPan: pan }
          ev.currentTarget.setPointerCapture?.(ev.pointerId)
          return
        }
        select([])
      }}
      className={`relative aspect-video overflow-hidden rounded-md shadow-sm outline-none bg-[var(--surface-2)] ${className}`}
      style={{ touchAction: 'none', cursor: panning ? 'grab' : creating ? 'crosshair' : 'default' }}
    >
      {/* the transformed stage: everything slide-space lives here so zoom/pan
          apply uniformly and pointer math (reads this rect) stays correct */}
      <div
        ref={wrapRef}
        className="absolute inset-0"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0', background: bgColor, fontFamily: theme.bodyFont, containerType: 'inline-size' }}
        onPointerDown={(ev) => {
          if (ev.target !== ev.currentTarget) return
          setMenu(null)
          if (spaceHeld || ev.button === 1) {
            panRef.current = { startPx: { x: ev.clientX, y: ev.clientY }, startPan: pan }
            clipRef.current?.setPointerCapture?.(ev.pointerId)
            return
          }
          // armed create tool: draw the new element's frame with a drag
          if (tool) {
            const p = toIn(ev)
            createRef.current = { x0: clamp(p.x, 0, SLIDE_W), y0: clamp(p.y, 0, SLIDE_H) }
            setCreateBox({ x: createRef.current.x0, y: createRef.current.y0, w: 0, h: 0 })
            clipRef.current?.setPointerCapture?.(ev.pointerId)
            return
          }
          if (!ev.shiftKey) select([])
          const p = toIn(ev)
          setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
          clipRef.current?.setPointerCapture?.(ev.pointerId)
        }}
        onContextMenu={(ev) => { if (ev.target === ev.currentTarget) openMenu(ev, null) }}
      >
        {bg.plate && plateBase && (
          <>
            <img
              src={plateBase}
              alt=""
              className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            />
            {plateHasOverlay && (
              <img src={theme.coverOverlay} alt="" className="absolute inset-0 w-full h-full object-cover pointer-events-none" />
            )}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ background: theme.primary, opacity: plateHasOverlay ? 0.45 : 0.74 }}
            />
          </>
        )}

        {/* paint layer: the flattened primitives, exactly what exports */}
        <div className="absolute inset-0 pointer-events-none">
          {flat.map((el) => (editingText && el.srcId === editingText ? null : <ElementView key={el.id} el={el} theme={theme} iconById={iconById} />))}
        </div>

        {/* hit layer: one surface per primitive, mapping back to its source
            node — DOM order mirrors z-order so the topmost object wins */}
        {!panning && !creating && flat.map((el) => (
          <div
            key={`hit_${el.id}`}
            className="absolute"
            style={{ ...pctBox(el.box), cursor: editingText ? 'text' : 'move', minWidth: 6, minHeight: 6 }}
            onPointerDown={(ev) => beginDrag(ev, el.srcId, 'move')}
            onDoubleClick={(ev) => onDoubleClick(ev, el.srcId)}
            onContextMenu={(ev) => openMenu(ev, el.srcId)}
          />
        ))}

        {/* smart alignment guides (element-to-element + slide) while dragging */}
        {guides?.v?.map((at, i) => (
          <div key={`gv_${i}`} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: pctLine(at, 'x'), width: 1, background: '#F43F5E' }} />
        ))}
        {guides?.h?.map((at, i) => (
          <div key={`gh_${i}`} className="absolute left-0 right-0 pointer-events-none" style={{ top: pctLine(at, 'y'), height: 1, background: '#F43F5E' }} />
        ))}

        {/* open-group scope frame */}
        {scopeBox && (
          <div
            className="absolute pointer-events-none rounded-sm"
            style={{ ...pctBox(scopeBox), boxShadow: '0 0 0 1px #3B82F6', outline: '1px dashed rgba(59,130,246,0.6)', outlineOffset: 2 }}
          />
        )}

        {/* selection frames + resize handles (handles on single selection) */}
        {!panning && selectedIds.map((id) => {
          const b = boxes.get(id)
          if (!b || editingText === id) return null
          const single = selectedIds.length === 1
          return (
            <div key={`sel_${id}`} className="absolute pointer-events-none" style={pctBox(b)}>
              <div className="absolute inset-0" style={{ boxShadow: '0 0 0 1.5px #3B82F6' }} />
              {single &&
                HANDLES.map((hd) => {
                  const pos = {}
                  if (hd.includes('n')) pos.top = '-4px'
                  else if (hd.includes('s')) pos.bottom = '-4px'
                  else pos.top = 'calc(50% - 4px)'
                  if (hd.includes('w')) pos.left = '-4px'
                  else if (hd.includes('e')) pos.right = '-4px'
                  else pos.left = 'calc(50% - 4px)'
                  const cursor = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }[hd]
                  return (
                    <div
                      key={hd}
                      onPointerDown={(ev) => beginDrag(ev, id, 'resize', hd)}
                      className="absolute w-2 h-2 bg-white border border-[#3B82F6] rounded-[2px] pointer-events-auto"
                      style={{ ...pos, cursor, zIndex: 5 }}
                    />
                  )
                })}
            </div>
          )
        })}

        {/* marquee */}
        {marquee && (
          <div
            className="absolute pointer-events-none border border-[#3B82F6] bg-[#3B82F6]/10"
            style={pctBox({
              x: Math.min(marquee.x0, marquee.x1),
              y: Math.min(marquee.y0, marquee.y1),
              w: Math.abs(marquee.x1 - marquee.x0),
              h: Math.abs(marquee.y1 - marquee.y0),
            })}
          />
        )}

        {/* drag-to-create preview frame */}
        {createBox && (
          <div className="absolute pointer-events-none border border-dashed border-[var(--accent)] bg-[var(--accent)]/10 rounded-sm" style={pctBox(createBox)} />
        )}

        {/* inline text editor overlays the text node at its flattened position */}
        {editingNode && boxes.get(editingNode.id) && (
          <div
            ref={editRef}
            contentEditable
            suppressContentEditableWarning
            onBlur={() => commitText(editingNode)}
            onKeyDown={(ev) => {
              if (ev.key === 'Escape') {
                ev.preventDefault()
                setEditingText(null)
              }
              if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
                ev.preventDefault()
                commitText(editingNode)
              }
              ev.stopPropagation()
            }}
            className="absolute outline-none"
            style={{
              ...pctBox(boxes.get(editingNode.id)),
              fontFamily: editingNode.style?.fontFamily || (editingNode.style?.fontRole === 'heading' ? theme.headingFont : theme.bodyFont),
              fontSize: `${(editingNode.style?.fontSize || 13) / 7.2}cqw`,
              color: editingNode.style?.color?.startsWith('@') ? theme[editingNode.style.color.slice(1)] : editingNode.style?.color || theme.bodyText,
              fontWeight: editingNode.style?.bold ? 700 : 400,
              fontStyle: editingNode.style?.italic ? 'italic' : 'normal',
              textAlign: editingNode.style?.align || 'left',
              lineHeight: editingNode.style?.lineHeight || 1.2,
              padding: '0.4cqw 0.95cqw',
              whiteSpace: 'pre-wrap',
              background: 'rgba(59,130,246,0.06)',
              boxShadow: '0 0 0 1.5px #3B82F6 inset',
              zIndex: 10,
            }}
          >
            {editingNode.text}
          </div>
        )}
      </div>

      {/* zoom control (clip-space, fixed to the corner regardless of pan) */}
      <div className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded-lg bg-[var(--surface)]/90 backdrop-blur border border-[var(--border)] shadow-sm px-0.5 py-0.5 text-[var(--muted)] select-none">
        <button className="w-6 h-6 rounded grid place-items-center hover:bg-[var(--surface-3)] text-sm" onClick={() => zoomTo(zoom - 0.25, null)} title="Zoom −">−</button>
        <button className="px-1.5 h-6 rounded hover:bg-[var(--surface-3)] text-[11px] tabular-nums min-w-[3rem]" onClick={resetView} title="Ajustar (100%)">
          {Math.round(zoom * 100)}%
        </button>
        <button className="w-6 h-6 rounded grid place-items-center hover:bg-[var(--surface-3)] text-sm" onClick={() => zoomTo(zoom + 0.25, null)} title="Zoom +">+</button>
      </div>

      {/* right-click context menu */}
      {menu && <CanvasMenu menu={menu} onClose={() => setMenu(null)} actions={{
        hasSelection: selectedIds.length > 0,
        multi: selectedIds.length > 1,
        isGroup: selectedNodes.length === 1 && selectedNodes[0]?.type === 'group',
        canPaste: clipboardHasContent(),
        copy: () => copySelection(),
        cut: () => { if (copySelection()) { onChangeElements(removeNodes(elements, selectedIds), { commit: true }); select([]) } },
        paste: pasteClipboard,
        duplicate: duplicateSelection,
        group: () => { const { elements: n, groupId } = groupNodes(elements, selectedIds, theme); if (groupId) { onChangeElements(n, { commit: true }); select([groupId]) } },
        ungroup: () => { const n = selectedNodes[0]; if (n?.type === 'group') { const res = ungroupNode(elements, n.id, theme); onChangeElements(res.elements, { commit: true }); select(res.ids) } },
        toFront: () => reorderSelection(1, true),
        toBack: () => reorderSelection(-1, true),
        forward: () => reorderSelection(1),
        backward: () => reorderSelection(-1),
        remove: () => { onChangeElements(removeNodes(elements, selectedIds), { commit: true }); select([]) },
      }} />}
    </div>
  )
}

// Right-click menu (Claude-Design-style): a compact floating list of the
// canvas commands, positioned at the pointer within the clip. Backdrop closes.
function CanvasMenu({ menu, onClose, actions }) {
  const run = (fn) => () => { fn?.(); onClose() }
  const Item = ({ label, on, kbd, disabled }) => (
    <button
      disabled={disabled}
      onClick={run(on)}
      className="w-full flex items-center gap-3 px-2.5 py-1.5 text-[12px] rounded-md text-left text-[var(--text)] hover:bg-[var(--surface-3)] disabled:opacity-35 disabled:hover:bg-transparent"
    >
      <span className="flex-1">{label}</span>
      {kbd && <span className="text-[10px] text-[var(--faint)] tabular-nums">{kbd}</span>}
    </button>
  )
  const Sep = () => <div className="my-1 h-px bg-[var(--border-soft)]" />
  return (
    <>
      <div className="fixed inset-0 z-20" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div
        className="absolute z-30 w-52 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl shadow-black/40 p-1"
        style={{ left: Math.min(menu.x, (menu.clipW || 9999)), top: menu.y }}
      >
        {actions.hasSelection ? (
          <>
            <Item label="Copiar" on={actions.copy} kbd="⌘C" />
            <Item label="Recortar" on={actions.cut} kbd="⌘X" />
            <Item label="Duplicar" on={actions.duplicate} kbd="⌘D" />
            <Item label="Colar" on={actions.paste} kbd="⌘V" disabled={!actions.canPaste} />
            <Sep />
            {actions.multi && <Item label="Agrupar" on={actions.group} kbd="⌘G" />}
            {actions.isGroup && <Item label="Desagrupar" on={actions.ungroup} kbd="⌘⇧G" />}
            <Item label="Trazer para frente" on={actions.toFront} />
            <Item label="Avançar" on={actions.forward} kbd="⌘]" />
            <Item label="Recuar" on={actions.backward} kbd="⌘[" />
            <Item label="Enviar para trás" on={actions.toBack} />
            <Sep />
            <Item label="Excluir" on={actions.remove} kbd="⌫" />
          </>
        ) : (
          <Item label="Colar" on={actions.paste} kbd="⌘V" disabled={!actions.canPaste} />
        )}
      </div>
    </>
  )
}
