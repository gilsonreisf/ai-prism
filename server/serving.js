// Discovery of AI Gateway serving endpoints + merge with the curated static
// catalog and the admin overrides. Three layers:
//   1. LIVE endpoints from GET /api/2.0/serving-endpoints (task=llm/v1/chat)
//   2. CURATED defaults from MODELS in llm.js (rich flags: noTemperature, maxOut,
//      vision, streamUsage, promptCache — sondados ao vivo, ver memória)
//   3. ADMIN overrides from model_catalog_overrides (enabled + display name/blurb)
// so a brand-new endpoint served in the gateway shows up on the admin's Models
// tab automatically (with a derived label), the admin flips it on and names it,
// and only enabled endpoints reach regular users via GET /api/models.
import { MODELS } from './llm.js'

function host() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

const LIST_TTL_MS = 5 * 60 * 1000
const listCache = new Map() // host -> { ts, endpoints }

// GET the live chat serving endpoints. Best-effort: on any failure returns []
// and the caller falls back to the curated MODELS list (graceful degradation,
// same pattern the rest of the app uses).
export async function listChatEndpoints(token) {
  const h = host()
  const cached = listCache.get(h)
  if (cached && Date.now() - cached.ts < LIST_TTL_MS) return cached.endpoints
  try {
    const res = await fetch(`${h}/api/2.0/serving-endpoints`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) return []
    const d = await res.json()
    const endpoints = []
    for (const ep of d.endpoints || []) {
      // keep only chat-completions endpoints. The task lives on the endpoint or
      // (older shape) on the served entity's foundation-model metadata.
      const task =
        ep.task ||
        ep.config?.served_entities?.[0]?.foundation_model?.task ||
        ep.config?.served_models?.[0]?.foundation_model?.task ||
        ''
      if (task && !String(task).includes('llm/v1/chat')) continue
      // when task is absent we can't be sure; include it — the admin decides.
      endpoints.push({ id: ep.name })
    }
    listCache.set(h, { ts: Date.now(), endpoints })
    return endpoints
  } catch {
    return []
  }
}

const FAMILY_PROVIDER = [
  [/gpt-oss/, 'OpenAI (OSS)'],
  [/gpt/, 'OpenAI'],
  [/claude/, 'Anthropic'],
  [/gemini/, 'Google'],
  [/llama/, 'Meta'],
  [/qwen/, 'Alibaba'],
  [/glm/, 'Zhipu AI'],
]

export function deriveProvider(id) {
  const s = (id || '').toLowerCase()
  for (const [re, provider] of FAMILY_PROVIDER) if (re.test(s)) return provider
  return 'Outros'
}

const FAMILY_LABEL = { gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', llama: 'Llama', qwen: 'Qwen', glm: 'GLM' }

// databricks-gpt-5-6-terra -> "GPT 5.6 Terra". Strips the databricks- prefix,
// maps the family token to its display form, joins adjacent numbers with a dot
// (5-6 -> 5.6), Title-Cases the rest. Conservative — the admin can always edit.
export function deriveLabel(id) {
  let s = (id || '').replace(/^databricks-/, '')
  const tokens = s.split('-').filter(Boolean)
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const fam = FAMILY_LABEL[t.toLowerCase()]
    if (fam) {
      out.push(fam)
      continue
    }
    // fold a run of pure-number tokens into a dotted version (5-6 -> 5.6)
    if (/^\d+$/.test(t)) {
      const nums = [t]
      while (i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) {
        nums.push(tokens[++i])
      }
      out.push(nums.join('.'))
      continue
    }
    out.push(t.charAt(0).toUpperCase() + t.slice(1))
  }
  return out.join(' ') || id
}

// The static MODELS list keyed by id, for the curated-flag layer.
const CURATED = Object.fromEntries(MODELS.map((m) => [m.id, m]))

// Builds the ADMIN view: every live endpoint (discovered) unioned with any
// endpoint that has an override or a curated entry, each annotated with:
//   discovered, curated, enabled, displayName (override ?? curated ?? derived),
//   blurb, provider. The admin tab renders this list with a toggle + editable
//   name/blurb.
export function buildAdminCatalog(discovered, overrides) {
  const ids = new Set()
  for (const e of discovered) ids.add(e.id)
  for (const id of Object.keys(overrides || {})) ids.add(id)
  for (const id of Object.keys(CURATED)) ids.add(id)
  const discoveredIds = new Set(discovered.map((e) => e.id))
  const list = []
  for (const id of ids) {
    const ov = overrides?.[id]
    const cur = CURATED[id]
    list.push({
      id,
      discovered: discoveredIds.has(id),
      curated: !!cur,
      enabled: ov ? ov.enabled : false,
      displayName: (ov?.displayName || cur?.label || deriveLabel(id)),
      blurb: ov?.blurb ?? cur?.blurb ?? '',
      provider: cur?.provider || deriveProvider(id),
      sortOrder: ov?.sortOrder ?? null,
    })
  }
  // enabled first, then by sortOrder, then label
  list.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    const so = (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9)
    if (so) return so
    return a.displayName.localeCompare(b.displayName)
  })
  return list
}

// Builds the USER-facing model list for GET /api/models: only endpoints the
// admin enabled, in override sort order, carrying the curated flags the chat
// body needs (noTemperature/streamUsage/maxOut/tools/vision/promptCache) merged
// with the admin's display name + blurb. If NO overrides exist yet (fresh
// install, admin never opened the tab), falls back to the full curated MODELS
// so the picker is never empty.
export function buildUserModels(overrides) {
  const hasAny = overrides && Object.keys(overrides).length > 0
  if (!hasAny) return MODELS
  const enabled = Object.values(overrides).filter((o) => o.enabled)
  if (!enabled.length) return MODELS // never strand the org with zero models
  enabled.sort((a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9))
  return enabled.map((o) => {
    const cur = CURATED[o.endpointId] || {}
    return {
      // curated flags first (safe defaults for uncurated endpoints), then the
      // admin's display fields on top
      id: o.endpointId,
      provider: cur.provider || deriveProvider(o.endpointId),
      in: cur.in,
      out: cur.out,
      vision: cur.vision ?? false,
      streamUsage: cur.streamUsage ?? false,
      noTemperature: cur.noTemperature ?? true, // conservative: never causes a 400
      tools: cur.tools ?? true,
      maxOut: cur.maxOut ?? 8192,
      promptCache: cur.promptCache ?? false,
      label: o.displayName || cur.label || deriveLabel(o.endpointId),
      blurb: o.blurb || cur.blurb || '',
    }
  })
}
