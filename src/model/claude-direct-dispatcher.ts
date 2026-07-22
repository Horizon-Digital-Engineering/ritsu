import {
  query, type CanUseTool, type SDKUserMessage, type HookCallback, type PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { ChatRequest, ChatResponse, ChatMessage, ModelDispatcher } from './dispatcher.js';
import { messageText, messageImages } from './dispatcher.js';
import type { Workspace } from '../workspace-store.js';
import type { MemoryStore } from '../memory-store.js';
import type { ApprovalStore } from '../approval-store.js';
import { checkToolUse } from '../tools/permissions.js';
import type { McpGateContext } from '../tools/mcp-internal/approval-gate.js';
import { assembleMcp, type McpProvider, type SdkMcpServer } from '../tools/mcp-gateway.js';
import {
  memoryProvider, commsProvider, adminProvider, monitorProvider, emailProvider, socialProvider,
} from '../tools/builtin-providers.js';
import type { SecretStore } from '../auth/secret-store.js';
import type { AgentCommsDeps } from '../tools/mcp-internal/agent-comms.js';
import type { AgentAdminDeps } from '../tools/mcp-internal/agent-admin.js';
import type { AgentMonitorDeps } from '../tools/mcp-internal/agent-monitor.js';
import { logger } from '../util/log.js';

/**
 * Uses @anthropic-ai/claude-agent-sdk, which reads the Max-plan CLI session
 * from ~/.claude/. $0 marginal cost.
 *
 * V0.4: per-agent `cwd`, tool allowlist, AND per-tool permission enforcement.
 * checkToolUse maps each call to a required workspace permission (Read→'read',
 * Write→'write', Bash→'exec', Web*→network) and denies with a reason the model
 * sees in the result. Built-in tools (Bash/Read/Write/Edit/…) are enforced by a
 * PreToolUse hook — canUseTool never sees them on the Max-plan subprocess path;
 * in-process MCP tools gate inside their own handlers.
 */
export interface ClaudeDirectOpts {
  /** The agent this dispatcher serves. Used to scope plugin tool calls. */
  agentId?: string;
  /** Working directory the agent operates in (taken from its workspaces[0].path). */
  cwd?: string;
  /** Allowlist of SDK tool names. Empty/undefined = no tools. */
  tools?: string[];
  /** Per-agent workspaces. Used to authorize each tool call. */
  workspaces?: Workspace[];
  /**
   * MCP tool providers for the plugins this agent is allowlisted for. Each is
   * assembled through the MCP gateway alongside the built-in tool groups. The
   * gateway is the general mechanism; core built-ins migrate onto it over time.
   */
  plugins?: McpProvider[];
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
  /**
   * CRM social tools (read_mentions / read_my_posts / post_tweet). Wired when
   * the agent has the 'social' capability. post_tweet always blocks on
   * approval. Same secret-store + gate pattern as email.
   */
  social?: { agentId: string; secrets: SecretStore; approvals: ApprovalStore };
}

export class ClaudeDirectDispatcher implements ModelDispatcher {
  readonly kind = 'claude-direct' as const;

  constructor(
    readonly defaultModel: string = 'claude-sonnet-4-6',
    private readonly opts: ClaudeDirectOpts = {},
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model ?? this.defaultModel;
    const { systemMsg, userPrompt, images } = formatMessages(req.messages);
    // The SDK's `prompt` is either a plain string (text-only, the common case)
    // or an async stream of user messages. We only need the stream form when a
    // turn carries images: yield ONE user message whose content is the
    // flattened text + the image blocks, then close (= a single turn).
    const prompt = images.length === 0 ? userPrompt : imagePrompt(userPrompt, images);

    logger.debug('claude-direct.chat', {
      model,
      msg_count: req.messages.length,
      cwd: this.opts.cwd,
      tools_count: this.opts.tools?.length ?? 0,
      workspace_count: this.opts.workspaces?.length ?? 0,
    });

    const workspaces = this.opts.workspaces ?? [];
    const { mcpServers, allowedTools } = buildMcpServers(this.opts, req.conversation_id ?? null);
    const inProcessTools = new Set(allowedTools);
    const canUseTool = buildCanUseToolCallback(workspaces, this.opts, req.conversation_id ?? null, inProcessTools);
    const preToolUseHook = buildPreToolUseHook(workspaces, this.opts, req.conversation_id ?? null, inProcessTools);

    // Cache the most recent non-empty text from any 'assistant' event as the
    // stream flows by. When the agent's final action is a tool_use (e.g.
    // mcp__memory__update_memory) without a follow-up text turn, the SDK's
    // terminal result message has `result: ""` and the user sees a blank
    // reply. The last cached assistant text is the right thing to return in
    // that case — it's the model's most recent words to the user.
    let lastAssistantText = '';
    for await (const event of query({
      prompt,
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
        // proven by tracing the event stream. PreToolUse HOOKS, however, DO
        // fire for built-in tools, so we install one (buildPreToolUseHook) to
        // enforce workspace permissions + operator approval on Bash/Read/Write/
        // Edit/… — the same policy canUseTool intends, applied where it bites.
        // In-process MCP tools still gate in their own handlers (approval-
        // gate.ts), the layer the SDK can't bypass. The ritsu-agent runtime
        // (our own loop) remains the fully-owned path.
        settingSources: [],
        permissionMode: 'default',
        hooks: { PreToolUse: [{ hooks: [preToolUseHook] }] },
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

/** An Anthropic base64 image content block, the shape the SDK forwards to the
 *  Messages API verbatim. */
interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

/** Split a flat message list into the SDK's expected (systemPrompt, userPrompt)
 *  shape. System turns concatenate into systemPrompt; everything else becomes
 *  a single user-prompt blob with role-prefixed lines. Any image blocks (only
 *  user turns carry them) are pulled out and returned in Anthropic wire shape
 *  to ride along on the streamed user message. */
export function formatMessages(
  messages: readonly ChatMessage[],
): { systemMsg: string; userPrompt: string; images: AnthropicImageBlock[] } {
  const systemMsg = messages
    .filter(m => m.role === 'system')
    .map(m => messageText(m.content))
    .join('\n\n');
  const userPrompt = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role.toUpperCase()}: ${messageText(m.content)}`)
    .join('\n\n');
  const images: AnthropicImageBlock[] = messages
    .flatMap(m => messageImages(m.content))
    .map(b => ({ type: 'image', source: { type: 'base64', media_type: b.media_type, data: b.data } }));
  return { systemMsg, userPrompt, images };
}

/** A single-turn streamed prompt: one user message carrying the flattened
 *  conversation text plus the image blocks. Closing the generator after one
 *  yield tells the SDK this is a complete turn. */
export async function* imagePrompt(text: string, images: AnthropicImageBlock[]): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'text', text }, ...images],
    },
  } as SDKUserMessage;
}

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
  inProcessTools: Set<string>,
): CanUseTool | undefined {
  const gating = opts.approval && opts.approval.gatedTools.length > 0 ? opts.approval : undefined;
  if (workspaces.length === 0 && inProcessTools.size === 0 && !gating) {
    return undefined;
  }
  return async (toolName, input) => {
    // In-process MCP tools (memory, comms, plugins, …) are pre-authorized here
    // — their own handlers do the allowlist, loop-guard, and approval-gating.
    // The set is the agent's assembled tool list, so it covers plugins too.
    if (inProcessTools.has(toolName)) {
      return { behavior: 'allow' as const, updatedInput: input };
    }
    // Built-in tool. On the Max-plan path canUseTool is a no-op for built-ins,
    // so the PreToolUse hook is the real enforcement — this branch is the
    // defense-in-depth twin, sharing enforceBuiltinTool so the two can't drift.
    const verdict = await enforceBuiltinTool(toolName, input, workspaces, gating, conversationId);
    return verdict.ok
      ? { behavior: 'allow' as const, updatedInput: input }
      : { behavior: 'deny' as const, message: verdict.message };
  };
}

/**
 * Shared built-in-tool enforcement: workspace permission (checkToolUse), then,
 * when the tool is in the agent's approval list, block on operator approval.
 * Used by BOTH canUseTool and the PreToolUse hook so the two apply an identical
 * policy. Returns a normalized verdict the callers map to their own shapes.
 */
async function enforceBuiltinTool(
  toolName: string,
  input: Record<string, unknown>,
  workspaces: Workspace[],
  gating: { agentId: string; store: ApprovalStore; gatedTools: string[] } | undefined,
  conversationId: number | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = checkToolUse(toolName, input, workspaces);
  if (!result.ok) {
    logger.warn('tool.denied', { tool: toolName, reason: result.reason });
    return { ok: false, message: result.reason };
  }
  if (gating && gating.gatedTools.includes(toolName)) {
    logger.info('approval.gate', { agent_id: gating.agentId, tool: toolName, conversation_id: conversationId });
    const decision = await gating.store.request({ agentId: gating.agentId, conversationId, toolName, args: input });
    if (decision.state === 'rejected') {
      const why = decision.reason?.trim()
        ? `Operator rejected this ${toolName} call: ${decision.reason.trim()}`
        : `Operator rejected this ${toolName} call.`;
      return { ok: false, message: why };
    }
  }
  return { ok: true };
}

/**
 * PreToolUse hook — the enforcement layer for the SDK's BUILT-IN tools
 * (Bash/Read/Write/Edit/…). Unlike canUseTool (MCP-only on the Max-plan
 * subprocess path), PreToolUse hooks DO fire for built-in tools, so this is
 * where workspace-permission + approval gating actually bites for them. MCP /
 * in-process tools gate themselves inside their handlers, so the hook waves
 * them through. Always installed: when `tools` is unset the SDK exposes its
 * full default built-in toolset — exactly the surface that must not run
 * ungoverned.
 */
export function buildPreToolUseHook(
  workspaces: Workspace[],
  opts: ClaudeDirectOpts,
  conversationId: number | null,
  inProcessTools: Set<string>,
): HookCallback {
  const gating = opts.approval && opts.approval.gatedTools.length > 0 ? opts.approval : undefined;
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const toolName = pre.tool_name;
    if (toolName.startsWith('mcp__') || inProcessTools.has(toolName)) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
    }
    const toolInput = pre.tool_input && typeof pre.tool_input === 'object'
      ? pre.tool_input as Record<string, unknown>
      : {};
    logger.info('tool.check', {
      tool: toolName,
      gated: !!(gating && gating.gatedTools.includes(toolName)),
      via: 'pretooluse-hook',
    });
    const verdict = await enforceBuiltinTool(toolName, toolInput, workspaces, gating, conversationId);
    return verdict.ok
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
      : {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: verdict.message,
          },
        };
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
  mcpServers: Record<string, SdkMcpServer>;
  allowedTools: string[];
} {
  // Approval gate context for in-process MCP tools — enforced INSIDE the
  // handler (the SDK can't bypass that, unlike canUseTool). Null when the
  // agent gates nothing.
  // Built whenever an ApprovalStore is present (not only when gatedTools is
  // non-empty): the comms path needs gate.approvals to route an approvable
  // escalation even for an agent with no other gated tools. Empty gatedTools
  // just means gateMcpTool no-ops for the normal per-tool gating.
  const gate: McpGateContext | null = opts.approval
    ? {
        agentId: opts.approval.agentId,
        conversationId,
        gatedTools: opts.approval.gatedTools,
        approvals: opts.approval.store,
      }
    : null;
  // Every tool group — built-in and plugin — is a provider assembled through
  // the one gateway. Selection here mirrors the agent's wiring (memory/comms
  // always on; admin/monitor/email/social set only when the capability is);
  // adding a new built-in group is a new provider, not a new assembly branch.
  const providers: McpProvider[] = [];
  if (opts.memory) providers.push(memoryProvider(opts.memory.store));
  if (opts.comms) providers.push(commsProvider(opts.comms.deps));
  if (opts.admin) providers.push(adminProvider(opts.admin.deps));
  if (opts.monitor) providers.push(monitorProvider(opts.monitor.deps));
  if (opts.email) providers.push(emailProvider(opts.email.secrets, opts.email.approvals));
  if (opts.social) providers.push(socialProvider(opts.social.secrets, opts.social.approvals));
  if (opts.plugins) providers.push(...opts.plugins);

  const agentId = opts.agentId ?? opts.memory?.agentId ?? opts.approval?.agentId ?? 'unknown';
  const asm = assembleMcp(providers, { agentId, conversationId, gate });
  return { mcpServers: asm.mcpServers, allowedTools: asm.allowedTools };
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
