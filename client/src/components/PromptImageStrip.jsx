import * as Icon from './Icons.jsx'

// Removable thumbnails for images attached to an AI tweak prompt (Deck +
// Spreadsheet studios). `images` are { id, name, dataUrl }; `onRemove(id)`
// drops one. Renders nothing when empty.
export default function PromptImageStrip({ images, onRemove }) {
  if (!images?.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 mb-1.5">
      {images.map((im) => (
        <span key={im.id} className="relative group inline-flex">
          <img src={im.dataUrl} alt={im.name} className="w-10 h-10 rounded-md object-cover border border-[var(--border)]" />
          <button
            onClick={() => onRemove(im.id)}
            className="absolute -top-1.5 -right-1.5 p-0.5 rounded-full bg-[var(--surface-3)] border border-[var(--border)] text-[var(--faint)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition"
            title={im.name}
          >
            <Icon.Close size={11} />
          </button>
        </span>
      ))}
    </div>
  )
}
