import type { PluginDb } from '../types.js';

export type TaskStatus = 'backlog' | 'doing' | 'done' | 'blocked';

export interface Project {
  id: string;
  name: string;
  working_dir: string;
  description: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface ProjectWrite {
  id: string;
  name: string;
  working_dir?: string;
  description?: string;
  enabled?: boolean;
}

export interface Task {
  id: number;
  project_id: string;
  title: string;
  status: TaskStatus;
  detail: string;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface TaskCreate {
  project_id: string;
  title: string;
  status?: TaskStatus;
  detail?: string;
}

export interface TaskPatch {
  title?: string;
  status?: TaskStatus;
  detail?: string;
  position?: number;
}

interface ProjectRow {
  id: string;
  name: string;
  working_dir: string;
  description: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface TaskRow {
  id: number;
  project_id: string;
  title: string;
  status: TaskStatus;
  detail: string;
  position: number;
  created_at: number;
  updated_at: number;
}

function toProject(r: ProjectRow): Project {
  return { ...r, enabled: r.enabled === 1 };
}

function toTask(r: TaskRow): Task {
  return { ...r };
}

export class ProjectStore {
  constructor(private readonly db: PluginDb) {}
  private get t(): string { return this.db.table('projects'); }

  list(): Project[] {
    return (this.db.prepare(`SELECT * FROM ${this.t} ORDER BY name COLLATE NOCASE ASC`).all() as ProjectRow[]).map(toProject);
  }

  get(id: string): Project | null {
    const row = this.db.prepare(`SELECT * FROM ${this.t} WHERE id = ?`).get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  upsert(p: ProjectWrite): Project {
    this.db
      .prepare(
        `INSERT INTO ${this.t} (id, name, working_dir, description, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, working_dir = excluded.working_dir,
           description = excluded.description, enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(p.id, p.name, p.working_dir ?? '', p.description ?? '', p.enabled === false ? 0 : 1);
    return this.get(p.id) as Project;
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM ${this.t} WHERE id = ?`).run(id).changes > 0;
  }
}

export class TaskStore {
  constructor(private readonly db: PluginDb) {}
  private get t(): string { return this.db.table('tasks'); }

  list(): Task[] {
    return (this.db.prepare(`SELECT * FROM ${this.t} ORDER BY project_id ASC, position ASC, id ASC`).all() as TaskRow[]).map(toTask);
  }

  listFor(projectId: string): Task[] {
    return (this.db.prepare(`SELECT * FROM ${this.t} WHERE project_id = ? ORDER BY position ASC, id ASC`).all(projectId) as TaskRow[]).map(toTask);
  }

  get(id: number): Task | null {
    const row = this.db.prepare(`SELECT * FROM ${this.t} WHERE id = ?`).get(id) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  create(t: TaskCreate): Task {
    const res = this.db
      .prepare(
        `INSERT INTO ${this.t} (project_id, title, status, detail, position)
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM ${this.t} WHERE project_id = ?))`,
      )
      .run(t.project_id, t.title, t.status ?? 'backlog', t.detail ?? '', t.project_id);
    return this.get(Number(res.lastInsertRowid)) as Task;
  }

  update(id: number, patch: TaskPatch): Task | null {
    const cur = this.get(id);
    if (!cur) return null;
    this.db
      .prepare(`UPDATE ${this.t} SET title = ?, status = ?, detail = ?, position = ?, updated_at = strftime('%s','now') WHERE id = ?`)
      .run(patch.title ?? cur.title, patch.status ?? cur.status, patch.detail ?? cur.detail, patch.position ?? cur.position, id);
    return this.get(id);
  }

  delete(id: number): boolean {
    return this.db.prepare(`DELETE FROM ${this.t} WHERE id = ?`).run(id).changes > 0;
  }

  deleteForProject(projectId: string): number {
    return this.db.prepare(`DELETE FROM ${this.t} WHERE project_id = ?`).run(projectId).changes;
  }
}
