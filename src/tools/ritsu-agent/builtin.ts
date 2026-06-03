/**
 * Built-in tools every ritsu-agent gets: memory CRUD + inter-agent
 * messaging. Mirrors the behavior of src/tools/mcp-internal/memory.ts and
 * src/tools/mcp-internal/agent-comms.ts but plugs into the ritsu-agent
 * runtime as native function-calling tools (JSON schema → provider tool
 * desc → handler called in-process) instead of via the MCP transport.
 *
 * The agent_id and allowlist enforcement are closed over in the handler
 * so a model can't spoof identity by passing a different id — same
 * security posture as the MCP path.
 *
 * The two parallel implementations (this file + mcp-internal/) share the
 * same MemoryStore / AgentDefinitionStore / ConversationStore underneath,
 * so a memory written via claude-sdk's MCP path is visible to a
 * ritsu-agent's native list_memories call, and vice versa.
 */
import type { MemoryStore } from '../../memory-store.js';
import type { AgentDefinitionStore } from '../../agent-definition-store.js';
import type { ConversationStore } from '../../conversation-store.js';
import type { Workspace } from '../../workspace-store.js';
import {
  AgentDefinitionSchema,
  AgentDefinitionPatchSchema,
  assertGrantableCapabilities,
  type AgentDefinition,
} from '../../admin/schema.js';
import {
  currentCallContext, runInCallContext, MAX_CALL_DEPTH, buildDenialMessage,
} from '../mcp-internal/agent-comms.js';
import { buildFsTools } from './fs.js';
import { buildProcessTools } from './process.js';
import { buildNetworkTools, type NetworkOptions } from './network.js';
import type { RaTool } from '../../model/ritsu-agent/types.js';
import { logger } from '../../util/log.js';
import { asString } from '../../util/cast.js';

/** Minimal AgentHost surface — same as in memory/comms MCP wrappers. */
export interface RaCommsHost {
  get(id: string): { onMessage(req: { message: string; conversation_id?: number; caller_label?: string | null }): Promise<{ reply: string; conversation_id: number }> };
}

/** Minimal AgentHost surface for the admin tools: just the live-reload entrypoint. */
export interface RaAdminHost {
  addOrReplace(def: AgentDefinition): void;
}

export interface RaToolDeps {
  agentId: string;
  memory: MemoryStore;
  defStore: AgentDefinitionStore;
  conversations: ConversationStore;
  host: RaCommsHost;
  /** Workspaces the agent can operate inside. If present, the matching FS /
   *  process / network tools (filtered by toolsAllowlist) get surfaced. */
  workspaces?: Workspace[];
  /** From def.tools_allowlist — same list claude-sdk uses to pick SDK
   *  built-ins. For ritsu-agent we use it to gate the native FS / process /
   *  network tool descriptors we expose. memory_* and agent_comms_* are
   *  always on (mirroring claude-sdk's auto-wired MCP tools). */
  toolsAllowlist?: string[];
  /** Network tool options (searxng URL override, custom fetch for tests). */
  network?: NetworkOptions;
  /** Per-agent capabilities. 'manage_agents' → admin tools; 'monitor_agents'
   *  → monitor tools. AgentHost passes the live list from def.capabilities. */
  capabilities?: string[];
  /** Live AgentHost reload entrypoint, needed by the admin tools. */
  adminHost?: RaAdminHost;
}

/** Memory: remember / list_memories / update_memory / forget.
 *  Same wire-format the MCP path uses, just exposed as JSON-schema
 *  function calls so any OpenAI-compat provider can invoke them. */
