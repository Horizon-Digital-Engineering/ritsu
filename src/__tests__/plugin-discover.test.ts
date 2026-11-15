import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanPlugins } from '../plugins/discover.js';

describe('plugin auto-discovery', () => {
  it('finds every first-party plugin with no index.ts registration', async () => {
    const { plugins } = await scanPlugins();
    const ids = plugins.map(p => p.manifest.id).sort();
    assert.deepEqual(ids, ['finance', 'health', 'projects', 'tasks']);
    assert.ok(plugins.every(p => typeof p.manifest.id === 'string' && !!p.manifest.version));
  });

  it('reports no failures for the shipped plugins', async () => {
    assert.deepEqual((await scanPlugins()).failed, []);
  });

  it('returns folders whose plugin threw on import or exported nothing, and skips them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ritsu-discover-'));
    try {
      const write = (name: string, body: string) => {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, 'plugin.js'), body);
      };
      write('good', "export const plugin = { manifest: { id: 'good', name: 'Good', version: '1.0.0' } };\n");
      write('throws', "throw new Error('missing dependency');\n");
      write('empty', 'export const nothing = 1;\n');
      mkdirSync(join(dir, 'no-plugin-file'));
      const { plugins, failed } = await scanPlugins(dir);
      assert.deepEqual(plugins.map(p => p.manifest.id), ['good']);
      assert.deepEqual(failed, ['empty', 'throws']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
