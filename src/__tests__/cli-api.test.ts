import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveAdminToken, resolveBaseUrl } from '../cli/api.js';

describe('resolveAdminToken', () => {
  let dir: string;
  const ownedKeys = ['RITSU_ADMIN_TOKEN', 'RITSU_ADMIN_TOKEN_FILE'];
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ritsu-cli-api-'));
    snapshot = Object.fromEntries(ownedKeys.map(k => [k, process.env[k]]));
    for (const k of ownedKeys) delete process.env[k];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns the --token flag value verbatim when given', () => {
    assert.equal(resolveAdminToken('rat_explicit_value'), 'rat_explicit_value');
  });

  it('trims whitespace from --token', () => {
    assert.equal(resolveAdminToken('   rat_padded   '), 'rat_padded');
  });

  it('falls through to RITSU_ADMIN_TOKEN env when flag is missing', () => {
    process.env.RITSU_ADMIN_TOKEN = 'rat_from_env';
    assert.equal(resolveAdminToken(undefined), 'rat_from_env');
  });

  it('reads the configured token file when neither flag nor env set', () => {
    const tokenFile = join(dir, '.admin-token');
    writeFileSync(tokenFile, 'rat_on_disk\n');
    process.env.RITSU_ADMIN_TOKEN_FILE = tokenFile;
    assert.equal(resolveAdminToken(undefined), 'rat_on_disk');
  });

  it('throws when no source can supply a token', () => {
    process.env.RITSU_ADMIN_TOKEN_FILE = join(dir, 'does-not-exist');
    assert.throws(
      () => resolveAdminToken(undefined),
      /no admin token found/,
    );
  });
});

describe('resolveBaseUrl', () => {
  const ownedKeys = ['RITSU_URL', 'ADMIN_HOST', 'ADMIN_PORT'];
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = Object.fromEntries(ownedKeys.map(k => [k, process.env[k]]));
    for (const k of ownedKeys) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns the --url flag value when given (trailing slash stripped)', () => {
    assert.equal(resolveBaseUrl('https://ritsu.example/'), 'https://ritsu.example');
  });

  it('falls through to RITSU_URL env when flag is missing', () => {
    process.env.RITSU_URL = 'https://from-env.example/';
    assert.equal(resolveBaseUrl(undefined), 'https://from-env.example');
  });

  it('falls back to ADMIN_HOST:ADMIN_PORT loaded from config', () => {
    process.env.ADMIN_HOST = '10.0.0.5';
    process.env.ADMIN_PORT = '9000';
    assert.equal(resolveBaseUrl(undefined), 'http://10.0.0.5:9000');
  });

  it('rewrites 0.0.0.0 bind to loopback (cannot connect to bind-everywhere)', () => {
    process.env.ADMIN_HOST = '0.0.0.0';
    process.env.ADMIN_PORT = '7334';
    assert.equal(resolveBaseUrl(undefined), 'http://127.0.0.1:7334');
  });
});
