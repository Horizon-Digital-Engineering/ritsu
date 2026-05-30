import { query, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { ChatRequest, ChatResponse, ChatMessage, ModelDispatcher } from './dispatcher.js';
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
    const { systemMsg, userPrompt } = formatMessages(req.messages);

    logger.debug('claude-direct.chat', {
      model,
      msg_count: req.messages.length,
      cwd: this.opts.cwd,
      tools_count: this.opts.tools?.length ?? 0,
      workspace_count: this.opts.workspaces?.length ?? 0,
    });

    const workspaces = this.opts.workspaces ?? [];
    const canUseTool = buildCanUseToolCallback(workspaces, this.opts);
    const { mcpServers, allowedTools } = buildMcpServers(this.opts);

    // Cache the most recent non-empty text from any 'assistant' event as the
    // stream flows by. When the agent's final action is a tool_use (e.g.
    // mcp__memory__update_memory) without a follow-up text turn, the SDK's
    // terminal result message has `result: ""` and the user sees a blank
    // reply. The last cached assistant text is the right thing to return in
    // that case — it's the model's most recent words to the user.
    let lastAssistantText = '';
    for await (const event of query({
      prompt: userPrompt,
      options: {
        systemPrompt: systemMsg,
        model,
        ...(this.opts.cwd === undefined ? {} : { cwd: this.opts.cwd }),
        ...(this.opts.tools === undefined ? {} : { tools: this.opts.tools }),
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        ...(allowedTools.length > 0 ? { allowedTools } : {}),
        ...(canUseTool ? { canUseTool } : {}),
      },
    })) {
      const text = extractAssistantText(event);
      if (text) lastAssistantText = text;
      const result = extractResult(event, model);
      if (result) {
        if (!result.content && lastAssistantText) {
          logger.debug('claude-direct.result-fallback', {
            reason: 'empty-result-using-last-assistant-text',
            len: lastAssistantText.length,
          });
          return { ...result, content: lastAssistantText };
        }
        return result;
      }
    }

    throw new Error('Claude SDK stream ended without a result message');
  }
}

// ---- helpers ---------------------------------------------------------------

/** Split a flat message list into the SDK's expected (systemPrompt, userPrompt)
 *  shape. System turns concatenate into systemPrompt; everything else becomes
 *  a single user-prompt blob with role-prefixed lines. */
function formatMessages(messages: readonly ChatMessage[]): { systemMsg: string; userPrompt: string } {
  const systemMsg = messages
    .filter(m => m.role === 'system')
    .map(m => m.content)
    .join('\n\n');
  const userPrompt = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');
  return { systemMsg, userPrompt };
}

/** Names of in-process MCP tools that are pre-authorized by their per-agent
 *  servers. Memoised at module load — these never change at runtime. */
const IN_PROCESS_MCP_TOOLS = new Set<string>([
  ...MEMORY_TOOL_NAMES,
  ...COMMS_TOOL_NAMES,
  ...ADMIN_TOOL_NAMES,
  ...MONITOR_TOOL_NAMES,
]);

/**
 * Build the SDK's `canUseTool` callback. Returns undefined when no permission
 * gate is needed (no workspaces AND no in-process MCP servers wired). The
 * callback allows in-process MCP tools unconditionally (their handlers do
 * their own allowlist + loop-guard checks) and routes everything else through
 * checkToolUse which enforces workspace permissions on built-in FS tools.
 */
function buildCanUseToolCallback(
  workspaces: Workspace[],
  opts: ClaudeDirectOpts,
): CanUseTool | undefined {
  if (workspaces.length === 0 && !opts.memory && !opts.comms && !opts.admin && !opts.monitor) {
    return undefined;
  }
  return async (toolName, input) => {
    if (IN_PROCESS_MCP_TOOLS.has(toolName)) {
      return { behavior: 'allow' as const, updatedInput: input };
    }
    const result = checkToolUse(toolName, input, workspaces);
    if (result.ok) return { behavior: 'allow' as const, updatedInput: input };
    logger.warn('tool.denied', { tool: toolName, reason: result.reason });
    return { behavior: 'deny' as const, message: result.reason };
  };
}

/**
 * Build the SDK's mcpServers map + the matching allowedTools list. The SDK's
 * `tools` option allowlists BUILT-IN tools only (Read, Bash, ...); MCP tools
 * have to be named in `allowedTools` by their fully-qualified `mcp__*__*`
 * name or the SDK strips them from the model's toolbelt even when the server
 * is registered.
 */
function buildMcpServers(opts: ClaudeDirectOpts): {
  mcpServers: Record<string, ReturnType<typeof buildAgentMemoryMcp>>;
  allowedTools: string[];
} {
  const mcpServers: Record<string, ReturnType<typeof buildAgentMemoryMcp>> = {};
  const allowedTools: string[] = [];
  if (opts.memory) {
    mcpServers[MEMORY_MCP_NAME] = buildAgentMemoryMcp(opts.memory.agentId, opts.memory.store);
    allowedTools.push(...MEMORY_TOOL_NAMES);
  }
  if (opts.comms) {
    mcpServers[COMMS_MCP_NAME] = buildAgentCommsMcp(opts.comms.callerAgentId, opts.comms.deps);
    allowedTools.push(...COMMS_TOOL_NAMES);
  }
  if (opts.admin) {
    mcpServers[ADMIN_MCP_NAME] = buildAgentAdminMcp(opts.admin.callerAgentId, opts.admin.deps);
    allowedTools.push(...ADMIN_TOOL_NAMES);
  }
  if (opts.monitor) {
    mcpServers[MONITOR_MCP_NAME] = buildAgentMonitorMcp(opts.monitor.callerAgentId, opts.monitor.deps);
    allowedTools.push(...MONITOR_TOOL_NAMES);
  }
  return { mcpServers, allowedTools };
}

/**
 * Pull joined plain-text from an 'assistant' SDK event's content blocks.
 * The model emits a `BetaMessage` per assistant turn whose `content` is an
 * array of typed blocks; we join every `{ type: 'text', text }` block and
 * drop the rest (tool_use, thinking, etc.). Returns '' for non-assistant
 * events, malformed shapes, or turns that contained no text blocks.
 */
export function extractAssistantText(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const e = event as { type?: string; message?: { content?: unknown } };
  if (e.type !== 'assistant') return '';
  const blocks = e.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b): b is { type: string; text: string } =>
      typeof b === 'object' && b !== null
      && (b as { type?: unknown }).type === 'text'
      && typeof (b as { text?: unknown }).text === 'string',
    )
    .map(b => b.text)
    .join('')
    .trim();
}

/**
 * Pull a ChatResponse out of an SDK event, or null when the event isn't a
 * terminal result. Throws on result events with an error subtype so the
 * caller's loop surfaces the failure instead of silently waiting on more
 * events that will never come.
 */
function extractResult(event: { type: string; subtype?: string; result?: string; usage?: unknown; errors?: string[] }, model: string): ChatResponse | null {
  if (event.type !== 'result') return null;
  if (event.subtype === 'success') {
    const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    return {
      content: event.result ?? '',
      model,
      usage: { input_tokens: usage?.input_tokens, output_tokens: usage?.output_tokens },
      raw: event,
    };
  }
  const errs = event.errors ? event.errors.join('; ') : 'unknown';
  throw new Error(`Claude SDK error: ${event.subtype ?? 'unknown'} (${errs})`);
}
