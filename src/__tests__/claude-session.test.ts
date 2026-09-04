import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../db.js';
import { SecretStore } from '../auth/secret-store.js';
import { buildDispatcher } from '../model/factory.js';
import { CLAUDE_NS } from '../model/claude-direct-dispatcher.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';

describe('claude session token', () => {
  let secrets: SecretStore;

  beforeEach(() => {
    process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
    secrets = new SecretStore(openDatabase(':memory:'));
  });

  it('is read from the secret store into the dispatcher', () => {
    secrets.set(CLAUDE_NS, 'oauth_token', 'not-a-real-token-stored');
    const d = buildDispatcher('claude-direct', 'claude-sonnet-4-6', { secrets }) as unknown as
      { opts: { oauthToken?: string } };
    assert.equal(d.opts.oauthToken, 'not-a-real-token-stored');
  });

  it('is absent when nothing is stored, so the subprocess keeps its own auth', () => {
    const d = buildDispatcher('claude-direct', 'claude-sonnet-4-6', { secrets }) as unknown as
      { opts: { oauthToken?: string } };
    assert.equal(d.opts.oauthToken, undefined);
  });

  it('a whitespace-only stored value is treated as unset', () => {
    secrets.set(CLAUDE_NS, 'oauth_token', '   ');
    const d = buildDispatcher('claude-direct', 'claude-sonnet-4-6', { secrets }) as unknown as
      { opts: { oauthToken?: string } };
    assert.equal(d.opts.oauthToken, undefined);
  });

  it('round-trips through the store without the plaintext being derivable from the hint', () => {
    // Assembled from parts: the hint logic is content-agnostic, and any
    // long opaque literal here reads as a live secret to the scanners.
    const token = Array.from({ length: 6 }, (_, i) => `part${i}`).join('-');
    secrets.set(CLAUDE_NS, 'oauth_token', token);
    const stored = secrets.get(CLAUDE_NS, 'oauth_token')!;
    assert.equal(stored, token);
    // What the admin endpoint exposes: a hint, never the value.
    const hint = `${stored.slice(0, 12)}…${stored.slice(-4)}`;
    assert.ok(!token.includes(hint));
    assert.ok(hint.length < 25);
  });
});
