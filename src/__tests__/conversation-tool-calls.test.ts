import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, type Db } from '../db.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { conversationBus, type ConversationEvent } from '../conversation-bus.js';
import { BackupManager, importJson } from '../backup.js';
import { mergeExportIntoDb } from '../merge-import.js';
import type { ToolActivity } from '../model/dispatcher.js';

const CALLS: ToolActivity[] = [
  { id: 'toolu_1', name: 'mcp__finance__get_balances', args: '{"account":"all"}', status: 'done', result: '{"total":12}' },
  { id: 'toolu_2', name: 'Bash', args: '{"command":"false"}', status: 'error', result: 'Exit code 1' },
];

const count = (db: Db, table: string): number =>
  (db.prepare(`SELECT count(*) AS c FROM "${table}"`).get() as { c: number }).c;

describe('tool calls stored with assistant messages', () => {
  let db: Db;
  let store: SqliteConversationStore;
  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new SqliteConversationStore(db);
  });

  it('round-trips in call order on the assistant row only', () => {
    const cid = store.start('alice');
    const u = store.append(cid, 'user', 'what do I have?', 'admin-ui');
    const a = store.append(cid, 'assistant', 'You have 12.', null, undefined, u, CALLS);
    store.append(cid, 'user', 'thanks', 'admin-ui');
    const rows = store.recent(cid);
    assert.equal(rows[0].tool_calls, undefined);
    assert.equal(rows[2].tool_calls, undefined);
    assert.equal(rows[1].id, a);
    assert.deepEqual(rows[1].tool_calls, CALLS);
  });

  it('stores an unfinished call as an error and a missing result as empty', () => {
    const cid = store.start('alice');
    store.append(cid, 'assistant', 'partial', null, undefined, null, [
      { id: 'toolu_9', name: 'Read', args: '{}', status: 'running' },
    ]);
    assert.deepEqual(store.recent(cid)[0].tool_calls, [{ id: 'toolu_9', name: 'Read', args: '{}', status: 'error', result: '' }]);
  });

  it('writes the calls before the message event fires', () => {
    const cid = store.start('alice');
    let seen: ToolActivity[] | undefined;
    const onEvent = (e: ConversationEvent): void => {
      if (e.kind === 'message' && e.role === 'assistant') seen = store.recent(cid).at(-1)?.tool_calls;
    };
    conversationBus.on('event', onEvent);
    try {
      store.append(cid, 'assistant', 'done', null, undefined, null, CALLS);
    } finally {
      conversationBus.off('event', onEvent);
    }
    assert.deepEqual(seen, CALLS);
  });

  it('is one transaction: a call that cannot be stored leaves no message behind', () => {
    const cid = store.start('alice');
    const bad = [{ ...CALLS[0], name: null as unknown as string }];
    assert.throws(() => store.append(cid, 'assistant', 'nope', null, undefined, null, bad));
    assert.equal(count(db, 'messages'), 0);
    assert.equal(count(db, 'message_tool_calls'), 0);
  });

  it('deleting a conversation removes its calls', () => {
    const cid = store.start('alice');
    const keep = store.start('alice');
    store.append(cid, 'assistant', 'one', null, undefined, null, CALLS);
    store.append(keep, 'assistant', 'two', null, undefined, null, CALLS.slice(0, 1));
    assert.equal(store.deleteConversation(cid), true);
    assert.equal(count(db, 'message_tool_calls'), 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });

  it('cascades, so a delete that never names the table still succeeds', () => {
    const cid = store.start('alice');
    const keep = store.start('alice');
    store.append(cid, 'assistant', 'one', null, undefined, null, CALLS);
    store.append(keep, 'assistant', 'two', null, undefined, null, CALLS.slice(0, 1));
    db.transaction(() => {
      db.prepare('DELETE FROM message_attachments WHERE conversation_id = ?').run(cid);
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(cid);
      db.prepare('DELETE FROM conversations WHERE id = ?').run(cid);
    })();
    assert.equal(count(db, 'message_tool_calls'), 1);
    assert.deepEqual(store.recent(keep)[0].tool_calls, CALLS.slice(0, 1));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });

  it('a fork copies the calls of the messages it copies', () => {
    const cid = store.start('alice');
    const u = store.append(cid, 'user', 'first', 'admin-ui');
    const a = store.append(cid, 'assistant', 'answer', null, undefined, u, CALLS);
    store.append(cid, 'user', 'second', 'admin-ui');
    store.append(cid, 'assistant', 'later', null, undefined, null, [{ ...CALLS[0], id: 'toolu_later' }]);

    const whole = store.fork(cid);
    assert.ok(whole);
    const copied = store.recent(whole);
    assert.deepEqual(copied[1].tool_calls, CALLS);
    assert.equal(copied[3].tool_calls?.[0].id, 'toolu_later');

    const upTo = store.fork(cid, a);
    assert.ok(upTo);
    const partial = store.recent(upTo);
    assert.equal(partial.length, 2);
    assert.deepEqual(partial[1].tool_calls, CALLS);
    assert.equal(count(db, 'message_tool_calls'), 3 + 3 + 2);
  });
});

