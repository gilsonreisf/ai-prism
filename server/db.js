import pg from 'pg'

const { Client, Pool } = pg

// ---- connection identity ----------------------------------------------------
// Preferred: the APP's service principal (Databricks Apps inject
// DATABRICKS_CLIENT_ID/SECRET). One PG role serves every signed-in user and
// per-user isolation is enforced app-level by the user_email WHERE clauses —
// this is what makes the app truly multi-user (workspace users don't get
// Lakebase PG roles of their own) and what lets admins publish global
// templates every user can read. Requires a one-time setup:
//   POST /api/2.0/database/instances/<instance>/roles
//     {"name": "<DATABRICKS_CLIENT_ID>", "identity_type": "SERVICE_PRINCIPAL"}
//   + GRANTs on the app tables (see ensureSchema's grant block).
// Fallback: the caller's own identity + OBO token as password (original
// behavior — works for the table owner even without the SP role). A failed SP
// login only disables the SP path temporarily (never a permanent latch).
const SP_RETRY_MS = 5 * 60 * 1000
let spToken = { value: null, exp: 0 }
let spDisabledUntil = 0

function oidcHost() {
  let h = process.env.DATABRICKS_HOST || ''
  if (h && !h.startsWith('http')) h = `https://${h}`
  return h
}

