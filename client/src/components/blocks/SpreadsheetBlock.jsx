import { useState } from 'react'
import * as Icon from '../Icons.jsx'

// A compact file-chip for a generated `spreadsheet` block — NOT a full preview.
// The chat body just announces the workbook (icon + title + "Planilha · XLSX ·
// N abas") and offers two actions: open the Studio (full-screen preview + AI
// editing) or download the .xlsx directly. The rich grid/charts live in the
// Studio, not inline. Mirrors DeckBlock's compact shape.
export default function SpreadsheetBlock({ block, onOpenSpreadsheet }) {
  const [exporting, setExporting] = useState(false)
  const [err, setErr] = useState('')

  const sheetCount = (block.sheets || []).length
  const canOpen = !!block.spreadsheetId

  const exportXlsx = async () => {
    if (!block.spreadsheetId) return
    setExporting(true)
    setErr('')
    try {
      const res = await fetch(`/api/spreadsheets/${block.spreadsheetId}/export`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(block.title || 'planilha').replace(/[^\w-]+/g, '_').slice(0, 60)}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr(e.message || 'Falha ao exportar')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="my-3">
      <div
        className={`group flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-3 pr-3.5 transition ${
          canOpen ? 'hover:border-[var(--accent)] cursor-pointer' : ''
        }`}
        onClick={() => canOpen && onOpenSpreadsheet?.(block.spreadsheetId)}
      >
        {/* thumbnail: a spreadsheet-file glyph (grid on a page), not a database */}
        <div className="shrink-0 grid place-items-center w-12 h-12 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)]">
          <Icon.SpreadsheetFile size={26} />
        </div>

        {/* title + meta */}
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-sm text-[var(--text)]">{block.title || 'Planilha'}</div>
          <div className="text-xs text-[var(--faint)]">
            Planilha · XLSX{sheetCount ? ` · ${sheetCount} aba${sheetCount !== 1 ? 's' : ''}` : ''}
          </div>
        </div>

        {/* actions */}
        <div className="shrink-0 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => canOpen && onOpenSpreadsheet?.(block.spreadsheetId)}
            disabled={!canOpen}
            className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] hover:brightness-110 disabled:opacity-50 text-white font-semibold text-sm px-3.5 py-2 transition"
            title="Abrir no Estúdio de Planilhas"
          >
            <Icon.Expand size={15} /> Abrir estúdio
          </button>
          <button
            onClick={exportXlsx}
            disabled={!canOpen || exporting}
            className="flex items-center gap-1.5 rounded-xl bg-[var(--surface)] border border-[var(--border)] hover:brightness-110 disabled:opacity-50 text-[var(--text)] font-medium text-sm px-3 py-2 transition"
            title="Baixar .xlsx"
          >
            <Icon.Download size={15} /> {exporting ? '…' : 'Download'}
          </button>
        </div>
      </div>
      {err && <div className="mt-1.5 text-xs text-[var(--danger,#e5484d)]">{err}</div>}
    </div>
  )
}
