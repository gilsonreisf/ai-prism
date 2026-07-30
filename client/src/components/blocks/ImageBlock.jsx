import { useEffect, useRef, useState } from 'react'
import * as Icon from '../Icons.jsx'
import Skeleton from '../Skeleton.jsx'
import CostBadge from '../CostBadge.jsx'
import { useT } from '../../lib/i18n.jsx'

// Renders a generated `image` block inline in the chat. The bytes live on a UC
// Volume and are served (scoped to the owner) by GET /api/images/:id — we fetch
// them as a blob once, hold the object URL for the block's lifetime, and offer
// download / copy / open-full-size. Mirrors the DeckBlock/SpreadsheetBlock
// card styling and the chart block's PNG-download pattern.
export default function ImageBlock({ block, models }) {
  const t = useT()
  const [url, setUrl] = useState(null)
  const [status, setStatus] = useState('loading') // loading | ready | error
  const [copied, setCopied] = useState(false)
  const blobRef = useRef(null)

  useEffect(() => {
    let alive = true
    if (!block.imageId) {
      setStatus('error')
      return
    }
    ;(async () => {
      try {
        const res = await fetch(`/api/images/${block.imageId}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        if (!alive) return
        blobRef.current = blob
        const objUrl = URL.createObjectURL(blob)
        setUrl(objUrl)
        setStatus('ready')
      } catch {
        if (alive) setStatus('error')
      }
    })()
    return () => {
      alive = false
    }
  }, [block.imageId])

  // revoke the object URL only on unmount / id change (not on every render)
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [url])

  const filename = () => {
    const base = (block.caption || block.prompt || 'imagem')
      .replace(/[^\w-]+/g, '_')
      .slice(0, 60) || 'imagem'
    return `${base}.png`
  }

  const download = () => {
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.download = filename()
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const copy = async () => {
    try {
      const blob = blobRef.current
      if (!blob || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard blocked (permissions / unsupported) — silently no-op; the
      // download action is always available as a fallback.
    }
  }

  const canCopy = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-2 my-3 max-w-[520px]">
      <div className="relative group overflow-hidden rounded-xl">
        {status === 'loading' && <Skeleton className="w-full aspect-square" rounded="rounded-xl" />}
        {status === 'error' && (
          <div className="w-full aspect-square flex flex-col items-center justify-center gap-2 text-[var(--faint)] text-sm">
            <Icon.Image size={22} className="opacity-40" />
            {t('imageBlock.failed')}
          </div>
        )}
        {status === 'ready' && url && (
          <a href={url} target="_blank" rel="noreferrer" title={t('imageBlock.openTitle')} className="block">
            <img
              src={url}
              alt={block.alt || block.caption || t('imageBlock.alt')}
              className="w-full h-auto block rounded-xl"
            />
          </a>
        )}
      </div>

      {block.caption && (
        <div className="px-1.5 pt-2 text-xs text-[var(--muted)] leading-relaxed">{block.caption}</div>
      )}

      {/* Always-visible action bar — download and copy are primary affordances
          for a generated image, not hover-only easter eggs (also works on touch
          and when hover is unavailable). */}
      {status === 'ready' && url && (
        <div className="flex items-center gap-1.5 px-1 pt-2 pb-0.5">
          <button
            onClick={download}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-3)] px-2.5 py-1.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] transition"
          >
            <Icon.Download size={14} /> {t('imageBlock.download')}
          </button>
          {canCopy && (
            <button
              onClick={copy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-3)] px-2.5 py-1.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] transition"
            >
              {copied ? <Icon.Check size={14} className="text-[var(--accent)]" /> : <Icon.Copy size={14} />}
              {copied ? t('imageBlock.copied') : t('imageBlock.copy')}
            </button>
          )}
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-3)] px-2.5 py-1.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] transition"
          >
            <Icon.Expand size={14} /> {t('imageBlock.open')}
          </a>
          {block.usage && (
            <CostBadge usage={block.usage} model={block.model} models={models} className="ml-auto text-[11px]" />
          )}
        </div>
      )}
    </div>
  )
}
