function Bar({ w }) {
  return (
    <div
      className="h-3 rounded-full bg-gradient-to-r from-[var(--surface-2)] via-[var(--surface-3)] to-[var(--surface-2)] bg-[length:200%_100%] animate-shimmer"
      style={{ width: w }}
    />
  )
}

function Bubble({ w }) {
  return (
    <div
      className="h-9 rounded-2xl rounded-tr-md bg-gradient-to-r from-[var(--surface-2)] via-[var(--surface-3)] to-[var(--surface-2)] bg-[length:200%_100%] animate-shimmer"
      style={{ width: w }}
    />
  )
}

// Shown while a session's history is being fetched — mimics the chat layout
// so switching conversations reads as "loading" instead of looking frozen.
export default function SessionSkeleton() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6 animate-fade-in">
      <div className="flex justify-end">
        <Bubble w="42%" />
      </div>
      <div className="flex gap-3">
        <div className="shrink-0 mt-0.5 w-8 h-8 rounded-lg bg-[var(--surface-2)]" />
        <div className="flex-1 space-y-2.5 pt-1">
          <Bar w="92%" />
          <Bar w="78%" />
          <Bar w="60%" />
        </div>
      </div>
      <div className="flex justify-end">
        <Bubble w="30%" />
      </div>
      <div className="flex gap-3">
        <div className="shrink-0 mt-0.5 w-8 h-8 rounded-lg bg-[var(--surface-2)]" />
        <div className="flex-1 space-y-2.5 pt-1">
          <Bar w="85%" />
          <Bar w="45%" />
        </div>
      </div>
    </div>
  )
}
