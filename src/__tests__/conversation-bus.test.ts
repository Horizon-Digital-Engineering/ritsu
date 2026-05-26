import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { conversationBus, type ConversationEvent } from '../conversation-bus.js';

describe('conversationBus', () => {
  it('publishes a message event when SqliteConversationStore.append runs', () => {
    const store = new SqliteConversationStore(openDatabase(':memory:'));
    const cid = store.start('alice');
    const captured: ConversationEvent[] = [];
    const handler = (e: ConversationEvent) => captured.push(e);
    conversationBus.on('event', handler);
    try {
      store.append(cid, 'user', 'hello', 'admin-ui');
    } finally {
      conversationBus.off('event', handler);
    }
    assert.equal(captured.length, 1);
    const ev = captured[0];
    assert.equal(ev.kind, 'message');
    if (ev.kind !== 'message') throw new Error('type narrow failed');
    assert.equal(ev.conversation_id, cid);
    assert.equal(ev.agent_id, 'alice');
    assert.equal(ev.role, 'user');
    assert.equal(ev.content, 'hello');
    assert.equal(ev.caller_label, 'admin-ui');
    assert.equal(typeof ev.ts, 'number');
  });

  it('publish() round-trips ask-start / ask-end events to subscribers', () => {
    const captured: ConversationEvent[] = [];
    const handler = (e: ConversationEvent) => captured.push(e);
    conversationBus.on('event', handler);
    try {
      conversationBus.publish({ kind: 'ask-start', conversation_id: 42, agent_id: 'alice', ts: 1 });
      conversationBus.publish({ kind: 'ask-end', conversation_id: 42, agent_id: 'alice', ts: 2 });
    } finally {
      conversationBus.off('event', handler);
    }
    assert.deepEqual(captured.map(e => e.kind), ['ask-start', 'ask-end']);
  });

  it('caller_label is null when omitted from append()', () => {
    const store = new SqliteConversationStore(openDatabase(':memory:'));
    const cid = store.start('bob');
    const captured: ConversationEvent[] = [];
    const handler = (e: ConversationEvent) => captured.push(e);
    conversationBus.on('event', handler);
    try {
      store.append(cid, 'assistant', 'reply');
    } finally {
      conversationBus.off('event', handler);
    }
    assert.equal(captured.length, 1);
    const ev = captured[0];
    if (ev.kind !== 'message') throw new Error('type narrow failed');
    assert.equal(ev.caller_label, null);
    assert.equal(ev.role, 'assistant');
  });
});
