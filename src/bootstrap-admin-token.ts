/**
 * Bootstrap-admin-token write path, extracted from src/index.ts so it
 * can be unit-tested without spinning up the whole server.
 *
 * Behavior contract:
 *   - If any active admin-scoped token already exists in the DB, this
 *     is a no-op (the operator has a way to retrieve it).
 *   - Otherwise, mint a new admin token and persist the plaintext to
 *     the configured file with mode 0600, ATOMICALLY (O_EXCL).
 *   - If the file write fails (path not writable, EEXIST pre-create,
 *     anything), revoke the just-minted token and exit 70 (EX_SOFTWARE).
 *
 * Why O_EXCL: `writeFileSync(...,{ mode: 0o600 })` silently ignores the
 * mode flag when the target already exists. An attacker who pre-creates
 * the path at 0644 would otherwise get the bootstrap token at
 * world-readable mode. With O_EXCL the open fails up-front; we refuse to
 * overwrite and the operator removes the file manually after deciding
 * it isn't a legitimate stale one.
 */
import { closeSync, openSync, writeSync, constants as fsConstants } from 'node:fs';

import type { TokenStore } from './auth/token-store.js';
import { logger } from './util/log.js';

export interface BootstrapAdminTokenConfig {
  adminTokenFile: string;
}

export interface BootstrapAdminTokenDeps {
  /** Override `process.exit` for tests. Default: process.exit. */
  exit?: (code: number) => never;
}

export function bootstrapAdminToken(
  tokens: TokenStore,
  cfg: BootstrapAdminTokenConfig,
  deps: BootstrapAdminTokenDeps = {},
): void {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));

  if (tokens.hasAnyActive('admin')) {
    logger.debug('admin.token.exists');
    return;
  }
  const minted = tokens.mint('bootstrap', 'admin');
  let fd: number | null = null;
  try {
    fd = openSync(
      cfg.adminTokenFile,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    writeSync(fd, minted.token + '\n');
    logger.warn('admin.token.bootstrapped', { path: cfg.adminTokenFile, prefix: minted.prefix });
  } catch (err) {
    tokens.revoke(minted.id);
    const e = err as NodeJS.ErrnoException;
    const hint = e.code === 'EEXIST'
      ? 'file already exists; verify it is not an attacker pre-create, then remove it and restart'
      : 'token revoked; refusing to start with an unreachable bootstrap token';
    logger.error('admin.token.write-failed', {
      path: cfg.adminTokenFile,
      err: e.message,
      code: e.code,
      action: hint,
    });
    exit(70); // EX_SOFTWARE — operator must fix RITSU_ADMIN_TOKEN_FILE
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