async function spAccessToken() {
  if (spToken.value && Date.now() < spToken.exp - 120_000) return spToken.value
  const res = await fetch(`${oidcHost()}/oidc/v1/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'all-apis',
      client_id: process.env.DATABRICKS_CLIENT_ID,
      client_secret: process.env.DATABRICKS_CLIENT_SECRET,
    }),
  })
  if (!res.ok) throw new Error(`sp token: HTTP ${res.status}`)
  const d = await res.json()
  spToken = { value: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 }
  return spToken.value
}

function connInfo(user, password) {
  return {
    host: process.env.PGHOST,
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'databricks_postgres',
    user,
    password,
    ssl: { rejectUnauthorized: false },
    // keep the handshake snappy; fail loud if Lakebase is unreachable
    connectionTimeoutMillis: 15000,
    // 60s: the Settings template list ships whole mined asset libraries (MBs
    // of jsonb) — comfortably fast in-region, but a remote dev laptop pays
    // the cross-region transfer inside the query and 30s wasn't enough
    query_timeout: 60000,
  }
}

// ---- connection pooling ------------------------------------------------------
// The Lakebase handshake (TLS + auth) costs ~2s in-region, and a single chat
// turn runs ~10 DB operations. Opening a fresh Client per op (the original
// design) serialized ~20s of pure handshake onto every turn. Pooling reuses
// warm sockets: only the FIRST op of a cold pool pays the handshake.
//
// Token rotation (the reason pooling was originally avoided) is handled two
// ways: (1) `password` is passed as an async FUNCTION — node-postgres calls it
// for each NEW physical connection, so a fresh SP token is fetched at connect
// time; and (2) an already-open socket doesn't re-authenticate (Postgres only
// checks credentials at connect), so a mid-flight token expiry can't break a
// live connection. Idle connections are reaped after `idleTimeoutMillis`, and
// `maxLifetime` caps how long any socket lives so we never sit on an ancient
// one. A per-connection error (e.g. server-side termination) just removes it
// from the pool; the next acquire opens a fresh one.
const POOL_OPTS = {
  max: 8,
  idleTimeoutMillis: 5 * 60 * 1000,
  maxLifetimeSeconds: 30 * 60,
  allowExitOnIdle: true,
}

// SP pool: one shared identity for the whole app, so a single pool serves every
// user. `password` is a function → each new connection gets a fresh SP token.
let spPool = null
function getSpPool() {
  if (!spPool) {
    spPool = new Pool({
      ...connInfo(process.env.DATABRICKS_CLIENT_ID, () => spAccessToken()),
      ...POOL_OPTS,
    })
    // a broken idle socket must never crash the process — pg emits 'error' on
    // the pool for backend-terminated idle clients; drop it and move on.
    spPool.on('error', (e) => console.warn('lakebase SP pool: idle client error (dropped):', e.message))
  }
  return spPool
}

// Per-user pools, keyed by email — ONLY when the password is stable across the
// process (PGPASSWORD, i.e. local dev with a generated DB credential). With a
// rotating OBO token as password we can't safely pool (a reaped+reopened
// connection would use a stale token), so that path stays one-shot below.
const userPools = new Map()
function getUserPool(userEmail, password) {
  let p = userPools.get(userEmail)
  if (!p) {
    p = new Pool({ ...connInfo(userEmail, password), ...POOL_OPTS })
    p.on('error', (e) => console.warn(`lakebase user pool (${userEmail}): idle client error (dropped):`, e.message))
    userPools.set(userEmail, p)
  }
  return p
}

// Runs fn(client) with a pooled connection, releasing it back afterward.
async function withPool(pool, fn) {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

async function withClient(userEmail, userToken, fn) {
  if (process.env.DATABRICKS_CLIENT_ID && process.env.DATABRICKS_CLIENT_SECRET && Date.now() >= spDisabledUntil) {
    try {
      return await withPool(getSpPool(), fn)
    } catch (e) {
      // only auth/connection/authorization failures demote to the per-user
      // path; real query errors (thrown inside fn) must surface, not be
      // silently retried. "permission denied" means the SP role exists but
      // its GRANTs haven't been applied yet (see ensureSpGrants) — degrading
      // to the caller's own identity keeps the table owner working meanwhile.
      if (!/password authentication|role .* does not exist|sp token|permission denied|ECONNREFUSED|ETIMEDOUT/i.test(e.message || '')) throw e
      spDisabledUntil = Date.now() + SP_RETRY_MS
      console.warn('lakebase: service-principal login unavailable, using per-user identity:', e.message)
    }
  }
  // per-user fallback: the OBO token is the Postgres password. Local dev:
  // workspace CLI tokens are NOT accepted by Lakebase, so a dedicated
  // credential (databricks database generate-database-credential) can be
  // supplied via PGPASSWORD without affecting API bearer usage.
  const stablePassword = process.env.PGPASSWORD
  if (stablePassword) {
    // stable password across the process → safe to pool by user
    return await withPool(getUserPool(userEmail, stablePassword), fn)
  }
  // rotating OBO token as password: can't pool safely, so keep the original
  // fresh-client-per-op behavior (always uses a currently-valid token).
  const client = new Client(connInfo(userEmail, userToken))
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

export async function ensureSchema(userEmail, userToken) {
  await withClient(userEmail, userToken, async (c) => {
    // cheap probe of the NEWEST schema artifacts: when they exist the whole
    // DDL body can be skipped. This matters beyond speed — tables belong to
    // whoever created them, and ALTER TABLE from any other identity fails
    // with 42501, which used to 500 the app when a non-owner booted first.
    const schemaCurrent = async () => {
      try {
        await c.query(`SELECT scope FROM deck_templates LIMIT 0`)
        await c.query(`SELECT principal FROM app_admins LIMIT 0`)
        await c.query(`SELECT template_id FROM user_template_selection LIMIT 0`)
        await c.query(`SELECT id FROM chat_spreadsheets LIMIT 0`)
        await c.query(`SELECT endpoint_id FROM model_catalog_overrides LIMIT 0`)
        await c.query(`SELECT connection_name FROM user_mcp_connections LIMIT 0`)
        await c.query(`SELECT triggers FROM skills LIMIT 0`)
        return true
      } catch {
        return false
      }
    }
    if (await schemaCurrent()) return
    try {
      await runSchemaDdl(c)
    } catch (e) {
      if (e.code === '42501' && (await schemaCurrent())) {
        console.warn('ensureSchema: sem privilégio para DDL, mas o schema já está atual — seguindo:', e.message)
        return
      }
      throw e
    }
  })
}

async function runSchemaDdl(c) {
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        system_prompt TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments TEXT,
        model TEXT,
        prompt_tokens INT,
        completion_tokens INT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    // forward-compat for older deployments of this table
    await c.query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS system_prompt TEXT;`)
    await c.query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`)
    await c.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS prompt_tokens INT;`)
    await c.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS completion_tokens INT;`)
    await c.query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS embedding DOUBLE PRECISION[];`)
    await c.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS blocks JSONB;`)
    // regeneration versioning: all variants of one assistant turn share
    // `variant_group` (the id of the first/original row in that slot); only
    // one is `active` at a time — that's the one shown in the main thread,
    // replayed to the model, and what a new regeneration branches from.
    await c.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS variant_group BIGINT;`)
    await c.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;`)
    await c.query(`UPDATE chat_messages SET variant_group = id WHERE variant_group IS NULL;`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_variant_group ON chat_messages(variant_group);`)
    // tools embedded in the session: the built-in Python UC function is
    // implicit and never stored here — only the *additional* Unity Catalog
    // Functions the user attached, so reopening a session re-enables them
    // without any reconfiguration.
    await c.query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS enabled_tools JSONB DEFAULT '[]'::jsonb;`)
    // chart candidates accumulate across the whole session (not just one
    // turn): a report compiled several messages after the Genie calls that
    // actually fetched the numbers still needs those candidates to resolve
    // its prism-block fences. `nextId` is a monotonic counter so ids stay
    // unique even after `items` gets trimmed (see saveSessionChartCandidates).
    await c.query(
      `ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS chart_candidates JSONB DEFAULT '{"nextId":1,"items":[]}'::jsonb;`
    )
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_tool_calls (
        id BIGSERIAL PRIMARY KEY,
        message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
        seq INT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_label TEXT,
        arguments JSONB,
        result TEXT,
        status TEXT NOT NULL,
        duration_ms INT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    // the model/gateway's own tool_call id — lets stored message content
    // reference a specific call inline (see {{toolcall:ID}} in blocks.js)
    // instead of always rendering every tool call before the answer text
    await c.query(`ALTER TABLE chat_tool_calls ADD COLUMN IF NOT EXISTS call_id TEXT;`)
    // remembers which Genie conversation a session is using for a given space,
    // so follow-up questions within the same chat keep Genie's own context
    // instead of starting a fresh conversation (and losing it) every turn
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_genie_conversations (
        session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        space_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (session_id, space_id)
      );`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_email, updated_at DESC);`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_chat_tool_calls_message ON chat_tool_calls(message_id, seq);`)
    // style templates ("design systems") used to steer generated decks toward
    // the user's own branding instead of generic defaults — a user can keep
    // several (e.g. one per audience/brand) with exactly one selected at a time
    await c.query(`
      CREATE TABLE IF NOT EXISTS deck_templates (
        user_email TEXT PRIMARY KEY,
        name TEXT,
        primary_color TEXT,
        secondary_color TEXT,
        accent_color TEXT,
        heading_font TEXT,
        body_font TEXT,
        logo_data_url TEXT,
        style_notes TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    // migrates the original "1 row per user" shape above to "N rows per user,
    // one selected" — ADD COLUMN/DROP CONSTRAINT IF EXISTS keep this idempotent
    // across restarts (Postgres always names a table's primary key constraint
    // `<table>_pkey`, so dropping-then-re-adding it every boot is a no-op once
    // already applied)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS id BIGSERIAL;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS is_selected BOOLEAN NOT NULL DEFAULT false;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS background_color TEXT;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`)
    // real icon/image assets mined from an imported .pptx (never emoji — see
    // server/blocks.js iconRef) + a lightweight per-slide summary used only by
    // the Design System inspector (client/src/components/DeckTemplateInspector.jsx)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS icon_assets JSONB NOT NULL DEFAULT '[]'::jsonb;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS preview_slides JSONB NOT NULL DEFAULT '[]'::jsonb;`)
    // full-bleed cover background photo mined from the imported .pptx —
    // carries the template's own visual identity into generated covers
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS cover_plate_data_url TEXT;`)
    // deeper mined identity: cover overlay layer, section plate, vector motif
    // spec, title ink/typography (see extractPptxTheme in the client)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS mined_style JSONB;`)
    // design-system BUNDLE fields (Claude Design folder/zip exports — see
    // client/src/lib/dsImport.js): declared identity beyond what a .pptx
    // carries. readme = full text (viewer); brand_rules = condensed cut for
    // the model prompt; palette = named color tokens; font_assets =
    // self-hosted webfonts (preview/present-mode only — pptx references
    // fonts by name); ds_cards = self-contained HTML specimen cards.
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS logo_light_data_url TEXT;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS readme TEXT;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS brand_rules TEXT;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS palette JSONB NOT NULL DEFAULT '[]'::jsonb;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS font_assets JSONB NOT NULL DEFAULT '[]'::jsonb;`)
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS ds_cards JSONB NOT NULL DEFAULT '[]'::jsonb;`)
    // one-time migration of the primary key from the original `user_email`
    // shape to `id`. Guarded so it only fires on the OLD shape: once the PK is
    // on `id`, a bare DROP CONSTRAINT fails on any DB where a dependent FK
    // (user_template_selection_template_id_fkey) already references it.
    await c.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'deck_templates'::regclass AND i.indisprimary AND a.attname = 'user_email'
        ) THEN
          ALTER TABLE deck_templates DROP CONSTRAINT IF EXISTS deck_templates_pkey;
          ALTER TABLE deck_templates ADD PRIMARY KEY (id);
        END IF;
      END $$;`)
    await c.query(`
      UPDATE deck_templates SET is_selected = true
      WHERE user_email IN (
        SELECT user_email FROM deck_templates GROUP BY user_email HAVING NOT bool_or(is_selected)
      );`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_deck_templates_user ON deck_templates(user_email);`)
    // decks the model draws as a structured `deck` prism-block (see blocks.js)
    // — stored separately from chat_messages.blocks so the Deck Studio can
    // edit/export them without touching the message's own persisted content
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_decks (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        user_email TEXT NOT NULL,
        title TEXT NOT NULL,
        slides JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_chat_decks_session ON chat_decks(session_id);`)
    // deck-level metadata (audience/author/narrative — see sanitizeDeck in
    // blocks.js) that travels with the slides through Studio edits and export
    await c.query(`ALTER TABLE chat_decks ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'::jsonb;`)

    // spreadsheets the model draws as a structured `spreadsheet` prism-block
    // (see sanitizeSpreadsheet in blocks.js) — the tabular sibling of chat_decks,
    // stored separately from the message so a workbook can be reloaded/exported
    // (server/xlsx-export.js) independent of the chat message's own content.
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_spreadsheets (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        user_email TEXT NOT NULL,
        title TEXT NOT NULL,
        spec JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_chat_spreadsheets_session ON chat_spreadsheets(session_id);`)

    // ---- multi-user administration ----------------------------------------
    // extra app admins beyond the owner (APP_OWNER_EMAIL): user emails or
    // workspace group display names (resolved via SCIM /Me — see authz.js)
    await c.query(`
      CREATE TABLE IF NOT EXISTS app_admins (
        principal TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'user',
        added_by TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    // 'user' rows stay private; 'global' rows (published by an admin) are
    // visible to everyone, editable only by admins. user_email keeps holding
    // the publishing admin for audit.
    await c.query(`ALTER TABLE deck_templates ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';`)
    await c.query(`CREATE INDEX IF NOT EXISTS idx_deck_templates_global ON deck_templates(scope) WHERE scope = 'global';`)
    // per-user selection of a (possibly shared/global) template — the per-row
    // is_selected flag can't express two users selecting the same global row.
    // The old column stays for back-compat but is no longer read or written.
    await c.query(`
      CREATE TABLE IF NOT EXISTS user_template_selection (
        user_email TEXT PRIMARY KEY,
        template_id BIGINT NOT NULL REFERENCES deck_templates(id) ON DELETE CASCADE,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    await c.query(`
      INSERT INTO user_template_selection (user_email, template_id)
        SELECT user_email, id FROM deck_templates WHERE is_selected
      ON CONFLICT (user_email) DO NOTHING;`)
    // ---- admin-curated model catalog -------------------------------------
    // one row per AI Gateway serving endpoint an admin has touched: whether
    // it's enabled for the org, plus the display name/blurb users will see in
    // the model picker. Endpoints with no row fall back to the derived/curated
    // defaults; GET /api/models surfaces only enabled ones (with a safe seed
    // so the org is never left with zero models). Global (org-wide), so no
    // user_email — writes are gated to admins at the route layer.
    await c.query(`
      CREATE TABLE IF NOT EXISTS model_catalog_overrides (
        endpoint_id TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT false,
        display_name TEXT,
        blurb TEXT,
        sort_order INT,
        updated_by TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    // ---- per-user adopted external MCP connections -----------------------
    // records that a user has "connected" a UC HTTP MCP connection (chose to
    // use it) plus the last probed auth status. Holds NO credential — the
    // bearer is always the user's forwarded OAuth token; this only remembers
    // intent + status so the tool picker can show adopted connections as
    // on/off toggles (default on) instead of a search-every-time list.
    await c.query(`
      CREATE TABLE IF NOT EXISTS user_mcp_connections (
        user_email TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        comment TEXT,
        status TEXT NOT NULL DEFAULT 'unknown',
        last_checked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_email, connection_name)
      );`)
    // ---- authored skills (progressive-disclosure capabilities) -----------
    // A skill is a named capability whose detailed instructions (`body`) are
    // injected into the system prompt ONLY when a turn is routed to it (see
    // server/skills.js). `scope` = 'global' (admin-authored, whole org) or
    // 'user' (owner_email's own). The system skills (deck/spreadsheet/chart)
    // live in code, not here. `triggers` are optional keywords for the lexical
    // route; `embedding` (of "title — description") powers the semantic route.
    // Isolation is app-level, same as everything else: WHERE scope='global'
    // OR (scope='user' AND owner_email=$user).
    await c.query(`
      CREATE TABLE IF NOT EXISTS skills (
        id BIGSERIAL PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_email TEXT,
        name TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        body TEXT NOT NULL,
        triggers JSONB NOT NULL DEFAULT '[]'::jsonb,
        embedding DOUBLE PRECISION[],
        source TEXT DEFAULT 'write',
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );`)
    // a skill name is unique within its owning scope (global names are org-wide;
    // user names are per-user) — enforced with two partial unique indexes so a
    // user can reuse a name the org also uses
    await c.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_global_name ON skills(name) WHERE scope = 'global';`
    )
    await c.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_user_name ON skills(owner_email, name) WHERE scope = 'user';`
    )
}

// grants: the app service principal gets DML on the app tables — row
// isolation is app-level (user_email WHERE clauses), the same trust model the
// app always applied to the forwarded email header. GRANT ... TO the SP can
// only run as the table owner, and never over the SP connection itself, so
// this deliberately bypasses withClient and connects as the caller. Called on
// every request (see ensureReady) because the SP role may be created long
// after the schema — it must fire even when the DDL is skipped as current.
// Cheap in steady state: latched on success, per-caller cooldown on failure.
const SP_GRANT_RETRY_MS = 5 * 60 * 1000
let spGrantsDone = false
const spGrantAttempts = new Map()

export async function ensureSpGrants(userEmail, userToken) {
  const spRole = process.env.DATABRICKS_CLIENT_ID
  if (spGrantsDone || !spRole || !/^[\w-]+$/.test(spRole)) return
  const last = spGrantAttempts.get(userEmail) || 0
  if (Date.now() - last < SP_GRANT_RETRY_MS) return
  spGrantAttempts.set(userEmail, Date.now())
  const client = new Client(connInfo(userEmail, process.env.PGPASSWORD || userToken))
  try {
    await client.connect()
    const probe = await client.query(`SELECT has_table_privilege($1, 'chat_sessions', 'SELECT') AS ok`, [spRole])
    if (!probe.rows[0]?.ok) {
      await client.query(`GRANT USAGE ON SCHEMA public TO "${spRole}"`)
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${spRole}"`)
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${spRole}"`)
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${spRole}"`
      )
      await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${spRole}"`)
      console.log('ensureSpGrants: privilégios concedidos ao service principal', spRole)
    }
    spGrantsDone = true
    spDisabledUntil = 0 // re-enable the SP path right away
  } catch (e) {
    // non-owners can't grant (and non-owner logins may not even connect):
    // quiet skip, the owner's next request will land it
    console.warn('ensureSpGrants: pulado para', userEmail, '-', e.message)
  } finally {
    await client.end().catch(() => {})
  }
}

export async function getGenieConversationId(userEmail, userToken, sessionId, spaceId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT conversation_id FROM chat_genie_conversations WHERE session_id = $1 AND space_id = $2`,
      [sessionId, spaceId]
    )
    return r.rows[0]?.conversation_id || null
  })
}

export async function setGenieConversationId(userEmail, userToken, sessionId, spaceId, conversationId) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO chat_genie_conversations (session_id, space_id, conversation_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id, space_id) DO UPDATE SET conversation_id = $3, updated_at = NOW()`,
      [sessionId, spaceId, conversationId]
    )
  })
}

