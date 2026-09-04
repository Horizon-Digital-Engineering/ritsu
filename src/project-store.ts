/**
 * Workspace projects — named groups an operator files chats and workspace
 * files under, inside one agent's workspace UI. Projects will eventually
 * carry context of their own; v1 organizes only — it does not yet feed a
 * project's files into the chats filed under it (that arrives with the
 * memory work).
 *
 * Organizational only, and deletion honors that: deleting a project unfiles
 * its conversations and drops its file tags — it never deletes a conversation
 * or touches a file on disk.
 *
 * File tags store canonical absolute paths under the agent's workspace roots.
 * The filesystem is authoritative: a tag whose file was moved or deleted just
 * dangles until read-time filtering drops it.
 */
import type { Db } from './db.js';
import { logger } from './util/log.js';

export interface Project {
  id: number;
  agent_id: string;
  name: string;
  created_at: number;
  /** Conversations filed under this project. */
  chat_count: number;
  /** File tags on this project (may include dangling paths). */
  file_count: number;
}

export class ProjectStore {
  constructor(private readonly db: Db) {}

  listFor(agent_id: string): Project[] {
    return this.db
      .prepare(
        `SELECT p.id, p.agent_id, p.name, p.created_at,
                (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS chat_count,
                (SELECT COUNT(*) FROM agent_project_files f WHERE f.project_id = p.id) AS file_count
         FROM agent_projects p
         WHERE p.agent_id = ?
         ORDER BY p.name COLLATE NOCASE ASC`,
      )
      .all(agent_id) as Project[];
  }

  read(id: number): Project | null {
    const row = this.db
      .prepare(
        `SELECT p.id, p.agent_id, p.name, p.created_at,
                (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id) AS chat_count,
                (SELECT COUNT(*) FROM agent_project_files f WHERE f.project_id = p.id) AS file_count
         FROM agent_projects p WHERE p.id = ?`,
      )
      .get(id) as Project | undefined;
    return row ?? null;
  }

  create(agent_id: string, name: string): Project {
    const r = this.db
      .prepare('INSERT INTO agent_projects (agent_id, name) VALUES (?, ?)')
      .run(agent_id, name);
    logger.info('project.created', { agent_id, name, id: Number(r.lastInsertRowid) });
    // The row was just inserted; read() cannot miss it.
    return this.read(Number(r.lastInsertRowid))!;
  }

  rename(id: number, name: string): boolean {
    const r = this.db.prepare('UPDATE agent_projects SET name = ? WHERE id = ?').run(name, id);
    return r.changes > 0;
  }

  /** Unfiles members, never deletes them. One transaction so a crash can't
   *  leave chats pointing at a project row that no longer exists. */
  delete(id: number): boolean {
    let removed = false;
    this.db.transaction(() => {
      this.db.prepare('UPDATE conversations SET project_id = NULL WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM agent_project_files WHERE project_id = ?').run(id);
      removed = this.db.prepare('DELETE FROM agent_projects WHERE id = ?').run(id).changes > 0;
    })();
    if (removed) logger.info('project.deleted', { id });
    return removed;
  }

  /**
   * Tag a file into a project, exclusively: a path belongs to at most one of
   * the agent's projects, so tagging moves it rather than multiplying it.
   * `path` must already be canonical — the file API canonicalizes before
   * calling. project_id null = untag from every project of this agent.
   */
  tagFile(agent_id: string, path: string, project_id: number | null): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM agent_project_files
           WHERE path = ?
             AND project_id IN (SELECT id FROM agent_projects WHERE agent_id = ?)`,
        )
        .run(path, agent_id);
      if (project_id != null) {
        this.db
          .prepare('INSERT INTO agent_project_files (project_id, path) VALUES (?, ?)')
          .run(project_id, path);
      }
    })();
  }

  /** path → project_id for every tag across this agent's projects, so the file
   *  browser resolves tags in one query instead of one per file. */
  fileTagsFor(agent_id: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT f.path, f.project_id
         FROM agent_project_files f
         JOIN agent_projects p ON p.id = f.project_id
         WHERE p.agent_id = ?`,
      )
      .all(agent_id) as Array<{ path: string; project_id: number }>;
    return new Map(rows.map(r => [r.path, r.project_id]));
  }

  /** Drop a tag whose file no longer exists on disk (read-time hygiene). */
  dropTag(path: string): void {
    this.db.prepare('DELETE FROM agent_project_files WHERE path = ?').run(path);
  }
}
