import { query, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { ChatRequest, ChatResponse, ChatMessage, ModelDispatcher } from './dispatcher.js';
import type { Workspace } from '../workspace-store.js';
import type { MemoryStore } from '../memory-store.js';
import type { ApprovalStore } from '../approval-store.js';
import { checkToolUse } from '../tools/permissions.js';
import { buildAgentMemoryMcp, MEMORY_TOOL_NAMES, MEMORY_MCP_NAME } from '../tools/mcp-internal/memory.js';
import { buildAgentEmailMcp, EMAIL_TOOL_NAMES, EMAIL_MCP_NAME } from '../tools/mcp-internal/email.js';
import type { McpGateContext } from '../tools/mcp-internal/approval-gate.js';
import type { SecretStore } from '../auth/secret-store.js';
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
  /**
   * Human-in-the-loop approval gate. When a tool the model wants to call is
   * in `gatedTools`, the dispatcher writes a pending approval and blocks the
   * turn until the operator approves (→ allow) or rejects (→ deny, with the
   * operator's reason fed back to the model). `agentId` attributes the
   * request; `store` is the shared ApprovalStore. Omit to disable gating.
   */
  approval?: { agentId: string; store: ApprovalStore; gatedTools: string[] };
  /**
   * CRM email tools (read_inbox / read_email / send_email). Wired when the
   * agent has the 'crm' capability. send_email always blocks on approval, so
   * the ApprovalStore is required here. Credentials are read from the
   * SecretStore inside the handlers — never surfaced to the model.
   */
  email?: { agentId: string; secrets: SecretStore; approvals: ApprovalStore };
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
    const canUseTool = buildCanUseToolCallback(workspaces, this.opts, req.conversation_id ?? null);
    const { mcpServers, allowedTools } = buildMcpServers(this.opts, req.conversation_id ?? null);

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
        // Explicit-safe permission baseline. settingSources:[] stops the SDK
        // loading the service account's ~/.claude/settings.json (whose
        // `defaultMode: "auto"` would put the agent in classifier-auto mode);
        // permissionMode:'default' is the documented interactive-approval
        // mode. OAuth credentials load independently of settings, so $0 Max
        // dispatch is unaffected, and agents carry their own system_prompt so
        // dropping CLAUDE.md costs nothing.
        //
        // CAVEAT (learned the hard way): on the Max-plan session path the
        // spawned `claude` subprocess runs its BUILT-IN tools itself and does
        // NOT route them through canUseTool regardless of these options —
        // proven by tracing the event stream. So built-in Bash/Read/Write are
        // ungovernable here. We therefore gate at the layer we DO own: the
        // in-process MCP tool handlers (see approval-gate.ts), and we hand
        // governed agents OUR MCP-wrapped tools instead of the SDK's built-ins.
        // The ritsu-agent runtime (our own loop) gates reliably and is the
        // home for agents that need hard tool approval.
        settingSources: [],
        permissionMode: 'default',
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
  ...EMAIL_TOOL_NAMES,
]);

/**
 * Build the SDK's `canUseTool` callback. Returns undefined when no gate is
 * needed at all (no workspaces, no in-process MCP servers, no approval gating).
 * The callback:
 *   1. allows in-process MCP tools unconditionally (their handlers do their
 *      own allowlist + loop-guard checks),
 *   2. enforces workspace permissions on built-in FS/exec/net tools via
 *      checkToolUse,
 *   3. and finally, for tools listed in the agent's approval_tools, blocks on
 *      operator approval — a reject denies the call with the operator's reason
 *      so the model sees why and can adapt.
 */
function buildCanUseToolCallback(
  workspaces: Workspace[],
  opts: ClaudeDirectOpts,
  conversationId: number | null,
): CanUseTool | undefined {
  const gating = opts.approval && opts.approval.gatedTools.length > 0 ? opts.approval : undefined;
  if (workspaces.length === 0 && !opts.memory && !opts.comms && !opts.admin && !opts.monitor && !gating) {
    return undefined;
  }
  return async (toolName, input) => {
    if (IN_PROCESS_MCP_TOOLS.has(toolName)) {
      return { behavior: 'allow' as const, updatedInput: input };
    }
    // Observability: every built-in tool call (Bash/Read/Write/Web*) that
    // routes through permission. Tells us whether the model is actually
    // invoking a tool vs answering from memory — and whether a gated tool
    // is being recognized as gated.
    logger.info('tool.check', {
      tool: toolName,
      gated: !!(gating && gating.gatedTools.includes(toolName)),
    });
    const result = checkToolUse(toolName, input, workspaces);
    if (!result.ok) {
      logger.warn('tool.denied', { tool: toolName, reason: result.reason });
      return { behavior: 'deny' as const, message: result.reason };
    }
    if (gating && gating.gatedTools.includes(toolName)) {
      logger.info('approval.gate', { agent_id: gating.agentId, tool: toolName, conversation_id: conversationId });
      const decision = await gating.store.request({
        agentId: gating.agentId,
        conversationId,
        toolName,
        args: input,
      });
      if (decision.state === 'rejected') {
        const why = decision.reason?.trim()
          ? `Operator rejected this ${toolName} call: ${decision.reason.trim()}`
          : `Operator rejected this ${toolName} call.`;
        return { behavior: 'deny' as const, message: why };
      }
      return { behavior: 'allow' as const, updatedInput: input };
    }
    return { behavior: 'allow' as const, updatedInput: input };
  };
}

/**
 * Build the SDK's mcpServers map + the matching allowedTools list. The SDK's
 * `tools` option allowlists BUILT-IN tools only (Read, Bash, ...); MCP tools
 * have to be named in `allowedTools` by their fully-qualified `mcp__*__*`
 * name or the SDK strips them from the model's toolbelt even when the server
 * is registered.
 */
function buildMcpServers(opts: ClaudeDirectOpts, conversationId: number | null): {
  mcpServers: Record<string, ReturnType<typeof buildAgentMemoryMcp>>;
  allowedTools: string[];
} {
  const mcpServers: Record<string, ReturnType<typeof buildAgentMemoryMcp>> = {};
  const allowedTools: string[] = [];
  // Approval gate context for in-process MCP tools — enforced INSIDE the
  // handler (the SDK can't bypass that, unlike canUseTool). Null when the
  // agent gates nothing.
  const gate: McpGateContext | null = opts.approval && opts.approval.gatedTools.length > 0
    ? {
        agentId: opts.approval.agentId,
        conversationId,
        gatedTools: opts.approval.gatedTools,
        approvals: opts.approval.store,
      }
    : null;
  if (opts.memory) {
    mcpServers[MEMORY_MCP_NAME] = buildAgentMemoryMcp(opts.memory.agentId, opts.memory.store, gate);
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
  if (opts.email) {
    mcpServers[EMAIL_MCP_NAME] = buildAgentEmailMcp({
      agentId: opts.email.agentId,
      secrets: opts.email.secrets,
      approvals: opts.email.approvals,
      conversationId,
    });
    allowedTools.push(...EMAIL_TOOL_NAMES);
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
