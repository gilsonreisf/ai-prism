// Conectores gerenciados do Google (Gmail/Drive/Calendar), a via governada e
// per-user — SEM projeto próprio no Google Cloud. São conexões Unity Catalog do
// tipo HTTP com `is_mcp_connection=false` e `credential_type=OAUTH_U2M_MAPPING`,
// cujo OAuth com o Google usa o app OAuth embutido da Databricks. Cada usuário
// consente uma vez (página da conexão no Catalog Explorer).
//
// IMPORTANTE: eles NÃO são servidores MCP. O proxy `/api/2.0/mcp/external/<conn>`
// faz *passthrough HTTP autenticado*: anexa o caminho REST à URL e encaminha para
// o host da conexão (googleapis.com) injetando o token OAuth Google DO USUÁRIO.
// Confirmado ao vivo: GET .../<conn>/gmail/v1/users/me/messages -> 200 com o
// Gmail real do usuário. Por isso expomos um conjunto CURADO de tools por provider
// e as executamos como chamadas REST via esse passthrough — mesmo modelo
// on-behalf-of do resto do app (o bearer é o token encaminhado do usuário).
//
// Escopos (limite da plataforma): Gmail = `gmail.modify` (ler/rotular/rascunhos,
// sem `send`); Drive = `drive.readonly`/`documents.readonly`/`spreadsheets.readonly`
// + `drive.file`. MVP atual: LEITURA de Gmail.

function host() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

// Providers gerenciados que este módulo sabe expor como tools. Mantido enxuto de
// propósito (MVP = Gmail); adicionar Drive/Calendar é só estender aqui + specs.
export const MANAGED_GOOGLE_PROVIDERS = new Set(['OAUTH_PROVIDER_GMAIL', 'OAUTH_PROVIDER_GOOGLE_DRIVE'])

export function isManagedGoogleProvider(provider) {
  return MANAGED_GOOGLE_PROVIDERS.has(provider)
}

/** Rótulo amigável do conector (usado como descrição na aba de MCPs). */
export function googleProviderLabel(provider) {
  switch (provider) {
    case 'OAUTH_PROVIDER_GMAIL':
      return 'Gmail (conector gerenciado Databricks · leitura)'
    case 'OAUTH_PROVIDER_GOOGLE_DRIVE':
      return 'Google Drive (conector gerenciado Databricks)'
    case 'OAUTH_PROVIDER_GOOGLE_CALENDAR':
      return 'Google Calendar (conector gerenciado Databricks)'
    default:
      return 'Conector gerenciado Databricks'
  }
}

// A mensagem de "precisa consentir" que o proxy devolve quando o usuário ainda
// não autorizou a conexão (carrega o link da página de login no Catalog Explorer).
const LOGIN_HINT = /login first|not found for the connection|unauthenticated|please login|authorize/i

function loginErrorFrom(text) {
  // Para na primeira aspa/chave/barra: a mensagem vem embrulhada em JSON(-RPC),
  // então `\S+` capturaria lixo tipo `...?o=123\"}}` no fim da URL.
  const loginUrl = (String(text).match(/https?:\/\/[^\s"'\\}]+/) || [])[0] || ''
  const err = new Error(text || 'needs_login')
  err.needsLogin = true
  err.loginUrl = loginUrl
  return err
}

/**
 * Uma chamada REST via passthrough do proxy. Devolve JSON parseado.
 * Lança err.needsLogin=true (com loginUrl) quando o usuário ainda não consentiu,
 * para o chamador transformar em status "needs_login" (a UI já existe).
 */
async function googleFetch(
  token,
  connectionName,
  path,
  { method = 'GET', body = null, raw = false, rawBody = null, contentType = null } = {}
) {
  const url = `${host()}/api/2.0/mcp/external/${encodeURIComponent(connectionName)}${path}`
  // Corpo: `rawBody` (string, ex.: multipart de upload) tem prioridade e usa
  // `contentType`; senão `body` vira JSON.
  const ct = contentType || (body ? 'application/json' : null)
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(ct ? { 'Content-Type': ct } : {}),
    },
    body: rawBody != null ? rawBody : body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    if (LOGIN_HINT.test(text)) throw loginErrorFrom(text)
    // Escopo ainda não consentido (ex.: adicionamos escrita a uma conexão que só
    // tinha leitura): tratar como needs_login, apontando p/ a página de reautorização.
    if (res.status === 403 && /insufficient.*scope|insufficientPermissions/i.test(text)) {
      const err = new Error('Permissão insuficiente — reautorize a conexão para conceder as novas permissões (ex.: escrita).')
      err.needsLogin = true
      err.loginUrl = `${host()}/explore/connections/${encodeURIComponent(connectionName)}`
      throw err
    }
    throw new Error(`Google API ${res.status}: ${text.slice(0, 300)}`)
  }
  // Um 200 ainda pode carregar o aviso de consentimento (o proxy às vezes embrulha
  // o erro de auth num corpo 200 JSON-RPC-like).
  if (LOGIN_HINT.test(text) && /jsonrpc|error_code|UNAUTHENTICATED/i.test(text)) {
    throw loginErrorFrom(text)
  }
  // `raw`: endpoints que devolvem texto puro (export de Docs/Sheets, download de
  // arquivos texto via alt=media) — não tentar parsear JSON.
  if (raw) return text
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text }
  }
}

