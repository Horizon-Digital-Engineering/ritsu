import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { SqliteMemoryBackend } from '../memory/sqlite-backend.js';
import { FakeMemoryBackend } from '../memory/fake-backend.js';
import { MemoryService } from '../memory/service.js';
import { loadMemoryConfig } from '../memory/config.js';
import type { SecretStore } from '../auth/secret-store.js';
import type { MemoryBackend, Scope, RawRecordInput, AssembledContext, RawRecord, QueryFilter } from '../memory/backend.js';

const scope: Scope = { user_id: 'operator', project_id: 'alice', session_id: '1' };

/** A backend that fails on demand, to prove fire-and-forget + fallback. */
class FlakyBackend implements MemoryBackend {
  recordCalls = 0;
  getContextCalls = 0;
  fail = false;
  /** ms to stall before resolving/rejecting (to exercise the timeout). */
  delayMs = 0;
  constructor(private readonly inner = new FakeMemoryBackend()) {}
  private async gate(): Promise<void> {
    if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
    if (this.fail) throw new Error('flashback down');
  }
  async record(rec: RawRecordInput): Promise<{ id: string }> {
    this.recordCalls++; await this.gate(); return this.inner.record(rec);
  }
  async getContext(s: Scope, q: string, o?: { budget?: number; limit?: number }): Promise<AssembledContext> {
    this.getContextCalls++; await this.gate(); return this.inner.getContext(s, q, o);
  }
  async query(s: Scope, f?: QueryFilter): Promise<RawRecord[]> { await this.gate(); return this.inner.query(s, f); }
  async read(id: string): Promise<RawRecord | null> { await this.gate(); return this.inner.read(id); }
  async lineage(id: string): Promise<RawRecord[]> { await this.gate(); return this.inner.lineage(id); }
}

const rec = (content: string): RawRecordInput => ({ type: 'episodic', content, source: 's', scope });

/** A read-only stub of the SecretStore over a plain key/value map, keyed
 *  `namespace:name` — enough for loadMemoryConfig, which only reads. */
const fakeSecrets = (kv: Record<string, string>): Pick<SecretStore, 'get'> => ({
  get: (ns: string, name: string): string | null => kv[`${ns}:${name}`] ?? null,
});

describe('loadMemoryConfig', () => {
  it('defaults to sqlite when unconfigured (regression guard: unchanged behavior)', () => {
    const cfg = loadMemoryConfig(fakeSecrets({}));
    assert.equal(cfg.mode, 'sqlite');
    assert.equal(cfg.flashback, undefined);
  });

  it('reads dual + credentials from the secret store', () => {
    const cfg = loadMemoryConfig(fakeSecrets({
      'flashback:mode': 'dual', 'flashback:url': 'https://fb.example/', 'flashback:token': 't',
    }));
    assert.equal(cfg.mode, 'dual');
    assert.equal(cfg.flashback?.endpoint, 'https://fb.example'); // trailing slash stripped
    assert.equal(cfg.flashback?.token, 't');
  });

  it('defaults to dual once credentials are set with no explicit mode', () => {
    const cfg = loadMemoryConfig(fakeSecrets({ 'flashback:url': 'https://fb.example', 'flashback:token': 't' }));
    assert.equal(cfg.mode, 'dual');
    assert.equal(cfg.flashback?.token, 't');
  });

  it('degrades a remote mode without credentials to sqlite (not a crash)', () => {
    const cfg = loadMemoryConfig(fakeSecrets({ 'flashback:mode': 'flashback' }));
    assert.equal(cfg.mode, 'sqlite');
    assert.equal(cfg.flashback, undefined);
  });

  it('ignores an unknown stored mode and stays on sqlite', () => {
    const cfg = loadMemoryConfig(fakeSecrets({
      'flashback:mode': 'redis', 'flashback:url': 'https://x', 'flashback:token': 't',
    }));
    assert.equal(cfg.mode, 'sqlite');
  });
});

