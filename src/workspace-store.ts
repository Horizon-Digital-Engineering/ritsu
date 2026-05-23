import type { Db } from './db.js';

export type Permission = 'read' | 'write' | 'exec';

export interface Workspace {
  id: number;
  agent_id: string;
  path: string;
  permissions: Permission[];
  created_at: number;
}

interface WorkspaceRow {
  id: number;
  agent_id: string;
  path: string;
  permissions: string;
  created_at: number;
}

function rowToWs(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    agent_id: r.agent_id,
    path: r.path,
    permissions: r.permissions.split(',').filter(Boolean) as Permission[],
    created_at: r.created_at,
  };
}

export interface WorkspaceWrite {
  agent_id: string;
  path: string;
  permissions: Permission[];
}

/**
 * Per-agent filesystem roots. Each row is "agent X is allowed on path Y with
 * permissions Z". V0.3 uses the lowest-id row as the agent's cwd for tool
 * dispatch. V0.4 will enforce permissions per tool call.
 *
 * Path traversal protection happens at the tool layer; this store stores
 * exactly what was set. The admin UI should resolve to absolute paths
 * before writing.
 */
export class WorkspaceStore {
  constructor(private readonly db: Db) {}

  listFor(agent_id: string): Workspace[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_workspaces WHERE agent_id = ? ORDER BY id ASC')
      .all(agent_id) as WorkspaceRow[];
    return rows.map(rowToWs);
  }

  upsert(w: WorkspaceWrite): Workspace {
    const perms = [...new Set(w.permissions)].sort((a, b) => a.localeCompare(b)).join(',');
    this.db
      .prepare(
        `INSERT INTO agent_workspaces (agent_id, path, permissions)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_id, path) DO UPDATE SET permissions = excluded.permissions`,
      )
      .run(w.agent_id, w.path, perms);
    const row = this.db
      .prepare('SELECT * FROM agent_workspaces WHERE agent_id = ? AND path = ?')
      .get(w.agent_id, w.path) as WorkspaceRow;
    return rowToWs(row);
  }

  delete(id: number): boolean {
    const r = this.db.prepare('DELETE FROM agent_workspaces WHERE id = ?').run(id);
    return r.changes > 0;
  }

  deleteAll(agent_id: string): number {
    const r = this.db.prepare('DELETE FROM agent_workspaces WHERE agent_id = ?').run(agent_id);
    return r.changes;
  }
}
