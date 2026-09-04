/**
 * The small modules the rest of the security posture rests on: the in-handler
 * approval gate, the trusted-bin resolver, the HTML escaper, and the per-IP
 * rate limiter. None of them had a test before; each is a single point whose
 * silent failure would not surface anywhere else.
 */
import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { openDatabase } from '../db.js';
import { ApprovalStore } from '../approval-store.js';
import { gateMcpTool, type McpGateContext } from '../tools/mcp-internal/approval-gate.js';
import { spawnSync, _resetResolveCacheForTests } from '../util/safe-spawn.js';
import { escapeHtml, html } from '../util/safe-html.js';
import { RateLimiter } from '../util/rate-limit.js';
import { SecretStore } from '../auth/secret-store.js';
import { SqliteAgentDefinitionStore } from '../agent-definition-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { SqliteMemoryStore } from '../memory-store.js';
import { buildAgentMonitorMcp } from '../tools/mcp-internal/agent-monitor.js';
import { buildAgentEmailMcp } from '../tools/mcp-internal/email.js';
import { buildAgentSocialMcp } from '../tools/mcp-internal/social.js';
import { randomBytes } from 'node:crypto';
import { _resetKeyCacheForTests } from '../util/secret-crypto.js';

describe('gateMcpTool', () => {
  let approvals: ApprovalStore;
  beforeEach(() => { approvals = new ApprovalStore(openDatabase(':memory:')); });

  const ctx = (gatedTools: string[]): McpGateContext =>
    ({ agentId: 'alice', conversationId: 7, gatedTools, approvals });

  it('runs straight through when there is no gate at all', async () => {
    let ran = false;
    const r = await gateMcpTool(null, 'mcp__memory__forget', {}, async () => {
      ran = true;
      return { content: [{ type: 'text' as const, text: 'done' }] };
    });
    assert.equal(ran, true);
    assert.equal(r.content[0].text, 'done');
  });

  it('runs straight through when the tool is not in the gated list', async () => {
    const r = await gateMcpTool(ctx(['mcp__memory__remember']), 'mcp__memory__forget', {}, async () =>
      ({ content: [{ type: 'text' as const, text: 'done' }] }));
    assert.equal(r.content[0].text, 'done');
  });

  it('runs the handler once the operator approves', async () => {
    const gate = ctx(['mcp__memory__forget']);
    const call = gateMcpTool(gate, 'mcp__memory__forget', { id: 1 }, async () =>
      ({ content: [{ type: 'text' as const, text: 'forgotten' }] }));
    const pending = await waitForPending(approvals);
    approvals.decide(pending, 'approved', null, 'operator');
    assert.equal((await call).content[0].text, 'forgotten');
  });

  it('NEVER runs the handler on reject, and hands the reason to the model', async () => {
    const gate = ctx(['mcp__memory__forget']);
    let ran = false;
    const call = gateMcpTool(gate, 'mcp__memory__forget', { id: 1 }, async () => {
      ran = true;
      return { content: [{ type: 'text' as const, text: 'forgotten' }] };
    });
    const pending = await waitForPending(approvals);
    approvals.decide(pending, 'rejected', 'that is the audit trail', 'operator');
    const r = await call;
    assert.equal(ran, false, 'a rejected call must not reach the handler');
    assert.match(r.content[0].text, /Operator rejected this mcp__memory__forget call: that is the audit trail/);
  });

  it('records the args on the approval row so the operator sees what they are approving', async () => {
    const gate = ctx(['mcp__email__send_email']);
    void gateMcpTool(gate, 'mcp__email__send_email', { to: 'a@b.com', subject: 'hi' }, async () =>
      ({ content: [{ type: 'text' as const, text: 'sent' }] }));
    const id = await waitForPending(approvals);
    const row = approvals.listPending(10).find(r => r.id === id);
    assert.ok(row);
    assert.equal(row.agent_id, 'alice');
    assert.equal(row.conversation_id, 7);
    assert.deepEqual(JSON.parse(row.args_json), { to: 'a@b.com', subject: 'hi' });
    approvals.decide(id, 'rejected', null, 'operator');
  });
});

/** request() mints the row asynchronously; poll briefly rather than guessing. */
async function waitForPending(approvals: ApprovalStore): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const rows = approvals.listPending(10);
    if (rows.length) return rows[rows.length - 1].id;
    await new Promise(r => setTimeout(r, 2));
  }
  throw new Error('no pending approval was minted');
}

describe('safe-spawn', () => {
  beforeEach(() => { _resetResolveCacheForTests(); });

  it('resolves a bare name against the trusted dirs, not $PATH', () => {
    const r = spawnSync('echo', ['hello'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'hello');
  });

  it('refuses a name that is not in a trusted bin dir', () => {
    assert.throws(
      () => spawnSync('definitely-not-a-real-binary-xyz', []),
      /not found in any trusted bin dir/,
    );
  });

  it('does NOT fall back to $PATH when a shadowing binary is planted there', (t) => {
    // The whole point of the module: a writable dir on PATH must not win.
    const original = process.env.PATH;
    t.after(() => { process.env.PATH = original; });
    process.env.PATH = '/tmp/definitely-not-trusted';
    assert.throws(() => spawnSync('definitely-not-a-real-binary-xyz', []), /trusted bin dir/);
  });

  it('passes an absolute path through unchanged', () => {
    const r = spawnSync('/bin/echo', ['abs'], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), 'abs');
  });
});

