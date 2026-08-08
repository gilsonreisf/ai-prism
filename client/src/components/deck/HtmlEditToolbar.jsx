import { useT } from '../../lib/i18n.jsx'
import * as Icon from '../Icons.jsx'

// Create-asset toolbar for the HTML slide editor — Claude Design parity: Select,
// Text, Rectangle, Oval, Line, Arrow, Image, plus Undo/Redo. Picking a shape
// tool arms drag-to-create on the canvas (the iframe runtime draws the box and
// inserts the element); Image opens a file picker and drops the picture in.
// `tool` is the armed tool; clicking the active one disarms back to select.

function ToolBtn({ active, title, onClick, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-8 h-8 rounded-lg grid place-items-center transition ${
        active ? 'bg-[var(--accent)] text-white' : 'text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]'
      }`}
    >
      {children}
    </button>
  )
}

// small glyphs to match the Claude Design toolbar
const RectGlyph = () => <span className="w-3.5 h-3.5 rounded-[3px] border-2 border-current" />
const OvalGlyph = () => <span className="w-3.5 h-3.5 rounded-full border-2 border-current" />
const LineGlyph = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="3" y1="13" x2="13" y2="3" />
  </svg>
)
const ArrowGlyph = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
    <line x1="3" y1="13" x2="13" y2="3" />
    <path d="M7 3h6v6" />
  </svg>
)
const TextGlyph = () => <span className="text-[15px] font-bold leading-none">T</span>

export default function HtmlEditToolbar({ tool, onTool, onImage, onUndo, onRedo, canUndo, canRedo }) {
  const t = useT()
  const pick = (name) => onTool(tool === name ? 'select' : name)
  return (
    <div className="flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-1">
      <ToolBtn active={tool === 'select'} title={t('deckStudio.htmlEdit.tool.select')} onClick={() => onTool('select')}>
        <Icon.Pencil size={15} />
      </ToolBtn>
      <span className="w-px h-5 bg-[var(--border)] mx-0.5" />
      <ToolBtn active={tool === 'text'} title={t('deckStudio.htmlEdit.tool.text')} onClick={() => pick('text')}>
        <TextGlyph />
      </ToolBtn>
      <ToolBtn active={tool === 'rect'} title={t('deckStudio.htmlEdit.tool.rect')} onClick={() => pick('rect')}>
        <RectGlyph />
      </ToolBtn>
      <ToolBtn active={tool === 'oval'} title={t('deckStudio.htmlEdit.tool.oval')} onClick={() => pick('oval')}>
        <OvalGlyph />
      </ToolBtn>
      <ToolBtn active={tool === 'line'} title={t('deckStudio.htmlEdit.tool.line')} onClick={() => pick('line')}>
        <LineGlyph />
      </ToolBtn>
      <ToolBtn active={tool === 'arrow'} title={t('deckStudio.htmlEdit.tool.arrow')} onClick={() => pick('arrow')}>
        <ArrowGlyph />
      </ToolBtn>
      <label className="w-8 h-8 rounded-lg grid place-items-center text-[var(--muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)] cursor-pointer" title={t('deckStudio.htmlEdit.tool.image')}>
        <Icon.Image size={15} />
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (!f) return
            const r = new FileReader()
            r.onload = () => onImage(r.result)
            r.readAsDataURL(f)
            e.target.value = ''
          }}
        />
      </label>
      <span className="w-px h-5 bg-[var(--border)] mx-0.5" />
      <ToolBtn title={t('deckStudio.htmlEdit.undo')} onClick={onUndo}>
        <span className={canUndo ? '' : 'opacity-30'}>
          <Icon.Regenerate size={14} className="-scale-x-100" />
        </span>
      </ToolBtn>
      <ToolBtn title={t('deckStudio.htmlEdit.redo')} onClick={onRedo}>
        <span className={canRedo ? '' : 'opacity-30'}>
          <Icon.Regenerate size={14} />
        </span>
      </ToolBtn>
    </div>
  )
}
