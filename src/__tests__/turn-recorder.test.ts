import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ApprovalStore } from '../approval-store.js';
import { clipText, TurnRecorder, untilAborted, TOOL_ARGS_MAX, TOOL_RESULT_MAX, type TurnEvent } from '../model/dispatcher.js';
import { beginTurn, stopTurns, runningTurns, closeApprovalsOnStop, STOPPED_APPROVAL_REASON } from '../turns.js';

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
process.on('unhandledRejection', onUnhandled);
after(() => {
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, [], 'no promise rejection went unhandled');
});

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

function recorder(): { turn: TurnRecorder; events: TurnEvent[] } {
  const events: TurnEvent[] = [];
  return { turn: new TurnRecorder(e => events.push(e)), events };
}

describe('clipText', () => {
  it('leaves short text alone and cuts long text to exactly max chars ending in an ellipsis', () => {
    assert.equal(clipText('short', 10), 'short');
    assert.equal(clipText('0123456789', 10), '0123456789');
    const cut = clipText('0123456789abc', 10);
    assert.equal(cut, '012345678…');
    assert.equal(cut.length, 10);
  });

  it('never splits a surrogate pair', () => {
    const cut = clipText('abc😀def', 5);
    assert.equal(cut, 'abc…');
    assert.ok(!/[\uD800-\uDBFF]$/.test(cut.slice(0, -1)));
  });
});

describe('TurnRecorder', () => {
  it('streams text in order and puts a paragraph break between stretches split by tools', () => {
    const { turn, events } = recorder();
    turn.write('Let me check');
    turn.write('.');
    turn.toolStart('t1', 'mcp__finance__get_balances', { account: 'all' });
    turn.toolEnd('t1', '{"total":12}', false);
    turn.write('You have 12.');
    const text = events.filter(e => e.type === 'text').map(e => e.delta);
    assert.deepEqual(text, ['Let me check', '.', '\n\n', 'You have 12.']);
    assert.equal(turn.text, 'Let me check.\n\nYou have 12.');
  });

  it('adds no break before the first text when a tool ran first', () => {
    const { turn } = recorder();
    turn.toolStart('t1', 'Read', { path: 'a' });
    turn.toolEnd('t1', 'x', false);
    turn.write('Done.');
    assert.equal(turn.text, 'Done.');
  });

  it('reports a call starting and ending under one id, as copies', () => {
    const { turn, events } = recorder();
    turn.toolStart('t1', 'Bash', { command: 'ls' });
    turn.toolEnd('t1', 'a.txt', false);
    const tools = events.filter((e): e is Extract<TurnEvent, { type: 'tool' }> => e.type === 'tool');
    assert.equal(tools.length, 2);
    assert.deepEqual(tools[0].call, { id: 't1', name: 'Bash', args: '{"command":"ls"}', status: 'running' });
    assert.deepEqual(tools[1].call, { id: 't1', name: 'Bash', args: '{"command":"ls"}', status: 'done', result: 'a.txt' });
    assert.notEqual(tools[0].call, tools[1].call);
  });

  it('ignores a repeated start, an unknown end, and a second end', () => {
    const { turn, events } = recorder();
    turn.toolStart('t1', 'Bash', {});
    turn.toolStart('t1', 'Bash', {});
    turn.toolEnd('nope', 'x', false);
    turn.toolEnd('t1', 'first', true);
    turn.toolEnd('t1', 'second', false);
    assert.equal(events.length, 2);
    assert.deepEqual(turn.finish('stopped'), [{ id: 't1', name: 'Bash', args: '{}', status: 'error', result: 'first' }]);
  });

  it('clips arguments and results', () => {
    const { turn } = recorder();
    turn.toolStart('t1', 'Write', { content: 'x'.repeat(5000) });
    turn.toolEnd('t1', 'y'.repeat(9000), false);
    const [call] = turn.finish('stopped');
    assert.equal(call.args.length, TOOL_ARGS_MAX);
    assert.ok(call.args.endsWith('…'));
    assert.equal(call.result?.length, TOOL_RESULT_MAX);
  });

  it('finish marks unfinished calls as errors and ignores everything after it', () => {
    const { turn, events } = recorder();
    turn.write('working');
    turn.toolStart('t1', 'mcp__web__fetch', { url: 'https://example.test' });
    const calls = turn.finish('stopped');
    assert.deepEqual(calls, [{ id: 't1', name: 'mcp__web__fetch', args: '{"url":"https://example.test"}', status: 'error', result: 'stopped' }]);
    const seen = events.length;
    turn.toolEnd('t1', 'late', false);
    turn.write('late text');
    turn.toolStart('t2', 'Bash', {});
    assert.equal(events.length, seen);
    assert.equal(turn.text, 'working');
  });

  it('a listener that throws does not break the turn', () => {
    const turn = new TurnRecorder(() => { throw new Error('feed closed'); });
    turn.write('still');
    turn.toolStart('t1', 'Bash', {});
    turn.toolEnd('t1', 'ok', false);
    assert.equal(turn.text, 'still');
    assert.equal(turn.finish('stopped')[0].status, 'done');
  });
});

