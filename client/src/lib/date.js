// Shared date helpers for the sidebar's chronological grouping and the
// History page's compact relative timestamps — kept in one place so both
// views agree on what "hoje"/"2d atrás" mean.
export function timeGroup(d) {
  const date = new Date(d)
  const now = new Date()
  const diff = (now - date) / 86400000
  if (diff < 1 && now.getDate() === date.getDate()) return 'Hoje'
  if (diff < 2) return 'Ontem'
  if (diff < 7) return 'Últimos 7 dias'
  if (diff < 30) return 'Últimos 30 dias'
  return 'Mais antigos'
}

export function relativeTime(d) {
  const diffMs = Date.now() - new Date(d).getTime()
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `${min}m atrás`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h atrás`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d atrás`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mês atrás`
  return `${Math.floor(months / 12)}a atrás`
}
