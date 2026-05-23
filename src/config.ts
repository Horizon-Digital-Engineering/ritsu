/**
 * Single source of truth for ritsu runtime configuration. Both the server
 * (src/index.ts) and the operator CLI (src/cli.ts + commands) load through
 * here so they can never disagree on a path.
 *
 * Design tenets, in order:
 *
 *  1. Explicit over magical. Every knob is an env var. No "auto-detect dev
 *     vs prod"; if you want a non-default path, set it. Defaults exist for
 *     ergonomic dev, not as silent fallbacks.
 *  2. Fail-loud on misconfig. Validation runs at load. Throws `ConfigError`
 *     with EVERY problem collected — not just the first one — so the
 *     operator fixes the env in one pass instead of bisecting.
 *  3. Server vs CLI share validation but not invocation. `loadConfig()` is
 *     pure parsing; `assertAdminTokenFileWritable()` is the additional
 *     server-only precondition. The CLI is allowed to read a path that
 *     isn't writable to it (e.g. when running unprivileged against a file
 *     owned by the ritsu service user).
 *
 * Env precedence (highest first):
 *   1. process.env (systemd EnvironmentFile, exported shell vars)
 *   2. /etc/ritsu/env (the installer-written env file, when running CLI
 *      outside the service unit on a prod host)
 *   3. ./.env (project-local for dev)
 *
 * dotenv-lite never overwrites already-set vars, so each layer only fills
 * gaps left by the layer above.
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { loadDotenv } from './util/dotenv-lite.js';
import { stripTrailingSlashes } from './util/path-utils.js';

export type AuthMode = 'auto' | 'on' | 'off';

export interface RitsuConfig {
  readonly mcpPort: number;
  readonly mcpHost: string;
  readonly adminPort: number;
  readonly adminHost: string;
  readonly dbPath: string;
  readonly authMode: AuthMode;
  readonly allowedHosts: readonly string[];
  readonly publicUrl: string | undefined;
  /**
   * Absolute path to the file that holds the bootstrap admin token. Read by
   * the CLI; written by the server on first boot. Server-side writability
   * is checked separately by `assertAdminTokenFileWritable()`.
   */
  readonly adminTokenFile: string;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super('ritsu config invalid:\n' + issues.map(i => '  - ' + i).join('\n'));
    this.name = 'ConfigError';
  }
}

const DEFAULT_ADMIN_TOKEN_FILE = '/opt/ritsu/data/.admin-token';
const DEFAULT_DB_PATH          = './data/ritsu.db';
const DEFAULT_MCP_PORT         = 7333;
const DEFAULT_ADMIN_PORT       = 7334;
const DEFAULT_HOST             = '127.0.0.1';

let envHydrated = false;

/**
 * Populate `process.env` from the layered env files described in this
 * file's header. Idempotent; safe to call from multiple entry points.
 */
export function hydrateEnv(): void {
  if (envHydrated) return;
  envHydrated = true;
  // /etc/ritsu/env is the installer-written file. Loading it here means a
  // CLI invocation `ritsu admin-token show` sees the same config the
  // service does, without the operator having to source it manually.
  if (existsSync('/etc/ritsu/env')) loadDotenv('/etc/ritsu/env');
  // Project-local .env for dev. dotenv-lite does not overwrite existing
  // keys, so this can't shadow systemd or /etc/ritsu/env values.
  loadDotenv();
}

function parsePort(raw: string | undefined, name: string, fallback: number, issues: string[]): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    issues.push(`${name}=${raw}: not a valid TCP port (1-65535)`);
    return fallback;
  }
  return n;
}

function parseHost(raw: string | undefined, name: string, fallback: string, issues: string[]): string {
  const v = raw?.trim();
  if (!v) return fallback;
  // Cheap sanity — reject embedded whitespace or commas. Real IP/hostname
  // validation is done by the OS at bind time.
  if (/[\s,]/.test(v)) {
    issues.push(`${name}=${raw}: contains whitespace or comma`);
    return fallback;
  }
  return v;
}

function parseAuthModeStrict(raw: string | undefined, issues: string[]): AuthMode {
  if (raw === undefined || raw === '') return 'auto';
  const v = raw.trim().toLowerCase();
  if (v === 'auto' || v === 'on' || v === 'off') return v;
  issues.push(`MCP_REQUIRE_AUTH=${raw}: expected one of auto|on|off`);
  return 'auto';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RitsuConfig {
  hydrateEnv();

  const issues: string[] = [];

  const cfg: RitsuConfig = {
    mcpPort:        parsePort(env.PORT,           'PORT',         DEFAULT_MCP_PORT,   issues),
    mcpHost:        parseHost(env.MCP_HOST,       'MCP_HOST',     DEFAULT_HOST,       issues),
    adminPort:      parsePort(env.ADMIN_PORT,     'ADMIN_PORT',   DEFAULT_ADMIN_PORT, issues),
    adminHost:      parseHost(env.ADMIN_HOST,     'ADMIN_HOST',   DEFAULT_HOST,       issues),
    dbPath:         resolve(env.DB_PATH?.trim() || DEFAULT_DB_PATH),
    authMode:       parseAuthModeStrict(env.MCP_REQUIRE_AUTH, issues),
    allowedHosts:   (env.RITSU_ALLOWED_HOSTS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    publicUrl:      env.RITSU_PUBLIC_URL?.trim()
      ? stripTrailingSlashes(env.RITSU_PUBLIC_URL.trim())
      : undefined,
    adminTokenFile: resolve(env.RITSU_ADMIN_TOKEN_FILE?.trim() || DEFAULT_ADMIN_TOKEN_FILE),
  };

  if (cfg.mcpPort === cfg.adminPort) {
    issues.push(`PORT and ADMIN_PORT both = ${cfg.mcpPort}; they must differ`);
  }

  if (issues.length > 0) throw new ConfigError(issues);
  return cfg;
}

/**
 * Server-only precondition: refuse to start if the admin-token file's
 * parent directory isn't a sane place to drop a 0600 secret. Runs BEFORE
 * the token is minted so we never leave a token in the DB that nobody
 * can recover.
 */
export function assertAdminTokenFileWritable(cfg: RitsuConfig): void {
  const dir = dirname(cfg.adminTokenFile);
  const issues: string[] = [];

  if (!existsSync(dir)) {
    issues.push(
      `RITSU_ADMIN_TOKEN_FILE=${cfg.adminTokenFile}: parent directory '${dir}' does not exist. ` +
      `Create it (mkdir -p ${dir}) or point RITSU_ADMIN_TOKEN_FILE at a path whose parent does.`,
    );
    throw new ConfigError(issues);
  }

  try {
    accessSync(dir, constants.W_OK);
  } catch {
    issues.push(
      `RITSU_ADMIN_TOKEN_FILE=${cfg.adminTokenFile}: parent directory '${dir}' is not writable by this user. ` +
      `chown it to the ritsu service user, or set RITSU_ADMIN_TOKEN_FILE to a writable path.`,
    );
  }

  // Refuse to drop a 0600 secret in a world-writable directory — the file
  // permission is meaningless if any user can rename the parent.
  const st = statSync(dir);
  if ((st.mode & 0o002) !== 0) {
    issues.push(
      `RITSU_ADMIN_TOKEN_FILE parent '${dir}' is world-writable (mode ${(st.mode & 0o777).toString(8)}). ` +
      `Refusing to bootstrap a secrets file here. chmod o-w ${dir} (or pick a different parent).`,
    );
  }

  if (issues.length > 0) throw new ConfigError(issues);
}
