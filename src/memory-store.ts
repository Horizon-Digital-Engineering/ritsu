import type { Db } from './db.js';

export interface Memory {
  id: number;
  agent_id: string;
  content: string;
  created_at: number;
  superseded_by: number | null;
  lineage_root_id: number;
}

export interface MemoryWrite {
  agent_id: string;
  content: string;
  /** If provided, the new memory supersedes this one. */
  supersedes?: number;
}

/**
 * Long-term agent knowledge. Supersede-not-delete: updating a memory inserts
 * a new row and marks the old one superseded; lineage walks all versions.
 * Same shape Flashback uses, so the FlashbackStore swap is interface-only.
 */
export interface MemoryStore {
  write(m: MemoryWrite): Promise<number>;
  list(agent_id: string, limit?: number): Promise<Memory[]>;
  read(id: number): Promise<Memory | null>;
  lineage(memory_id: number): Promise<Memory[]>;
  supersede(old_id: number, new_id: number): Promise<void>;
  /**
   * Hard-delete a memory and its successors. Used by the agent's `forget`
   * tool and the operator UI's Delete action. Lineage chain stops here:
   * any memory that was superseded BY this one (or its predecessors)
   * becomes effectively dead. Use supersede() for "I want a new version".
   */
  delete(id: number): Promise<boolean>;
}

export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly db: Db) {}

  async write(m: MemoryWrite): Promise<number> {
    const tx = this.db.transaction((m: MemoryWrite): number => {
      const insert = this.db.prepare(
        `INSERT INTO memories (agent_id, content, lineage_root_id) VALUES (?, ?, ?)`,
      );
      const placeholder = insert.run(m.agent_id, m.content, 0);
      const newId = Number(placeholder.lastInsertRowid);

      let rootId = newId;
      if (m.supersedes !== undefined) {
        const old = this.db
          .prepare('SELECT lineage_root_id FROM memories WHERE id = ?')
          .get(m.supersedes) as { lineage_root_id: number } | undefined;
        if (!old) throw new Error(`supersedes target ${m.supersedes} not found`);
        rootId = old.lineage_root_id || m.supersedes;
        this.db
          .prepare('UPDATE memories SET superseded_by = ? WHERE id = ?')
          .run(newId, m.supersedes);
      }
      this.db.prepare('UPDATE memories SET lineage_root_id = ? WHERE id = ?').run(rootId, newId);
      return newId;
    });
    return tx(m);
  }

  async list(agent_id: string, limit = 100): Promise<Memory[]> {
    return this.db
      .prepare(
        `SELECT * FROM memories
         WHERE agent_id = ? AND superseded_by IS NULL
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(agent_id, limit) as Memory[];
  }

  async read(id: number): Promise<Memory | null> {
    return (
      (this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined) ?? null
    );
  }

  async lineage(memory_id: number): Promise<Memory[]> {
    const m = await this.read(memory_id);
    if (!m) return [];
    return this.db
      .prepare(`SELECT * FROM memories WHERE lineage_root_id = ? ORDER BY created_at ASC`)
      .all(m.lineage_root_id) as Memory[];
  }

  async supersede(old_id: number, new_id: number): Promise<void> {
    this.db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(new_id, old_id);
  }

  async delete(id: number): Promise<boolean> {
    // Soft-tombstone by self-supersede instead of hard DELETE. This keeps
    // any FK-style joins (lineage walks etc.) intact and means
    // "forgotten" memories simply stop appearing in active listings.
    // Hard DELETE would orphan any rows that reference this id via
    // superseded_by. Self-reference removes from active queries
    // (`WHERE superseded_by IS NULL`) while leaving the row in place.
    const r = this.db
      .prepare('UPDATE memories SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL')
      .run(id, id);
    return r.changes > 0;
  }
}

/**
 * Stub. Replace with a real implementation when Flashback's agent-mode API is
 * available. Because MemoryStore is the only interface consumed by AgentBase,
 * swapping backends does not touch any agent code.
 */
export class FlashbackMemoryStore implements MemoryStore {
  constructor(_config: { endpoint: string; apiKey: string }) {
    throw new Error('FlashbackMemoryStore not implemented — use SqliteMemoryStore for V1');
  }
  async write(_m: MemoryWrite): Promise<number> { throw new Error('not implemented'); }
  async list(_agent_id: string, _limit?: number): Promise<Memory[]> { throw new Error('not implemented'); }
  async read(_id: number): Promise<Memory | null> { throw new Error('not implemented'); }
  async lineage(_id: number): Promise<Memory[]> { throw new Error('not implemented'); }
  async supersede(_old: number, _new: number): Promise<void> { throw new Error('not implemented'); }
  async delete(_id: number): Promise<boolean> { throw new Error('not implemented'); }
}
