import { ClaudeDirectDispatcher, type ClaudeDirectOpts } from './claude-direct-dispatcher.js';
import { LiteLLMDispatcher } from './litellm-dispatcher.js';
import { RitsuAgentDispatcher } from './ritsu-agent/dispatcher.js';
import type { OpenAIProvider } from './ritsu-agent/openai-client.js';
import type { RaToolDeps } from '../tools/ritsu-agent/builtin.js';
import type { RaProviderOptions } from './ritsu-agent/types.js';
import type { DispatcherKind, ModelDispatcher } from './dispatcher.js';
import type { Workspace } from '../workspace-store.js';
import type { MemoryStore } from '../memory-store.js';
import type { ApiKeyStore } from '../auth/api-key-store.js';
import type { AgentCommsDeps } from '../tools/mcp-internal/agent-comms.js';
import type { AgentAdminDeps } from '../tools/mcp-internal/agent-admin.js';
import type { AgentMonitorDeps } from '../tools/mcp-internal/agent-monitor.js';

/**
 * Per-agent dispatcher options. claude-direct consumes the SDK opts;
 * ritsu-agent consumes the ritsuAgent opts. Both are filled by AgentHost.
 */
export interface DispatcherOpts {
  cwd?: string;
  tools?: string[];
  workspaces?: Workspace[];
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
   * Ritsu-agent runtime config (Phase B). When present + kind is
   * 'ritsu-agent', the dispatcher uses its own tool-calling loop against
   * an OpenAI-compatible provider instead of the Claude Agent SDK.
   */
  ritsuAgent?: {
    provider: OpenAIProvider;
    apiKeyRef: number;
    apiKeys: ApiKeyStore;
    providerOptions?: RaProviderOptions;
    /** Built-in tool deps (memory + agent-comms). Null = no built-ins. */
    toolDeps: RaToolDeps | null;
  };
}

/**
 * One dispatcher instance per agent. All implementations are cheap to
 * construct; if any grows expensive state, swap to a memoized factory
 * keyed on (kind, model, opts).
 */
export function buildDispatcher(kind: DispatcherKind, model: string, opts: DispatcherOpts = {}): ModelDispatcher {
  switch (kind) {
    case 'claude-direct': {
      const claudeOpts: ClaudeDirectOpts = {
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...(opts.tools === undefined ? {} : { tools: opts.tools }),
        ...(opts.workspaces === undefined ? {} : { workspaces: opts.workspaces }),
        ...(opts.memory === undefined ? {} : { memory: opts.memory }),
        ...(opts.comms === undefined ? {} : { comms: opts.comms }),
        ...(opts.admin === undefined ? {} : { admin: opts.admin }),
        ...(opts.monitor === undefined ? {} : { monitor: opts.monitor }),
      };
      return new ClaudeDirectDispatcher(model, claudeOpts);
    }
    case 'litellm':
      // Legacy thin OpenAI-compat shim; superseded by 'ritsu-agent' for new
      // work. Kept around for any agent still configured against it.
      return new LiteLLMDispatcher(model);
    case 'ritsu-agent': {
      if (!opts.ritsuAgent) {
        throw new Error('ritsu-agent dispatcher requires opts.ritsuAgent (provider, apiKeyRef, apiKeys, toolDeps)');
      }
      return new RitsuAgentDispatcher({
        provider: opts.ritsuAgent.provider,
        apiKeyRef: opts.ritsuAgent.apiKeyRef,
        apiKeys: opts.ritsuAgent.apiKeys,
        defaultModel: model,
        providerOptions: opts.ritsuAgent.providerOptions,
        toolDeps: opts.ritsuAgent.toolDeps,
      });
    }
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown dispatcher kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
