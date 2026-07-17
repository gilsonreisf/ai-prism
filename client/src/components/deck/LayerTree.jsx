import { useEffect, useRef, useState } from 'react'
import * as Icon from '../Icons.jsx'
import { resolvePreviewTheme } from '../DeckSlidePreview.jsx'
import { findNode, findParent, updateNode, moveNode, nodeLabel, typeLabel } from '../../lib/deckTree.js'

// Claude-Design-style layer tree for freeform slides: the slide's element
// tree as a nested, selectable, renamable, drag-reorderable list. At every
// level rows render in REVERSE array order (top row = front-most object),
// mirroring how designers read a layers panel; drops convert back to array
// indices. Selection is shared state with the canvas (ids), so clicking here
// highlights there and vice-versa.

const TYPE_GLYPHS = {
  text: 'T',
  shape: '▢',
  line: '╱',
  icon: '☆',
  image: '🖻',
  chart: '📊',
  group: '▣',
}

function TypeGlyph({ type }) {
  if (type === 'chart') {
    return (
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
      </svg>
    )
  }
  return <span className="text-[10px] leading-none w-[11px] text-center">{TYPE_GLYPHS[type] || '?'}</span>
}

function EyeOff({ size = 12 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 8 10 8a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  )
}

function collectAncestors(elements, id, acc = []) {
  const { parent } = findParent(elements, id)
  if (parent) {
    acc.push(parent.id)
    collectAncestors(elements, parent.id, acc)
  }
  return acc
}

