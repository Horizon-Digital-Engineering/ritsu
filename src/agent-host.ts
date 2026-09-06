import type { AgentBase, AgentDeps } from './agents/base.js';
import { buildAgent } from './agents/registry.js';
import { ProjectStore } from './project-store.js';
import { SkillStore } from './skill-store.js';
import { buildDispatcher, type DispatcherOpts } from './model/factory.js';
import { SqliteMemoryStore, type MemoryStore } from './memory-store.js';
import type { ConversationStore } from './conversation-store.js';
import type { DispatcherKind, ModelDispatcher } from './model/dispatcher.js';
import type { RaProvider } from './model/ritsu-agent/types.js';
import type { AgentDefinition } from './admin/schema.js';
import type { AgentDefinitionStore } from './agent-definition-store.js';
import type { WorkspaceStore } from './workspace-store.js';
import type { ApprovalStore } from './approval-store.js';
import type { CommsDenialStore } from './comms-denial-store.js';
import type { SecretStore } from './auth/secret-store.js';
import type { Db } from './db.js';
import type { PluginHost } from './plugins/host.js';
import type { JobStore } from './scheduler/store.js';
import { pluginMcpProvider, pluginGatedToolNames } from './plugins/mcp-provider.js';
import type { PluginToolSet } from './tools/ritsu-agent/plugin.js';
import type { MemoryService } from './memory/service.js';
import type { SettingsStore } from './settings-store.js';
import { isSearchProvider, type SearchConfig } from './tools/ritsu-agent/search.js';
import { SEARCH_NS } from './tools/ritsu-agent/search-config.js';
import { logger } from './util/log.js';

/**
 * Hook signature for dispatcher construction. The default points at the
 * production factory; tests pass a fake to avoid real model calls.
 */
export type DispatcherFactory = (
  def: AgentDefinition,
  opts: DispatcherOpts,
) => ModelDispatcher;

/** runtime 'api' → our loop; runtime 'direct' → the vendor dispatcher for
 *  that provider ('claude' today; chatgpt/gemini/grok as they ship). */
export function dispatcherKindFor(def: AgentDefinition): DispatcherKind {
  if (def.runtime === 'api') return 'ritsu-agent';
  if (def.provider === 'claude') return 'claude-direct';
  throw new Error(`direct runtime has no dispatcher for provider '${def.provider}' yet`);
}

/**
 * Owns the live map of agent instances. Reads definitions from the
 * AgentDefinitionStore at boot and rebuilds an instance whenever
 * `addOrReplace`/`remove` is called (admin endpoints invoke these directly
 * after writing to the store — no event bus, no race window).
 */
/**
 * Which `approval_tools` entries this agent's runtime cannot actually enforce.
 *
 * On `api` ritsu owns the loop, so every tool call passes the gate — nothing is
 * ungateable. On `direct` the vendor SDK runs its own built-ins without
 * consulting us; only in-process MCP tools (`mcp__*`) reach a handler that
 * calls `gateMcpTool`. Naming a built-in there is silently inert, which is
 * worse than not gating at all — the operator believes there is a gate.
 */
export function ungateableApprovalTools(
  approvalTools: readonly string[],
  runtime: AgentDefinition['runtime'],
): string[] {
  if (runtime === 'api') return [];
  return approvalTools.filter(t => !t.startsWith('mcp__'));
}

export class AgentHost {
  private readonly agents = new Map<string, AgentBase>();
  private pluginHost?: PluginHost;
  private jobStore?: JobStore;
  private readonly projects: ProjectStore;
  private readonly skills: SkillStore;
  /** Per-agent `approval_tools` entries the runtime cannot enforce. Surfaced by
   *  the admin API so a save says so instead of only the log. */
  private readonly ungateable = new Map<string, string[]>();
  private memoryService?: MemoryService;
  private settings?: SettingsStore;

  /** Wired after construction: the store exists only once the DB is open. */
  setSettings(s: SettingsStore): void { this.settings = s; }

  /** Injected after construction (pluginHost is built alongside AgentHost in
   *  index.ts). When unset, agents simply get no plugin tools. */
  setPluginHost(h: PluginHost): void { this.pluginHost = h; }
  /** Wired after construction: the store exists only once the DB is open. */
  setJobStore(j: JobStore): void { this.jobStore = j; }

