import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from '../util/log.js';
import type { Plugin } from './types.js';

function isPlugin(x: unknown): x is Plugin {
  const m = (x as { manifest?: { id?: unknown } } | null)?.manifest;
  return !!m && typeof m === 'object' && typeof m.id === 'string';
}

/**
 * Auto-register first-party plugins by scanning sibling subdirectories for a
 * `plugin.{js,ts}` that exports a Plugin — no index.ts edit to add one, just
 * drop a `plugins/<name>/` folder. Still compile-time (the code ships in the
 * build); this only removes the manual registration seam. Hot-loading of
 * third-party plugins is a separate, later step (it needs real isolation).
 *
 * Resolves relative to THIS module so it works both from the build
 * (dist/plugins/<name>/plugin.js) and under tsx in dev/test
 * (src/plugins/<name>/plugin.ts). A plugin that throws on import is logged and
 * skipped rather than crashing boot.
 */
export async function discoverPlugins(): Promise<Plugin[]> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dirs = readdirSync(here, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));  // deterministic registration order
  const out: Plugin[] = [];
  for (const name of dirs) {
    const file = ['plugin.js', 'plugin.ts'].map(f => join(here, name, f)).find(existsSync);
    if (!file) continue;
    try {
      const mod = await import(pathToFileURL(file).href) as Record<string, unknown>;
      const plugin = Object.values(mod).find(isPlugin);
      if (plugin) out.push(plugin);
      else logger.warn('plugin.discover.no-export', { dir: name });
    } catch (err) {
      logger.error('plugin.discover.failed', { dir: name, err: (err as Error).message });
    }
  }
  logger.info('plugin.discovered', { count: out.length, ids: out.map(p => p.manifest.id) });
  return out;
}
