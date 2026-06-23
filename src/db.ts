import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- The authoritative agent record. Edited via /admin CRUD. AgentHost reads at
-- boot and on hot-reload. id is a stable kebab-case string chosen at create.
CREATE TABLE IF NOT EXISTS agent_definitions (
  id                     TEXT PRIMARY KEY,
  type                   TEXT NOT NULL,
  name                   TEXT NOT NULL,
  description            TEXT NOT NULL,
  system_prompt          TEXT NOT NULL,
  dispatcher             TEXT NOT NULL CHECK (dispatcher IN ('claude-direct','litellm')),
  model                  TEXT NOT NULL,
  memory_backend         TEXT NOT NULL DEFAULT 'sqlite' CHECK (memory_backend IN ('sqlite','flashback')),
  tools_allowlist        TEXT NOT NULL DEFAULT '[]',
  enabled                INTEGER NOT NULL DEFAULT 1,
  created_at             INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at             INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  -- One-step undo: the immediately-prior system_prompt. Set automatically
  -- on upsert when system_prompt changes. The Revert button swaps these.
  previous_system_prompt TEXT,
  previous_saved_at      INTEGER
);

-- Long-term knowledge, supersede-not-delete. agent_id is a plain string;
-- no FK so memories outlive their owning definition (recreating an agent
-- with the same id picks up its prior memories).
CREATE TABLE IF NOT EXISTS memories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT NOT NULL,
  content         TEXT NOT NULL,
  embedding       BLOB,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  superseded_by   INTEGER REFERENCES memories(id),
  lineage_root_id INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(agent_id) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_lineage ON memories(lineage_root_id);

-- Conversation transcripts. Distinct concept from memory: ephemeral history
-- of turns, not curated knowledge. Lives in SQLite even when an agent uses
-- a non-SQLite memory backend (e.g. Flashback).
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  ended_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

