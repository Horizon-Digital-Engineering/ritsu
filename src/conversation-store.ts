import { conversationBus } from './conversation-bus.js';
import type { Db } from './db.js';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** An image (or future binary) attached to a user turn. `data` is raw base64
 *  (no `data:` prefix). */
export interface MessageAttachment {
  media_type: string;
  data: string;
}

export interface ConversationMessage {
  role: MessageRole;
  content: string;
  /** Who produced this turn. Null for legacy rows / assistant turns / system
   *  injections; for user turns it's 'admin-ui', a bearer token's name (or
   *  OAuth client_id), or the calling agent's id. */
  caller_label?: string | null;
  /** Images attached to this turn (user turns only). Absent/empty for the
   *  common text-only turn. Surfaced to the admin UI for rendering; the model
   *  context path (AgentBase) re-attaches the current turn's images directly,
   *  so these are NOT replayed into history. */
  attachments?: MessageAttachment[];
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
  /** Workspace project this conversation is filed under; null = unfiled. */
  project_id: number | null;
}

/** 'human' = caller_agent_id IS NULL; 'agent' = inter-agent threads; 'all' = both. */
export type ConversationKind = 'human' | 'agent' | 'all';

export interface ConversationStore {
  start(agent_id: string): number;
  end(conversation_id: number): void;
  append(
    conversation_id: number,
    role: MessageRole,
    content: string,
    caller_label?: string | null,
    attachments?: MessageAttachment[],
  ): number;
  recent(conversation_id: number, limit?: number): ConversationMessage[];
  /** The agent a conversation belongs to, or null if it doesn't exist. Used to
   *  reject a caller-supplied conversation_id that names another agent's thread. */
  agentIdOf(conversation_id: number): string | null;
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
  /** File a conversation under a workspace project (null unfiles it). Returns
   *  false for an unknown conversation. Cross-agent validation is the
   *  caller's job — this store doesn't know which agent owns a project. */
  setProject(conversation_id: number, project_id: number | null): boolean;
  /** Operator-set title; null reverts to deriving from the first user turn. */
  setTitle(conversation_id: number, title: string | null): boolean;
  /** True when this is the agent's canonical human thread — the anchor
   *  telegram and bare asks share. Never creates one. */
  isHumanAnchor(conversation_id: number): boolean;
  /** Delete a conversation with its messages and attachments. The caller
   *  refuses the human anchor first — deleting it would silently promote the
   *  next-oldest thread into being the default chat. */
  deleteConversation(conversation_id: number): boolean;
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

  append(
    conversation_id: number,
    role: MessageRole,
    content: string,
    caller_label?: string | null,
    attachments?: MessageAttachment[],
  ): number {
    // One transaction: an attachment insert that fails partway used to leave
    // the message row with some of its images and no way to tell.
    const messageId = this.db.transaction((): number => {
      const r = this.db
        .prepare('INSERT INTO messages (conversation_id, role, content, caller_label) VALUES (?, ?, ?, ?)')
        .run(conversation_id, role, content, caller_label ?? null);
      const id = Number(r.lastInsertRowid);
      if (attachments && attachments.length > 0) {
        const ins = this.db.prepare(
          'INSERT INTO message_attachments (message_id, conversation_id, media_type, data) VALUES (?, ?, ?, ?)',
        );
        for (const a of attachments) ins.run(id, conversation_id, a.media_type, a.data);
      }
      return id;
    })();
    // Look up agent_id once so SSE subscribers can scope by agent without
    // a second round-trip. Cheap (indexed lookup on the row we just touched).
    const row = this.db
      .prepare('SELECT agent_id FROM conversations WHERE id = ?')
      .get(conversation_id) as { agent_id: string } | undefined;
    // The SSE 'message' event only signals "something changed" — clients
    // re-fetch the transcript (which carries attachments) — so it stays lean.
    conversationBus.publish({
      kind: 'message',
      conversation_id,
      agent_id: row?.agent_id ?? '',
      role,
      content,
      caller_label: caller_label ?? null,
      ts: Math.floor(Date.now() / 1000),
    });
    return messageId;
  }

  agentIdOf(conversation_id: number): string | null {
    const row = this.db
      .prepare('SELECT agent_id FROM conversations WHERE id = ?')
      .get(conversation_id) as { agent_id: string } | undefined;
    return row ? row.agent_id : null;
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
        `SELECT id, role, content, caller_label FROM messages
         WHERE conversation_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(conversation_id, limit) as Array<ConversationMessage & { id: number }>;
    rows.reverse();
    // Attach images in one extra query, grouped by message id. Skipped
    // entirely when the thread has none (the common case).
    const ids = rows.map(r => r.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const atts = this.db
        .prepare(
          `SELECT message_id, media_type, data FROM message_attachments
           WHERE message_id IN (${placeholders})
           ORDER BY id ASC`,
        )
        .all(...ids) as Array<{ message_id: number; media_type: string; data: string }>;
      if (atts.length > 0) {
        const byMessage = new Map<number, MessageAttachment[]>();
        for (const a of atts) {
          const list = byMessage.get(a.message_id) ?? [];
          list.push({ media_type: a.media_type, data: a.data });
          byMessage.set(a.message_id, list);
        }
        for (const r of rows) {
          const list = byMessage.get(r.id);
          if (list) r.attachments = list;
        }
      }
    }
    return rows.map(({ id: _id, ...rest }) => rest);
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

  setProject(conversation_id: number, project_id: number | null): boolean {
    const r = this.db
      .prepare('UPDATE conversations SET project_id = ? WHERE id = ?')
      .run(project_id, conversation_id);
    return r.changes > 0;
  }

  setTitle(conversation_id: number, title: string | null): boolean {
    const r = this.db
      .prepare('UPDATE conversations SET title = ? WHERE id = ?')
      .run(title, conversation_id);
    return r.changes > 0;
  }

  isHumanAnchor(conversation_id: number): boolean {
    const row = this.db
      .prepare('SELECT agent_id, caller_agent_id FROM conversations WHERE id = ?')
      .get(conversation_id) as { agent_id: string; caller_agent_id: string | null } | undefined;
    if (!row || row.caller_agent_id !== null) return false;
    const oldest = this.db
      .prepare(
        `SELECT id FROM conversations
         WHERE agent_id = ? AND caller_agent_id IS NULL
         ORDER BY id ASC LIMIT 1`,
      )
      .get(row.agent_id) as { id: number } | undefined;
    return oldest?.id === conversation_id;
  }

  deleteConversation(conversation_id: number): boolean {
    let removed = false;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM message_attachments WHERE conversation_id = ?').run(conversation_id);
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversation_id);
      removed = this.db.prepare('DELETE FROM conversations WHERE id = ?').run(conversation_id).changes > 0;
    })();
    return removed;
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
      SELECT c.id, c.agent_id, c.caller_agent_id, c.started_at, c.ended_at, c.project_id, c.title AS custom_title,
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
    type Row = Omit<ConversationSummary, 'title'> & { first_user_msg: string; custom_title: string | null };
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map(r => {
      const { first_user_msg, custom_title, ...rest } = r;
      const oneLine = first_user_msg.replace(/\s+/g, ' ').trim();
      const derived = oneLine.length > 60 ? oneLine.slice(0, 57) + '…' : oneLine;
      return { ...rest, title: custom_title?.trim() ? custom_title.trim() : derived };
    });
  }
}
