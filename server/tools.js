// Tool calling, Databricks-native: tools are either Unity Catalog Functions or
// Genie Spaces, both invoked with the signed-in user's own OAuth token — same
// on-behalf-of pattern already used for Lakebase and the AI Gateway. This
// means tool execution is governed by the user's real permissions (no bespoke
// sandbox to build or trust), and "add a new tool" simply means "let the user
// attach something they can already access".
//
// The one built-in tool (Python) is a UC Python function this module
// provisions lazily (CREATE OR REPLACE, idempotent) in a configurable
// catalog/schema. UC Python functions run in Databricks' own governed,
// network/filesystem-isolated serverless sandbox, so no extra sandboxing is
// layered on top here — that isolation is the platform's job, not this app's.
import { execStatement, warehouseId } from './warehouse.js'
import { askGenie, askGenieOne } from './genie.js'
import { getGenieConversationId, setGenieConversationId } from './db.js'
import { chartCandidatesFromRows } from './analysis.js'
import { listMcpTools, callMcpTool } from './mcpClient.js'
import { externalMcpUrl } from './externalMcp.js'
import { describeVectorIndexColumns, queryVectorIndex } from './vectorSearch.js'

function host() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

// Fixed pseudo space id so Genie One's own conversation continuity reuses
// the existing per-session Genie conversation table (space_id is a free-form
// key) without a schema change — Genie One has no real spaceId of its own.
const GENIE_ONE_SPACE_ID = '__genie_one__'
export const GENIE_ONE_TOOL_FN_NAME = 'ask_genie_one'

function catalog() {
  return process.env.TOOLS_CATALOG || 'main'
}
function schema() {
  return process.env.TOOLS_SCHEMA || 'default'
}
function pythonFqName() {
  return `${catalog()}.${schema()}.ai_prism_python_exec`
}

export const PYTHON_TOOL_FN_NAME = 'execute_python'

let builtinReady = false
export async function ensureBuiltinPythonTool(token) {
  if (builtinReady) return
  const body = `
import io, contextlib, math, statistics, decimal, fractions, cmath, random, itertools, functools, re, json as _json, datetime
ns = {
    "math": math, "statistics": statistics, "decimal": decimal, "fractions": fractions,
    "cmath": cmath, "random": random, "itertools": itertools, "functools": functools,
    "re": re, "json": _json, "datetime": datetime,
}
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        exec(code, ns)
except Exception as e:
    return "ERROR: " + repr(e)
# Cap is a runaway backstop only (a stray dump of a whole table shouldn't blow
# up the turn), set generously so it never truncates a legitimate result — not
# a quality limit. Speed comes from prompt caching, not from shrinking outputs.
_LIMIT = 200000
if "result" in ns:
    return str(ns["result"])[:_LIMIT]
out = buf.getvalue().strip()
return out[:_LIMIT] if out else "(execução concluída sem saída — defina uma variável \`result\` ou use print())"
`.trim()

  await execStatement(
    token,
    `CREATE OR REPLACE FUNCTION ${pythonFqName()}(code STRING COMMENT 'Código-fonte Python a executar. Defina uma variável "result" com a resposta final, ou use print().')
     RETURNS STRING
     LANGUAGE PYTHON
     COMMENT 'Executa código Python (math, statistics, decimal, fractions, cmath, random, itertools, functools, re, json, datetime disponíveis) e retorna a variável result como texto, ou a saída de print(). Use para cálculos que exigem precisão exata.'
     AS $$${body}$$`
  )
  builtinReady = true
}

function pythonToolDef() {
  return {
    type: 'function',
    function: {
      name: PYTHON_TOOL_FN_NAME,
      description:
        'Executa código Python para cálculos que exigem precisão exata (aritmética, álgebra, ' +
        'estatística, datas). Sempre prefira esta tool a calcular de cabeça quando o resultado ' +
        'numérico importa. Defina uma variável "result" com a resposta final, ou use print(). ' +
        'A PRIMEIRA linha do código DEVE ser um comentário curto (#) que descreve o passo, escrito ' +
        'no MESMO IDIOMA do usuário — ele vira o rótulo visível deste passo na interface.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'Código Python a executar. Comece com um comentário curto (#) no idioma do usuário ' +
              'descrevendo o passo (ex.: "# Receita mensal — apenas meses completos"), pois ele é ' +
              'usado como rótulo do passo na UI.',
          },
        },
        required: ['code'],
      },
    },
  }
}

// --- Unity Catalog Function discovery (for user-selectable "extra" tools) ---

