import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { PluginHost } from '../plugins/host.js';
import { SecretStore } from '../auth/secret-store.js';
import { SqliteJobStore } from '../scheduler/store.js';
import { SchedulerRunner } from '../scheduler/runner.js';
import type { Plugin } from '../plugins/types.js';

function setup(plugin: Plugin) {
  const db = openDatabase(':memory:');
  const host = new PluginHost(db, new SecretStore(db));
  const jobs = new SqliteJobStore(db);
  host.setJobStore(jobs);
  host.register(plugin);
  // register() installs; mountApi() is where register(ctx) and the job declarations run
  host.mountApi({ get() {}, post() {}, patch() {}, put() {}, delete() {} } as never);
  return { host, jobs };
}

describe('plugin-declared in-process jobs', () => {
  it('a `run` declaration becomes a plugin_task payload the host can execute', async () => {
    let calls = 0;
    const { host, jobs } = setup({
      manifest: { id: 'demo', name: 'Demo', version: '1' },
      register(ctx) { ctx.schedule({ name: 'sync', title: 'Demo sync', kind: 'every', spec: '24h', run: async () => { calls++; return calls > 1 ? 'again' : ''; } }); },
    });
    const job = jobs.read('plugin-demo-sync');
    assert.ok(job);
    assert.deepEqual(job.payload, { kind: 'plugin_task', plugin_id: 'demo', task: 'sync' });
    assert.equal(job.owner, 'plugin:demo');
    assert.ok(jobs.state('plugin-demo-sync')?.next_run_at);
    assert.equal(await host.runTask('demo', 'sync'), '');
    assert.equal(await host.runTask('demo', 'sync'), 'again');
    await assert.rejects(() => host.runTask('demo', 'nope'), /declares no task/);
    host.setEnabled('demo', false);
    await assert.rejects(() => host.runTask('demo', 'sync'), /disabled/);
  });

  it('a declaration must choose exactly one of command / run', () => {
    assert.throws(() => setup({
      manifest: { id: 'bad', name: 'Bad', version: '1' },
      register(ctx) { ctx.schedule({ name: 'x', title: 'x', kind: 'every', spec: '1h' }); },
    }), /exactly one of command \/ run/);
  });

  it('the runner dispatches plugin_task through the plugin host', async () => {
    const { host, jobs } = setup({
      manifest: { id: 'demo', name: 'Demo', version: '1' },
      register(ctx) { ctx.schedule({ name: 'tick', title: 'tick', kind: 'every', spec: '1h', run: () => 'ran', channel_ids: [1] }); },
    });
    const delivered: string[] = [];
    const runner = new SchedulerRunner({
      store: jobs,
      delivery: { send: async (_id, text) => { delivered.push(text); }, runningIds: () => [1] },
      agents: { get: () => { throw new Error('no agents'); } },
      plugins: host,
      now: () => Date.now() + 2 * 3_600_000,  // past the first due slot
    });
    await runner.tick();
    const runs = jobs.runs('plugin-demo-tick', 5);
    assert.equal(runs[0]?.status, 'ok', runs[0]?.error ?? 'no run');
    assert.match(runs[0]?.output ?? '', /ran/);
    assert.deepEqual(delivered, ['ran']);
  });
});
