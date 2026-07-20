// Generic client for Databricks-hosted MCP (Model Context Protocol) endpoints —
// used both for the workspace-wide Genie One managed MCP and for external MCP
// servers proxied through a Unity Catalog HTTP connection. Both are reached
// the same way: Streamable HTTP, on-behalf-of the signed-in user's own OAuth
// token as the bearer credential. Connections are short-lived (open, do one
// thing, close) since these proxies are effectively stateless per request —
// there's no benefit to pooling a persistent session across chat turns.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

async function withMcpClient(url, token, fn) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'ai-prism', version: '1.0.0' })
  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    await client.close().catch(() => {})
  }
}

// tools/list runs on the hot path of building a chat turn (see buildToolDefs),
// BEFORE the model streams its first token. A slow/hung external MCP server
// would otherwise block every turn's TTFT for as long as it takes to connect.
// Bound it: on timeout we reject, and buildToolDefs degrades that connection to
// a one-off "status" tool (surfacing the reason to the user) instead of hanging.
const LIST_TOOLS_TIMEOUT_MS = 4000

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} excedeu ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Lists the tools an MCP server exposes: [{name, description, inputSchema}]. */
export async function listMcpTools(url, token) {
  const { tools } = await withTimeout(
    withMcpClient(url, token, (client) => client.listTools()),
    LIST_TOOLS_TIMEOUT_MS,
    'listagem de tools MCP'
  )
  return tools || []
}

/**
 * Calls one MCP tool and returns `{ text, structuredContent }`: `text` joins
 * any text content blocks (the human/LLM-facing rendering — for Genie's
 * tools this is markdown that already includes its own instructions on how
 * to present the answer, so callers should generally pass it through as-is
 * rather than re-summarizing it), `structuredContent` is the typed JSON
 * result when the server provides one (used for control flow, e.g. reading
 * `status` while polling, without having to re-parse the text). MCP-level
 * errors (isError, JSON-RPC errors) are returned as text too (often with an
 * actionable message, e.g. a connection-login link) rather than thrown, so
 * the model/user can see and act on them.
 */
export async function callMcpTool(url, token, toolName, args) {
  try {
    const result = await withMcpClient(url, token, (client) =>
      client.callTool({ name: toolName, arguments: args || {} })
    )
    const text = (result.content || [])
      .map((c) => (c.type === 'text' ? c.text : c.type === 'resource' ? JSON.stringify(c.resource) : ''))
      .filter(Boolean)
      .join('\n\n')
    return {
      text: text || (result.isError ? 'ERROR: a tool MCP não retornou detalhes do erro.' : '(sem conteúdo retornado)'),
      structuredContent: result.structuredContent || null,
    }
  } catch (e) {
    return { text: `ERROR: ${e.message}`, structuredContent: null }
  }
}