const MAX_STORED_CHART_CANDIDATES = 40

export async function getSessionChartCandidates(userEmail, userToken, sessionId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT chart_candidates FROM chat_sessions WHERE id = $1 AND user_email = $2`, [
      sessionId,
      userEmail,
    ])
    const state = r.rows[0]?.chart_candidates
    return { nextId: state?.nextId || 1, items: Array.isArray(state?.items) ? state.items : [] }
  })
}

export async function saveSessionChartCandidates(userEmail, userToken, sessionId, state) {
  const trimmed = {
    nextId: state.nextId,
    items: state.items.slice(-MAX_STORED_CHART_CANDIDATES),
  }
  await withClient(userEmail, userToken, async (c) => {
    await c.query(`UPDATE chat_sessions SET chart_candidates = $1 WHERE id = $2 AND user_email = $3`, [
      JSON.stringify(trimmed),
      sessionId,
      userEmail,
    ])
  })
}

export async function createSession(userEmail, userToken, title, model, systemPrompt, enabledTools = []) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `INSERT INTO chat_sessions (user_email, title, model, system_prompt, enabled_tools)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userEmail, title, model, systemPrompt || null, JSON.stringify(enabledTools || [])]
    )
    return r.rows[0].id
  })
}

const MAX_ATTACHMENT_NAMES_PER_SESSION = 6

export async function listSessions(userEmail, userToken, limit = 100) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT s.id, s.title, s.model, s.system_prompt, s.enabled_tools, s.created_at, s.updated_at,
              COALESCE(att.names, ARRAY[]::text[]) AS attachment_names
       FROM chat_sessions s
       LEFT JOIN LATERAL (
         SELECT array_agg(DISTINCT elem) AS names
         FROM chat_messages m
         CROSS JOIN LATERAL jsonb_array_elements_text(m.attachments::jsonb) AS elem
         WHERE m.session_id = s.id AND m.attachments IS NOT NULL
       ) att ON true
       WHERE s.user_email = $1
       ORDER BY s.updated_at DESC LIMIT $2`,
      [userEmail, limit]
    )
    return r.rows.map((x) => ({
      id: String(x.id),
      title: x.title,
      model: x.model,
      system_prompt: x.system_prompt,
      enabled_tools: x.enabled_tools || [],
      created_at: x.created_at,
      updated_at: x.updated_at,
      attachment_names: (x.attachment_names || []).slice(0, MAX_ATTACHMENT_NAMES_PER_SESSION),
    }))
  })
}

export async function getSession(userEmail, userToken, sessionId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT id, title, model, system_prompt, enabled_tools FROM chat_sessions
       WHERE id = $1 AND user_email = $2`,
      [sessionId, userEmail]
    )
    if (!r.rows.length) return null
    const x = r.rows[0]
    return {
      id: String(x.id),
      title: x.title,
      model: x.model,
      system_prompt: x.system_prompt,
      enabled_tools: x.enabled_tools || [],
    }
  })
}

