import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { CommsDenialStore } from '../comms-denial-store.js';
import { approvalBus, type ApprovalEvent } from '../approval-bus.js';

describe('CommsDenialStore', () => {
  it('records denials and lists them newest-first with detail intact', () => {
    const store = new CommsDenialStore(openDatabase(':memory:'));
    store.record({ caller: 'a', target: 'b', reason: 'escalation', detail: 'escalated: manage_agents', conversationId: 9 });
    store.record({ caller: 'a', target: 'c', reason: 'not_in_allowlist' });
    const recent = store.listRecent();
    assert.equal(recent.length, 2);
    assert.equal(recent[0].target, 'c');                       // newest first
    assert.equal(recent[1].reason, 'escalation');
    assert.equal(recent[1].detail, 'escalated: manage_agents');
    assert.equal(recent[1].conversation_id, 9);
    assert.equal(recent[0].detail, null);                      // optional fields default null
  });

  it('publishes a comms-denied event on the approval bus', () => {
    const store = new CommsDenialStore(openDatabase(':memory:'));
    const seen: string[] = [];
    const handler = (e: ApprovalEvent): void => {
      if (e.kind === 'comms-denied') seen.push(`${e.denial.caller}->${e.denial.target}:${e.denial.reason}`);
    };
    approvalBus.on('event', handler);
    try {
      store.record({ caller: 'x', target: 'y', reason: 'cycle' });
    } finally {
      approvalBus.off('event', handler);
    }
    assert.deepEqual(seen, ['x->y:cycle']);
  });
});
