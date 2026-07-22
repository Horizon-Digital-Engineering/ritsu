import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Request, Response } from 'express';
import type { Plugin, PluginContext, PluginDb, PluginToolContext } from '../types.js';
import { ProjectStore, TaskStore } from './store.js';
import { ProjectWriteSchema, TaskCreateSchema, TaskPatchSchema } from './schema.js';

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function defineTools(ctx: PluginToolContext): void {
  const projects = new ProjectStore(ctx.db);
  const tasks = new TaskStore(ctx.db);

  ctx.tool({
    name: 'list_projects',
    description: 'List all projects (id, name, working directory, enabled state).',
    input: {},
    untrustedOutput: true,
    handler: () => {
      const rows = projects.list();
      return text(rows.length ? rows.map(p => `${p.id} — ${p.name}${p.working_dir ? ` (${p.working_dir})` : ''}${p.enabled ? '' : ' [disabled]'}`).join('\n') : '(no projects)');
    },
  });

  ctx.tool({
    name: 'create_project',
    description: 'Create a project (or update an existing one by id). Needs an id (lowercase kebab-case) and a name.',
    needsApproval: true,
    input: {
      id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(128).describe('lowercase kebab-case id, e.g. "test-project"'),
      name: z.string().min(1).max(200).describe('display name'),
      working_dir: z.string().max(512).optional().describe('working directory on the host'),
      description: z.string().max(4000).optional().describe('what this project is'),
    },
    handler: (args) => {
      const p = projects.upsert({
        id: String(args.id),
        name: String(args.name),
        working_dir: typeof args.working_dir === 'string' ? args.working_dir : undefined,
        description: typeof args.description === 'string' ? args.description : undefined,
      });
      return text(`created project ${p.id} (${p.name})`);
    },
  });

  ctx.tool({
    name: 'list_tasks',
    description: 'List tasks. Pass project to scope to one project; omit for the whole backlog.',
    input: { project: z.string().max(128).optional().describe('project id to filter by') },
    untrustedOutput: true,
    handler: (args) => {
      const project = typeof args.project === 'string' ? args.project : undefined;
      const rows = project ? tasks.listFor(project) : tasks.list();
      return text(rows.length ? rows.map(t => `[${t.id}] (${t.project_id}) ${t.status} — ${t.title}`).join('\n') : '(no tasks)');
    },
  });

  ctx.tool({
    name: 'create_task',
    description: 'Add a task to a project backlog.',
    needsApproval: true,
    input: {
      project_id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(128).describe('the project id this task belongs to'),
      title: z.string().min(1).max(200).describe('short task title'),
      status: z.enum(['backlog', 'doing', 'done', 'blocked']).optional().describe('defaults to backlog'),
      detail: z.string().max(4000).optional().describe('optional longer note'),
    },
    handler: (args) => {
      const t = tasks.create({
        project_id: String(args.project_id),
        title: String(args.title),
        status: args.status as 'backlog' | 'doing' | 'done' | 'blocked' | undefined,
        detail: typeof args.detail === 'string' ? args.detail : undefined,
      });
      return text(`created task ${t.id} in ${t.project_id}`);
    },
  });

  ctx.tool({
    name: 'update_task',
    description: 'Update a task\'s status, title, or detail by id.',
    needsApproval: true,
    input: {
      id: z.number().int().positive().describe('task id'),
      status: z.enum(['backlog', 'doing', 'done', 'blocked']).optional(),
      title: z.string().min(1).max(200).optional(),
      detail: z.string().max(4000).optional(),
    },
    handler: (args) => {
      const updated = tasks.update(Number(args.id), {
        status: args.status as 'backlog' | 'doing' | 'done' | 'blocked' | undefined,
        title: typeof args.title === 'string' ? args.title : undefined,
        detail: typeof args.detail === 'string' ? args.detail : undefined,
      });
      return text(updated ? `updated task ${updated.id} → ${updated.status}` : `no task with id ${String(args.id)}`);
    },
  });
}

function migrate(db: PluginDb): void {
  const projects = db.table('projects');
  const tasks = db.table('tasks');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${projects} (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      working_dir TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS ${tasks} (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','doing','done','blocked')),
      detail      TEXT NOT NULL DEFAULT '',
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_${tasks}_project ON ${tasks}(project_id);
  `);
  importLegacy(db, projects, tasks);
}

function importLegacy(db: PluginDb, projects: string, tasks: string): void {
  try {
    db.exec(`INSERT OR IGNORE INTO ${projects} (id, name, working_dir, description, enabled, created_at, updated_at)
             SELECT id, name, working_dir, description, enabled, created_at, updated_at FROM projects`);
    db.exec(`INSERT OR IGNORE INTO ${tasks} (id, project_id, title, status, detail, position, created_at, updated_at)
             SELECT id, project_id, title, status, detail, position, created_at, updated_at FROM tasks`);
  } catch {
    /* no legacy core tables — fresh install */
  }
}

function parse<T>(req: Request, res: Response, schema: z.ZodType<T>): T | null {
  const r = schema.safeParse(req.body);
  if (!r.success) {
    res.status(400).json({ error: 'invalid request body', issues: z.treeifyError(r.error) });
    return null;
  }
  return r.data;
}

function register(ctx: PluginContext): void {
  const projects = new ProjectStore(ctx.db);
  const tasks = new TaskStore(ctx.db);

  ctx.route('get', '/projects', (_req, res) => {
    res.json({ projects: projects.list() });
  });

  ctx.route('post', '/projects', (req, res) => {
    const b = parse(req, res, ProjectWriteSchema);
    if (!b) return;
    try { res.status(201).json(projects.upsert(b)); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  ctx.route('delete', '/projects/:id', (req, res) => {
    const id = String(req.params.id);
    tasks.deleteForProject(id);
    res.status(projects.delete(id) ? 204 : 404).end();
  });

  ctx.route('get', '/tasks', (req, res) => {
    const project = req.query.project as string | undefined;
    res.json({ tasks: project ? tasks.listFor(project) : tasks.list() });
  });

  ctx.route('post', '/tasks', (req, res) => {
    const b = parse(req, res, TaskCreateSchema);
    if (!b) return;
    try { res.status(201).json(tasks.create(b)); }
    catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  ctx.route('patch', '/tasks/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: 'id must be integer' }); return; }
    const b = parse(req, res, TaskPatchSchema);
    if (!b) return;
    const updated = tasks.update(id, b);
    if (!updated) { res.status(404).json({ error: 'task not found' }); return; }
    res.json(updated);
  });

  ctx.route('delete', '/tasks/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) { res.status(400).json({ error: 'id must be integer' }); return; }
    res.status(tasks.delete(id) ? 204 : 404).end();
  });
}

export const projectsPlugin: Plugin = {
  manifest: {
    id: 'projects',
    name: 'Projects',
    version: '1.0.0',
    description: 'Multi-project manager with per-project and aggregated task backlogs.',
    nav: [
      { id: 'projects', label: 'Projects', tabs: [{ id: 'projects', label: 'Projects' }] },
      { id: 'backlog', label: 'Backlog', tabs: [{ id: 'backlog', label: 'Backlog' }] },
    ],
  },
  migrate,
  defineTools,
  register,
  assetsDir: fileURLToPath(new URL('./ui', import.meta.url)),
};
