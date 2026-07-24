import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { z } from 'zod';
import { buildPluginTools } from '../tools/ritsu-agent/plugin.js';
import { buildBuiltinTools, type RaToolDeps } from '../tools/ritsu-agent/builtin.js';
import type { PluginToolDef } from '../plugins/types.js';

// SEC-5: plugin tools must reach the ritsu-agent (native-loop) runtime too, not
// only claude-direct — otherwise a ritsu-agent agent silently loses plugin
// access. Naming + fencing must match the claude-direct MCP path so the
// dispatcher's gatedTools (mcp__<id>__<name>) gates them identically.
const def = (over: Partial<PluginToolDef> = {}): PluginToolDef => ({
  name: 'list_things',
  description: 'list things',
  input: { q: z.string() },
  handler: async (args) => ({ content: [{ type: 'text', text: `got:${String(args.q)}` }] }),
  ...over,
});

describe('buildPluginTools (ritsu-agent plugin parity)', () => {
  it('names tools mcp__<id>__<name> and exposes a JSON-schema parameters object', () => {
    const [t] = buildPluginTools([{ id: 'projects', tools: [def()] }], 'agent-x');
    assert.equal(t.name, 'mcp__projects__list_things');
    assert.equal((t.parameters as { type?: string }).type, 'object');
    // The zod raw shape converted to JSON schema; no leftover $schema meta key.
    assert.equal(t.parameters.$schema, undefined);
    assert.deepEqual(Object.keys((t.parameters as { properties: object }).properties), ['q']);
  });

  it('invokes the plugin handler and returns its text verbatim (non-untrusted)', async () => {
    const [t] = buildPluginTools([{ id: 'projects', tools: [def()] }], 'agent-x');
    assert.equal(await t.handler({ q: 'abc' }), 'got:abc');
  });

  it('fences the output of an untrustedOutput tool (wraps, never returns raw)', async () => {
    const [t] = buildPluginTools([{ id: 'crm', tools: [def({
      name: 'read_inbox',
      untrustedOutput: true,
      handler: async () => ({ content: [{ type: 'text', text: 'ATTACKER-CONTROLLED' }] }),
    })] }], 'agent-x');
    const out = await t.handler({});
    assert.match(out, /ATTACKER-CONTROLLED/);      // content preserved
    assert.notEqual(out, 'ATTACKER-CONTROLLED');   // but wrapped in fence delimiters
  });

  it('buildBuiltinTools includes plugin tools when deps.plugins is set', () => {
    const deps = {
      agentId: 'agent-x',
      memory: {}, defStore: {}, conversations: {}, host: {},
      plugins: [{ id: 'projects', tools: [def()] }],
    } as unknown as RaToolDeps;
    const names = buildBuiltinTools(deps).map(t => t.name);
    assert.ok(names.includes('mcp__projects__list_things'), 'plugin tool should be surfaced');
    // sanity: built-ins still there
    assert.ok(names.includes('memory_remember'));
  });

  it('omits plugin tools when none are allowlisted', () => {
    const deps = {
      agentId: 'agent-x', memory: {}, defStore: {}, conversations: {}, host: {},
    } as unknown as RaToolDeps;
    const names = buildBuiltinTools(deps).map(t => t.name);
    assert.ok(!names.some(n => n.startsWith('mcp__')));
  });
});