// ————————————————————————————————————————————————————————————————
// Gmail
// ————————————————————————————————————————————————————————————————

const GMAIL_SPECS = [
  {
    name: 'gmail_search',
    description:
      'Busca e-mails na caixa do PRÓPRIO usuário (Gmail). Use a sintaxe de busca do Gmail em `query` ' +
      '(ex.: "from:fulano newer_than:7d", "subject:contrato", "is:unread"). Retorna remetente, ' +
      'assunto, data, trecho e o id de cada mensagem (use gmail_get_message para o corpo completo).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Consulta no formato de busca do Gmail.' },
        max_results: { type: 'integer', description: 'Máximo de mensagens (1–10, padrão 5).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gmail_get_message',
    description:
      'Retorna o conteúdo completo de UMA mensagem de e-mail do próprio usuário (cabeçalhos e corpo em texto), ' +
      'dado o `message_id` obtido via gmail_search.',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'O id da mensagem (campo id do gmail_search).' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_create_draft',
    description:
      'Cria um RASCUNHO de e-mail na conta do PRÓPRIO usuário. IMPORTANTE: apenas salva em Rascunhos — ' +
      'NÃO envia. O usuário revisa e envia manualmente pelo Gmail. Use para preparar respostas/mensagens.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destinatário(s), separados por vírgula.' },
        subject: { type: 'string', description: 'Assunto do e-mail.' },
        body: { type: 'string', description: 'Corpo do e-mail, em texto.' },
        cc: { type: 'string', description: 'Cópia (Cc), separados por vírgula (opcional).' },
      },
      required: ['to', 'body'],
    },
  },
]

// RFC 2047 para Subject com caracteres não-ASCII (acentos etc.).
function encodeHeaderWord(s) {
  if (/^[\x00-\x7F]*$/.test(s)) return s
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
}

async function gmailCreateDraft(token, connectionName, args) {
  const to = String(args.to || '').trim()
  const body = String(args.body || '')
  if (!to) return 'Informe o destinatário (parâmetro `to`).'
  const cc = String(args.cc || '').trim()
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${encodeHeaderWord(String(args.subject || ''))}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    body,
  ].filter((l) => l !== null)
  const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
  const res = await googleFetch(token, connectionName, `/gmail/v1/users/me/drafts`, {
    method: 'POST',
    body: { message: { raw } },
  })
  const id = res?.id
  if (!id) return `ERROR: não foi possível criar o rascunho: ${JSON.stringify(res).slice(0, 200)}`
  return (
    `Rascunho criado (id: ${id}) na pasta Rascunhos do Gmail do usuário. ` +
    `NÃO foi enviado — o usuário deve revisar e enviar manualmente pelo Gmail.`
  )
}

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name?.toLowerCase() === name.toLowerCase())
  return h ? h.value : ''
}

