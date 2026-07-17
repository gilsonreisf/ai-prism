import express from 'express'
import multer from 'multer'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

import {
  ensureSchema,
  ensureSpGrants,
  createSession,
  listSessions,
  getSession,
  updateSession,
  deleteSession,
  addMessage,
  listMessages,
  listMessagesBeforeMessage,
  getMessageRaw,
  activateVariant,
  addToolCalls,
  setSessionEmbedding,
  listSessionsForSearch,
  getSessionChartCandidates,
  saveSessionChartCandidates,
  listDeckTemplates,
  getSelectedDeckTemplate,
  getDeckTemplate,
  templateSummary,
  createDeckTemplate,
  updateDeckTemplate,
  selectDeckTemplate,
  deleteDeckTemplate,
  setDeckTemplateScope,
  listAppAdmins,
  addAppAdmin,
  removeAppAdmin,
  createDeck,
  getDeck,
  updateDeckSlides,
  createSpreadsheet,
  getSpreadsheet,
  updateSpreadsheet,
} from './db.js'
import { isAdmin, isOwner, ownerEmail, groupCheckStatus, invalidateAdminsCache, appAccessCandidates } from './authz.js'
import { MODELS, modelById, streamChat, complete, generateTitle, embed, cosineSim, labelDesignAssets } from './llm.js'
import { extractText, SUPPORTED_EXTENSIONS } from './files.js'
import { analyzeSpreadsheet, isSpreadsheet } from './analysis.js'
import {
  buildBlocksInstruction,
  extractPrismBlocks,
  stripBlockPlaceholders,
  buildNewCandidatesHint,
  sanitizeDeck,
  sanitizeSpreadsheet,
  usableIconAssets,
} from './blocks.js'
import { ensureBuiltinPythonTool, searchUcFunctions, buildToolDefs, invokeTool } from './tools.js'
import { searchGenieSpaces } from './genie.js'
import { searchVectorIndexes } from './vectorSearch.js'
import { searchExternalMcpConnections } from './externalMcp.js'
import { renderPptx } from './decks.js'
import { renderXlsx } from './xlsx-export.js'

// Resolve the app root for serving the built frontend. In the bundled CJS
// build, Node's native __dirname is the bundle's folder (server-dist/); in ESM
// dev we derive it from import.meta.url. `typeof __dirname` is safe in both.
function baseDir() {
  if (typeof __dirname !== 'undefined') return __dirname
  return path.dirname(fileURLToPath(import.meta.url))
}
const DIST = path.join(baseDir(), '..', 'client', 'dist')
const PORT = parseInt(process.env.PORT || '8000', 10)
const ATTACH_MARKER = '\n\n--- ANEXOS ---\n\n'

function stripAttach(content) {
  const i = content.indexOf('\n\n--- ANEXOS ---')
  return i >= 0 ? content.slice(0, i) : content
}

// multer/busboy exposes the multipart filename as a latin1-decoded string, so
// UTF-8 names get mangled (e.g. "ção" -> "cÌ§aÌ o"). Re-decode as UTF-8 and
// compose to NFC (macOS sends decomposed accents).
function fixFilename(name) {
  try {
    return Buffer.from(name, 'latin1').toString('utf8').normalize('NFC')
  } catch {
    return name
  }
}

const app = express()
// 40mb to fit a full design-system BUNDLE import (fonts + specimen cards +
// downscaled backgrounds — see dsImport.js caps); plain mined templates stay
// well under the old 15mb in practice
app.use(express.json({ limit: '40mb' }))
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
})

// ---- auth (on-behalf-of the signed-in Databricks user) ----
function userEmail(req) {
  return (
    req.headers['x-forwarded-email'] ||
    process.env.DATABRICKS_USER_EMAIL ||
    'local-dev@databricks.com'
  )
}
function userToken(req) {
  return req.headers['x-forwarded-access-token'] || process.env.DATABRICKS_USER_TOKEN || null
}

function auth(req, res, next) {
  const token = userToken(req)
  if (!token) {
    return res.status(401).json({ error: 'Token de usuário não encontrado (OAuth do app).' })
  }
  req.email = userEmail(req)
  req.token = token
  next()
}

// schema is created once, lazily, with the first user's token
let schemaReady = false
async function ensureReady(req) {
  if (!schemaReady) {
    await ensureSchema(req.email, req.token)
    schemaReady = true
  }
  // separate latch: the SP role can appear long after the schema did, and
  // only the table owner's identity can apply its grants — so this must keep
  // trying past the schemaReady latch (no-op once granted)
  await ensureSpGrants(req.email, req.token)
}

// Built-in Python tool provisioning failing (no SQL_WAREHOUSE_ID, no CREATE
// FUNCTION grant, token without the `sql` scope, warehouse down…) must only
// cost us the Python tool — never the user's Genie/UC/Vector/MCP tools. The
// failure is remembered with a cooldown instead of a permanent latch, because
// it can be per-token (scope) or transient rather than a property of the
// environment.
const TOOLS_RETRY_MS = 5 * 60 * 1000
let toolsState = { ready: false, error: null, lastAttempt: 0 }
async function ensureTools(req) {
  if (toolsState.ready) return toolsState
  if (Date.now() - toolsState.lastAttempt < TOOLS_RETRY_MS) return toolsState
  toolsState.lastAttempt = Date.now()
  try {
    await ensureBuiltinPythonTool(req.token)
    toolsState.ready = true
    toolsState.error = null
  } catch (e) {
    toolsState.error = e.message
    console.warn('python tool setup failed, continuing without it:', e.message)
  }
  return toolsState
}

// Injected as a system message whenever a turn has tools available. Two goals:
// (1) the user should never see a silent gap where the assistant "froze" while
// deciding on / running a tool — so the model narrates a short line BEFORE each
// tool call, which the server already streams as it arrives (result.content in
// runAssistantTurn); (2) that narration doubles as an explanation of the
// reasoning ("vou consultar o Genie para trazer os números reais…"), so the
// tool-call chips read as a coherent train of thought, not a black box.
const TOOL_NARRATION_POLICY =
  'Uso de ferramentas (tools): você tem ferramentas disponíveis (ex.: Genie/Genie One para ' +
  'consultar dados, Python para cálculos). SEMPRE que for chamar uma ferramenta, escreva ANTES ' +
  'uma frase curta em linguagem natural dizendo O QUE vai fazer e POR QUÊ (ex.: "Vou consultar o ' +
  'Genie One para trazer a receita mês a mês direto do banco." ou "Deixa eu calcular a projeção ' +
  'em Python com essas premissas."). Isso vale para CADA chamada, inclusive as intermediárias ' +
  'entre uma ferramenta e outra — o usuário acompanha seu raciocínio em tempo real e não pode ' +
  'ficar sem nenhum sinal enquanto você trabalha. Seja conciso (uma frase por chamada, sem ' +
  'repetir a mesma frase), e ao terminar de usar as ferramentas, entregue a resposta/artefato ' +
  'final normalmente.'

// Resolves the tool defs for one turn: the built-in Python tool (if the model
// supports tools and provisioning succeeded) plus whichever Genie/UC refs the
// session has enabled. Shared by /api/chat and the regenerate endpoint so
// both attach tools identically.
async function resolveToolDefs(req, model, enabledToolRefs) {
  const modelInfo = modelById(model)
  if (!modelInfo.tools) return { toolDefs: null, toolResolvers: null }
  const ts = await ensureTools(req)
  const built = await buildToolDefs(enabledToolRefs, req.token, req.email, { includePython: ts.ready })
  if (!built.tools.length) return { toolDefs: null, toolResolvers: null }
  return { toolDefs: built.tools, toolResolvers: built.resolvers }
}

/**
 * Drives one assistant answer end-to-end: streams model output, executes any
 * tool calls (looping up to MAX_ROUNDS), and forwards SSE events as it goes.
 * `apiMessages` is mutated in place with the tool-call/tool-result turns.
 * Shared by /api/chat (new turns) and the regenerate endpoint (in-place
 * versions) — the only difference between them is how `apiMessages` and the
 * final message row get built around this call.
 * `chartState` ({nextId, items}) is mutated in place: a Genie tool call that
 * returns tabular data appends real, deterministic candidates to `items`,
 * numbered from the session-wide `nextId` counter, so the caller's later
 * extractPrismBlocks(answer, chartState.items) can resolve any prism-block
 * fence the model placed against them — including ones the model places in
 * a later turn, referencing data a tool call fetched earlier in the session.
 */
