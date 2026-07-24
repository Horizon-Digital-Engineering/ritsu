import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { SqliteMemoryBackend } from '../memory/sqlite-backend.js';
import { FakeMemoryBackend } from '../memory/fake-backend.js';
import type { MemoryBackend, Scope } from '../memory/backend.js';

const scope: Scope = { user_id: 'leslie', project_id: 'health' };

// Run the same suite against both the sqlite (DB-backed) and fake (in-memory)
// adapters — they must behave identically behind the seam.
function suite(name: string, make: () => MemoryBackend) {
  describe(name, () => {
    let mem: MemoryBackend;
    beforeEach(() => { mem = make(); });

    it('records a typed record and reads it back', async () => {
      const { id } = await mem.record({
        type: 'episodic', content: 'took 5mg lisinopril', source: 'ritsu:health', scope,
      });
      assert.ok(id);
      const rows = await mem.query(scope);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].content, 'took 5mg lisinopril');
      assert.equal(rows[0].type, 'episodic');
      assert.ok(rows[0].content_hash.length === 32);   // md5 hex (matches flashback)
      assert.ok(rows[0].ingest_time > 0);
    });

    it('getContext ranks keyword matches above the rest', async () => {
      await mem.record({ type: 'episodic', content: 'weighed 180 lbs', source: 's', scope });
      await mem.record({ type: 'episodic', content: 'discussed lisinopril dosage', source: 's', scope });
      await mem.record({ type: 'episodic', content: 'ate lunch', source: 's', scope });
      const ctx = await mem.getContext(scope, 'lisinopril');
      assert.ok(ctx.records.length >= 1);
      assert.match(ctx.records[0].content, /lisinopril/);
    });

    it('supersede is a forward pointer: old row survives unmutated, hidden from active', async () => {
      const { id: v1 } = await mem.record({ type: 'semantic', content: 'weight 180', source: 's', scope });
      const { id: v2 } = await mem.record({ type: 'semantic', content: 'weight 178', source: 's', scope, supersedes: v1 });

      const active = await mem.query(scope);
      assert.deepEqual(active.map(r => r.id), [v2]);         // only the new one is active

      const old = await mem.read(v1);                        // old row STILL EXISTS
      assert.notEqual(old, null);
      assert.equal(old!.content, 'weight 180');              // and is UNMUTATED
      assert.equal(old!.supersedes, null);                   // we never touched it

      const line = await mem.lineage(v2);
      assert.deepEqual(line.map(r => r.id), [v1, v2]);       // full chain, oldest first
    });

    it('lineage keeps ALL versions when history branches (no dropped siblings)', async () => {
      const { id: v1 } = await mem.record({ type: 'semantic', content: 'weight 180', source: 's', scope });
      const { id: a } = await mem.record({ type: 'semantic', content: 'weight 178', source: 's', scope, supersedes: v1 });
      const { id: b } = await mem.record({ type: 'semantic', content: 'weight 179', source: 's', scope, supersedes: v1 });
      const ids = (await mem.lineage(v1)).map(r => r.id).sort();
      assert.deepEqual(ids, [v1, a, b].sort());  // all three; the branch sibling is not dropped
    });

    it('scopes by project', async () => {
      await mem.record({ type: 'episodic', content: 'a', source: 's', scope: { user_id: 'leslie', project_id: 'health' } });
      await mem.record({ type: 'episodic', content: 'b', source: 's', scope: { user_id: 'leslie', project_id: 'finance' } });
      assert.equal((await mem.query({ user_id: 'leslie', project_id: 'health' })).length, 1);
      assert.equal((await mem.query({ user_id: 'leslie', project_id: 'finance' })).length, 1);
      assert.equal((await mem.query({ user_id: 'leslie' })).length, 2);   // user-wide sees both
    });

    it('filters by type', async () => {
      await mem.record({ type: 'episodic', content: 'e', source: 's', scope });
      await mem.record({ type: 'document', content: 'd', source: 's', scope });
      const docs = await mem.query(scope, { type: 'document' });
      assert.equal(docs.length, 1);
      assert.equal(docs[0].type, 'document');
    });

    it('respects ttl expiry', async () => {
      const now = Math.floor(Date.now() / 1000);
      await mem.record({ type: 'working', content: 'expired', source: 's', scope, ttl: now - 10 });
      await mem.record({ type: 'working', content: 'live', source: 's', scope, ttl: now + 1000 });
      assert.deepEqual((await mem.query(scope)).map(r => r.content), ['live']);
    });

    it('round-trips a structured payload', async () => {
      await mem.record({
        type: 'state_object', content: 'txn', source: 'finance-sync', scope,
        payload: { amount: 42.5, category: 'food', merchant: 'cafe' },
      });
      const [row] = await mem.query(scope, { type: 'state_object' });
      assert.deepEqual(row.payload, { amount: 42.5, category: 'food', merchant: 'cafe' });
    });
  });
}

suite('SqliteMemoryBackend', () => new SqliteMemoryBackend(openDatabase(':memory:')));
suite('FakeMemoryBackend', () => new FakeMemoryBackend());
