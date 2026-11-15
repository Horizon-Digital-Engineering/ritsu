import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { logger } from '../util/log.js';
import type { Plugin } from './types.js';

function isPlugin(x: unknown): x is Plugin {
  const m = (x as { manifest?: { id?: unknown } } | null)?.manifest;
  return !!m && typeof m === 'object' && typeof m.id === 'string';
}

export interface PluginScan {
  plugins: Plugin[];
  /** Folders with a plugin file that threw on import or exported no plugin. */
  failed: string[];
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
 * skipped rather than crashing boot, and reported in `failed`.
 */
export async function scanPlugins(here = dirname(fileURLToPath(import.meta.url))): Promise<PluginScan> {
  const dirs = readdirSync(here, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));  // deterministic registration order
  const failed: string[] = [];
  // Imports run concurrently; the sorted index, not import completion, decides
  // registration order.
  const loaded = await Promise.all(dirs.map(async (name): Promise<Plugin | null> => {
    const file = ['plugin.js', 'plugin.ts'].map(f => join(here, name, f)).find(existsSync);
    if (!file) return null;
    try {
      const mod = await import(pathToFileURL(file).href) as Record<string, unknown>;
      const plugin = Object.values(mod).find(isPlugin);
      if (plugin) return plugin;
      logger.warn('plugin.discover.no-export', { dir: name });
    } catch (err) {
      logger.error('plugin.discover.failed', { dir: name, err: (err as Error).message });
    }
    failed.push(name);
    return null;
  }));
  const plugins = loaded.filter((p): p is Plugin => p !== null);
  logger.info('plugin.discovered', { count: plugins.length, ids: plugins.map(p => p.manifest.id), ...(failed.length ? { failed: failed.length } : {}) });
  return { plugins, failed: failed.toSorted((a, b) => a.localeCompare(b)) };
}
