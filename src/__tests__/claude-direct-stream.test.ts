import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeDirectDispatcher, SdkTurnFeed, sdkProgress } from '../model/claude-direct-dispatcher.js';
import { TurnRecorder, type ToolActivity, type TurnEvent } from '../model/dispatcher.js';
import { openDatabase } from '../db.js';
import { ApprovalStore } from '../approval-store.js';
import { STOPPED_APPROVAL_REASON } from '../turns.js';
import type { Workspace } from '../workspace-store.js';

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
process.on('unhandledRejection', onUnhandled);
after(() => {
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, [], 'no promise rejection went unhandled');
});

const SESSION = 'session-for-the-test';
const MODEL = 'claude-sonnet-4-6';
let seq = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// Shapes as the SDK emits them with includePartialMessages: one stream_event per
// Messages API streaming event, one assistant message per completed block, one
// user message per tool result. parent_tool_use_id is set inside a subagent.
const stream = (event: object, parent: string | null = null) =>
  ({ type: 'stream_event', event, parent_tool_use_id: parent, uuid: uuid(), session_id: SESSION });
const messageStart = (id: string) => stream({
  type: 'message_start',
  message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } },
});
const textDelta = (text: string, index = 0, parent: string | null = null) =>
  stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }, parent);
const assistant = (block: object, parent: string | null = null) => ({
  type: 'assistant',
  message: { id: 'msg_x', type: 'message', role: 'assistant', model: MODEL, content: [block], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 5 } },
  parent_tool_use_id: parent, uuid: uuid(), session_id: SESSION,
});
const toolResult = (tool_use_id: string, content: unknown, isError = false, parent: string | null = null) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content, ...(isError ? { is_error: true } : {}) }] },
  parent_tool_use_id: parent, uuid: uuid(), session_id: SESSION, tool_use_result: { stdout: '' },
});
const success = (result: string) => ({
  type: 'result', subtype: 'success', is_error: false, result, num_turns: 3, duration_ms: 900, duration_api_ms: 800,
  total_cost_usd: 0, usage: { input_tokens: 40, output_tokens: 22 }, session_id: SESSION, uuid: uuid(),
});

function recordedTurn(): unknown[] {
  return [
    { type: 'system', subtype: 'init', session_id: SESSION, model: MODEL, tools: ['Bash', 'Task'], uuid: uuid() },
    messageStart('msg_1'),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    textDelta('Let me '),
    textDelta('check.'),
    stream({ type: 'content_block_stop', index: 0 }),
    assistant({ type: 'text', text: 'Let me check.' }),
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'mcp__finance__get_balances', input: {} } }),
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"account":"all"}' } }),
    stream({ type: 'content_block_stop', index: 1 }),
    assistant({ type: 'tool_use', id: 'toolu_01', name: 'mcp__finance__get_balances', input: { account: 'all' } }),
    stream({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } }),
    stream({ type: 'message_stop' }),
    toolResult('toolu_01', [{ type: 'text', text: '{"total":12}' }]),
    messageStart('msg_2'),
    assistant({ type: 'tool_use', id: 'toolu_02', name: 'Task', input: { description: 'look around', prompt: 'list the files' } }),
    assistant({ type: 'tool_use', id: 'toolu_03', name: 'Bash', input: { command: 'false' } }),
    textDelta('subagent text', 0, 'toolu_02'),
    assistant({ type: 'text', text: 'subagent text' }, 'toolu_02'),
    assistant({ type: 'tool_use', id: 'toolu_sub', name: 'Glob', input: { pattern: '*' } }, 'toolu_02'),
    toolResult('toolu_sub', 'a.txt', false, 'toolu_02'),
    toolResult('toolu_03', 'Exit code 1', true),
    toolResult('toolu_02', [{ type: 'text', text: 'Found a.txt' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }]),
    messageStart('msg_3'),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'adding up' } }),
    assistant({ type: 'thinking', thinking: 'adding up', signature: 'sig' }),
    textDelta('You have ', 1),
    textDelta('12.', 1),
    assistant({ type: 'text', text: 'You have 12.' }),
    success('You have 12.'),
  ];
}

const EXPECTED_CALLS: ToolActivity[] = [
  { id: 'toolu_01', name: 'mcp__finance__get_balances', args: '{"account":"all"}', status: 'done', result: '{"total":12}' },
  { id: 'toolu_02', name: 'Task', args: '{"description":"look around","prompt":"list the files"}', status: 'done', result: 'Found a.txt\n[image]' },
  { id: 'toolu_03', name: 'Bash', args: '{"command":"false"}', status: 'error', result: 'Exit code 1' },
];

