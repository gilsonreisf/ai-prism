import { useEffect, useState } from 'react'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'
import { getJSON, putJSON } from '../api.js'

const PROVIDER_DOT = {
  Anthropic: '#d97757',
  OpenAI: '#10a37f',
  'OpenAI (OSS)': '#10a37f',
  Google: '#4285f4',
  Meta: '#0668e1',
  'Zhipu AI': '#7c3aed',
  Alibaba: '#ff6a00',
  Outros: '#888',
}

// Admin tab: the org's LLM catalog. Lists every AI Gateway chat endpoint
// (discovered ∪ curated ∪ overrides). The admin toggles each on/off for the
// org and — when on — sets the display name + short description users see in
// the model picker. Only enabled endpoints reach regular users (GET /api/models).
export default function ModelsAdminTab({ open, onModelsChanged }) {
  const t = useT()
  const [endpoints, setEndpoints] = useState(null)
  const [error, setError] = useState('')
  const [savingId, setSavingId] = useState(null)
  // local edit buffers keyed by endpoint id, so typing doesn't fight the list
  const [edits, setEdits] = useState({})
  // syntactic filter over displayName + id (item 3)
  const [query, setQuery] = useState('')

  const load = async () => {
    try {
      const r = await getJSON('/api/admin/model-endpoints')
      setEndpoints(r.endpoints || [])
      setError('')
    } catch (e) {
      setError(e.message)
      setEndpoints([])
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const editOf = (ep) => edits[ep.id] || { displayName: ep.displayName, blurb: ep.blurb }

  const save = async (ep, patch) => {
    const current = editOf(ep)
    const body = {
      enabled: patch.enabled ?? ep.enabled,
      displayName: patch.displayName ?? current.displayName,
      blurb: patch.blurb ?? current.blurb,
      sortOrder: ep.sortOrder,
    }
    setSavingId(ep.id)
    try {
      await putJSON(`/api/admin/model-endpoints/${encodeURIComponent(ep.id)}`, body)
      // reflect locally without a full reload flicker
      setEndpoints((list) =>
        list.map((x) => (x.id === ep.id ? { ...x, ...body } : x))
      )
      // propagate to the chat's model picker live — server already invalidated
      // its enabled-models cache; this refetches /api/models so the new name/
      // blurb/availability shows without a page reload (item 4)
      onModelsChanged?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setSavingId(null)
    }
  }

  if (endpoints === null) {
    return <div className="text-sm text-[var(--muted)]">{t('models.loading')}</div>
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold flex items-center gap-2">
          <Icon.Wrench size={16} /> {t('settings.tab.models')}
        </h3>
        <p className="text-xs text-[var(--muted)] mt-0.5">
          {t('models.subtitle')}
        </p>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      {/* syntactic search over name + endpoint id */}
      <div className="relative">
        <Icon.Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('models.searchPlaceholder')}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] pl-8 pr-3 py-1.5 text-sm outline-none focus:border-[var(--accent)] placeholder:text-[var(--faint)]"
        />
      </div>

      <div className="space-y-2">
        {(() => {
          const q = query.trim().toLowerCase()
          const shown = q
            ? endpoints.filter(
                (ep) =>
                  (ep.displayName || '').toLowerCase().includes(q) || (ep.id || '').toLowerCase().includes(q)
              )
            : endpoints
          if (!shown.length) {
            return (
              <div className="text-xs text-[var(--faint)] py-6 text-center">
                {t('models.noMatch', { query })}
              </div>
            )
          }
          return shown.map((ep) => {
          const e = editOf(ep)
          const dot = PROVIDER_DOT[ep.provider] || PROVIDER_DOT.Outros
          return (
            <div
              key={ep.id}
              className={`rounded-xl border p-3 transition ${
                ep.enabled ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)]/30' : 'border-[var(--border)]'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="block w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate flex items-center gap-2">
                    {ep.displayName}
                    {!ep.discovered && (
                      <span className="text-[10px] text-[var(--faint)] border border-[var(--border)] rounded px-1">
                        {t('models.badge.notListed')}
                      </span>
                    )}
                    {ep.discovered && !ep.curated && (
                      <span className="text-[10px] text-[var(--accent)] border border-[var(--accent)]/40 rounded px-1">
                        {t('models.badge.new')}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-[var(--faint)] font-mono truncate">{ep.id}</div>
                </div>
                {savingId === ep.id && <span className="text-[11px] text-[var(--faint)]">{t('common.saving')}</span>}
                {/* on/off toggle */}
                <button
                  onClick={() => save(ep, { enabled: !ep.enabled })}
                  className={`relative w-10 h-6 rounded-full transition shrink-0 ${
                    ep.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--surface-3)]'
                  }`}
                  aria-label={ep.enabled ? t('models.disable') : t('models.enable')}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                      ep.enabled ? 'translate-x-4' : ''
                    }`}
                  />
                </button>
              </div>

              {ep.enabled && (
                <div className="mt-3 pl-5 space-y-2">
                  <div>
                    <label className="text-[11px] text-[var(--muted)]">{t('models.displayName')}</label>
                    <input
                      value={e.displayName}
                      onChange={(ev) =>
                        setEdits((m) => ({ ...m, [ep.id]: { ...editOf(ep), displayName: ev.target.value } }))
                      }
                      onBlur={() => save(ep, {})}
                      placeholder={t('models.displayNamePlaceholder')}
                      className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-[var(--muted)]">{t('models.blurb')}</label>
                    <input
                      value={e.blurb}
                      onChange={(ev) =>
                        setEdits((m) => ({ ...m, [ep.id]: { ...editOf(ep), blurb: ev.target.value } }))
                      }
                      onBlur={() => save(ep, {})}
                      placeholder={t('models.blurbPlaceholder')}
                      className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                </div>
              )}
            </div>
          )
          })
        })()}
      </div>
    </div>
  )
}
