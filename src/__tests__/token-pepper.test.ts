import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { openDatabase } from '../db.js';
import { TokenStore } from '../auth/token-store.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';

// SEC-3: with a master key configured, tokens are stored as an HMAC keyed by a
// pepper derived from that key (not bare sha256), so a stolen DB alone can't be
// brute-forced offline. Legacy sha256 rows still verify and drift up in place.
// The no-key fallback (bare sha256, no regression) is covered by the main
// TokenStore suite, which runs with no RITSU_MASTER_KEY set.
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

describe('TokenStore token-at-rest hashing (SEC-3 pepper)', () => {
  let store: TokenStore;
  let db: ReturnType<typeof openDatabase>;

  before(() => { process.env.RITSU_MASTER_KEY = TEST_KEY; _resetKeyCacheForTests(); });
  after(() => { delete process.env.RITSU_MASTER_KEY; _resetKeyCacheForTests(); });
  beforeEach(() => { db = openDatabase(':memory:'); store = new TokenStore(db); });

  const storedHash = (id: number): string =>
    (db.prepare('SELECT token_hash FROM mcp_tokens WHERE id = ?').get(id) as { token_hash: string }).token_hash;

  it('stores a peppered hash (not the bare sha256) when a master key is set', () => {
    const m = store.mint('keyed');
    const bare = createHash('sha256').update(m.token).digest('hex');
    assert.notEqual(storedHash(m.id), bare, 'stored hash must not be the bare sha256');
    assert.equal(store.verify(m.token)?.id, m.id);
  });

  it('still verifies a legacy bare-sha256 row and upgrades it in place', () => {
    const m = store.mint('legacy');
    const bare = createHash('sha256').update(m.token).digest('hex');
    db.prepare('UPDATE mcp_tokens SET token_hash = ? WHERE id = ?').run(bare, m.id);
    assert.equal(storedHash(m.id), bare, 'row now looks legacy');
    // Candidate match on the sha256 hash still authenticates the token...
    assert.equal(store.verify(m.token)?.id, m.id);
    // ...and rehash-on-verify has migrated the row up to the peppered hash.
    assert.notEqual(storedHash(m.id), bare, 'legacy row should be upgraded to the peppered hash');
    // Still verifies after the upgrade.
    assert.equal(store.verify(m.token)?.id, m.id);
  });
});
