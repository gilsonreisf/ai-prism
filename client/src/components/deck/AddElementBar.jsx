import { useRef } from 'react'
import * as Icon from '../Icons.jsx'
import { defaultElement } from '../../../../shared/deckLayout.js'
import { fileToDataUrl } from '../../lib/pptxMining.js'

// Add-element toolbar for the freeform canvas: text box, rectangle, ellipse,
// line/arrow, icon and image — each lands pre-styled from the theme and
// selected, ready to drag/edit. Plus selection-aware Group/Ungroup actions
// (mirroring Cmd+G / Cmd+Shift+G) so both are discoverable right by the canvas,
// not buried in the side panels.
export default function AddElementBar({ theme, onAdd, canGroup = false, canUngroup = false, onGroup, onUngroup }) {
  const fileRef = useRef(null)

  const add = (type, extra = {}) => {
    const el = { ...defaultElement(type, theme), ...extra }
    onAdd(el)
  }

  const btn = 'flex items-center gap-1 rounded-lg bg-[var(--surface-3)] hover:brightness-110 text-[11px] font-semibold px-2 py-1.5'
  const actionBtn = 'flex items-center gap-1 rounded-lg text-[11px] font-semibold px-2 py-1.5 transition disabled:opacity-35 disabled:cursor-not-allowed'
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button className={btn} onClick={() => add('text')} title="Caixa de texto">
        <span className="font-bold">T</span> Texto
      </button>
      <button className={btn} onClick={() => add('shape', { shape: 'roundRect' })} title="Retângulo">
        ▢ Retângulo
      </button>
      <button className={btn} onClick={() => add('shape', { shape: 'ellipse' })} title="Elipse">
        ◯ Elipse
      </button>
      <button className={btn} onClick={() => add('line', { style: { lineColor: theme?.accent, lineWidth: 2, arrowEnd: true } })} title="Linha / seta">
        → Seta
      </button>
      <button className={btn} onClick={() => add('icon')} title="Ícone (troque no painel ao lado)">
        <Icon.Sparkle size={12} /> Ícone
      </button>
      <button className={btn} onClick={() => add('chart')} title="Gráfico (tipo e dados no painel ao lado)">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
        </svg>
        Gráfico
      </button>
      <button className={btn} onClick={() => add('group')} title="Grupo vazio com auto-layout (arraste elementos para dentro pela árvore de camadas)">
        ▣ Grupo
      </button>
      <button className={btn} onClick={() => fileRef.current?.click()} title="Imagem (upload)">
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