async function runAssistantTurn({
  req,
  res,
  send,
  model,
  temperature,
  apiMessages,
  toolDefs,
  toolResolvers,
  sessionId,
  chartState,
}) {
  let answer = ''
  const usage = { prompt_tokens: 0, completion_tokens: 0 }
  let hadUsage = false
  const toolTrace = []
  let finishReason = null
  // null = ran to a natural finish; 'loop' = cut off spinning on identical
  // calls; 'ceiling' = hit MAX_ROUNDS. Surfaced to the user as an honest notice.
  let stoppedEarly = null

  async function runRound(msgs, tools) {
    let content = ''
    let toolCalls = null
    for await (const chunk of streamChat(req.token, model, msgs, { temperature, tools })) {
      if (chunk.delta) {
        content += chunk.delta
        send({ type: 'token', value: chunk.delta })
      }
      if (chunk.usage) {
        usage.prompt_tokens += chunk.usage.prompt_tokens || 0
        usage.completion_tokens += chunk.usage.completion_tokens || 0
        hadUsage = true
      }
      if (chunk.finishReason) finishReason = chunk.finishReason
      if (chunk.toolCalls) toolCalls = chunk.toolCalls
      if (res.writableEnded) break
    }
    return { content, toolCalls }
  }

  try {
    // Hard backstop on tool-calling rounds — NOT "how many steps a task may
    // take" (that should be generous: query → iterate in Python → synthesize an
    // artifact is legitimately many rounds). This ceiling only catches truly
    // pathological runs; the real anti-spin mechanism is identical-call
    // detection below. Set high enough that a genuinely multi-step task never
    // hits it, low enough that a broken run can't rack up unbounded cost.
    const MAX_ROUNDS = 20
    // A model calling the EXACT same tool with the EXACT same arguments over and
    // over is stuck, not progressing — the classic agent failure mode. Distinct
    // calls (different Python code, a new Genie question) are real work and are
    // never counted here. Third identical repeat → force the model to wrap up.
    const REPEAT_LIMIT = 3
    const callCounts = new Map()
    let forceSynthesis = false
    for (let round = 0; round < MAX_ROUNDS && !res.writableEnded; round++) {
      const lastRound = round === MAX_ROUNDS - 1
      // Drop tools on the final allowed round OR once the model is detected
      // spinning — either way it's forced to WRITE its answer with what it has
      // instead of calling yet another tool. Without a guaranteed synthesis
      // round, a turn that keeps calling tools exits with its last content being
      // a tool call (no prose): the message persists empty and any prism-block
      // the user asked for (a spreadsheet, a deck) is never authored.
      const synthesize = lastRound || forceSynthesis
      const roundTools = synthesize ? null : toolDefs
      if (synthesize) {
        // record WHY we're cutting tools, so the caller can surface an honest
        // notice — the answer isn't "complete", it's the best with data so far
        stoppedEarly = forceSynthesis ? 'loop' : 'ceiling'
        // one-time nudge so the synthesis round produces the final answer AND
        // any requested artifact, not just a shrug
        apiMessages.push({ role: 'system', content: SYNTHESIS_NUDGE })
      }
      let result
      try {
        result = await runRound(apiMessages, roundTools)
      } catch (e) {
        // some endpoints reject the `tools` field outright — degrade once,
        // on the first round, instead of failing the whole answer
        if (roundTools && round === 0) {
          toolDefs = null
          result = await runRound(apiMessages, null)
        } else {
          throw e
        }
      }
      answer += result.content
      if (!result.toolCalls?.length || res.writableEnded) break

      // a model calling a tool with no parameters (e.g. the mcp-external
      // status tool) sometimes streams an empty `arguments` string instead
      // of "{}" — replaying that empty string back to the gateway as tool
      // history fails ("not a valid JSON string"), so it's normalized here,
      // once, before both replay and parsing below.
      for (const tc of result.toolCalls) {
        if (!tc.function.arguments) tc.function.arguments = '{}'
      }

      // identical-call detection: signature = tool name + verbatim arguments.
      // Once any signature repeats REPEAT_LIMIT times the model is spinning —
      // flag it so the NEXT round drops tools and forces a wrap-up.
      for (const tc of result.toolCalls) {
        const sig = `${tc.function?.name}:${tc.function.arguments}`
        const n = (callCounts.get(sig) || 0) + 1
        callCounts.set(sig, n)
        if (n >= REPEAT_LIMIT) forceSynthesis = true
      }

      // inline markers (same mechanism as {{block:N}}) placed in the *display*
      // text only — apiMessages keeps the model's own plain content, so the
      // model never sees or has to reproduce these — so the frontend can
      // render each tool-call chip exactly where it happened in the
      // conversation, interleaved with the narrative, instead of grouping
      // every call before the answer regardless of when it actually ran
      answer += result.toolCalls.map((tc) => `\n\n{{toolcall:${tc.id}}}\n\n`).join('')

      apiMessages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls })
      for (const tc of result.toolCalls) {
        const resolver = toolResolvers?.get(tc.function?.name)
        let args = {}
        try {
          args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}
        } catch {
          // malformed JSON from the model — run with empty args, the tool/UC
          // function will surface its own validation error
        }
        const label =
          resolver?.kind === 'python'
            ? 'Python'
            : resolver?.kind === 'genie'
              ? `Genie · ${resolver.ref.title}`
              : resolver?.kind === 'genie-one'
                ? 'Genie One'
                : resolver?.kind === 'vector-search'
                  ? `Vector Search · ${resolver.ref.indexName}`
                  : resolver?.kind === 'mcp-external'
                    ? `${resolver.ref.connectionName} · ${resolver.mcpToolName}`
                    : resolver?.kind === 'mcp-external-error'
                      ? `${resolver.connectionName} · indisponível`
                      : resolver?.ref?.name || tc.function?.name || 'tool'
        send({ type: 'tool_call', id: tc.id, name: tc.function?.name, label, args })

        const startedAt = Date.now()
        let resultText
        let status = 'ok'
        let newCandidates = []
        try {
          if (!resolver) throw new Error('Tool não reconhecida pelo servidor.')
          const invoked = await invokeTool(req.token, resolver, args, { sessionId, email: req.email })
          resultText = invoked.resultText
          newCandidates = invoked.chartCandidates || []
        } catch (e) {
          status = 'error'
          resultText = `ERROR: ${e.message}`
        }
        const durationMs = Date.now() - startedAt
        toolTrace.push({ id: tc.id, name: tc.function?.name, label, args, result: resultText, status, durationMs })
        send({ type: 'tool_result', id: tc.id, status, result: resultText, durationMs })

        let modelContent = resultText
        if (newCandidates.length && chartState) {
          newCandidates.forEach((c) => (c.id = `candidate_${chartState.nextId++}`))
          chartState.items.push(...newCandidates)
          modelContent += buildNewCandidatesHint(newCandidates)
        }
        apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: modelContent })
      }
    }
  } catch (e) {
    send({ type: 'error', error: e.message })
  }

  return { answer, usage, hadUsage, toolTrace, truncated: finishReason === 'length', stoppedEarly }
}

// A `finish_reason: "length"` turn hit the model's max_tokens mid-answer. For
// deck turns that's fatal in a silent way: the unclosed ```prism-block fence é
// descartado pelo extractPrismBlocks e a mensagem persistida ficaria VAZIA, sem
// nenhum feedback (bug real: sessão presa em "gerando" deck e nada renderiza).
// Anexa um aviso visível ao conteúdo persistido e emite o evento `error`, que o
// frontend já mostra como toast + linha inline.
const TRUNCATION_NOTICE =
  '⚠️ A resposta atingiu o limite de tokens de saída do modelo e chegou incompleta. ' +
  'Tente gerar novamente ou peça um conteúdo mais curto (ex.: um deck com menos slides).'

function applyTruncationNotice(truncated, content, send) {
  if (!truncated) return content
  send({ type: 'error', error: TRUNCATION_NOTICE })
  return content ? `${content}\n\n${TRUNCATION_NOTICE}` : TRUNCATION_NOTICE
}

// Injected once, right before the guaranteed synthesis round (tools already
// dropped) — tells the model to STOP calling tools and deliver the final
// answer plus any requested artifact with the data gathered so far.
const SYNTHESIS_NUDGE =
  'Pare de usar ferramentas agora e escreva a resposta final ao usuário com os dados que você já ' +
  'reuniu até aqui. Se o pedido inclui um artefato (planilha, deck, gráfico), produza-o agora no ' +
  'bloco ```prism-block``` apropriado. Se algum dado ficou faltando, entregue o melhor resultado ' +
  'possível e diga em uma frase, com honestidade, o que não foi possível obter.'

