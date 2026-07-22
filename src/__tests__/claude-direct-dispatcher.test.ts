import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractAssistantText, buildPreToolUseHook } from '../model/claude-direct-dispatcher.js';
import type { Workspace } from '../workspace-store.js';
import type { ApprovalStore } from '../approval-store.js';
import type { ClaudeDirectOpts } from '../model/claude-direct-dispatcher.js';

describe('extractAssistantText', () => {
  it('joins all text blocks from an assistant event and trims', () => {
    const ev = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world  ' },
        ],
      },
    };
    assert.equal(extractAssistantText(ev), 'hello world');
  });

  it('ignores tool_use and thinking blocks but keeps surrounding text', () => {
    const ev = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', text: 'private deliberation' },
          { type: 'text', text: 'Got it. Updating memory.' },
          { type: 'tool_use', id: 'tu_1', name: 'update_memory', input: {} },
        ],
      },
    };
    assert.equal(extractAssistantText(ev), 'Got it. Updating memory.');
  });

  it('returns "" for a tool-only assistant turn (the bug we are fixing)', () => {
    const ev = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'update_memory', input: {} },
        ],
      },
    };
    assert.equal(extractAssistantText(ev), '');
  });

  it('returns "" for non-assistant events', () => {
    assert.equal(extractAssistantText({ type: 'result', subtype: 'success', result: 'ok' }), '');
    assert.equal(extractAssistantText({ type: 'user', message: { content: 'hi' } }), '');
    assert.equal(extractAssistantText({ type: 'system' }), '');
  });

  it('returns "" for malformed shapes without throwing', () => {
    assert.equal(extractAssistantText(null), '');
    assert.equal(extractAssistantText(undefined), '');
    assert.equal(extractAssistantText('not-an-event'), '');
    assert.equal(extractAssistantText({ type: 'assistant' }), '');
    assert.equal(extractAssistantText({ type: 'assistant', message: { content: 'not-array' } }), '');
    assert.equal(extractAssistantText({ type: 'assistant', message: { content: [{ noType: 1 }] } }), '');
  });
});

// The PreToolUse hook is the enforcement layer for the SDK's BUILT-IN tools on
// the Max-plan path (canUseTool never sees them). We can't drive the SDK
// subprocess in a unit test, but we CAN exercise the returned hook callback
// directly with a synthetic PreToolUseHookInput and assert its permission
// decision — that's where the workspace-permission + approval policy lives.
describe('buildPreToolUseHook (built-in tool enforcement)', () => {
  const ws = (path: string, permissions: string[]): Workspace =>
    ({ path, permissions } as unknown as Workspace);
  const workspaces = [ws('/work', ['read', 'exec'])];

  type Hook = ReturnType<typeof buildPreToolUseHook>;
  async function decide(hook: Hook, tool_name: string, tool_input: unknown) {
    const input = { hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't' };
    const res = await hook(input as never, undefined, { signal: new AbortController().signal });
    const out = (res as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
    return { decision: out?.permissionDecision, reason: out?.permissionDecisionReason ?? '' };
  }

  it('waves through in-process / MCP tools with no workspace check', async () => {
    const hook = buildPreToolUseHook([], {}, null, new Set(['mcp__memory__remember']));
    assert.equal((await decide(hook, 'mcp__memory__remember', {})).decision, 'allow');
    assert.equal((await decide(hook, 'mcp__plugin__anything', {})).decision, 'allow');
  });

  it('allows a built-in Bash when the workspace grants exec', async () => {
    const hook = buildPreToolUseHook(workspaces, {}, null, new Set());
    assert.equal((await decide(hook, 'Bash', { command: 'ls' })).decision, 'allow');
  });

  it('denies a Read outside the workspace', async () => {
    const hook = buildPreToolUseHook(workspaces, {}, null, new Set());
    const r = await decide(hook, 'Read', { file_path: '/etc/passwd' });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /no workspace grants/);
  });

  it('denies a tool not in the permission map (fail-closed)', async () => {
    const hook = buildPreToolUseHook(workspaces, {}, null, new Set());
    assert.equal((await decide(hook, 'MysteryTool', {})).decision, 'deny');
  });

  it('routes a gated built-in through approval and denies on reject', async () => {
    const store = { request: async () => ({ state: 'rejected', reason: 'nope' }) } as unknown as ApprovalStore;
    const opts: ClaudeDirectOpts = { approval: { agentId: 'a', store, gatedTools: ['Bash'] } };
    const hook = buildPreToolUseHook(workspaces, opts, null, new Set());
    const r = await decide(hook, 'Bash', { command: 'rm -rf /' });
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /Operator rejected/);
  });

  it('allows a gated built-in when the operator approves', async () => {
    const store = { request: async () => ({ state: 'approved', reason: null }) } as unknown as ApprovalStore;
    const opts: ClaudeDirectOpts = { approval: { agentId: 'a', store, gatedTools: ['Bash'] } };
    const hook = buildPreToolUseHook(workspaces, opts, null, new Set());
    assert.equal((await decide(hook, 'Bash', { command: 'ls' })).decision, 'allow');
  });
});
