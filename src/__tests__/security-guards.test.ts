import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { assertGrantableCapabilities } from '../admin/schema.js';
import { scrubSecrets } from '../util/scrub.js';

describe('assertGrantableCapabilities (privesc guard)', () => {
  it('allows the agent-grantable capabilities', () => {
    assert.doesNotThrow(() => assertGrantableCapabilities([]));
    assert.doesNotThrow(() => assertGrantableCapabilities(['manage_agents']));
    assert.doesNotThrow(() => assertGrantableCapabilities(['manage_agents', 'monitor_agents']));
    assert.doesNotThrow(() => assertGrantableCapabilities(undefined));
  });

  it('rejects crm — an agent must not be able to grant inbox access', () => {
    assert.throws(() => assertGrantableCapabilities(['crm']), /operator-only/);
    assert.throws(() => assertGrantableCapabilities(['manage_agents', 'crm']), /crm/);
  });

  it('rejects social — an agent must not be able to grant posting access', () => {
    assert.throws(() => assertGrantableCapabilities(['social']), /operator-only/);
    assert.throws(() => assertGrantableCapabilities(['crm', 'social']), /operator-only/);
  });

  it('rejects unknown capabilities', () => {
    assert.throws(() => assertGrantableCapabilities(['root']), /operator-only/);
  });
});

describe('scrubSecrets (model-facing error redaction)', () => {
  it('redacts a Bearer token', () => {
    const out = scrubSecrets('LinkedIn 401: Authorization Bearer AbCdEf0123456789xyz failed');
    assert.equal(out.includes('AbCdEf0123456789xyz'), false);
    assert.match(out, /\[redacted\]/);
  });

  it('redacts long opaque tokens / API keys', () => {
    const token = 'sk-' + 'a1B2c3D4e5'.repeat(5); // 53 chars
    const out = scrubSecrets(`auth failed for ${token}`);
    assert.equal(out.includes(token), false);
  });

  it('leaves ordinary error text intact', () => {
    const msg = 'connection refused to imap.example.com:993';
    assert.equal(scrubSecrets(msg), msg);
  });
});
