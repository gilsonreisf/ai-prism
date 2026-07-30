// Pure helpers over the freeform element TREE (see shared/deckLayout.js:
// groups carry `children` with boxes relative to the group origin; `stack`
// groups compute children boxes at flatten time). All mutators are immutable
// — they return a new tree. Coordinate conversions never re-implement layout
// math: they read the absolute boxes that flattenElements collects, so a
// node dropped into/out of a group lands visually where it was.
import { flattenElements, newElementId } from '../../../shared/deckLayout.js'

const r2 = (v) => Math.round(v * 100) / 100

export function findNode(elements, id) {
  for (const el of elements || []) {
    if (el.id === id) return el
    if (el.children) {
      const hit = findNode(el.children, id)
      if (hit) return hit
    }
  }
  return null
}

// → { parent: node|null, index } — parent null means the node lives at the
// slide root; index -1 means the id wasn't found at all
export function findParent(elements, id, parent = null) {
  const list = parent ? parent.children || [] : elements || []
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return { parent, index: i }
    if (list[i].children) {
      const hit = findParent(elements, id, list[i])
      if (hit.index !== -1) return hit
    }
  }
  return { parent: null, index: -1 }
}

export function updateNode(elements, id, patchFn) {
  return (elements || []).map((el) => {
    if (el.id === id) return patchFn(el)
    if (el.children) {
      const children = updateNode(el.children, id, patchFn)
      if (children !== el.children && children.some((c, i) => c !== el.children[i])) return { ...el, children }
    }
    return el
  })
}

export function removeNodes(elements, ids) {
  const set = ids instanceof Set ? ids : new Set(ids)
  return (elements || [])
    .filter((el) => !set.has(el.id))
    .map((el) => (el.children ? { ...el, children: removeNodes(el.children, set) } : el))
}

export function insertNode(elements, parentId, index, node) {
  if (!parentId) {
    const next = [...(elements || [])]
    next.splice(Math.max(0, Math.min(index, next.length)), 0, node)
    return next
  }
  return updateNode(elements, parentId, (g) => {
    const children = [...(g.children || [])]
    children.splice(Math.max(0, Math.min(index, children.length)), 0, node)
    return { ...g, children }
  })
}

export function isStackChild(elements, id) {
  const { parent } = findParent(elements, id)
  return !!parent?.stack
}

// Merge a style patch into every id in one pass (batch styling on multi-
// selection). undefined values delete the key. Immutable.
export function patchNodesStyle(elements, ids, patch) {
  const set = ids instanceof Set ? ids : new Set(ids)
  let next = elements
  for (const id of set) {
    next = updateNode(next, id, (n) => {
      const style = { ...(n.style || {}), ...patch }
      for (const k of Object.keys(style)) if (style[k] === undefined) delete style[k]
      return { ...n, style }
    })
  }
  return next
}

function absBoxes(elements, theme) {
  const boxes = new Map()
  flattenElements(elements, theme, { boxes })
  return boxes
}

// Moves a node to a new parent (null = root) at `index`, keeping it visually
// in place: the box converts between coordinate spaces via the flatten-time
// absolute boxes. Dropping INTO a stack skips the conversion — the stack
// positions its children itself.
export function moveNode(elements, id, newParentId, index, theme) {
  const node = findNode(elements, id)
  if (!node || id === newParentId) return elements
  // never move a node into its own subtree
  if (newParentId && findNode(node.children || [], newParentId)) return elements
  const boxes = absBoxes(elements, theme)
  const { parent: oldParent, index: oldIndex } = findParent(elements, id)
  if (oldIndex === -1) return elements
  const newParent = newParentId ? findNode(elements, newParentId) : null
  let moved = node
  const abs = boxes.get(id)
  if (abs && !newParent?.stack) {
    const origin = newParent ? boxes.get(newParent.id) : { x: 0, y: 0 }
    if (origin) {
      moved = { ...node, box: { ...node.box, x: r2(abs.x - origin.x), y: r2(abs.y - origin.y), w: r2(abs.w), h: r2(abs.h) } }
    }
  }
  // removing before inserting shifts sibling indices — adjust when staying
  // under the same parent and moving forward
  let target = index
  if ((oldParent?.id || null) === (newParentId || null) && oldIndex < index) target = index - 1
  const without = removeNodes(elements, [id])
  return insertNode(without, newParentId, target, moved)
}

