import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';

// Plugin routes write connector credentials through the SecretStore, which needs a key.
process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
import { openDatabase } from '../db.js';
import { ScopedDb, PluginHost } from '../plugins/host.js';
import { SecretStore } from '../auth/secret-store.js';
import type { PluginContext, RouteHandler, RouteMethod, PluginSecrets } from '../plugins/types.js';
import { projectsPlugin } from '../plugins/projects/plugin.js';
import { financePlugin } from '../plugins/finance/plugin.js';
import { healthPlugin } from '../plugins/health/plugin.js';
import { FinanceStore } from '../plugins/finance/store.js';

// Minimal Express req/res doubles: enough for the plugins' handlers, which only
// read body/params/query and call res.status()/json()/end(). Captures the last
// status + payload so a test can assert on the handler's output.
interface Captured { status: number; body: unknown; ended: boolean }
function mockRes() {
  const cap: Captured = { status: 200, body: undefined, ended: false };
  const res = {
    status(code: number) { cap.status = code; return res; },
    json(payload: unknown) { cap.body = payload; cap.ended = true; return res; },
    send(payload: unknown) { cap.body = payload; cap.ended = true; return res; },
    setHeader() { return res; },
    end() { cap.ended = true; return res; },
  };
  return { res: res as unknown as Parameters<RouteHandler>[1], cap };
}
function mockReq(over: { body?: unknown; params?: Record<string, string>; query?: Record<string, unknown> } = {}) {
  return { body: over.body ?? {}, params: over.params ?? {}, query: over.query ?? {} } as unknown as Parameters<RouteHandler>[0];
}

/** Register a plugin against a capturing context and return an invoker keyed by
 *  "METHOD /path", plus the plugin's ScopedDb + secrets for seeding. */
function mountRoutes(plugin: typeof projectsPlugin, secretStore: SecretStore, db: ReturnType<typeof openDatabase>) {
  const routes = new Map<string, RouteHandler>();
  const ns = `plugin:${plugin.manifest.id}`;
  const secrets: PluginSecrets = {
    get: (n) => secretStore.get(ns, n),
    set: (n, v) => secretStore.set(ns, n, v),
    has: (n) => secretStore.has(ns, n),
    delete: (n) => secretStore.delete(ns, n),
    list: () => secretStore.list(ns).map(m => m.name),
  };
  const ctx: PluginContext = {
    id: plugin.manifest.id,
    db: new ScopedDb(db, plugin.manifest.id, true),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets,
    extractor: { extract: async () => ({}) },
    schedule: () => undefined,
    route: (method: RouteMethod, path: string, handler: RouteHandler) => routes.set(`${method} ${path}`, handler),
  };
  plugin.register!(ctx);
  const call = async (key: string, req = mockReq()) => {
    const handler = routes.get(key);
    assert.ok(handler, `no route ${key}`);
    const { res, cap } = mockRes();
    await handler(req, res);
    return cap;
  };
  return { call, routeKeys: [...routes.keys()] };
}

function freshHost() {
  const db = openDatabase(':memory:');
  const secretStore = new SecretStore(db);
  const host = new PluginHost(db, secretStore);
  return { db, secretStore, host };
}

describe('projects plugin HTTP routes', () => {
  let env: ReturnType<typeof mountRoutes>;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    const h = freshHost();
    db = h.db;
    h.host.register(projectsPlugin);
    env = mountRoutes(projectsPlugin, h.secretStore, db);
  });

  it('full CRUD lifecycle over projects + tasks', async () => {
    // create project
    let r = await env.call('post /projects', mockReq({ body: { id: 'proj-a', name: 'Project A' } }));
    assert.equal(r.status, 201);

    // list projects
    r = await env.call('get /projects');
    assert.equal((r.body as { projects: unknown[] }).projects.length, 1);

    // create task
    r = await env.call('post /tasks', mockReq({ body: { project_id: 'proj-a', title: 'first task' } }));
    assert.equal(r.status, 201);
    const taskId = (r.body as { id: number }).id;

    // list tasks scoped to a project
    r = await env.call('get /tasks', mockReq({ query: { project: 'proj-a' } }));
    assert.equal((r.body as { tasks: unknown[] }).tasks.length, 1);

    // patch task
    r = await env.call('patch /tasks/:id', mockReq({ params: { id: String(taskId) }, body: { status: 'done' } }));
    assert.equal((r.body as { status: string }).status, 'done');

    // delete task, then project
    r = await env.call('delete /tasks/:id', mockReq({ params: { id: String(taskId) } }));
    assert.equal(r.status, 204);
    r = await env.call('delete /projects/:id', mockReq({ params: { id: 'proj-a' } }));
    assert.equal(r.status, 204);
  });

  it('rejects an invalid project body with 400', async () => {
    const r = await env.call('post /projects', mockReq({ body: { id: 'BadUpper', name: '' } }));
    assert.equal(r.status, 400);
  });

  it('404s on a missing task patch and a non-integer id 400s', async () => {
    let r = await env.call('patch /tasks/:id', mockReq({ params: { id: '9999' }, body: { status: 'done' } }));
    assert.equal(r.status, 404);
    r = await env.call('patch /tasks/:id', mockReq({ params: { id: 'abc' }, body: { status: 'done' } }));
    assert.equal(r.status, 400);
    r = await env.call('delete /tasks/:id', mockReq({ params: { id: 'abc' } }));
    assert.equal(r.status, 400);
  });
});

