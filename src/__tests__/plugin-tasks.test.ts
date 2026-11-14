import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { PluginHost, ScopedDb } from '../plugins/host.js';
import { SecretStore } from '../auth/secret-store.js';
import type { PluginContext, PluginToolDef, RouteHandler, RouteMethod } from '../plugins/types.js';
import { tasksPlugin } from '../plugins/tasks/plugin.js';
import { normalizeTag, normalizeTitle } from '../plugins/tasks/store.js';
import { daysUntil, dueLabel, sessionTitle } from '../plugins/tasks/dates.js';

type Db = ReturnType<typeof openDatabase>;

function mountTools(db: Db): Map<string, PluginToolDef> {
  const host = new PluginHost(db, new SecretStore(db));
  host.register(tasksPlugin);
  return new Map(host.toolsFor('tasks').map(t => [t.name, t]));
}

async function call(tools: Map<string, PluginToolDef>, name: string, args: Record<string, unknown>, conversationId: number | null): Promise<string> {
  const def = tools.get(name);
  assert.ok(def, `tool ${name} exists`);
  const r = await def.handler(args, { agentId: 'tasks-assistant', conversationId });
  return r.content.map(b => b.text).join('\n');
}

interface Captured { status: number; body: unknown }
function mockRes() {
  const cap: Captured = { status: 200, body: undefined };
  const res = {
    status(code: number) { cap.status = code; return res; },
    json(payload: unknown) { cap.body = payload; return res; },
    end() { return res; },
  };
  return { res: res as unknown as Parameters<RouteHandler>[1], cap };
}

function mountRoutes(db: Db) {
  const routes = new Map<string, RouteHandler>();
  const host = new PluginHost(db, new SecretStore(db));
  host.register(tasksPlugin);
  const ctx = {
    id: 'tasks',
    db: new ScopedDb(db, 'tasks', true),
    logger: { info() {}, warn() {}, error() {} },
    secrets: { get: () => null, set() {}, has: () => false, delete: () => false, list: () => [] },
    extractor: undefined,
    route: (m: RouteMethod, p: string, h: RouteHandler) => { routes.set(`${m.toUpperCase()} ${p}`, h); },
    schedule() {},
  } as unknown as PluginContext;
  tasksPlugin.register!(ctx);
  return async (method: string, path: string, over: { body?: unknown; params?: Record<string, string>; query?: Record<string, unknown> } = {}) => {
    const h = routes.get(`${method} ${path}`);
    assert.ok(h, `route ${method} ${path}`);
    const { res, cap } = mockRes();
    await h({ body: over.body ?? {}, params: over.params ?? {}, query: over.query ?? {} } as unknown as Parameters<RouteHandler>[0], res);
    return cap;
  };
}