// Decodifica base64url (Gmail) para texto UTF-8.
function decodeB64Url(data) {
  if (!data) return ''
  try {
    return Buffer.from(data, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

// Extrai o melhor corpo textual de um payload Gmail (prefere text/plain; cai para
// text/html com tags removidas). Caminha recursivamente pelas parts.
function extractBody(payload) {
  if (!payload) return ''
  const plain = findPart(payload, 'text/plain')
  if (plain) return decodeB64Url(plain.body?.data)
  const html = findPart(payload, 'text/html')
  if (html) return decodeB64Url(html.body?.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (payload.body?.data) return decodeB64Url(payload.body.data)
  return ''
}
function findPart(part, mime) {
  if (part.mimeType === mime && part.body?.data) return part
  for (const p of part.parts || []) {
    const found = findPart(p, mime)
    if (found) return found
  }
  return null
}

async function gmailSearch(token, connectionName, args) {
  const q = String(args.query || '').trim()
  if (!q) return 'Informe uma consulta de busca (parâmetro `query`).'
  const n = Math.min(Math.max(Number(args.max_results) || 5, 1), 10)
  const list = await googleFetch(
    token,
    connectionName,
    `/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${n}`
  )
  const ids = (list.messages || []).map((m) => m.id)
  if (!ids.length) return `Nenhuma mensagem encontrada para: ${q}`
  // format=metadata sem `metadataHeaders` (o proxy colapsa parâmetros repetidos,
  // então pedir headers específicos perdia From/Subject); traz todos os headers e
  // extraímos localmente os que interessam.
  const metas = await Promise.all(
    ids.map((id) =>
      googleFetch(token, connectionName, `/gmail/v1/users/me/messages/${id}?format=metadata`).catch((e) => ({
        id,
        _error: e.message,
      }))
    )
  )
  const lines = metas.map((m) => {
    if (m._error) return `- (erro ao ler ${m.id}: ${m._error})`
    const H = m.payload?.headers
    return [
      `• id: ${m.id}`,
      `  De: ${headerValue(H, 'From')}`,
      `  Assunto: ${headerValue(H, 'Subject')}`,
      `  Data: ${headerValue(H, 'Date')}`,
      `  Trecho: ${(m.snippet || '').slice(0, 200)}`,
    ].join('\n')
  })
  return `Resultados (${lines.length} de ~${list.resultSizeEstimate ?? '?'}) para "${q}":\n\n${lines.join('\n\n')}`
}

async function gmailGetMessage(token, connectionName, args) {
  const id = String(args.message_id || '').trim()
  if (!id) return 'Informe o `message_id`.'
  const m = await googleFetch(token, connectionName, `/gmail/v1/users/me/messages/${id}?format=full`)
  const H = m.payload?.headers
  const body = extractBody(m.payload).slice(0, 8000)
  return [
    `De: ${headerValue(H, 'From')}`,
    `Para: ${headerValue(H, 'To')}`,
    `Assunto: ${headerValue(H, 'Subject')}`,
    `Data: ${headerValue(H, 'Date')}`,
    '',
    body || `(sem corpo textual; trecho: ${m.snippet || ''})`,
  ].join('\n')
}

// ————————————————————————————————————————————————————————————————
// Google Drive (leitura)
// ————————————————————————————————————————————————————————————————

const DRIVE_SPECS = [
  {
    name: 'drive_search',
    description:
      'Busca arquivos no Google Drive do PRÓPRIO usuário por texto (procura no nome e no conteúdo). ' +
      'Retorna nome, id, tipo, data de modificação e link de cada arquivo (use drive_get_file para o conteúdo).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a procurar no nome/conteúdo dos arquivos.' },
        max_results: { type: 'integer', description: 'Máximo de arquivos (1–20, padrão 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'drive_get_file',
    description:
      'Retorna o conteúdo (em texto) de UM arquivo do Drive dado o `file_id` obtido via drive_search. ' +
      'Google Docs/Sheets/Slides são exportados para texto; arquivos de texto são lidos direto. ' +
      'Para formatos binários (ex.: PDF/imagem) retorna apenas os metadados e o link.',
    parameters: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'O id do arquivo (campo id do drive_search).' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'drive_create_document',
    description:
      'Cria um Google Documento (Docs) na Drive do PRÓPRIO usuário, com o conteúdo fornecido. ' +
      'ATENÇÃO: cria um arquivo REAL e imediato na Drive (o Drive não tem "rascunho"); o usuário pode ' +
      'editar/excluir depois. `content` pode ser HTML simples (títulos, negrito, listas) ou texto puro.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Nome/título do documento.' },
        content: { type: 'string', description: 'Conteúdo (HTML simples ou texto).' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'drive_create_spreadsheet',
    description:
      'Cria uma Planilha Google (Sheets) na Drive do PRÓPRIO usuário a partir de dados CSV. ' +
      'ATENÇÃO: cria um arquivo REAL e imediato na Drive (não é rascunho); o usuário pode editar/excluir. ' +
      '`csv` deve ser o conteúdo em CSV (primeira linha = cabeçalhos).',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Nome/título da planilha.' },
        csv: { type: 'string', description: 'Conteúdo em CSV (linhas separadas por \\n).' },
      },
      required: ['title', 'csv'],
    },
  },
]

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Monta um corpo multipart/related (metadados JSON + mídia) para o upload do Drive.
function multipartRelated(metadata, mediaContentType, mediaBody) {
  const boundary = 'aiprism_' + Math.random().toString(36).slice(2)
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mediaContentType}; charset=UTF-8\r\n\r\n` +
    `${mediaBody}\r\n` +
    `--${boundary}--`
  return { body, contentType: `multipart/related; boundary=${boundary}` }
}

// Cria um arquivo "Google nativo" fazendo upload de mídia que o Drive converte
// (HTML -> Documento, CSV -> Planilha). Usa o endpoint /upload (mesmo host).
async function driveCreateNative(token, connectionName, { name, googleMime, mediaType, mediaBody }) {
  const { body, contentType } = multipartRelated({ name, mimeType: googleMime }, mediaType, mediaBody)
  const res = await googleFetch(
    token,
    connectionName,
    `/upload/drive/v3/files?uploadType=multipart&${DRIVE_SHARED}&fields=id,name,webViewLink`,
    { method: 'POST', rawBody: body, contentType }
  )
  return res
}

async function driveCreateDocument(token, connectionName, args) {
  const name = String(args.title || '').trim() || 'Documento sem título'
  const content = String(args.content || '')
  // Se já vier HTML, usa como está; senão embrulha o texto (quebras -> <br>).
  const html = /<[a-z][\s\S]*>/i.test(content)
    ? content
    : `<html><body>${escapeHtml(content).replace(/\n/g, '<br>')}</body></html>`
  const res = await driveCreateNative(token, connectionName, {
    name,
    googleMime: 'application/vnd.google-apps.document',
    mediaType: 'text/html',
    mediaBody: html,
  })
  if (!res?.id) return `ERROR: não foi possível criar o documento: ${JSON.stringify(res).slice(0, 200)}`
  return `Documento criado: "${res.name}" (id: ${res.id}). Arquivo REAL na Drive do usuário (editável/excluível). Link: ${res.webViewLink || '—'}`
}

async function driveCreateSpreadsheet(token, connectionName, args) {
  const name = String(args.title || '').trim() || 'Planilha sem título'
  const csv = String(args.csv || '')
  if (!csv.trim()) return 'Informe o conteúdo CSV (parâmetro `csv`).'
  const res = await driveCreateNative(token, connectionName, {
    name,
    googleMime: 'application/vnd.google-apps.spreadsheet',
    mediaType: 'text/csv',
    mediaBody: csv,
  })
  if (!res?.id) return `ERROR: não foi possível criar a planilha: ${JSON.stringify(res).slice(0, 200)}`
  return `Planilha criada: "${res.name}" (id: ${res.id}). Arquivo REAL na Drive do usuário (editável/excluível). Link: ${res.webViewLink || '—'}`
}

// Parâmetros comuns p/ enxergar itens em Shared Drives também.
const DRIVE_SHARED = 'supportsAllDrives=true&includeItemsFromAllDrives=true'
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,owners(displayName,emailAddress),webViewLink'

async function driveSearch(token, connectionName, args) {
  const q = String(args.query || '').trim()
  if (!q) return 'Informe um texto de busca (parâmetro `query`).'
  const n = Math.min(Math.max(Number(args.max_results) || 10, 1), 20)
  // fullText procura em nome + conteúdo; escapa aspas simples para a sintaxe do Drive.
  const driveQ = `fullText contains '${q.replace(/'/g, "\\'")}' and trashed = false`
  const path =
    `/drive/v3/files?q=${encodeURIComponent(driveQ)}` +
    `&pageSize=${n}&${DRIVE_SHARED}&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}`
  const res = await googleFetch(token, connectionName, path)
  const files = res.files || []
  if (!files.length) return `Nenhum arquivo encontrado para: ${q}`
  const lines = files.map((f) =>
    [
      `• ${f.name}`,
      `  id: ${f.id}`,
      `  Tipo: ${f.mimeType}`,
      `  Modificado: ${f.modifiedTime || '?'}`,
      `  Dono: ${(f.owners && f.owners[0] && (f.owners[0].displayName || f.owners[0].emailAddress)) || '?'}`,
      `  Link: ${f.webViewLink || '—'}`,
    ].join('\n')
  )
  return `Arquivos encontrados (${lines.length}) para "${q}":\n\n${lines.join('\n\n')}`
}

