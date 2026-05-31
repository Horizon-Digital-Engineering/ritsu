import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ApprovalStore } from '../approval-store.js';
import { approvalBus, type ApprovalEvent } from '../approval-bus.js';

describe('ApprovalStore', () => {
  let store: ApprovalStore;

  beforeEach(() => {
    store = new ApprovalStore(openDatabase(':memory:'));
  });

  it('request creates a pending row and the promise resolves on approve', async () => {
    const p = store.request({ agentId: 'alice', conversationId: 7, toolName: 'Bash', args: { command: 'ls' } });
    const pending = store.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].agent_id, 'alice');
    assert.equal(pending[0].conversation_id, 7);
    assert.equal(pending[0].tool_name, 'Bash');
    assert.equal(pending[0].state, 'pending');
    assert.equal(store.pendingCount(), 1);

    const decided = store.decide(pending[0].id, 'approved', null, 'test');
    assert.ok(decided);
    assert.equal(decided.state, 'approved');

    const result = await p;
    assert.deepEqual(result, { state: 'approved', reason: null });
    assert.equal(store.pendingCount(), 0);
  });

  it('reject resolves the promise with the operator reason (fed back to the model)', async () => {
    const p = store.request({ agentId: 'bob', conversationId: null, toolName: 'Write', args: {} });
    const id = store.listPending()[0].id;
    store.decide(id, 'rejected', 'send me a draft first', 'admin-ui');
    const result = await p;
    assert.deepEqual(result, { state: 'rejected', reason: 'send me a draft first' });
  });

  it('args are stored verbatim as JSON for the approval card', () => {
    void store.request({ agentId: 'alice', conversationId: 1, toolName: 'Bash', args: { command: 'rm -rf /tmp/x', cwd: '/srv' } });
    const row = store.listPending()[0];
    assert.deepEqual(JSON.parse(row.args_json), { command: 'rm -rf /tmp/x', cwd: '/srv' });
  });

  it('decide on an unknown id returns null', () => {
    assert.equal(store.decide(9999, 'approved', null, 'test'), null);
  });

  it('decide is idempotent — a second decide on the same id returns null', () => {
    void store.request({ agentId: 'alice', conversationId: 1, toolName: 'Bash', args: {} });
    const id = store.listPending()[0].id;
    assert.ok(store.decide(id, 'approved', null, 'test'));
    assert.equal(store.decide(id, 'rejected', 'too late', 'test'), null);
    // The first decision stands.
    assert.equal(store.get(id)!.state, 'approved');
  });

  it('listPending is oldest-first; listDecided is newest-first', () => {
    void store.request({ agentId: 'a', conversationId: 1, toolName: 'T1', args: {} });
    void store.request({ agentId: 'a', conversationId: 1, toolName: 'T2', args: {} });
    const pending = store.listPending();
    assert.deepEqual(pending.map(p => p.tool_name), ['T1', 'T2']); // oldest first

    store.decide(pending[0].id, 'approved', null, 'test');
    store.decide(pending[1].id, 'rejected', null, 'test');
    const decided = store.listDecided();
    // Newest decision first — T2 was decided last.
    assert.equal(decided[0].tool_name, 'T2');
  });

  it('listPendingForConversation scopes to one thread', () => {
    void store.request({ agentId: 'a', conversationId: 1, toolName: 'T1', args: {} });
    void store.request({ agentId: 'a', conversationId: 2, toolName: 'T2', args: {} });
    void store.request({ agentId: 'a', conversationId: 1, toolName: 'T3', args: {} });
    const forConvo1 = store.listPendingForConversation(1);
    assert.deepEqual(forConvo1.map(p => p.tool_name), ['T1', 'T3']);
  });

  it('reconcileOnBoot closes pendings left over from a prior process', () => {
    const db = openDatabase(':memory:');
    // Simulate a row written by a previous process (no live resolver).
    db.prepare(
      `INSERT INTO tool_approvals (agent_id, conversation_id, tool_name, args_json) VALUES ('a', 1, 'Bash', '{}')`,
    ).run();
    const fresh = new ApprovalStore(db);
    assert.equal(fresh.pendingCount(), 1);
    fresh.reconcileOnBoot();
    assert.equal(fresh.pendingCount(), 0);
    const decided = fresh.listDecided();
    assert.equal(decided.length, 1);
    assert.equal(decided[0].state, 'rejected');
    assert.equal(decided[0].decided_by, 'system');
    // Idempotent — a second pass is a no-op.
    fresh.reconcileOnBoot();
    assert.equal(fresh.listDecided().length, 1);
  });

  it('publishes requested + decided events on the approval bus', () => {
    const events: ApprovalEvent[] = [];
    const handler = (e: ApprovalEvent) => events.push(e);
    approvalBus.on('event', handler);
    try {
      void store.request({ agentId: 'a', conversationId: 1, toolName: 'Bash', args: {} });
      const id = store.listPending()[0].id;
      store.decide(id, 'approved', null, 'test');
    } finally {
      approvalBus.off('event', handler);
    }
    assert.deepEqual(events.map(e => e.kind), ['requested', 'decided']);
    assert.equal(events[1].approval.state, 'approved');
  });
});
