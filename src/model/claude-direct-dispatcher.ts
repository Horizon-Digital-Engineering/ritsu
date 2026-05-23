import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ChatRequest, ChatResponse, ModelDispatcher } from './dispatcher.js';
import type { Workspace } from '../workspace-store.js';
import type { MemoryStore } from '../memory-store.js';
import { checkToolUse } from '../tools/permissions.js';
import { buildAgentMemoryMcp, MEMORY_TOOL_NAMES, MEMORY_MCP_NAME } from '../tools/mcp-internal/memory.js';
import {
  buildAgentCommsMcp, COMMS_TOOL_NAMES, COMMS_MCP_NAME,
  type AgentCommsDeps,
} from '../tools/mcp-internal/agent-comms.js';
import {
  buildAgentAdminMcp, ADMIN_TOOL_NAMES, ADMIN_MCP_NAME,
  type AgentAdminDeps,
} from '../tools/mcp-internal/agent-admin.js';
import {
  buildAgentMonitorMcp, MONITOR_TOOL_NAMES, MONITOR_MCP_NAME,
  type AgentMonitorDeps,
} from '../tools/mcp-internal/agent-monitor.js';
import { logger } from '../util/log.js';

/**
 * Uses @anthropic-ai/claude-agent-sdk, which reads the Max-plan CLI session
 * from ~/.claude/. $0 marginal cost.
 *
 * V0.4: per-agent `cwd`, tool allowlist, AND per-tool permission enforcement
 * via the SDK's canUseTool callback. checkToolUse maps each call to a
 * required workspace permission (Read→'read', Write→'write', Bash→'exec',
 * Web*→network) and denies with a reason the model will see in the result.
 */
export interface ClaudeDirectOpts {
  /** Working directory the agent operates in (taken from its workspaces[0].path). */
  cwd?: string;
  /** Allowlist of SDK tool names. Empty/undefined = no tools. */
  tools?: string[];
  /** Per-agent workspaces. Used to authorize each tool call. */
  workspaces?: Workspace[];
  /**
   * Wire ritsu's per-agent memory tools (remember / update_memory / forget /
   * list_memories) into this agent's SDK invocation. When provided, an
   * in-process MCP server is built with the agent_id closed over so every
   * call is scoped to this one agent. Pass null / undefined to disable.
   */
  memory?: { agentId: string; store: MemoryStore };
  /**
   * Wire ritsu's per-agent inter-agent messaging tools (ask_agent, list_agents)
   * into this agent's SDK invocation. The caller's agent_id is closed over so
   * the can_call allowlist + AsyncLocalStorage call-depth guard are correctly
   * scoped. Omit to disable inter-agent comms for this dispatcher.
   */
  comms?: { callerAgentId: string; deps: AgentCommsDeps };
  /**
   * Wire ritsu's agent-admin tools (create / update / reload) into this
   * agent's SDK invocation. Only set when the agent's `capabilities`
   * include 'manage_agents' — the gate lives at the AgentHost layer.
   */
  admin?: { callerAgentId: string; deps: AgentAdminDeps };
  /**
   * Wire ritsu's agent-monitor read-only inspection tools. Only set when
   * the agent's `capabilities` include 'monitor_agents'.
   */
  monitor?: { callerAgentId: string; deps: AgentMonitorDeps };
}

export class ClaudeDirectDispatcher implements ModelDispatcher {
  readonly kind = 'claude-direct' as const;

