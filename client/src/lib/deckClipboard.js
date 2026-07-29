// Deck-level element clipboard. Module state (not React state) so it survives
// slide switches — Cmd+C on slide 2 then Cmd+V on slide 5 pastes there. Holds
// deep-cloned node snapshots; paste re-clones with fresh ids so repeated pastes
// never collide. Independent from the OS clipboard on purpose (we copy the
// element TREE with its styles/children, not text).
let buffer = []

export function setClipboard(nodes) {
  // structuredClone keeps the copy immune to later edits of the source tree
  buffer = (nodes || []).map((n) => structuredClone(n))
}

export function getClipboard() {
  return buffer.map((n) => structuredClone(n))
}

export function clipboardHasContent() {
  return buffer.length > 0
}
