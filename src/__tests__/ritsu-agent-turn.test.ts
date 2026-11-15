import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ApiKeyStore } from '../auth/api-key-store.js';
import { ApprovalStore } from '../approval-store.js';
import { SqliteMemoryStore } from '../memory-store.js';
import { SqliteAgentDefinitionStore } from '../agent-definition-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { RitsuAgentDispatcher } from '../model/ritsu-agent/dispatcher.js';
import type { RaChatOptions, RaClient, RaCompletion, RaMessage, RaToolCall } from '../model/ritsu-agent/types.js';
import type { ChatResponse, TurnEvent } from '../model/dispatcher.js';
import type { PluginToolDef } from '../plugins/types.js';
import { STOPPED_APPROVAL_REASON } from '../turns.js';

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
process.on('unhandledRejection', onUnhandled);
after(() => {
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, [], 'no promise rejection went unhandled');
});

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

type Step = (messages: RaMessage[], opts: RaChatOptions | undefined) => Promise<RaCompletion>;

function scripted(steps: Step[]): RaClient & { seen: Array<RaChatOptions | undefined> } {
  let i = 0;
  const seen: Array<RaChatOptions | undefined> = [];
  return {
    seen,
    chat(messages, _tools, opts) {
      seen.push(opts);
      const step = steps[i++];
      if (!step) return Promise.reject(new Error('script exhausted'));
      return step(messages, opts);
    },
  };
}

const done = (content: string, tool_calls: RaToolCall[] = []): RaCompletion =>
  ({ content, tool_calls, model: 'fake-model', usage: { prompt_tokens: 3, completion_tokens: 2 }, raw: null });
const callOf = (id: string, name: string, args: unknown): RaToolCall =>
  ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });

const streams = (parts: string[], tool_calls: RaToolCall[] = []): Step => async (_m, opts) => {
  for (const p of parts) opts?.onText?.(p);
  return done(parts.join(''), tool_calls);
};

/** Rejects on the stop, as a streaming client does. */
const streamsUntilStopped = (parts: string[]): Step => (_m, opts) => new Promise((_, reject) => {
  for (const p of parts) opts?.onText?.(p);
  opts?.signal?.addEventListener('abort', () => reject(new Error('request aborted')));
});

const tool = (name: string, handler: PluginToolDef['handler']): PluginToolDef =>
  ({ name, description: name, input: {}, handler });

function setup(steps: Step[], opts: { gated?: string[]; tools?: PluginToolDef[] } = {}) {
  const db = openDatabase(':memory:');
  const approvals = new ApprovalStore(db);
  const client = scripted(steps);
  const toolDeps = {
    agentId: 'alice',
    memory: new SqliteMemoryStore(db),
    defStore: new SqliteAgentDefinitionStore(db),
    conversations: new SqliteConversationStore(db),
    host: { get: () => ({ onMessage: async () => ({ reply: '', conversation_id: 0 }) }) },
    plugins: [{ id: 'demo', tools: opts.tools ?? [] }],
  };
  const d = new RitsuAgentDispatcher({
    provider: 'custom', apiKeyRef: null, apiKeys: new ApiKeyStore(db), defaultModel: 'fake-model',
    toolDeps, client,
    ...(opts.gated ? { approval: { agentId: 'alice', store: approvals, gatedTools: opts.gated } } : {}),
  });
  const events: TurnEvent[] = [];
  const onEvent = (e: TurnEvent): void => { events.push(e); };
  return { d, client, approvals, events, onEvent };
}

const texts = (events: TurnEvent[]): string[] => events.flatMap(e => (e.type === 'text' ? [e.delta] : []));
const statuses = (events: TurnEvent[]): string[] =>
  events.flatMap(e => (e.type === 'tool' ? [`${e.call.id}:${e.call.status}`] : []));

const ECHO = tool('echo', (args) => ({ content: [{ type: 'text', text: `echo ${String(args.msg)}` }] }));
const BOOM = tool('boom', () => { throw new Error('kaput'); });