describe('tasks plugin: sessions over one backlog', () => {
  let db: Db;
  let tools: Map<string, PluginToolDef>;
  beforeEach(() => { db = openDatabase(':memory:'); tools = mountTools(db); });

  it('a session belongs to its chat and starts empty even when the backlog is full', async () => {
    assert.match(await call(tools, 'add', { title: 'Finish taxes', tags: ['Admin'] }, 1), /Added #1 \[open\] Finish taxes — admin/);
    assert.match(await call(tools, 'add', { title: 'Mount dryer box' }, 1), /Added #2/);
    const other = await call(tools, 'session', {}, 2);
    assert.match(other, /^Today: /);
    assert.match(other, /0 open, 0 done/);
    assert.match(other, /\(no items yet\)/);
    assert.match(other, /Tags in use: admin 1/);
    const first = await call(tools, 'session', {}, 1);
    assert.match(first, /2 open, 0 done/);
    assert.match(first, /#1 \[open\] Finish taxes — admin\n#2 \[open\] Mount dryer box/);
  });

  it('naming something already in the backlog links it instead of duplicating', async () => {
    await call(tools, 'add', { title: 'Finish the homestead exemption paperwork', tags: ['admin'] }, 1);
    const again = await call(tools, 'add', { title: 'finish the homestead exemption paperwork!', tags: ['house'] }, 2);
    assert.match(again, /Already in the backlog as #1/);
    assert.match(again, /admin, house/, 'tags merge');
    assert.match(await call(tools, 'session', {}, 2), /1 open/);
    assert.match(await call(tools, 'find', {}, null), /^#1 \[open\]/m);
    assert.doesNotMatch(await call(tools, 'find', {}, null), /#2/);
  });

  it('short titles never swallow each other by containment', async () => {
    await call(tools, 'add', { title: 'Taxes' }, 1);
    assert.match(await call(tools, 'add', { title: 'Tax the jeep' }, 1), /Added #2/);
  });

  it('done, reopen and drop carry the reason and show up in the session', async () => {
    await call(tools, 'add', { title: 'Weld heater frame' }, 1);
    await call(tools, 'add', { title: 'Fix the pipe beam' }, 1);
    assert.match(await call(tools, 'done', { item_ids: [1] }, 1), /Done: #1 Weld heater frame/);
    assert.match(await call(tools, 'drop', { item_id: 2, reason: 'dictation garbage, nobody knows what it meant' }, 1), /Dropped: #2 .*dictation garbage/);
    const s = await call(tools, 'session', {}, 1);
    assert.match(s, /0 open, 1 done, 1 dropped/);
    assert.match(s, /#2 \[dropped\] Fix the pipe beam — dropped: dictation garbage/);
    assert.match(await call(tools, 'reopen', { item_id: 1 }, 1), /Open again: #1/);
    assert.match(await call(tools, 'session', {}, 1), /1 open, 0 done, 1 dropped/);
  });

  it('pull brings an open item into the session once; closed items are refused', async () => {
    await call(tools, 'add', { title: 'Paint calipers', tags: ['truck'] }, 1);
    await call(tools, 'add', { title: 'Old thing' }, 1);
    await call(tools, 'done', { item_ids: [2] }, 1);
    assert.match(await call(tools, 'pull', { item_id: 1 }, 2), /Pulled #1 \[open\] Paint calipers — truck/);
    assert.match(await call(tools, 'pull', { item_id: 1 }, 2), /already in this session/);
    assert.match(await call(tools, 'pull', { item_id: 2 }, 2), /#2 is done/);
    assert.match(await call(tools, 'pull', { item_id: 99 }, 2), /No item #99/);
  });

  it('update changes notes, due, blocker, tags and parent; subtasks render indented', async () => {
    await call(tools, 'add', { title: 'Build manifold board' }, 1);
    await call(tools, 'add', { title: 'Buy wood', parent_id: 1 }, 1);
    const u = await call(tools, 'update', { item_id: 1, notes: '7 cold / 6 hot, 1" trunk', due: '2099-01-01', blocker: 'waiting on PEX fittings', tags: ['house', 'plumbing'] }, 1);
    assert.match(u, /#1 \[open\] Build manifold board — house, plumbing · due 2099-01-01 \(in \d+ days\) · blocked: waiting on PEX fittings\n {4}7 cold \/ 6 hot, 1" trunk/);
    const s = await call(tools, 'session', {}, 1);
    assert.match(s, /#1 \[open\] Build manifold board[^\n]*\n {4}7 cold[^\n]*\n {2}#2 \[open\] Buy wood/);
    assert.match(await call(tools, 'update', { item_id: 1, due: '', blocker: '', parent_id: 0 }, 1), /#1 \[open\] Build manifold board — house, plumbing\n/);
  });

  it('find searches explicitly: words, tag, done included only on request', async () => {
    await call(tools, 'add', { title: 'Replace spark plugs', tags: ['truck'], notes: 'cylinder 3 had oil' }, 1);
    await call(tools, 'add', { title: 'File the insurance appeal', tags: ['health'] }, 1);
    await call(tools, 'done', { item_ids: [2] }, 1);
    assert.match(await call(tools, 'find', { q: 'oil' }, null), /#1/);
    assert.doesNotMatch(await call(tools, 'find', { q: 'oil' }, null), /#2/);
    assert.equal(await call(tools, 'find', { tag: 'health' }, null), '(nothing matched)');
    assert.match(await call(tools, 'find', { tag: 'health', include_done: true }, null), /#2 \[done\]/);
  });

  it('session topic lands in the title, and history lists sessions newest first', async () => {
    await call(tools, 'session', { topic: 'taxes' }, 1);
    await call(tools, 'add', { title: 'Gather W-2s' }, 1);
    await call(tools, 'done', { item_ids: [1] }, 1);
    await call(tools, 'session', { topic: 'house' }, 2);
    const h = await call(tools, 'history', {}, null);
    const lines = h.split('\n');
    assert.match(lines[0], /^Tasks — .* · house \(#2\) — 0 open, 0 done$/);
    assert.match(lines[1], /^Tasks — .* · taxes \(#1\) — 0 open, 1 done$/);
  });

  it('tools that need a chat say so outside one', async () => {
    assert.match(await call(tools, 'session', {}, null), /works inside a chat/);
    assert.match(await call(tools, 'add', { title: 'x' }, null), /works inside a chat/);
    assert.match(await call(tools, 'history', {}, null), /no sessions yet/);
  });
});

describe('tasks plugin: routes', () => {
  it('creates a session for a conversation, lists items, patches status with a reason', async () => {
    const db = openDatabase(':memory:');
    const req = mountRoutes(db);
    const created = await req('POST', '/sessions', { body: { conversation_id: 7, topic: 'weekend' } });
    assert.equal(created.status, 201);
    const s = created.body as { id: number; title: string; conversation_id: number };
    assert.equal(s.conversation_id, 7);
    assert.match(s.title, /^Tasks — .* · weekend$/);
    const same = await req('POST', '/sessions', { body: { conversation_id: 7 } });
    assert.equal((same.body as { id: number }).id, s.id, 'one session per chat');

    const item = await req('POST', '/items', { body: { title: 'Clean vertical surfaces', tags: ['House', 'Cleaning'], session_id: s.id } });
    assert.equal(item.status, 201);
    assert.deepEqual((item.body as { tags: string[] }).tags, ['cleaning', 'house']);

    const view = await req('GET', '/sessions/:id', { params: { id: String(s.id) } });
    assert.equal((view.body as { items: unknown[] }).items.length, 1);
    assert.equal((view.body as { session: { open: number } }).session.open, 1);

    const dropped = await req('PATCH', '/items/:id', { params: { id: '1' }, body: { status: 'dropped', reason: 'moved house', session_id: s.id } });
    assert.equal((dropped.body as { status: string; drop_reason: string }).drop_reason, 'moved house');
    const after = await req('GET', '/sessions/:id', { params: { id: String(s.id) } });
    assert.equal((after.body as { session: { dropped: number } }).session.dropped, 1);

    const tags = await req('GET', '/tags');
    assert.deepEqual((tags.body as { tags: Array<{ tag: string }> }).tags.map(t => t.tag), ['cleaning', 'house']);
    assert.equal((await req('GET', '/sessions/:id', { params: { id: '999' } })).status, 404);
    assert.equal((await req('PATCH', '/items/:id', { params: { id: 'x' }, body: {} })).status, 400);
  });
});

describe('tasks plugin: helpers', () => {
  it('normalises tags and titles', () => {
    assert.equal(normalizeTag('  House Projects!! '), 'house-projects');
    assert.equal(normalizeTitle('Finish the homestead exemption paperwork!'), 'finish the homestead exemption paperwork');
  });
  it('dates read like a person says them', () => {
    assert.equal(daysUntil('2026-11-20', '2026-11-13'), 7);
    assert.equal(dueLabel('2026-11-13', '2026-11-13'), 'today');
    assert.equal(dueLabel('2026-11-14', '2026-11-13'), 'tomorrow');
    assert.equal(dueLabel('2026-11-10', '2026-11-13'), '3 days overdue');
    assert.equal(sessionTitle('2026-10-18', ''), 'Tasks — October 18, 2026');
    assert.equal(sessionTitle('2026-10-18', 'taxes'), 'Tasks — October 18, 2026 · taxes');
  });
});
