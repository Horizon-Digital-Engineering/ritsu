/**
 * Ritsu-agent dispatcher: our own tool-calling loop, no Claude Agent SDK.
 *
 * Loop:
 *   1. Send messages + tools to the provider (OpenAI-compat HTTP).
 *   2. Receive {content, tool_calls}.
 *   3. If no tool_calls, return the content as the final reply.
 *   4. Otherwise: execute each tool_call in-process (memory_*, agent_comms_*),
 *      append the results as role:'tool' messages, go back to step 1.
 *   5. Bounded by MAX_TOOL_ROUNDS so a misbehaving model can't infinite-loop.
 *
 * This dispatcher implements ModelDispatcher so the rest of ritsu (AgentBase,
 * AgentHost) doesn't have to care which runtime it's talking to.
 */
import type { ChatRequest, ChatResponse, ModelDispatcher } from '../dispatcher.js';
import type { ApiKeyStore } from '../../auth/api-key-store.js';
import type { ApprovalStore } from '../../approval-store.js';
import { buildRaClient } from './client.js';
import { buildBuiltinTools, type RaToolDeps } from '../../tools/ritsu-agent/builtin.js';
import type { RaMessage, RaProvider, RaTool, RaToolCall, RaProviderOptions } from './types.js';
import { logger } from '../../util/log.js';

/** A misbehaving model that keeps tool-calling without producing a final
 *  answer eventually hits this cap and we return whatever text it last sent
 *  (or an explicit failure message). 8 is generous — most legitimate flows
 *  resolve in 2-4 rounds. */
const MAX_TOOL_ROUNDS = 8;

export interface RitsuAgentDispatcherOpts {
  provider: RaProvider;
  /** api_keys.id — looked up via apiKeys.reveal() right before the call so
   *  the plaintext lives in memory only for the duration of the request.
   *  Null = keyless (litellm/custom endpoints; schema-enforced). */
  apiKeyRef: number | null;
  apiKeys: ApiKeyStore;
  /** Key to use when apiKeyRef is null (e.g. the LiteLLM proxy key from the
   *  SecretStore). Empty/omitted = no Authorization header. */
  fallbackApiKey?: string;
  /** Default model; can be overridden per ChatRequest. */
  defaultModel: string;
  providerOptions?: RaProviderOptions;
  /** Built-in tool wiring (memory + agent-comms). Pass null to disable
   *  (e.g. a bare-bones agent with no built-ins). */
  toolDeps: RaToolDeps | null;
  /**
   * Human-in-the-loop approval gate. When a tool the model wants to run is
   * in `gatedTools`, we BLOCK the loop on operator approval before executing
   * it. This is the reliable enforcement point for open models: we own the
   * loop, so there's no SDK and no tool timeout to bypass us — the await
   * just waits. On reject, the operator's reason is returned to the model as
   * the tool result so it can adapt. Omit to disable gating.
   */
  approval?: { agentId: string; store: ApprovalStore; gatedTools: string[] };
  /** Injected by tests. */
  fetchImpl?: typeof fetch;
}

export class RitsuAgentDispatcher implements ModelDispatcher {
  readonly kind = 'ritsu-agent' as const;
  readonly defaultModel: string;
  private readonly opts: RitsuAgentDispatcherOpts;