// The model was cut off before finishing on its own: either spinning on
// identical tool calls ('loop') or having hit the round ceiling ('ceiling').
// The synthesis round still produced a real answer with the data gathered, so
// this is an informational note, not an error — the answer is usable, just
// flagged as "best with what I had" so the user knows it wasn't a clean finish.
const STOPPED_EARLY_NOTICE = {
  loop:
    'ℹ️ Encerrei as consultas porque o modelo estava repetindo a mesma chamada sem avançar. A ' +
    'resposta acima foi montada com os dados obtidos até então.',
  ceiling:
    'ℹ️ Esta tarefa exigiu muitos passos e atingi o limite de rodadas de ferramentas. A resposta ' +
    'acima usa os dados reunidos até aqui — se faltou algo, peça a continuação.',
}

function applyStoppedEarlyNotice(stoppedEarly, content, send) {
  const notice = stoppedEarly && STOPPED_EARLY_NOTICE[stoppedEarly]
  if (!notice) return content
  send({ type: 'error', error: notice })
  return content ? `${content}\n\n${notice}` : notice
}

// A `deck` block is resolved (validated/sanitized) by extractPrismBlocks like
// any other prism-block, but — unlike chart/table/insight — it also needs a
// row of its own so the Deck Studio can reload/edit/export it later
// independent of the message's stored content. Mutates `blocks` in place to
// attach the new `deckId`.
async function persistDeckBlocks(req, sessionId, blocks) {
  for (const b of blocks) {
    if (b.type === 'deck') {
      const meta = { audience: b.audience, author: b.author, narrative: b.narrative }
      b.deckId = await createDeck(req.email, req.token, sessionId, b.title, b.slides, meta)
    } else if (b.type === 'spreadsheet') {
      // persist the whole spec (title + sheets) so the export route can
      // reload and render it into .xlsx independent of the message content
      const spec = { title: b.title, sheets: b.sheets }
      b.spreadsheetId = await createSpreadsheet(req.email, req.token, sessionId, b.title, spec)
    }
  }
}

// ---- API ----
app.get('/api/me', auth, async (req, res) => {
  try {
    await ensureReady(req)
    res.json({ email: req.email, isAdmin: await isAdmin(req.email, req.token), isOwner: isOwner(req.email) })
  } catch (e) {
    // identity must never fail the app shell — degrade to non-admin
    res.json({ email: req.email, isAdmin: isOwner(req.email), isOwner: isOwner(req.email) })
  }
})

