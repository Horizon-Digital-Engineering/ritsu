import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { SqliteMemoryStore } from '../memory-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { GenericAgent } from '../agents/generic.js';
import { STOPPED_MARK, storedReply } from '../agents/base.js';
import { conversationBus, type ConversationEvent } from '../conversation-bus.js';
import { stopTurns, runningTurns } from '../turns.js';
import { TurnRecorder, type ChatRequest, type ChatResponse, type ModelDispatcher } from '../model/dispatcher.js';
import type { AgentDefinition } from '../admin/schema.js';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function def(id: string): AgentDefinition {
  return {
    id, type: 'generic', name: id, description: 'test agent', system_prompt: 'be brief',
    runtime: 'api', provider: 'custom', model: 'fake-model', memory_backend: 'sqlite',
    tools_allowlist: [], can_call: [], api_key_ref: null, provider_options: {}, capabilities: [],
    approval_tools: [], plugins: [], enabled: true, escalation_approvable: false, allow_monitor_read: false,
  };
}

function dispatcher(chat: (req: ChatRequest) => Promise<ChatResponse>): ModelDispatcher {
  return { kind: 'ritsu-agent', defaultModel: 'fake-model', chat };
}

async function toolTurn(req: ChatRequest): Promise<ChatResponse> {
  const turn = new TurnRecorder(req.onEvent);
  turn.write('Let me look.');
  turn.toolStart('t1', 'mcp__demo__echo', { msg: 'hi' });
  await sleep(1);
  turn.toolEnd('t1', 'echo hi', false);
  turn.write('Found it.');
  return { content: 'Found it.', model: 'fake-model', raw: null, tool_calls: turn.finish('no result') };
}

function stoppableTurn(text: string) {
  return (req: ChatRequest): Promise<ChatResponse> => new Promise(resolve => {
    const turn = new TurnRecorder(req.onEvent);
    if (text) turn.write(text);
    turn.toolStart('t1', 'mcp__demo__slow', {});
    const stop = (): void => {
      resolve({ content: turn.text, model: 'fake-model', raw: null, tool_calls: turn.finish('stopped'), stopped: true });
    };
    if (req.signal?.aborted) stop();
    else req.signal?.addEventListener('abort', stop, { once: true });
  });
}

