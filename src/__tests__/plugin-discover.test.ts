import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { discoverPlugins } from '../plugins/discover.js';

describe('plugin auto-discovery', () => {
  it('finds every first-party plugin with no index.ts registration', async () => {
    const plugins = await discoverPlugins();
    const ids = plugins.map(p => p.manifest.id).sort();
    assert.deepEqual(ids, ['finance', 'projects']);
    assert.ok(plugins.every(p => typeof p.manifest.id === 'string' && !!p.manifest.version));
  });
});
