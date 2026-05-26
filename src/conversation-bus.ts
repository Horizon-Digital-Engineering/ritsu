import { EventEmitter } from 'node:events';

/**
 * Conversation-scoped event bus for live UI sync. Separate from eventBus
 * (which carries log entries) so a noisy log channel can't drown chat
 * sync, and so SSE subscribers can attach without seeing log spam.
 *
 * Three event kinds, all carrying conversation_id so the client can
 * filter to a single thread:
 *
 *   - 'message'    A turn was appended to a conversation. Fires from
 *                  ConversationStore.append().
 *   - 'ask-start'  An /ask handler began processing a turn for this
 *                  conversation. The UI shows a typing indicator.
 *   - 'ask-end'    The handler resolved (success OR error). UI hides
 *                  the typing indicator. Always fires after ask-start.
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

export type ConversationEvent = ConversationMessageEvent | ConversationAskEvent;

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