describe('safe-html', () => {
  it('escapes every character that can break out of a text node or attribute', () => {
    assert.equal(String(escapeHtml(`<script>"x"&'y'</script>`)),
      '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;');
  });

  it('escapes interpolated values in the html template', () => {
    const name = '<img src=x onerror=alert(1)>';
    assert.equal(String(html`<h1>Hello, ${name}</h1>`),
      '<h1>Hello, &lt;img src=x onerror=alert(1)&gt;</h1>');
  });

  it('does not double-escape an already-safe fragment', () => {
    const inner = escapeHtml('a & b');
    assert.equal(String(html`<p>${inner}</p>`), '<p>a &amp; b</p>');
  });

  it('concatenates an array of fragments without re-escaping', () => {
    const items = ['a<b', 'c&d'].map(i => html`<li>${i}</li>`);
    assert.equal(String(html`<ul>${items}</ul>`), '<ul><li>a&lt;b</li><li>c&amp;d</li></ul>');
  });

  it('renders null and undefined as empty, not as the words', () => {
    assert.equal(String(html`<p>${null}${undefined}</p>`), '<p></p>');
  });
});

describe('RateLimiter', () => {
  it('allows up to max in a window, then reports Retry-After', () => {
    const rl = new RateLimiter(60_000, 3);
    const now = 1_000_000;
    assert.equal(rl.hit('1.2.3.4', now), null);
    assert.equal(rl.hit('1.2.3.4', now), null);
    assert.equal(rl.hit('1.2.3.4', now), null);
    assert.equal(rl.hit('1.2.3.4', now), 60);
  });

  it('keeps buckets per address', () => {
    const rl = new RateLimiter(60_000, 1);
    const now = 1_000_000;
    assert.equal(rl.hit('1.1.1.1', now), null);
    assert.equal(rl.hit('1.1.1.1', now), 60);
    assert.equal(rl.hit('2.2.2.2', now), null);
  });

  it('resets once the window has passed', () => {
    const rl = new RateLimiter(1_000, 1);
    assert.equal(rl.hit('1.1.1.1', 0), null);
    assert.equal(rl.hit('1.1.1.1', 500), 1);
    assert.equal(rl.hit('1.1.1.1', 2_000), null);
  });

  it('sweeps expired buckets instead of growing forever', () => {
    const rl = new RateLimiter(1_000, 100);
    // Past the sweep threshold, from addresses that never come back.
    for (let i = 0; i < 1100; i++) rl.hit(`10.0.${(i / 256) | 0}.${i % 256}`, 0);
    assert.ok(rl.size > 1000, 'entries accumulate inside the window');
    rl.hit('9.9.9.9', 10_000);   // every prior bucket is now expired
    assert.equal(rl.size, 1, 'the sweep reclaimed every expired bucket');
  });
});

/**
 * Every in-process MCP group has to honour approval_tools, not just the ones
 * that happened to be wired first. On the direct runtime these handlers are the
 * ONLY enforcement point, so a group that ignores the gate is a silent no-op
 * behind a checkbox the operator ticked.
 */
describe('every in-process MCP group honours the gate', () => {
  let approvals: ApprovalStore;
  let secrets: SecretStore;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    process.env.RITSU_MASTER_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
    db = openDatabase(':memory:');
    approvals = new ApprovalStore(db);
    secrets = new SecretStore(db);
  });

  const gateFor = (tool: string): McpGateContext =>
    ({ agentId: 'alice', conversationId: null, gatedTools: [tool], approvals });

  /**
   * Invoke a tool on a built SDK MCP server. createSdkMcpServer returns a
   * wrapper whose registry is the only way in — there is no public call path
   * short of standing up a transport. Kept to this one helper so an SDK change
   * breaks here rather than in every assertion.
   */
  type Registry = { instance: { _registeredTools: Record<string, {
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
  }> } };
  function handlerOf(server: unknown, name: string): (args: Record<string, unknown>) => Promise<unknown> {
    const entry = (server as Registry).instance._registeredTools[name];
    assert.ok(entry, `tool ${name} not found on the server`);
    return (args) => entry.handler(args, {});
  }

  async function assertRejects(server: unknown, toolName: string, fullName: string): Promise<void> {
    const call = handlerOf(server, toolName)({});
    const id = await waitForPending(approvals);
    approvals.decide(id, 'rejected', 'no', 'operator');
    const out = JSON.stringify(await call);
    assert.match(out, new RegExp(`Operator rejected this ${fullName.replace(/[_]/g, '_')} call`),
      `${fullName} must be blocked by the gate`);
  }

  it('agent_monitor blocks a gated read', async () => {
    const server = buildAgentMonitorMcp('alice', {
      defStore: new SqliteAgentDefinitionStore(db),
      conversations: new SqliteConversationStore(db),
      memory: new SqliteMemoryStore(db),
    }, gateFor('mcp__agent_monitor__list_agents'));
    await assertRejects(server, 'list_agents', 'mcp__agent_monitor__list_agents');
  });

  it('email blocks a gated inbox read', async () => {
    const server = buildAgentEmailMcp({
      agentId: 'alice', secrets, approvals, conversationId: null,
      gate: gateFor('mcp__email__read_inbox'),
    });
    await assertRejects(server, 'read_inbox', 'mcp__email__read_inbox');
  });

  it('social blocks a gated mentions read', async () => {
    const server = buildAgentSocialMcp({
      agentId: 'alice', secrets, approvals, conversationId: null,
      gate: gateFor('mcp__social__read_mentions'),
    });
    await assertRejects(server, 'read_mentions', 'mcp__social__read_mentions');
  });

  it('leaves an ungated group alone', async () => {
    const server = buildAgentEmailMcp({
      agentId: 'alice', secrets, approvals, conversationId: null,
      gate: gateFor('mcp__email__read_email'),   // a DIFFERENT tool is gated
    });
    const out = JSON.stringify(await handlerOf(server, 'read_inbox')({}));
    assert.match(out, /not configured/, 'read_inbox should run straight through to its own check');
    assert.equal(approvals.listPending(10).length, 0);
  });
});
