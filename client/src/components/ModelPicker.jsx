import { useState, useRef, useEffect } from 'react'
import * as Icon from './Icons.jsx'

const PROVIDER_DOT = {
  Anthropic: '#D97757',
  OpenAI: '#10A37F',
  'OpenAI (OSS)': '#10A37F',
  Google: '#4285F4',
  Meta: '#0668E1',
  Alibaba: '#FF6A00',
  'Zhipu AI': '#3859FF',
}

export default function ModelPicker({ models, value, onChange, disabled }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const current = models.find((m) => m.id === value) || models[0]

  useEffect(() => {
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  if (!current) return null

  return (
    <div className="relative" ref={ref}>
      <button
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] px-3 py-1.5 text-sm font-medium transition disabled:opacity-50"
      >
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: PROVIDER_DOT[current.provider] || '#888' }}
        />
        <span className="whitespace-nowrap">{current.label}</span>
        <Icon.ChevronDown size={15} className="text-[var(--muted)] shrink-0" />
      </button>

      {open && (
        <div className="absolute z-40 mt-2 w-[320px] max-h-[60vh] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl shadow-black/40 p-1.5">
          <div className="px-3 py-2 text-[11px] uppercase tracking-wide font-semibold text-[var(--faint)]">
            Modelos via AI Gateway
          </div>
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                onChange(m.id)
                setOpen(false)
              }}
              className={`w-full text-left rounded-xl px-3 py-2.5 transition flex gap-2.5 items-start ${
                m.id === value ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-2)]'
              }`}
            >
              <span
                className="mt-1.5 w-2 h-2 rounded-full shrink-0"
                style={{ background: PROVIDER_DOT[m.provider] || '#888' }}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{m.label}</span>
                  {m.vision && (
                    <span className="text-[9px] uppercase font-bold tracking-wide text-[var(--faint)] border border-[var(--border)] rounded px-1">
                      visão
                    </span>
                  )}
                </span>
                <span className="block text-xs text-[var(--muted)]">{m.provider}</span>
                <span className="block text-xs text-[var(--faint)] mt-0.5">{m.blurb}</span>
              </span>
              {m.id === value && <Icon.Check size={16} className="text-[var(--accent)] mt-1" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