export async function updateSession(userEmail, userToken, sessionId, fields) {
  const sets = []
  const vals = []
  let i = 1
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${i++}`)
    vals.push(k === 'enabled_tools' ? JSON.stringify(v || []) : v)
  }
  if (!sets.length) return
  sets.push(`updated_at = NOW()`)
  vals.push(sessionId, userEmail)
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `UPDATE chat_sessions SET ${sets.join(', ')} WHERE id = $${i++} AND user_email = $${i}`,
      vals
    )
  })
}

export async function touchSession(userEmail, userToken, sessionId) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(`UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1 AND user_email = $2`, [
      sessionId,
      userEmail,
    ])
  })
}

export async function deleteSession(userEmail, userToken, sessionId) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(`DELETE FROM chat_sessions WHERE id = $1 AND user_email = $2`, [
      sessionId,
      userEmail,
    ])
  })
}

export async function setSessionEmbedding(userEmail, userToken, sessionId, vec) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `UPDATE chat_sessions SET embedding = $1 WHERE id = $2 AND user_email = $3`,
      [vec, sessionId, userEmail]
    )
  })
}

// Returns every session with its stored embedding and a concatenated text doc
// (title + message contents) used to (re)build embeddings for semantic search.
export async function listSessionsForSearch(userEmail, userToken) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT s.id, s.title, s.embedding,
              COALESCE(string_agg(m.content, ' ' ORDER BY m.id) FILTER (WHERE m.role = 'user'), s.title) AS doc
       FROM chat_sessions s
       LEFT JOIN chat_messages m ON m.session_id = s.id
       WHERE s.user_email = $1
       GROUP BY s.id, s.title, s.embedding, s.updated_at
       ORDER BY s.updated_at DESC`,
      [userEmail]
    )
    return r.rows.map((x) => ({
      id: String(x.id),
      title: x.title,
      embedding: x.embedding,
      doc: x.doc || x.title,
    }))
  })
}

/**
 * Inserts a message. Pass `variantGroup` (the original message's id) to add a
 * regenerated variant to an existing slot — the new row becomes the active
 * one and every sibling in that group is deactivated. Omit it for a normal
 * new message, which becomes its own single-variant group.
 */
export async function addMessage(userEmail, userToken, msg) {
  return withClient(userEmail, userToken, async (c) => {
    // chat_messages has no user_email of its own — ownership is inherited from
    // the parent session. Since every user shares one Postgres identity (the
    // app SP), the ONLY isolation is this app-level check: the INSERT ... SELECT
    // materializes a row only when the target session belongs to the caller, so
    // a client can never inject a message into someone else's thread by passing
    // a guessed (enumerable BIGSERIAL) session id.
    const r = await c.query(
      `INSERT INTO chat_messages (session_id, role, content, attachments, model, prompt_tokens, completion_tokens, blocks, variant_group)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
       WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $1 AND user_email = $10)
       RETURNING id, created_at`,
      [
        msg.sessionId,
        msg.role,
        msg.content,
        msg.attachments || null,
        msg.model || null,
        msg.promptTokens ?? null,
        msg.completionTokens ?? null,
        msg.blocks ? JSON.stringify(msg.blocks) : null,
        msg.variantGroup ?? null,
        userEmail,
      ]
    )
    if (!r.rows.length) throw Object.assign(new Error('sessão não encontrada'), { status: 404 })
    const id = r.rows[0].id
    if (msg.variantGroup == null) {
      await c.query(`UPDATE chat_messages SET variant_group = $1 WHERE id = $1`, [id])
    } else {
      await c.query(`UPDATE chat_messages SET active = (id = $1) WHERE variant_group = $2`, [id, msg.variantGroup])
    }
    return { id: String(id), created_at: r.rows[0].created_at }
  })
}

// Raw row lookup for a single message — used by the edit endpoint to verify
// role/ownership and to carry over the variant_group + attachment tail.
export async function getMessageRaw(userEmail, userToken, messageId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT m.session_id, m.role, m.content, m.attachments, m.variant_group FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $2
       WHERE m.id = $1`,
      [messageId, userEmail]
    )
    if (!r.rows.length) return null
    const x = r.rows[0]
    return {
      sessionId: String(x.session_id),
      role: x.role,
      content: x.content,
      attachments: x.attachments,
      variantGroup: String(x.variant_group),
    }
  })
}

// Returns the parsed blocks array stored on a message (or null).
export async function getMessageBlocks(userEmail, userToken, messageId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT m.blocks FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $2
       WHERE m.id = $1`,
      [messageId, userEmail]
    )
    return r.rows.length ? r.rows[0].blocks || null : null
  })
}

// Persists answers into a `deck-questions` block stored on a message's blocks
// JSONB. Answers are stamped onto the first deck-questions block found (there's
// only ever one per message). Returns the updated blocks array, or null if the
// message has no such block. `answersMap` is already sanitized by the caller.
export async function setDeckQuestionsAnswers(userEmail, userToken, messageId, answersMap, answeredAt) {
  return withClient(userEmail, userToken, async (c) => {
    // only read/write a message whose session belongs to the caller
    const r = await c.query(
      `SELECT m.blocks FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $2
       WHERE m.id = $1`,
      [messageId, userEmail]
    )
    if (!r.rows.length || !r.rows[0].blocks) return null
    const blocks = r.rows[0].blocks
    let touched = false
    for (const b of blocks) {
      if (b && b.type === 'deck-questions') {
        b.answers = answersMap
        b.answeredAt = answeredAt
        touched = true
        break
      }
    }
    if (!touched) return null
    // the WHERE still re-checks ownership so a concurrent session move can't slip
    // the write onto another user's row between the SELECT and the UPDATE
    await c.query(
      `UPDATE chat_messages m SET blocks = $2
       FROM chat_sessions s
       WHERE m.id = $1 AND s.id = m.session_id AND s.user_email = $3`,
      [messageId, JSON.stringify(blocks), userEmail]
    )
    return blocks
  })
}

// Marks one specific variant as the active one for its slot — used when the
// user navigates the version carousel to a message other than the latest.
export async function activateVariant(userEmail, userToken, messageId) {
  await withClient(userEmail, userToken, async (c) => {
    // resolve the variant group only for a message in the caller's own session,
    // so the subsequent UPDATE can't flip the active variant in someone else's
    // thread by targeting a guessed message id
    const r = await c.query(
      `SELECT m.variant_group FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $2
       WHERE m.id = $1`,
      [messageId, userEmail]
    )
    if (!r.rows.length) return
    await c.query(`UPDATE chat_messages SET active = (id = $1) WHERE variant_group = $2`, [
      messageId,
      r.rows[0].variant_group,
    ])
  })
}

