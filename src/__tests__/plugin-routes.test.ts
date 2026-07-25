import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
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

describe('finance plugin HTTP routes (no Plaid network)', () => {
  beforeEach(() => { process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64'); });

  it('status/config/accounts/report/targets/items round-trip without a bank link', async () => {
    const { db, secretStore, host } = freshHost();
    host.register(financePlugin);
    const { call } = mountRoutes(financePlugin, secretStore, db);
    const store = new FinanceStore(new ScopedDb(db, 'finance'));

    // status before config → not configured
    let r = await call('get /status');
    assert.equal((r.body as { configured: boolean }).configured, false);

    // config sets the credentials (secrets), status flips
    r = await call('post /config', mockReq({ body: { client_id: 'c', secret: 's', env: 'sandbox' } }));
    assert.equal((r.body as { configured: boolean }).configured, true);
    r = await call('get /status');
    assert.equal((r.body as { configured: boolean }).configured, true);

    // seed an account + transaction, then read accounts + report
    store.upsertAccount({ account_id: 'a', item_id: 'i', name: 'Chk', official_name: '', type: 'depository', subtype: 'checking', mask: '1', current_balance: 100, available_balance: 100, iso_currency: 'USD' });
    store.upsertTransaction({ transaction_id: 't', account_id: 'a', date: new Date().toISOString().slice(0, 10), name: 'Store', merchant_name: 'Store', amount: 20, iso_currency: 'USD', category: 'SHOPPING', category_detailed: '', pending: false });
    r = await call('get /accounts');
    assert.equal((r.body as { accounts: unknown[] }).accounts.length, 1);
    r = await call('get /report', mockReq({ query: { days: '30' } }));
    assert.ok((r.body as { byCategory: unknown[] }).byCategory.length >= 1);

    // targets: create then delete
    r = await call('post /targets', mockReq({ body: { category: 'SHOPPING', monthly_limit: 200 } }));
    assert.equal(r.status, 201);
    r = await call('delete /targets/:category', mockReq({ params: { category: 'SHOPPING' } }));
    assert.equal(r.status, 204);
    r = await call('delete /targets/:category', mockReq({ params: { category: 'nope' } }));
    assert.equal(r.status, 404);

    // a Plaid-requiring route 409s when Plaid is configured but we don't call out
    // (delete item never touches the network)
    r = await call('delete /items/:itemId', mockReq({ params: { itemId: 'i' } }));
    assert.equal(r.status, 204);
  });

  it('link routes 409 when Plaid is not configured', async () => {
    const { db, secretStore, host } = freshHost();
    host.register(financePlugin);
    const { call } = mountRoutes(financePlugin, secretStore, db);
    const r = await call('post /link/start');
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