// Groups SIBLING nodes (same parent) into a new plain group: frame = the
// bounding box of the members, member boxes go relative to it, and the group
// takes the z position of the back-most member.
export function groupNodes(elements, ids, theme) {
  if (!ids?.length) return { elements, groupId: null }
  const { parent } = findParent(elements, ids[0])
  const parentId = parent?.id || null
  const siblings = parent ? parent.children || [] : elements
  const members = siblings.filter((el) => ids.includes(el.id))
  if (members.length < 2) return { elements, groupId: null }
  const boxes = absBoxes(elements, theme)
  const abs = members.map((m) => boxes.get(m.id)).filter(Boolean)
  if (abs.length !== members.length) return { elements, groupId: null }
  const x0 = Math.min(...abs.map((b) => b.x))
  const y0 = Math.min(...abs.map((b) => b.y))
  const x1 = Math.max(...abs.map((b) => b.x + b.w))
  const y1 = Math.max(...abs.map((b) => b.y + b.h))
  const origin = parent ? boxes.get(parent.id) : { x: 0, y: 0 }
  const group = {
    id: newElementId('g'),
    type: 'group',
    name: 'Grupo',
    box: { x: r2(x0 - origin.x), y: r2(y0 - origin.y), w: r2(x1 - x0), h: r2(y1 - y0) },
    style: {},
    children: members.map((m) => {
      const b = boxes.get(m.id)
      return { ...m, box: { ...m.box, x: r2(b.x - x0), y: r2(b.y - y0), w: r2(b.w), h: r2(b.h) } }
    }),
  }
  const zIndex = Math.min(...members.map((m) => siblings.indexOf(m)))
  const without = removeNodes(elements, ids)
  return { elements: insertNode(without, parentId, zIndex, group), groupId: group.id }
}

// Dissolves a group: children return to the group's parent in the group's z
// slot, re-based to that coordinate space (flatten-computed for stacks too).
export function ungroupNode(elements, id, theme) {
  const group = findNode(elements, id)
  if (!group || group.type !== 'group') return { elements, ids: [] }
  const boxes = absBoxes(elements, theme)
  const { parent, index } = findParent(elements, id)
  if (index === -1) return { elements, ids: [] }
  const origin = parent ? boxes.get(parent.id) : { x: 0, y: 0 }
  const children = (group.children || []).map((c) => {
    const b = boxes.get(c.id)
    if (!b) return c
    return { ...c, box: { ...c.box, x: r2(b.x - origin.x), y: r2(b.y - origin.y), w: r2(b.w), h: r2(b.h) } }
  })
  let next = removeNodes(elements, [id])
  children.forEach((c, i) => {
    next = insertNode(next, parent?.id || null, index + i, c)
  })
  return { elements: next, ids: children.map((c) => c.id) }
}

// deep clone with fresh ids (Cmd+D) — nested children too
export function cloneWithNewIds(node) {
  const clone = { ...node, id: newElementId(node.type === 'group' ? 'g' : 'e') }
  if (node.children) clone.children = node.children.map(cloneWithNewIds)
  return clone
}

// --- align / distribute -------------------------------------------------------
// Operate on the flatten-time ABSOLUTE boxes of the selected nodes, then push
// the same delta into each node's parent-relative box (abs = parentOrigin +
// relative, so a shift in absolute space equals the same shift in relative
// space — no coordinate conversion needed). Stack children skip it (their
// position is auto-computed). Immutable; returns the new tree.
const EDGE_AXIS = { left: 'x', hcenter: 'x', right: 'x', top: 'y', vcenter: 'y', bottom: 'y' }