  constructor(
    readonly defaultModel: string = 'claude-sonnet-4-6',
    private readonly opts: ClaudeDirectOpts = {},
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model ?? this.defaultModel;
    const systemMsg = req.messages
      .filter(m => m.role === 'system')
      .map(m => m.content)
      .join('\n\n');
    const userPrompt = req.messages
      .filter(m => m.role !== 'system')
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');

    logger.debug('claude-direct.chat', {
      model,
      msg_count: req.messages.length,
      cwd: this.opts.cwd,
      tools_count: this.opts.tools?.length ?? 0,
      workspace_count: this.opts.workspaces?.length ?? 0,
    });

    const workspaces = this.opts.workspaces ?? [];
    // The canUseTool gate fires on EVERY tool the SDK is about to invoke,
    // including the memory + comms MCP tools and any other custom MCP servers.
    // Allow memory + comms tools unconditionally (they're already authorized
    // by being on the per-agent in-process MCP — the tool handlers do their
    // own allowlist + loop-guard checks). Route everything else through
    // checkToolUse which only knows about workspace permissions for built-in
    // FS tools.
    const inProcessMcpTools = new Set<string>([
      ...MEMORY_TOOL_NAMES,
      ...COMMS_TOOL_NAMES,
      ...ADMIN_TOOL_NAMES,
      ...MONITOR_TOOL_NAMES,
    ]);
    const canUseTool = (workspaces.length === 0 && !this.opts.memory && !this.opts.comms && !this.opts.admin && !this.opts.monitor)
      ? undefined
      : async (toolName: string, input: Record<string, unknown>) => {
          if (inProcessMcpTools.has(toolName)) {
            return { behavior: 'allow' as const, updatedInput: input };
          }
          const result = checkToolUse(toolName, input, workspaces);
          if (result.ok) {
            return { behavior: 'allow' as const, updatedInput: input };
          }
          logger.warn('tool.denied', { tool: toolName, reason: result.reason });
          return { behavior: 'deny' as const, message: result.reason };
        };

    // Build per-agent in-process MCP servers. Each closes the caller's
    // agent_id over its handlers so identity can't be spoofed by tool args.
    const memoryServer = this.opts.memory
      ? buildAgentMemoryMcp(this.opts.memory.agentId, this.opts.memory.store)
      : null;
    const commsServer = this.opts.comms
      ? buildAgentCommsMcp(this.opts.comms.callerAgentId, this.opts.comms.deps)
      : null;
    const adminServer = this.opts.admin
      ? buildAgentAdminMcp(this.opts.admin.callerAgentId, this.opts.admin.deps)
      : null;
    const monitorServer = this.opts.monitor
      ? buildAgentMonitorMcp(this.opts.monitor.callerAgentId, this.opts.monitor.deps)
      : null;
    const mcpServers: Record<string, ReturnType<typeof buildAgentMemoryMcp>> = {};
    if (memoryServer) mcpServers[MEMORY_MCP_NAME] = memoryServer;
    if (commsServer) mcpServers[COMMS_MCP_NAME] = commsServer;
    if (adminServer) mcpServers[ADMIN_MCP_NAME] = adminServer;
    if (monitorServer) mcpServers[MONITOR_MCP_NAME] = monitorServer;
    const haveMcpServers = Object.keys(mcpServers).length > 0;

    // The SDK's `tools` option allowlists BUILT-IN tools only (Read, Bash, ...).
    // For MCP tools we have to add their fully-qualified names to allowedTools.
    // Otherwise the SDK strips them out of the model's toolbelt even though
    // the server is registered. Same gotcha that bit me on the OAuth work.
    const allowedTools: string[] = [];
    if (memoryServer) allowedTools.push(...MEMORY_TOOL_NAMES);
    if (commsServer) allowedTools.push(...COMMS_TOOL_NAMES);
    if (adminServer) allowedTools.push(...ADMIN_TOOL_NAMES);
    if (monitorServer) allowedTools.push(...MONITOR_TOOL_NAMES);
    const haveAllowedTools = allowedTools.length > 0;

    for await (const event of query({
      prompt: userPrompt,
      options: {
        systemPrompt: systemMsg,
        model,
        ...(this.opts.cwd === undefined ? {} : { cwd: this.opts.cwd }),
        ...(this.opts.tools === undefined ? {} : { tools: this.opts.tools }),
        ...(haveMcpServers ? { mcpServers } : {}),
        ...(haveAllowedTools ? { allowedTools } : {}),
        ...(canUseTool ? { canUseTool } : {}),
      },
    })) {
      if (event.type !== 'result') continue;
      if (event.subtype === 'success') {
        return {
          content: event.result,
          model,
          usage: {
            // The SDK types usage as unknown; narrow at the boundary so the
            // returned shape is the documented number-or-undefined pair.
            input_tokens: (event.usage as { input_tokens?: number } | undefined)?.input_tokens,
            output_tokens: (event.usage as { output_tokens?: number } | undefined)?.output_tokens,
          },
          raw: event,
        };
      }
      const errs = 'errors' in event ? event.errors.join('; ') : 'unknown';
      throw new Error(`Claude SDK error: ${event.subtype} (${errs})`);
    }

    throw new Error('Claude SDK stream ended without a result message');
  }
}
