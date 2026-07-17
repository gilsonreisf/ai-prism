import { useState } from 'react'

const CAP = 12

export default function TableBlock({ block }) {
  const { title, columns, rows } = block
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? rows : rows.slice(0, CAP)
  const hidden = rows.length - visible.length

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4 my-3 overflow-x-auto">
      {title && <div className="text-sm font-semibold mb-2">{title}</div>}
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-[var(--border)]">
            {columns.map((c, i) => (
              <th key={i} className="text-left font-semibold px-2 py-1.5 text-[var(--muted)]">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, ri) => (
            <tr key={ri} className="border-b border-[var(--border-soft)]">
              {row.map((cell, ci) => (
                <td key={ci} className="px-2 py-1.5">
                  {cell ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-2 text-xs text-[var(--accent)] hover:underline"
        >
          + {hidden} linhas
        </button>
      )}
    </div>
  )
}
