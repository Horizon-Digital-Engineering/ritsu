import type { MemoryStore } from '../memory-store.js';
import type { ConversationStore } from '../conversation-store.js';
import type { ChatMessage, ChatRequest, DispatcherKind, ModelDispatcher } from '../model/dispatcher.js';
import type { AgentDefinition } from '../admin/schema.js';
import { logger } from '../util/log.js';

export interface AgentRequest {
  message: string;
  conversation_id?: number;
  /** Who's making this call. Stored alongside the user turn in the transcript
   *  so the admin UI can show "from: admin-ui / Mac mini CLI / agent-three". */
  caller_label?: string | null;
}

export interface AgentResponse {
  conversation_id: number;
  reply: string;
  memories_written: number[];
  dispatcher_used: DispatcherKind;
  model_used: string;
}

export interface AgentDeps {
  memory: MemoryStore;
  conversations: ConversationStore;
  dispatcher: ModelDispatcher;
}

/**
 * Base class. Concrete subclasses override hooks (loadContext, persistAfterTurn,
 * selectDispatcher). All metadata is injected from an AgentDefinition at
 * construction time — no hardcoded fields in subclasses.
 */
export abstract class AgentBase {
  constructor(
    readonly definition: AgentDefinition,
    protected readonly deps: AgentDeps,
  ) {}

  get id(): string { return this.definition.id; }
  get name(): string { return this.definition.name; }
  get description(): string { return this.definition.description; }
  get systemPrompt(): string { return this.definition.system_prompt; }

  /**
   * Hook: assemble context messages from memories + inter-agent comms.
   *
   * Always emits a "memory tools" guidance system message so the agent knows
   * the mcp__memory__* tools exist and how to use them, regardless of
   * whether it has any memories yet. Stored memories (if any) come right
   * after, so the agent sees both the tool surface and the current state.
   *
   * If the agent has anyone in its can_call allowlist, also emit a system
   * message describing the agent-comms tools so the model actually reaches
   * for them when the user says "go ask X about Y" instead of replying
   * conversationally as if it had no way to do that.
   */
  protected async loadContext(): Promise<ChatMessage[]> {
    const out: ChatMessage[] = [];
    out.push({
      role: 'system',
      content:
        'Persistent memory is available. Use these tools to maintain knowledge across conversations:\n' +
        '  - mcp__memory__remember(content)            save a durable fact about this agent\'s domain\n' +
        '  - mcp__memory__list_memories(limit?)        list this agent\'s active memories with their ids\n' +
        '  - mcp__memory__update_memory(id, content)   replace an existing memory with a new version\n' +
        '  - mcp__memory__forget(id)                   tombstone a memory that\'s no longer relevant\n' +
        'Guidance: store concise, durable facts (preferences, decisions, deadlines) — not transient state. ' +
        'Active memories below are injected into your system context every turn.',
    });
    const canCall = this.definition.can_call ?? [];
    if (canCall.length > 0) {
      out.push({
        role: 'system',
        content:
          'You can talk to other agents to delegate questions or coordinate work. Tools available:\n' +
          '  - mcp__agent_comms__list_agents()                        see who you can call (with their names + descriptions)\n' +
          '  - mcp__agent_comms__ask_agent(agent_id, message)         ask another agent and get their reply synchronously\n' +
          `You are allowed to call: ${canCall.join(', ')}\n` +
          'Each (you, target) pair keeps one long-running thread, so the target sees the prior context with you on subsequent calls. ' +
          'Omit conversation_id to land in that canonical thread. Max call depth is 3 hops — don\'t chain too deep. ' +
          'Reach for ask_agent when the user asks you to consult another agent, or when answering well needs context only another agent has.',
      });
    }
    const capabilities = this.definition.capabilities ?? [];
    if (capabilities.includes('manage_agents')) {
      out.push({
        role: 'system',
        content:
          'You have the manage_agents capability. You can mint and edit other agents on this server:\n' +
          '  - mcp__agent_admin__create_agent(id, name, description, system_prompt, dispatcher, model, ...)\n' +
          '  - mcp__agent_admin__update_agent(agent_id, patch)\n' +
          '  - mcp__agent_admin__reload_agent(agent_id)\n' +
          'Use sparingly. Each agent has cost (model calls, attention surface) — prefer reusing or updating ' +
          'an existing agent over creating a new one. Never grant manage_agents to a new agent without a ' +
          'clear, written reason. Agent deletion is intentionally NOT exposed here — leave that to the operator.',
      });
    }
    if (capabilities.includes('monitor_agents')) {
      out.push({
        role: 'system',
        content:
          'You have the monitor_agents capability. You can observe the whole swarm read-only:\n' +
          '  - mcp__agent_monitor__list_agents()                        every agent on the server (not just your can_call list)\n' +
          '  - mcp__agent_monitor__list_conversations(agent_id?, kind?) recent conversations, filterable by agent or kind\n' +
          '  - mcp__agent_monitor__read_conversation(conversation_id)   read a conversation transcript with caller attribution\n' +
          "  - mcp__agent_monitor__read_memory(agent_id)                read another agent's active memories\n" +
          'Use these for oversight / triage when the operator asks "what is X up to?" or "who knows about Y?". ' +
          "You cannot write to other agents' memories or conversations — to intervene, use ask_agent (if your " +
          'can_call list permits) or escalate to the operator.',
      });
    }
    const mems = await this.deps.memory.list(this.id, 50);
    if (mems.length > 0) {
      const body = mems
        .map(m => `[${m.id}] (${new Date(m.created_at * 1000).toISOString()}) ${m.content}`)
        .join('\n');
      out.push({ role: 'system', content: `Active memories for this agent:\n${body}` });
    }
    return out;
  }

  /** Hook: decide what (if anything) to persist after a turn. */
  protected async persistAfterTurn(_userMsg: string, _assistantMsg: string): Promise<number[]> {
    return [];
  }

  /** Hook: choose the dispatcher for this turn. Override to escalate. */
  protected async selectDispatcher(_userMsg: string): Promise<ModelDispatcher> {
    return this.deps.dispatcher;
  }

  async onMessage(req: AgentRequest): Promise<AgentResponse> {
    // No conversation_id passed = a non-agent caller (admin UI or external
    // MCP) hitting this agent without continuing a specific thread. Route to
    // the canonical human ↔ this-agent thread instead of spawning a new one.
    // Agent-to-agent calls always pass a conversation_id (resolved in
    // agent-comms-mcp via findOrStartInterAgentThread) so they don't take
    // this branch.
    const conversationId = req.conversation_id ?? this.deps.conversations.findOrStartHumanThread(this.id);

    this.deps.conversations.append(conversationId, 'user', req.message, req.caller_label ?? null);

    const history = this.deps.conversations
      .recent(conversationId, 50)
      .map(m => ({ role: m.role, content: m.content }));
    const contextMsgs = await this.loadContext();

    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt },
      ...contextMsgs,
      ...history,
    ];

    const dispatcher = await this.selectDispatcher(req.message);

    logger.info('agent.onMessage', {
      agent: this.id,
      conv: conversationId,
      dispatcher: dispatcher.kind,
      model: dispatcher.defaultModel,
    });

    const resp = await dispatcher.chat({ messages } satisfies ChatRequest);

    this.deps.conversations.append(conversationId, 'assistant', resp.content);
    const written = await this.persistAfterTurn(req.message, resp.content);

    return {
      conversation_id: conversationId,
      reply: resp.content,
      memories_written: written,
      dispatcher_used: dispatcher.kind,
      model_used: resp.model,
    };
  }
}
