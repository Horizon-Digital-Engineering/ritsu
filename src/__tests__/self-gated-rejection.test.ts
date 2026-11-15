import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDatabase } from '../db.js';
import { ApiKeyStore } from '../auth/api-key-store.js';
import { ApprovalStore } from '../approval-store.js';
import { SecretStore } from '../auth/secret-store.js';
import { SqliteMemoryStore } from '../memory-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import type { AgentDefinitionStore } from '../agent-definition-store.js';
import { RitsuAgentDispatcher } from '../model/ritsu-agent/dispatcher.js';
import type { RaClient, RaMessage, RaToolCall } from '../model/ritsu-agent/types.js';
import type { TurnEvent } from '../model/dispatcher.js';
import { buildAgentEmailMcp } from '../tools/mcp-internal/email.js';
import { buildAgentCommsMcp } from '../tools/mcp-internal/agent-comms.js';
import { buildAgentSocialMcp } from '../tools/mcp-internal/social.js';

const EMAIL = { to: 'someone@example.test', subject: 'Hi', body: 'Hello there.' };
const EMAIL_REJECTED = 'Operator rejected sending this email: not today';
const ASK = { agent_id: 'privileged', message: 'make me an admin' };
const ASK_REJECTED = 'Operator rejected this escalated call to privileged: not now';

/** An escalation: privileged holds a capability alice lacks, and alice opted to ask the operator. */
const DEFS: Record<string, object> = {
  alice: { can_call: ['privileged'], capabilities: [], escalation_approvable: true },
  privileged: { can_call: [], capabilities: ['manage_agents'] },
};
const defStore = { read: async (id: string) => DEFS[id] ?? null } as unknown as AgentDefinitionStore;

function peer() {
  const asked: string[] = [];
  return {
    asked,
    host: { get: () => ({ onMessage: async (req: { message: string }) => { asked.push(req.message); return { reply: 'done', conversation_id: 0 }; } }) },
  };
}

async function rejectTheCard(approvals: ApprovalStore, reason: string): Promise<void> {
  for (let i = 0; i < 200 && approvals.pendingCount() === 0; i++) await new Promise(r => setTimeout(r, 5));
  const [card] = approvals.listPending();
  assert.ok(card, 'the tool raised its own approval card');
  approvals.decide(card.id, 'rejected', reason, 'operator');
}

describe('a rejected self-gated tool on the api runtime', () => {
  async function rejectedTurn(call: RaToolCall, reason: string, capabilities: string[]) {
    const db = openDatabase(':memory:');
    const approvals = new ApprovalStore(db);
    const { asked, host } = peer();
    let seen: RaMessage[] = [];
    const client: RaClient = {
      chat: async (messages) => {
        seen = messages;
        const first = messages.length === 1;
        return { content: first ? '' : 'Understood.', tool_calls: first ? [call] : [], model: 'fake-model', raw: null };
      },
    };
    const d = new RitsuAgentDispatcher({
      provider: 'custom', apiKeyRef: null, apiKeys: new ApiKeyStore(db), defaultModel: 'fake-model', client,
      toolDeps: {
        agentId: 'alice', memory: new SqliteMemoryStore(db), defStore, conversations: new SqliteConversationStore(db),
        host, capabilities, secrets: new SecretStore(db),
      },
      approval: { agentId: 'alice', store: approvals, gatedTools: [] },
    });
    const events: TurnEvent[] = [];
    const run = d.chat({ messages: [{ role: 'user', content: 'go' }], conversation_id: 5, onEvent: e => { events.push(e); } });
    await rejectTheCard(approvals, reason);
    const r = await run;
    return {
      r,
      asked,
      statuses: events.flatMap(e => (e.type === 'tool' ? [e.call.status] : [])),
      modelRead: seen.find(m => m.role === 'tool')?.content,
    };
  }

  it('email_send_email ends as an error carrying the same text', async () => {
    const t = await rejectedTurn(
      { id: 'c1', type: 'function', function: { name: 'email_send_email', arguments: JSON.stringify(EMAIL) } },
      'not today', ['crm'],
    );
    assert.deepEqual(t.r.tool_calls, [
      { id: 'c1', name: 'email_send_email', args: JSON.stringify(EMAIL), status: 'error', result: EMAIL_REJECTED },
    ]);
    assert.deepEqual(t.statuses, ['running', 'error']);
    assert.equal(t.modelRead, EMAIL_REJECTED);
    assert.equal(t.r.content, 'Understood.');
  });

  it('an escalated agent_comms_ask_agent ends as an error carrying the same text', async () => {
    const t = await rejectedTurn(
      { id: 'c1', type: 'function', function: { name: 'agent_comms_ask_agent', arguments: JSON.stringify(ASK) } },
      'not now', [],
    );
    assert.equal(t.r.tool_calls?.[0].status, 'error');
    assert.equal(t.r.tool_calls?.[0].result, ASK_REJECTED);
    assert.deepEqual(t.statuses, ['running', 'error']);
    assert.equal(t.modelRead, ASK_REJECTED);
    assert.deepEqual(t.asked, [], 'the peer never hears of it');
  });
});