describe('AgentBase turns', () => {
  let conversations: SqliteConversationStore;
  let memory: SqliteMemoryStore;
  let bus: ConversationEvent[];
  const onBus = (e: ConversationEvent): void => { bus.push(e); };

  beforeEach(() => {
    const db = openDatabase(':memory:');
    conversations = new SqliteConversationStore(db);
    memory = new SqliteMemoryStore(db);
    bus = [];
    conversationBus.on('event', onBus);
  });
  afterEach(() => { conversationBus.off('event', onBus); });

  const agent = (chat: (req: ChatRequest) => Promise<ChatResponse>, id = 'alice') =>
    new GenericAgent(def(id), { memory, conversations, dispatcher: dispatcher(chat) });
  const kinds = (cid: number): string[] => bus.filter(e => e.conversation_id === cid).map(e =>
    e.kind === 'message' ? `message:${e.role}` : e.kind === 'tool' ? `tool:${e.call.status}` : e.kind);
  const midTurn = async (cid: number): Promise<void> => {
    for (let i = 0; i < 200 && !kinds(cid).includes('tool:running'); i++) await sleep(2);
    assert.ok(kinds(cid).includes('tool:running'));
  };

  it('publishes ask-start, the live progress, the reply, then ask-end, and stores the tool calls', async () => {
    const a = agent(toolTurn);
    const r = await a.onMessage({ message: 'find it', caller_label: 'admin-ui' });
    assert.equal(r.reply, 'Let me look.\n\nFound it.', 'text written before the tool call stays in the answer');
    assert.equal(r.stopped, undefined);
    assert.deepEqual(kinds(r.conversation_id), [
      'message:user', 'ask-start', 'delta', 'tool:running', 'tool:done', 'delta', 'delta', 'message:assistant', 'ask-end',
    ]);
    const deltas = bus.flatMap(e => (e.kind === 'delta' ? [e.text] : []));
    assert.equal(deltas.join(''), 'Let me look.\n\nFound it.');
    for (const e of bus) assert.equal(e.agent_id, 'alice');
    const rows = conversations.recent(r.conversation_id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].tool_calls, undefined);
    assert.deepEqual(rows[1].tool_calls, [
      { id: 't1', name: 'mcp__demo__echo', args: '{"msg":"hi"}', status: 'done', result: 'echo hi' },
    ]);
    assert.equal(runningTurns(r.conversation_id), 0);
  });

  it('the turn passes a signal and the bus events name the agent\'s own thread', async () => {
    const other = conversations.start('bob');
    let seen: ChatRequest | undefined;
    const a = agent(async (req) => { seen = req; return { content: 'ok', model: 'fake-model', raw: null }; });
    const r = await a.onMessage({ message: 'hi', conversation_id: other });
    assert.notEqual(r.conversation_id, other, 'a foreign conversation is not honored');
    assert.ok(seen?.signal instanceof AbortSignal);
    assert.equal(typeof seen?.onEvent, 'function');
    assert.deepEqual(kinds(other), []);
    assert.deepEqual(kinds(r.conversation_id), ['message:user', 'ask-start', 'message:assistant', 'ask-end']);
  });

  it('a stopped turn stores the partial text marked stopped, with its calls', async () => {
    const a = agent(stoppableTurn('Half an ans'));
    const cid = conversations.findOrStartHumanThread('alice');
    const run = a.onMessage({ message: 'go', conversation_id: cid });
    await midTurn(cid);
    assert.equal(stopTurns(cid), 1);
    const r = await run;
    assert.equal(r.stopped, true);
    assert.equal(r.reply, `Half an ans\n\n${STOPPED_MARK}`);
    const last = conversations.recent(cid).at(-1);
    assert.equal(last?.content, `Half an ans\n\n${STOPPED_MARK}`);
    assert.deepEqual(last?.tool_calls, [{ id: 't1', name: 'mcp__demo__slow', args: '{}', status: 'error', result: 'stopped' }]);
    assert.deepEqual(kinds(cid).slice(-2), ['message:assistant', 'ask-end']);
    assert.equal(runningTurns(cid), 0);
  });

  it('a turn stopped before writing anything stores just the marker; a caller signal also stops it', async () => {
    const a = agent(stoppableTurn(''));
    const ctl = new AbortController();
    const run = a.onMessage({ message: 'go', signal: ctl.signal });
    await midTurn(conversations.findOrStartHumanThread('alice'));
    ctl.abort();
    const r = await run;
    assert.equal(r.reply, STOPPED_MARK);
    assert.equal(conversations.recent(r.conversation_id).at(-1)?.content, STOPPED_MARK);
  });

  it('ask-end fires when the turn fails, and nothing is stored for the reply', async () => {
    const a = agent(async (req) => {
      req.onEvent?.({ type: 'text', delta: 'Start' });
      throw new Error('provider down');
    });
    const cid = conversations.findOrStartHumanThread('alice');
    await assert.rejects(a.onMessage({ message: 'go', conversation_id: cid }), /provider down/);
    assert.deepEqual(kinds(cid), ['message:user', 'ask-start', 'delta', 'ask-end']);
    assert.equal(conversations.recent(cid).length, 1);
    assert.equal(runningTurns(cid), 0);
  });

  it('regenerate is a live, stoppable turn that stores a sibling with its calls', async () => {
    let script: (req: ChatRequest) => Promise<ChatResponse> = toolTurn;
    const a = agent(req => script(req));
    const first = await a.onMessage({ message: 'find it' });
    const cid = first.conversation_id;
    const original = conversations.recent(cid).at(-1);
    assert.ok(original?.id);
    bus.length = 0;

    const again = await a.regenerate(cid, original.id);
    assert.equal(again.content, 'Let me look.\n\nFound it.');
    assert.deepEqual(kinds(cid), [
      'ask-start', 'delta', 'tool:running', 'tool:done', 'delta', 'delta', 'message:assistant', 'ask-end',
    ]);
    const sibling = conversations.recent(cid).find(m => m.id === again.message_id);
    assert.equal(sibling?.parent_message_id, original.parent_message_id);
    assert.equal(sibling?.tool_calls?.length, 1);

    script = stoppableTurn('Another tak');
    bus.length = 0;
    const run = a.regenerate(cid, original.id);
    await midTurn(cid);
    assert.equal(stopTurns(cid), 1);
    const stopped = await run;
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.content, `Another tak\n\n${STOPPED_MARK}`);
  });

  it('a stop that lands before the runtime starts still ends the turn as stopped', async () => {
    const a = agent(stoppableTurn('never shown'));
    const cid = conversations.findOrStartHumanThread('alice');
    const run = a.onMessage({ message: 'go', conversation_id: cid });
    assert.equal(stopTurns(cid), 1, 'registered from ask-start on');
    const r = await run;
    assert.equal(r.stopped, true);
  });

  it('regenerate refuses a bad target before any turn starts', async () => {
    const a = agent(toolTurn);
    const cid = conversations.findOrStartHumanThread('alice');
    await assert.rejects(a.regenerate(cid, 999), /no such assistant message/);
    assert.deepEqual(kinds(cid), []);
  });
});

describe('storedReply', () => {
  it('keeps everything that streamed, whitespace trimmed', () => {
    assert.equal(storedReply({ content: 'Found it.' }, 'Let me look.\n\nFound it.\n'), 'Let me look.\n\nFound it.');
  });
  it('keeps a final text the stream never carried after what did stream', () => {
    assert.equal(storedReply({ content: '(loop stopped after 25 rounds)' }, 'Checking.'), 'Checking.\n\n(loop stopped after 25 rounds)');
  });
  it('falls back to the final text when nothing streamed', () => {
    assert.equal(storedReply({ content: 'Plain answer.' }), 'Plain answer.');
    assert.equal(storedReply({ content: 'Plain answer.' }, '  '), 'Plain answer.');
  });
  it('marks a stopped turn, with or without text', () => {
    assert.equal(storedReply({ content: 'Half', stopped: true }, 'Half'), `Half\n\n${STOPPED_MARK}`);
    assert.equal(storedReply({ content: '', stopped: true }, ''), STOPPED_MARK);
  });
});