export default function LayerTree({ elements, selectedIds = [], onSelect, onChangeElements, template }) {
  const theme = resolvePreviewTheme(template)
  const [expanded, setExpanded] = useState(() => new Set())
  const [renaming, setRenaming] = useState(null)
  const [dropHint, setDropHint] = useState(null) // { id, pos: 'above'|'below'|'inside' }
  const dragId = useRef(null)
  const renameRef = useRef(null)

  // selecting on the canvas auto-expands the tree down to the node
  useEffect(() => {
    if (!selectedIds.length) return
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const id of selectedIds) for (const a of collectAncestors(elements, id)) next.add(a)
      return next
    })
  }, [selectedIds, elements])

  useEffect(() => {
    if (renaming && renameRef.current) {
      renameRef.current.focus()
      renameRef.current.select()
    }
  }, [renaming])

  const toggleExpand = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleHidden = (id) => {
    const node = findNode(elements, id)
    onChangeElements(
      updateNode(elements, id, (n) => {
        const next = { ...n }
        if (node.hidden) delete next.hidden
        else next.hidden = true
        return next
      }),
      { commit: true }
    )
  }

  const commitRename = (id, value) => {
    setRenaming(null)
    onChangeElements(
      updateNode(elements, id, (n) => {
        const next = { ...n }
        if (value.trim()) next.name = value.trim().slice(0, 60)
        else delete next.name
        return next
      }),
      { commit: true }
    )
  }

  const handleDrop = (targetId, pos) => {
    const src = dragId.current
    dragId.current = null
    setDropHint(null)
    if (!src || src === targetId) return
    const target = findNode(elements, targetId)
    if (!target) return
    if (pos === 'inside' && target.type === 'group') {
      // drop into a group: land on top of its display stack (end of array)
      onChangeElements(moveNode(elements, src, targetId, (target.children || []).length, theme), { commit: true })
      setExpanded((prev) => new Set(prev).add(targetId))
      return
    }
    const { parent, index } = findParent(elements, targetId)
    if (index === -1) return
    // display is reversed: dropping ABOVE a row means a HIGHER array index
    const insertAt = pos === 'above' ? index + 1 : index
    onChangeElements(moveNode(elements, src, parent?.id || null, insertAt, theme), { commit: true })
  }

  const Row = ({ el, depth }) => {
    const isGroup = el.type === 'group'
    const isSel = selectedIds.includes(el.id)
    const isOpen = expanded.has(el.id)
    const hint = dropHint?.id === el.id ? dropHint.pos : null
    return (
      <div>
        <div
          draggable={renaming !== el.id}
          onDragStart={(ev) => {
            dragId.current = el.id
            ev.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(ev) => {
            ev.preventDefault()
            if (!dragId.current || dragId.current === el.id) return
            const rect = ev.currentTarget.getBoundingClientRect()
            const t = (ev.clientY - rect.top) / rect.height
            const pos = isGroup && t > 0.3 && t < 0.7 ? 'inside' : t < 0.5 ? 'above' : 'below'
            setDropHint((cur) => (cur?.id === el.id && cur.pos === pos ? cur : { id: el.id, pos }))
          }}
          onDragLeave={() => setDropHint((cur) => (cur?.id === el.id ? null : cur))}
          onDrop={(ev) => {
            ev.preventDefault()
            handleDrop(el.id, dropHint?.id === el.id ? dropHint.pos : 'above')
          }}
          onClick={(ev) => {
            if (ev.shiftKey) {
              onSelect(isSel ? selectedIds.filter((i) => i !== el.id) : [...selectedIds, el.id])
            } else {
              onSelect([el.id])
            }
          }}
          onDoubleClick={(ev) => {
            ev.stopPropagation()
            setRenaming(el.id)
          }}
          className={`group/row relative flex items-center gap-1.5 h-7 rounded-md pr-1.5 cursor-pointer select-none transition-colors ${
            isSel ? 'bg-[var(--accent-soft)] text-[var(--text)]' : 'text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]'
          } ${el.hidden ? 'opacity-45' : ''}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          {hint && hint !== 'inside' && (
            <div
              className="absolute left-2 right-2 h-[2px] rounded bg-[#3B82F6] pointer-events-none"
              style={hint === 'above' ? { top: -1 } : { bottom: -1 }}
            />
          )}
          {hint === 'inside' && <div className="absolute inset-0 rounded-md ring-1 ring-[#3B82F6] pointer-events-none" />}
          {isGroup ? (
            <button
              onClick={(ev) => {
                ev.stopPropagation()
                toggleExpand(el.id)
              }}
              className="shrink-0 w-4 h-4 grid place-items-center text-[var(--faint)] hover:text-[var(--text)]"
            >
              <Icon.ChevronRight size={10} className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
            </button>
          ) : (
            <span className="shrink-0 w-4" />
          )}
          <span className={`shrink-0 grid place-items-center w-4 ${isSel ? 'text-[var(--accent)]' : 'text-[var(--faint)]'}`}>
            <TypeGlyph type={el.type} />
          </span>
          {renaming === el.id ? (
            <input
              ref={renameRef}
              defaultValue={el.name || ''}
              placeholder={nodeLabel(el)}
              onBlur={(ev) => commitRename(el.id, ev.target.value)}
              onKeyDown={(ev) => {
                ev.stopPropagation()
                if (ev.key === 'Enter') ev.currentTarget.blur()
                if (ev.key === 'Escape') setRenaming(null)
              }}
              onClick={(ev) => ev.stopPropagation()}
              className="flex-1 min-w-0 bg-[var(--surface)] border border-[var(--accent)] rounded px-1 text-[11px] outline-none"
            />
          ) : (
            <span className="flex-1 min-w-0 truncate text-[11px]" title={nodeLabel(el)}>
              {nodeLabel(el)}
            </span>
          )}
          {isGroup && <span className="shrink-0 text-[9px] text-[var(--faint)] tabular-nums">{(el.children || []).length}</span>}
          <span className="shrink-0 text-[9px] text-[var(--faint)] hidden lg:block">{typeLabel(el.type).toLowerCase()}</span>
          <button
            onClick={(ev) => {
              ev.stopPropagation()
              toggleHidden(el.id)
            }}
            title={el.hidden ? 'Mostrar' : 'Ocultar'}
            className={`shrink-0 w-5 h-5 grid place-items-center rounded text-[var(--faint)] hover:text-[var(--text)] ${
              el.hidden ? '' : 'opacity-0 group-hover/row:opacity-100'
            }`}
          >
            {el.hidden ? <EyeOff size={12} /> : <Icon.Eye size={12} />}
          </button>
        </div>
        {isGroup && isOpen && (
          <div>
            {[...(el.children || [])].reverse().map((c) => (
              <Row key={c.id} el={c} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    )
  }

  if (!elements?.length) {
    return <p className="text-[11px] text-[var(--faint)] px-2 py-1.5">Sem elementos neste slide ainda.</p>
  }
  return (
    <div className="py-1" onDragEnd={() => setDropHint(null)}>
      {[...elements].reverse().map((el) => (
        <Row key={el.id} el={el} depth={0} />
      ))}
    </div>
  )
}
