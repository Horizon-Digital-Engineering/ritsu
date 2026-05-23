/**
 * Shared client for the running ritsu admin API. Used by every CLI
 * subcommand that operates on running state (tokens, agents, etc) rather
 * than on host config files.
 *
 * Token resolution priority:
 *   1. --token <tok> flag
 *   2. RITSU_ADMIN_TOKEN env var
 *   3. /opt/ritsu/data/.admin-token on disk (default install location)
 */
import { readFileSync, existsSync } from 'node:fs';
import { stripTrailingSlashes } from '../util/path-utils.js';

export const DEFAULT_ADMIN_TOKEN_FILE = '/opt/ritsu/data/.admin-token';
export const DEFAULT_BASE_URL = 'http://127.0.0.1:7334';

export function resolveAdminToken(flagToken: string | boolean | undefined): string {
  if (typeof flagToken === 'string' && flagToken.trim()) return flagToken.trim();
  const env = process.env.RITSU_ADMIN_TOKEN;
  if (env && env.trim()) return env.trim();
  if (existsSync(DEFAULT_ADMIN_TOKEN_FILE)) {
    try {
      return readFileSync(DEFAULT_ADMIN_TOKEN_FILE, 'utf8').trim();
    } catch (err) {
      throw new Error(
        `cannot read ${DEFAULT_ADMIN_TOKEN_FILE} (${(err as Error).message}). ` +
        `Re-run with sudo, pass --token, or set RITSU_ADMIN_TOKEN.`,
      );
    }
  }
  throw new Error(
    'no admin token found. Provide --token, set RITSU_ADMIN_TOKEN, or run ' +
    `from a host with ${DEFAULT_ADMIN_TOKEN_FILE} (requires sudo).`,
  );
}

export function resolveBaseUrl(flagUrl: string | boolean | undefined): string {
  if (typeof flagUrl === 'string' && flagUrl.trim()) return stripTrailingSlashes(flagUrl);
  const env = process.env.RITSU_URL;
  if (env && env.trim()) return stripTrailingSlashes(env);
  return DEFAULT_BASE_URL;
}

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;            // e.g. '/admin/api/tokens'
  body?: unknown;
  token: string;
  baseUrl: string;
}

export async function apiCall<T = unknown>(req: ApiRequest): Promise<T> {
  const r = await fetch(`${req.baseUrl}${req.path}`, {
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${req.token}`,
    },
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
  });
  const text = await r.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!r.ok) {
    const msg = typeof parsed === 'object' && parsed && 'error' in parsed
      ? String((parsed).error)
      : `HTTP ${r.status}`;
    throw new Error(`API ${req.method} ${req.path} → ${msg}`);
  }
  return parsed as T;
}
