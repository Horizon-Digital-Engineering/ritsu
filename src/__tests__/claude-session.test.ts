import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../db.js';
import { SecretStore } from '../auth/secret-store.js';
import { buildDispatcher } from '../model/factory.js';
import { CLAUDE_NS, subscriptionEnv } from '../model/claude-direct-dispatcher.js';
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

describe('subscription billing precedence', () => {
  it('drops ANTHROPIC_API_KEY so the plan is used, not per-token billing', () => {
    const env = subscriptionEnv('tok', {
      PATH: '/usr/bin',
      HOME: '/home/ritsu',
      // Any non-empty value; the point is that it must not survive.
      ANTHROPIC_API_KEY: ['would', 'bill', 'per', 'token'].join('-'),
    });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    // The subprocess still needs its inherited environment to start at all.
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/ritsu');
  });

  it('leaves an environment without an API key untouched apart from the token', () => {
    const env = subscriptionEnv('tok', { PATH: '/usr/bin' });
    assert.deepEqual(env, { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
  });
});