describe('finance plugin HTTP routes (no network)', () => {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  it('connections status, manual accounts, transactions, splits, rules, budgets, goals', async () => {
    const { db, secretStore, host } = freshHost();
    host.register(financePlugin);
    const { call } = mountRoutes(financePlugin, secretStore, db);
    const store = new FinanceStore(new ScopedDb(db, 'finance'));

    let r = await call('get /connections');
    assert.equal((r.body as { plaid: { configured: boolean } }).plaid.configured, false);
    r = await call('post /connections/plaid/config', mockReq({ body: { client_id: 'c', secret: 's', env: 'sandbox' } }));
    assert.equal((r.body as { configured: boolean }).configured, true);
    r = await call('post /connections/plaid/link/complete');
    assert.equal(r.status, 409);  // configured, but no pending link session

    // manual account + balance update
    r = await call('post /accounts', mockReq({ body: { name: 'House', type: 'property', balance: 350000 } }));
    assert.equal(r.status, 201);
    const house = (r.body as { account: { id: string } }).account.id;
    r = await call('put /accounts/:id/balance', mockReq({ params: { id: house }, body: { balance: 355000 } }));
    assert.equal((r.body as { account: { balance: number } }).account.balance, 355000);
    r = await call('post /accounts', mockReq({ body: { name: 'Chk', type: 'depository', balance: 1000 } }));
    const chk = (r.body as { account: { id: string } }).account.id;
    r = await call('get /accounts');
    assert.equal((r.body as { net_worth: { net: number } }).net_worth.net, 356000);

    // manual transaction → keyword category; patch; splits must balance
    r = await call('post /transactions', mockReq({ body: { account_id: chk, date: today, payee: 'Trader Joes', amount: -80 } }));
    assert.equal(r.status, 201);
    const tid = (r.body as { transaction: { id: string; category_id: string } }).transaction.id;
    assert.equal((r.body as { transaction: { category_id: string } }).transaction.category_id, 'groceries');
    r = await call('patch /transactions/:id', mockReq({ params: { id: tid }, body: { notes: 'weekly', tags: ['Food'], reviewed: true } }));
    assert.deepEqual((r.body as { transaction: { tags: string[] } }).transaction.tags, ['food']);
    r = await call('put /transactions/:id/splits', mockReq({ params: { id: tid }, body: { splits: [{ category_id: 'groceries', amount: -50 }, { category_id: 'home_goods', amount: -20 }] } }));
    assert.equal(r.status, 400);
    r = await call('put /transactions/:id/splits', mockReq({ params: { id: tid }, body: { splits: [{ category_id: 'groceries', amount: -50 }, { category_id: 'home_goods', amount: -30 }] } }));
    assert.equal((r.body as { splits: unknown[] }).splits.length, 2);
    r = await call('get /transactions', mockReq({ query: { q: 'trader', limit: '10' } }));
    assert.equal((r.body as { total: number }).total, 1);
    r = await call('post /transactions', mockReq({ body: { account_id: 'nope', date: today, payee: 'x', amount: 1 } }));
    assert.equal(r.status, 404);

    // rules: create with apply_to_existing recategorizes rows not set by hand
    store.upsertTransaction({ id: 'sync1', account_id: chk, date: today, description: 'SQ *MYSTERY SHOP', amount: -12 });
    r = await call('post /rules', mockReq({ body: { pattern: 'mystery', set_category_id: 'coffee', apply_to_existing: true } }));
    assert.equal(r.status, 201);
    assert.equal((r.body as { applied: number }).applied, 1);
    assert.equal(store.getTransaction('sync1')!.category_id, 'coffee');
    assert.equal(store.getTransaction('sync1')!.category_source, 'rule');

    // budgets
    r = await call('put /budgets', mockReq({ body: { category_id: 'groceries', amount: 400 } }));
    assert.equal(r.status, 200);
    r = await call('get /budgets', mockReq({ query: { month } }));
    const line = (r.body as { lines: Array<{ category_id: string; actual: number; budget: number }> }).lines.find(l => l.category_id === 'groceries')!;
    assert.equal(line.budget, 400);
    assert.equal(line.actual, 50);  // the split, not the parent
    r = await call('delete /budgets/:category/:month', mockReq({ params: { category: 'groceries', month: '*' } }));
    assert.equal(r.status, 204);

    // categories
    r = await call('post /categories', mockReq({ body: { id: 'kids', name: 'Kids', group_name: 'Personal' } }));
    assert.equal(r.status, 201);
    r = await call('post /categories', mockReq({ body: { id: 'kids', name: 'Kids', group_name: 'Personal' } }));
    assert.equal(r.status, 409);
    r = await call('delete /categories/:id', mockReq({ params: { id: 'uncategorized' } }));
    assert.equal(r.status, 404);

    // goals + recurring + overview
    r = await call('post /goals', mockReq({ body: { name: 'Cushion', target_amount: 2000, account_ids: [chk] } }));
    assert.equal(r.status, 201);
    r = await call('get /goals');
    assert.equal((r.body as { goals: Array<{ progress: number }> }).goals[0].progress, 0.5);
    r = await call('post /recurring', mockReq({ body: { display_name: 'Netflix', amount: -15.49, cadence: 'monthly', next_date: today } }));
    assert.equal(r.status, 201);
    r = await call('get /overview');
    const ov = r.body as { net_worth: { net: number }; upcoming: unknown[]; uncategorized_count: number };
    assert.equal(ov.net_worth.net, 356000);
    assert.equal(ov.upcoming.length, 1);

    // export
    r = await call('get /transactions/export.csv');
    assert.equal(r.status, 200);
  });

  it('plaid-requiring routes 409 when Plaid is not configured', async () => {
    const { db, secretStore, host } = freshHost();
    host.register(financePlugin);
    const { call } = mountRoutes(financePlugin, secretStore, db);
    const r = await call('post /connections/plaid/link/start');
    assert.equal(r.status, 409);
  });
});

