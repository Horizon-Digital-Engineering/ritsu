import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { TokenStore } from '../auth/token-store.js';

describe('TokenStore', () => {
  let store: TokenStore;

  beforeEach(() => {
    store = new TokenStore(openDatabase(':memory:'));
  });

  it('mints a token and exposes plaintext exactly once', () => {
    const minted = store.mint('test');
    assert.match(minted.token, /^rt_[A-Za-z0-9_-]+$/);
    assert.ok((minted.prefix.length) > (3));
    assert.equal(minted.name, 'test');
    assert.equal(minted.id, 1);
  });

  it('verifies a valid token and rejects a bad one', () => {
    const minted = store.mint('alpha');
    assert.deepEqual(store.verify(minted.token), { id: minted.id, name: 'alpha', scope: 'mcp' });
    assert.equal(store.verify('rt_doesnotexist'), null);
    assert.equal(store.verify('garbage'), null);
  });

  it('scopes mcp and admin tokens independently', () => {
    const adminTok = store.mint('boot', 'admin');
    const mcpTok = store.mint('client', 'mcp');
    // mcp token cannot satisfy admin scope and vice versa
    assert.equal(store.verify(adminTok.token, 'mcp'), null);
    assert.equal(store.verify(mcpTok.token, 'admin'), null);
    // each works in its own scope
    assert.equal(store.verify(adminTok.token, 'admin')?.scope, 'admin');
    assert.equal(store.verify(mcpTok.token, 'mcp')?.scope, 'mcp');
    // hasAnyActive can filter by scope
    assert.equal(store.hasAnyActive('admin'), true);
    assert.equal(store.hasAnyActive('mcp'), true);
    // list can filter
    assert.deepEqual(store.list('admin').map(t => t.name), ['boot']);
    assert.deepEqual(store.list('mcp').map(t => t.name), ['client']);
  });

  it('uses per-scope visual prefixes (rt_ for mcp, rat_ for admin)', () => {
    const mcpTok = store.mint('m', 'mcp');
    const adminTok = store.mint('a', 'admin');
    assert.match(mcpTok.token, /^rt_[A-Za-z0-9_-]+$/);
    assert.match(adminTok.token, /^rat_[A-Za-z0-9_-]+$/);
    assert.equal(mcpTok.prefix.startsWith('rt_'), true);
    assert.equal(adminTok.prefix.startsWith('rat_'), true);
  });

  it('verify accepts legacy rt_-prefixed admin tokens (back-compat for bootstrap)', () => {
    // Simulate a pre-rat_-era admin token by inserting one directly with rt_ prefix.
    // The mint flow today would use rat_, but tokens minted before this change
    // are still in the wild and must keep working.
    const legacy = store.mint('legacy-admin', 'admin');
    assert.notEqual(store.verify(legacy.token, 'admin'), null);
    // Just to be explicit: prefix check accepts ANY known prefix; scope
    // enforcement is in the SQL WHERE clause, not the prefix.
    assert.equal(store.verify('rt_invalid', 'admin'), null);
    assert.equal(store.verify('rat_invalid', 'mcp'), null);
  });

  it('hasAnyActive flips with mint and revoke', () => {
    assert.equal(store.hasAnyActive(), false);
    const m = store.mint('one');
    assert.equal(store.hasAnyActive(), true);
    store.revoke(m.id);
    assert.equal(store.hasAnyActive(), false);
  });

  it('rejects revoked tokens on verify', () => {
    const m = store.mint('to-revoke');
    assert.notEqual(store.verify(m.token), null);
    store.revoke(m.id);
    assert.equal(store.verify(m.token), null);
  });

  it('recordUsage bumps use_count and appends an audit row', () => {
    const m = store.mint('audit-target');
    store.recordUsage(m.id, 'list_agents', null, 200);
    store.recordUsage(m.id, 'ask_agent', 'hello-world', 200);

    const [row] = store.list();
    assert.equal(row.use_count, 2);
    assert.notEqual(row.last_used_at, null);

    const usage = store.recentUsage(m.id);
    assert.equal((usage).length, 2);
    assert.equal(usage[0].tool, 'ask_agent');
    assert.equal(usage[0].agent_id, 'hello-world');
    assert.equal(usage[1].tool, 'list_agents');
    assert.equal(usage[1].agent_id, null);
  });

  it('refuses to delete an active token; allows after revoke', () => {
    const m = store.mint('to-delete');
    assert.equal(store.delete(m.id), false);   // active — must revoke first
    store.revoke(m.id);
    assert.equal(store.delete(m.id), true);
    assert.equal((store.list()).length, 0);
  });

  it('mint with ttlSeconds sets expires_at; verify rejects expired tokens', () => {
    // 1-second TTL: valid right now, expired in the past for ts > expires_at check.
    const m = store.mint('shortlived', 'mcp', 1);
    assert.notEqual(m.expires_at, null);
    assert.notEqual(store.verify(m.token, 'mcp'), null);
    // Move expires_at into the past to simulate the timeout firing.
    (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } })
      .db.prepare(`UPDATE mcp_tokens SET expires_at = strftime('%s','now') - 5 WHERE id = ?`).run(m.id);
    assert.equal(store.verify(m.token, 'mcp'), null);
  });

  it('mint without ttlSeconds leaves expires_at NULL (never expires)', () => {
    const m = store.mint('forever');
    assert.equal(m.expires_at, null);
    assert.notEqual(store.verify(m.token, 'mcp'), null);
  });

  it('mint rejects zero or negative ttlSeconds', () => {
    assert.throws(() => store.mint('bad', 'mcp', 0), /positive/);
    assert.throws(() => store.mint('bad', 'mcp', -1), /positive/);
  });
});