export function alignNodes(elements, ids, edge, theme) {
  const axis = EDGE_AXIS[edge]
  if (!axis) return elements
  const boxes = absBoxes(elements, theme)
  const movable = (ids || []).filter((id) => !isStackChild(elements, id) && boxes.get(id))
  if (movable.length < 2) return elements
  const abs = movable.map((id) => ({ id, b: boxes.get(id) }))
  const size = (b) => (axis === 'x' ? b.w : b.h)
  const lo = Math.min(...abs.map(({ b }) => b[axis]))
  const hi = Math.max(...abs.map(({ b }) => b[axis] + size(b)))
  const target = (b) => {
    if (edge === 'left' || edge === 'top') return lo
    if (edge === 'right' || edge === 'bottom') return hi - size(b)
    return (lo + hi) / 2 - size(b) / 2 // center
  }
  let next = elements
  for (const { id, b } of abs) {
    const delta = target(b) - b[axis]
    if (Math.abs(delta) < 0.001) continue
    next = updateNode(next, id, (n) => ({ ...n, box: { ...n.box, [axis]: r2((n.box?.[axis] || 0) + delta) } }))
  }
  return next
}

// Equalize the gaps between selected nodes along an axis (Figma "distribute
// spacing"): the two extreme nodes stay put, the rest slide so consecutive
// gaps are equal. Needs 3+ movable nodes.
export function distributeNodes(elements, ids, axis, theme) {
  if (axis !== 'x' && axis !== 'y') return elements
  const boxes = absBoxes(elements, theme)
  const movable = (ids || []).filter((id) => !isStackChild(elements, id) && boxes.get(id))
  if (movable.length < 3) return elements
  const size = (b) => (axis === 'x' ? b.w : b.h)
  const items = movable.map((id) => ({ id, b: boxes.get(id) })).sort((p, q) => p.b[axis] - q.b[axis])
  const first = items[0].b
  const last = items[items.length - 1].b
  const span = last[axis] + size(last) - first[axis]
  const totalSize = items.reduce((s, { b }) => s + size(b), 0)
  const gap = (span - totalSize) / (items.length - 1)
  let cursor = first[axis]
  let next = elements
  for (const { id, b } of items) {
    const delta = cursor - b[axis]
    if (Math.abs(delta) > 0.001) {
      next = updateNode(next, id, (n) => ({ ...n, box: { ...n.box, [axis]: r2((n.box?.[axis] || 0) + delta) } }))
    }
    cursor += size(b) + gap
  }
  return next
}

// snap targets for a moving node: every OTHER node's left/center/right (and
// top/middle/bottom) edge in absolute inches, tagged by axis. Consumed by the
// canvas to draw alignment guides and snap while dragging.
export function alignmentTargets(elements, theme, excludeIds = []) {
  const boxes = absBoxes(elements, theme)
  const skip = excludeIds instanceof Set ? excludeIds : new Set(excludeIds)
  const x = []
  const y = []
  const walk = (list) => {
    for (const el of list || []) {
      if (!skip.has(el.id) && !el.hidden) {
        const b = boxes.get(el.id)
        if (b) {
          x.push(b.x, b.x + b.w / 2, b.x + b.w)
          y.push(b.y, b.y + b.h / 2, b.y + b.h)
        }
      }
      if (el.children) walk(el.children)
    }
  }
  walk(elements)
  return { x, y }
}

const TYPE_LABELS = {
  text: 'Texto', shape: 'Forma', line: 'Linha', icon: 'Ícone',
  image: 'Imagem', chart: 'Gráfico', group: 'Grupo',
}

export function typeLabel(type) {
  return TYPE_LABELS[type] || type
}

export function nodeLabel(el) {
  if (el.name) return el.name
  if (el.type === 'text' && el.text) {
    const t = el.text.replace(/\s+/g, ' ').trim()
    return t.length > 30 ? `${t.slice(0, 30)}…` : t || TYPE_LABELS.text
  }
  if (el.type === 'chart' && el.chart?.kind) return `Gráfico · ${el.chart.kind}`
  return TYPE_LABELS[el.type] || el.type
}