// admin gate for management routes: 403 for signed-in non-admins
async function requireAdmin(req, res, next) {
  try {
    await ensureReady(req)
    if (await isAdmin(req.email, req.token)) return next()
    res.status(403).json({ error: 'apenas administradores' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}

app.get('/api/admins', auth, requireAdmin, async (req, res) => {
  try {
    res.json({
      owner: ownerEmail(),
      admins: await listAppAdmins(req.email, req.token),
      groupCheck: groupCheckStatus(),
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// autocomplete for the admin form: everyone already granted CAN_USE/CAN_MANAGE
// on the app (best-effort — empty list just disables suggestions)
app.get('/api/admins/candidates', auth, requireAdmin, async (req, res) => {
  res.json({ candidates: await appAccessCandidates(req.token) })
})

app.post('/api/admins', auth, requireAdmin, async (req, res) => {
  try {
    const principal = String(req.body?.principal || '').trim()
    const kind = req.body?.kind === 'group' ? 'group' : 'user'
    if (!principal || principal.length > 200) return res.status(400).json({ error: 'principal inválido' })
    if (kind === 'user' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(principal))
      return res.status(400).json({ error: 'para kind=user o principal deve ser um e-mail' })
    await addAppAdmin(req.email, req.token, principal, kind)
    invalidateAdminsCache()
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/admins/:principal', auth, requireAdmin, async (req, res) => {
  try {
    await removeAppAdmin(req.email, req.token, decodeURIComponent(req.params.principal))
    invalidateAdminsCache()
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/models', auth, (req, res) => {
  res.json({ models: MODELS, supported_extensions: SUPPORTED_EXTENSIONS })
})

app.get('/api/sessions', auth, async (req, res) => {
  try {
    await ensureReady(req)
    res.json({ sessions: await listSessions(req.email, req.token) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// semantic search over the user's chat history
app.get('/api/search', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const q = (req.query.q || '').toString().trim()
    if (!q) return res.json({ results: [] })

    // qwen3-embedding is instruction-tuned: queries use an Instruct/Query
    // prefix for asymmetric retrieval; passages (docs) stay plain.
    const qtext = `Instruct: Dada uma busca do usuário, recupere conversas de chat relevantes.\nQuery: ${q}`
    const [qvec] = await embed(req.token, [qtext])
    const rows = await listSessionsForSearch(req.email, req.token)

    // lazily backfill embeddings for sessions that don't have one yet
    const missing = rows.filter((r) => !r.embedding && r.doc)
    if (missing.length) {
      try {
        const vecs = await embed(
          req.token,
          missing.map((r) => r.doc.slice(0, 4000))
        )
        await Promise.all(
          missing.map((r, i) => {
            r.embedding = vecs[i]
            return setSessionEmbedding(req.email, req.token, r.id, vecs[i])
          })
        )
      } catch (e) {
        console.warn('search backfill failed:', e.message)
      }
    }

    const results = rows
      .filter((r) => r.embedding)
      .map((r) => ({ id: r.id, title: r.title, score: cosineSim(qvec, r.embedding) }))
      .filter((r) => r.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)

    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/sessions/:id/messages', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const msgs = await listMessages(req.email, req.token, req.params.id)
    res.json({ messages: msgs })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.patch('/api/sessions/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const fields = {}
    if (typeof req.body.title === 'string') fields.title = req.body.title
    if (typeof req.body.model === 'string') fields.model = req.body.model
    if (typeof req.body.system_prompt === 'string') fields.system_prompt = req.body.system_prompt
    if (Array.isArray(req.body.enabled_tools)) fields.enabled_tools = req.body.enabled_tools
    await updateSession(req.email, req.token, req.params.id, fields)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// search Unity Catalog Functions the user can attach as extra tools
app.get('/api/tools/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim()
    const results = await searchUcFunctions(req.token, q)
    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// search Genie Spaces the user can attach as extra tools
app.get('/api/tools/genie/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim()
    const results = await searchGenieSpaces(req.token, req.email, q)
    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// search Vector Search indexes the user can attach as extra tools
app.get('/api/tools/vector-search/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim()
    const results = await searchVectorIndexes(req.token, req.email, q)
    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// search Unity Catalog connections registered as external MCP servers
app.get('/api/tools/mcp/external/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim()
    const results = await searchExternalMcpConnections(req.token, req.email, q)
    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/sessions/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    await deleteSession(req.email, req.token, req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// a user's collection of presentation style templates ("design systems"),
// exactly one selected at a time (Settings → Modelos de apresentação).
// The list ships SUMMARIES (no readme/specimen cards — see templateSummary);
// the by-id route below returns the full row for the Design System viewer.
app.get('/api/deck-templates', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const [templates, admin] = await Promise.all([
      listDeckTemplates(req.email, req.token),
      isAdmin(req.email, req.token),
    ])
    // visible non-global rows are always the caller's own; global rows are
    // read-only unless the caller is an admin (server enforces on write too)
    res.json({
      templates: templates.map((t) => ({ ...templateSummary(t), canEdit: t.scope !== 'global' || admin })),
      isAdmin: admin,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Render bundle: only the SELECTED template, with iconAssets cut to the kinds
// the painters actually resolve (icon/image refs on slides, illustration art
// in the theme — see shared/deckTheme.js). The chat deck cards and the Studio
// load this on every deck open, so it must stay lean: a mined design system's
// full asset library (backgrounds, lockups) can be tens of MB and belongs
// only to the Settings grid, which keeps the full list endpoint.
// NOTE: registered before /api/deck-templates/:id — Express matches in order.
const RENDER_ASSET_KINDS = new Set(['icon', 'image', 'illustration'])
app.get('/api/deck-templates/selected', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const t = await getSelectedDeckTemplate(req.email, req.token)
    if (!t) return res.json({ template: null })
    const template = templateSummary(t)
    template.iconAssets = (template.iconAssets || []).filter((a) => !a.kind || RENDER_ASSET_KINDS.has(a.kind))
    res.json({ template })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/deck-templates/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const template = await getDeckTemplate(req.email, req.token, req.params.id)
    if (!template) return res.status(404).json({ error: 'modelo não encontrado' })
    res.json({ template })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// cheap shape/cap validation so a malformed client payload can't persist
// garbage into a design system (400 with the offending fields, not a 500)
function validateTemplatePayload(t) {
  const bad = []
  const hexOk = (v) => !v || /^#[0-9A-Fa-f]{6}$/.test(v)
  for (const k of ['primaryColor', 'secondaryColor', 'accentColor', 'backgroundColor']) {
    if (!hexOk(t[k])) bad.push(k)
  }
  if (t.palette !== undefined) {
    const ok =
      Array.isArray(t.palette) &&
      t.palette.length <= 64 &&
      t.palette.every((p) => p && typeof p.varName === 'string' && /^#[0-9A-Fa-f]{6}$/.test(p.value || ''))
    if (!ok) bad.push('palette')
  }
  if (t.iconAssets !== undefined) {
    const kinds = new Set(['icon', 'image', 'watermark', 'illustration', 'background', 'lockup'])
    const ok =
      Array.isArray(t.iconAssets) &&
      t.iconAssets.length <= 200 &&
      t.iconAssets.every(
        (a) => a && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:') && (!a.kind || kinds.has(a.kind))
      )
    if (!ok) bad.push('iconAssets')
  }
  if (t.fontAssets !== undefined) {
    const ok =
      Array.isArray(t.fontAssets) &&
      t.fontAssets.length <= 16 &&
      t.fontAssets.every((f) => f && typeof f.family === 'string' && typeof f.dataUrl === 'string' && f.dataUrl.startsWith('data:'))
    if (!ok) bad.push('fontAssets')
  }
  if (t.dsCards !== undefined) {
    const ok =
      Array.isArray(t.dsCards) &&
      t.dsCards.length <= 120 &&
      t.dsCards.every((c) => c && typeof c.html === 'string' && c.html.length <= 700_000)
    if (!ok) bad.push('dsCards')
  }
  return bad
}

app.post('/api/deck-templates', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const body = req.body || {}
    delete body._importReport // review-UI bookkeeping, never persisted
    const bad = validateTemplatePayload(body)
    if (bad.length) return res.status(400).json({ error: `payload inválido nos campos: ${bad.join(', ')}` })
    const template = await createDeckTemplate(req.email, req.token, body)
    res.json({ template })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Semantic labeling of mined design-system assets with a vision model — the
// import flow sends thumbnail-sized copies; the returned labels only steer
// asset choice in prompts (never slide content). Stateless: the client merges
// labels into the (still unsaved) template draft.
app.post('/api/deck-templates/label-assets', auth, async (req, res) => {
  try {
    const assets = (Array.isArray(req.body?.assets) ? req.body.assets : [])
      .filter((a) => a && typeof a.id === 'string' && typeof a.dataUrl === 'string' && /^data:image\//.test(a.dataUrl))
      .slice(0, 40)
      .map((a) => ({ id: a.id.slice(0, 60), kind: typeof a.kind === 'string' ? a.kind.slice(0, 12) : 'icon', dataUrl: a.dataUrl.slice(0, 300_000) }))
    const diagrams = (Array.isArray(req.body?.diagrams) ? req.body.diagrams : [])
      .filter((d) => d && typeof d.id === 'string')
      .slice(0, 8)
      .map((d) => ({ id: d.id.slice(0, 60), texts: (Array.isArray(d.texts) ? d.texts : []).map((t) => String(t).slice(0, 60)) }))
    if (!assets.length && !diagrams.length) return res.json({ labels: {} })
    res.json({ labels: await labelDesignAssets(req.token, assets, diagrams) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.patch('/api/deck-templates/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const body = req.body || {}
    delete body._importReport
    const bad = validateTemplatePayload(body)
    if (bad.length) return res.status(400).json({ error: `payload inválido nos campos: ${bad.join(', ')}` })
    const admin = await isAdmin(req.email, req.token)
    const ok = await updateDeckTemplate(req.email, req.token, req.params.id, body, admin)
    if (!ok) return res.status(403).json({ error: 'sem permissão para editar este modelo' })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/deck-templates/:id/select', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const ok = await selectDeckTemplate(req.email, req.token, req.params.id)
    if (!ok) return res.status(404).json({ error: 'modelo não encontrado' })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/deck-templates/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const admin = await isAdmin(req.email, req.token)
    const ok = await deleteDeckTemplate(req.email, req.token, req.params.id, admin)
    if (!ok) return res.status(403).json({ error: 'sem permissão para excluir este modelo' })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// publishes/unpublishes a template org-wide: global rows appear (read-only)
// for every user and become the default starting point for new users
app.post('/api/deck-templates/:id/scope', auth, requireAdmin, async (req, res) => {
  try {
    const scope = req.body?.scope === 'global' ? 'global' : 'user'
    const ok = await setDeckTemplateScope(req.email, req.token, req.params.id, scope)
    if (!ok) return res.status(404).json({ error: 'modelo não encontrado' })
    res.json({ ok: true, scope })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// decks the model designs as a `deck` prism-block (server/blocks.js) — edited
// and exported from the Deck Studio independent of the chat message itself
app.get('/api/decks/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const deck = await getDeck(req.email, req.token, req.params.id)
    if (!deck) return res.status(404).json({ error: 'deck não encontrado' })
    res.json({ deck })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.patch('/api/decks/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const sanitized = sanitizeDeck(req.body || {})
    if (!sanitized) return res.status(400).json({ error: 'deck inválido' })
    const meta = { audience: sanitized.audience, author: sanitized.author, narrative: sanitized.narrative }
    await updateDeckSlides(req.email, req.token, req.params.id, sanitized.title, sanitized.slides, meta)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Natural-language "tweak": the Studio sends an instruction (optionally
// scoped to a clicked element — see SelBox in DeckSlidePreview.jsx) and the
// model returns the revised slide/deck JSON, revalidated by the exact same
// sanitizers as generation, then persisted. Small, synchronous, non-streaming:
// a tweak is one focused edit, not a chat turn.
const TWEAK_MAX_TOKENS = 16384
// Data-URLs (images/fonts baked into slides) never travel to the tweak model:
// they're swapped for __ASSET_n__ sentinels before serializing and restored
// after the parse — cutting both cost and the chance of the model mangling
// megabytes of base64.
function stripDataUrls(value) {
  const assets = []
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const [k, val] of Object.entries(v)) out[k] = walk(val)
      return out
    }
    if (typeof v === 'string' && v.startsWith('data:') && v.length > 200) {
      assets.push(v)
      return `__ASSET_${assets.length - 1}__`
    }
    return v
  }
  return { stripped: walk(value), assets }
}

function restoreDataUrls(value, assets) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const [k, val] of Object.entries(v)) out[k] = walk(val)
      return out
    }
    if (typeof v === 'string') {
      const m = /^__ASSET_(\d+)__$/.exec(v)
      if (m && assets[+m[1]] !== undefined) return assets[+m[1]]
    }
    return v
  }
  return walk(value)
}

// Robust JSON extraction from a model reply: tolerates a prose preamble/note,
// markdown fences placed anywhere, and trailing text by scanning for the first
// balanced {...} or [...] (respecting string literals + escapes). Returns null
// only when there is genuinely no JSON value to recover. Far more forgiving
// than a leading/trailing fence strip, which broke whenever the model added
// any surrounding prose.
function extractJson(text) {
  if (typeof text !== 'string') return null
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    // fall through to balanced-scan
  }
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = cleaned.indexOf(open)
    if (start < 0) continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
      } else if (ch === '"') inStr = true
      else if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return null
}

// Immutable set-by-path (server mirror of DeckStudio's setDeep): splices a new
// value into a slide at a dotted/bracketed path like "cards[2].heading" without
// mutating the original — used to apply a field-scoped tweak deterministically.
function setDeepPath(obj, path, value) {
  const tokens = (String(path).match(/[^.[\]]+/g) || []).map((t) => (/^\d+$/.test(t) ? Number(t) : t))
  if (!tokens.length) return obj
  const clone = Array.isArray(obj) ? [...obj] : { ...obj }
  let cur = clone
  for (let i = 0; i < tokens.length - 1; i++) {
    const k = tokens[i]
    const next = cur[k]
    cur[k] = Array.isArray(next) ? [...next] : { ...(next || {}) }
    cur = cur[k]
  }
  cur[tokens[tokens.length - 1]] = value
  return clone
}

// compact element-schema description for tweaks on freeform slides — must
// stay in sync with the DECK_POLICY freeform section in server/blocks.js
const FREEFORM_TWEAK_SCHEMA =
  'Este slide é FREEFORM: {"layout":"freeform","background"?,"elements":[...]}. Cada elemento: ' +
  '{"id","name"?,"hidden"?,"type":"text|shape|line|icon|image|chart|group","box":{"x","y","w","h" em ' +
  'polegadas num canvas de 10×5.625},"rotate"?,"grow"?,"style":{...},"text"?/"shape"?/"icon"?/' +
  '"imageDataUrl"?/"chart"?/"children"?+"stack"?}. A ordem do array é a ordem de empilhamento (z). ' +
  'Grupos: {"type":"group","children":[...] (boxes relativos à origem do grupo),"stack"?:{"direction":' +
  '"column|row","gap","padding","align":"start|center|end|stretch","justify":"start|center|end|between"}} ' +
  '— num stack os x/y dos filhos são ignorados, a altura de textos é automática e "grow":1 absorve o ' +
  'espaço restante; style do grupo (fill/radius/borderColor) desenha um painel de fundo. ' +
  'Charts: {"type":"chart","chart":{"kind":"bar|barH|line|area|pie|doughnut|scatter|heatmap|gantt",' +
  '"series":[{"name","data":[{"label","value"}]}] (scatter usa points:[{x,y}]; heatmap usa ' +
  'heatmap:{xLabels,yLabels,values}; gantt usa gantt:{tasks:[{label,start,end}],axis:[...]})}} — nunca ' +
  'invente números novos. Style aceita: fill (#hex|"@tokenDoTema"|"none"), opacity 0-100, ' +
  'borderColor/Width/Dash, radius (pol), shadow, overflow, fontRole ("heading"|"body"), fontFamily, ' +
  'fontSize (pt), color, bold, italic, underline, uppercase, bullet, align, valign, lineHeight, ' +
  'letterSpacing, lineColor/Width, dash, arrowStart/End. Cores como tokens do tema (@primary @accent ' +
  '@background @heading @bodyText @muted @faint @hairline @accentSoft @cardFill @deep @onPrimary ' +
  '@onAccent @onPrimaryMuted @onPrimaryFaint) sempre que possível — hex literal congela a cor. ' +
  'PRESERVE os "id" existentes e todos os campos que não precisar mudar (inclusive sentinelas __ASSET_n__).'

// freeform element tree lookup/splice for layer-scoped tweaks
function findElementById(els, id) {
  for (const el of els || []) {
    if (el?.id === id) return el
    if (Array.isArray(el?.children)) {
      const hit = findElementById(el.children, id)
      if (hit) return hit
    }
  }
  return null
}

function replaceElementById(els, id, next) {
  return (els || []).map((el) => {
    if (el?.id === id) return next
    if (Array.isArray(el?.children)) return { ...el, children: replaceElementById(el.children, id, next) }
    return el
  })
}

app.post('/api/decks/:id/tweak', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const deck = await getDeck(req.email, req.token, req.params.id)
    if (!deck) return res.status(404).json({ error: 'deck não encontrado' })
    const instruction = String(req.body?.instruction || '').trim().slice(0, 2000)
    if (!instruction) return res.status(400).json({ error: 'instrução vazia' })
    const slideIndex = Number.isInteger(req.body?.slideIndex) ? req.body.slideIndex : null
    const scoped = slideIndex != null && deck.slides[slideIndex] ? deck.slides[slideIndex] : null
    const sel = req.body?.selection
    const selection =
      sel && typeof sel.path === 'string'
        ? { path: sel.path.slice(0, 80), label: String(sel.label || '').slice(0, 120), text: String(sel.text || '').slice(0, 400) }
        : null

    const template = await getSelectedDeckTemplate(req.email, req.token)
    const icons = usableIconAssets(template)
    const scopedFreeform = scoped?.layout === 'freeform'

    // Field-scoped fast path: a selected text field on a SEMANTIC slide (the
    // most common tweak — e.g. rewording a cover title). Reserializing the
    // whole slide to JSON just to change one string is fragile: any preamble
    // or note from the model breaks JSON.parse and the edit fails hard. Instead
    // ask for the new text ONLY (plain string, no JSON) and splice it into the
    // slide deterministically via setDeepPath — the same guarantee the freeform
    // element path already gives. A text edit must never fail on JSON parsing.
    if (scoped && !scopedFreeform && selection?.path) {
      const fieldSystem =
        'Você reescreve UM campo de texto de um slide de apresentação, seguindo a instrução do usuário. ' +
        'Responda com o TEXTO NOVO desse campo e nada mais — sem aspas, sem JSON, sem cercas de markdown, ' +
        'sem preâmbulo, sem explicação. Mantenha o mesmo idioma do texto atual. Nunca invente dados numéricos novos. ' +
        'Se a instrução não pedir mudança de conteúdo, devolva o texto atual inalterado.'
      const fieldUser =
        `Campo: ${selection.label || selection.path}\n` +
        `Texto atual: ${JSON.stringify(selection.text || '')}\n\n` +
        `Instrução: ${instruction}\n\nTexto novo:`
      const model = typeof req.body?.model === 'string' && modelById(req.body.model) ? req.body.model : MODELS[0].id
      const raw = await complete(req.token, model, [
        { role: 'system', content: fieldSystem },
        { role: 'user', content: fieldUser },
      ], { maxTokens: 2000, temperature: 0.2 })
      const newText = String(raw || '')
        .replace(/```[a-z]*\n?/gi, '')
        .trim()
        .replace(/^["'`]+|["'`]+$/g, '')
        .slice(0, 4000)
      if (!newText) return res.status(422).json({ error: 'a edição resultou em um texto vazio — tente reformular a instrução' })
      const nextSlide = setDeepPath(scoped, selection.path, newText)
      const revalidated = sanitizeDeck({ title: deck.title, slides: [nextSlide] }, new Map(), template)
      if (!revalidated?.slides?.length) return res.status(422).json({ error: 'a edição resultou em um slide inválido' })
      const slides = [...deck.slides]
      slides[slideIndex] = revalidated.slides[0]
      const updated = { ...deck, slides }
      const meta = { audience: updated.audience, author: updated.author, narrative: updated.narrative }
      await updateDeckSlides(req.email, req.token, req.params.id, updated.title, updated.slides, meta)
      return res.json({ deck: updated })
    }
    // freeform layer scoping: with a selected element the model answers with
    // the JSON of THAT element only and the server splices it back into the
    // slide — a hard guarantee the rest of the slide survives untouched
    const elementId = scopedFreeform && typeof sel?.elementId === 'string' ? sel.elementId.slice(0, 80) : null
    const selEl = elementId ? findElementById(scoped.elements || [], elementId) : null
    const system =
      (selEl
        ? 'Você edita UM ELEMENTO de um slide freeform de um deck de apresentação. Você receberá o JSON APENAS desse elemento (é tudo o que você precisa — nada fora dele existe para você).'
        : scoped
          ? 'Você edita UM slide de um deck de apresentação, representado em JSON (o schema é o mesmo dos blocos `deck` do AI Prism: layout, heading, subheading, kicker, bullets, cards, stats, phases, items, columns, callout, footnote, notes, styles...).'
          : 'Você edita um deck de apresentação inteiro, representado em JSON ({"title","slides":[...]}, schema dos blocos `deck` do AI Prism; slides com layout "freeform" carregam uma lista `elements` posicionada — preserve ids e boxes que a instrução não pedir para mudar).') +
      (scopedFreeform ? `\n${FREEFORM_TWEAK_SCHEMA}` : '') +
      (selEl
        ? ' Aplique a instrução SOMENTE ao elemento selecionado (e aos filhos dele, se for um grupo) — nada fora dele muda. ' +
          'Nunca invente dados numéricos novos. Responda APENAS com o JSON atualizado DESSE elemento, mantendo o mesmo "id" e preservando os campos que não precisar mudar (inclusive sentinelas __ASSET_n__; nunca as invente nem remova), sem cercas de markdown e sem comentários.'
        : ' Aplique SOMENTE a alteração pedida pelo usuário, preservando todo o resto intacto — incluindo campos que você não conhece (styles, iconAssetId, diagramSpec, imageDataUrl, series) e sentinelas __ASSET_n__ (referências a imagens; nunca as invente nem remova). ' +
          'Nunca invente dados numéricos novos. Responda APENAS com o JSON atualizado' +
          (scoped ? ' do slide' : ' do deck') +
          ', sem cercas de markdown e sem comentários.') +
      (icons.length
        ? '\nÍcones reais disponíveis (para itens de cards/stats/phases use `iconRef` com um destes ids; nunca emoji):\n' +
          icons.slice(0, 30).map((a) => `- ${a.id}: "${a.label || 'ícone'}"`).join('\n')
        : '')
    // element-scoped tweak: send ONLY the selected element's JSON as context
    // (not the whole slide) — the model edits one element, siblings are
    // irrelevant, and a smaller prompt is materially faster + cheaper. Other
    // scopes still serialize their full target (slide or deck).
    const { stripped, assets } = stripDataUrls(selEl || scoped || { title: deck.title, slides: deck.slides })
    const strippedJson = JSON.stringify(stripped)
    if (!scoped && strippedJson.length > 60_000) {
      return res.status(422).json({
        error: 'o deck é grande demais para uma alteração de uma vez — desmarque "aplicar ao deck inteiro" e edite slide a slide',
      })
    }
    const user = selEl
      ? `JSON do elemento selecionado (id "${elementId}"` +
        (sel?.label ? `, ${String(sel.label).slice(0, 120)}` : '') +
        `):\n${strippedJson}\n\n` +
        `Instrução: ${instruction}\n\nResponda com o JSON atualizado apenas desse elemento, mantendo o mesmo "id".`
      : `JSON atual:\n${strippedJson}\n\n` +
        (selection
          ? `Elemento selecionado pelo usuário: ${selection.label || selection.path} (path: ${selection.path}` +
            (selection.text ? `, texto atual: ${JSON.stringify(selection.text)}` : '') +
            '). A instrução se refere a ESTE elemento, salvo indicação em contrário.\n\n'
          : '') +
        `Instrução: ${instruction}`

    const model = typeof req.body?.model === 'string' && modelById(req.body.model) ? req.body.model : MODELS[0].id
    const out = await complete(req.token, model, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { maxTokens: TWEAK_MAX_TOKENS, temperature: 0.2 })

    const extracted = extractJson(out)
    if (extracted == null) {
      return res.status(422).json({ error: 'o modelo não devolveu um JSON válido — tente reformular a instrução' })
    }
    let parsed = restoreDataUrls(extracted, assets)

    // element-scoped answer: splice the revised element back into the
    // ORIGINAL slide (if the model answered with the whole slide anyway,
    // accept it — the scoped path below validates either)
    if (selEl && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (!(parsed.layout === 'freeform' && Array.isArray(parsed.elements))) {
        parsed = { ...scoped, elements: replaceElementById(scoped.elements || [], elementId, { ...parsed, id: elementId }) }
      }
    }

    let updated
    if (scoped) {
      const revalidated = sanitizeDeck({ title: deck.title, slides: [parsed] }, new Map(), template)
      if (!revalidated?.slides?.length) return res.status(422).json({ error: 'a edição resultou em um slide inválido' })
      const slides = [...deck.slides]
      slides[slideIndex] = revalidated.slides[0]
      updated = { ...deck, slides }
    } else {
      const revalidated = sanitizeDeck(parsed, new Map(), template)
      if (!revalidated) return res.status(422).json({ error: 'a edição resultou em um deck inválido' })
      updated = { ...deck, title: revalidated.title, slides: revalidated.slides }
    }
    const meta = { audience: updated.audience, author: updated.author, narrative: updated.narrative }
    await updateDeckSlides(req.email, req.token, req.params.id, updated.title, updated.slides, meta)
    res.json({ deck: updated })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/decks/:id/export', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const deck = await getDeck(req.email, req.token, req.params.id)
    if (!deck) return res.status(404).json({ error: 'deck não encontrado' })
    const template = await getSelectedDeckTemplate(req.email, req.token)
    const buf = await renderPptx(deck, template)
    const safeName = (deck.title || 'apresentacao').replace(/[^\w-]+/g, '_').slice(0, 60) || 'apresentacao'
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pptx"`)
    res.send(buf)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---- spreadsheets (tabular sibling of decks) ----
app.get('/api/spreadsheets/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const spreadsheet = await getSpreadsheet(req.email, req.token, req.params.id)
    if (!spreadsheet) return res.status(404).json({ error: 'planilha não encontrada' })
    res.json({ spreadsheet })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/spreadsheets/:id/export', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const spreadsheet = await getSpreadsheet(req.email, req.token, req.params.id)
    if (!spreadsheet) return res.status(404).json({ error: 'planilha não encontrada' })
    // the workbook wears the user's selected design system (same as decks)
    const template = await getSelectedDeckTemplate(req.email, req.token)
    const buf = await renderXlsx(spreadsheet, template)
    const safeName = (spreadsheet.title || 'planilha').replace(/[^\w-]+/g, '_').slice(0, 60) || 'planilha'
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xlsx"`)
    res.send(buf)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Studio: persist a full edited spec (revalidated by the same sanitizer as
// generation, so a hand-edit can never write a shape the renderer can't lay out).
app.patch('/api/spreadsheets/:id', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const existing = await getSpreadsheet(req.email, req.token, req.params.id)
    if (!existing) return res.status(404).json({ error: 'planilha não encontrada' })
    const sanitized = sanitizeSpreadsheet({ type: 'spreadsheet', ...(req.body || {}) })
    if (!sanitized) return res.status(400).json({ error: 'planilha inválida' })
    const spec = { title: sanitized.title, sheets: sanitized.sheets }
    if (sanitized.instructions) spec.instructions = sanitized.instructions
    await updateSpreadsheet(req.email, req.token, req.params.id, sanitized.title, spec)
    res.json({ spreadsheet: { id: String(req.params.id), ...spec } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Natural-language "tweak" (mirrors /api/decks/:id/tweak): the Studio sends an
// instruction, optionally scoped to one sheet; the model returns the revised
// spec JSON, revalidated by sanitizeSpreadsheet and persisted. One focused edit,
// synchronous and non-streaming. Formulas stay position-free (token) refs — the
// same contract SPREADSHEET_POLICY teaches — so the renderer resolves them.
const SS_TWEAK_MAX_TOKENS = 16384
app.post('/api/spreadsheets/:id/tweak', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const ss = await getSpreadsheet(req.email, req.token, req.params.id)
    if (!ss) return res.status(404).json({ error: 'planilha não encontrada' })
    const instruction = String(req.body?.instruction || '').trim().slice(0, 2000)
    if (!instruction) return res.status(400).json({ error: 'instrução vazia' })
    const sheetIndex = Number.isInteger(req.body?.sheetIndex) ? req.body.sheetIndex : null
    const scoped = sheetIndex != null && ss.sheets?.[sheetIndex] ? ss.sheets[sheetIndex] : null

    const system =
      (scoped
        ? 'Você edita UMA ABA de uma planilha (workbook) do AI Prism, representada em JSON. O schema é o dos blocos `spreadsheet`: a aba tem "name", "purpose"?, "freeze"?, "blocks" (lista ordenada de title/note/section/spacer/table) e "charts"?.'
        : 'Você edita uma PLANILHA (workbook) inteira do AI Prism, representada em JSON ({"title","instructions"?,"sheets":[...]}, schema dos blocos `spreadsheet`).') +
      ' Aplique SOMENTE a alteração pedida, preservando todo o resto intacto (colunas, roles, formatos, dropdowns, nomes de abas que não precisar mudar). ' +
      'REGRA CRÍTICA DE FÓRMULAS: nunca use referências A1 absolutas (ex.: "=B14-C14"). Use tokens que o app resolve: [@Coluna] (mesma linha), [Aba!Coluna] (coluna inteira de outra aba), [#nome] (célula nomeada). ' +
      'Nunca invente dados numéricos novos — para um template, deixe entradas vazias e fórmulas prontas. ' +
      'Responda APENAS com o JSON atualizado' + (scoped ? ' DESSA aba' : ' do workbook') + ', sem cercas de markdown e sem comentários.'

    const target = scoped || { title: ss.title, instructions: ss.instructions, sheets: ss.sheets }
    const strippedJson = JSON.stringify(target)
    if (strippedJson.length > 60_000) {
      return res.status(422).json({ error: 'a planilha é grande demais para editar de uma vez — edite uma aba por vez' })
    }
    const user = `JSON atual:\n${strippedJson}\n\nInstrução: ${instruction}`

    const model = typeof req.body?.model === 'string' && modelById(req.body.model) ? req.body.model : MODELS[0].id
    const out = await complete(req.token, model, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { maxTokens: SS_TWEAK_MAX_TOKENS, temperature: 0.2 })

    const parsed = extractJson(out)
    if (parsed == null) return res.status(422).json({ error: 'o modelo não devolveu um JSON válido — tente reformular a instrução' })

    let nextSpec
    if (scoped) {
      const sheets = [...ss.sheets]
      sheets[sheetIndex] = parsed
      nextSpec = { type: 'spreadsheet', title: ss.title, instructions: ss.instructions, sheets }
    } else {
      nextSpec = { type: 'spreadsheet', ...parsed }
    }
    const revalidated = sanitizeSpreadsheet(nextSpec)
    if (!revalidated) return res.status(422).json({ error: 'a edição resultou em uma planilha inválida' })
    const spec = { title: revalidated.title, sheets: revalidated.sheets }
    if (revalidated.instructions) spec.instructions = revalidated.instructions
    await updateSpreadsheet(req.email, req.token, req.params.id, revalidated.title, spec)
    res.json({ spreadsheet: { id: String(req.params.id), ...spec } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---- streaming chat ----
app.post('/api/chat', auth, upload.array('files'), async (req, res) => {
  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }
  try {
    await ensureReady(req)

    let payload = {}
    try {
      payload = JSON.parse(req.body.payload || '{}')
    } catch {
      return res.status(400).json({ error: 'payload inválido' })
    }
    const prompt = (payload.prompt || '').trim()
    const model = payload.model || MODELS[0].id
    const temperature = typeof payload.temperature === 'number' ? payload.temperature : 0.7
    const systemPrompt = (payload.systemPrompt || '').trim()
    const enabledToolRefs = Array.isArray(payload.enabledTools) ? payload.enabledTools : []
    let sessionId = payload.sessionId || null

    if (!prompt && !(req.files && req.files.length)) {
      return res.status(400).json({ error: 'prompt vazio' })
    }

    // extract attachment text, and — for spreadsheets — real chart candidates
    // computed deterministically (never by the model, to avoid hallucinated numbers)
    const attachNames = []
    const attachBlocks = []
    let fileCandidates = []
    for (const f of req.files || []) {
      const name = fixFilename(f.originalname)
      const text = await extractText(name, f.buffer)
      attachNames.push(name)
      attachBlocks.push(`### Arquivo: ${name}\n${text}`)
      if (isSpreadsheet(name)) {
        try {
          const { chartCandidates: cands } = analyzeSpreadsheet(name, f.buffer)
          fileCandidates = fileCandidates.concat(cands)
        } catch (e) {
          console.warn(`análise de planilha falhou (${name}):`, e.message)
        }
      }
    }

    // open SSE
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    // create session lazily on first message
    let isNew = false
    if (!sessionId) {
      isNew = true
      sessionId = await createSession(
        req.email,
        req.token,
        '💬 Nova conversa',
        model,
        systemPrompt,
        enabledToolRefs
      )
    }

    // chart candidates accumulate for the whole session's lifetime (see
    // saveSessionChartCandidates) — a report compiled several turns after
    // the Genie calls that fetched the numbers still needs those candidates
    // to resolve its prism-block fences, not just ones from this exact turn.
    const chartState = isNew
      ? { nextId: 1, items: [] }
      : await getSessionChartCandidates(req.email, req.token, sessionId)
    if (fileCandidates.length) {
      fileCandidates.forEach((c) => (c.id = `candidate_${chartState.nextId++}`))
      chartState.items.push(...fileCandidates)
    }

    const fullContent = attachBlocks.length
      ? prompt + ATTACH_MARKER + attachBlocks.join('\n\n')
      : prompt

    await addMessage(req.email, req.token, {
      sessionId,
      role: 'user',
      content: fullContent,
      attachments: attachNames.length ? JSON.stringify(attachNames) : null,
    })

    send({ type: 'meta', sessionId: String(sessionId), isNew })

    // build conversation for the model
    const history = await listMessages(req.email, req.token, sessionId)
    const apiMessages = []
    if (systemPrompt) apiMessages.push({ role: 'system', content: systemPrompt })
    // ephemeral, per-turn instruction — never persisted, only sent to the model
    const selectedTemplate = await getSelectedDeckTemplate(req.email, req.token)
    const blocksInstruction = buildBlocksInstruction(chartState.items, selectedTemplate)
    if (blocksInstruction) apiMessages.push({ role: 'system', content: blocksInstruction })
    for (const m of history) {
      // strip {{block:N}} placeholders from prior assistant turns — the
      // model doesn't need its own past visualization markers echoed back
      apiMessages.push({ role: m.role, content: stripBlockPlaceholders(m.content) })
    }

    // tools: the built-in Python UC function is provisioned lazily once per
    // process; additional tools are whichever UC Functions the user attached
    // to this session. Skip entirely for models flagged tools:false or if
    // provisioning failed (e.g. no SQL_WAREHOUSE_ID / no CREATE FUNCTION grant).
    const { toolDefs, toolResolvers } = await resolveToolDefs(req, model, enabledToolRefs)
    // narration guidance only when tools are actually in play — appended after
    // the history so it's the freshest instruction when the model decides
    // whether/how to call a tool
    if (toolDefs) apiMessages.push({ role: 'system', content: TOOL_NARRATION_POLICY })

    const { answer, usage, hadUsage, toolTrace, truncated, stoppedEarly } = await runAssistantTurn({
      req,
      res,
      send,
      model,
      temperature,
      apiMessages,
      toolDefs,
      toolResolvers,
      sessionId,
      chartState,
    })

    // resolve any model-placed chart/insight blocks against the real,
    // deterministic candidates (from attachments and/or Genie tool calls made
    // this turn or earlier in the session) — each fence becomes a {{block:N}}
    // placeholder right where the model put it, so the frontend renders it inline
    let { content: finalContent, blocks } = extractPrismBlocks(answer, chartState.items, selectedTemplate)
    finalContent = applyTruncationNotice(truncated, finalContent, send)
    finalContent = applyStoppedEarlyNotice(stoppedEarly, finalContent, send)
    await saveSessionChartCandidates(req.email, req.token, sessionId, chartState)
    await persistDeckBlocks(req, sessionId, blocks)

    const assistantMsg = await addMessage(req.email, req.token, {
      sessionId,
      role: 'assistant',
      content: finalContent,
      model,
      promptTokens: hadUsage ? usage.prompt_tokens : null,
      completionTokens: hadUsage ? usage.completion_tokens : null,
      blocks: blocks.length ? blocks : null,
    })
    if (toolTrace.length) await addToolCalls(req.email, req.token, assistantMsg.id, toolTrace)

    if (blocks.length) {
      send({ type: 'blocks', sessionId: String(sessionId), blocks, content: finalContent })
    }
    if (hadUsage) send({ type: 'usage', usage })

    // refresh the session's semantic-search embedding from the user's messages
    // (the topic/intent) — keeping the passage focused beats embedding the
    // verbose full transcript, which dilutes the topic.
    try {
      const doc = history
        .filter((m) => m.role === 'user')
        .map((m) => stripAttach(m.content))
        .join('\n')
        .slice(0, 1500)
      const [vec] = await embed(req.token, [doc])
      if (vec) await setSessionEmbedding(req.email, req.token, sessionId, vec)
    } catch (e) {
      console.warn('embedding update failed:', e.message)
    }

    // emoji title on the first exchange — the answer snippet grounds the
    // title in what the conversation is actually about, not just how the
    // user happened to phrase the opening message
    if (isNew) {
      const title = await generateTitle(req.token, prompt || attachNames.join(', '), answer)
      await updateSession(req.email, req.token, sessionId, { title })
      send({ type: 'title', title, sessionId: String(sessionId) })
    } else {
      await updateSession(req.email, req.token, sessionId, {})
    }

    send({ type: 'done' })
    res.end()
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message })
    } else {
      send({ type: 'error', error: e.message })
      send({ type: 'done' })
      res.end()
    }
  }
})

// ---- recovery: answer a trailing UNANSWERED user message ----
// A turn can leave a user message with no assistant reply — the server crashed
// or the token expired mid-generation, so /api/chat persisted the user row but
// never created the answer. There's no assistant message to "regenerate", so
// the user is stuck. This generates the missing reply as a fresh assistant
// message (its own variant group), building history exactly like /api/chat.
app.post('/api/sessions/:id/continue', auth, async (req, res) => {
  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }
  try {
    await ensureReady(req)

    const sessionId = req.params.id
    const model = req.body.model || MODELS[0].id
    const temperature = typeof req.body.temperature === 'number' ? req.body.temperature : 0.7
    const systemPrompt = (req.body.systemPrompt || '').trim()
    const enabledToolRefs = Array.isArray(req.body.enabledTools) ? req.body.enabledTools : []

    const history = await listMessages(req.email, req.token, sessionId)
    if (!history.length) return res.status(404).json({ error: 'sessão vazia' })
    // only valid when the conversation actually ends on an unanswered user
    // message — otherwise there's nothing missing to fill in
    if (history[history.length - 1].role !== 'user') {
      return res.status(409).json({ error: 'a última mensagem já foi respondida' })
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    const apiMessages = []
    if (systemPrompt) apiMessages.push({ role: 'system', content: systemPrompt })
    const chartState = await getSessionChartCandidates(req.email, req.token, sessionId)
    const selectedTemplate = await getSelectedDeckTemplate(req.email, req.token)
    const blocksInstruction = buildBlocksInstruction(chartState.items, selectedTemplate)
    if (blocksInstruction) apiMessages.push({ role: 'system', content: blocksInstruction })
    for (const m of history) {
      apiMessages.push({ role: m.role, content: stripBlockPlaceholders(m.content) })
    }

    const { toolDefs, toolResolvers } = await resolveToolDefs(req, model, enabledToolRefs)
    if (toolDefs) apiMessages.push({ role: 'system', content: TOOL_NARRATION_POLICY })

    const { answer, usage, hadUsage, toolTrace, truncated, stoppedEarly } = await runAssistantTurn({
      req,
      res,
      send,
      model,
      temperature,
      apiMessages,
      toolDefs,
      toolResolvers,
      sessionId,
      chartState,
    })

    let { content: finalContent, blocks } = extractPrismBlocks(answer, chartState.items, selectedTemplate)
    finalContent = applyTruncationNotice(truncated, finalContent, send)
    finalContent = applyStoppedEarlyNotice(stoppedEarly, finalContent, send)
    await saveSessionChartCandidates(req.email, req.token, sessionId, chartState)
    await persistDeckBlocks(req, sessionId, blocks)

    const assistantMsg = await addMessage(req.email, req.token, {
      sessionId,
      role: 'assistant',
      content: finalContent,
      model,
      promptTokens: hadUsage ? usage.prompt_tokens : null,
      completionTokens: hadUsage ? usage.completion_tokens : null,
      blocks: blocks.length ? blocks : null,
    })
    if (toolTrace.length) await addToolCalls(req.email, req.token, assistantMsg.id, toolTrace)

    if (blocks.length) send({ type: 'blocks', blocks, content: finalContent })
    if (hadUsage) send({ type: 'usage', usage })
    send({ type: 'variant', messageId: assistantMsg.id })

    await updateSession(req.email, req.token, sessionId, {})
    send({ type: 'done' })
    res.end()
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message })
    } else {
      send({ type: 'error', error: e.message })
      send({ type: 'done' })
      res.end()
    }
  }
})

// ---- in-place regeneration: replaces one assistant turn, keeping every
// earlier attempt as a browsable version instead of overwriting it ----
app.post('/api/sessions/:id/messages/:messageId/regenerate', auth, async (req, res) => {
  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }
  try {
    await ensureReady(req)

    const sessionId = req.params.id
    const model = req.body.model || MODELS[0].id
    const temperature = typeof req.body.temperature === 'number' ? req.body.temperature : 0.7
    const systemPrompt = (req.body.systemPrompt || '').trim()
    const enabledToolRefs = Array.isArray(req.body.enabledTools) ? req.body.enabledTools : []

    const { variantGroup, messages: history } = await listMessagesBeforeMessage(
      req.email,
      req.token,
      sessionId,
      req.params.messageId
    )
    if (!variantGroup) return res.status(404).json({ error: 'mensagem não encontrada' })

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    const apiMessages = []
    if (systemPrompt) apiMessages.push({ role: 'system', content: systemPrompt })
    // no new attachment on a regenerate turn, but candidates from earlier in
    // the session (past attachments/Genie calls) are still fair game
    const chartState = await getSessionChartCandidates(req.email, req.token, sessionId)
    const selectedTemplate = await getSelectedDeckTemplate(req.email, req.token)
    const blocksInstruction = buildBlocksInstruction(chartState.items, selectedTemplate)
    if (blocksInstruction) apiMessages.push({ role: 'system', content: blocksInstruction })
    for (const m of history) {
      apiMessages.push({ role: m.role, content: stripBlockPlaceholders(m.content) })
    }

    const { toolDefs, toolResolvers } = await resolveToolDefs(req, model, enabledToolRefs)
    if (toolDefs) apiMessages.push({ role: 'system', content: TOOL_NARRATION_POLICY })

    const { answer, usage, hadUsage, toolTrace, truncated, stoppedEarly } = await runAssistantTurn({
      req,
      res,
      send,
      model,
      temperature,
      apiMessages,
      toolDefs,
      toolResolvers,
      sessionId,
      chartState,
    })

    let { content: finalContent, blocks } = extractPrismBlocks(answer, chartState.items, selectedTemplate)
    finalContent = applyTruncationNotice(truncated, finalContent, send)
    finalContent = applyStoppedEarlyNotice(stoppedEarly, finalContent, send)
    await saveSessionChartCandidates(req.email, req.token, sessionId, chartState)
    await persistDeckBlocks(req, sessionId, blocks)

    const assistantMsg = await addMessage(req.email, req.token, {
      sessionId,
      role: 'assistant',
      content: finalContent,
      model,
      promptTokens: hadUsage ? usage.prompt_tokens : null,
      completionTokens: hadUsage ? usage.completion_tokens : null,
      blocks: blocks.length ? blocks : null,
      variantGroup,
    })
    if (toolTrace.length) await addToolCalls(req.email, req.token, assistantMsg.id, toolTrace)

    if (blocks.length) {
      send({ type: 'blocks', blocks, content: finalContent })
    }
    if (hadUsage) send({ type: 'usage', usage })
    send({ type: 'variant', messageId: assistantMsg.id, variantGroup })

    await updateSession(req.email, req.token, sessionId, {})
    send({ type: 'done' })
    res.end()
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message })
    } else {
      send({ type: 'error', error: e.message })
      send({ type: 'done' })
      res.end()
    }
  }
})

// switches which stored variant is "active" for its slot — used when the
// user browses the version carousel to something other than the latest
app.patch('/api/messages/:id/activate', auth, async (req, res) => {
  try {
    await ensureReady(req)
    await activateVariant(req.email, req.token, req.params.id)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// edits a previously-sent user prompt: files a new active variant into the
// same slot (the original wording stays in the table, just deactivated) —
// the frontend follows this up with a regenerate of the assistant reply that
// came after it, so the conversation continues from the corrected wording
app.post('/api/sessions/:id/messages/:messageId/edit', auth, async (req, res) => {
  try {
    await ensureReady(req)
    const newText = (req.body.content || '').trim()
    if (!newText) return res.status(400).json({ error: 'conteúdo vazio' })

    const orig = await getMessageRaw(req.email, req.token, req.params.messageId)
    if (!orig || orig.sessionId !== req.params.id || orig.role !== 'user') {
      return res.status(404).json({ error: 'mensagem não encontrada' })
    }

    // preserve the extracted-attachment tail (if any) — only the visible
    // prompt text is editable, not the files that were attached to it
    const markerIdx = orig.content.indexOf('\n\n--- ANEXOS ---')
    const tail = markerIdx >= 0 ? orig.content.slice(markerIdx) : ''

    const newMsg = await addMessage(req.email, req.token, {
      sessionId: req.params.id,
      role: 'user',
      content: newText + tail,
      attachments: orig.attachments,
      variantGroup: orig.variantGroup,
    })
    res.json({ id: newMsg.id, variantGroup: orig.variantGroup })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---- static frontend ----
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST))
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' })
    res.sendFile(path.join(DIST, 'index.html'))
  })
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Prism listening on :${PORT}`)
})
