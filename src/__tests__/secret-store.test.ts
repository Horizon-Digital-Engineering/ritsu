import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../db.js';
import { SecretStore } from '../auth/secret-store.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';

describe('SecretStore', () => {
  let store: SecretStore;

  beforeEach(() => {
    process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
    store = new SecretStore(openDatabase(':memory:'));
  });

  it('set → get round-trips the plaintext', () => {
    store.set('email', 'smtp_password', 'hunter2');
    assert.equal(store.get('email', 'smtp_password'), 'hunter2');
  });

  it('get returns null for an absent secret', () => {
    assert.equal(store.get('email', 'nope'), null);
  });

  it('set on an existing (namespace,name) updates in place', () => {
    store.set('email', 'smtp_password', 'old');
    store.set('email', 'smtp_password', 'new');
    assert.equal(store.get('email', 'smtp_password'), 'new');
    // Still one row, not two.
    assert.equal(store.list('email').length, 1);
  });

  it('namespace isolates same-named secrets', () => {
    store.set('email', 'token', 'email-tok');
    store.set('twitter', 'token', 'twitter-tok');
    assert.equal(store.get('email', 'token'), 'email-tok');
    assert.equal(store.get('twitter', 'token'), 'twitter-tok');
  });

  it('list returns metadata only — never the value', () => {
    store.set('email', 'smtp_password', 'secret-value');
    const meta = store.list('email');
    assert.equal(meta.length, 1);
    assert.equal(meta[0].namespace, 'email');
    assert.equal(meta[0].name, 'smtp_password');
    assert.equal(typeof meta[0].created_at, 'number');
    // The metadata object must not carry the plaintext anywhere.
    assert.equal(JSON.stringify(meta).includes('secret-value'), false);
  });

  it('has() checks presence without decrypting', () => {
    assert.equal(store.has('email', 'x'), false);
    store.set('email', 'x', 'v');
    assert.equal(store.has('email', 'x'), true);
  });

  it('delete removes the secret', () => {
    store.set('email', 'x', 'v');
    assert.equal(store.delete('email', 'x'), true);
    assert.equal(store.get('email', 'x'), null);
    assert.equal(store.delete('email', 'x'), false); // idempotent
  });

  it('ciphertext at rest is not the plaintext', () => {
    store.set('email', 'smtp_password', 'plaintext-here');
    // Reach into the raw row (private db, bracket access in tests) — the
    // stored value must be ciphertext, not the secret.
    const raw = store['db'].prepare('SELECT value_enc FROM plugin_secrets WHERE namespace=? AND name=?')
      .get('email', 'smtp_password') as { value_enc: string };
    assert.equal(raw.value_enc.includes('plaintext-here'), false);
    assert.ok(raw.value_enc.length > 0);
  });
});
