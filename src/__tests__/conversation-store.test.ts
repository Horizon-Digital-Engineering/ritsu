import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { SqliteConversationStore } from '../conversation-store.js';

describe('SqliteConversationStore', () => {
  let store: SqliteConversationStore;

  beforeEach(() => {
    store = new SqliteConversationStore(openDatabase(':memory:'));
  });

  it('start → append → recent round-trip preserves order', () => {
    const cid = store.start('alice');
    store.append(cid, 'user', 'hi');
    store.append(cid, 'assistant', 'hello');
    store.append(cid, 'user', 'how are you');
    const recent = store.recent(cid);
    assert.deepEqual(recent.map(m => m.role), ['user', 'assistant', 'user']);
    assert.deepEqual(recent.map(m => m.content), ['hi', 'hello', 'how are you']);
  });

  it('honors limit AND returns the newest N (chronological order, most-recent last)', () => {
    const cid = store.start('alice');
    for (let i = 0; i < 10; i++) store.append(cid, 'user', `m${i}`);
    const last3 = store.recent(cid, 3);
    assert.equal((last3).length, 3);
    // Must be the LATEST three, in chronological order — regression guard for
    // the ORDER BY ASC LIMIT bug that silently truncated new turns after a
    // conversation crossed the limit.
    assert.deepEqual(last3.map(m => m.content), ['m7', 'm8', 'm9']);
  });

  it('persists image attachments on a user turn and returns them in order', () => {
    const cid = store.start('alice');
    store.append(cid, 'user', 'look at this', 'admin-ui', [
      { media_type: 'image/png', data: 'QUFB' },
      { media_type: 'image/jpeg', data: 'QkJC' },
    ]);
    store.append(cid, 'assistant', 'nice shot');
    const recent = store.recent(cid);
    assert.equal(recent.length, 2);
    assert.deepEqual(recent[0].attachments, [
      { media_type: 'image/png', data: 'QUFB' },
      { media_type: 'image/jpeg', data: 'QkJC' },
    ]);
    assert.equal(recent[1].attachments, undefined); // assistant turn has none
  });

  it('omits the attachments field for a text-only turn', () => {
    const cid = store.start('alice');
    store.append(cid, 'user', 'plain text only');
    assert.equal(store.recent(cid)[0].attachments, undefined);
  });

  it('isolates conversations', () => {
    const a = store.start('alice');
    const b = store.start('bob');
    store.append(a, 'user', 'alice-1');
    store.append(b, 'user', 'bob-1');
    assert.equal((store.recent(a)).length, 1);
    assert.equal((store.recent(b)).length, 1);
    assert.equal(store.recent(a)[0].content, 'alice-1');
  });

  describe('findOrStartInterAgentThread', () => {
    it('creates a thread the first time, returns the same id on subsequent calls', () => {
      const first = store.findOrStartInterAgentThread('alice', 'bob');
      const second = store.findOrStartInterAgentThread('alice', 'bob');
      const third = store.findOrStartInterAgentThread('alice', 'bob');
      assert.equal(second, first);
      assert.equal(third, first);
    });

    it('keeps separate threads per (caller, target) pair', () => {
      const aliceBob = store.findOrStartInterAgentThread('alice', 'bob');
      const aliceCharlie = store.findOrStartInterAgentThread('alice', 'charlie');
      const dianeBob = store.findOrStartInterAgentThread('diane', 'bob');
      assert.notEqual(aliceBob, aliceCharlie);
      assert.notEqual(aliceBob, dianeBob);
      assert.notEqual(aliceCharlie, dianeBob);
    });

    it('returns the OLDEST matching thread if multiple exist (canonical = first one)', () => {
      const first = store.findOrStartInterAgentThread('alice', 'bob');
      // Simulate a second thread created out-of-band (e.g. explicit conversation_id flow)
      const db = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db;
      db.prepare('INSERT INTO conversations (agent_id, caller_agent_id) VALUES (?, ?)').run('bob', 'alice');
      const lookup = store.findOrStartInterAgentThread('alice', 'bob');
      assert.equal(lookup, first);
    });

    it('does not collide with human-initiated conversations (caller_agent_id null)', () => {
      const human = store.start('bob');               // caller_agent_id is null
      const interAgent = store.findOrStartInterAgentThread('alice', 'bob');
      assert.notEqual(interAgent, human);
    });
  });
});