-- Image (and future binary) attachments for a message. Kept out of the
-- messages.content column so the transcript text stays cheap to scan; the data
-- column is base64. conversation_id is denormalized so a single query can fetch
-- every attachment for a thread in one shot.
CREATE TABLE IF NOT EXISTS message_attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      INTEGER NOT NULL REFERENCES messages(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  media_type      TEXT NOT NULL,
  data            TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON message_attachments(conversation_id);

-- MCP bearer tokens (Flashback-style). Full token shown to user once at mint;
-- stored as sha256 hash. prefix is the first 8 chars after the rt_ prefix,
-- kept for display so the operator can identify tokens by sight.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_used_at INTEGER,
  use_count    INTEGER NOT NULL DEFAULT 0,
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_active ON mcp_tokens(token_hash) WHERE revoked_at IS NULL;

-- Per-call audit trail. Kept small; trim/rotate is V2.
CREATE TABLE IF NOT EXISTS mcp_token_usage (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id  INTEGER NOT NULL REFERENCES mcp_tokens(id),
  ts        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  tool      TEXT NOT NULL,
  agent_id  TEXT,
  status    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_token_usage_token ON mcp_token_usage(token_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_token_usage_ts ON mcp_token_usage(ts DESC);

-- Filesystem roots an agent can operate on. The first row (lowest id) is
-- treated as the agent's working directory for V0.3; future tool-level
-- enforcement will check the full set + permissions per call.
CREATE TABLE IF NOT EXISTS agent_workspaces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT NOT NULL,
  path        TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT 'read',
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(agent_id, path)
);

CREATE INDEX IF NOT EXISTS idx_agent_workspaces_agent ON agent_workspaces(agent_id);

-- ---- OAuth 2.1 (RFC 7591/9728/8414, RFC 8707 audience) -----------------
-- These tables back the MCP-spec OAuth surface used by spec-compliant
-- clients (claude.ai web "Add custom connector", Claude Desktop's
-- Connectors UI). The simpler rt_* bearer tokens in mcp_tokens remain
-- valid in parallel for header-based clients (Claude Code CLI, curl).
--
-- Public clients only (PKCE-required, no client secrets).

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                  TEXT PRIMARY KEY,
  client_name                TEXT NOT NULL,
  redirect_uris              TEXT NOT NULL,           -- JSON array
  grant_types                TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  response_types             TEXT NOT NULL DEFAULT '["code"]',
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  scope                      TEXT NOT NULL DEFAULT 'mcp',
  software_id                TEXT,
  software_version           TEXT,
  created_at                 INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  revoked_at                 INTEGER
);

-- Server-side state for an in-flight /oauth/authorize request. Issued
-- by GET, looked up by POST. The consent page renders only request_id;
-- the form POST cannot influence PKCE / redirect_uri / scope / resource
-- because the server reads them from THIS row, not from the body. Single-
-- use: consumed on the first POST (success or denial), and any unused
-- row past expires_at is rejected.
CREATE TABLE IF NOT EXISTS oauth_authorize_requests (
  request_id            TEXT PRIMARY KEY,            -- random opaque token (base64url)
  client_id             TEXT NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri          TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  state                 TEXT,                         -- echoed back to client
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method IN ('S256')),
  resource              TEXT NOT NULL,
  expires_at            INTEGER NOT NULL,
  consumed_at           INTEGER,
  created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_oauth_authz_req_expiry ON oauth_authorize_requests(expires_at);

CREATE TABLE IF NOT EXISTS oauth_authz_codes (
  code_hash             TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri          TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method IN ('S256')),
  resource              TEXT NOT NULL,                 -- RFC 8707 audience
  state_snapshot        TEXT,                          -- not used; reserved
  expires_at            INTEGER NOT NULL,
  consumed_at           INTEGER,
  created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expiry ON oauth_authz_codes(expires_at);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  token_hash   TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES oauth_clients(client_id),
  scope        TEXT NOT NULL,
  resource     TEXT NOT NULL,                          -- audience binding
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_oauth_access_expiry ON oauth_access_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_access_client ON oauth_access_tokens(client_id);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash   TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES oauth_clients(client_id),
  scope        TEXT NOT NULL,
  resource     TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  rotated_to   TEXT,                                   -- token_hash of successor (rotation chain)
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_client ON oauth_refresh_tokens(client_id);

-- Human-in-the-loop approvals. A row is created when an agent tries to use
-- a tool that its definition lists in approval_tools; the agent's turn
-- blocks until the operator approves or rejects. agent_id / conversation_id
-- are plain strings/ids (no FK) so a row survives agent or conversation
-- deletion for audit. args_json is the tool input the model proposed —
-- shown verbatim on the approval card. reason is the operator's optional
-- note on reject, fed back to the model as the tool-denial message.
CREATE TABLE IF NOT EXISTS tool_approvals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT NOT NULL,
  conversation_id INTEGER,
  tool_name       TEXT NOT NULL,
  args_json       TEXT NOT NULL DEFAULT '{}',
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected')),
  reason          TEXT,
  decided_by      TEXT,
  requested_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  decided_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tool_approvals_pending ON tool_approvals(requested_at DESC) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_tool_approvals_convo ON tool_approvals(conversation_id);

-- Inter-agent call denials. ask_agent blocked by a guard (allowlist, capability
-- escalation, cycle, depth, or in-flight cap) used to vanish into the log; this
-- persists each one so a blocked delegation is visible to the operator. No FK on
-- caller/target so a row survives agent deletion for audit. detail carries
-- human-readable context (escalated caps, the call chain, counts).
CREATE TABLE IF NOT EXISTS comms_denials (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  caller          TEXT NOT NULL,
  target          TEXT NOT NULL,
  reason          TEXT NOT NULL,   -- not_in_allowlist | escalation | cycle | depth | inflight
  detail          TEXT,
  message         TEXT,            -- what the caller was trying to say (truncated)
  conversation_id INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_comms_denials_recent ON comms_denials(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tool_approvals_decided ON tool_approvals(decided_at DESC) WHERE state <> 'pending';

-- Plugin secret store. Credentials for CRM/email/social and any other plugin
-- that talks to an external service: an IMAP password, an SMTP login, an API
-- token. Encrypted at rest (AES-256-GCM with row-context AAD via
-- secret-crypto, same as api_keys/channels). The decrypt path is reachable
-- ONLY from tool/plugin handlers — there is deliberately NO agent-callable
-- "get_secret" tool, so the plaintext never enters an LLM's context. Agents
-- pass opaque references (e.g. account name) and the handler resolves the
-- secret internally. namespace groups a connector's secrets (e.g. 'email').
CREATE TABLE IF NOT EXISTS plugin_secrets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace   TEXT NOT NULL,
  name        TEXT NOT NULL,
  value_enc   TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(namespace, name)
);

CREATE INDEX IF NOT EXISTS idx_plugin_secrets_ns ON plugin_secrets(namespace);
`;

/**
 * Result of a mutating SQL statement. node:sqlite returns these as
 * BigInt; we coerce to Number in `wrap()` so the rest of the codebase
 * can keep using JS number comparisons, JSON.stringify, etc. (the shape
 * better-sqlite3 always exposed by default). The lossy edge case —
 * lastInsertRowid > 2^53 — doesn't apply: we don't have tables anywhere
 * near that many rows.
 */
export type RunResult = { changes: number; lastInsertRowid: number };

/**
 * Connection handle shared by every store. Two extensions on top of
 * node:sqlite's DatabaseSync:
 *   1. `prepare().run()` returns RunResult with Number fields (see above).
 *   2. `transaction(fn)` returns a function that calls `fn` inside
 *      BEGIN/COMMIT, ROLLBACK on throw. Mirrors the better-sqlite3 API
 *      the stores still call.
 */
/**
 * Prepared statement as exposed to the stores. node:sqlite's StatementSync
 * types `.get/.all` as `Record<string, SQLOutputValue>` (a tagged-union row
 * shape that requires going through `unknown` to cast to a domain type).
 * That makes every caller noisier. We mirror the better-sqlite3 ergonomics
 * by declaring `.get/.all` as returning `unknown`, so existing
 * `stmt.all(...) as Row[]` casts just work.
 */
export interface Stmt {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export type Db = Omit<DatabaseSync, 'prepare'> & {
  prepare(sql: string): Stmt;
  // any[] in the function signature is unavoidable here — the wrapped fn
  // is generic across every caller; it'd otherwise force every transaction
  // body to widen to unknown[].
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<T extends (...args: any[]) => unknown>(fn: T): T;
};

/**
 * Install the two shims (prepare-coercion + transaction helper) onto a
 * freshly-constructed DatabaseSync. Sole place the wrapping happens, so
 * Db invariants are guaranteed for every connection.
 */
function wrap(d: DatabaseSync): Db {
  const db = d as unknown as Db;

  const origPrepare = (d.prepare).bind(d);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = origPrepare(sql);
    const origRun = stmt.run.bind(stmt);
    (stmt as unknown as { run(...p: unknown[]): RunResult }).run = (...params: unknown[]) => {
      const r = origRun(...(params as Parameters<typeof origRun>));
      return {
        changes: Number(r.changes),
        lastInsertRowid: Number(r.lastInsertRowid),
      };
    };
    // node:sqlite returns rows with a `null` prototype (defensive against
    // prototype pollution). Clone into plain objects so downstream code
    // (and `assert.deepStrictEqual` in tests) see normal Object.prototype
    // shapes — same as better-sqlite3 always exposed.
    const origGet = stmt.get.bind(stmt);
    (stmt as unknown as { get(...p: unknown[]): unknown }).get = (...params: unknown[]) => {
      const r = origGet(...(params as Parameters<typeof origGet>));
      return r ? { ...(r as object) } : r;
    };
    const origAll = stmt.all.bind(stmt);
    (stmt as unknown as { all(...p: unknown[]): unknown[] }).all = (...params: unknown[]) => {
      const rs = origAll(...(params as Parameters<typeof origAll>));
      return rs.map((r: unknown) => ({ ...(r as object) }));
    };
    return stmt;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.transaction = function transaction<T extends (...args: any[]) => unknown>(fn: T): T {
    return ((...args: Parameters<T>) => {
      db.exec('BEGIN');
      try {
        const result = fn(...args);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        // If ROLLBACK itself fails, surface the original error — it's the
        // more useful signal, and ROLLBACK failures here are almost always
        // a follow-on consequence (closed connection, etc.).
        try { db.exec('ROLLBACK'); } catch { /* swallow */ }
        throw err;
      }
    }) as T;
  };

  return db;
}

/**
 * Open (or create) the application's SQLite database and apply the schema.
 * Called exactly once at boot. The returned connection is shared by every
 * store (memory, conversation, agent-definition) — node:sqlite is
 * synchronous so one connection is correct.
 *
 * Migrations are additive: CREATE TABLE IF NOT EXISTS handles new tables,
 * and `addColumnIfMissing` handles new columns on existing tables. Don't
 * remove or rename columns from this codepath — write a script for that.
 */
export function openDatabase(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = wrap(new DatabaseSync(dbPath));
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Test helper: in-memory DB with the .transaction shim + .run coercion
 * applied, but no schema or migrations. Callers seed their own minimal
 * schema (see src/__tests__/oauth-store.test.ts).
 */
export function createInMemoryDb(): Db {
  return wrap(new DatabaseSync(':memory:'));
}

function migrate(db: Db): void {
  addColumnIfMissing(db, 'agent_definitions', 'previous_system_prompt', 'TEXT');
  addColumnIfMissing(db, 'agent_definitions', 'previous_saved_at', 'INTEGER');
  // Opt-in: route capability-escalation ask_agent calls to the approval screen
  // instead of hard-denying. Default 0 = hard-deny (the safe baseline).
  addColumnIfMissing(db, 'agent_definitions', 'escalation_approvable', 'INTEGER NOT NULL DEFAULT 0');
  // The message a blocked ask_agent was trying to send (added after comms_denials
  // first shipped, so existing deploys need the column).
  addColumnIfMissing(db, 'comms_denials', 'message', 'TEXT');
  // Phase 7: bearer tokens carry a scope so admin and MCP tokens are
  // distinguishable. Existing rows are 'mcp' (the only kind that existed).
  addColumnIfMissing(db, 'mcp_tokens', 'scope', "TEXT NOT NULL DEFAULT 'mcp'");
  // Inter-agent messaging: who this agent is allowed to call via ask_agent.
  addColumnIfMissing(db, 'agent_definitions', 'can_call', "TEXT NOT NULL DEFAULT '[]'");
  // Inter-agent conversations: caller_agent_id is null for human-initiated
  // threads, set to the calling agent's id for agent-to-agent threads.
  addColumnIfMissing(db, 'conversations', 'caller_agent_id', 'TEXT');
  // Per-message caller attribution: identifies who/what produced a given user
  // turn within a conversation. Values: 'admin-ui' for the admin chat panel,
  // an MCP token's name (or OAuth client_id) for bearer-authed calls, or the
  // calling agent's id for agent-to-agent calls. Null on legacy rows.
  addColumnIfMissing(db, 'messages', 'caller_label', 'TEXT');
  // Optional expiry on bearer tokens. NULL = never expires (legacy behavior);
  // populated rows are rejected by verify() once strftime('%s','now') > expires_at.
  addColumnIfMissing(db, 'mcp_tokens', 'expires_at', 'INTEGER');
  backfillCallerLabels(db);
  consolidateHumanThreads(db);
  ensureChannelsTable(db);
  ensureAdminAuditTable(db);
  ensureApiKeysTable(db);
  // Per-agent model provider config — added late so legacy rows just have
  // NULL here and continue using the claude-direct dispatcher unchanged.
  addColumnIfMissing(db, 'agent_definitions', 'provider', 'TEXT');
  addColumnIfMissing(db, 'agent_definitions', 'api_key_ref', 'INTEGER');
  addColumnIfMissing(db, 'agent_definitions', 'provider_options', "TEXT NOT NULL DEFAULT '{}'");
  // Per-agent capability flags. JSON array of capability names; today
  // 'manage_agents' (mint+update agents via in-process MCP) and
  // 'monitor_agents' (read-only swarm inspection). Empty = the safe
  // default; existing agents stay where they are.
  addColumnIfMissing(db, 'agent_definitions', 'capabilities', "TEXT NOT NULL DEFAULT '[]'");
  // Human-in-the-loop: JSON array of tool names this agent must get operator
  // approval for before each use (e.g. ["Bash","Write"]). Empty = no gating
  // (current behavior for every existing agent).
  addColumnIfMissing(db, 'agent_definitions', 'approval_tools', "TEXT NOT NULL DEFAULT '[]'");
}

/** API keys for the ritsu-agent runtime (Phase B). Stored AES-256-GCM
 *  encrypted via secret-crypto; the plaintext is shown to the operator at
 *  mint time exactly once and is never readable from the API thereafter.
 *  Each agent that needs a paid model references one of these by id. */
function ensureApiKeysTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL UNIQUE,
      provider     TEXT NOT NULL,
      key_enc      TEXT NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      last_used_at INTEGER,
      use_count    INTEGER NOT NULL DEFAULT 0,
      revoked_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_provider ON api_keys(provider);
  `);
}

