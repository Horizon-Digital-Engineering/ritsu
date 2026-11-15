import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDatabase, type Db } from '../db.js';
import { createParts, summarize, type PartsDeps } from '../health/parts.js';
import type { Part, PartId } from '../health/types.js';
import type { BackupInfo } from '../backup.js';
import { eventBus } from '../event-bus.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';

const GiB = 2 ** 30;
const MiB = 2 ** 20;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

function backup(host: string, kind: BackupInfo['kind'], hoursAgo: number): BackupInfo {
  const created_at = Math.floor((NOW - hoursAgo * HOUR) / 1000);
  return { name: `ritsu-${host}-${kind}-${created_at}.db.age`, host, kind, created_at, size: 1 };
}

describe('health parts', () => {
  let db: Db;
  let dataDir: string;
  let base: PartsDeps;

  const part = (id: PartId, over: Partial<PartsDeps> = {}): Part =>
    createParts({ ...base, ...over })().find(p => p.id === id)!;
  const verdict = (id: PartId, over: Partial<PartsDeps> = {}): [string, string] => {
    const p = part(id, over);
    return [p.status, p.note];
  };

  const addAgent = (id: string, runtime: 'direct' | 'api', enabled: boolean) =>
    db.prepare(`INSERT INTO agent_definitions (id, type, name, description, system_prompt, runtime, model, enabled)
                VALUES (?, 'generic', ?, 'd', 'p', ?, 'm', ?)`).run(id, id, runtime, enabled ? 1 : 0);
  const addJob = (id: string, enabled: boolean, state: { next?: number | null; failures?: number; reason?: string | null } = {}) => {
    db.prepare(`INSERT INTO scheduler_jobs (id, name, enabled, schedule, payload) VALUES (?, ?, ?, '{}', '{}')`)
      .run(id, id, enabled ? 1 : 0);
    db.prepare(`INSERT INTO scheduler_job_state (job_id, next_run_at, consecutive_failures, disabled_reason) VALUES (?, ?, ?, ?)`)
      .run(id, state.next ?? null, state.failures ?? 0, state.reason ?? null);
  };
  const addChannel = (name: string, config: string, enabled = true): number =>
    Number(db.prepare(`INSERT INTO channels (name, kind, operator_agent_id, config, enabled) VALUES (?, 'telegram', 'a', ?, ?)`)
      .run(name, config, enabled ? 1 : 0).lastInsertRowid);

  beforeEach(() => {
    db = openDatabase(':memory:');
    dataDir = mkdtempSync(join(tmpdir(), 'ritsu-parts-'));
    base = {
      db,
      dataDir,
      agentsLoaded: () => 0,
      secrets: { has: () => false },
      mcpListening: () => true,
      backups: {
        host: 'box',
        status: { running: false, last_error: null, last_ok: null },
        passwordSet: () => true,
        listBackups: () => [backup('box', 'daily', 3)],
      },
      backupIntervalHours: () => 24,
      schedulerRunning: () => true,
      plugins: { manifests: () => [] },
      pluginFailures: () => 0,
      runningChannels: () => [],
      now: () => NOW,
      freeBytes: () => 812 * GiB,
      masterKey: { present: () => true, usable: () => true },
    };
  });

  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('lists every part once, in order, with its label', () => {
    const parts = createParts(base)();
    assert.deepEqual(parts.map(p => [p.id, p.label]), [
      ['database', 'Database'], ['secrets', 'Secret storage'], ['subscription', 'Subscription token'],
      ['agents', 'Agents'], ['mcp', 'MCP server'], ['voice', 'Voice'], ['backups', 'Backups'],
      ['scheduler', 'Scheduler'], ['plugins', 'Plugins'], ['channels', 'Channels'],
    ]);
  });

  it('summary: any fail is fail, else any warn is warn, and off never counts', () => {
    const p = (status: Part['status']): Part => ({ id: 'mcp', label: 'MCP server', status, note: '' });
    assert.equal(summarize([p('ok'), p('off')], '1.0.0', 5).status, 'ok');
    assert.equal(summarize([p('ok'), p('warn'), p('off')], '1.0.0', 5).status, 'warn');
    assert.equal(summarize([p('warn'), p('fail')], '1.0.0', 5).status, 'fail');
    const s = summarize([p('ok')], '1.2.3', 42);
    assert.deepEqual({ ...s, parts: undefined }, { name: 'ritsu', status: 'ok', version: '1.2.3', uptime_s: 42, parts: undefined });
  });

  it('a check that throws is its own failure and is logged', () => {
    const parts = createParts({ ...base, agentsLoaded: () => { throw new Error('host exploded'); } })();
    const agents = parts.find(p => p.id === 'agents')!;
    assert.deepEqual([agents.status, agents.note], ['fail', 'check failed']);
    assert.equal(parts.find(p => p.id === 'mcp')!.status, 'ok');
    const logged = eventBus.recent(50).find(e => e.msg === 'health.part-failed' && e.part === 'agents');
    assert.ok(logged);
  });

  describe('database', () => {
    it('reports free space, warns when low, fails when nearly full', () => {
      assert.deepEqual(verdict('database'), ['ok', 'open, 812 GB free']);
      assert.deepEqual(verdict('database', { freeBytes: () => 5.27 * GiB }), ['ok', 'open, 5.2 GB free']);
      assert.deepEqual(verdict('database', { freeBytes: () => 1.5 * GiB }), ['warn', 'low disk, 1.5 GB free']);
      assert.deepEqual(verdict('database', { freeBytes: () => 100 * MiB }), ['fail', 'disk nearly full, 100 MB free']);
    });

    it('reads the real disk when nothing is injected', () => {
      const { freeBytes: _, ...real } = base;
      assert.match(createParts(real)().find(p => p.id === 'database')!.note, /^(open|low disk|disk nearly full), [\d.]+ (GB|MB) free$/);
    });

    it('still says open when free space cannot be read', () => {
      assert.deepEqual(verdict('database', { freeBytes: () => { throw new Error('ENOSYS'); } }), ['ok', 'open']);
    });

    it('fails on a data folder it cannot write or a database that does not answer', () => {
      assert.deepEqual(verdict('database', { dataDir: join(dataDir, 'missing') }), ['fail', 'data folder not writable']);
      const dead = { prepare: () => { throw new Error('database is not open'); } };
      assert.deepEqual(verdict('database', { db: dead }), ['fail', 'not answering']);
    });
  });

  describe('secrets', () => {
    it('is ok with a usable key and fails on one that will not load', () => {
      assert.deepEqual(verdict('secrets'), ['ok', 'key loaded']);
      assert.deepEqual(verdict('secrets', { masterKey: { present: () => true, usable: () => false } }), ['fail', 'key present but unusable']);
    });

    it('never touches the key without one present, and tells no key from a lost key', () => {
      let used = 0;
      const masterKey = { present: () => false, usable: () => { used++; return true; } };
      assert.deepEqual(verdict('secrets', { masterKey }), ['warn', "no key yet; secrets can't be saved"]);
      const stored = [
        () => db.prepare(`INSERT INTO plugin_secrets (namespace, name, value_enc) VALUES ('email', 'smtp_password', 'enc:v2:abc')`).run(),
        () => db.prepare(`INSERT INTO api_keys (name, provider, key_enc) VALUES ('k', 'openai', 'sk-p…|enc:v2:abc')`).run(),
        () => db.prepare(`INSERT INTO channels (name, kind, operator_agent_id, config) VALUES ('c', 'telegram', 'a', '{"bot_token":"enc:v2:abc"}')`).run(),
      ];
      for (const add of stored) {
        db.exec('DELETE FROM plugin_secrets; DELETE FROM api_keys; DELETE FROM channels;');
        add();
        assert.deepEqual(verdict('secrets', { masterKey }), ['fail', "key missing; stored secrets can't be read"]);
      }
      assert.equal(used, 0);
    });

    it('ignores revoked keys when looking for stored secrets', () => {
      db.prepare(`INSERT INTO api_keys (name, provider, key_enc, revoked_at) VALUES ('k', 'openai', 'sk-p…|enc:v2:abc', 1)`).run();
      assert.equal(part('secrets', { masterKey: { present: () => false, usable: () => true } }).status, 'warn');
    });

    it('uses the real key from the environment by default', () => {
      const saved = process.env.RITSU_MASTER_KEY;
      process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
      _resetKeyCacheForTests();
      try {
        const { masterKey: _, ...real } = base;
        assert.deepEqual(createParts(real)().find(p => p.id === 'secrets')!.note, 'key loaded');
      } finally {
        if (saved === undefined) delete process.env.RITSU_MASTER_KEY; else process.env.RITSU_MASTER_KEY = saved;
        _resetKeyCacheForTests();
      }
    });
  });

  describe('subscription', () => {
    let savedToken: string | undefined;
    beforeEach(() => { savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN; delete process.env.CLAUDE_CODE_OAUTH_TOKEN; });
    afterEach(() => {
      if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    });

    it('is off when no enabled agent runs direct', () => {
      addAgent('metered', 'api', true);
      addAgent('parked', 'direct', false);
      assert.deepEqual(verdict('subscription'), ['off', 'no agents need it']);
    });

    it('finds a stored token first, then the environment, else warns', () => {
      addAgent('main', 'direct', true);
      assert.deepEqual(verdict('subscription'), ['warn', 'missing']);
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token';
      assert.deepEqual(verdict('subscription'), ['ok', 'from the environment']);
      const secrets = { has: (ns: string, name: string) => ns === 'claude' && name === 'oauth_token' };
      assert.deepEqual(verdict('subscription', { secrets }), ['ok', 'stored']);
    });
  });

  describe('agents', () => {
    it('compares enabled rows with loaded agents', () => {
      assert.deepEqual(verdict('agents'), ['warn', 'none enabled']);
      addAgent('a', 'direct', true);
      addAgent('b', 'api', true);
      addAgent('c', 'direct', false);
      assert.deepEqual(verdict('agents', { agentsLoaded: () => 2 }), ['ok', '2 loaded']);
      addAgent('d', 'api', true);
      assert.deepEqual(verdict('agents', { agentsLoaded: () => 2 }), ['fail', '2 of 3 loaded']);
    });
  });

  describe('mcp', () => {
    it('follows the server listening', () => {
      assert.deepEqual(verdict('mcp'), ['ok', 'listening']);
      assert.deepEqual(verdict('mcp', { mcpListening: () => false }), ['fail', 'not listening']);
    });
  });

  describe('voice', () => {
    type St = ReturnType<NonNullable<PartsDeps['speech']>['status']>;
    const speech = (st: St): PartsDeps['speech'] => ({ status: () => st });

    it('is off without the service or when turned off', () => {
      assert.deepEqual(verdict('voice'), ['off', 'not available']);
      assert.deepEqual(verdict('voice', { speech: speech({ choice: 'off', engine: null, model: null }) }), ['off', 'turned off']);
    });

    it('names the engine in use, with a published model size only', () => {
      assert.deepEqual(verdict('voice', { speech: speech({ choice: 'auto', engine: 'builtin', model: 'small.en' }) }), ['ok', 'built-in Whisper (small.en)']);
      assert.deepEqual(verdict('voice', { speech: speech({ choice: 'builtin', engine: 'builtin', model: '../../srv/models/x' }) }), ['ok', 'built-in Whisper']);
      assert.deepEqual(verdict('voice', { speech: speech({ choice: 'local', engine: 'local', model: null }) }), ['ok', 'Whisper server']);
      assert.deepEqual(verdict('voice', { speech: speech({ choice: 'auto', engine: 'openai', model: null }) }), ['ok', 'OpenAI gpt-transcribe']);
    });

    it('warns when nothing is set up and fails when the chosen engine cannot run', () => {
      assert.deepEqual(verdict('voice', { speech: speech({ choice: 'auto', engine: null, model: null }) }), ['warn', 'not set up']);
      assert.deepEqual(verdict('voice', { speech: speech({ choice: 'local', engine: null, model: null }) }), ['fail', 'Whisper server chosen but not available']);
      assert.deepEqual(verdict('voice', { speech: speech({ choice: 'builtin', engine: null, model: null }) }), ['fail', 'built-in Whisper chosen but not available']);
    });
  });

  describe('backups', () => {
    const with_ = (over: Partial<PartsDeps['backups']>): Partial<PartsDeps> => ({ backups: { ...base.backups, ...over } });
    const idle = { running: false, last_error: null, last_ok: null };

    it('fails on an unreadable password file and warns with none', () => {
      assert.deepEqual(verdict('backups', with_({ passwordSet: () => { throw new Error('EACCES'); } })), ['fail', 'password file unreadable']);
      assert.deepEqual(verdict('backups', with_({ passwordSet: () => false })), ['warn', 'off: no backup password']);
    });

    it('reports a backup in progress, then a failed last attempt', () => {
      assert.deepEqual(verdict('backups', with_({ status: { ...idle, running: true, last_error: 'x' } })), ['ok', 'running now']);
      assert.deepEqual(verdict('backups', with_({ status: { ...idle, last_error: 'EIO: i/o error' } })), ['fail', 'last attempt failed']);
    });

    it('counts only this host’s daily backups', () => {
      const listBackups = () => [backup('other', 'daily', 1), backup('box', 'pre-upgrade', 1)];
      assert.deepEqual(verdict('backups', with_({ listBackups })), ['warn', 'no daily backup yet']);
    });

    it('grades the newest daily backup by age against the interval', () => {
      const at = (h: number, over: Partial<PartsDeps> = {}) =>
        verdict('backups', { ...with_({ listBackups: () => [backup('box', 'daily', h), backup('box', 'daily', h + 24)] }), ...over });
      assert.deepEqual(at(0.5), ['ok', 'newest under 1 h old']);
      assert.deepEqual(at(3), ['ok', 'newest 3 h old']);
      assert.deepEqual(at(25), ['ok', 'newest 25 h old']);
      assert.deepEqual(at(26), ['warn', 'newest 26 h old']);
      assert.deepEqual(at(49), ['fail', 'newest 49 h old']);
      assert.deepEqual(at(26, { backupIntervalHours: () => 12 }), ['fail', 'newest 26 h old']);
    });

    it('lists the folder at most once a minute, and sees a backup made since', () => {
      let now = NOW;
      let listed = 0;
      const status = { ...idle } as PartsDeps['backups']['status'];
      const check = createParts({
        ...base, now: () => now,
        backups: { ...base.backups, status, listBackups: () => { listed++; return [backup('box', 'daily', 30)]; } },
      });
      const note = () => check().find(p => p.id === 'backups')!.note;
      assert.equal(note(), 'newest 30 h old');
      now += 59_000;
      status.last_ok = backup('box', 'daily', 0);
      assert.equal(note(), 'newest under 1 h old');
      assert.equal(listed, 1);
      now += 2_000;
      note();
      assert.equal(listed, 2);
    });
  });

  describe('scheduler', () => {
    it('is off with no jobs to run', () => {
      assert.deepEqual(verdict('scheduler'), ['off', 'no jobs']);
      addJob('paused', false, { failures: 3 });
      addJob('once', true, { reason: 'exhausted' });
      assert.deepEqual(verdict('scheduler', { schedulerRunning: () => false }), ['off', 'no jobs']);
    });

    it('fails when the runner is stopped or a job was given up on', () => {
      addJob('a', true, { next: NOW + HOUR });
      assert.deepEqual(verdict('scheduler', { schedulerRunning: () => false }), ['fail', 'not running']);
      addJob('b', true, { reason: 'consecutive-failures', failures: 10 });
      addJob('c', true, { reason: 'uncomputable-schedule' });
      addJob('d', true, { reason: 'unreadable' });
      assert.deepEqual(verdict('scheduler'), ['fail', '3 stopped after failures']);
    });

    it('warns on failing and overdue jobs', () => {
      addJob('a', true, { next: NOW + HOUR, failures: 2 });
      addJob('b', true, { next: NOW + HOUR });
      assert.deepEqual(verdict('scheduler'), ['warn', '1 of 2 failing']);
      db.exec('UPDATE scheduler_job_state SET consecutive_failures = 0');
      db.prepare('UPDATE scheduler_job_state SET next_run_at = ? WHERE job_id = ?').run(NOW - 10 * 60_000, 'a');
      assert.deepEqual(verdict('scheduler'), ['ok', '2 jobs, none failing']);
      db.prepare('UPDATE scheduler_job_state SET next_run_at = ? WHERE job_id = ?').run(NOW - 21 * 60_000, 'a');
      assert.deepEqual(verdict('scheduler'), ['warn', '1 overdue']);
    });

    it('counts jobs with the right plural', () => {
      addJob('a', true, { next: NOW + HOUR });
      addJob('paused', false);
      assert.deepEqual(verdict('scheduler'), ['ok', '1 job, none failing']);
    });
  });

  describe('plugins', () => {
    it('reports none, failures, and loaded with those turned off', () => {
      assert.deepEqual(verdict('plugins'), ['off', 'none installed']);
      assert.deepEqual(verdict('plugins', { pluginFailures: () => 1 }), ['fail', '1 failed to load']);
      const three = [{ enabled: true }, { enabled: true }, { enabled: true }];
      assert.deepEqual(verdict('plugins', { plugins: { manifests: () => three } }), ['ok', '3 loaded']);
      const oneOff = [{ enabled: true }, { enabled: false }, { enabled: true }];
      assert.deepEqual(verdict('plugins', { plugins: { manifests: () => oneOff } }), ['ok', '3 loaded, 1 off']);
      assert.deepEqual(verdict('plugins', { plugins: { manifests: () => three }, pluginFailures: () => 2 }), ['fail', '2 failed to load']);
    });
  });

  describe('channels', () => {
    it('is off with no enabled channel', () => {
      assert.deepEqual(verdict('channels'), ['off', 'none set up']);
      addChannel('parked', '{"chat_id":1}', false);
      assert.deepEqual(verdict('channels'), ['off', 'none set up']);
    });

    it('fails on a channel not running, then warns on one with no chat', () => {
      const a = addChannel('a', '{"bot_token":"enc:v2:x","chat_id":101}');
      const b = addChannel('b', '{"bot_token":"enc:v2:y","chat_id":null}');
      assert.deepEqual(verdict('channels', { runningChannels: () => [a] }), ['fail', '1 of 2 not running']);
      assert.deepEqual(verdict('channels', { runningChannels: () => [a, b] }), ['warn', '1 not linked to a chat']);
      db.prepare(`UPDATE channels SET config = '{"chat_id":102}' WHERE id = ?`).run(b);
      assert.deepEqual(verdict('channels', { runningChannels: () => [a, b] }), ['ok', '2 running']);
    });

    it('treats an unparseable config as unlinked rather than failing the part', () => {
      const a = addChannel('a', 'not json');
      assert.deepEqual(verdict('channels', { runningChannels: () => [a] }), ['warn', '1 not linked to a chat']);
    });
  });
});