function feedAll(events: unknown[]): { turn: TurnRecorder; seen: TurnEvent[] } {
  const seen: TurnEvent[] = [];
  const turn = new TurnRecorder(e => seen.push(e));
  const feed = new SdkTurnFeed(turn);
  for (const e of events) feed.push(e);
  return { turn, seen };
}

describe('sdkProgress', () => {
  it('maps text deltas, tool_use and tool_result; other partial frames are just "stream"', () => {
    assert.deepEqual(sdkProgress(textDelta('hi')), [{ kind: 'text', text: 'hi' }]);
    assert.deepEqual(sdkProgress(stream({ type: 'message_stop' })), [{ kind: 'stream' }]);
    assert.deepEqual(
      sdkProgress(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x' } })),
      [{ kind: 'stream' }],
    );
    assert.deepEqual(sdkProgress(assistant({ type: 'tool_use', id: 'toolu_9', name: 'Read', input: { file_path: '/a' } })),
      [{ kind: 'tool-start', id: 'toolu_9', name: 'Read', input: { file_path: '/a' } }]);
    assert.deepEqual(sdkProgress(toolResult('toolu_9', 'contents')),
      [{ kind: 'tool-end', id: 'toolu_9', result: 'contents', isError: false }]);
    assert.deepEqual(sdkProgress(toolResult('toolu_9', [{ type: 'text', text: 'denied' }], true)),
      [{ kind: 'tool-end', id: 'toolu_9', result: 'denied', isError: true }]);
  });

  it('ignores subagent frames, results, system events and malformed input', () => {
    assert.deepEqual(sdkProgress(textDelta('x', 0, 'toolu_02')), []);
    assert.deepEqual(sdkProgress(assistant({ type: 'tool_use', id: 'a', name: 'Glob', input: {} }, 'toolu_02')), []);
    assert.deepEqual(sdkProgress(success('done')), []);
    assert.deepEqual(sdkProgress({ type: 'system', subtype: 'init' }), []);
    assert.deepEqual(sdkProgress(null), []);
    assert.deepEqual(sdkProgress({ type: 'assistant', message: { content: 'not blocks' } }), []);
    assert.deepEqual(sdkProgress({ type: 'user', message: { role: 'user', content: 'a plain prompt' }, parent_tool_use_id: null }), []);
  });
});

describe('SdkTurnFeed', () => {
  it('streams a recorded turn: deltas across rounds with a break, tool statuses, no subagent noise', () => {
    const { turn, seen } = feedAll(recordedTurn());
    const text = seen.flatMap(e => (e.type === 'text' ? [e.delta] : []));
    assert.deepEqual(text, ['Let me ', 'check.', '\n\n', 'You have ', '12.']);
    const tools = seen.flatMap(e => (e.type === 'tool' ? [`${e.call.id}:${e.call.status}`] : []));
    assert.deepEqual(tools, [
      'toolu_01:running', 'toolu_01:done',
      'toolu_02:running', 'toolu_03:running', 'toolu_03:error', 'toolu_02:done',
    ]);
    assert.deepEqual(turn.finish('stopped'), EXPECTED_CALLS);
  });

  it('writes completed text blocks only when no partial frame ever arrives', () => {
    const { turn } = feedAll([
      assistant({ type: 'text', text: 'Checking.' }),
      assistant({ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }),
      toolResult('toolu_1', 'x'),
      assistant({ type: 'text', text: 'Done.' }),
    ]);
    assert.equal(turn.text, 'Checking.\n\nDone.');
  });
});

/** With `hang`, fails a little after the abort, the way the CLI winds down. */
function fakeQuery(events: unknown[], opts: { hang?: boolean; before?: (o: Options) => Promise<void> } = {}) {
  const seen: { options?: Options; closed: boolean } = { closed: false };
  const impl = (params: { options?: Options }): AsyncIterable<SDKMessage> => {
    seen.options = params.options;
    const signal = params.options?.abortController?.signal;
    async function* gen(): AsyncGenerator<SDKMessage> {
      try {
        for (const e of events) {
          await sleep(1);
          yield e as SDKMessage;
        }
        if (opts.before && params.options) await opts.before(params.options);
        if (opts.hang) {
          await new Promise<void>((_, reject) => {
            signal?.addEventListener('abort', () => setTimeout(() => reject(new Error('Claude Code process aborted by user')), 150));
          });
        }
      } finally {
        seen.closed = true;
      }
    }
    return gen();
  };
  return { impl, seen };
}

describe('ClaudeDirectDispatcher.chat', () => {
  it('streams through onEvent and returns the final result with the tool calls', async () => {
    const q = fakeQuery(recordedTurn());
    const d = new ClaudeDirectDispatcher(MODEL, { queryImpl: q.impl });
    const events: TurnEvent[] = [];
    const r = await d.chat({ messages: [{ role: 'user', content: 'what do I have?' }], onEvent: e => events.push(e) });
    assert.equal(r.content, 'You have 12.');
    assert.equal(r.stopped, undefined);
    assert.deepEqual(r.tool_calls, EXPECTED_CALLS);
    assert.equal(events.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Let me check.\n\nYou have 12.');
    assert.equal(q.seen.options?.includePartialMessages, true);
    assert.ok(q.seen.options?.abortController, 'the SDK gets an abort controller');
    assert.equal(q.seen.closed, true, 'the SDK session is closed once the result arrives');
  });

  it('a stop returns at once with the streamed text and the unfinished call marked stopped', async () => {
    const events = recordedTurn().slice(0, 12);   // text, then a tool call still running
    const q = fakeQuery(events, { hang: true });
    const d = new ClaudeDirectDispatcher(MODEL, { queryImpl: q.impl });
    const ctl = new AbortController();
    const seen: TurnEvent[] = [];
    const p = d.chat({
      messages: [{ role: 'user', content: 'what do I have?' }],
      signal: ctl.signal,
      onEvent: e => {
        seen.push(e);
        if (e.type === 'tool') setTimeout(() => ctl.abort(), 5);
      },
    });
    const r = await p;
    assert.equal(r.stopped, true);
    assert.equal(r.content, 'Let me check.');
    assert.deepEqual(r.tool_calls, [
      { id: 'toolu_01', name: 'mcp__finance__get_balances', args: '{"account":"all"}', status: 'error', result: 'stopped' },
    ]);
    assert.equal(q.seen.options?.abortController?.signal.aborted, true, 'the stop reaches the SDK, which ends the CLI');
    const count = seen.length;
    await sleep(250);   // the fake CLI fails after the stop; nothing more is published
    assert.equal(seen.length, count);
    assert.equal(q.seen.closed, true);
  });

  it('a stop before the turn starts never starts the SDK', async () => {
    const q = fakeQuery(recordedTurn());
    const d = new ClaudeDirectDispatcher(MODEL, { queryImpl: q.impl });
    const r = await d.chat({ messages: [{ role: 'user', content: 'hi' }], signal: AbortSignal.abort() });
    assert.equal(r.stopped, true);
    assert.equal(r.content, '');
    assert.equal(q.seen.options, undefined);
  });

  it('a stop while a gated built-in waits on approval rejects the card and releases the hook', async () => {
    const store = new ApprovalStore(openDatabase(':memory:'));
    const workspaces = [{ path: '/work', permissions: ['read', 'exec'] } as unknown as Workspace];
    let hookResult: unknown;
    const q = fakeQuery(recordedTurn().slice(0, 7), {
      hang: true,
      before: async (options) => {
        const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
        assert.ok(hook, 'the PreToolUse hook is installed');
        const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_b' };
        hookResult = await hook(input as never, 'toolu_b', { signal: new AbortController().signal });
      },
    });
    const d = new ClaudeDirectDispatcher(MODEL, {
      queryImpl: q.impl, workspaces,
      approval: { agentId: 'alice', store, gatedTools: ['Bash'] },
    });
    const ctl = new AbortController();
    const p = d.chat({ messages: [{ role: 'user', content: 'list files' }], conversation_id: 42, signal: ctl.signal });
    for (let i = 0; i < 100 && store.pendingCount() === 0; i++) await sleep(5);
    assert.equal(store.pendingCount(), 1);
    ctl.abort();
    const r = await p;
    assert.equal(r.stopped, true);
    assert.equal(store.pendingCount(), 0, 'no orphan card stays pending');
    const [decided] = store.listDecided();
    assert.equal(decided.state, 'rejected');
    assert.equal(decided.reason, STOPPED_APPROVAL_REASON);
    await sleep(200);
    const out = (hookResult as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)?.hookSpecificOutput;
    assert.equal(out?.permissionDecision, 'deny');
  });
});
