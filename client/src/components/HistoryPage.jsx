import { useEffect, useMemo, useState } from 'react'
import * as Icon from './Icons.jsx'
import { relativeTime } from '../lib/date.js'
import { useT } from '../lib/i18n.jsx'

export default function HistoryPage({
  sessions,
  sessionsLoading,
  currentId,
  onSelect,
  onNew,
  onDelete,
  deletingId,
  onRename,
  onBack,
  onSearch,
  searchResults,
  searching,
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('newest')
  const [selected, setSelected] = useState(() => new Set())
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => onSearch(query.trim()), 350)
    return () => clearTimeout(timer)
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  const searchActive = query.trim().length > 0
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])

  const rows = useMemo(() => {
    if (searchActive) {
      return (searchResults || [])
        .map((r) => {
          const full = byId.get(r.id)
          return full ? { ...full, score: r.score } : { id: r.id, title: r.title, score: r.score }
        })
    }
    const sorted = [...sessions].sort((a, b) => {
      const da = new Date(a.updated_at || a.created_at).getTime()
      const db = new Date(b.updated_at || b.created_at).getTime()
      return sort === 'oldest' ? da - db : db - da
    })
    return sorted
  }, [searchActive, searchResults, sessions, sort, byId])

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleSelectAll = () => {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))))
  }

  const startEdit = (sNode) => {
    setEditingId(sNode.id)
    setDraft(sNode.title)
  }
  const commitEdit = () => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }

  const deleteSelected = async () => {
    const ids = [...selected]
    setSelected(new Set())
    for (const id of ids) await onDelete(id)
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <header className="shrink-0 flex items-center gap-3 px-4 md:px-6 h-14 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur">
        <button
          onClick={onBack}
          className="p-2 -ml-2 rounded-lg hover:bg-[var(--surface-3)] text-[var(--muted)]"
          title={t('history.back')}
        >
          <Icon.ChevronLeft size={20} />
        </button>
        <h1 className="font-bold text-lg flex items-center gap-2">
          <Icon.History size={18} /> {t('sidebar.history')}
        </h1>
        <button
          onClick={onNew}
          className="ml-auto flex items-center gap-1.5 rounded-xl bg-[var(--accent)] hover:brightness-110 text-white font-semibold text-sm px-3.5 py-2 transition"
        >
          <Icon.Plus size={16} /> {t('sidebar.newChat')}
        </button>
      </header>

      <div className="max-w-3xl w-full mx-auto px-4 md:px-6 pt-5 pb-2 flex flex-col gap-3 shrink-0">
        <div className="relative">
          <Icon.Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('history.searchPlaceholder')}
            className="w-full rounded-xl bg-[var(--surface-2)] border border-[var(--border)] pl-10 pr-9 py-2.5 text-sm outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
          />
          {searchActive && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-md text-[var(--faint)] hover:bg-[var(--surface-3)]"
            >
              <Icon.Close size={14} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-[var(--faint)] pl-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={rows.length > 0 && selected.size === rows.length}
              onChange={toggleSelectAll}
              className="accent-[var(--accent)]"
            />
            {t('history.selectAll')}
          </label>

          {!searchActive && (
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="text-xs rounded-lg bg-[var(--surface-2)] border border-[var(--border)] px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
            >
              <option value="newest">{t('history.sortNewest')}</option>
              <option value="oldest">{t('history.sortOldest')}</option>
            </select>
          )}

          {selected.size > 0 && (
            <button
              onClick={deleteSelected}
              className="ml-auto flex items-center gap-1.5 text-xs font-medium text-[var(--accent)] hover:brightness-110 rounded-lg px-2.5 py-1.5"
            >
              <Icon.Trash size={13} /> {t(selected.size > 1 ? 'history.deleteSelectedPlural' : 'history.deleteSelected', { n: selected.size })}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 md:px-6 pb-8">
          {sessionsLoading ? (
            <div className="pt-4 space-y-2">
              {[92, 78, 85, 60, 70].map((w, i) => (
                <div
                  key={i}
                  className="h-12 rounded-xl bg-gradient-to-r from-[var(--surface-2)] via-[var(--surface-3)] to-[var(--surface-2)] bg-[length:200%_100%] animate-shimmer"
                  style={{ width: `${w}%` }}
                />
              ))}
            </div>
          ) : searching ? (
            <p className="py-10 text-sm text-[var(--faint)] text-center">{t('history.searching')}</p>
          ) : rows.length === 0 ? (
            <p className="py-10 text-sm text-[var(--faint)] text-center">
              {searchActive ? t('history.noResults') : t('sidebar.empty')}
            </p>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {rows.map((r) => {
                const active = r.id === currentId
                const isDeleting = r.id === deletingId
                return (
                  <div
                    key={r.id}
                    className={`group flex items-center gap-3 py-2.5 px-1 transition ${
                      active ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-2)]'
                    } ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggleSelect(r.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="accent-[var(--accent)] shrink-0"
                    />

                    <button onClick={() => onSelect(r.id)} className="flex-1 min-w-0 flex items-center gap-3 text-left">
                      {editingId === r.id ? (
                        <input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commitEdit}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEdit()
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          className="flex-1 bg-transparent text-sm px-0 py-1 outline-none border-b border-[var(--accent)]"
                        />
                      ) : (
                        <span className="text-sm truncate" title={r.title}>
                          {r.title}
                        </span>
                      )}

                      {r.attachment_names?.length > 0 && (
                        <span className="hidden sm:flex items-center gap-1 shrink-0">
                          {r.attachment_names.slice(0, 2).map((name) => (
                            <span
                              key={name}
                              className="flex items-center gap-1 text-[10.5px] text-[var(--faint)] bg-[var(--surface-3)] rounded-md px-1.5 py-0.5 max-w-[9rem] truncate"
                              title={name}
                            >
                              <Icon.File size={10} className="shrink-0" />
                              {name}
                            </span>
                          ))}
                          {r.attachment_names.length > 2 && (
                            <span className="text-[10.5px] text-[var(--faint)]">
                              +{r.attachment_names.length - 2}
                            </span>
                          )}
                        </span>
                      )}
                    </button>

                    {typeof r.score === 'number' && (
                      <span className="text-[10px] font-mono text-[var(--faint)] shrink-0">
                        {Math.round(r.score * 100)}%
                      </span>
                    )}

                    <span className="text-xs text-[var(--faint)] shrink-0 w-20 text-right">
                      {r.updated_at ? (() => { const rt = relativeTime(r.updated_at); return t(rt.key, rt.vars) })() : ''}
                    </span>

                    <div className="flex items-center opacity-0 group-hover:opacity-100 transition shrink-0">
                      {isDeleting ? (
                        <span className="p-1.5" title={t('sidebar.deleting')}>
                          <span className="block w-3.5 h-3.5 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
                        </span>
                      ) : (
                        <>
                          <button
                            onClick={() => startEdit(r)}
                            className="p-1.5 rounded-md hover:bg-[var(--surface-3)] text-[var(--muted)]"
                            title={t('sidebar.rename')}
                          >
                            <Icon.Pencil size={13} />
                          </button>
                          <button
                            onClick={() => onDelete(r.id)}
                            className="p-1.5 rounded-md hover:bg-[var(--surface-3)] text-[var(--muted)] hover:text-[var(--accent)]"
                            title={t('common.delete')}
                          >
                            <Icon.Trash size={13} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
