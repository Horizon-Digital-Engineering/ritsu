import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../db.js';
import { ApiKeyStore } from '../auth/api-key-store.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';

describe('ApiKeyStore', () => {
  let store: ApiKeyStore;

  beforeEach(() => {
    process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
    store = new ApiKeyStore(openDatabase(':memory:'));
  });

  it('mint stores ciphertext, returns plaintext exactly once', () => {
    const m = store.mint('anthropic-primary', 'anthropic', 'sk-ant-API03-very-long-token-string-here');
    assert.equal(m.plaintext, 'sk-ant-API03-very-long-token-string-here');
    assert.equal(m.provider, 'anthropic');
    assert.equal(m.prefix, 'sk-a');
    // Public list never includes plaintext, just the prefix.
    const listed = store.list();
    assert.equal((listed).length, 1);
    assert.equal((listed[0] as unknown as { plaintext?: string }).plaintext, undefined);
    assert.equal(listed[0].prefix, 'sk-a');
  });

  it('reveal returns plaintext for in-process use + bumps last_used_at + use_count', () => {
    const m = store.mint('openai-test', 'openai', 'sk-OPENAI-12345');
    const r1 = store.reveal(m.id);
    assert.equal(r1?.plaintext, 'sk-OPENAI-12345');
    assert.equal(r1?.provider, 'openai');
    assert.equal(r1?.name, 'openai-test');
    const r2 = store.reveal(m.id);
    assert.equal(r2?.plaintext, 'sk-OPENAI-12345');
    const row = store.read(m.id);
    assert.equal(row?.use_count, 2);
    assert.notEqual(row?.last_used_at, null);
  });

  it('reveal returns null for revoked keys (and never bumps counters)', () => {
    const m = store.mint('throwaway', 'openai', 'sk-throwaway');
    store.revoke(m.id);
    assert.equal(store.reveal(m.id), null);
    assert.equal(store.read(m.id)?.use_count, 0);
  });

  it('revoke is idempotent + reflected in list', () => {
    const m = store.mint('rotated', 'anthropic', 'sk-ant-rotated');
    assert.equal(store.revoke(m.id), true);
    assert.equal(store.revoke(m.id), false);  // second call: already revoked
    const row = store.read(m.id);
    assert.notEqual(row?.revoked_at, null);
  });

  it('delete requires prior revoke (matches TokenStore hygiene)', () => {
    const m = store.mint('to-delete', 'litellm', 'lt-1234');
    assert.equal(store.delete(m.id), false);   // active — must revoke first
    store.revoke(m.id);
    assert.equal(store.delete(m.id), true);
    assert.equal(store.read(m.id), null);
  });

  it('UNIQUE(name) prevents duplicates', () => {
    store.mint('only-one', 'openai', 'sk-A');
    assert.throws(() => store.mint('only-one', 'openai', 'sk-B'));
  });

  it('rejects unknown provider + empty name + empty plaintext', () => {
    assert.throws(() => store.mint('', 'anthropic', 'sk-X'), /name required/);
    assert.throws(() => store.mint('x', 'anthropic', ''), /plaintext required/);
    // @ts-expect-error — narrow the type to test runtime rejection
    assert.throws(() => store.mint('x', 'nonsense', 'sk-X'), /unknown provider/);
  });

  it('list returns rows newest-first', () => {
    store.mint('a', 'openai', 'sk-A');
    // Small synthetic delay isn't reliable; just rely on monotonic created_at via id ordering.
    store.mint('b', 'anthropic', 'sk-B');
    store.mint('c', 'litellm', 'lt-C');
    const names = store.list().map(r => r.name);
    assert.deepEqual(names, ['c', 'b', 'a']);
  });
});