// Shared by listMessages (full thread) and listMessagesBeforeMessage (history
// for a regeneration): fetches every row, attaches tool-call traces, then
// keeps only the active variant per slot — optionally cut off before a given
// slot — ordered by slot position rather than row id (see note below).
async function fetchActiveMessages(c, sessionId, userEmail, { beforeVariantGroup } = {}) {
  // ownership is enforced by joining chat_messages back to its parent session:
  // rows surface only when the session belongs to userEmail. Without this an
  // authenticated user could read another user's thread (messages + tool
  // traces) by passing a guessed session id — chat_messages carries no
  // user_email column of its own, and every user shares one PG identity.
  const r = await c.query(
    `SELECT m.id, m.role, m.content, m.attachments, m.model, m.prompt_tokens, m.completion_tokens, m.blocks, m.variant_group, m.active, m.created_at
     FROM chat_messages m
     JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $2
     WHERE m.session_id = $1 ORDER BY m.id ASC`,
    [sessionId, userEmail]
  )
  const ids = r.rows.map((x) => x.id)
  const toolsByMessage = new Map()
  if (ids.length) {
    const tr = await c.query(
      `SELECT message_id, call_id, tool_name, tool_label, arguments, result, status, duration_ms
       FROM chat_tool_calls WHERE message_id = ANY($1) ORDER BY message_id, seq ASC`,
      [ids]
    )
    for (const t of tr.rows) {
      const list = toolsByMessage.get(t.message_id) || []
      list.push({
        id: t.call_id,
        name: t.tool_name,
        label: t.tool_label,
        args: t.arguments,
        result: t.result,
        status: t.status,
        durationMs: t.duration_ms,
      })
      toolsByMessage.set(t.message_id, list)
    }
  }

  const toShape = (x) => ({
    id: String(x.id),
    role: x.role,
    content: x.content,
    attachments: x.attachments,
    model: x.model,
    prompt_tokens: x.prompt_tokens,
    completion_tokens: x.completion_tokens,
    blocks: x.blocks || null,
    tool_calls: toolsByMessage.get(x.id) || null,
    created_at: x.created_at,
  })

  // group every row (active or not) by slot, so each active row can carry
  // its sibling variants for the frontend's version carousel
  const groups = new Map()
  for (const x of r.rows) {
    const g = x.variant_group ?? x.id
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(x)
  }

  // active rows are ordered by their *slot* (variant_group), not by their own
  // id — a regenerated row's id is always the newest in the table, but it
  // must still render at the original position in the conversation
  let activeRows = r.rows.filter((x) => x.active)
  if (beforeVariantGroup != null) {
    activeRows = activeRows.filter((x) => Number(x.variant_group ?? x.id) < Number(beforeVariantGroup))
  }
  activeRows.sort((a, b) => Number(a.variant_group ?? a.id) - Number(b.variant_group ?? b.id))

  return activeRows.map((x) => {
    const shaped = toShape(x)
    const siblings = groups.get(x.variant_group ?? x.id)
    if (siblings && siblings.length > 1) shaped.variants = siblings.map(toShape)
    return shaped
  })
}

export async function listMessages(userEmail, userToken, sessionId) {
  return withClient(userEmail, userToken, (c) => fetchActiveMessages(c, sessionId, userEmail))
}

// Conversation history strictly before the slot `messageId` belongs to — what
// the model should see when regenerating that slot. Returns the resolved
// `variantGroup` too, since addMessage needs it to file the new variant into
// the same slot.
export async function listMessagesBeforeMessage(userEmail, userToken, sessionId, messageId) {
  return withClient(userEmail, userToken, async (c) => {
    // scope the slot lookup to a session the caller owns (join to chat_sessions)
    // so a regenerate can't be aimed at someone else's message id
    const g = await c.query(
      `SELECT m.variant_group FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id AND s.user_email = $3
       WHERE m.id = $1 AND m.session_id = $2`,
      [messageId, sessionId, userEmail]
    )
    if (!g.rows.length) return { variantGroup: null, messages: [] }
    const variantGroup = g.rows[0].variant_group
    const messages = await fetchActiveMessages(c, sessionId, userEmail, { beforeVariantGroup: variantGroup })
    return { variantGroup: String(variantGroup), messages }
  })
}

