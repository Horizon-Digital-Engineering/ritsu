import type { AgentBase, AgentDeps } from './agents/base.js';
import { buildAgent } from './agents/registry.js';
import { buildDispatcher, type DispatcherOpts } from './model/factory.js';
import { SqliteMemoryStore, FlashbackMemoryStore, type MemoryStore } from './memory-store.js';
import type { ConversationStore } from './conversation-store.js';
import type { ModelDispatcher } from './model/dispatcher.js';
import type { AgentDefinition } from './admin/schema.js';
import type { AgentDefinitionStore } from './agent-definition-store.js';
import type { WorkspaceStore } from './workspace-store.js';
import type { ApprovalStore } from './approval-store.js';
import type { Db } from './db.js';
import { logger } from './util/log.js';

/**
 * Hook signature for dispatcher construction. The default points at the
 * production factory; tests pass a fake to avoid real model calls.
 */
export type DispatcherFactory = (
  def: AgentDefinition,
  opts: DispatcherOpts,
) => ModelDispatcher;

/**
 * Owns the live map of agent instances. Reads definitions from the
 * AgentDefinitionStore at boot and rebuilds an instance whenever
 * `addOrReplace`/`remove` is called (admin endpoints invoke these directly
 * after writing to the store — no event bus, no race window).
 */
export class AgentHost {
  private readonly agents = new Map<string, AgentBase>();

  constructor(
    private readonly db: Db,
    private readonly conversations: ConversationStore,
    private readonly defStore: AgentDefinitionStore,
    private readonly workspaces: WorkspaceStore,
    private readonly apiKeys: import('./auth/api-key-store.js').ApiKeyStore,
    private readonly approvals: ApprovalStore,
    private readonly dispatcherFactory: DispatcherFactory = (def, opts) =>
      buildDispatcher(
        // ritsu-agent runtime overrides def.dispatcher when both provider +
        // api_key_ref are set. Falls back to def.dispatcher (claude-direct
        // / litellm) otherwise — existing agents are unchanged.
        def.provider && def.api_key_ref ? 'ritsu-agent' : def.dispatcher,
        def.model,
        opts,
      ),
  ) {}

  async loadAll(): Promise<void> {
    const defs = await this.defStore.list();
    for (const def of defs) this.addOrReplace(def);
    logger.info('host.loaded', { count: defs.length });
  }

