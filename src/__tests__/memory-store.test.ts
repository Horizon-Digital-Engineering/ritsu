import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { SqliteMemoryStore } from '../memory-store.js';

describe('SqliteMemoryStore', () => {
  let store: SqliteMemoryStore;

  beforeEach(() => {
    store = new SqliteMemoryStore(openDatabase(':memory:'));
  });

  it('writes and lists a memory', async () => {
    const id = await store.write({ agent_id: 'alice', content: 'remember me' });
    assert.equal(id, 1);
    const all = await store.list('alice');
    assert.equal((all).length, 1);
    assert.equal(all[0].content, 'remember me');
    assert.equal(all[0].lineage_root_id, id);
  });

  it('isolates memories per agent', async () => {
    await store.write({ agent_id: 'alice', content: 'a-1' });
    await store.write({ agent_id: 'bob', content: 'b-1' });
    assert.equal((await store.list('alice')).length, 1);
    assert.equal((await store.list('bob')).length, 1);
  });

  it('supersede chain hides old, preserves lineage', async () => {
    const v1 = await store.write({ agent_id: 'alice', content: 'v1' });
    const v2 = await store.write({ agent_id: 'alice', content: 'v2', supersedes: v1 });
    const v3 = await store.write({ agent_id: 'alice', content: 'v3', supersedes: v2 });

    // Active list shows only the latest
    const active = await store.list('alice');
    assert.equal((active).length, 1);
    assert.equal(active[0].id, v3);

    // Lineage walks all three in chronological order
    const line = await store.lineage(v3);
    assert.deepEqual(line.map(m => m.id), [v1, v2, v3]);
    assert.equal(line.every(m => m.lineage_root_id === v1), true);
  });

  it('explicit supersede() works on already-written rows', async () => {
    const v1 = await store.write({ agent_id: 'alice', content: 'first' });
    const v2 = await store.write({ agent_id: 'alice', content: 'second' });
    await store.supersede(v1, v2);
    const active = await store.list('alice');
    assert.ok((active.map(m => m.id)).includes(v2));
  });

  it('delete() tombstones a memory (hidden from active, preserved in lineage)', async () => {
    const id = await store.write({ agent_id: 'alice', content: 'kill me' });
    assert.equal((await store.list('alice')).length, 1);
    const ok = await store.delete(id);
    assert.equal(ok, true);
    // Active list no longer shows it
    assert.equal((await store.list('alice')).length, 0);
    // Row still exists and lineage still finds it
    const row = await store.read(id);
    assert.notEqual(row, null);
    assert.equal(row!.superseded_by, id);     // self-supersede tombstone
    const line = await store.lineage(id);
    assert.deepEqual(line.map(m => m.id), [id]);
  });

  it('delete() returns false for an already-tombstoned memory (idempotent)', async () => {
    const id = await store.write({ agent_id: 'alice', content: 'one shot' });
    assert.equal(await store.delete(id), true);
    assert.equal(await store.delete(id), false);   // already tombstoned
  });
});
