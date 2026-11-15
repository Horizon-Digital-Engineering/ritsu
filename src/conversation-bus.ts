import { EventEmitter } from 'node:events';
import type { ToolActivity } from './model/dispatcher.js';

/**
 * Conversation-scoped event bus for live UI sync. Separate from eventBus
 * (which carries log entries) so a noisy log channel can't drown chat
 * sync, and so SSE subscribers can attach without seeing log spam.
 *
 * Every event carries conversation_id so the client can filter to a single
 * thread. One turn publishes ask-start → (delta | tool)* → message → ask-end.
 *
 *   - 'message'    A turn was appended to a conversation. Fires from
 *                  ConversationStore.append(); clients re-fetch.
 *   - 'ask-start'  An agent began a turn here, from any surface. The UI
 *                  shows a typing indicator.
 *   - 'delta'      Text the model just wrote, in order.
 *   - 'tool'       A tool call started, or the same call (same id) ended.
 *   - 'ask-end'    The turn is over (success OR error). Always fires after
 *                  ask-start.
 */
export interface ConversationMessageEvent {
  kind: 'message';
  conversation_id: number;
  agent_id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  caller_label: string | null;
  ts: number;
}

export interface ConversationAskEvent {
  kind: 'ask-start' | 'ask-end';
  conversation_id: number;
  agent_id: string;
  ts: number;
}

export interface ConversationDeltaEvent {
  kind: 'delta';
  conversation_id: number;
  agent_id: string;
  text: string;
  ts: number;
}

export interface ConversationToolEvent {
  kind: 'tool';
  conversation_id: number;
  agent_id: string;
  call: ToolActivity;
  ts: number;
}

export type ConversationEvent =
  | ConversationMessageEvent
  | ConversationAskEvent
  | ConversationDeltaEvent
  | ConversationToolEvent;

export class ConversationBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0); // many SSE clients may attach
  }

  publish(event: ConversationEvent): void {
    this.emit('event', event);
  }
}

/** Process-wide singleton. */
export const conversationBus = new ConversationBus();