// Formato de export para os tipos "Google nativos" (que não têm bytes brutos).
const GOOGLE_EXPORT = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
}

async function driveGetFile(token, connectionName, args) {
  const id = String(args.file_id || '').trim()
  if (!id) return 'Informe o `file_id`.'
  const meta = await googleFetch(
    token,
    connectionName,
    `/drive/v3/files/${id}?${DRIVE_SHARED}&fields=${encodeURIComponent(FILE_FIELDS)}`
  )
  const header = [
    `Nome: ${meta.name}`,
    `Tipo: ${meta.mimeType}`,
    `Modificado: ${meta.modifiedTime || '?'}`,
    `Link: ${meta.webViewLink || '—'}`,
    '',
  ].join('\n')

  const mime = meta.mimeType || ''
  let content = ''
  if (GOOGLE_EXPORT[mime]) {
    // Google Docs/Sheets/Slides: exportar para texto
    content = await googleFetch(
      token,
      connectionName,
      `/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(GOOGLE_EXPORT[mime])}&${DRIVE_SHARED}`,
      { raw: true }
    )
  } else if (/^text\//.test(mime) || /^application\/(json|xml|xhtml\+xml|javascript|csv)$/.test(mime)) {
    // Arquivos de TEXTO: baixar direto. (Estrito de propósito — mimes de Office
    // como application/vnd.openxmlformats-officedocument… são ZIP binário e
    // contêm "xml" no nome; não podem ser lidos como texto aqui.)
    content = await googleFetch(token, connectionName, `/drive/v3/files/${id}?alt=media&${DRIVE_SHARED}`, { raw: true })
  } else {
    return `${header}(Formato ${mime || 'binário'} não é texto — abra pelo link acima. Metadados apenas.)`
  }
  return `${header}${String(content).slice(0, 8000)}`
}