// UC parameter types we know how to bind as SQL statement parameters and
// describe as JSON Schema. Complex types (ARRAY/MAP/STRUCT) are excluded from
// the picker — the Statement Execution API's parameter binding doesn't cover
// them well, and it keeps the tool-call argument shape simple for the model.
function sqlTypeToJsonSchema(fullType) {
  const t = (fullType || '').toLowerCase().trim()
  if (/^(string|varchar|char)/.test(t)) return { type: 'string' }
  if (/^(tinyint|smallint|int|integer|bigint|long|byte)/.test(t)) return { type: 'integer' }
  if (/^(float|double|decimal|numeric|real)/.test(t)) return { type: 'number' }
  if (/^boolean/.test(t)) return { type: 'boolean' }
  if (/^(date|timestamp|interval)/.test(t)) return { type: 'string', description: `formato ${t}` }
  return null // unsupported (array/map/struct/binary/void)
}

function sanitizeToolName(rawName) {
  const raw = rawName.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (raw.length <= 64) return raw
  // Deterministic short suffix keeps names unique without needing a lookup by hash.
  let hash = 0
  for (const ch of raw) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return raw.slice(0, 55) + '_' + hash.toString(36).slice(0, 8)
}

/** Search Unity Catalog Functions the user can see, by name substring. */
export async function searchUcFunctions(token, query, limit = 20) {
  const q = (query || '').trim()
  const { rows: routineRows } = await execStatement(
    token,
    `SELECT specific_catalog, specific_schema, specific_name, comment
     FROM system.information_schema.routines
     WHERE routine_type = 'FUNCTION'
       AND specific_catalog NOT IN ('system')
       AND specific_name ILIKE :pattern
     ORDER BY specific_catalog, specific_schema, specific_name
     LIMIT :limit`,
    [
      { name: 'pattern', type: 'STRING', value: `%${q}%` },
      { name: 'limit', type: 'INT', value: String(limit) },
    ]
  )
  if (!routineRows.length) return []

  const results = await Promise.all(
    routineRows.map(async ([cat, sch, name, comment]) => {
      const { rows: paramRows } = await execStatement(
        token,
        `SELECT parameter_name, full_data_type, comment
         FROM system.information_schema.parameters
         WHERE specific_catalog = :cat AND specific_schema = :sch AND specific_name = :name
           AND parameter_mode = 'IN'
         ORDER BY ordinal_position`,
        [
          { name: 'cat', type: 'STRING', value: cat },
          { name: 'sch', type: 'STRING', value: sch },
          { name: 'name', type: 'STRING', value: name },
        ]
      )
      const params = paramRows.map(([pname, ptype, pcomment]) => ({
        name: pname,
        type: ptype,
        comment: pcomment || '',
        jsonSchema: sqlTypeToJsonSchema(ptype),
      }))
      return {
        kind: 'uc',
        catalog: cat,
        schema: sch,
        name,
        fullName: `${cat}.${sch}.${name}`,
        comment: comment || '',
        params,
        supported: params.every((p) => p.jsonSchema),
      }
    })
  )
  return results.filter((r) => r.supported)
}

function coerceArg(value, sqlType) {
  const t = (sqlType || '').toLowerCase()
  if (/^boolean/.test(t)) return String(value) === 'true' || value === true ? 'true' : 'false'
  return String(value)
}

function genieToolName(spaceId) {
  return `genie__${spaceId}`.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function genieOneToolDef() {
  return {
    type: 'function',
    function: {
      name: GENIE_ONE_TOOL_FN_NAME,
      description:
        'Faz uma pergunta em linguagem natural para o Genie One, que enxerga todos os assets do ' +
        'workspace (Genie Spaces e Unity Catalog) aos quais o usuário tem acesso — prefira esta tool ' +
        'a uma Genie Space específica quando a pergunta puder cruzar dados de mais de uma fonte, ou ' +
        'quando nenhuma sala específica cobrir o assunto.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Pergunta em linguagem natural.' },
        },
        required: ['question'],
      },
    },
  }
}

// External MCP servers expose an arbitrary, only-known-at-runtime tool list —
// discovering it on every chat turn would add a network round trip per
// enabled connection, so the list is cached briefly per (user, connection),
// same pattern as the Genie Spaces search cache in genie.js.
const MCP_TOOLS_CACHE_TTL_MS = 10 * 60 * 1000
const mcpToolsCache = new Map() // `${email}:${url}` -> { ts, tools }
async function listMcpToolsCached(url, token, email) {
  const key = `${email}:${url}`
  const cached = mcpToolsCache.get(key)
  if (cached && Date.now() - cached.ts < MCP_TOOLS_CACHE_TTL_MS) return cached.tools
  const tools = await listMcpTools(url, token)
  mcpToolsCache.set(key, { ts: Date.now(), tools })
  return tools
}