// Persists the ordered trace of tool calls made while producing one assistant
// message — purely for display/audit on reload; the model itself never
// replays this (its own past tool mechanics are irrelevant context, same
// rationale as stripping {{block:N}} placeholders from history).
export async function addToolCalls(userEmail, userToken, messageId, trace) {
  if (!trace?.length) return
  await withClient(userEmail, userToken, async (c) => {
    let seq = 0
    for (const t of trace) {
      await c.query(
        `INSERT INTO chat_tool_calls (message_id, seq, call_id, tool_name, tool_label, arguments, result, status, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          messageId,
          seq++,
          t.id || null,
          t.name,
          t.label || null,
          JSON.stringify(t.args ?? {}),
          t.result != null ? String(t.result).slice(0, 8000) : null,
          t.status,
          t.durationMs ?? null,
        ]
      )
    }
  })
}

// Seeded the first time a user opens their (until-then-empty) template
// collection — pulled straight from the Databricks brand system (Navy/Lava/
// Coral/Oat, DM Sans) so Settings never starts as a blank slate and doubles
// as a concrete "design system" example.
const DATABRICKS_PRESET = {
  name: 'Databricks Corporate',
  primaryColor: '#1B3139',
  secondaryColor: '#FF5F46',
  accentColor: '#FF3621',
  backgroundColor: '#F9F7F4',
  headingFont: 'DM Sans',
  bodyFont: 'DM Sans',
  styleNotes:
    'Tom confiante e direto, como um colega experiente, não um vendedor. Frases curtas, sentence case (nunca Title Case), sem emojis. Fundos quentes (oat), acentos em coral/lava — nunca gradientes azul/roxo de SaaS genérico.',
}

function rowToTemplate(x) {
  return {
    id: String(x.id),
    scope: x.scope === 'global' ? 'global' : 'user',
    name: x.name || '',
    primaryColor: x.primary_color || '',
    secondaryColor: x.secondary_color || '',
    accentColor: x.accent_color || '',
    backgroundColor: x.background_color || '',
    headingFont: x.heading_font || '',
    bodyFont: x.body_font || '',
    logoDataUrl: x.logo_data_url || '',
    styleNotes: x.style_notes || '',
    iconAssets: x.icon_assets || [],
    previewSlides: x.preview_slides || [],
    coverPlateDataUrl: x.cover_plate_data_url || '',
    minedStyle: x.mined_style || null,
    logoLightDataUrl: x.logo_light_data_url || '',
    readme: x.readme || '',
    brandRules: x.brand_rules || '',
    palette: x.palette || [],
    fontAssets: x.font_assets || [],
    dsCards: x.ds_cards || [],
    // lightweight specimen metadata (group/title/description) for the
    // generation composition brief — present on list/render-cut rows that
    // don't ship the full ds_cards HTML
    ...(x.ds_cards_meta !== undefined ? { dsCardsMeta: x.ds_cards_meta || [] } : {}),
    // list rows carry has-flags instead of the payloads (TEMPLATE_LIST_SELECT)
    ...(x.has_ds_cards !== undefined ? { hasDsCards: !!x.has_ds_cards, hasReadme: !!x.has_readme } : {}),
    // selection lives in user_template_selection (selected_by_user computed
    // via LEFT JOIN); rows fetched without the join fall back to the legacy flag
    isSelected: x.selected_by_user !== undefined ? !!x.selected_by_user : !!x.is_selected,
  }
}

// visibility + per-user selection in one shot: the caller sees their own rows
// plus every global row, with isSelected computed from their selection row
const TEMPLATE_SELECT = `
  SELECT t.*, (s.template_id IS NOT NULL) AS selected_by_user
  FROM deck_templates t
  LEFT JOIN user_template_selection s ON s.user_email = $1 AND s.template_id = t.id`

// list path: same visibility join, but the viewer-only payloads (ds_cards
// specimen HTML, readme) never leave the database — a mined design system
// carries MBs of them per row, and the list is fetched on every Studio and
// Settings open. Shipped as has-flags so the grid can still advertise them.
// renderAssets additionally cuts icon_assets in SQL to the kinds the painters
// resolve (icon/image slide refs, illustration theme art) — the backgrounds/
// lockups of a mined bundle are Settings-grid-only and dominate the row size.
const RENDER_ASSET_KINDS_SQL = `
  (SELECT COALESCE(jsonb_agg(e.a ORDER BY e.ord), '[]'::jsonb)
     FROM jsonb_array_elements(t.icon_assets) WITH ORDINALITY AS e(a, ord)
    WHERE (e.a->>'kind') IS NULL OR (e.a->>'kind') IN ('icon', 'image', 'illustration'))`
const templateListSelect = (renderAssets) => `
  SELECT t.id, t.user_email, t.scope, t.name, t.primary_color, t.secondary_color,
         t.accent_color, t.background_color, t.heading_font, t.body_font,
         t.logo_data_url, t.style_notes,
         ${renderAssets ? RENDER_ASSET_KINDS_SQL : 't.icon_assets'} AS icon_assets,
         t.preview_slides,
         t.cover_plate_data_url, t.mined_style, t.logo_light_data_url,
         t.brand_rules, t.palette, t.font_assets, t.is_selected, t.created_at,
         (COALESCE(jsonb_array_length(t.ds_cards), 0) > 0) AS has_ds_cards,
         -- lightweight metadata of the bundle's component/slide specimens
         -- (group/title/description only — the heavy self-contained HTML is
         -- stripped). Feeds the deck generator's composition brief so it can
         -- learn THIS design system's own slide vocabulary; cheap enough to
         -- always ship (KBs, not the MBs of inlined HTML).
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'group', c->>'group', 'title', c->>'title', 'description', c->>'description')), '[]'::jsonb)
            FROM jsonb_array_elements(t.ds_cards) AS c) AS ds_cards_meta,
         (COALESCE(length(t.readme), 0) > 0) AS has_readme,
         (s.template_id IS NOT NULL) AS selected_by_user
  FROM deck_templates t
  LEFT JOIN user_template_selection s ON s.user_email = $1 AND s.template_id = t.id`

// The heavy bundle payloads only matter to specific consumers (viewer,
// preview font loading) — list endpoints strip them so the Settings grid
// isn't shipping tens of MB of fonts/cards per template row.
export function templateSummary(t) {
  const { dsCards, fontAssets, readme, ...rest } = t
  return {
    ...rest,
    // list rows never fetched the payloads — trust their precomputed flags
    hasDsCards: rest.hasDsCards ?? !!dsCards?.length,
    hasReadme: rest.hasReadme ?? !!readme,
    fontAssets, // fonts stay: DeckSlidePreview loads them for brand-true previews
  }
}

export async function listDeckTemplates(userEmail, userToken, { renderAssets = false } = {}) {
  return withClient(userEmail, userToken, async (c) => {
    const list = `${templateListSelect(renderAssets)}
      WHERE t.user_email = $1 OR t.scope = 'global'
      ORDER BY (t.scope = 'global') DESC, t.created_at ASC, t.id ASC`
    let r = await c.query(list, [userEmail])
    // seed the Databricks preset only for a user with no personal templates
    // AND no org-wide (global) template to fall back on — once an admin
    // publishes a global design system, new users start from that instead
    if (!r.rows.length) {
      const ins = await c.query(
        `INSERT INTO deck_templates
           (user_email, name, primary_color, secondary_color, accent_color, background_color, heading_font, body_font, style_notes, is_selected)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true) RETURNING id`,
        [
          userEmail,
          DATABRICKS_PRESET.name,
          DATABRICKS_PRESET.primaryColor,
          DATABRICKS_PRESET.secondaryColor,
          DATABRICKS_PRESET.accentColor,
          DATABRICKS_PRESET.backgroundColor,
          DATABRICKS_PRESET.headingFont,
          DATABRICKS_PRESET.bodyFont,
          DATABRICKS_PRESET.styleNotes,
        ]
      )
      await c.query(
        `INSERT INTO user_template_selection (user_email, template_id) VALUES ($1, $2)
         ON CONFLICT (user_email) DO NOTHING`,
        [userEmail, ins.rows[0].id]
      )
      r = await c.query(list, [userEmail])
    }
    const rows = r.rows.map(rowToTemplate)
    // no selection row (fresh user with globals only, or their selection
    // cascaded away with a deleted template) → first visible acts as selected
    if (rows.length && !rows.some((t) => t.isSelected)) rows[0] = { ...rows[0], isSelected: true }
    return rows
  })
}

// Every consumer of the *selected* template (generation prompt, PPTX export,
// the /selected render endpoint) only resolves icon/image/illustration assets,
// so this always takes the render cut — the full asset library stays behind
// the list/detail endpoints for the Settings grid.
// The selected template is read on the hot path of EVERY chat turn, but its
// heavy render-cut payload (preview_slides/palette/font_assets/mined_style/
// cover plate — can be MBs of jsonb) changes only when the user edits/selects/
// deletes a template. So memoize it per user with a short TTL and invalidate
// explicitly on writes. TTL is a backstop for cross-process edits (this app can
// run multiple replicas); the explicit bump covers same-process edits instantly.
const SELECTED_TEMPLATE_TTL_MS = 60 * 1000
const selectedTemplateCache = new Map() // email -> { ts, template }

// Bumped by every template write (create/update/select/delete/scope) so the
// next hot-path read re-fetches instead of serving a stale bundle.
export function invalidateSelectedTemplate(userEmail) {
  if (userEmail) selectedTemplateCache.delete(userEmail)
  else selectedTemplateCache.clear()
}

export async function getSelectedDeckTemplate(userEmail, userToken) {
  const hit = selectedTemplateCache.get(userEmail)
  if (hit && Date.now() - hit.ts < SELECTED_TEMPLATE_TTL_MS) return hit.template
  const templates = await listDeckTemplates(userEmail, userToken, { renderAssets: true })
  const template = templates.find((t) => t.isSelected) || templates[0] || null
  selectedTemplateCache.set(userEmail, { ts: Date.now(), template })
  return template
}

export async function createDeckTemplate(userEmail, userToken, tpl) {
  invalidateSelectedTemplate()
  return withClient(userEmail, userToken, async (c) => {
    const existing = await c.query(`SELECT COUNT(*)::int AS n FROM deck_templates WHERE user_email = $1`, [
      userEmail,
    ])
    const isFirst = existing.rows[0].n === 0 // first PERSONAL template
    const r = await c.query(
      `INSERT INTO deck_templates
         (user_email, name, primary_color, secondary_color, accent_color, background_color, heading_font, body_font, logo_data_url, style_notes, icon_assets, preview_slides, cover_plate_data_url, mined_style, logo_light_data_url, readme, brand_rules, palette, font_assets, ds_cards, is_selected)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING *`,
      [
        userEmail,
        tpl.name || null,
        tpl.primaryColor || null,
        tpl.secondaryColor || null,
        tpl.accentColor || null,
        tpl.backgroundColor || null,
        tpl.headingFont || null,
        tpl.bodyFont || null,
        tpl.logoDataUrl || null,
        tpl.styleNotes || null,
        JSON.stringify(tpl.iconAssets || []),
        JSON.stringify(tpl.previewSlides || []),
        tpl.coverPlateDataUrl || null,
        tpl.minedStyle ? JSON.stringify(tpl.minedStyle) : null,
        tpl.logoLightDataUrl || null,
        tpl.readme || null,
        tpl.brandRules || null,
        JSON.stringify(tpl.palette || []),
        JSON.stringify(tpl.fontAssets || []),
        JSON.stringify(tpl.dsCards || []),
        isFirst,
      ]
    )
    // becomes the selection only when the user hasn't selected anything yet
    // (e.g. they may already be using a global template)
    const sel = await c.query(
      `INSERT INTO user_template_selection (user_email, template_id) VALUES ($1, $2)
       ON CONFLICT (user_email) DO NOTHING RETURNING template_id`,
      [userEmail, r.rows[0].id]
    )
    return rowToTemplate({ ...r.rows[0], selected_by_user: sel.rows.length > 0 })
  })
}

// Bundle-heavy columns (readme/palette/font_assets/ds_cards/logo_light) are
// only rewritten when the caller actually sends them — the Settings form
// edits identity fields off a SUMMARY row (see templateSummary) and must not
// blank out payloads it never loaded.
export async function updateDeckTemplate(userEmail, userToken, id, tpl, isAdmin = false) {
  // a global edit affects every user's hot-path read, so clear the whole cache
  invalidateSelectedTemplate()
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `UPDATE deck_templates SET
         name = $1, primary_color = $2, secondary_color = $3, accent_color = $4, background_color = $5,
         heading_font = $6, body_font = $7, logo_data_url = $8, style_notes = $9,
         icon_assets = $10, preview_slides = $11, cover_plate_data_url = $12, mined_style = $13,
         logo_light_data_url = COALESCE($14, logo_light_data_url),
         readme = COALESCE($15, readme),
         brand_rules = COALESCE($16, brand_rules),
         palette = COALESCE($17, palette),
         font_assets = COALESCE($18, font_assets),
         ds_cards = COALESCE($19, ds_cards),
         updated_at = NOW()
       WHERE id = $20 AND (user_email = $21 OR (scope = 'global' AND $22)) RETURNING id`,
      [
        tpl.name || null,
        tpl.primaryColor || null,
        tpl.secondaryColor || null,
        tpl.accentColor || null,
        tpl.backgroundColor || null,
        tpl.headingFont || null,
        tpl.bodyFont || null,
        tpl.logoDataUrl || null,
        tpl.styleNotes || null,
        JSON.stringify(tpl.iconAssets || []),
        JSON.stringify(tpl.previewSlides || []),
        tpl.coverPlateDataUrl || null,
        tpl.minedStyle ? JSON.stringify(tpl.minedStyle) : null,
        tpl.logoLightDataUrl !== undefined ? tpl.logoLightDataUrl || '' : null,
        tpl.readme !== undefined ? tpl.readme || '' : null,
        tpl.brandRules !== undefined ? tpl.brandRules || '' : null,
        tpl.palette !== undefined ? JSON.stringify(tpl.palette || []) : null,
        tpl.fontAssets !== undefined ? JSON.stringify(tpl.fontAssets || []) : null,
        tpl.dsCards !== undefined ? JSON.stringify(tpl.dsCards || []) : null,
        id,
        userEmail,
        isAdmin,
      ]
    )
    return r.rows.length > 0
  })
}

export async function getDeckTemplate(userEmail, userToken, id) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `${TEMPLATE_SELECT} WHERE t.id = $2 AND (t.user_email = $1 OR t.scope = 'global')`,
      [userEmail, id]
    )
    return r.rows.length ? rowToTemplate(r.rows[0]) : null
  })
}

export async function selectDeckTemplate(userEmail, userToken, id) {
  invalidateSelectedTemplate(userEmail)
  return withClient(userEmail, userToken, async (c) => {
    const visible = await c.query(
      `SELECT 1 FROM deck_templates WHERE id = $1 AND (user_email = $2 OR scope = 'global')`,
      [id, userEmail]
    )
    if (!visible.rows.length) return false
    await c.query(
      `INSERT INTO user_template_selection (user_email, template_id) VALUES ($1, $2)
       ON CONFLICT (user_email) DO UPDATE SET template_id = EXCLUDED.template_id, updated_at = NOW()`,
      [userEmail, id]
    )
    return true
  })
}

// admins may edit/delete global rows; everyone else only their own — the
// route computes isAdmin (authz.js) and the SQL mirrors it so a route bug
// can never silently cross-write another user's template
export async function deleteDeckTemplate(userEmail, userToken, id, isAdmin = false) {
  invalidateSelectedTemplate()
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `DELETE FROM deck_templates
       WHERE id = $1 AND (user_email = $2 OR (scope = 'global' AND $3)) RETURNING id`,
      [id, userEmail, isAdmin]
    )
    return r.rows.length > 0
  })
}

export async function setDeckTemplateScope(userEmail, userToken, id, scope) {
  invalidateSelectedTemplate()
  return withClient(userEmail, userToken, async (c) => {
    // demoting a global row hands ownership to the acting admin so it doesn't
    // become an orphan visible to nobody
    const r = await c.query(
      `UPDATE deck_templates
       SET scope = $1, user_email = CASE WHEN $1 = 'user' THEN $2 ELSE user_email END, updated_at = NOW()
       WHERE id = $3 AND (user_email = $2 OR scope = 'global') RETURNING id`,
      [scope, userEmail, id]
    )
    return r.rows.length > 0
  })
}

// ---- app admins (authz.js resolves owner/groups on top of these rows) -------

export async function listAppAdmins(userEmail, userToken) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT principal, kind, added_by, created_at FROM app_admins ORDER BY created_at ASC`)
    return r.rows.map((x) => ({
      principal: x.principal,
      kind: x.kind === 'group' ? 'group' : 'user',
      addedBy: x.added_by,
      createdAt: x.created_at,
    }))
  })
}

