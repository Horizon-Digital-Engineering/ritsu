import type { Db } from './db.js';
import { AgentDefinitionSchema, type AgentDefinition } from './admin/schema.js';
import { logger } from './util/log.js';

/**
 * CRUD for agent_definitions rows. No events, no file watcher — admin
 * endpoints write here and then call AgentHost directly to reload the live
 * instance. Single source of truth, no race window.
 */
export interface AgentDefinitionStore {
  list(): Promise<AgentDefinition[]>;
  read(id: string): Promise<AgentDefinition | null>;
  upsert(def: AgentDefinition): Promise<AgentDefinition>;
  delete(id: string): Promise<boolean>;
  /** Swap current ↔ previous system_prompt. Returns the resulting definition. */
  revert(id: string): Promise<AgentDefinition>;
}

interface Row {
  id: string;
  type: string;
  name: string;
  description: string;
  system_prompt: string;
  dispatcher: 'claude-direct' | 'litellm';
  model: string;
  memory_backend: 'sqlite' | 'flashback';
  tools_allowlist: string;
  can_call: string | null;
  provider: string | null;
  api_key_ref: number | null;
  provider_options: string | null;
  capabilities: string | null;
  approval_tools: string | null;
  plugins: string | null;
  enabled: number;
  escalation_approvable: number;
  created_at: number;
  updated_at: number;
  previous_system_prompt: string | null;
  previous_saved_at: number | null;
}

function rowToDef(r: Row): AgentDefinition {
  return AgentDefinitionSchema.parse({
    id: r.id,
    type: r.type,
    name: r.name,
    description: r.description,
    system_prompt: r.system_prompt,
    dispatcher: r.dispatcher,
    model: r.model,
    memory_backend: r.memory_backend,
    tools_allowlist: JSON.parse(r.tools_allowlist) as string[],
    can_call: r.can_call ? (JSON.parse(r.can_call) as string[]) : [],
    provider: r.provider,
    api_key_ref: r.api_key_ref,
    provider_options: r.provider_options ? JSON.parse(r.provider_options) as Record<string, unknown> : {},
    capabilities: r.capabilities ? JSON.parse(r.capabilities) as string[] : [],
    approval_tools: r.approval_tools ? JSON.parse(r.approval_tools) as string[] : [],
    plugins: r.plugins ? JSON.parse(r.plugins) as string[] : [],
    enabled: r.enabled === 1,
    escalation_approvable: r.escalation_approvable === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
    previous_system_prompt: r.previous_system_prompt,
    previous_saved_at: r.previous_saved_at,
  });
}

export class SqliteAgentDefinitionStore implements AgentDefinitionStore {
  constructor(private readonly db: Db) {}

  async list(): Promise<AgentDefinition[]> {
    const rows = this.db
      .prepare('SELECT * FROM agent_definitions ORDER BY id ASC')
      .all() as Row[];
    return rows.map(rowToDef);
  }