// ————————————————————————————————————————————————————————————————
// API pública do módulo
// ————————————————————————————————————————————————————————————————

/** Specs de tools (OpenAI function-calling) para um provider gerenciado. */
export function googleToolSpecs(provider) {
  if (provider === 'OAUTH_PROVIDER_GMAIL') return GMAIL_SPECS
  if (provider === 'OAUTH_PROVIDER_GOOGLE_DRIVE') return DRIVE_SPECS
  return []
}

/** Executa uma tool curada e devolve o texto para o modelo. */
export async function execGoogleTool(token, connectionName, googleToolName, args = {}) {
  switch (googleToolName) {
    case 'gmail_search':
      return gmailSearch(token, connectionName, args)
    case 'gmail_get_message':
      return gmailGetMessage(token, connectionName, args)
    case 'gmail_create_draft':
      return gmailCreateDraft(token, connectionName, args)
    case 'drive_search':
      return driveSearch(token, connectionName, args)
    case 'drive_get_file':
      return driveGetFile(token, connectionName, args)
    case 'drive_create_document':
      return driveCreateDocument(token, connectionName, args)
    case 'drive_create_spreadsheet':
      return driveCreateSpreadsheet(token, connectionName, args)
    default:
      return `ERROR: tool desconhecida "${googleToolName}".`
  }
}

/**
 * "Probe" leve de um conector gerenciado: faz uma leitura mínima para saber se o
 * usuário já consentiu. Retorna o mesmo shape do probe de MCP externo:
 * { status: 'connected' | 'needs_login' | 'unavailable', loginUrl?, error? }.
 */
export async function probeGoogleConnector(token, connectionName, provider) {
  try {
    if (provider === 'OAUTH_PROVIDER_GMAIL') {
      await googleFetch(token, connectionName, `/gmail/v1/users/me/profile`)
    } else if (provider === 'OAUTH_PROVIDER_GOOGLE_DRIVE') {
      await googleFetch(token, connectionName, `/drive/v3/files?pageSize=1&${DRIVE_SHARED}&fields=files(id)`)
    } else {
      await googleFetch(token, connectionName, `/`) // fallback genérico
    }
    return { status: 'connected' }
  } catch (e) {
    if (e.needsLogin) return { status: 'needs_login', loginUrl: e.loginUrl || '', error: e.message }
    return { status: 'unavailable', error: String(e.message || e) }
  }
}
