import { useEffect, useRef, useState } from 'react'
import * as Icon from './Icons.jsx'
import { createRecognizer, dictationSupported } from '../lib/speech.js'
import { useT } from '../lib/i18n.jsx'

// One attachment chip. Image attachments show a live thumbnail (from an object
// URL, revoked on unmount) so a pasted/attached image is recognizable at a
// glance; audio/video show a media glyph (they'll be transcribed server-side);
// other files show the generic file icon + name.
function AttachmentChip({ file, isImage, media, onRemove }) {
  const [thumb, setThumb] = useState(null)
  useEffect(() => {
    if (!isImage) return
    const url = URL.createObjectURL(file)
    setThumb(url)
    return () => URL.revokeObjectURL(url)
  }, [file, isImage])

  if (!isImage && media) {
    const MediaIcon = media === 'video' ? Icon.Play : Icon.Waveform
    return (
      <span className="inline-flex items-center gap-1.5 text-xs bg-[var(--surface-3)] rounded-lg pl-2 pr-1 py-1">
        <MediaIcon size={13} className="text-[var(--accent)]" />
        <span className="max-w-[160px] truncate">{file.name}</span>
        <button onClick={onRemove} className="p-0.5 rounded hover:bg-[var(--surface)] text-[var(--faint)]">
          <Icon.Close size={12} />
        </button>
      </span>
    )
  }

  if (isImage) {
    return (
      <span className="relative group inline-flex">
        <img
          src={thumb || undefined}
          alt={file.name}
          className="w-14 h-14 rounded-lg object-cover border border-[var(--border)]"
        />
        <button
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 p-0.5 rounded-full bg-[var(--surface-3)] border border-[var(--border)] text-[var(--faint)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition"
          title="Remover"
        >
          <Icon.Close size={12} />
        </button>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs bg-[var(--surface-3)] rounded-lg pl-2 pr-1 py-1">
      <Icon.File size={13} className="text-[var(--muted)]" />
      <span className="max-w-[160px] truncate">{file.name}</span>
      <button onClick={onRemove} className="p-0.5 rounded hover:bg-[var(--surface)] text-[var(--faint)]">
        <Icon.Close size={12} />
      </button>
    </span>
  )
}

export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  files,
  setFiles,
  supportedExt,
  mediaExt,
  onOpenVoice,
}) {
  const t = useT()
  const fileInput = useRef(null)
  const taRef = useRef(null)
  const recRef = useRef(null)
  const baseRef = useRef('')
  const [listening, setListening] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  // images are always acceptable (pasted or attached) — they go to the model as
  // vision input, a separate path from the text-extracted document types. Audio
  // and video are accepted only when the workspace advertises media_extensions
  // (transcription enabled); they're transcribed server-side into text.
  const accept = [
    ...(supportedExt || []).map((e) => '.' + e),
    ...(mediaExt || []).map((e) => '.' + e),
    'image/*',
    ...((mediaExt || []).length ? ['audio/*', 'video/*'] : []),
  ].join(',')

  const isImageFile = (f) => (f.type || '').startsWith('image/')

  // Classify an attachment as audio/video for the chip glyph. Uses the mime type
  // first, then the extension against the workspace's advertised media list.
  const mediaKind = (f) => {
    const m = f.type || ''
    if (m.startsWith('audio/')) return 'audio'
    if (m.startsWith('video/')) return 'video'
    const dot = f.name.lastIndexOf('.')
    const ext = dot >= 0 ? f.name.slice(dot + 1).toLowerCase() : ''
    if ((mediaExt || []).includes(ext)) {
      // heuristic split for the icon only; the server does real detection
      return /^(mp4|mov|webm|m4v|mpeg|mpg|avi|mkv|3gp)$/.test(ext) ? 'video' : 'audio'
    }
    return null
  }

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

  // Paste-to-attach: the clipboard carries images as file items (e.g. a
  // screenshot, or "copy image" from a browser). Pull them out and attach them
  // like any other file — they reach the model as vision input. A pasted image
  // often has a generic name ("image.png"), which would collide with the
  // name+size dedup key, so give each a unique name. Non-image clipboard
  // content (plain text) is left to the textarea's default paste behavior.
  const onPaste = (e) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imgs = []
    for (const it of items) {
      if (it.kind === 'file' && (it.type || '').startsWith('image/')) {
        const blob = it.getAsFile()
        if (!blob) continue
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
        // stable-ish unique name; index keeps multiple pastes in one event distinct
        const name = blob.name && blob.name !== 'image.png'
          ? blob.name
          : `colado-${imgs.length + 1}-${blob.size}.${ext}`
        imgs.push(new File([blob], name, { type: blob.type }))
      }
    }
    if (imgs.length) {
      e.preventDefault() // don't also drop the image's binary as text into the box
      addFiles(imgs)
    }
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
              <AttachmentChip
                key={i}
                file={f}
                isImage={isImageFile(f)}
                media={mediaKind(f)}
                onRemove={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
              />
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
            onPaste={onPaste}
            placeholder={listening ? t('composer.listening') : t('composer.placeholder')}
            className="w-full max-h-48 resize-none bg-transparent outline-none text-[0.95rem] leading-relaxed placeholder:text-[var(--faint)]"
          />
        </div>
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <button
            onClick={() => fileInput.current?.click()}
            className="shrink-0 p-2 rounded-xl hover:bg-[var(--surface-3)] text-[var(--muted)] transition"
            title={(mediaExt || []).length ? t('composer.attachMedia') : t('composer.attach')}
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