/**
 * Builds the OpenAI-style tool defs + a resolver map for a set of enabled
 * tool refs (kind: 'uc' | 'genie' | 'genie-one' | 'vector-search' |
 * 'mcp-external'). Async because external MCP servers need a live
 * tools/list call to know what they expose — everything else is built from
 * data the ref already carries (resolved at search time) or is hardcoded.
 */
export async function buildToolDefs(enabledRefs, token, email, { includePython = true } = {}) {
  const tools = []
  const resolvers = new Map()
  if (includePython) {
    tools.push(pythonToolDef())
    resolvers.set(PYTHON_TOOL_FN_NAME, { kind: 'python' })
  }

  for (const ref of enabledRefs || []) {
    if (ref?.kind === 'genie' && ref.spaceId) {
      const toolName = genieToolName(ref.spaceId)
      tools.push({
        type: 'function',
        function: {
          name: toolName,
          description: (
            `Faz uma pergunta em linguagem natural para a sala Genie "${ref.title}". Genie conhece ` +
            `estes dados: ${ref.description || 'sem descrição disponível'}. Genie traduz a pergunta em ` +
            `SQL, executa e responde em linguagem natural — use para perguntas sobre esses dados em vez ` +
            `de tentar adivinhar.`
          ).slice(0, 1000),
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'Pergunta em linguagem natural para o Genie, sobre os dados dessa sala.',
              },
            },
            required: ['question'],
          },
        },
      })
      resolvers.set(toolName, { kind: 'genie', ref })
      continue
    }

    if (ref?.kind === 'genie-one') {
      tools.push(genieOneToolDef())
      resolvers.set(GENIE_ONE_TOOL_FN_NAME, { kind: 'genie-one' })
      continue
    }

    if (ref?.kind === 'vector-search' && ref.indexName) {
      const toolName = sanitizeToolName(`vs__${ref.indexName}`)
      tools.push({
        type: 'function',
        function: {
          name: toolName,
          description: (
            `Busca semântica no índice de Vector Search "${ref.indexName}" (tabela de origem: ` +
            `${ref.sourceTable || 'desconhecida'}). Use para encontrar trechos/documentos relevantes ` +
            `por similaridade de significado, não para agregações exatas.`
          ).slice(0, 1000),
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Texto da busca semântica.' },
              num_results: { type: 'integer', description: 'Número de resultados (padrão 5, máx. 20).' },
            },
            required: ['query'],
          },
        },
      })
      resolvers.set(toolName, { kind: 'vector-search', ref })
      continue
    }

    if (ref?.kind === 'mcp-external' && ref.connectionName) {
      const url = externalMcpUrl(ref.connectionName)
      let mcpTools = []
      try {
        mcpTools = await listMcpToolsCached(url, token, email)
      } catch (e) {
        // Some connections need one-time per-user OAuth consent (confirmed
        // live: tools/list itself fails with UNAUTHENTICATED + a login URL
        // until the user visits it) — rather than silently drop the
        // connection, register one status tool so the model can surface the
        // actual reason (and login link) to the user instead of the
        // connection just vanishing with no explanation.
        const toolName = sanitizeToolName(`mcpext__${ref.connectionName}__status`)
        tools.push({
          type: 'function',
          function: {
            name: toolName,
            description: `Verifica por que a conexão MCP externa "${ref.connectionName}" está indisponível.`,
            parameters: { type: 'object', properties: {} },
          },
        })
        resolvers.set(toolName, { kind: 'mcp-external-error', connectionName: ref.connectionName, error: e.message })
        continue
      }
      for (const mt of mcpTools) {
        const toolName = sanitizeToolName(`mcpext__${ref.connectionName}__${mt.name}`)
        tools.push({
          type: 'function',
          function: {
            name: toolName,
            description: (mt.description || `Tool ${mt.name} do MCP externo ${ref.connectionName}`).slice(0, 1000),
            parameters: mt.inputSchema || { type: 'object', properties: {} },
          },
        })
        resolvers.set(toolName, { kind: 'mcp-external', ref, mcpToolName: mt.name, url })
      }
      continue
    }

    if (!ref?.catalog || !ref?.schema || !ref?.name || !Array.isArray(ref.params)) continue
    const toolName = sanitizeToolName(`uc__${ref.catalog}__${ref.schema}__${ref.name}`)
    const properties = {}
    const required = []
    for (const p of ref.params) {
      if (!p.jsonSchema) continue
      properties[p.name] = { ...p.jsonSchema, description: p.comment || undefined }
      required.push(p.name)
    }
    tools.push({
      type: 'function',
      function: {
        name: toolName,
        description: ref.comment || `Unity Catalog function ${ref.fullName}`,
        parameters: { type: 'object', properties, required },
      },
    })
    resolvers.set(toolName, { kind: 'uc', ref })
  }
  return { tools, resolvers }
}

