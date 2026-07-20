import { useEffect, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import { createRecognizer, dictationSupported } from '../lib/speech.js'
import { useT } from '../lib/i18n.jsx'

export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  files,
  setFiles,
  supportedExt,
  onOpenVoice,
}) {
  const t = useT()
  const fileInput = useRef(null)
  const taRef = useRef(null)
  const recRef = useRef(null)
  const baseRef = useRef('')
  const [listening, setListening] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const accept = (supportedExt || []).map((e) => '.' + e).join(',')

  // auto-grow the textarea with its content (up to max-h-48) — a fixed
  // one-line box feels cramped, especially in the narrow focus-mode column
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 192) + 'px'
  }, [value])

  const addFiles = (list) => {
    const incoming = Array.from(list)
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name + f.size))
      return [...prev, ...incoming.filter((f) => !names.has(f.name + f.size))].slice(0, 10)
    })
  }

  const doSend = () => {
    if (streaming) return
    if (!value.trim() && files.length === 0) return
    onSend(value, files)
  }

  const toggleDictation = () => {
    if (listening) {
      recRef.current?.stop()
      return
    }
    baseRef.current = value ? value.replace(/\s+$/, '') + ' ' : ''
    const rec = createRecognizer({
      lang: 'pt-BR',
      onResult: (t) => onChange(baseRef.current + t),
      onEnd: () => setListening(false),
      onError: () => setListening(false),
    })
    if (!rec) return
    recRef.current = rec
    rec.start()
    setListening(true)
  }

  return (
    <div className="px-3 md:px-0">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
        }}
        className={`rounded-3xl border bg-[var(--surface)] transition shadow-lg shadow-black/10 ${
          dragOver ? 'border-[var(--accent)] ring-2 ring-[var(--accent-soft)]' : 'border-[var(--border)]'
        }`}
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-3">
            {files.map((f, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 text-xs bg-[var(--surface-3)] rounded-lg pl-2 pr-1 py-1"
              >
                <Icon.File size={13} className="text-[var(--muted)]" />
                <span className="max-w-[160px] truncate">{f.name}</span>
                <button
                  onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                  className="p-0.5 rounded hover:bg-[var(--surface)] text-[var(--faint)]"
                >
                  <Icon.Close size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* two rows (textarea on top, controls below): the placeholder never
            wraps behind the buttons, no matter how narrow the chat column
            gets (e.g. Studio focus mode) */}
        <div className="px-3 pt-3 pb-2">
          <textarea
            ref={taRef}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                doSend()
              }
            }}
            placeholder={listening ? t('composer.listening') : t('composer.placeholder')}
            className="w-full max-h-48 resize-none bg-transparent outline-none text-[0.95rem] leading-relaxed placeholder:text-[var(--faint)]"
          />
        </div>
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <button
            onClick={() => fileInput.current?.click()}
            className="shrink-0 p-2 rounded-xl hover:bg-[var(--surface-3)] text-[var(--muted)] transition"
            title={t('composer.attach')}
          >
            <Icon.Paperclip size={19} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={accept}
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <span className="flex-1" />
          {dictationSupported && (
            <button
              onClick={toggleDictation}
              className={`shrink-0 p-2 rounded-xl transition relative ${
                listening
                  ? 'text-white bg-[var(--accent)]'
                  : 'hover:bg-[var(--surface-3)] text-[var(--muted)]'
              }`}
              title={t('composer.dictate')}
            >
              {listening && (
                <span className="absolute inset-0 rounded-xl bg-[var(--accent)] animate-pulse-ring" />
              )}
              <Icon.Mic size={19} />
            </button>
          )}

          <button
            onClick={onOpenVoice}
            className="shrink-0 p-2 rounded-xl hover:bg-[var(--surface-3)] text-[var(--muted)] transition"
            title={t('composer.voiceMode')}
          >
            <Icon.Waveform size={19} />
          </button>

          {streaming ? (
            <button
              onClick={onStop}
              className="shrink-0 p-2 rounded-xl bg-[var(--surface-3)] hover:bg-[var(--border)] text-[var(--text)] transition"
              title={t('composer.stop')}
            >
              <Icon.Stop size={18} />
            </button>
          ) : (
            <button
              onClick={doSend}
              disabled={!value.trim() && files.length === 0}
              className="shrink-0 p-2 rounded-xl bg-[var(--accent)] hover:brightness-110 text-white transition disabled:opacity-40 disabled:cursor-not-allowed"
              title={t('composer.send')}
            >
              <Icon.Send size={18} />
            </button>
          )}
        </div>
      </div>
      <p className="text-center text-balance text-[11px] leading-snug text-[var(--faint)] mt-2 mb-1.5 px-2">
        {t('composer.disclaimer')}
      </p>
    </div>
  )
}