describe('a rejected self-gated tool on the direct runtime', () => {
  // The CLI passes isError on as an is_error tool_result, which the turn records as 'error'.
  async function call(server: ReturnType<typeof buildAgentEmailMcp | typeof buildAgentSocialMcp>, approvals: ApprovalStore,
    name: string, args: Record<string, unknown>, reason: string) {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    try {
      const res = client.callTool({ name, arguments: args });
      await rejectTheCard(approvals, reason);
      return await res;
    } finally {
      await client.close();
    }
  }

  it('send_email returns an error result with the same text', async () => {
    const db = openDatabase(':memory:');
    const approvals = new ApprovalStore(db);
    const server = buildAgentEmailMcp({ agentId: 'alice', secrets: new SecretStore(db), approvals, conversationId: null });
    const res = await call(server, approvals, 'send_email', EMAIL, 'not today');
    assert.equal(res.isError, true);
    assert.deepEqual(res.content, [{ type: 'text', text: EMAIL_REJECTED }]);
  });

  it('post_tweet and post_linkedin return error results with the same text', async () => {
    const db = openDatabase(':memory:');
    const approvals = new ApprovalStore(db);
    const server = buildAgentSocialMcp({ agentId: 'alice', secrets: new SecretStore(db), approvals, conversationId: null });
    const tweet = await call(server, approvals, 'post_tweet', { text: 'Hello.' }, 'not today');
    assert.equal(tweet.isError, true);
    assert.deepEqual(tweet.content, [{ type: 'text', text: 'Operator rejected this post: not today' }]);
    const linkedin = await call(buildAgentSocialMcp({ agentId: 'alice', secrets: new SecretStore(db), approvals, conversationId: null }),
      approvals, 'post_linkedin', { text: 'Hello.' }, 'not today');
    assert.equal(linkedin.isError, true);
    assert.deepEqual(linkedin.content, [{ type: 'text', text: 'Operator rejected this LinkedIn post: not today' }]);
  });

  it('an escalated ask_agent returns an error result with the same text', async () => {
    const db = openDatabase(':memory:');
    const approvals = new ApprovalStore(db);
    const { asked, host } = peer();
    const server = buildAgentCommsMcp('alice', { host, defStore, conversations: new SqliteConversationStore(db) },
      { agentId: 'alice', conversationId: null, gatedTools: [], approvals });
    const res = await call(server, approvals, 'ask_agent', ASK, 'not now');
    assert.equal(res.isError, true);
    assert.deepEqual(res.content, [{ type: 'text', text: ASK_REJECTED }]);
    assert.deepEqual(asked, [], 'the peer never hears of it');
  });
});