/** Per-request audit log for the admin surface. Captures every mutating
 *  request (POST/PATCH/PUT/DELETE) with token id, IP, status, latency, and
 *  a sha256 of the body. The body hash is tamper-evidence without storing
 *  the secrets that some endpoints (e.g. mint token, create channel) carry
 *  in their payloads. */
function ensureAdminAuditTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      token_id    INTEGER REFERENCES mcp_tokens(id),
      ip          TEXT,
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      status      INTEGER NOT NULL,
      body_sha256 TEXT,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_token ON admin_audit(token_id);
  `);
}

/** Communication channels (Telegram, Discord, …) — each row = one bot/account
 *  bound to one operator agent. Inbound messages get forwarded to that
 *  agent's onMessage with caller_label set to the channel kind. */
function ensureChannelsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL UNIQUE,
      kind              TEXT NOT NULL CHECK (kind IN ('telegram')),
      operator_agent_id TEXT NOT NULL,
      config            TEXT NOT NULL DEFAULT '{}',
      enabled           INTEGER NOT NULL DEFAULT 1,
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
}

/**
 * Collapse legacy mess: keep the longest human-kind conversation per agent,
 * delete the rest. Agent-to-agent threads (caller_agent_id IS NOT NULL) are
 * untouched. Tiebreaker among equal-length convos: lowest id (oldest wins).
 *
 * Idempotent — once every agent has at most one human-kind thread the
 * `HAVING COUNT(*) > 1` filter returns empty and the rest of the function
 * is a no-op.
 */
function consolidateHumanThreads(db: Db): void {
  const dupes = db.prepare(`
    SELECT agent_id
      FROM conversations
     WHERE caller_agent_id IS NULL
     GROUP BY agent_id
    HAVING COUNT(*) > 1
  `).all() as Array<{ agent_id: string }>;
  if (dupes.length === 0) return;
  const findKeeper = db.prepare(`
    SELECT c.id,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS mc
      FROM conversations c
     WHERE c.agent_id = ? AND c.caller_agent_id IS NULL
     ORDER BY mc DESC, c.id ASC
     LIMIT 1
  `);
  const purgeMsgs = db.prepare(`
    DELETE FROM messages
     WHERE conversation_id IN (
       SELECT id FROM conversations
        WHERE agent_id = ? AND caller_agent_id IS NULL AND id != ?
     )
  `);
  const purgeConvos = db.prepare(`
    DELETE FROM conversations
     WHERE agent_id = ? AND caller_agent_id IS NULL AND id != ?
  `);
  const tx = db.transaction(() => {
    for (const { agent_id } of dupes) {
      const keeper = findKeeper.get(agent_id) as { id: number; mc: number };
      purgeMsgs.run(agent_id, keeper.id);
      const removed = purgeConvos.run(agent_id, keeper.id);
      console.log(JSON.stringify({
        t: new Date().toISOString(),
        level: 'info',
        msg: 'consolidate.human-threads',
        agent_id,
        kept: keeper.id,
        kept_msg_count: keeper.mc,
        deleted_count: removed.changes,
      }));
    }
  });
  tx();
}

/**
 * Best-effort backfill for caller_label on legacy `messages` rows that
 * predate the column. Idempotent (only fills rows still NULL), runs once
 * per startup and is a no-op after that.
 *
 * Strategy:
 *   1. Inter-agent threads (conversation.caller_agent_id IS NOT NULL):
 *      every user turn is from that caller agent, so caller_label = caller_agent_id.
 *   2. Anything else (human-kind threads) gets labeled 'admin-ui'.
 *
 * Note: some of the human-kind messages were actually MCP bearer calls
 * (Claude Code etc.), not the admin chat. A correlated subquery against
 * mcp_token_usage to identify which was which by timestamp was attempted
 * but SQLite UPDATE scoping fights it — and the user explicitly said the
 * cheap "lump everything as admin-ui" path was fine. Per-message attribution
 * is exact going forward.
 */
function backfillCallerLabels(db: Db): void {
  const tx = db.transaction(() => {
    // 1) Agent-to-agent: pull caller from the conversation row.
    db.exec(`
      UPDATE messages
         SET caller_label = (
           SELECT c.caller_agent_id FROM conversations c
            WHERE c.id = messages.conversation_id
         )
       WHERE messages.role = 'user'
         AND messages.caller_label IS NULL
         AND EXISTS (
           SELECT 1 FROM conversations c
            WHERE c.id = messages.conversation_id
              AND c.caller_agent_id IS NOT NULL
         )
    `);
    // 2) Anything still NULL on a user-role row → admin-ui (best guess).
    db.exec(`
      UPDATE messages
         SET caller_label = 'admin-ui'
       WHERE messages.role = 'user'
         AND messages.caller_label IS NULL
    `);
  });
  tx();
}

/**
 * Identifier whitelist for the DDL helper. SQLite doesn't bind table /
 * column / type as parameters, so the only safe call shape is string
 * interpolation — which makes this helper a one-line landmine if a
 * future caller pipes user-controlled text through. Refuse anything
 * that isn't a plain SQL identifier so the bug surfaces loud.
 */
const SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_TYPE_RE  = /^[A-Za-z][A-Za-z0-9_ ()'"[\]{}=\-,.]*$/;

function addColumnIfMissing(db: Db, table: string, column: string, type: string): void {
  if (!SQL_IDENT_RE.test(table)) throw new Error(`addColumnIfMissing: table identifier '${table}' is not a plain identifier`);
  if (!SQL_IDENT_RE.test(column)) throw new Error(`addColumnIfMissing: column identifier '${column}' is not a plain identifier`);
  if (!SQL_TYPE_RE.test(type))   throw new Error(`addColumnIfMissing: type '${type}' contains disallowed characters`);
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some(c => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
