import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase } from '../db.js';
import { TokenStore } from '../auth/token-store.js';
import { bootstrapAdminToken } from '../bootstrap-admin-token.js';

/**
 * Two behaviours we're pinning, both load-bearing:
 *
 *   1. The bootstrap path uses O_EXCL — if the file already exists at
 *      0644 (attacker pre-create) we refuse to write, revoke the
 *      just-minted token, and exit 70.
 *   2. When the file does NOT pre-exist, the token lands at mode 0600
 *      and the contents match what we'd return on a subsequent verify.
 */
describe('bootstrapAdminToken', () => {
  let dir: string;
  let tokenFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ritsu-bootstrap-'));
    tokenFile = join(dir, '.admin-token');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('mints + writes the token at mode 0600 when the file does not exist', () => {
    const tokens = new TokenStore(openDatabase(':memory:'));
    const exitCalls: number[] = [];
    bootstrapAdminToken(tokens, { adminTokenFile: tokenFile }, {
      exit: (code) => { exitCalls.push(code); return undefined as never; },
    });
    assert.deepEqual(exitCalls, [], 'should not have exited');
    const contents = readFileSync(tokenFile, 'utf8').trim();
    assert.match(contents, /^rat_/, 'plaintext should be the admin token');
    const mode = statSync(tokenFile).mode & 0o777;
    assert.equal(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
    // And the verify path should succeed for the just-written token.
    assert.ok(tokens.verify(contents, 'admin'), 'token should verify');
  });

  it('refuses to write when the file already exists (attacker pre-create)', () => {
    // Operator-or-attacker plants a world-readable file at the target
    // path before ritsu first runs.
    writeFileSync(tokenFile, 'attacker_pre_created\n', { mode: 0o644 });
    const preMode = statSync(tokenFile).mode & 0o777;
    assert.equal(preMode, 0o644, 'sanity: setup created file at 0644');

    const tokens = new TokenStore(openDatabase(':memory:'));
    const exitCalls: number[] = [];
    bootstrapAdminToken(tokens, { adminTokenFile: tokenFile }, {
      exit: (code) => { exitCalls.push(code); return undefined as never; },
    });

    assert.deepEqual(exitCalls, [70], 'should exit 70 (EX_SOFTWARE)');
    // File contents must be UNCHANGED — we did NOT overwrite the
    // attacker's plant with the real token.
    assert.equal(readFileSync(tokenFile, 'utf8'), 'attacker_pre_created\n');
    // And the just-minted token must have been revoked so it can't be
    // used by anything that observed the write attempt.
    assert.equal(tokens.hasAnyActive('admin'), false);
  });

  it('is a no-op when an admin token already exists', () => {
    const tokens = new TokenStore(openDatabase(':memory:'));
    tokens.mint('pre-existing', 'admin');
    const exitCalls: number[] = [];
    bootstrapAdminToken(tokens, { adminTokenFile: tokenFile }, {
      exit: (code) => { exitCalls.push(code); return undefined as never; },
    });
    assert.deepEqual(exitCalls, [], 'should not have exited');
    assert.equal(existsSync(tokenFile), false, 'should not have created the file');
  });

  it('refuses when the parent directory does not exist (ENOENT)', () => {
    const missingPath = join(dir, 'does-not-exist', '.admin-token');
    const tokens = new TokenStore(openDatabase(':memory:'));
    const exitCalls: number[] = [];
    bootstrapAdminToken(tokens, { adminTokenFile: missingPath }, {
      exit: (code) => { exitCalls.push(code); return undefined as never; },
    });
    assert.deepEqual(exitCalls, [70]);
    assert.equal(tokens.hasAnyActive('admin'), false);
  });
});
