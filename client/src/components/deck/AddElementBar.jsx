import { useRef } from 'react'
import * as Icon from '../Icons.jsx'
import { defaultElement } from '../../../../shared/deckLayout.js'
import { fileToDataUrl } from '../../lib/pptxMining.js'

// Add-element toolbar for the freeform canvas. Text/rectangle/ellipse/line ARM
// a drag-to-create tool (click the button, then draw the frame on the canvas —
// click without dragging drops a default size); the armed button stays lit
// until you draw or press Esc. Icon/chart/group/image add immediately at a
// default spot (they aren't about a drawn frame). Plus selection-aware
// Group/Ungroup (mirroring Cmd+G / Cmd+Shift+G).
export default function AddElementBar({ theme, onAdd, tool, onArmTool, canGroup = false, canUngroup = false, onGroup, onUngroup }) {
  const fileRef = useRef(null)

  const add = (type, extra = {}) => {
    const el = { ...defaultElement(type, theme), ...extra }
    onAdd(el)
  }

  // a tool key disambiguates rectangle vs ellipse (both type 'shape')
  const toolKey = (tl) => (tl ? `${tl.type}${tl.extra?.shape ? `:${tl.extra.shape}` : ''}` : null)
  const activeKey = toolKey(tool)
  const btn = 'flex items-center gap-1 rounded-lg text-[11px] font-semibold px-2 py-1.5 transition'
  const idle = 'bg-[var(--surface-3)] hover:brightness-110'
  const armed = 'bg-[var(--accent)] text-white'
  const cls = (key) => `${btn} ${activeKey === key ? armed : idle}`
  const actionBtn = 'flex items-center gap-1 rounded-lg text-[11px] font-semibold px-2 py-1.5 transition disabled:opacity-35 disabled:cursor-not-allowed'

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button className={cls('text')} onClick={() => onArmTool?.({ type: 'text' })} title="Caixa de texto — clique e arraste no slide (ou só clique)">
        <span className="font-bold">T</span> Texto
      </button>
      <button className={cls('shape:roundRect')} onClick={() => onArmTool?.({ type: 'shape', extra: { shape: 'roundRect' } })} title="Retângulo — clique e arraste no slide">
        ▢ Retângulo
      </button>
      <button className={cls('shape:ellipse')} onClick={() => onArmTool?.({ type: 'shape', extra: { shape: 'ellipse' } })} title="Elipse — clique e arraste no slide">
        ◯ Elipse
      </button>
      <button className={cls('line')} onClick={() => onArmTool?.({ type: 'line', extra: { style: { lineColor: theme?.accent, lineWidth: 2, arrowEnd: true } } })} title="Linha / seta — clique e arraste no slide">
        → Seta
      </button>
      <button className={`${btn} ${idle}`} onClick={() => add('icon')} title="Ícone (troque no painel ao lado)">
        <Icon.Sparkle size={12} /> Ícone
      </button>
      <button className={`${btn} ${idle}`} onClick={() => add('chart')} title="Gráfico (tipo e dados no painel ao lado)">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
        </svg>
        Gráfico
      </button>
      <button className={`${btn} ${idle}`} onClick={() => add('group')} title="Grupo vazio com auto-layout (arraste elementos para dentro pela árvore de camadas)">
        ▣ Grupo
      </button>
      <button className={`${btn} ${idle}`} onClick={() => fileRef.current?.click()} title="Imagem (upload)">
        <Icon.Upload size={12} /> Imagem
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          try {
            const dataUrl = await fileToDataUrl(f)
            if (dataUrl.length < 8_000_000) add('image', { imageDataUrl: dataUrl })
          } catch {
            // unreadable image — ignore
          }
        }}
      />
      <span className="w-px h-5 bg-[var(--border)] mx-0.5" aria-hidden />
      <button
        className={`${actionBtn} bg-[var(--surface-3)] hover:brightness-110`}
        onClick={onGroup}
        disabled={!canGroup}
        title="Agrupar os elementos selecionados (Cmd+G) — selecione 2+ com shift-clique"
      >
        ▣ Agrupar
      </button>
      <button
        className={`${actionBtn} bg-[var(--surface-3)] hover:brightness-110`}
        onClick={onUngroup}
        disabled={!canUngroup}
        title="Desagrupar o grupo selecionado (Cmd+Shift+G)"
      >
        ▢ Desagrupar
      </button>
    </div>
  )
}
