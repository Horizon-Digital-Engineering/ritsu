/**
 * Skills — operator-authored markdown instruction sets, shared across agents.
 *
 * The binding is lazy on purpose: an agent with bound skills carries only a
 * one-line-per-skill manifest in its system context; the body loads on demand
 * through the view_skill tool. Twenty bound skills cost no context until one
 * is actually needed — the pattern that makes a skill library viable on a
 * multi-agent server, where the alternative is duplicating prompt text into
 * every agent definition.
 */
import type { Db } from './db.js';
import { logger } from './util/log.js';

export interface Skill {
  id: number;
  name: string;
  description: string;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface SkillMeta extends Omit<Skill, 'content'> {
  /** Agents currently bound to this skill. */
  agents: string[];
}

export class SkillStore {
  constructor(private readonly db: Db) {}

  list(): SkillMeta[] {
    const rows = this.db
      .prepare('SELECT id, name, description, created_at, updated_at FROM skills ORDER BY name COLLATE NOCASE')
      .all() as Array<Omit<SkillMeta, 'agents'>>;
    const binds = this.db
      .prepare('SELECT agent_id, skill_id FROM agent_skills')
      .all() as Array<{ agent_id: string; skill_id: number }>;
    const byId = new Map<number, string[]>();
    for (const b of binds) {
      const arr = byId.get(b.skill_id) ?? [];
      arr.push(b.agent_id);
      byId.set(b.skill_id, arr);
    }
    return rows.map(r => ({ ...r, agents: (byId.get(r.id) ?? []).sort() }));
  }

  read(id: number): Skill | null {
    return (this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Skill | undefined) ?? null;
  }

  readByName(name: string): Skill | null {
    return (this.db
      .prepare('SELECT * FROM skills WHERE name = ? COLLATE NOCASE')
      .get(name) as Skill | undefined) ?? null;
  }

  create(name: string, description: string, content: string): Skill {
    const r = this.db
      .prepare('INSERT INTO skills (name, description, content) VALUES (?, ?, ?)')
      .run(name, description, content);
    logger.info('skill.created', { name, id: Number(r.lastInsertRowid) });
    return this.read(Number(r.lastInsertRowid))!;
  }

  update(id: number, patch: { name?: string; description?: string; content?: string }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const k of ['name', 'description', 'content'] as const) {
      if (patch[k] !== undefined) { sets.push(`${k} = ?`); params.push(patch[k]); }
    }
    if (!sets.length) return false;
    sets.push(`updated_at = strftime('%s','now')`);
    params.push(id);
    return this.db.prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
  }

  delete(id: number): boolean {
    let removed = false;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM agent_skills WHERE skill_id = ?').run(id);
      removed = this.db.prepare('DELETE FROM skills WHERE id = ?').run(id).changes > 0;
    })();
    return removed;
  }

  bind(agent_id: string, skill_id: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO agent_skills (agent_id, skill_id) VALUES (?, ?)')
      .run(agent_id, skill_id);
  }

  unbind(agent_id: string, skill_id: number): boolean {
    return this.db
      .prepare('DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?')
      .run(agent_id, skill_id).changes > 0;
  }

  /** name + description per bound skill — the lazy manifest. */
  manifestFor(agent_id: string): Array<{ name: string; description: string }> {
    return this.db
      .prepare(
        `SELECT s.name, s.description FROM skills s
         JOIN agent_skills b ON b.skill_id = s.id
         WHERE b.agent_id = ? ORDER BY s.name COLLATE NOCASE`,
      )
      .all(agent_id) as Array<{ name: string; description: string }>;
  }

  /** Body lookup for the view_skill tool: bound skills only — an agent may
   *  not browse the whole library, just what the operator gave it. */
  contentFor(agent_id: string, name: string): string | null {
    const row = this.db
      .prepare(
        `SELECT s.content FROM skills s
         JOIN agent_skills b ON b.skill_id = s.id
         WHERE b.agent_id = ? AND s.name = ? COLLATE NOCASE`,
      )
      .get(agent_id, name) as { content: string } | undefined;
    return row?.content ?? null;
  }
}
