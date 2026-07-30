import { useEffect, useState } from 'react'
import * as Icon from '../Icons.jsx'
import DeckSlidePreview from '../DeckSlidePreview.jsx'
import { getJSON } from '../../api.js'
import { useT } from '../../lib/i18n.jsx'

export default function DeckBlock({ block, onOpenDeck }) {
  const t = useT()
  const [template, setTemplate] = useState(null)
  // block.slides is a snapshot frozen when the deck was generated; the studio
  // edits the persisted deck (/api/decks/:id) without touching it. Fetch the
  // live deck by id so the card mirrors the current state, and re-fetch when the
  // studio broadcasts a save. Fall back to the snapshot while loading / on error.
  const [liveDeck, setLiveDeck] = useState(null)

  useEffect(() => {
    getJSON('/api/deck-templates/selected')
      .then((r) => setTemplate(r.template || null))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!block.deckId) return
    let alive = true
    const load = () =>
      getJSON(`/api/decks/${block.deckId}`)
        .then((d) => {
          if (alive) setLiveDeck(d?.deck || null)
        })
        .catch(() => {})
    load()
    const onSaved = (e) => {
      if (e.detail?.deckId === block.deckId) load()
    }
    window.addEventListener('prism:deck-saved', onSaved)
    return () => {
      alive = false
      window.removeEventListener('prism:deck-saved', onSaved)
    }
  }, [block.deckId])

  const slides = liveDeck?.slides || block.slides || []
  const title = liveDeck?.title || block.title
  const slideCount = slides.length
  const preview = slides.slice(0, 3)

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 my-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Icon.Presentation size={16} className="text-[var(--accent)]" />
        <span className="truncate">{title}</span>
        <span className="text-xs font-normal text-[var(--faint)] shrink-0">
          {t('deckBlock.slideCount', { count: slideCount, slide: slideCount !== 1 ? t('deckBlock.slidePlural') : t('deckBlock.slideSingular') })}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-3">
        {preview.map((s, i) => (
          <DeckSlidePreview key={i} slide={s} template={template} deck={liveDeck || block} deckTitle={title} variant="card" pageNumber={i + 1} />
        ))}
      </div>

      <button
        onClick={() => onOpenDeck?.(block.deckId)}
        disabled={!block.deckId}
        className="mt-3 w-full flex items-center justify-center gap-2 rounded-xl bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white font-semibold text-sm py-2 transition"
      >
        <Icon.Presentation size={15} /> {t('deckBlock.openStudio')}
      </button>
    </div>
  )
}
