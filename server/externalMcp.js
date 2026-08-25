// External MCP servers, the governed way: rather than let a user paste an
// arbitrary URL + secret into this app, external MCP servers are Unity
// Catalog HTTP connections an admin already registered for the workspace
// (`CREATE CONNECTION ... TYPE HTTP` with `is_mcp_connection = true` —
// confirmed live against a real connection, e.g. a Slack MCP). Discovery
// just lists those connections; Databricks' own managed proxy at
// /api/2.0/mcp/external/<connection-name> handles auth to the actual
// third-party server (including, for OAuth-mapped connections, per-user
// consent — surfaced to the caller as a normal MCP error with a login link
// if the user hasn't gone through that yet).
import { listMcpTools } from './mcpClient.js'
// Conectores gerenciados do Google (Gmail/Drive) chegam pelo MESMO proxy, mas são
// passthrough REST (não MCP). Discovery os inclui; a lógica de tools/probe deles
// mora em googleConnector.js. Ver docs/ e external_mcp_google/proposals.
import { isManagedGoogleProvider, googleProviderLabel, probeGoogleConnector } from './googleConnector.js'

function host() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

export function externalMcpUrl(connectionName) {
  return `${host()}/api/2.0/mcp/external/${encodeURIComponent(connectionName)}`
}

// Probes a connection's auth state on-behalf-of the user by trying to list its
// tools. Returns 'connected' (tools listed → the user's token is authorized),
// 'needs_login' (the managed proxy reports missing per-user OAuth consent, with
// a login link), or 'unavailable' (any other failure). The error message
// carries the login URL when present so the UI can offer a "Conectar" button.
export async function probeMcpConnection(token, connectionName) {
  // Conector gerenciado do Google? Ele não fala MCP (tools/list daria 404 do
  // Google); prova de auth é uma leitura REST leve via passthrough.
  const opts = await getConnectionOptions(token, connectionName)
  if (opts.is_mcp_connection !== 'true' && isManagedGoogleProvider(opts.oauth_provider)) {
    return probeGoogleConnector(token, connectionName, opts.oauth_provider)
  }
  try {
    await listMcpTools(externalMcpUrl(connectionName), token)
    return { status: 'connected' }
  } catch (e) {
    const msg = String(e?.message || '')
    // the Databricks proxy surfaces missing consent as an auth error, usually
    // carrying an authorize/login URL the user must visit once
    const loginUrl = (msg.match(/https?:\/\/\S+/) || [])[0] || ''
    if (/unauth|unauthenticated|401|403|consent|login|authorize/i.test(msg)) {
      return { status: 'needs_login', loginUrl, error: msg }
    }
    return { status: 'unavailable', error: msg }
  }
}

async function apiFetch(path, opts, token) {
  const res = await fetch(`${host()}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts?.headers || {}),
    },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = json?.message || json?.error || `HTTP ${res.status}`
    throw new Error(`Unity Catalog API: ${msg}`)
  }
  return json
}

// Lê as `options` de UMA conexão (para decidir MCP-clássico vs conector Google no
// probe). Best-effort: falha vira {} e o probe cai no caminho MCP padrão.
async function getConnectionOptions(token, connectionName) {
  try {
    const json = await apiFetch(
      `/api/2.1/unity-catalog/connections/${encodeURIComponent(connectionName)}`,
      { method: 'GET' },
      token
    )
    return json.options || {}
  } catch {
    return {}
  }
}

const CONNECTIONS_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_PAGES = 20
const connectionsCache = new Map() // userEmail -> { ts, connections }

async function listAllMcpConnections(token) {
  const connections = []
  let pageToken = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ max_results: '100', ...(pageToken ? { page_token: pageToken } : {}) })
    const json = await apiFetch(`/api/2.1/unity-catalog/connections?${qs}`, { method: 'GET' }, token)
    for (const c of json.connections || []) {
      if (c.connection_type !== 'HTTP') continue
      const o = c.options || {}
      if (o.is_mcp_connection === 'true') {
        // MCP externo "clássico" (fala MCP no proxy)
        connections.push({ kind: 'mcp-external', connectionName: c.name, comment: c.comment || '', provider: null })
      } else if (isManagedGoogleProvider(o.oauth_provider)) {
        // Conector gerenciado do Google: mesmo kind p/ o cliente (adoção/enable
        // idênticos); `provider` marca que a execução é via passthrough REST.
        connections.push({
          kind: 'mcp-external',
          connectionName: c.name,
          comment: c.comment || googleProviderLabel(o.oauth_provider),
          provider: o.oauth_provider,
        })
      }
    }
    pageToken = json.next_page_token
    if (!pageToken) break
  }
  return connections
}

/** Search Unity Catalog connections registered as external MCP servers, by name/comment substring. */
export async function searchExternalMcpConnections(token, userEmail, query, limit = 20) {
  let cached = connectionsCache.get(userEmail)
  if (!cached || Date.now() - cached.ts > CONNECTIONS_CACHE_TTL_MS) {
    cached = { ts: Date.now(), connections: await listAllMcpConnections(token) }
    connectionsCache.set(userEmail, cached)
  }
  const q = (query || '').trim().toLowerCase()
  const matches = q
    ? cached.connections.filter(
        (c) => c.connectionName.toLowerCase().includes(q) || c.comment.toLowerCase().includes(q)
      )
    : cached.connections
  return matches.slice(0, limit)
}

/**
 * Se `connectionName` é um conector gerenciado do Google (Gmail/Drive/…), devolve
 * seu `oauth_provider`; senão null. Usa o mesmo cache do discovery (por usuário),
 * então é barato no hot path de montar as tools do turno.
 */
export async function getManagedGoogleProvider(token, userEmail, connectionName) {
  let cached = connectionsCache.get(userEmail)
  if (!cached || Date.now() - cached.ts > CONNECTIONS_CACHE_TTL_MS) {
    cached = { ts: Date.now(), connections: await listAllMcpConnections(token) }
    connectionsCache.set(userEmail, cached)
  }
  const hit = cached.connections.find((c) => c.connectionName === connectionName)
  return hit?.provider || null
}
