const KIND_STYLE = {
  summary: { emoji: '💡', border: 'border-[var(--border)]' },
  anomaly: { emoji: '⚠️', border: 'border-[var(--accent)]/40' },
  opportunity: { emoji: '📈', border: 'border-[var(--accent)]/40' },
}

export default function InsightCard({ block }) {
  const style = KIND_STYLE[block.kind] || KIND_STYLE.summary
  return (
    <div className={`rounded-2xl border ${style.border} bg-[var(--surface-2)] p-4 my-3`}>
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span>{style.emoji}</span>
        <span>{block.title}</span>
      </div>
      <p className="text-sm text-[var(--muted)] mt-1.5 leading-relaxed">{block.body}</p>
    </div>
  )
}
