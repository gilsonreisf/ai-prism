import * as Icon from '../Icons.jsx'
import { useT } from '../../lib/i18n.jsx'

// Compact file-chip for a generated `document` block — mirrors DeckBlock /
// SpreadsheetBlock. Shows the title + a short preview line and opens the full
// Document Studio (rich-text preview + AI editing + DOCX/MD/PDF export). The
// rich rendering lives in the Studio, not inline.
export default function DocumentBlock({ block, onOpenDocument }) {
  const t = useT()
  const canOpen = !!block.documentId
  // a short plain-text teaser from the markdown (strip the most common marks)
  const teaser = (block.markdown || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>#-]/g, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 140)

  return (
    <div className="my-3">
      <div
        onClick={() => canOpen && onOpenDocument?.(block.documentId)}
        className={`group flex items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5 transition ${
          canOpen ? 'hover:border-[var(--accent)] cursor-pointer' : ''
        }`}
      >
        <div className="mt-0.5 rounded-lg bg-[var(--accent-soft)] p-2 shrink-0">
          <Icon.FileText size={18} className="text-[var(--accent)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-sm truncate">{block.title || t('docBlock.defaultTitle')}</div>
          <div className="text-xs text-[var(--faint)] mt-0.5">{t('docBlock.meta')}</div>
          {teaser && <div className="text-xs text-[var(--muted)] mt-1.5 line-clamp-2 leading-relaxed">{teaser}</div>}
        </div>
        {canOpen && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onOpenDocument?.(block.documentId)
            }}
            className="shrink-0 flex items-center gap-1.5 rounded-xl bg-[var(--accent)] hover:brightness-110 text-white font-semibold text-xs px-3 py-2 transition"
          >
            <Icon.FileText size={14} /> {t('docBlock.open')}
          </button>
        )}
      </div>
    </div>
  )
}