describe('RitsuAgentDispatcher turn events', () => {
  it('streams deltas, reports each tool start and end, and returns the calls', async () => {
    const { d, client, events, onEvent } = setup([
      streams(['Looking ', 'it up.'], [callOf('c1', 'mcp__demo__echo', { msg: 'hi' }), callOf('c2', 'mcp__demo__boom', {})]),
      streams(['All ', 'done.']),
    ], { tools: [ECHO, BOOM] });
    const ctl = new AbortController();
    const r = await d.chat({ messages: [{ role: 'user', content: 'go' }], onEvent, signal: ctl.signal });
    assert.equal(r.content, 'All done.');
    assert.equal(r.stopped, undefined);
    assert.deepEqual(texts(events), ['Looking ', 'it up.', '\n\n', 'All ', 'done.']);
    const tools = statuses(events);
    assert.deepEqual(tools.slice(0, 2), ['c1:running', 'c2:running'], 'calls start in call order');
    assert.deepEqual(tools.slice(2).sort(), ['c1:done', 'c2:error'], 'and end as each one settles');
    assert.deepEqual(r.tool_calls, [
      { id: 'c1', name: 'mcp__demo__echo', args: '{"msg":"hi"}', status: 'done', result: 'echo hi' },
      { id: 'c2', name: 'mcp__demo__boom', args: '{}', status: 'error', result: 'error: kaput' },
    ]);
    assert.equal(client.seen[0]?.signal, ctl.signal, 'the client gets the turn signal');
    assert.equal(typeof client.seen[0]?.onText, 'function');
  });

  it('marks an unknown tool and malformed arguments as errors', async () => {
    const { d, events, onEvent } = setup([
      streams([], [callOf('c1', 'nope', {}), callOf('c2', 'mcp__demo__echo', '{not json')]),
      streams(['ok']),
    ], { tools: [ECHO] });
    const r = await d.chat({ messages: [{ role: 'user', content: 'go' }], onEvent });
    assert.deepEqual(statuses(events).sort(), ['c1:error', 'c1:running', 'c2:error', 'c2:running']);
    assert.match(r.tool_calls?.[0].result ?? '', /not available/);
    assert.match(r.tool_calls?.[1].result ?? '', /invalid tool arguments JSON/);
    assert.equal(r.tool_calls?.[1].args, '{not json');
  });

  it('an operator rejection at the gate is an error carrying the reason', async () => {
    let ran = false;
    const { d, approvals, events, onEvent } = setup([
      streams([], [callOf('c1', 'mcp__demo__send', { to: 'someone' })]),
      streams(['Understood.']),
    ], { gated: ['mcp__demo__send'], tools: [tool('send', () => { ran = true; return { content: [{ type: 'text', text: 'sent' }] }; })] });
    const p = d.chat({ messages: [{ role: 'user', content: 'send it' }], conversation_id: 3, onEvent });
    for (let i = 0; i < 100 && approvals.pendingCount() === 0; i++) await sleep(5);
    assert.deepEqual(statuses(events), ['c1:running'], 'running while the card waits');
    approvals.decide(approvals.listPending()[0].id, 'rejected', 'not today', 'test');
    const r = await p;
    assert.equal(ran, false);
    assert.deepEqual(r.tool_calls?.[0], {
      id: 'c1', name: 'mcp__demo__send', args: '{"to":"someone"}', status: 'error',
      result: 'Operator rejected this mcp__demo__send call: not today',
    });
  });

  it('shows the text of a round whose client delivered no deltas', async () => {
    const { d, events, onEvent } = setup([
      () => Promise.resolve(done('Checking.', [callOf('c1', 'mcp__demo__echo', { msg: 'x' })])),
      () => Promise.resolve(done('Done.')),
    ], { tools: [ECHO] });
    await d.chat({ messages: [{ role: 'user', content: 'go' }], onEvent });
    assert.deepEqual(texts(events), ['Checking.', '\n\n', 'Done.']);
  });

  it('keeps call ids unique when a provider repeats them across rounds', async () => {
    const { d, onEvent } = setup([
      streams([], [callOf('call_0', 'mcp__demo__echo', { msg: 'a' })]),
      streams([], [callOf('call_0', 'mcp__demo__echo', { msg: 'b' })]),
      streams(['two echoes']),
    ], { tools: [ECHO] });
    const r = await d.chat({ messages: [{ role: 'user', content: 'go' }], onEvent });
    assert.deepEqual(r.tool_calls?.map(c => `${c.id}=${c.result}`), ['call_0=echo a', 'call_0#2=echo b']);
  });
});