/**
 * Executes a resolved tool call and returns `{ resultText, chartCandidates }`
 * — resultText is the tool message content (and what's shown in the tool
 * chip), chartCandidates is [] except for Genie, where a query result is
 * turned into the same deterministic chart-candidate shape spreadsheet
 * uploads produce, so the model can actually reference it in a prism-block.
 * `ctx.sessionId`/`ctx.email` let the Genie resolver continue the same
 * Genie conversation across turns in this chat session.
 */
export async function invokeTool(token, resolver, args, ctx = {}) {
  if (resolver.kind === 'python') {
    const { rows } = await execStatement(token, `SELECT ${pythonFqName()}(:code)`, [
      { name: 'code', type: 'STRING', value: args.code || '' },
    ])
    return { resultText: rows[0]?.[0] ?? '', chartCandidates: [] }
  }

  if (resolver.kind === 'genie') {
    const { spaceId, title } = resolver.ref
    const { sessionId, email, onProgress } = ctx
    const existingConvId = sessionId ? await getGenieConversationId(email, token, sessionId, spaceId) : null
    const { conversationId, resultText, queryRows } = await askGenie(
      token,
      spaceId,
      args.question || '',
      existingConvId,
      onProgress
    )
    if (sessionId && conversationId !== existingConvId) {
      await setGenieConversationId(email, token, sessionId, spaceId, conversationId)
    }
    const chartCandidates = queryRows.length >= 2 ? chartCandidatesFromRows(title, queryRows) : []
    return { resultText, chartCandidates }
  }

  if (resolver.kind === 'genie-one') {
    const { sessionId, email, onProgress } = ctx
    const existingConvId = sessionId
      ? await getGenieConversationId(email, token, sessionId, GENIE_ONE_SPACE_ID)
      : null
    const { conversationId, resultText, queryRows } = await askGenieOne(
      token,
      args.question || '',
      existingConvId,
      onProgress
    )
    if (sessionId && conversationId !== existingConvId) {
      await setGenieConversationId(email, token, sessionId, GENIE_ONE_SPACE_ID, conversationId)
    }
    // Genie One returns tabular results as a markdown table inside resultText;
    // askGenieOne recovers it as rows so we can build the same deterministic
    // chart candidates a per-space Genie query or a spreadsheet upload would.
    const chartCandidates = queryRows?.length >= 2 ? chartCandidatesFromRows('Genie One', queryRows) : []
    return { resultText, chartCandidates }
  }

  if (resolver.kind === 'vector-search') {
    const { ref } = resolver
    const columns = await describeVectorIndexColumns(token, ref)
    const numResults = Number(args.num_results) > 0 ? Math.min(Number(args.num_results), 20) : 5
    const resultText = await queryVectorIndex(token, ref.indexName, columns, args.query || '', numResults)
    return { resultText, chartCandidates: [] }
  }

  if (resolver.kind === 'mcp-external') {
    const { text } = await callMcpTool(resolver.url, token, resolver.mcpToolName, args)
    return { resultText: text, chartCandidates: [] }
  }

  if (resolver.kind === 'mcp-external-error') {
    return { resultText: `ERROR: ${resolver.error}`, chartCandidates: [] }
  }

  const { ref } = resolver
  const paramNames = ref.params.map((_, i) => `p${i}`)
  const stmt = `SELECT \`${ref.catalog}\`.\`${ref.schema}\`.\`${ref.name}\`(${paramNames.map((n) => `:${n}`).join(', ')})`
  const parameters = ref.params.map((p, i) => ({
    name: paramNames[i],
    type: p.type,
    value: coerceArg(args[p.name], p.type),
  }))
  const { rows } = await execStatement(token, stmt, parameters, { warehouseId: warehouseId() })
  const val = rows[0]?.[0]
  return { resultText: val == null ? '(sem retorno)' : String(val), chartCandidates: [] }
}
