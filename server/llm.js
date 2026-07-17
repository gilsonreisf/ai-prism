// Catalog of AI Gateway models surfaced in the UI. `in`/`out` are approximate
// public list prices (USD per 1M tokens) used only for the cost-estimate flourish.
// `streamUsage` marks endpoints that accept the OpenAI `stream_options` field
// (Anthropic Claude + proprietary GPT-5). Gemini and the open-weights models
// served here reject it with a 400, so we omit it for them.
// `tools` marks endpoints we attach function-calling tools to (all of them —
// the AI Gateway normalizes tool calling across providers). If a specific
// endpoint ever rejects the `tools` field, index.js retries that turn without
// it rather than failing the whole request, so this flag is a hint, not a hard guarantee.
// `maxOut` is the max_tokens sent on chat turns. It must clear two bars: um
// deck completo (o maior artefato de um turno) consome bem mais que 4k tokens,
// e modelos de raciocínio queimam parte do orçamento em thinking oculto. Não
// pode passar do teto do endpoint, que o gateway rejeita com 400 — tetos
// sondados empiricamente: llama-4-maverick 8192, qwen35-122b 16384,
// gpt-oss-120b 16384, demais aceitam ≥32768.
//
// Catálogo curado (fase 1): estes ids/labels/flags foram conferidos ao vivo
// contra os endpoints `llm/v1/chat` do AI Gateway do workspace (e2-demo-field-eng).
// Sondas empíricas confirmaram, por endpoint: rejeição de `temperature` custom
// (→ noTemperature; ex.: toda a família Claude 5, GPT-5.6), aceitação de
// `stream_options` (→ streamUsage; Gemini rejeita com 400) e o teto de
// max_tokens. Modelos são adicionados/atualizados aqui à mão POR ORA — a fase 2
// (auto-discovery via GET /serving-endpoints, filtrando task=llm/v1/chat e
// aplicando estes overrides por padrão de nome) torna esta lista automática.
export const MODELS = [
  { id: 'databricks-claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'Anthropic', blurb: 'Equilibrado e rápido — ótimo padrão para agentes', in: 3, out: 15, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768 },
  { id: 'databricks-claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'Anthropic', blurb: 'Máxima capacidade de raciocínio e análise', in: 15, out: 75, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768 },
  { id: 'databricks-claude-fable-5', label: 'Claude Fable 5', provider: 'Anthropic', blurb: 'Família Claude 5, geração criativa e ágil', in: 1, out: 5, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768 },
  { id: 'databricks-claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'Anthropic', blurb: 'Rápido e econômico', in: 0.8, out: 4, vision: true, streamUsage: true, tools: true, maxOut: 32768 },
  { id: 'databricks-gpt-5-6-terra', label: 'GPT-5.6', provider: 'OpenAI', blurb: 'Multimodal de fronteira e agentes complexos', in: 1.25, out: 10, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768 },
  { id: 'databricks-gpt-5-mini', label: 'GPT-5 mini', provider: 'OpenAI', blurb: 'Rápido e de baixo custo', in: 0.25, out: 2, vision: true, streamUsage: true, noTemperature: true, tools: true, maxOut: 32768 },
  { id: 'databricks-gemini-3-pro', label: 'Gemini 3 Pro', provider: 'Google', blurb: 'Fronteira multimodal, contexto muito longo', in: 1.25, out: 10, vision: true, streamUsage: false, tools: true, maxOut: 32768 },
  { id: 'databricks-gemini-3-5-flash', label: 'Gemini 3.5 Flash', provider: 'Google', blurb: 'Muito rápido, contexto longo', in: 0.3, out: 2.5, vision: true, streamUsage: false, tools: true, maxOut: 32768 },
  { id: 'databricks-llama-4-maverick', label: 'Llama 4 Maverick', provider: 'Meta', blurb: 'Pesos abertos, modelo geral robusto', in: 0.5, out: 1.5, vision: false, streamUsage: false, tools: true, maxOut: 8192 },
  { id: 'databricks-glm-5-2', label: 'GLM-5.2', provider: 'Zhipu AI', blurb: 'Aberto, forte em raciocínio e código', in: 0.6, out: 2, vision: false, streamUsage: true, tools: true, maxOut: 32768 },
  { id: 'databricks-qwen35-122b-a10b', label: 'Qwen3.5 122B', provider: 'Alibaba', blurb: 'Aberto e eficiente, raciocínio MoE', in: 0.4, out: 1.2, vision: false, streamUsage: true, tools: true, maxOut: 16384 },
  { id: 'databricks-gpt-oss-120b', label: 'GPT-OSS 120B', provider: 'OpenAI (OSS)', blurb: 'Pesos abertos, ideal para auto-hospedagem', in: 0.3, out: 1.0, vision: false, streamUsage: false, tools: true, maxOut: 16384 },
]

// A fast, non-reasoning model: reasoning models can burn the whole token
// budget on hidden thinking and return empty content for tiny outputs.
const FAST_TITLE_MODEL = 'databricks-claude-haiku-4-5'

// Multilingual embedding model — far better Portuguese discrimination than the
// English-tuned gte/bge endpoints.
const EMBED_MODEL = 'databricks-qwen3-embedding-0-6b'

export function modelById(id) {
  return MODELS.find((m) => m.id === id) || MODELS[0]
}

function host() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

function chatUrl() {
  return `${host()}/serving-endpoints/chat/completions`
}

/** Embed one or more strings via the AI Gateway embeddings endpoint. */
export async function embed(token, inputs) {
  const arr = Array.isArray(inputs) ? inputs : [inputs]
  const res = await fetch(`${host()}/serving-endpoints/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: arr }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Embeddings ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = await res.json()
  return (json.data || []).map((d) => d.embedding)
}

// Content can be a plain string or, for harmony-format models (gpt-oss), an
// array of parts (reasoning summaries + text). Extract just the answer text.
function extractContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let out = ''
    for (const part of content) {
      if (typeof part === 'string') out += part
      else if (part?.type === 'text' && part.text) out += part.text
      // skip reasoning / summary parts
    }
    return out
  }
  return ''
}

export function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// Merges one streamed tool_calls delta fragment into the accumulator array,
// keyed by the provider's `index` — `arguments` arrives as incremental JSON
// string fragments that must be concatenated, not replaced.
function mergeToolCallDelta(acc, deltas) {
  for (const d of deltas) {
    const i = d.index ?? 0
    if (!acc[i]) acc[i] = { id: d.id, type: d.type || 'function', function: { name: '', arguments: '' } }
    if (d.id) acc[i].id = d.id
    if (d.function?.name) acc[i].function.name += d.function.name
    if (d.function?.arguments) acc[i].function.arguments += d.function.arguments
  }
}

/**
 * Stream a chat completion. Yields { delta } chunks for content tokens, and a
 * final { usage, toolCalls, finishReason } object once the stream ends.
 * `toolCalls` is null unless the model asked to call one or more tools.
 */
export async function* streamChat(token, model, messages, opts = {}) {
  const info = modelById(model)
  const body = {
    model,
    messages,
    max_tokens: opts.maxTokens || info.maxOut || 8192,
    stream: true,
  }
  // Some reasoning models (Claude Opus 4.8, GPT-5.5, GPT-5 mini) reject a
  // custom `temperature` with a 400; only send it for models that accept it.
  if (!info.noTemperature) {
    body.temperature = opts.temperature ?? 0.7
  }
  // Only endpoints flagged streamUsage accept stream_options; others (Gemini,
  // open-weights models) 400 on it. Many still return usage in the final chunk.
  if (info.streamUsage) {
    body.stream_options = { include_usage: true }
  }
  if (opts.tools?.length) {
    body.tools = opts.tools
  }

  const res = await fetch(chatUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`Endpoint ${model} returned ${res.status}: ${text.slice(0, 500)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let usage = null
  let toolCalls = []
  let finishReason = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let json
      try {
        json = JSON.parse(data)
      } catch {
        continue
      }
      if (json.usage) usage = json.usage
      const choice = json.choices?.[0]
      if (choice?.finish_reason) finishReason = choice.finish_reason
      if (choice?.delta?.tool_calls) mergeToolCallDelta(toolCalls, choice.delta.tool_calls)
      const delta = extractContent(choice?.delta?.content)
      if (delta) yield { delta }
    }
  }
  yield { usage: usage || null, toolCalls: toolCalls.length ? toolCalls : null, finishReason }
}

/** Non-streaming completion (used for title generation). */
export async function complete(token, model, messages, opts = {}) {
  const completeBody = {
    model,
    messages,
    max_tokens: opts.maxTokens || 256,
  }
  if (!modelById(model).noTemperature) {
    completeBody.temperature = opts.temperature ?? 0.5
  }
  const res = await fetch(chatUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(completeBody),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Endpoint ${model} returned ${res.status}: ${text.slice(0, 300)}`)
  }
  const json = await res.json()
  return extractContent(json.choices?.[0]?.message?.content)
}

// Vision model used to label mined design-system assets at import time —
// fast/cheap and vision-capable; labels only steer asset CHOICE (iconRef/
// imageRef in server/blocks.js), they never enter slide content.
const ASSET_LABEL_MODEL = 'databricks-claude-haiku-4-5'

/**
 * Semantic labeling of mined design-system assets (gap-analysis "next step"):
 * a mined icon arrives as "Gráfico 37"/"" — useless for the model to decide
 * whether it fits a card. This sends the (already thumbnail-sized) images to
 * a vision model and returns { [assetId]: "rótulo curto" }. Diagrams have no
 * raster — their box texts are sent instead. Best-effort: on any failure the
 * caller keeps the original labels.
 */
export async function labelDesignAssets(token, assets = [], diagrams = []) {
  const content = [
    {
      type: 'text',
      text:
        'Você rotula assets de um design system corporativo para uso por outro modelo. ' +
        'Para cada item abaixo, gere um rótulo curto (2 a 6 palavras, pt-BR, sem ponto final) que descreva ' +
        'O QUE a imagem representa conceitualmente (ex.: "cadeado — segurança", "gráfico de barras crescente", ' +
        '"logo da empresa", "foto de datacenter"). Responda SOMENTE com JSON válido no formato ' +
        '{"labels":{"<id>":"<rótulo>", ...}} cobrindo todos os ids.',
    },
  ]
  for (const a of assets.slice(0, 40)) {
    content.push({ type: 'text', text: `id: ${a.id} (${a.kind || 'icon'})` })
    content.push({ type: 'image_url', image_url: { url: a.dataUrl } })
  }
  for (const d of diagrams.slice(0, 8)) {
    content.push({
      type: 'text',
      text: `id: ${d.id} (diagrama vetorial; textos das formas: ${(d.texts || []).slice(0, 20).join(' | ').slice(0, 500)})`,
    })
  }
  const out = await complete(token, ASSET_LABEL_MODEL, [{ role: 'user', content }], { maxTokens: 1500, temperature: 0.2 })
  const match = out.match(/\{[\s\S]*\}/)
  if (!match) return {}
  try {
    const parsed = JSON.parse(match[0])
    const labels = {}
    for (const [id, label] of Object.entries(parsed.labels || {})) {
      if (typeof label === 'string' && label.trim()) labels[id] = label.trim().slice(0, 80)
    }
    return labels
  } catch {
    return {}
  }
}

/**
 * Generate a short session title: exactly one emoji + a few words, in the
 * user's own language. Falls back to a trimmed prompt if the model misbehaves.
 */
export async function generateTitle(token, firstUserMessage, assistantAnswer = '') {
  const snippet = (firstUserMessage || '').slice(0, 1500)
  const answerSnippet = (assistantAnswer || '').slice(0, 800)
  try {
    const out = await complete(
      token,
      FAST_TITLE_MODEL,
      [
        {
          role: 'system',
          content:
            'You title chat conversations for a sidebar list. ' +
            'Reply with EXACTLY one emoji, a space, and a specific 3 to 6 word title. ' +
            'Name the concrete subject — products, datasets, metrics, technologies, people, places — ' +
            'so this conversation is distinguishable from others on a similar theme. ' +
            'Never use generic filler like "Ajuda com", "Dúvida sobre", "Pergunta", "Conversa sobre". ' +
            "Write the title in the same language as the user's message. " +
            'No quotes, no trailing punctuation, no extra words.',
        },
        {
          role: 'user',
          content: answerSnippet
            ? `Mensagem do usuário:\n${snippet}\n\nInício da resposta do assistente:\n${answerSnippet}`
            : snippet,
        },
      ],
      { maxTokens: 40, temperature: 0.6 }
    )
    const clean = out.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\n.*$/s, '').slice(0, 60)
    if (clean) return clean
  } catch {
    // fall through to heuristic
  }
  const fallback = snippet.replace(/\s+/g, ' ').trim().slice(0, 40)
  return `💬 ${fallback || 'Nova conversa'}`
}