describe('tool calls in the JSON export, import and merge', () => {
  let tmp: string;
  let source: Db;
  let store: SqliteConversationStore;
  let assistantId: number;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ritsu-toolcalls-'));
    source = openDatabase(join(tmp, 'source.db'));
    store = new SqliteConversationStore(source);
    const cid = store.start('alice');
    const u = store.append(cid, 'user', 'what do I have?', 'admin-ui');
    assistantId = store.append(cid, 'assistant', 'You have 12.', null, undefined, u, CALLS);
    const other = store.start('bob');
    store.append(other, 'assistant', 'bob says hi', null, undefined, null, [{ ...CALLS[0], id: 'toolu_bob' }]);
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  const exported = () => new BackupManager(source, join(tmp, 'source.db'), join(tmp, 'backups'), { host: 'h' }).exportJson();

  it('the export carries the table and an import rebuilds it intact', () => {
    const file = exported();
    assert.equal(file.tables.message_tool_calls.length, 3);
    const dest = join(tmp, 'imported.db');
    const { counts } = importJson(file, dest);
    assert.equal(counts.message_tool_calls, 3);
    const db = new DatabaseSync(dest, { readOnly: true });
    try {
      const rows = db.prepare('SELECT message_id, call_id, status FROM message_tool_calls ORDER BY id').all() as
        Array<{ message_id: number; call_id: string; status: string }>;
      assert.deepEqual(rows.map(r => `${r.message_id}:${r.call_id}:${r.status}`),
        [`${assistantId}:toolu_1:done`, `${assistantId}:toolu_2:error`, `${assistantId + 1}:toolu_bob:done`]);
    } finally {
      db.close();
    }
  });

  it('a merge re-points calls at the remapped message and conversation, and drops unselected agents\' calls', () => {
    const live = openDatabase(join(tmp, 'live.db'));
    const liveStore = new SqliteConversationStore(live);
    const lc = liveStore.start('carol');
    liveStore.append(lc, 'user', 'a live message that takes id 1', 'admin-ui');
    liveStore.append(lc, 'assistant', 'live reply', null, undefined, null, [{ ...CALLS[1], id: 'toolu_live' }]);

    const report = mergeExportIntoDb(exported(), live, { agents: ['alice'] });
    assert.deepEqual(report.tables.message_tool_calls, { inserted: 2, skipped: 1 });
    const merged = live.prepare("SELECT id, conversation_id FROM messages WHERE content = 'You have 12.'").get() as
      { id: number; conversation_id: number };
    assert.notEqual(merged.id, assistantId, 'ids are remapped past the live rows');
    const calls = live.prepare('SELECT message_id, conversation_id, call_id FROM message_tool_calls WHERE message_id = ? ORDER BY id')
      .all(merged.id) as Array<{ message_id: number; conversation_id: number; call_id: string }>;
    assert.deepEqual(calls.map(c => c.call_id), ['toolu_1', 'toolu_2']);
    for (const c of calls) assert.equal(c.conversation_id, merged.conversation_id);
    assert.deepEqual(new SqliteConversationStore(live).recent(merged.conversation_id).at(-1)?.tool_calls, CALLS);
    assert.equal(count(live, 'message_tool_calls'), 3, 'the live call stays, bob\'s is not merged');
  });
});
