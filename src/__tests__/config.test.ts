import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadConfig, assertAdminTokenFileWritable, ConfigError } from '../config.js';

/**
 * Config is the single source of truth for paths/ports shared between
 * server and CLI. These tests pin the failure shape: misconfig is loud,
 * defaults are sane, and the bootstrap-path precondition refuses the
 * obviously-unsafe placements.
 */
describe('config.loadConfig', () => {
  /** Keys our tests touch — clean up to avoid leaks between tests. */
  const ownedKeys = [
    'PORT', 'MCP_HOST', 'ADMIN_PORT', 'ADMIN_HOST', 'DB_PATH',
    'MCP_REQUIRE_AUTH', 'RITSU_ALLOWED_HOSTS', 'RITSU_PUBLIC_URL',
    'RITSU_ADMIN_TOKEN_FILE',
  ];
  /** Snapshot baseline so each test starts clean. */
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

  it('returns defaults when no env is set', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.mcpPort, 7333);
    assert.equal(cfg.adminPort, 7334);
    assert.equal(cfg.mcpHost, '127.0.0.1');
    assert.equal(cfg.adminHost, '127.0.0.1');
    assert.equal(cfg.authMode, 'auto');
    assert.deepEqual(cfg.allowedHosts, []);
    assert.equal(cfg.publicUrl, undefined);
    assert.ok(cfg.adminTokenFile.endsWith('/opt/ritsu/data/.admin-token'));
  });

  it('throws when PORT === ADMIN_PORT', () => {
    assert.throws(
      () => loadConfig({ PORT: '7000', ADMIN_PORT: '7000' }),
      (err: Error) => err instanceof ConfigError && /must differ/.test(err.message),
    );
  });

  it('throws on a non-numeric port', () => {
    assert.throws(
      () => loadConfig({ PORT: 'not-a-port' }),
      (err: Error) => err instanceof ConfigError && /PORT=not-a-port/.test(err.message),
    );
  });

  it('throws on an out-of-range port', () => {
    assert.throws(
      () => loadConfig({ ADMIN_PORT: '99999' }),
      (err: Error) => err instanceof ConfigError && /ADMIN_PORT=99999/.test(err.message),
    );
  });

  it('throws on an unrecognised MCP_REQUIRE_AUTH value', () => {
    assert.throws(
      () => loadConfig({ MCP_REQUIRE_AUTH: 'yes-please' }),
      (err: Error) => err instanceof ConfigError && /MCP_REQUIRE_AUTH=yes-please/.test(err.message),
    );
  });

  it('collects multiple issues into a single ConfigError', () => {
    try {
      loadConfig({ PORT: 'bad', MCP_REQUIRE_AUTH: 'maybe' });
      assert.fail('expected ConfigError');
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.issues.length, 2);
    }
  });

  it('strips trailing slash from publicUrl', () => {
    const cfg = loadConfig({ RITSU_PUBLIC_URL: 'https://ritsu.example/' });
    assert.equal(cfg.publicUrl, 'https://ritsu.example');
  });

  it('splits RITSU_ALLOWED_HOSTS on comma and trims', () => {
    const cfg = loadConfig({ RITSU_ALLOWED_HOSTS: 'one.example, two.example ,three.example' });
    assert.deepEqual([...cfg.allowedHosts], ['one.example', 'two.example', 'three.example']);
  });
});

describe('config.assertAdminTokenFileWritable', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ritsu-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a writable, non-world-writable parent directory', () => {
    const cfg = loadConfig({ RITSU_ADMIN_TOKEN_FILE: join(dir, '.admin-token') });
    assert.doesNotThrow(() => assertAdminTokenFileWritable(cfg));
  });

  it('rejects a missing parent directory', () => {
    const cfg = loadConfig({ RITSU_ADMIN_TOKEN_FILE: join(dir, 'no-such-subdir', '.admin-token') });
    assert.throws(
      () => assertAdminTokenFileWritable(cfg),
      (err: Error) => err instanceof ConfigError && /does not exist/.test(err.message),
    );
  });

  it('rejects a world-writable parent directory', () => {
    chmodSync(dir, 0o777);
    const cfg = loadConfig({ RITSU_ADMIN_TOKEN_FILE: join(dir, '.admin-token') });
    assert.throws(
      () => assertAdminTokenFileWritable(cfg),
      (err: Error) => err instanceof ConfigError && /world-writable/.test(err.message),
    );
  });
});