export function buildMemoryTools(deps: RaToolDeps): RaTool[] {
  const { agentId, memory } = deps;
  return [
    {
      name: 'memory_remember',
      description:
        "Save a fact / preference / context note so future conversations with this same agent will see it. " +
        "Use sparingly — these are injected into every future turn's system prompt. " +
        'Prefer short, durable, true-tomorrow notes ("user prefers metric units", "audit deadline is 2026-07-15"); ' +
        'not transient state ("currently writing section 3").',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 4000, description: 'The fact to remember. One self-contained sentence is ideal.' },
        },
      },
      handler: async (args) => {
        const content = asString(args.content).trim();
        if (!content) return 'error: content required';
        const id = await memory.write({ agent_id: agentId, content });
        logger.info('ra.memory.remember', { agent_id: agentId, id, content_len: content.length });
        return `remembered (id=${id})`;
      },
    },
    {
      name: 'memory_list_memories',
      description:
        "List this agent's active memories. Each memory is already injected into the system prompt at every turn — " +
        'use this only when you need ids (e.g. to call memory_update_memory or memory_forget).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 500, description: 'max number of memories to return (default 50)' },
        },
      },
      handler: async (args) => {
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const memories = await memory.list(agentId, limit);
        if (memories.length === 0) return '(no active memories)';
        return memories.map(m => `[${m.id}] ${m.content}`).join('\n');
      },
    },
    {
      name: 'memory_update_memory',
      description:
        'Replace an existing memory with an updated version. The old version is preserved in the lineage chain; ' +
        'only the new version shows in the active list. Use when a fact changed (deadline moved, preference flipped).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'content'],
        properties: {
          id: { type: 'integer', minimum: 1, description: 'id of the memory to supersede' },
          content: { type: 'string', minLength: 1, maxLength: 4000, description: 'the new content' },
        },
      },
      handler: async (args) => {
        const id = Number(args.id);
        const content = asString(args.content).trim();
        if (!Number.isInteger(id) || id <= 0 || !content) return 'error: id and content required';
        const newId = await memory.write({ agent_id: agentId, content, supersedes: id });
        logger.info('ra.memory.update', { agent_id: agentId, old_id: id, new_id: newId });
        return `updated (old id=${id}, new id=${newId})`;
      },
    },
    {
      name: 'memory_forget',
      description:
        'Tombstone a memory so it no longer appears in the active list. Use when something is no longer true or relevant.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'integer', minimum: 1, description: 'id of the memory to forget' },
        },
      },
      handler: async (args) => {
        const id = Number(args.id);
        if (!Number.isInteger(id) || id <= 0) return 'error: id required';
        const ok = await memory.delete(id);
        logger.info('ra.memory.forget', { agent_id: agentId, id, ok });
        return ok ? `forgotten (id=${id})` : `nothing to forget (id=${id} not active)`;
      },
    },
  ];
}

/** Agent comms: ask_agent + list_agents. Allowlist enforcement is
 *  re-read at call time (admin edits take effect immediately) and the
 *  AsyncLocalStorage call-depth guard from agent-comms-mcp is shared so
 *  ritsu-agent → claude-direct loops are bounded too. */