describe('untilAborted', () => {
  it('settles with the promise when no stop comes', async () => {
    const ctl = new AbortController();
    assert.equal(await untilAborted(Promise.resolve(7), ctl.signal), 7);
    await assert.rejects(untilAborted(Promise.reject(new Error('boom')), ctl.signal), /boom/);
    assert.equal(await untilAborted(Promise.resolve(8), undefined), 8);
  });

  it('rejects at once on a stop and absorbs the late settle', async () => {
    const ctl = new AbortController();
    let fail: (e: Error) => void = () => undefined;
    const slow = new Promise<number>((_, reject) => { fail = reject; });
    const raced = untilAborted(slow, ctl.signal);
    ctl.abort();
    await assert.rejects(raced, /stopped/);
    fail(new Error('the late failure'));
    await tick();
  });

  it('rejects immediately for a signal that already aborted', async () => {
    await assert.rejects(untilAborted(new Promise<never>(() => undefined), AbortSignal.abort()), /stopped/);
  });
});

describe('turn registry', () => {
  it('stops every running turn in one conversation and counts them', () => {
    const a = beginTurn(101);
    const b = beginTurn(101);
    const other = beginTurn(102);
    assert.equal(runningTurns(101), 2);
    assert.equal(stopTurns(101), 2);
    assert.ok(a.signal.aborted && b.signal.aborted);
    assert.equal(other.signal.aborted, false);
    assert.equal(stopTurns(101), 0, 'already stopped turns are not counted again');
    a.end(); b.end(); other.end();
    assert.equal(runningTurns(101), 0);
    assert.equal(stopTurns(101), 0);
  });

  it('a caller signal also stops the turn', () => {
    const caller = new AbortController();
    const t = beginTurn(103, caller.signal);
    caller.abort();
    assert.equal(t.signal.aborted, true);
    t.end();
  });

  it('end is safe to call twice and keeps the other turns registered', () => {
    const a = beginTurn(104);
    const b = beginTurn(104);
    a.end();
    a.end();
    assert.equal(runningTurns(104), 1);
    assert.equal(stopTurns(104), 1);
    assert.ok(b.signal.aborted);
    b.end();
  });
});

describe('closeApprovalsOnStop', () => {
  it('rejects the stopped turn\'s pending approvals and releases the waiting tool', async () => {
    const store = new ApprovalStore(openDatabase(':memory:'));
    const ctl = new AbortController();
    const release = closeApprovalsOnStop(ctl.signal, store, 'alice', 5);
    const mine = store.request({ agentId: 'alice', conversationId: 5, toolName: 'Bash', args: {} });
    const otherConvo = store.request({ agentId: 'alice', conversationId: 6, toolName: 'Bash', args: {} });
    const otherAgent = store.request({ agentId: 'bob', conversationId: 5, toolName: 'Bash', args: {} });
    ctl.abort();
    assert.deepEqual(await mine, { state: 'rejected', reason: STOPPED_APPROVAL_REASON });
    const pending = store.listPending();
    assert.equal(pending.length, 2, 'approvals of other turns stay pending');
    const decided = store.listDecided();
    assert.equal(decided.length, 1);
    assert.equal(decided[0].decided_by, 'system');
    release();
    for (const p of pending) store.decide(p.id, 'approved', null, 'test');
    await Promise.all([otherConvo, otherAgent]);
  });

  it('rejects an approval raised after the stop, and stops watching once released', async () => {
    const store = new ApprovalStore(openDatabase(':memory:'));
    const ctl = new AbortController();
    const release = closeApprovalsOnStop(ctl.signal, store, 'alice', 5);
    ctl.abort();
    const late = await store.request({ agentId: 'alice', conversationId: 5, toolName: 'Write', args: {} });
    assert.equal(late.state, 'rejected');
    release();
    void store.request({ agentId: 'alice', conversationId: 5, toolName: 'Write', args: {} });
    await tick();
    assert.equal(store.pendingCount(), 1, 'a released watcher leaves later approvals alone');
  });
});