describe('RitsuAgentDispatcher stop', () => {
  async function stopWhen(
    run: Promise<ChatResponse>, ctl: AbortController, ready: () => boolean,
  ): Promise<{ r: ChatResponse; ms: number }> {
    for (let i = 0; i < 200 && !ready(); i++) await sleep(5);
    assert.ok(ready(), 'the turn reached the point to stop it');
    const t0 = Date.now();
    ctl.abort();
    const r = await run;
    return { r, ms: Date.now() - t0 };
  }

  it('a stop mid-stream returns the text so far', async () => {
    const { d, events, onEvent } = setup([streamsUntilStopped(['Partial ', 'answer'])]);
    const ctl = new AbortController();
    const run = d.chat({ messages: [{ role: 'user', content: 'go' }], onEvent, signal: ctl.signal });
    const { r, ms } = await stopWhen(run, ctl, () => texts(events).length === 2);
    assert.ok(ms < 100, `returned promptly (${ms} ms)`);
    assert.equal(r.stopped, true);
    assert.equal(r.content, 'Partial answer');
    assert.deepEqual(r.tool_calls, []);
  });

  it('a stop while a tool runs marks it stopped and starts no new round', async () => {
    let release: () => void = () => undefined;
    const slow = tool('slow', () => new Promise(res => { release = () => res({ content: [{ type: 'text', text: 'late' }] }); }));
    const { d, client, events, onEvent } = setup([
      streams(['Working.'], [callOf('c1', 'mcp__demo__slow', {})]),
      streams(['never']),
    ], { tools: [slow] });
    const ctl = new AbortController();
    const run = d.chat({ messages: [{ role: 'user', content: 'go' }], onEvent, signal: ctl.signal });
    const { r } = await stopWhen(run, ctl, () => statuses(events).length === 1);
    assert.equal(r.stopped, true);
    assert.equal(r.content, 'Working.');
    assert.deepEqual(r.tool_calls, [{ id: 'c1', name: 'mcp__demo__slow', args: '{}', status: 'error', result: 'stopped' }]);
    const count = events.length;
    release();
    await sleep(20);
    assert.equal(events.length, count, 'the late result is not published');
    assert.equal(client.seen.length, 1);
  });

  it('a stop while a call waits on approval returns promptly and closes the card', async () => {
    let ran = false;
    const { d, approvals, onEvent } = setup([
      streams(['Asking first.'], [callOf('c1', 'mcp__demo__send', {})]),
      streams(['never']),
    ], { gated: ['mcp__demo__send'], tools: [tool('send', () => { ran = true; return { content: [{ type: 'text', text: 'sent' }] }; })] });
    const ctl = new AbortController();
    const run = d.chat({ messages: [{ role: 'user', content: 'go' }], conversation_id: 8, onEvent, signal: ctl.signal });
    const { r, ms } = await stopWhen(run, ctl, () => approvals.pendingCount() === 1);
    assert.ok(ms < 100, `returned promptly (${ms} ms)`);
    assert.equal(r.stopped, true);
    assert.equal(r.tool_calls?.[0].status, 'error');
    assert.equal(r.tool_calls?.[0].result, 'stopped');
    assert.equal(approvals.pendingCount(), 0, 'no orphan card');
    assert.equal(approvals.listDecided()[0].reason, STOPPED_APPROVAL_REASON);
    await sleep(10);
    assert.equal(ran, false, 'the gated tool never runs');
  });

  it('a stop before the first round never calls the model', async () => {
    const { d, client } = setup([streams(['never'])]);
    const r = await d.chat({ messages: [{ role: 'user', content: 'go' }], signal: AbortSignal.abort() });
    assert.equal(r.stopped, true);
    assert.equal(r.content, '');
    assert.equal(client.seen.length, 0);
  });
});