export async function addAppAdmin(userEmail, userToken, principal, kind) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO app_admins (principal, kind, added_by) VALUES ($1, $2, $3)
       ON CONFLICT (principal) DO UPDATE SET kind = EXCLUDED.kind`,
      [principal, kind, userEmail]
    )
  })
}

export async function removeAppAdmin(userEmail, userToken, principal) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(`DELETE FROM app_admins WHERE principal = $1`, [principal])
  })
}

// ---- admin-curated model catalog overrides ------------------------------
export async function listModelOverrides(userEmail, userToken) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT endpoint_id, enabled, display_name, blurb, sort_order, updated_by, updated_at
         FROM model_catalog_overrides`
    )
    const map = {}
    for (const x of r.rows) {
      map[x.endpoint_id] = {
        endpointId: x.endpoint_id,
        enabled: !!x.enabled,
        displayName: x.display_name || '',
        blurb: x.blurb || '',
        sortOrder: x.sort_order,
        updatedBy: x.updated_by || '',
        updatedAt: x.updated_at,
      }
    }
    return map
  })
}

export async function upsertModelOverride(userEmail, userToken, endpointId, { enabled, displayName, blurb, sortOrder }) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO model_catalog_overrides (endpoint_id, enabled, display_name, blurb, sort_order, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (endpoint_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         display_name = EXCLUDED.display_name,
         blurb = EXCLUDED.blurb,
         sort_order = EXCLUDED.sort_order,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()`,
      [endpointId, !!enabled, displayName || null, blurb || null, sortOrder ?? null, userEmail]
    )
  })
}

// Seed the catalog from the static MODELS list the FIRST time an admin opens
// the models tab and no overrides exist yet — so switching /api/models to
// "enabled only" never leaves the org with zero models. Idempotent: only
// inserts rows that don't exist.
export async function seedModelOverridesIfEmpty(userEmail, userToken, seedRows) {
  return withClient(userEmail, userToken, async (c) => {
    const existing = await c.query(`SELECT COUNT(*)::int AS n FROM model_catalog_overrides`)
    if (existing.rows[0].n > 0) return false
    for (let i = 0; i < seedRows.length; i++) {
      const s = seedRows[i]
      await c.query(
        `INSERT INTO model_catalog_overrides (endpoint_id, enabled, display_name, blurb, sort_order, updated_by)
           VALUES ($1, true, $2, $3, $4, $5)
         ON CONFLICT (endpoint_id) DO NOTHING`,
        [s.id, s.label || null, s.blurb || null, i, userEmail]
      )
    }
    return true
  })
}

// ---- per-user adopted external MCP connections --------------------------
export async function listUserMcpConnections(userEmail, userToken) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT connection_name, comment, status, last_checked_at, created_at
         FROM user_mcp_connections WHERE user_email = $1 ORDER BY created_at ASC`,
      [userEmail]
    )
    return r.rows.map((x) => ({
      connectionName: x.connection_name,
      comment: x.comment || '',
      status: x.status || 'unknown',
      lastCheckedAt: x.last_checked_at,
      createdAt: x.created_at,
    }))
  })
}