  /** The operator's configured search backend, read fresh per agent build so
   *  saving a new provider applies on reload rather than at restart. Provider
   *  and endpoint are settings; the API key is a secret. */
  private searchConfig(): SearchConfig | undefined {
    if (!this.settings) return undefined;
    const raw = this.settings.get('search.provider');
    if (!raw || !isSearchProvider(raw)) return undefined;
    const url = this.settings.get('search.url')?.trim();
    const apiKey = this.secrets.get(SEARCH_NS, 'api_key')?.trim();
    return {
      provider: raw,
      ...(url ? { url } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  }

  /** Flow-level memory over the MemoryBackend seam. Injected after
   *  construction (built alongside AgentHost in index.ts). When unset, agents
   *  keep exactly today's static-RAG behavior — no getContext, no turn record. */
  setMemoryService(s: MemoryService): void { this.memoryService = s; }

  constructor(
    private readonly db: Db,
    private readonly conversations: ConversationStore,
    private readonly defStore: AgentDefinitionStore,
    private readonly workspaces: WorkspaceStore,
    private readonly apiKeys: import('./auth/api-key-store.js').ApiKeyStore,
    private readonly approvals: ApprovalStore,
    private readonly secrets: SecretStore,
    private readonly commsDenials: CommsDenialStore,
    private readonly dispatcherFactory: DispatcherFactory = (def, opts) =>
      buildDispatcher(
        dispatcherKindFor(def),
        def.model,
        { ...opts, secrets: this.secrets },
      ),
  ) {
    this.projects = new ProjectStore(db);
    this.skills = new SkillStore(db);}

  async loadAll(): Promise<void> {
    const defs = await this.defStore.list();
    let failed = 0;
    for (const def of defs) {
      // One unbuildable definition disables that agent, never the server.
      // Without this a single bad row — a backend that throws, a provider with
      // no dispatcher — takes the process down on every boot, and the row is
      // only editable through the admin API the crash prevents from starting.
      try {
        this.addOrReplace(def);
      } catch (err) {
        failed++;
        logger.error('agent.wire-failed', { id: def.id, err: (err as Error).message });
      }
    }
    logger.info('host.loaded', { count: defs.length - failed, ...(failed ? { failed } : {}) });
  }

  /** Rebuild every agent whose allowlist includes `pluginId`, so a plugin
   *  enable/disable/uninstall revokes (or restores) its tools on live agents —
   *  not just at next reload. Called by the plugin admin endpoints. */
  async reloadForPlugin(pluginId: string): Promise<void> {
    const affected = (await this.defStore.list()).filter(d => d.plugins.includes(pluginId));
    for (const def of affected) this.addOrReplace(def);
    if (affected.length) logger.info('host.reloaded-for-plugin', { plugin: pluginId, agents: affected.length });
  }

  /**
   * SECURITY: an agent that reads untrusted content (email bodies, social
   * mentions) must not have an UNGATED egress/persistence path, or a
   * prompt-injected message could exfiltrate or self-persist with no
   * operator approval. So for crm/social agents we auto-gate every egress +
   * persistence tool: shell/web (exfil), Write/Edit (persist attacker
   * content to a possibly-synced workspace), every memory mutation incl.
   * forget (so injection can't silently tombstone the agent's own security
   * memories), and ask_agent (so attacker text can't be laundered to a peer
   * with an ungated egress path).
   *
   * The ritsu-agent (open-model) runtime is the REAL enforcement layer here:
   * we own that loop, so these gates are unbypassable. claude-direct can't be
   * a trust boundary — the Max-session SDK runs built-ins without consulting
   * our hook — so for it we STRIP the ungateable built-ins rather than
   * pretend to gate them. An operator who wants a hard gate uses ritsu-agent.
   */
  private resolveInjectionGating(def: AgentDefinition, isRitsuAgent: boolean):
    { effectiveTools: string[]; autoGated: string[] } {
    const UNGATEABLE_BUILTIN_EGRESS = new Set(['Bash', 'WebFetch', 'WebSearch', 'Write', 'Edit']);
    if (isRitsuAgent) {
      // Our own loop gates these reliably — require approval, don't strip.
      return {
        effectiveTools: def.tools_allowlist,
        autoGated: [
          'memory_remember', 'memory_update_memory', 'memory_forget',
          'agent_comms_ask_agent',
          // Own-history recall replays past (possibly channel-borne) content
          // into fresh context — hold it behind the operator too.
          'history_search_chats', 'history_view_chat',
          // Scheduling is the most durable self-persistence there is: a job
          // feeds attacker text back as a user turn on a timer and delivers
          // the reply to every channel, outliving the conversation the
          // injection arrived in.
          'schedule_create', 'schedule_pause', 'schedule_remove',
          // Minting or patching an agent is a privilege-escalation primitive:
          // the new agent carries whatever the caller writes into it.
          'agent_admin_create_agent', 'agent_admin_update_agent', 'agent_admin_reload_agent',
          ...UNGATEABLE_BUILTIN_EGRESS,
        ],
      };
    }
    // memory_forget + ask_agent gate via gateMcpTool inside their handlers
    // (the path the SDK can't bypass); the built-in egress tools can't, so
    // strip those.
    const autoGated = [
      'mcp__scheduler__schedule_create', 'mcp__scheduler__schedule_pause',
      'mcp__scheduler__schedule_remove',
      'mcp__memory__remember', 'mcp__memory__update_memory', 'mcp__memory__forget',
      'mcp__agent_comms__ask_agent',
      'mcp__agent_admin__create_agent', 'mcp__agent_admin__update_agent',
      'mcp__agent_admin__reload_agent',
      'mcp__history__search_chats', 'mcp__history__view_chat',
    ];
    let effectiveTools = def.tools_allowlist;
    const stripped = def.tools_allowlist.filter(t => UNGATEABLE_BUILTIN_EGRESS.has(t));
    if (stripped.length) {
      effectiveTools = def.tools_allowlist.filter(t => !UNGATEABLE_BUILTIN_EGRESS.has(t));
      logger.warn('agent.crm-egress-stripped', { id: def.id, stripped });
    }
    return { effectiveTools, autoGated };
  }

  /** Resolve the agent's plugin allowlist into MCP providers. A plugin that
   *  isn't installed, isn't enabled, or has no agent tools is skipped — so a
   *  disabled/removed plugin makes the allowlist entry inert, not broken.
   *  Every plugin flows through the same gateway; adding one needs no new code. */
  private resolvePluginTools(def: AgentDefinition): {
    pluginProviders: ReturnType<typeof pluginMcpProvider>[];
    pluginToolSets: PluginToolSet[];
    pluginGated: string[];
    pluginAll: string[];
  } {
    const pluginProviders: ReturnType<typeof pluginMcpProvider>[] = [];
    const pluginToolSets: PluginToolSet[] = [];
    const pluginGated: string[] = [];
    const pluginAll: string[] = [];
    for (const pid of def.plugins) {
      const tools = this.pluginHost?.isEnabled(pid) ? this.pluginHost.toolsFor(pid) : [];
      if (!tools.length) continue;
      pluginProviders.push(pluginMcpProvider(pid, tools));
      pluginToolSets.push({ id: pid, tools });
      pluginGated.push(...pluginGatedToolNames(pid, tools));
      pluginAll.push(...tools.map(t => `mcp__${pid}__${t.name}`));
    }
    return { pluginProviders, pluginToolSets, pluginGated, pluginAll };
  }

  /** The capability-conditional slice of the dispatcher deps: admin/monitor
   *  tool surfaces, the approval gate, CRM extensions, scheduling. Split out
   *  so addOrReplace reads as a wiring list rather than a branch forest. */
  private capabilityDispatcherDeps(def: AgentDefinition, ctx: {
    memory: ReturnType<AgentHost['buildMemoryStore']>;
    gatedTools: string[];
    readsUntrusted: boolean;
    canManage: boolean;
    canMonitor: boolean;
    canCrm: boolean;
    canSocial: boolean;
  }): Partial<DispatcherOpts> {
    const out: Partial<DispatcherOpts> = {};
    if (ctx.canManage) {
      out.admin = {
        callerAgentId: def.id,
        deps: {
          defStore: this.defStore,
          host: { addOrReplace: (d) => this.addOrReplace(d) },
        },
      };
    }
    if (ctx.canMonitor) {
      out.monitor = {
        callerAgentId: def.id,
        deps: {
          defStore: this.defStore,
          conversations: this.conversations,
          memory: ctx.memory,
        },
      };
    }
    // Human-in-the-loop: tools this agent must get operator approval for.
    // Wired when the gated list is non-empty OR the agent opts into
    // approvable escalation (which needs the ApprovalStore on the comms path
    // even with no other gated tools). Re-read fresh on every addOrReplace,
    // so editing approval_tools / escalation_approvable in the admin UI takes
    // effect on the next reload.
    // crm/social also need it unconditionally: their send/post tools block
    // on the operator from inside their own handlers, independent of
    // approval_tools.
    if (ctx.gatedTools.length > 0 || def.escalation_approvable || ctx.readsUntrusted) {
      out.approval = {
        agentId: def.id,
        store: this.approvals,
        gatedTools: ctx.gatedTools,
      };
    }
    // CRM email extension — only when the agent has the 'crm' capability.
    // send_email always blocks on approval, so the gate store rides along
    // independent of approval_tools. Credentials are resolved from the
    // SecretStore inside the tool handlers, never exposed to the model.
    if (ctx.canCrm) {
      out.email = { agentId: def.id, secrets: this.secrets, approvals: this.approvals };
    }
    // CRM social extension — X/Twitter tools when the agent has 'social'.
    // post_tweet always blocks on approval.
    if (ctx.canSocial) {
      out.social = { agentId: def.id, secrets: this.secrets, approvals: this.approvals };
    }
    // Scheduling, for every agent regardless of runtime. The native loop
    // gets the same tools through ritsuAgentToolDeps; this is the direct-
    // runtime half, which is the default and would otherwise have none.
    if (this.jobStore) out.scheduler = { store: this.jobStore };
    return out;
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
    const canCrm = def.capabilities.includes('crm');
    const canSocial = def.capabilities.includes('social');
    const isRitsuAgent = def.runtime === 'api';

    const readsUntrusted = canCrm || canSocial;
    const { effectiveTools, autoGated } = readsUntrusted
      ? this.resolveInjectionGating(def, isRitsuAgent)
      : { effectiveTools: def.tools_allowlist, autoGated: [] as string[] };
    const { pluginProviders, pluginToolSets, pluginGated, pluginAll } = this.resolvePluginTools(def);
    // Injection-exposed agents (crm/social) get NO ungated plugin egress: every
    // plugin tool they can call is force-gated, not just the ones a plugin author
    // flagged needsApproval — the same hard rail the built-in egress tools get.
    // Normal agents gate only the plugin's declared-mutating tools.
    const pluginGating = readsUntrusted ? pluginAll : pluginGated;
    const gatedTools = [...new Set([...def.approval_tools, ...autoGated, ...pluginGating])];
    // Fail loudly rather than logging an enforced-looking list that isn't.
    const ungateable = ungateableApprovalTools(def.approval_tools, def.runtime);
    if (ungateable.length) {
      logger.warn('agent.approval-tools-ungateable', {
        id: def.id, runtime: def.runtime, tools: ungateable,
      });
    }
    this.ungateable.set(def.id, ungateable);
    // For ritsu-agent runtime: same memory + agent-comms toolset, just
    // exposed as native function-calls instead of MCP transport. The
    // dispatcher decides whether to use this (kind === 'ritsu-agent') or
    // the SDK MCP path (kind === 'claude-direct').
    const ritsuAgentToolDeps = isRitsuAgent ? {
      agentId: def.id,
      memory,
      defStore: this.defStore,
      conversations: this.conversations,
      denials: this.commsDenials,
      host: { get: (id: string) => this.get(id) },
      // Workspace + allowlist plumbing parity with claude-sdk: the same
      // tools_allowlist list ("Read", "Write", "Edit") that controls SDK
      // built-ins for claude-sdk also controls the native FS tools for
      // ritsu-agent. Memory + agent-comms stay always-on.
      workspaces,
      toolsAllowlist: def.tools_allowlist,
      // Network tools: the operator's search backend, with a per-agent
      // searxng URL override from provider_options for THIS agent only.
      network: {
        ...(this.searchConfig() ? { search: this.searchConfig()! } : {}),
        ...(typeof (def.provider_options)?.searxng_url === 'string'
          ? { searxng_url: (def.provider_options as Record<string, string>).searxng_url }
          : {}),
      },
      // Per-agent capabilities flow through to ritsu-agent so the native
      // admin / monitor tool surfaces appear when the flag is set.
      capabilities: def.capabilities,
      adminHost: { addOrReplace: (d: AgentDefinition) => this.addOrReplace(d) },
      // Plugin tools reach the native loop too (parity with claude-direct).
      // The same mcp__<id>__<name> gatedTools list below gates them.
      plugins: pluginToolSets,
      jobs: this.jobStore,
      // CRM credentials. The native email/social tools resolve the mailbox
      // and social accounts through this; the model never sees them.
      secrets: this.secrets,
      skillsLookup: {
        manifest: () => this.skills.manifestFor(def.id),
        content: (name: string) => this.skills.contentFor(def.id, name),
      },
    } : null;
    const dispatcher = this.dispatcherFactory(def, {
      agentId: def.id,
      plugins: pluginProviders,
      cwd,
      // tools_allowlist on the definition IS the list of SDK tool names
      // exposed to claude-direct (e.g. ['Read', 'Bash']). Empty array =
      // no tools (the safe default). effectiveTools drops ungate-able egress
      // for content-reading agents (see SECURITY note above).
      tools: effectiveTools,
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
          denials: this.commsDenials,
        },
      },
      ...this.capabilityDispatcherDeps(def, { memory, gatedTools, readsUntrusted, canManage, canMonitor, canCrm, canSocial }),
      skillsLookup: {
        manifest: () => this.skills.manifestFor(def.id),
        content: (name: string) => this.skills.contentFor(def.id, name),
      },
      history: { conversations: this.conversations },
      // api-runtime config. Only consumed when the factory picks the
      // 'ritsu-agent' kind (def.runtime === 'api').
      ...(isRitsuAgent ? {
        ritsuAgent: {
          provider: def.provider as RaProvider,
          apiKeyRef: def.api_key_ref,
          apiKeys: this.apiKeys,
          providerOptions: def.provider_options,
          toolDeps: ritsuAgentToolDeps,
        },
      } : {}),
    });
    const deps: AgentDeps = {
      memory, conversations: this.conversations, dispatcher,
      // Flow-level memory: wired only when a MemoryService is set on the host.
      // Absent => today's static-RAG behavior, unchanged.
      ...(this.memoryService ? { memoryService: this.memoryService } : {}),
      // Project prompt inheritance + the lazy skills manifest. Read live from
      // the DB per turn, so filing a chat or binding a skill takes effect on
      // the very next message without a reload.
      projectPrompt: (cid) => this.projects.promptForConversation(cid),
      skills: {
        manifest: () => this.skills.manifestFor(def.id),
        content: (name) => this.skills.contentFor(def.id, name),
      },
    };
    this.agents.set(def.id, buildAgent(def, deps));
    logger.info('agent.wired', {
      id: def.id,
      type: def.type,
      runtime: def.runtime,
      dispatcher: dispatcherKindFor(def),
      model: def.model,
      provider: def.provider,
      memory_backend: def.memory_backend,
      workspace: cwd ?? null,
      tools_count: effectiveTools.length,
      capabilities: def.capabilities,
      gated_tools: gatedTools,
    });
  }

  remove(id: string): void {
    if (this.agents.delete(id)) logger.info('agent.removed', { id });
    this.ungateable.delete(id);
  }

  /** `approval_tools` entries wired for this agent that its runtime cannot
   *  enforce. Empty when everything named is really gated. */
  ungateableFor(id: string): string[] {
    return this.ungateable.get(id) ?? [];
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
      default: {
        // The per-agent backend is sqlite-only. A remote store is reached
        // through the MemoryService seam, configured once for the server, not
        // chosen per agent.
        const _exhaustive: never = def.memory_backend;
        throw new Error(`Unknown memory_backend: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
}