  /** Idempotent. Builds the agent fresh from `def` and swaps the instance. */
  addOrReplace(def: AgentDefinition): void {
    if (!def.enabled) {
      if (this.agents.delete(def.id)) {
        logger.info('agent.disabled', { id: def.id });
      }
      return;
    }
    const memory = this.buildMemoryStore(def);
    const workspaces = this.workspaces.listFor(def.id);
    const cwd = workspaces[0]?.path;
    const canManage = def.capabilities.includes('manage_agents');
    const canMonitor = def.capabilities.includes('monitor_agents');
    // For ritsu-agent runtime: same memory + agent-comms toolset, just
    // exposed as native function-calls instead of MCP transport. The
    // dispatcher decides whether to use this (kind === 'ritsu-agent') or
    // the SDK MCP path (kind === 'claude-direct').
    const ritsuAgentToolDeps = def.provider && def.api_key_ref ? {
      agentId: def.id,
      memory,
      defStore: this.defStore,
      conversations: this.conversations,
      host: { get: (id: string) => this.get(id) },
      // Workspace + allowlist plumbing parity with claude-sdk: the same
      // tools_allowlist list ("Read", "Write", "Edit") that controls SDK
      // built-ins for claude-sdk also controls the native FS tools for
      // ritsu-agent. Memory + agent-comms stay always-on.
      workspaces,
      toolsAllowlist: def.tools_allowlist,
      // Per-agent network tool config: provider_options.searxng_url overrides
      // the RITSU_SEARXNG_URL env default for THIS agent only.
      network: typeof (def.provider_options)?.searxng_url === 'string'
        ? { searxng_url: (def.provider_options as Record<string, string>).searxng_url }
        : undefined,
      // Per-agent capabilities flow through to ritsu-agent so the native
      // admin / monitor tool surfaces appear when the flag is set.
      capabilities: def.capabilities,
      adminHost: { addOrReplace: (d: AgentDefinition) => this.addOrReplace(d) },
    } : null;
    const dispatcher = this.dispatcherFactory(def, {
      cwd,
      // tools_allowlist on the definition IS the list of SDK tool names
      // exposed to claude-direct (e.g. ['Read', 'Bash']). Empty array =
      // no tools (the safe default).
      tools: def.tools_allowlist,
      // Full workspace list (with per-path permissions) is consumed by the
      // dispatcher's canUseTool hook for per-call permission enforcement.
      workspaces,
      // Per-agent memory MCP — gives this agent's SDK invocation the
      // remember/update_memory/forget/list_memories tools, scoped to this
      // agent_id. The memory store is the same instance the agent's
      // base.loadContext() reads from, so writes from a turn are visible
      // on the next turn's system prompt.
      memory: { agentId: def.id, store: memory },
      // Per-agent inter-agent messaging MCP — gives this agent ask_agent +
      // list_agents, scoped to this caller. The host reference is `this` so
      // a call routes through the live agent map. defStore is read at call
      // time so admin edits to can_call propagate without a reload.
      comms: {
        callerAgentId: def.id,
        deps: {
          host: { get: (id: string) => this.get(id) },
          defStore: this.defStore,
          conversations: this.conversations,
        },
      },
      ...(canManage ? {
        admin: {
          callerAgentId: def.id,
          deps: {
            defStore: this.defStore,
            host: { addOrReplace: (d) => this.addOrReplace(d) },
          },
        },
      } : {}),
      ...(canMonitor ? {
        monitor: {
          callerAgentId: def.id,
          deps: {
            defStore: this.defStore,
            conversations: this.conversations,
            memory,
          },
        },
      } : {}),
      // Human-in-the-loop: tools this agent must get operator approval for.
      // Only wired when the list is non-empty so unconfigured agents pay
      // nothing. Re-read fresh on every addOrReplace, so editing
      // approval_tools in the admin UI takes effect on the next reload.
      ...(def.approval_tools.length > 0 ? {
        approval: {
          agentId: def.id,
          store: this.approvals,
          gatedTools: def.approval_tools,
        },
      } : {}),
      // Phase B: ritsu-agent runtime config. Only consumed when the
      // factory picks 'ritsu-agent' kind (def.provider + def.api_key_ref set).
      ...(def.provider && def.api_key_ref ? {
        ritsuAgent: {
          provider: def.provider as 'openai' | 'openai-compat' | 'litellm',
          apiKeyRef: def.api_key_ref,
          apiKeys: this.apiKeys,
          providerOptions: def.provider_options,
          toolDeps: ritsuAgentToolDeps,
        },
      } : {}),
    });
    const deps: AgentDeps = { memory, conversations: this.conversations, dispatcher };
    this.agents.set(def.id, buildAgent(def, deps));
    const effectiveDispatcher = def.provider && def.api_key_ref ? 'ritsu-agent' : def.dispatcher;
    logger.info('agent.wired', {
      id: def.id,
      type: def.type,
      dispatcher: effectiveDispatcher,
      model: def.model,
      provider: def.provider ?? null,
      memory_backend: def.memory_backend,
      workspace: cwd ?? null,
      tools_count: def.tools_allowlist.length,
      capabilities: def.capabilities,
    });
  }

  remove(id: string): void {
    if (this.agents.delete(id)) logger.info('agent.removed', { id });
  }

  list(): Array<{ id: string; name: string; description: string }> {
    return [...this.agents.values()].map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
    }));
  }

  get(id: string): AgentBase {
    const a = this.agents.get(id);
    if (!a) throw new Error(`Unknown or disabled agent: ${id}`);
    return a;
  }

  private buildMemoryStore(def: AgentDefinition): MemoryStore {
    switch (def.memory_backend) {
      case 'sqlite':
        return new SqliteMemoryStore(this.db);
      case 'flashback':
        // V1: only one backend type works. The schema accepts 'flashback' so
        // V2 wiring is a one-line change here.
        return new FlashbackMemoryStore({ endpoint: '', apiKey: '' });
      default: {
        const _exhaustive: never = def.memory_backend;
        throw new Error(`Unknown memory_backend: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
}