export async function adoptUserMcpConnection(userEmail, userToken, connectionName, comment, status) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `INSERT INTO user_mcp_connections (user_email, connection_name, comment, status, last_checked_at)
         VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_email, connection_name) DO UPDATE SET
         comment = EXCLUDED.comment,
         status = EXCLUDED.status,
         last_checked_at = NOW()`,
      [userEmail, connectionName, comment || null, status || 'unknown']
    )
  })
}

export async function setUserMcpStatus(userEmail, userToken, connectionName, status) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `UPDATE user_mcp_connections SET status = $3, last_checked_at = NOW()
         WHERE user_email = $1 AND connection_name = $2`,
      [userEmail, connectionName, status]
    )
  })
}

export async function forgetUserMcpConnection(userEmail, userToken, connectionName) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(`DELETE FROM user_mcp_connections WHERE user_email = $1 AND connection_name = $2`, [
      userEmail,
      connectionName,
    ])
  })
}

// ---- authored skills ----------------------------------------------------
function shapeSkill(x) {
  return {
    id: String(x.id),
    scope: x.scope,
    ownerEmail: x.owner_email || null,
    name: x.name,
    title: x.title,
    description: x.description,
    body: x.body,
    triggers: Array.isArray(x.triggers) ? x.triggers : [],
    embedding: x.embedding || null,
    source: x.source || 'write',
    enabled: !!x.enabled,
    createdBy: x.created_by || '',
    updatedAt: x.updated_at,
  }
}

// Every skill this user can see: all global skills ∪ their own. `includeBody`
// false trims the (large) body/embedding for list views; the router needs
// them, the settings list doesn't.
export async function listSkills(userEmail, userToken, { includeBody = true } = {}) {
  return withClient(userEmail, userToken, async (c) => {
    const cols = includeBody
      ? `id, scope, owner_email, name, title, description, body, triggers, embedding, source, enabled, created_by, updated_at`
      : `id, scope, owner_email, name, title, description, '' AS body, triggers, NULL AS embedding, source, enabled, created_by, updated_at`
    const r = await c.query(
      `SELECT ${cols} FROM skills
        WHERE scope = 'global' OR (scope = 'user' AND owner_email = $1)
        ORDER BY scope DESC, updated_at DESC`,
      [userEmail]
    )
    return r.rows.map(shapeSkill)
  })
}

export async function getSkill(userEmail, userToken, id) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `SELECT id, scope, owner_email, name, title, description, body, triggers, embedding, source, enabled, created_by, updated_at
         FROM skills WHERE id = $1 AND (scope = 'global' OR (scope = 'user' AND owner_email = $2))`,
      [id, userEmail]
    )
    return r.rows.length ? shapeSkill(r.rows[0]) : null
  })
}

// Insert or update a skill. `scope` decides ownership: 'global' rows have a
// NULL owner (the caller must be admin — enforced at the route); 'user' rows
// belong to the caller. Returns the row's id.
export async function upsertSkill(userEmail, userToken, { id, scope, name, title, description, body, triggers, source, enabled }) {
  return withClient(userEmail, userToken, async (c) => {
    const owner = scope === 'global' ? null : userEmail
    const trig = JSON.stringify(Array.isArray(triggers) ? triggers : [])
    if (id) {
      // update in place, but only a row the caller may touch (own user row, or
      // any global row when this is a global-scoped call from an admin route)
      const r = await c.query(
        `UPDATE skills SET name=$3, title=$4, description=$5, body=$6, triggers=$7::jsonb,
           enabled=$8, embedding=NULL, updated_at=NOW()
         WHERE id=$1 AND (
           (scope='user' AND owner_email=$2) OR (scope='global' AND $9='global')
         )
         RETURNING id`,
        [id, userEmail, name, title, description, body, trig, enabled !== false, scope]
      )
      return r.rows[0] ? String(r.rows[0].id) : null
    }
    const r = await c.query(
      `INSERT INTO skills (scope, owner_email, name, title, description, body, triggers, source, enabled, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING id`,
      [scope || 'user', owner, name, title, description, body, trig, source || 'write', enabled !== false, userEmail]
    )
    return String(r.rows[0].id)
  })
}

export async function setSkillEmbedding(userEmail, userToken, id, vec) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(`UPDATE skills SET embedding = $2 WHERE id = $1`, [id, vec])
  })
}

export async function deleteSkill(userEmail, userToken, id, { allowGlobal = false } = {}) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `DELETE FROM skills
         WHERE id = $1 AND ((scope='user' AND owner_email=$2) OR (scope='global' AND $3))
       RETURNING id`,
      [id, userEmail, allowGlobal]
    )
    return r.rows.length > 0
  })
}

// Decks are drawn by the model as a structured `deck` prism-block (see
// blocks.js) and persisted here so the Deck Studio can reload/edit/export
// them independent of the chat message's own stored content.
export async function createDeck(userEmail, userToken, sessionId, title, slides, meta) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `INSERT INTO chat_decks (session_id, user_email, title, slides, meta) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [sessionId, userEmail, title, JSON.stringify(slides), JSON.stringify(meta || {})]
    )
    return String(r.rows[0].id)
  })
}

export async function getDeck(userEmail, userToken, deckId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT id, title, slides, meta FROM chat_decks WHERE id = $1 AND user_email = $2`, [
      deckId,
      userEmail,
    ])
    if (!r.rows.length) return null
    const x = r.rows[0]
    return { id: String(x.id), title: x.title, slides: x.slides || [], ...(x.meta || {}) }
  })
}

export async function updateDeckSlides(userEmail, userToken, deckId, title, slides, meta) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `UPDATE chat_decks SET title = $1, slides = $2, meta = $3, updated_at = NOW() WHERE id = $4 AND user_email = $5`,
      [title, JSON.stringify(slides), JSON.stringify(meta || {}), deckId, userEmail]
    )
  })
}

// ---- spreadsheets (see sanitizeSpreadsheet in blocks.js) — mirrors the deck
// helpers above: the model draws a `spreadsheet` prism-block, persisted here so
// it can be reloaded/exported (server/xlsx-export.js) independent of the message.
export async function createSpreadsheet(userEmail, userToken, sessionId, title, spec) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(
      `INSERT INTO chat_spreadsheets (session_id, user_email, title, spec) VALUES ($1, $2, $3, $4) RETURNING id`,
      [sessionId, userEmail, title, JSON.stringify(spec || {})]
    )
    return String(r.rows[0].id)
  })
}

export async function getSpreadsheet(userEmail, userToken, sheetId) {
  return withClient(userEmail, userToken, async (c) => {
    const r = await c.query(`SELECT id, title, spec FROM chat_spreadsheets WHERE id = $1 AND user_email = $2`, [
      sheetId,
      userEmail,
    ])
    if (!r.rows.length) return null
    const x = r.rows[0]
    return { id: String(x.id), title: x.title, ...(x.spec || {}) }
  })
}

export async function updateSpreadsheet(userEmail, userToken, sheetId, title, spec) {
  await withClient(userEmail, userToken, async (c) => {
    await c.query(
      `UPDATE chat_spreadsheets SET title = $1, spec = $2, updated_at = NOW() WHERE id = $3 AND user_email = $4`,
      [title, JSON.stringify(spec || {}), sheetId, userEmail]
    )
  })
}