export function buildAgentCommsTools(deps: RaToolDeps): RaTool[] {
  const { agentId, defStore, conversations, host } = deps;
  return [
    {
      name: 'agent_comms_ask_agent',
      description:
        'Send a message to another agent and get its reply. Only agents in your `can_call` allowlist are reachable. ' +
        "Omit conversation_id to land in the canonical (you, target) thread — keeps related back-and-forth in one place. " +
        'Pass an explicit conversation_id only when you specifically want a different thread.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['agent_id', 'message'],
        properties: {
          agent_id: { type: 'string', description: 'id of the target agent to call' },
          message: { type: 'string', minLength: 1, description: 'what to say to the target' },
          conversation_id: { type: 'integer', minimum: 1, description: 'optional: specific conversation to use' },
        },
      },
      handler: async (args) => {
        const target = asString(args.agent_id);
        const message = asString(args.message);
        const conversation_id = typeof args.conversation_id === 'number' ? args.conversation_id : undefined;
        if (!target || !message) return 'error: agent_id and message required';

        // Live allowlist check — same posture as agent-comms-mcp.
        const def = await defStore.read(agentId);
        const allowed = def?.can_call ?? [];
        if (!allowed.includes(target)) {
          logger.warn('ra.comms.denied', { caller: agentId, target, reason: 'not_in_allowlist' });
          return buildDenialMessage(agentId, target, allowed);
        }

        // Shared call-depth guard with agent-comms-mcp so mixed-runtime chains
        // (ritsu-agent → claude-sdk → ritsu-agent → …) are bounded together.
        const ctx = currentCallContext() ?? { depth: 0, chain: [agentId] };
        if (ctx.depth >= MAX_CALL_DEPTH) {
          const chain = [...ctx.chain, target].join(' → ');
          logger.warn('ra.comms.depth-exceeded', { caller: agentId, target, chain });
          return `call depth exceeded (max ${MAX_CALL_DEPTH}): ${chain}. Stop and answer with what you already know.`;
        }
        const nextCtx = { depth: ctx.depth + 1, chain: [...ctx.chain, target] };
        const convoId = conversation_id ?? conversations.findOrStartInterAgentThread(agentId, target);
        logger.info('ra.comms.ask', { caller: agentId, target, conv: convoId, depth: nextCtx.depth });

        try {
          const r = await runInCallContext(nextCtx, async () =>
            host.get(target).onMessage({ message, conversation_id: convoId, caller_label: agentId }),
          );
          return r.reply;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('ra.comms.error', { caller: agentId, target, error: msg });
          return `error calling ${target}: ${msg}`;
        }
      },
    },
    {
      name: 'agent_comms_list_agents',
      description:
        'List the agents you can call via agent_comms_ask_agent — filtered to your `can_call` allowlist. ' +
        'Returns id, name, and one-line description for each.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const def = await defStore.read(agentId);
        const allowed = new Set(def?.can_call ?? []);
        if (allowed.size === 0) return '(no callable agents — your can_call list is empty)';
        const all = await defStore.list();
        const visible = all.filter(a => a.enabled && allowed.has(a.id));
        if (visible.length === 0) return '(your allowed agents are all disabled or missing)';
        return visible.map(a => `[${a.id}] ${a.name} — ${a.description}`).join('\n');
      },
    },
  ];
}

/** Agent admin: create / update / reload other agents.
 *  Mirrors src/tools/mcp-internal/agent-admin.ts. The capability gate lives
 *  one level up — if these tools are wired in, the caller is authorized. */