describe('health plugin HTTP routes', () => {
  it('observations + medications + documents CRUD and query-string reads', async () => {
    const { db, secretStore, host } = freshHost();
    host.register(healthPlugin);
    const { call } = mountRoutes(healthPlugin, secretStore, db);

    // create an observation
    let r = await call('post /observations', mockReq({ body: { date: '2026-01-01', kind: 'lab', label: 'LDL', value: 120 } }));
    assert.equal(r.status, 201);

    r = await call('get /overview');
    assert.ok((r.body as { labs: unknown[] }).labs.length >= 1);

    // series read pulls the label off the query string
    r = await call('get /series', mockReq({ query: { label: 'LDL' } }));
    assert.equal((r.body as { label: string }).label, 'LDL');

    // observations list honours the label query filter
    r = await call('get /observations', mockReq({ query: { label: 'LDL', limit: '10' } }));
    assert.equal((r.body as { observations: unknown[] }).observations.length, 1);

    // a bad body is a 400
    r = await call('post /observations', mockReq({ body: { label: '' } }));
    assert.equal(r.status, 400);

    // medications
    r = await call('post /medications', mockReq({ body: { name: 'Statin', start_date: '2026-01-01' } }));
    assert.equal(r.status, 201);
    r = await call('get /medications', mockReq({ query: { active: '1' } }));
    assert.equal((r.body as { medications: unknown[] }).medications.length, 1);

    // documents + search
    r = await call('post /documents', mockReq({ body: { category: 'benefits', title: 'Plan', text: 'acupuncture is covered', source: 'agent' } }));
    assert.equal(r.status, 201);
    r = await call('get /documents/search', mockReq({ query: { q: 'acupuncture' } }));
    assert.ok((r.body as { hits: unknown[] }).hits.length >= 1);

    // labels + correlate read their inputs off the query string
    r = await call('get /labels');
    assert.ok(Array.isArray((r.body as { labels: unknown[] }).labels));
    r = await call('get /correlate', mockReq({ query: { a: 'LDL', b: 'LDL' } }));
    assert.equal((r.body as { a: string; b: string }).a, 'LDL');
  });
});
