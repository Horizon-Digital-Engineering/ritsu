import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ApprovalStore } from '../approval-store.js';
import {
  ProposalAdapter, PROPOSAL_TOOL_NAME, type FlashbackProposal, type FlashbackProposalClient,
} from '../memory/proposal-adapter.js';

/** Records what the adapter reported back to flashback. */
class MockClient {
  proposed: FlashbackProposal[] = [];
  approved: Array<{ id: string; note?: string }> = [];
  denied: Array<{ id: string; note?: string }> = [];
  executedCalls: Array<{ id: string; result?: unknown }> = [];
  async listProposed(): Promise<FlashbackProposal[]> { return this.proposed; }
  async approve(id: string, note?: string): Promise<void> { this.approved.push({ id, note }); }
  async deny(id: string, note?: string): Promise<void> { this.denied.push({ id, note }); }
  async executed(id: string, result?: unknown): Promise<void> { this.executedCalls.push({ id, result }); }
}

/** Wait for the bus-driven report (approve/deny) to settle. */
const settle = () => new Promise(r => setTimeout(r, 10));

describe('ProposalAdapter', () => {
  let approvals: ApprovalStore;
  let client: MockClient;
  let adapter: ProposalAdapter;

  beforeEach(() => {
    approvals = new ApprovalStore(openDatabase(':memory:'));
    client = new MockClient();
    adapter = new ProposalAdapter({
      client: client as unknown as FlashbackProposalClient,
      approvals,
    });
    adapter.start();
  });
  afterEach(() => { adapter.stop(); });

  it('surfaces proposed actions into pending approval rows', async () => {
    client.proposed = [
      { id: 'p1', kind: 'remember', summary: 'save weight 178' },
      { id: 'p2', kind: 'notify', summary: 'ping about refill' },
    ];
    const created = await adapter.sync();
    assert.equal(created, 2);
    const pending = approvals.listPending();
    assert.equal(pending.length, 2);
    assert.ok(pending.every(r => r.tool_name === PROPOSAL_TOOL_NAME));
    // The flashback proposal id is carried on the row so decisions route back.
    const ids = pending
      .map(r => (JSON.parse(r.args_json) as { proposal_id: string }).proposal_id)
      .sort();
    assert.deepEqual(ids, ['p1', 'p2']);
  });

  it('does not double-mint an already-surfaced proposal', async () => {
    client.proposed = [{ id: 'p1', kind: 'remember' }];
    assert.equal(await adapter.sync(), 1);
    assert.equal(await adapter.sync(), 0); // second sync: nothing new
    assert.equal(approvals.listPending().length, 1);
  });

  it('reports APPROVE back to flashback when the operator approves the row', async () => {
    client.proposed = [{ id: 'p1', kind: 'remember' }];
    await adapter.sync();
    const row = approvals.listPending()[0];
    approvals.decide(row.id, 'approved', 'looks good', 'operator');
    await settle();
    assert.deepEqual(client.approved, [{ id: 'p1', note: 'looks good' }]);
    assert.equal(client.denied.length, 0);
  });

  it('reports DENY back to flashback when the operator rejects the row', async () => {
    client.proposed = [{ id: 'p1', kind: 'notify' }];
    await adapter.sync();
    const row = approvals.listPending()[0];
    approvals.decide(row.id, 'rejected', 'not now', 'operator');
    await settle();
    assert.deepEqual(client.denied, [{ id: 'p1', note: 'not now' }]);
    assert.equal(client.approved.length, 0);
  });

  it('ignores non-proposal approval decisions on the shared bus', async () => {
    // A normal gated-tool approval must not be reported to flashback.
    const decision = approvals.request({
      agentId: 'alice', conversationId: null, toolName: 'send_email', args: {},
    });
    const row = approvals.listPending().find(r => r.tool_name === 'send_email')!;
    approvals.decide(row.id, 'approved', null, 'operator');
    await decision;
    await settle();
    assert.equal(client.approved.length, 0);
    assert.equal(client.denied.length, 0);
  });

  it('reportExecuted marks a proposal executed on flashback', async () => {
    await adapter.reportExecuted('p1', { ok: true });
    assert.deepEqual(client.executedCalls, [{ id: 'p1', result: { ok: true } }]);
  });
});
