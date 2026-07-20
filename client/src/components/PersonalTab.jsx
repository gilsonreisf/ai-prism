import { useState } from 'react'
import * as Icon from './Icons.jsx'
import { useT } from '../lib/i18n.jsx'

// Personal preferences: appearance, UI/response language, and desktop
// notifications. All persisted in localStorage by App (this tab is a pure
// controlled view over the props) — no server round-trip, so it applies live.

// Miniature app mock used in the theme cards, so the choice previews the actual
// surface colors instead of relying on a label alone (mirrors the reference UI).
function ThemePreview({ mode }) {
  const dark = { bg: '#0b0d0f', rail: '#161a1f', line: '#2a3038', bubble: '#1e2630', accent: '#ff3621' }
  const light = { bg: '#f7f8fa', rail: '#eef1f4', line: '#d7dde3', bubble: '#e6ebf0', accent: '#e5341f' }
  const Panel = ({ c, half }) => (
    <div
      className="relative overflow-hidden"
      style={{ background: c.bg, width: half ? '50%' : '100%', height: '100%' }}
    >
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: 14, background: c.rail }}>
        <div style={{ height: 4, width: 4, borderRadius: 9, background: c.line, margin: '5px auto' }} />
        <div style={{ height: 3, width: 6, borderRadius: 2, background: c.line, margin: '4px auto' }} />
        <div style={{ height: 3, width: 6, borderRadius: 2, background: c.line, margin: '4px auto' }} />
      </div>
      <div style={{ position: 'absolute', left: 20, right: 6, top: 8 }}>
        <div style={{ height: 3, width: '60%', borderRadius: 2, background: c.line, marginBottom: 6 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
          <div style={{ height: 8, width: '55%', borderRadius: 4, background: c.bubble }} />
          <div style={{ height: 7, width: 7, borderRadius: 9, background: c.accent }} />
        </div>
      </div>
    </div>
  )
  return (
    <div className="w-full h-20 rounded-lg overflow-hidden border border-[var(--border)] flex">
      {mode === 'system' ? (
        <>
          <Panel c={light} half />
          <Panel c={dark} half />
        </>
      ) : (
        <Panel c={mode === 'light' ? light : dark} />
      )}
    </div>
  )
}

function Row({ icon: IconCmp, title, hint, children }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex items-start gap-3 min-w-0">
        {IconCmp && <IconCmp size={17} className="text-[var(--muted)] mt-0.5 shrink-0" />}
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          {hint && <div className="text-xs text-[var(--muted)] mt-0.5">{hint}</div>}
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Select({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function Toggle({ on, onClick }) {
  return (
    <button
      onClick={onClick}
      role="switch"
      aria-checked={on}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
        on ? 'bg-[var(--accent)]' : 'bg-[var(--surface-3)]'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
          on ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

export default function PersonalTab({
  theme,
  setTheme,
  uiLang,
  setUiLang,
  responseLang,
  setResponseLang,
  notify,
  setNotify,
}) {
  const t = useT()
  const [notifHint, setNotifHint] = useState('')

  const THEMES = [
    { id: 'light', label: t('personal.theme.light') },
    { id: 'dark', label: t('personal.theme.dark') },
    { id: 'system', label: t('personal.theme.system') },
  ]

  const UI_LANGS = [
    { id: 'auto', label: t('personal.uiLang.auto') },
    { id: 'pt-BR', label: 'Português' },
    { id: 'en', label: 'English' },
    { id: 'es', label: 'Español' },
  ]

  const RESPONSE_LANGS = [
    { id: 'auto', label: t('personal.responseLang.auto') },
    { id: 'pt', label: 'Português' },
    { id: 'en', label: 'English' },
    { id: 'es', label: 'Español' },
  ]

  // Turning notifications on requires the browser permission — request it on
  // enable and only flip the pref if granted (denied → explain, don't silently
  // enable a setting that can never fire).
  const toggleNotify = async () => {
    if (notify) {
      setNotify(false)
      setNotifHint('')
      return
    }
    if (typeof Notification === 'undefined') {
      setNotifHint(t('personal.notify.unsupported'))
      return
    }
    if (Notification.permission === 'granted') {
      setNotify(true)
      setNotifHint('')
      return
    }
    if (Notification.permission === 'denied') {
      setNotifHint(t('personal.notify.blocked'))
      return
    }
    const perm = await Notification.requestPermission()
    if (perm === 'granted') {
      setNotify(true)
      setNotifHint('')
    } else {
      setNotifHint(t('personal.notify.denied'))
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-semibold flex items-center gap-2">
          <Icon.User size={16} /> {t('personal.title')}
        </h3>
        <p className="text-xs text-[var(--muted)] mt-0.5">
          {t('personal.subtitle')}
        </p>
      </div>

      {/* Appearance */}
      <div>
        <div className="text-sm font-medium mb-2">{t('personal.appearance')}</div>
        <div className="grid grid-cols-3 gap-2.5">
          {THEMES.map((th) => {
            const active = theme === th.id
            return (
              <button
                key={th.id}
                onClick={() => setTheme(th.id)}
                className={`rounded-xl border p-2 text-left transition ${
                  active
                    ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]'
                    : 'border-[var(--border)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <ThemePreview mode={th.id} />
                <div className="mt-1.5 flex items-center gap-1.5 text-xs font-medium px-0.5">
                  {active && <Icon.Check size={13} className="text-[var(--accent)]" />}
                  {th.label}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="border-t border-[var(--border)]" />

      {/* Language */}
      <div className="divide-y divide-[var(--border)]">
        <Row icon={Icon.Languages} title={t('personal.uiLangRow.title')} hint={t('personal.uiLangRow.hint')}>
          <Select value={uiLang} onChange={setUiLang} options={UI_LANGS} />
        </Row>
        <Row
          icon={Icon.Sparkle}
          title={t('personal.responseLangRow.title')}
          hint={t('personal.responseLangRow.hint')}
        >
          <Select value={responseLang} onChange={setResponseLang} options={RESPONSE_LANGS} />
        </Row>
        <Row
          icon={Icon.Bell}
          title={t('personal.notifyRow.title')}
          hint={notifHint || t('personal.notifyRow.hint')}
        >
          <Toggle on={notify} onClick={toggleNotify} />
        </Row>
      </div>
    </div>
  )
}
