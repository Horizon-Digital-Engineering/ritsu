import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../db.js';
import { ApiKeyStore } from '../auth/api-key-store.js';
import { RitsuAgentDispatcher } from '../model/ritsu-agent/dispatcher.js';
import { ApprovalStore } from '../approval-store.js';
import { SqliteMemoryStore } from '../memory-store.js';
import { SqliteAgentDefinitionStore } from '../agent-definition-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';

/** Minimal RaToolDeps wiring the memory + comms built-ins against one DB. */
function makeToolDeps(db: ReturnType<typeof openDatabase>, agentId = 'a') {
  return {
    agentId,
    memory: new SqliteMemoryStore(db),
    defStore: new SqliteAgentDefinitionStore(db),
    conversations: new SqliteConversationStore(db),
    host: { get: () => ({ onMessage: async () => ({ reply: '', conversation_id: 0 }) }) },
  };
}

/** Spin until the predicate holds or we give up (the gated chat() runs
 *  concurrently; the pending approval appears a few microtasks in). */
async function waitFor(pred: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) await new Promise(r => setTimeout(r, 5));
}

/** Build a fake fetch that returns a queued series of OpenAI-shape
 *  responses. Each call dequeues one. */
function makeFetchQueue(responses: unknown[]): typeof fetch {
  let i = 0;
  return (async (_url: unknown, _init: unknown) => {
    const body = responses[i++];
    if (!body) throw new Error('fetch queue exhausted');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
  });
}

