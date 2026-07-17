// Shown inline, right where the model is currently emitting a ```prism-block
// fence, so the user sees *where* a chart/insight is coming together instead
// of the reply appearing to stall once visible text stops growing.
export default function LoadingChip() {
  return (
    <div className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 my-2 text-xs text-[var(--muted)]">
      <span className="w-3 h-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
      Preparando visualização…
    </div>
  )
}
