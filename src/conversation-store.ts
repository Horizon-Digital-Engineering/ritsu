import { conversationBus } from './conversation-bus.js';
import type { Db } from './db.js';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ConversationMessage {
  role: MessageRole;
  content: string;
  /** Who produced this turn. Null for legacy rows / assistant turns / system
   *  injections; for user turns it's 'admin-ui', a bearer token's name (or
   *  OAuth client_id), or the calling agent's id. */
  caller_label?: string | null;
}

/**
 * Ephemeral per-conversation transcript. Separate from MemoryStore because the
 * lifetime and semantics differ: messages are a turn-by-turn record, memories
 * are curated long-term knowledge. Memory backends (Flashback, etc.) don't
 * generally store transcripts, so this stays in SQLite.
 */
export interface ConversationSummary {
  id: number;
  agent_id: string;
  /** Caller agent id for inter-agent threads; null for human-initiated conversations. */
  caller_agent_id: string | null;
  started_at: number;
  ended_at: number | null;
  message_count: number;
  /** Derived: first ~60 chars of the first user message. Empty if no messages yet. */
  title: string;
}

/** 'human' = caller_agent_id IS NULL; 'agent' = inter-agent threads; 'all' = both. */
export type ConversationKind = 'human' | 'agent' | 'all';

export interface ConversationStore {
  start(agent_id: string): number;
  end(conversation_id: number): void;
  append(conversation_id: number, role: MessageRole, content: string, caller_label?: string | null): number;
  recent(conversation_id: number, limit?: number): ConversationMessage[];
  /**
   * List conversations (newest first). Optional `agent_id` matches c.agent_id;
   * `involves` is the wider filter that returns threads where the id appears
   * on either side (agent_id OR caller_agent_id), used by the chat panel's
   * picker to surface every thread the panel's agent is part of.
   */
  listSummaries(agent_id?: string, limit?: number, kind?: ConversationKind, involves?: string): ConversationSummary[];
  /**
   * Get-or-create the canonical inter-agent thread for a (caller, target) pair.
   * Returns the id of the *oldest* row with caller_agent_id=caller AND
   * agent_id=target, so each pair keeps one long-running thread that grows
   * over time. If none exists, inserts a new row and returns its id.
   */
  findOrStartInterAgentThread(caller_agent_id: string, target_agent_id: string): number;
  /**
   * Get-or-create the canonical human ↔ agent thread for an agent. Same shape
   * as findOrStartInterAgentThread but for caller_agent_id IS NULL — one
   * long-running thread per agent so the slide-in chat panel never spawns
   * accidental new conversations.
   */
  findOrStartHumanThread(agent_id: string): number;
}

export class SqliteConversationStore implements ConversationStore {
  constructor(private readonly db: Db) {}

  start(agent_id: string): number {
    const r = this.db.prepare('INSERT INTO conversations (agent_id) VALUES (?)').run(agent_id);
    return Number(r.lastInsertRowid);
  }

  end(conversation_id: number): void {
    this.db
      .prepare("UPDATE conversations SET ended_at = strftime('%s','now') WHERE id = ?")
      .run(conversation_id);
  }

  append(conversation_id: number, role: MessageRole, content: string, caller_label?: string | null): number {
    const r = this.db
      .prepare('INSERT INTO messages (conversation_id, role, content, caller_label) VALUES (?, ?, ?, ?)')
      .run(conversation_id, role, content, caller_label ?? null);
    // Look up agent_id once so SSE subscribers can scope by agent without
    // a second round-trip. Cheap (indexed lookup on the row we just touched).
    const row = this.db
      .prepare('SELECT agent_id FROM conversations WHERE id = ?')
      .get(conversation_id) as { agent_id: string } | undefined;
    conversationBus.publish({
      kind: 'message',
      conversation_id,
      agent_id: row?.agent_id ?? '',
      role,
      content,
      caller_label: caller_label ?? null,
      ts: Math.floor(Date.now() / 1000),
    });
    return Number(r.lastInsertRowid);
  }

  recent(conversation_id: number, limit = 50): ConversationMessage[] {
    // ORDER BY id DESC LIMIT N gives us the LAST N messages (newest); the
    // earlier `ORDER BY created_at ASC LIMIT N` returned the first N (oldest),
    // which silently dropped every new turn after a conversation crossed the
    // limit. Use id (monotonic primary key) instead of created_at (1s resolution
    // with no defined tiebreaker), then reverse so the caller sees chronological
    // order with the most recent turn at the end.
    const rows = this.db
      .prepare(
        `SELECT role, content, caller_label FROM messages
         WHERE conversation_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(conversation_id, limit) as ConversationMessage[];
    return rows.reverse();
  }

  findOrStartInterAgentThread(caller_agent_id: string, target_agent_id: string): number {
    const existing = this.db
      .prepare(
        `SELECT id FROM conversations
         WHERE agent_id = ? AND caller_agent_id = ?
         ORDER BY id ASC LIMIT 1`,
      )
      .get(target_agent_id, caller_agent_id) as { id: number } | undefined;
    if (existing) return existing.id;
    const r = this.db
      .prepare('INSERT INTO conversations (agent_id, caller_agent_id) VALUES (?, ?)')
      .run(target_agent_id, caller_agent_id);
    return Number(r.lastInsertRowid);
  }

  findOrStartHumanThread(agent_id: string): number {
    const existing = this.db
      .prepare(
        `SELECT id FROM conversations
         WHERE agent_id = ? AND caller_agent_id IS NULL
         ORDER BY id ASC LIMIT 1`,
      )
      .get(agent_id) as { id: number } | undefined;
    if (existing) return existing.id;
    return this.start(agent_id);
  }

  listSummaries(
    agent_id?: string,
    limit = 100,
    kind: ConversationKind = 'all',
    involves?: string,
  ): ConversationSummary[] {
    const baseSql = `
      SELECT c.id, c.agent_id, c.caller_agent_id, c.started_at, c.ended_at,
             (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
             COALESCE(
               (SELECT m.content FROM messages m
                WHERE m.conversation_id = c.id AND m.role = 'user'
                ORDER BY m.id ASC LIMIT 1),
               ''
             ) AS first_user_msg
      FROM conversations c`;
    const where: string[] = [];
    const params: unknown[] = [];
    if (agent_id) { where.push('c.agent_id = ?'); params.push(agent_id); }
    if (involves) {
      where.push('(c.agent_id = ? OR c.caller_agent_id = ?)');
      params.push(involves, involves);
    }
    if (kind === 'human') where.push('c.caller_agent_id IS NULL');
    else if (kind === 'agent') where.push('c.caller_agent_id IS NOT NULL');
    const sql = `${baseSql}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY c.id DESC LIMIT ?`;
    params.push(limit);
    type Row = Omit<ConversationSummary, 'title'> & { first_user_msg: string };
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map(r => {
      const { first_user_msg, ...rest } = r;
      const oneLine = first_user_msg.replace(/\s+/g, ' ').trim();
      const title = oneLine.length > 60 ? oneLine.slice(0, 57) + '…' : oneLine;
      return { ...rest, title };
    });
  }
}
