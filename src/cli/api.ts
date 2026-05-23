/**
 * Shared client for the running ritsu admin API. Used by every CLI
 * subcommand that operates on running state (tokens, agents, etc) rather
 * than on host config files.
 *
 * Token resolution priority:
 *   1. --token <tok> flag
 *   2. RITSU_ADMIN_TOKEN env var
 *   3. The file at config.adminTokenFile (default
 *      /opt/ritsu/data/.admin-token; override with RITSU_ADMIN_TOKEN_FILE
 *      to match the server's bootstrap path).
 */
import { readFileSync, existsSync } from 'node:fs';

import { loadConfig } from '../config.js';
import { stripTrailingSlashes } from '../util/path-utils.js';

export function resolveAdminToken(flagToken: string | boolean | undefined): string {
  if (typeof flagToken === 'string' && flagToken.trim()) return flagToken.trim();
  const env = process.env.RITSU_ADMIN_TOKEN;
  if (env?.trim()) return env.trim();

  const cfg = loadConfig();
  const tokenFile = cfg.adminTokenFile;
  if (existsSync(tokenFile)) {
    try {
      return readFileSync(tokenFile, 'utf8').trim();
    } catch (err) {
      throw new Error(
        `cannot read ${tokenFile} (${(err as Error).message}). ` +
        `Re-run with sudo, pass --token, or set RITSU_ADMIN_TOKEN.`,
      );
    }
  }
  throw new Error(
    `no admin token found. Provide --token, set RITSU_ADMIN_TOKEN, or run ` +
    `from a host with ${tokenFile} (set RITSU_ADMIN_TOKEN_FILE to override).`,
  );
}

export function resolveBaseUrl(flagUrl: string | boolean | undefined): string {
  if (typeof flagUrl === 'string' && flagUrl.trim()) return stripTrailingSlashes(flagUrl);
  const env = process.env.RITSU_URL;
  if (env?.trim()) return stripTrailingSlashes(env);
  const cfg = loadConfig();
  // adminHost === 0.0.0.0 means "bind everywhere"; we can't connect to that
  // literally, so fall back to loopback for the client.
  const host = cfg.adminHost === '0.0.0.0' ? '127.0.0.1' : cfg.adminHost;
  return `http://${host}:${cfg.adminPort}`;
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