  constructor(opts: RitsuAgentDispatcherOpts) {
    this.opts = opts;
    this.defaultModel = opts.defaultModel;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let apiKey = this.opts.fallbackApiKey ?? '';
    if (this.opts.apiKeyRef !== null) {
      const revealed = this.opts.apiKeys.reveal(this.opts.apiKeyRef);
      if (!revealed) {
        throw new Error(`api key ref=${this.opts.apiKeyRef} not found or revoked`);
      }
      apiKey = revealed.plaintext;
    }
    const client = buildRaClient({
      provider: this.opts.provider,
      apiKey,
      model: req.model ?? this.defaultModel,
      providerOptions: this.opts.providerOptions,
      fetchImpl: this.opts.fetchImpl,
    });

    // Thread the approval store + this turn's conversation into the builtin
    // tools so an approvable escalation can route to the operator (parity with
    // the MCP path). Per-call because conversationId is per-turn.
    const tools: RaTool[] = this.opts.toolDeps
      ? buildBuiltinTools({
          ...this.opts.toolDeps,
          approvals: this.opts.approval?.store,
          conversationId: req.conversation_id ?? null,
          // So a conditionally self-gating tool (ask_agent, which only asks on
          // capability escalation) can tell whether the loop already asked.
          gatedTools: this.opts.approval?.gatedTools ?? [],
          // A scheduled turn must not be able to schedule more work. Without
          // this the scheduling tools are present in a job run and one fire can
          // create a job per tool round, with no cap and no natural stop.
          insideJobRun: (req.caller_label ?? '').startsWith('scheduler:'),
        })
      : [];
    const toolsByName = new Map(tools.map(t => [t.name, t]));

    // Seed messages from the ChatRequest. Roles map 1:1 to OpenAI's shape;
    // we don't have an SDK-style internal protocol to translate. Content
    // (string or image blocks) is structurally identical, passed through.
    const messages: RaMessage[] = req.messages.map(m => ({ role: m.role, content: m.content }));

    let lastContent = '';
    let lastModel = req.model ?? this.defaultModel;
    let totalIn = 0;
    let totalOut = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const completion = await client.chat(messages, tools);
      lastModel = completion.model;
      lastContent = completion.content;
      totalIn += completion.usage?.prompt_tokens ?? 0;
      totalOut += completion.usage?.completion_tokens ?? 0;

      if (completion.tool_calls.length === 0) {
        // No more tools — done.
        logger.debug('ra.dispatch.done', { rounds: round + 1, model: lastModel, in: totalIn, out: totalOut });
        return {
          content: lastContent,
          model: lastModel,
          usage: { input_tokens: totalIn, output_tokens: totalOut },
          raw: completion.raw,
        };
      }

      // Append the assistant's tool-call message AS-IS so the provider can
      // match results back to calls by tool_call_id on the next round.
      messages.push({
        role: 'assistant',
        content: lastContent,
        tool_calls: completion.tool_calls,
      });

      // Execute each tool, append result.
      for (const call of completion.tool_calls) {
        const result = await this.runTool(call, toolsByName, req.conversation_id ?? null);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }

    // Hit the cap — return whatever the model last said with a warning
    // appended so the caller can see the loop bailed.
    logger.warn('ra.dispatch.tool-cap', { rounds: MAX_TOOL_ROUNDS });
    return {
      content: lastContent || `(ritsu-agent: tool-call loop exceeded ${MAX_TOOL_ROUNDS} rounds — model did not finish)`,
      model: lastModel,
      usage: { input_tokens: totalIn, output_tokens: totalOut },
      raw: null,
    };
  }

  /** Resolve, parse args, invoke handler. Errors are caught + stringified
   *  so the model can react instead of crashing the loop. */
  private async runTool(call: RaToolCall, byName: Map<string, RaTool>, conversationId: number | null): Promise<string> {
    const tool = byName.get(call.function.name);
    if (!tool) return `error: tool "${call.function.name}" not available`;
    let args: Record<string, unknown>;
    try {
      args = call.function.arguments
        ? JSON.parse(call.function.arguments) as Record<string, unknown>
        : {};
    } catch (err) {
      return `error: invalid tool arguments JSON: ${(err as Error).message}`;
    }
    // Human-in-the-loop gate. We own this loop, so blocking here is reliable:
    // the tool does NOT run until the operator approves. On reject, the reason
    // goes back to the model as the tool result. No SDK / timeout to bypass us.
    // A self-gated tool has already promised to ask; gating here too would put
    // two identical cards in front of the operator for one action.
    const gate = tool.selfGated ? null : this.opts.approval;
    if (gate?.gatedTools.includes(call.function.name)) {
      logger.info('ra.approval.gate', { agent_id: gate.agentId, tool: call.function.name, conversation_id: conversationId });
      const decision = await gate.store.request({
        agentId: gate.agentId,
        conversationId,
        toolName: call.function.name,
        args,
      });
      if (decision.state === 'rejected') {
        return decision.reason?.trim()
          ? `Operator rejected this ${call.function.name} call: ${decision.reason.trim()}`
          : `Operator rejected this ${call.function.name} call.`;
      }
    }
    try {
      return await tool.handler(args);
    } catch (err) {
      logger.error('ra.dispatch.tool-error', {
        tool: call.function.name, err: (err as Error).message,
      });
      return `error: ${(err as Error).message}`;
    }
  }
}