describe('MemoryService', () => {
  let sqlite: SqliteMemoryBackend;
  beforeEach(() => { sqlite = new SqliteMemoryBackend(openDatabase(':memory:')); });

  it('sqlite mode: reads + writes only sqlite (today\'s behavior)', async () => {
    const svc = new MemoryService({ mode: 'sqlite', sqlite });
    const { id } = await svc.record(rec('hello'));
    assert.ok(id);
    const ctx = await svc.getContext(scope, 'hello');
    assert.equal(ctx.records.length, 1);
  });

  it('dual mode: writes BOTH backends; sqlite authoritative for reads', async () => {
    const flashback = new FakeMemoryBackend();
    const svc = new MemoryService({ mode: 'dual', sqlite, flashback });
    await svc.record(rec('lisinopril note'));
    // sqlite (authoritative) has it synchronously after the awaited write.
    assert.equal((await sqlite.query(scope)).length, 1);
    // flashback got a fire-and-forget write too — settle the microtask/timer.
    await new Promise(r => setTimeout(r, 10));
    assert.equal((await flashback.query(scope)).length, 1);
    // reads come from sqlite in dual mode.
    const ctx = await svc.getContext(scope, 'lisinopril');
    assert.match(ctx.records[0].content, /lisinopril/);
  });

  it('dual mode: a flashback WRITE failure still succeeds the sqlite write + returns (fire-and-forget)', async () => {
    const flaky = new FlakyBackend();
    flaky.fail = true;
    const svc = new MemoryService({ mode: 'dual', sqlite, flashback: flaky });
    // Must NOT throw even though flashback.record rejects.
    const { id } = await svc.record(rec('durable'));
    assert.ok(id, 'sqlite write returned an id despite flashback failure');
    assert.equal((await sqlite.query(scope)).length, 1, 'sqlite write landed');
    assert.equal(flaky.recordCalls, 1, 'flashback write was attempted');
    // let the rejected fire-and-forget settle so it can\'t leak into another test
    await new Promise(r => setTimeout(r, 10));
  });

  it('dual mode: a SLOW flashback write is abandoned by the timeout, turn unaffected', async () => {
    const flaky = new FlakyBackend();
    flaky.delayMs = 200;
    const svc = new MemoryService({ mode: 'dual', sqlite, flashback: flaky, fireAndForgetTimeoutMs: 20 });
    const start = Date.now();
    const { id } = await svc.record(rec('quick'));
    assert.ok(id);
    // The record() call returned well before the 200ms flashback stall.
    assert.ok(Date.now() - start < 150, 'record() did not wait on the slow flashback write');
    await new Promise(r => setTimeout(r, 250)); // let the abandoned write settle
  });

  it('flashback mode: flashback authoritative for reads, sqlite shadow-written', async () => {
    const flashback = new FakeMemoryBackend();
    const svc = new MemoryService({ mode: 'flashback', sqlite, flashback });
    await svc.record(rec('remote fact'));
    // Both stores got the write (flashback authoritative + sqlite shadow).
    assert.equal((await flashback.query(scope)).length, 1);
    assert.equal((await sqlite.query(scope)).length, 1);
    // getContext reads flashback.
    const ctx = await svc.getContext(scope, 'remote');
    assert.equal(ctx.records.length, 1);
  });

  it('flashback mode: a getContext failure falls back to the sqlite backstop', async () => {
    const flaky = new FlakyBackend();
    const svc = new MemoryService({ mode: 'flashback', sqlite, flashback: flaky });
    // Seed via the service so both stores have it, THEN break flashback.
    await svc.record(rec('backstop me'));
    flaky.fail = true;
    const ctx = await svc.getContext(scope, 'backstop');
    // Fell back to sqlite; still got the record instead of throwing.
    assert.equal(ctx.records.length, 1);
    assert.match(ctx.records[0].content, /backstop/);
  });

  it('remote mode with NO flashback wired degrades to sqlite-only (no throw)', async () => {
    const svc = new MemoryService({ mode: 'dual', sqlite }); // flashback omitted
    const { id } = await svc.record(rec('local only'));
    assert.ok(id);
    assert.equal((await svc.getContext(scope, 'local')).records.length, 1);
  });
});
