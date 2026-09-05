/**
 * Saved prompt library, fired from the composer palette. agent_id-scoped rows
 * appear only in that agent's workspace; null-scoped rows appear everywhere.
 * Variables stay in the content verbatim ({{name | select:options=[a,b]}}) —
 * the UI parses them into a form at fire time; the server just stores text.
 */
import type { Db } from './db.js';

export interface SavedPrompt {
  id: number;
  agent_id: string | null;
  name: string;
  content: string;
  created_at: number;
}

export class PromptStore {
  constructor(private readonly db: Db) {}

  listFor(agent_id: string): SavedPrompt[] {
    return this.db
      .prepare(
        `SELECT * FROM workspace_prompts
         WHERE agent_id IS NULL OR agent_id = ?
         ORDER BY name COLLATE NOCASE`,
      )
      .all(agent_id) as SavedPrompt[];
  }

  create(agent_id: string | null, name: string, content: string): SavedPrompt {
    const r = this.db
      .prepare('INSERT INTO workspace_prompts (agent_id, name, content) VALUES (?, ?, ?)')
      .run(agent_id, name, content);
    return this.db.prepare('SELECT * FROM workspace_prompts WHERE id = ?').get(Number(r.lastInsertRowid)) as SavedPrompt;
  }

  update(id: number, patch: { name?: string; content?: string; agent_id?: string | null }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
    if (patch.content !== undefined) { sets.push('content = ?'); params.push(patch.content); }
    if (patch.agent_id !== undefined) { sets.push('agent_id = ?'); params.push(patch.agent_id); }
    if (!sets.length) return false;
    params.push(id);
    return this.db.prepare(`UPDATE workspace_prompts SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM workspace_prompts WHERE id = ?').run(id).changes > 0;
  }
}
