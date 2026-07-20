import { useState } from 'react'
import Logo from './Logo.jsx'
import * as Icon from './Icons.jsx'
import { timeGroupKey } from '../lib/date.js'
import { useT } from '../lib/i18n.jsx'

// Shown while the session list is being fetched — without it, an empty
// sidebar briefly reads as "you have no conversations" instead of "loading".
function SidebarSkeleton() {
  return (
    <div className="px-3 pt-2 space-y-2 animate-fade-in">
      {[85, 65, 90, 55, 75, 60].map((w, i) => (
        <div
          key={i}
          className="h-8 rounded-lg bg-gradient-to-r from-[var(--surface-2)] via-[var(--surface-3)] to-[var(--surface-2)] bg-[length:200%_100%] animate-shimmer"
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  )
}

export default function Sidebar({
  open,
  email,
  sessions,
  sessionsLoading,
  currentId,
  onNew,
  onSelect,
  onDelete,
  deletingId,
  onRename,
  onClose,
  onOpenHistory,
  collapsed,
  onToggleCollapse,
  overlay,
}) {
  const t = useT()
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState('')

  const groups = []
  let lastGroup = null
  for (const sNode of sessions) {
    const g = timeGroupKey(sNode.updated_at || sNode.created_at)
    if (g !== lastGroup) {
      groups.push({ key: g, items: [] })
      lastGroup = g
    }
    groups[groups.length - 1].items.push(sNode)
  }

  const startEdit = (sNode) => {
    setEditingId(sNode.id)
    setDraft(sNode.title)
  }
  const commitEdit = () => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }

  return (
    <>
      {/* collapsed desktop rail — mobile always shows the full drawer below,
          regardless of this preference, so it's gated with plain conditional
          rendering (not a responsive class) plus `hidden md:flex` as a belt-
          and-suspenders guard against a flash at the md breakpoint */}
      {collapsed && (
        <aside className="hidden md:flex z-30 h-full w-16 shrink-0 flex-col items-center bg-[var(--surface)] border-r border-[var(--border)] py-3 gap-2">
          <button
            onClick={onToggleCollapse}
            className="p-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]"
            title={t('sidebar.expand')}
          >
            <Logo size={22} />
          </button>
          <button
            onClick={onToggleCollapse}
            className="p-1.5 rounded-lg hover:bg-[var(--surface-3)] text-[var(--faint)]"
            title={t('sidebar.expand')}
          >
            <Icon.ChevronRight size={15} />
          </button>
          <button
            onClick={onNew}
            className="mt-1 p-2.5 rounded-xl bg-[var(--accent)] hover:brightness-110 text-white transition shadow-sm shadow-black/20"
            title={t('sidebar.newChat')}
          >
            <Icon.Plus size={18} />
          </button>
          <button
            onClick={onOpenHistory}
            className="p-2.5 rounded-xl text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] transition"
            title={t('sidebar.history')}
          >
            <Icon.History size={18} />
          </button>
          <div className="flex-1" />
          <div
            className="w-8 h-8 rounded-full bg-[var(--surface-3)] grid place-items-center text-xs font-bold text-[var(--muted)]"
            title={email}
          >
            {(email || '?')[0].toUpperCase()}
          </div>
        </aside>
      )}

      {open && (
        <div
          className="fixed inset-0 z-20 bg-black/50 md:hidden"
          onClick={onClose}
        />
      )}
      {/* overlay mode (expanded Studio on desktop): the drawer floats OVER the
          narrow chat column instead of squeezing it; clicking the scrim tucks
          it back into the rail */}
      {overlay && !collapsed && (
        <div className="hidden md:block fixed inset-0 z-40 bg-black/30" onClick={onToggleCollapse} />
      )}
      <aside
        className={`fixed z-30 h-full w-[280px] shrink-0 flex flex-col bg-[var(--surface)] border-r border-[var(--border)] transition-transform duration-200 ${
          overlay ? 'md:z-50 md:shadow-2xl md:shadow-black/40' : 'md:static'
        } ${collapsed ? 'md:hidden' : ''} ${open ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}
      >
        {/* brand */}
        <div className="flex items-center gap-2.5 px-4 h-14 border-b border-[var(--border)]">
          <Logo size={26} />
          <div className="leading-none">
            <div className="font-extrabold tracking-tight text-[15px]">
              AI <span className="prism-text">Prism</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto md:hidden p-1.5 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]"
          >
            <Icon.Close size={18} />
          </button>
          <button
            onClick={onToggleCollapse}
            className="ml-auto hidden md:block p-1.5 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]"
            title={t('sidebar.collapse')}
          >
            <Icon.ChevronLeft size={16} />
          </button>
        </div>

        {/* new chat */}
        <div className="p-3 space-y-1.5">
          <button
            onClick={onNew}
            className="w-full flex items-center gap-2 justify-center rounded-xl bg-[var(--accent)] hover:brightness-110 text-white font-semibold text-sm py-2.5 transition shadow-sm shadow-black/20"
          >
            <Icon.Plus size={18} /> {t('sidebar.newChat')}
          </button>
          <button
            onClick={onOpenHistory}
            className="w-full flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)] transition"
          >
            <Icon.History size={17} /> {t('sidebar.history')}
          </button>
        </div>

        {/* sessions */}
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
          {sessionsLoading ? (
            <SidebarSkeleton />
          ) : sessions.length === 0 ? (
            <p className="px-3 py-6 text-xs text-[var(--faint)] text-center">
              {t('sidebar.empty')}
            </p>
          ) : null}
          {!sessionsLoading && groups.map((grp) => (
            <div key={grp.key}>
              <div className="px-3 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--faint)]">
                {t(grp.key)}
              </div>
              {grp.items.map((sNode) => {
                const active = sNode.id === currentId
                const isDeleting = sNode.id === deletingId
                return (
                  <div
                    key={sNode.id}
                    className={`group relative flex items-center rounded-lg transition ${
                      active ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-2)]'
                    } ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    {editingId === sNode.id ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit()
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        className="flex-1 bg-transparent text-sm px-3 py-2 outline-none border-b border-[var(--accent)]"
                      />
                    ) : (
                      // full sidebar width for the title; it only gives up room
                      // (right padding) while hovered, when the overlaid
                      // rename/delete actions are actually visible
                      <button
                        onClick={() => onSelect(sNode.id)}
                        className={`flex-1 min-w-0 text-left text-sm py-2 pl-3 truncate ${
                          isDeleting ? 'pr-9' : 'pr-3 group-hover:pr-16'
                        }`}
                        title={sNode.title}
                      >
                        {sNode.title}
                      </button>
                    )}
                    <div
                      className={`absolute right-1 top-1/2 -translate-y-1/2 flex items-center ${
                        isDeleting ? 'flex' : 'hidden group-hover:flex'
                      }`}
                    >
                      {isDeleting ? (
                        <span className="p-1.5" title={t('sidebar.deleting')}>
                          <span className="block w-3.5 h-3.5 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
                        </span>
                      ) : (
                        <>
                          <button
                            onClick={() => startEdit(sNode)}
                            className="p-1.5 rounded-md hover:bg-[var(--surface)] text-[var(--muted)]"
                            title={t('sidebar.rename')}
                          >
                            <Icon.Pencil size={14} />
                          </button>
                          <button
                            onClick={() => onDelete(sNode.id)}
                            className="p-1.5 rounded-md hover:bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--accent)]"
                            title={t('common.delete')}
                          >
                            <Icon.Trash size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {/* footer */}
        <div className="border-t border-[var(--border)] p-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-[var(--surface-3)] grid place-items-center text-xs font-bold text-[var(--muted)]">
              {(email || '?')[0].toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium truncate">{email}</div>
            </div>
          </div>
          <a
            href="https://www.databricks.com/product/machine-learning/foundation-models"
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-1.5 text-[10.5px] text-[var(--faint)] hover:text-[var(--muted)] transition"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
            {t('sidebar.poweredBy')}
          </a>
        </div>
      </aside>
    </>
  )
}