  async read(id: string): Promise<AgentDefinition | null> {
    const row = this.db
      .prepare('SELECT * FROM agent_definitions WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? rowToDef(row) : null;
  }

  async upsert(def: AgentDefinition): Promise<AgentDefinition> {
    const validated = AgentDefinitionSchema.parse(def);
    // Diff can_call before the write so we can apply bidirectional sync
    // inside the same transaction. If X adds Y, Y gets X added; if X removes
    // Y, Y gets X removed. Sister agent doesn't need an agent-host reload
    // because agent-comms-mcp re-reads can_call from the store on every call.
    const existing = await this.read(validated.id);
    const oldCanCall = new Set(existing?.can_call ?? []);
    const newCanCall = new Set(validated.can_call);
    const addedEdges = [...newCanCall].filter(id => !oldCanCall.has(id) && id !== validated.id);
    const removedEdges = [...oldCanCall].filter(id => !newCanCall.has(id) && id !== validated.id);
    // On UPDATE: if system_prompt is actually changing, snapshot the current
    // one into previous_system_prompt (one-step undo). On INSERT: previous_*
    // stay null.
    const tx = this.db.transaction(() => {
      writeAgentDefRow(this.db, validated);
      syncCanCallEdges(this.db, validated.id, addedEdges, removedEdges);
    });
    tx();
    logger.info('def-store.upsert', { id: validated.id });
    const saved = await this.read(validated.id);
    if (!saved) throw new Error(`upsert vanished for ${validated.id}`);
    return saved;
  }

  async delete(id: string): Promise<boolean> {
    const r = this.db.prepare('DELETE FROM agent_definitions WHERE id = ?').run(id);
    const removed = r.changes > 0;
    if (removed) logger.info('def-store.delete', { id });
    return removed;
  }

  async revert(id: string): Promise<AgentDefinition> {
    const row = this.db
      .prepare('SELECT system_prompt, previous_system_prompt FROM agent_definitions WHERE id = ?')
      .get(id) as { system_prompt: string; previous_system_prompt: string | null } | undefined;
    if (!row) throw new Error(`agent ${id} not found`);
    if (row.previous_system_prompt === null) {
      throw new Error(`agent ${id} has no previous prompt to revert to`);
    }
    this.db
      .prepare(
        `UPDATE agent_definitions SET
           system_prompt          = previous_system_prompt,
           previous_system_prompt = ?,
           previous_saved_at      = updated_at,
           updated_at             = strftime('%s','now')
         WHERE id = ?`,
      )
      .run(row.system_prompt, id);
    logger.info('def-store.revert', { id });
    const saved = await this.read(id);
    if (!saved) throw new Error(`revert vanished for ${id}`);
    return saved;
  }
}

/** UPSERT the validated agent-definition row. ON CONFLICT preserves the
 *  previous_system_prompt for one-step undo when system_prompt actually
 *  changes. Kept separate from upsert() so the cognitive complexity of
 *  the transaction body stays manageable. */
function writeAgentDefRow(db: Db, validated: AgentDefinition): void {
  db.prepare(
    `INSERT INTO agent_definitions
       (id, type, name, description, system_prompt, dispatcher, model,
        memory_backend, tools_allowlist, can_call, provider, api_key_ref,
        provider_options, capabilities, approval_tools, plugins, enabled, escalation_approvable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type            = excluded.type,
       name            = excluded.name,
       description     = excluded.description,
       previous_system_prompt = CASE
         WHEN agent_definitions.system_prompt <> excluded.system_prompt
           THEN agent_definitions.system_prompt
         ELSE agent_definitions.previous_system_prompt
       END,
       previous_saved_at = CASE
         WHEN agent_definitions.system_prompt <> excluded.system_prompt
           THEN agent_definitions.updated_at
         ELSE agent_definitions.previous_saved_at
       END,
       system_prompt    = excluded.system_prompt,
       dispatcher       = excluded.dispatcher,
       model            = excluded.model,
       memory_backend   = excluded.memory_backend,
       tools_allowlist  = excluded.tools_allowlist,
       can_call         = excluded.can_call,
       provider         = excluded.provider,
       api_key_ref      = excluded.api_key_ref,
       provider_options = excluded.provider_options,
       capabilities     = excluded.capabilities,
       approval_tools   = excluded.approval_tools,
       plugins          = excluded.plugins,
       enabled          = excluded.enabled,
       escalation_approvable = excluded.escalation_approvable,
       updated_at       = strftime('%s','now')`,
  ).run(
    validated.id,
    validated.type,
    validated.name,
    validated.description,
    validated.system_prompt,
    validated.dispatcher,
    validated.model,
    validated.memory_backend,
    JSON.stringify(validated.tools_allowlist),
    JSON.stringify(validated.can_call),
    validated.provider,
    validated.api_key_ref,
    JSON.stringify(validated.provider_options),
    JSON.stringify(validated.capabilities),
    JSON.stringify(validated.approval_tools),
    JSON.stringify(validated.plugins),
    validated.enabled ? 1 : 0,
    validated.escalation_approvable ? 1 : 0,
  );
}

/** Apply bidirectional can_call sync: if A adds B, append A to B's can_call;
 *  if A removes B, drop A from B's can_call. Uses direct UPDATEs so this
 *  doesn't recurse into upsert(). Tolerates dangling ids — the operator may
 *  have removed an agent without scrubbing references. */
function syncCanCallEdges(
  db: Db,
  agentId: string,
  addedEdges: readonly string[],
  removedEdges: readonly string[],
): void {
  if (addedEdges.length === 0 && removedEdges.length === 0) return;
  const readRow = db.prepare('SELECT can_call FROM agent_definitions WHERE id = ?');
  const writeRow = db.prepare(
    `UPDATE agent_definitions SET can_call = ?, updated_at = strftime('%s','now') WHERE id = ?`,
  );
  const touched: string[] = [];
  for (const otherId of addedEdges) {
    if (addAgentToOtherCanCall(readRow, writeRow, otherId, agentId)) touched.push(otherId);
  }
  for (const otherId of removedEdges) {
    if (removeAgentFromOtherCanCall(readRow, writeRow, otherId, agentId)) touched.push(otherId);
  }
  if (touched.length) {
    logger.info('def-store.can-call-sync', {
      id: agentId,
      added: addedEdges,
      removed: removedEdges,
      synced: touched,
    });
  }
}

/** Add `agentId` to `otherId`'s can_call list. Returns true if a row was
 *  actually written (existing other, agentId not already present). */
function addAgentToOtherCanCall(
  readRow: ReturnType<Db['prepare']>,
  writeRow: ReturnType<Db['prepare']>,
  otherId: string,
  agentId: string,
): boolean {
  const row = readRow.get(otherId) as { can_call: string } | undefined;
  if (!row) return false;
  const list = JSON.parse(row.can_call) as string[];
  if (list.includes(agentId)) return false;
  writeRow.run(JSON.stringify([...list, agentId]), otherId);
  return true;
}

/** Drop `agentId` from `otherId`'s can_call list. Returns true if a row
 *  was actually written (existing other, agentId currently present). */
function removeAgentFromOtherCanCall(
  readRow: ReturnType<Db['prepare']>,
  writeRow: ReturnType<Db['prepare']>,
  otherId: string,
  agentId: string,
): boolean {
  const row = readRow.get(otherId) as { can_call: string } | undefined;
  if (!row) return false;
  const list = JSON.parse(row.can_call) as string[];
  if (!list.includes(agentId)) return false;
  writeRow.run(JSON.stringify(list.filter(id => id !== agentId)), otherId);
  return true;
}

/**
 * If the table is empty, seed a single generic smoke-test agent so first-run
 * users have something to call. Delete it freely; nothing depends on it.
 * No business-specific personas seeded.
 */
export async function seedIfEmpty(store: AgentDefinitionStore): Promise<void> {
  const existing = await store.list();
  if (existing.length > 0) return;

  await store.upsert({
    id: 'hello-world',
    type: 'generic',
    name: 'Hello World',
    description: 'Generic smoke-test agent. Delete or replace freely.',
    system_prompt: [
      'You are a smoke-test agent for this server.',
      'On every turn, briefly:',
      '1. Note any persistent memories you can see in the context.',
      '2. Echo back what the user just said.',
      '3. Confirm the wiring works in one sentence.',
    ].join('\n'),
    dispatcher: 'claude-direct',
    model: 'claude-sonnet-4-6',
    memory_backend: 'sqlite',
    tools_allowlist: [],
    can_call: [],
    provider: null,
    api_key_ref: null,
    provider_options: {},
    capabilities: [],
    approval_tools: [],
    plugins: [],
    enabled: true,
    escalation_approvable: false,
  });
  logger.info('def-store.seeded', { ids: ['hello-world'] });
}
