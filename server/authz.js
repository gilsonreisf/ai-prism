// App-level authorization: the OWNER comes from env (APP_OWNER_EMAIL in
// app.yaml), further admins from the app_admins table — either user emails
// (guaranteed path, no extra scopes) or workspace group display names,
// resolved through SCIM /Me with the caller's own forwarded token. A SCIM
// failure (e.g. missing IAM scope on the app) degrades gracefully: group
// admins simply don't match, email admins keep working.
import { listAppAdmins } from './db.js'

function host() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

const GROUPS_TTL_MS = 5 * 60 * 1000
const ADMINS_TTL_MS = 30 * 1000
const groupsCache = new Map() // email -> { groups: Set<string>, ts }
let adminsCache = { rows: null, ts: 0 }
let scimOk = true

export function ownerEmail() {
  return (process.env.APP_OWNER_EMAIL || process.env.DATABRICKS_USER_EMAIL || '').trim().toLowerCase()
}

export function isOwner(email) {
  const owner = ownerEmail()
  return !!owner && !!email && email.trim().toLowerCase() === owner
}

export function invalidateAdminsCache() {
  adminsCache = { rows: null, ts: 0 }
}

async function cachedAdmins(email, token) {
  if (adminsCache.rows && Date.now() - adminsCache.ts < ADMINS_TTL_MS) return adminsCache.rows
  const rows = await listAppAdmins(email, token)
  adminsCache = { rows, ts: Date.now() }
  return rows
}

async function userGroups(email, token) {
  const hit = groupsCache.get(email)
  if (hit && Date.now() - hit.ts < GROUPS_TTL_MS) return hit.groups
  const groups = new Set()
  try {
    const res = await fetch(`${host()}/api/2.0/preview/scim/v2/Me?attributes=groups`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      const d = await res.json()
      for (const g of d.groups || []) if (g?.display) groups.add(String(g.display).toLowerCase())
      scimOk = true
    } else {
      scimOk = false
    }
  } catch {
    scimOk = false
  }
  groupsCache.set(email, { groups, ts: Date.now() })
  return groups
}

// what the admin UI shows next to the group form — 'unavailable' means the
// forwarded token can't call SCIM /Me (scope missing) so group membership
// can't be verified in this deployment
export function groupCheckStatus() {
  return scimOk ? 'ok' : 'unavailable'
}

// Users/groups that already have CAN_USE/CAN_MANAGE on this app (Databricks
// Apps permissions API) — the natural universe of admin candidates, surfaced
// as autocomplete in the admin panel. Read with the caller's own token (the
// panel is admin-only; a caller without permission-read access just gets no
// suggestions — the free-text form keeps working).
const CANDIDATES_TTL_MS = 5 * 60 * 1000
let candidatesCache = { list: null, ts: 0 }

export async function appAccessCandidates(token) {
  if (candidatesCache.list && Date.now() - candidatesCache.ts < CANDIDATES_TTL_MS) return candidatesCache.list
  const appName = process.env.DATABRICKS_APP_NAME
  if (!appName || !token) return []
  try {
    const res = await fetch(`${host()}/api/2.0/permissions/apps/${encodeURIComponent(appName)}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) return []
    const d = await res.json()
    const rank = { CAN_MANAGE: 2, CAN_USE: 1 }
    const list = []
    for (const acl of d.access_control_list || []) {
      const levels = (acl.all_permissions || []).map((p) => p.permission_level)
      const best = levels.sort((a, b) => (rank[b] || 0) - (rank[a] || 0))[0]
      if (!rank[best]) continue
      if (acl.user_name) list.push({ kind: 'user', principal: acl.user_name, display: acl.display_name || '', level: best })
      else if (acl.group_name) list.push({ kind: 'group', principal: acl.group_name, display: '', level: best })
      // service principals can't sign in to the UI — not admin material
    }
    candidatesCache = { list, ts: Date.now() }
    return list
  } catch {
    return []
  }
}

export async function isAdmin(email, token) {
  if (isOwner(email)) return true
  try {
    const admins = await cachedAdmins(email, token)
    const lower = (email || '').trim().toLowerCase()
    if (admins.some((a) => a.kind === 'user' && a.principal.trim().toLowerCase() === lower)) return true
    const groupAdmins = admins.filter((a) => a.kind === 'group')
    if (groupAdmins.length) {
      const groups = await userGroups(email, token)
      if (groupAdmins.some((a) => groups.has(a.principal.trim().toLowerCase()))) return true
    }
  } catch (e) {
    console.warn('authz: falha ao checar admins (assumindo não-admin):', e.message)
  }
  return false
}