export function buildAgentAdminTools(deps: RaToolDeps): RaTool[] {
  const { agentId, defStore, adminHost } = deps;
  if (!adminHost) return [];
  return [
    {
      name: 'agent_admin_create_agent',
      description:
        'Create a new agent and wire it live. The new agent is immediately callable via ask_agent ' +
        '(if your can_call list includes its id, or after an admin edit adds it). Choose a stable ' +
        'lowercase kebab-case id — it cannot be changed later.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'description', 'system_prompt', 'dispatcher', 'model'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', description: 'Stable kebab-case identifier.' },
          type: { type: 'string', default: 'generic' },
          name: { type: 'string' },
          description: { type: 'string' },
          system_prompt: { type: 'string' },
          dispatcher: { type: 'string', enum: ['claude-direct', 'litellm'] },
          model: { type: 'string' },
          memory_backend: { type: 'string', enum: ['sqlite', 'flashback'], default: 'sqlite' },
          tools_allowlist: { type: 'array', items: { type: 'string' }, default: [] },
          can_call: { type: 'array', items: { type: 'string' }, default: [] },
          capabilities: { type: 'array', items: { type: 'string', enum: ['manage_agents', 'monitor_agents'] }, default: [] },
          enabled: { type: 'boolean', default: true },
        },
      },
      handler: async (args) => {
        try {
          // JSON-schema defaults aren't applied at parse time — mirror what the
          // Zod path on the MCP side gets by hand. Provider/api-key-ref start
          // as null (claude-sdk default) unless caller overrides.
          const withDefaults = {
            type: 'generic',
            memory_backend: 'sqlite',
            tools_allowlist: [],
            can_call: [],
            capabilities: [],
            provider: null,
            api_key_ref: null,
            provider_options: {},
            enabled: true,
            ...args,
          };
          const validated = AgentDefinitionSchema.parse(withDefaults);
          // runTool does not validate args against the JSON-schema enum, so
          // AgentDefinitionSchema (which permits crm/social) is the only gate
          // here — enforce the operator-only capabilities explicitly.
          assertGrantableCapabilities(validated.capabilities);
          const existing = await defStore.read(validated.id);
          if (existing) return `error: agent ${validated.id} already exists; use agent_admin_update_agent`;
          const saved = await defStore.upsert(validated);
          adminHost.addOrReplace(saved);
          logger.info('ra.agent-admin.create', { by: agentId, id: saved.id });
          return `created ${saved.id}`;
        } catch (e) {
          return `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
    {
      name: 'agent_admin_update_agent',
      description:
        'Update one or more fields on an existing agent. Only the fields you pass in `patch` change.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['agent_id', 'patch'],
        properties: {
          agent_id: { type: 'string' },
          patch: { type: 'object', additionalProperties: true },
        },
      },
      handler: async (args) => {
        try {
          const id = asString(args.agent_id);
          if (!id) return 'error: agent_id required';
          // Self-modification via agent-admin is operator-only — otherwise an
          // agent could strip its own approval_tools / grant itself tools.
          if (id === agentId) return 'error: an agent cannot modify itself via agent-admin (operator-only)';
          const current = await defStore.read(id);
          if (!current) return `error: agent ${id} not found`;
          const validPatch = AgentDefinitionPatchSchema.parse(args.patch ?? {});
          // crm/social are operator-only; an agent cannot grant them here.
          assertGrantableCapabilities(validPatch.capabilities);
          const merged = AgentDefinitionSchema.parse({ ...current, ...validPatch, id: current.id });
          const saved = await defStore.upsert(merged);
          adminHost.addOrReplace(saved);
          logger.info('ra.agent-admin.update', { by: agentId, id: saved.id, fields: Object.keys(validPatch) });
          return `updated ${saved.id}`;
        } catch (e) {
          return `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
    {
      name: 'agent_admin_reload_agent',
      description: "Rebuild an agent's live instance from its current DB row.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['agent_id'],
        properties: { agent_id: { type: 'string' } },
      },
      handler: async (args) => {
        try {
          const id = asString(args.agent_id);
          if (!id) return 'error: agent_id required';
          const def = await defStore.read(id);
          if (!def) return `error: agent ${id} not found`;
          adminHost.addOrReplace(def);
          logger.info('ra.agent-admin.reload', { by: agentId, id: def.id });
          return `reloaded ${def.id}`;
        } catch (e) {
          return `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
  ];
}

/** Agent monitor: read-only swarm inspection.
 *  Mirrors src/tools/mcp-internal/agent-monitor.ts. */
export function buildAgentMonitorTools(deps: RaToolDeps): RaTool[] {
  const { agentId, defStore, conversations, memory } = deps;
  return [
    {
      name: 'agent_monitor_list_agents',
      description:
        'List every agent registered on this server (id, name, description, enabled, dispatcher). ' +
        'NOT filtered to your can_call allowlist — monitoring sees the whole swarm.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => {
        const all = await defStore.list();
        if (all.length === 0) return '(no agents registered)';
        logger.info('ra.agent-monitor.list_agents', { by: agentId, count: all.length });
        return all
          .map(a => `[${a.id}] ${a.name} (${a.enabled ? 'enabled' : 'disabled'}, ${a.dispatcher}/${a.model}) — ${a.description}`)
          .join('\n');
      },
    },
    {
      name: 'agent_monitor_list_conversations',
      description:
        'List recent conversations. Pass agent_id to filter to threads where that agent is on either side. ' +
        "Omit agent_id to see the whole swarm. `kind`: 'human', 'agent', 'all' (default).",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agent_id: { type: 'string' },
          kind: { type: 'string', enum: ['human', 'agent', 'all'], default: 'all' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
      handler: async (args) => {
        const target = asString(args.agent_id) || undefined;
        const kind = (args.kind as 'human' | 'agent' | 'all') ?? 'all';
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const summaries = conversations.listSummaries(undefined, limit, kind, target);
        if (summaries.length === 0) return '(no conversations match)';
        logger.info('ra.agent-monitor.list_conversations', { by: agentId, target: target ?? null, count: summaries.length });
        return summaries
          .map(s => {
            const side = s.caller_agent_id ? `${s.caller_agent_id} → ${s.agent_id}` : `human → ${s.agent_id}`;
            const status = s.ended_at ? 'ended' : 'open';
            return `[${s.id}] ${side} · ${s.message_count} msg · ${status} · ${s.title || '(no title)'}`;
          })
          .join('\n');
      },
    },
    {
      name: 'agent_monitor_read_conversation',
      description:
        'Read messages from a conversation. Returns the most recent `limit` messages in chronological ' +
        'order with caller attribution preserved.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['conversation_id'],
        properties: {
          conversation_id: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        },
      },
      handler: async (args) => {
        const convId = Number(args.conversation_id);
        if (!Number.isInteger(convId) || convId <= 0) return 'error: conversation_id required';
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const msgs = conversations.recent(convId, limit);
        if (msgs.length === 0) return '(no messages in this conversation)';
        logger.info('ra.agent-monitor.read_conversation', { by: agentId, conv: convId, count: msgs.length });
        return msgs
          .map(m => {
            const who = m.role === 'assistant' ? 'assistant' : m.caller_label ?? m.role;
            return `[${who}] ${m.content}`;
          })
          .join('\n\n');
      },
    },
    {
      name: 'agent_monitor_read_memory',
      description: "Read another agent's active memories. Read-only: no write / update / forget.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        },
      },
      handler: async (args) => {
        const target = asString(args.agent_id);
        if (!target) return 'error: agent_id required';
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const mems = await memory.list(target, limit);
        if (mems.length === 0) return `(agent ${target} has no active memories)`;
        logger.info('ra.agent-monitor.read_memory', { by: agentId, target, count: mems.length });
        return mems.map(m => `[${m.id}] ${m.content}`).join('\n');
      },
    },
  ];
}

/** Convenience: every built-in tool for a ritsu-agent.
 *
 * Always-on (mirroring claude-sdk's auto-wired MCP servers):
 *  - memory_* (4 tools)
 *  - agent_comms_* (2 tools)
 *
 * Allowlist-gated (mirroring claude-sdk's SDK built-ins):
 *  - FS: Read, Write, Edit                — exposed if workspaces present
 *  - Process: Bash, Glob, Grep            — exposed if workspaces present
 *  - Network: WebFetch, WebSearch         — exposed always (no fs scope needed);
 *                                           WebSearch needs RITSU_SEARXNG_URL
 *
 * The toolsAllowlist filter is name-based and case-sensitive (matches the
 * Claude SDK convention: "Read", "Write", "Bash" — capitalized).
 */
export function buildBuiltinTools(deps: RaToolDeps): RaTool[] {
  const out: RaTool[] = [...buildMemoryTools(deps), ...buildAgentCommsTools(deps)];
  const caps = new Set(deps.capabilities ?? []);
  if (caps.has('manage_agents')) out.push(...buildAgentAdminTools(deps));
  if (caps.has('monitor_agents')) out.push(...buildAgentMonitorTools(deps));
  const allowed = new Set(deps.toolsAllowlist ?? []);
  if (deps.workspaces && deps.workspaces.length > 0) {
    out.push(
      ...buildFsTools(deps.workspaces).filter(t => allowed.has(t.name)),
      ...buildProcessTools(deps.workspaces).filter(t => allowed.has(t.name)),
    );
  }
  // Network tools don't need a workspace — they hit the network, not the FS.
  out.push(...buildNetworkTools(deps.network).filter(t => allowed.has(t.name)));
  return out;
}