function textOnly(content: string) {
  return {
    id: 'r1', model: 'gpt-test',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function toolCalls(calls: Array<{ id: string; name: string; args: unknown }>) {
  return {
    id: 'r2', model: 'gpt-test',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: calls.map(c => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  };
}

describe('RitsuAgentDispatcher', () => {
  let apiKeys: ApiKeyStore;
  let keyId: number;

  beforeEach(() => {
    process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
    apiKeys = new ApiKeyStore(openDatabase(':memory:'));
    keyId = apiKeys.mint('test-key', 'openai', 'sk-test-12345').id;
  });

  it('text-only round: assistant content flows through to ChatResponse', async () => {
    const d = new RitsuAgentDispatcher({
      provider: 'openai', apiKeyRef: keyId, apiKeys,
      defaultModel: 'gpt-test', toolDeps: null,
      fetchImpl: makeFetchQueue([textOnly('hello world')]),
    });
    const r = await d.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.content, 'hello world');
    assert.equal(r.model, 'gpt-test');
    assert.equal(r.usage?.input_tokens, 10);
    assert.equal(r.usage?.output_tokens, 5);
  });

  it('one tool round: dispatcher runs the tool + sends result back + returns final text', async () => {
    let toolRan = false;
    const d = new RitsuAgentDispatcher({
      provider: 'openai', apiKeyRef: keyId, apiKeys,
      defaultModel: 'gpt-test', toolDeps: null,
      fetchImpl: makeFetchQueue([
        toolCalls([{ id: 'c1', name: 'echo', args: { msg: 'hi' } }]),
        textOnly('done'),
      ]),
    });
    // Manually inject a tool by reaching into the dispatcher? No — we
    // exercise the loop end-to-end by stubbing the provider so the
    // dispatcher SEES a tool call but the real tools (no toolDeps) report
    // "tool not available". Then the second response wraps up.
    const r = await d.chat({ messages: [{ role: 'user', content: 'echo hi' }] });
    assert.equal(r.content, 'done');
    // Token usage accumulates across rounds.
    assert.equal(r.usage?.input_tokens, 22);
    assert.equal(r.usage?.output_tokens, 13);
    void toolRan;
  });

  it('unknown tool returns error string to model (not throw)', async () => {
    // Two rounds: first asks for a tool we don't have; second returns final text.
    // The dispatcher's runTool returns `error: tool "X" not available`; the
    // model sees it in the next round and produces a final answer.
    const d = new RitsuAgentDispatcher({
      provider: 'openai', apiKeyRef: keyId, apiKeys,
      defaultModel: 'gpt-test', toolDeps: null,
      fetchImpl: makeFetchQueue([
        toolCalls([{ id: 'c1', name: 'unknown_tool', args: {} }]),
        textOnly('I could not call that tool; here is what I know.'),
      ]),
    });
    const r = await d.chat({ messages: [{ role: 'user', content: 'try a thing' }] });
    assert.ok((r.content).includes('could not call'));
  });

  it('invalid JSON arguments produces an error string the model can react to', async () => {
    // Force the dispatcher to see malformed JSON in arguments by passing a
    // raw response that bypasses our toolCalls() helper (which always
    // JSON.stringifies). Two rounds: bad-args, then final.
    const badArgsResp = {
      id: 'r', model: 'gpt-test',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'whatever', arguments: '{not-json' } }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const d = new RitsuAgentDispatcher({
      provider: 'openai', apiKeyRef: keyId, apiKeys,
      defaultModel: 'gpt-test', toolDeps: null,
      fetchImpl: makeFetchQueue([badArgsResp, textOnly('ok recovered')]),
    });
    const r = await d.chat({ messages: [{ role: 'user', content: 'go' }] });
    assert.equal(r.content, 'ok recovered');
  });

  it('throws when api_key_ref is missing or revoked', async () => {
    apiKeys.revoke(keyId);
    const d = new RitsuAgentDispatcher({
      provider: 'openai', apiKeyRef: keyId, apiKeys,
      defaultModel: 'gpt-test', toolDeps: null,
      fetchImpl: makeFetchQueue([textOnly('never reached')]),
    });
    await assert.rejects(d.chat({ messages: [{ role: 'user', content: 'hi' }] }), /not found or revoked/);
  });

  it('tool-cap (MAX_TOOL_ROUNDS) returns the loop-exceeded message', async () => {
    // Queue 9 rounds — all tool_calls, never a text-only finish.
    const responses = Array.from({ length: 9 }, () => toolCalls([{ id: 'cx', name: 'unknown', args: {} }]));
    const d = new RitsuAgentDispatcher({
      provider: 'openai', apiKeyRef: keyId, apiKeys,
      defaultModel: 'gpt-test', toolDeps: null,
      fetchImpl: makeFetchQueue(responses),
    });
    const r = await d.chat({ messages: [{ role: 'user', content: 'loop' }] });
    assert.match(r.content, /tool-call loop exceeded/);
  });

  it('approval gate: a gated tool BLOCKS until approved, then runs', async () => {
    const db = openDatabase(':memory:');
    const deps = makeToolDeps(db);
    const approvals = new ApprovalStore(db);
    const d = new RitsuAgentDispatcher({
      provider: 'openai', apiKeyRef: keyId, apiKeys, defaultModel: 'gpt-test',
      toolDeps: deps,
      approval: { agentId: 'a', store: approvals, gatedTools: ['memory_remember'] },
      fetchImpl: makeFetchQueue([
        toolCalls([{ id: 'c1', name: 'memory_remember', args: { content: 'a gated fact' } }]),
        textOnly('saved it'),
      ]),
    });
    // Run the turn concurrently — it will block inside runTool on the gate.
    const chatP = d.chat({ messages: [{ role: 'user', content: 'remember a gated fact' }], conversation_id: 7 });
    await waitFor(() => approvals.pendingCount() === 1);
    assert.equal(approvals.pendingCount(), 1);
    const pending = approvals.listPending()[0];
    assert.equal(pending.tool_name, 'memory_remember');
    assert.equal(pending.conversation_id, 7);
    // The tool has NOT run yet — nothing written while blocked.
    assert.equal((await deps.memory.list('a', 10)).length, 0);
    // Approve → the turn resumes and the tool finally executes.
    approvals.decide(pending.id, 'approved', null, 'test');
    const r = await chatP;
    assert.equal(r.content, 'saved it');
    assert.equal((await deps.memory.list('a', 10)).length, 1);
  });

  it('approval gate: reject returns the reason to the model + the tool never runs', async () => {
    const db = openDatabase(':memory:');
    const deps = makeToolDeps(db);
    const approvals = new ApprovalStore(db);
    const d = new RitsuAgentDispatcher({
      provider: 'openai', apiKeyRef: keyId, apiKeys, defaultModel: 'gpt-test',
      toolDeps: deps,
      approval: { agentId: 'a', store: approvals, gatedTools: ['memory_remember'] },
      fetchImpl: makeFetchQueue([
        toolCalls([{ id: 'c1', name: 'memory_remember', args: { content: 'should not persist' } }]),
        textOnly('understood, skipping'),
      ]),
    });
    const chatP = d.chat({ messages: [{ role: 'user', content: 'remember something' }], conversation_id: 9 });
    await waitFor(() => approvals.pendingCount() === 1);
    const pending = approvals.listPending()[0];
    approvals.decide(pending.id, 'rejected', 'not allowed', 'test');
    const r = await chatP;
    assert.equal(r.content, 'understood, skipping');
    // The tool did NOT run — memory stays empty even though the model asked.
    assert.equal((await deps.memory.list('a', 10)).length, 0);
  });
});
