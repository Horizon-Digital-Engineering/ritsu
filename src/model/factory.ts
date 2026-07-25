import { ClaudeDirectDispatcher, type ClaudeDirectOpts } from './claude-direct-dispatcher.js';
import { LITELLM_NS } from './ritsu-agent/client.js';
import { RitsuAgentDispatcher } from './ritsu-agent/dispatcher.js';
import type { RaToolDeps } from '../tools/ritsu-agent/builtin.js';
import type { RaProvider, RaProviderOptions } from './ritsu-agent/types.js';
import type { DispatcherKind, ModelDispatcher } from './dispatcher.js';
import type { Workspace } from '../workspace-store.js';
import type { MemoryStore } from '../memory-store.js';
import type { ApiKeyStore } from '../auth/api-key-store.js';
import type { AgentCommsDeps } from '../tools/mcp-internal/agent-comms.js';
import type { AgentAdminDeps } from '../tools/mcp-internal/agent-admin.js';
import type { AgentMonitorDeps } from '../tools/mcp-internal/agent-monitor.js';
import type { ApprovalStore } from '../approval-store.js';
import type { McpProvider } from '../tools/mcp-gateway.js';

/**
 * Per-agent dispatcher options. claude-direct consumes the SDK opts;
 * ritsu-agent consumes the ritsuAgent opts. Both are filled by AgentHost.
 */
export interface DispatcherOpts {
  agentId?: string;
  cwd?: string;
  tools?: string[];
  workspaces?: Workspace[];
  /** MCP providers for the plugins this agent is allowlisted for. */
  plugins?: McpProvider[];
  /**
   * Wire ritsu's memory tools (remember/update_memory/forget/list_memories)
   * into the agent's SDK invocation as MCP tools. Pass the agent_id and
   * the shared MemoryStore; the dispatcher builds a per-agent in-process
   * MCP server so handlers are pre-scoped.
   */
  memory?: { agentId: string; store: MemoryStore };
  /**
   * Wire inter-agent messaging tools (ask_agent, list_agents). The caller's
   * agent_id is closed over so the can_call allowlist + call-depth guard are
   * scoped to this agent.
   */
  comms?: { callerAgentId: string; deps: AgentCommsDeps };
  /**
   * Wire ritsu's agent-admin tools (create/update/reload). Only set when the
   * agent's `capabilities` include 'manage_agents'.
   */
  admin?: { callerAgentId: string; deps: AgentAdminDeps };
  /**
   * Wire ritsu's agent-monitor read-only inspection tools. Only set when
   * the agent's `capabilities` include 'monitor_agents'.
   */
  monitor?: { callerAgentId: string; deps: AgentMonitorDeps };
  /**
   * Human-in-the-loop approval gate. gatedTools is the agent's approval_tools
   * list; when non-empty, the dispatcher blocks on operator approval before
   * each listed tool runs. Currently honored by the claude-direct dispatcher.
   */
  approval?: { agentId: string; store: ApprovalStore; gatedTools: string[] };
  /** CRM email tools — wired when the agent has the 'crm' capability. */
  email?: { agentId: string; secrets: import('../auth/secret-store.js').SecretStore; approvals: ApprovalStore };
  /** CRM social tools — wired when the agent has the 'social' capability. */
  social?: { agentId: string; secrets: import('../auth/secret-store.js').SecretStore; approvals: ApprovalStore };
  /**
   * Ritsu-agent runtime config (Phase B). When present + kind is
   * 'ritsu-agent', the dispatcher uses its own tool-calling loop against
   * an OpenAI-compatible provider instead of the Claude Agent SDK.
   */
  ritsuAgent?: {
    provider: RaProvider;
    /** Null = keyless provider (litellm/custom); the litellm case falls back
     *  to the SecretStore's proxy credentials. */
    apiKeyRef: number | null;
    apiKeys: ApiKeyStore;
    providerOptions?: RaProviderOptions;
    /** Built-in tool deps (memory + agent-comms). Null = no built-ins. */
    toolDeps: RaToolDeps | null;
  };
  /** Secret store, so a dispatcher can resolve its own connector credentials
   *  (e.g. the LiteLLM proxy url/api_key under the 'litellm' namespace). */
  secrets?: import('../auth/secret-store.js').SecretStore;
}

/**
 * One dispatcher instance per agent. All implementations are cheap to
 * construct; if any grows expensive state, swap to a memoized factory
 * keyed on (kind, model, opts).
 */
export function buildDispatcher(kind: DispatcherKind, model: string, opts: DispatcherOpts = {}): ModelDispatcher {
  switch (kind) {
    case 'claude-direct': return new ClaudeDirectDispatcher(model, claudeOptsFrom(opts));
    case 'ritsu-agent':   return new RitsuAgentDispatcher(ritsuAgentOptsFrom(opts, model));
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown dispatcher kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Project DispatcherOpts down to ClaudeDirectOpts, dropping fields that
 *  are undefined so the spread doesn't violate exactOptionalPropertyTypes. */
function claudeOptsFrom(opts: DispatcherOpts): ClaudeDirectOpts {
  const out: ClaudeDirectOpts = {};
  if (opts.cwd        !== undefined) out.cwd        = opts.cwd;
  if (opts.tools      !== undefined) out.tools      = opts.tools;
  if (opts.workspaces !== undefined) out.workspaces = opts.workspaces;
  if (opts.memory     !== undefined) out.memory     = opts.memory;
  if (opts.comms      !== undefined) out.comms      = opts.comms;
  if (opts.admin      !== undefined) out.admin      = opts.admin;
  if (opts.monitor    !== undefined) out.monitor    = opts.monitor;
  if (opts.approval   !== undefined) out.approval   = opts.approval;
  if (opts.email      !== undefined) out.email      = opts.email;
  if (opts.social     !== undefined) out.social     = opts.social;
  if (opts.agentId    !== undefined) out.agentId    = opts.agentId;
  if (opts.plugins    !== undefined) out.plugins    = opts.plugins;
  return out;
}

/** Project DispatcherOpts → RitsuAgentDispatcher constructor args; throws if
 *  the caller forgot to wire the ritsu-agent runtime config. */
function ritsuAgentOptsFrom(opts: DispatcherOpts, defaultModel: string) {
  if (!opts.ritsuAgent) {
    throw new Error('ritsu-agent dispatcher requires opts.ritsuAgent (provider, apiKeyRef, apiKeys, toolDeps)');
  }
  // A keyless litellm agent inherits the proxy connection configured in the
  // SecretStore (admin → connectors), so per-agent config stays optional.
  let providerOptions = opts.ritsuAgent.providerOptions;
  let fallbackApiKey: string | undefined;
  if (opts.ritsuAgent.provider === 'litellm' && opts.ritsuAgent.apiKeyRef === null) {
    const url = opts.secrets?.get(LITELLM_NS, 'url')?.trim();
    if (url && !providerOptions?.base_url) providerOptions = { ...providerOptions, base_url: url };
    fallbackApiKey = opts.secrets?.get(LITELLM_NS, 'api_key')?.trim() || undefined;
  }
  return {
    provider: opts.ritsuAgent.provider,
    apiKeyRef: opts.ritsuAgent.apiKeyRef,
    apiKeys: opts.ritsuAgent.apiKeys,
    defaultModel,
    providerOptions,
    ...(fallbackApiKey !== undefined ? { fallbackApiKey } : {}),
    toolDeps: opts.ritsuAgent.toolDeps,
    // Same approval gate the claude-direct path gets — but here it's the
    // reliable enforcement point (our own loop, no SDK to bypass it).
    ...(opts.approval ? { approval: opts.approval } : {}),
  };
}
