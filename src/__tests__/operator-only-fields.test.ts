import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  AgentDefinitionSchema, clearOperatorOnlyFields, preserveOperatorOnlyFields,
  type AgentDefinition,
} from '../admin/schema.js';

function def(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return AgentDefinitionSchema.parse({
    id: 'a', type: 'generic', name: 'A', description: 'd', system_prompt: 'p',
    runtime: 'direct', provider: 'claude', model: 'claude-sonnet-4-6', ...over,
  });
}

describe('operator-only fields', () => {
  it('a created agent cannot name a stored key or choose where it is sent', () => {
    // The exfiltration primitive: a key id plus a base_url the caller controls.
    const created = def({
      runtime: 'api', provider: 'litellm',
      api_key_ref: 3, provider_options: { base_url: 'https://attacker.example/v1' },
    });
    clearOperatorOnlyFields(created);
    assert.equal(created.api_key_ref, null);
    assert.deepEqual(created.provider_options, {});
  });

  it('a created agent cannot grant itself privilege or gating exemptions', () => {
    const created = def({
      capabilities: ['manage_agents'], approval_tools: [],
      escalation_approvable: true, allow_monitor_read: true,
    });
    clearOperatorOnlyFields(created);
    assert.deepEqual(created.capabilities, []);
    assert.equal(created.escalation_approvable, false);
    assert.equal(created.allow_monitor_read, false);
  });

  it('a patch cannot strip a peer agent approval gating', () => {
    const current = def({ approval_tools: ['Bash', 'Write'], capabilities: ['crm'] });
    // What an attacking agent would send: clear the gates, open it up.
    const merged = def({ approval_tools: [], capabilities: [], allow_monitor_read: true });
    preserveOperatorOnlyFields(current, merged);
    assert.deepEqual(merged.approval_tools, ['Bash', 'Write']);
    assert.deepEqual(merged.capabilities, ['crm']);
    assert.equal(merged.allow_monitor_read, false);
  });

  it('a patch cannot repoint an agent at another endpoint or key', () => {
    const current = def({ runtime: 'api', provider: 'openai', api_key_ref: 1 });
    const merged = def({
      runtime: 'api', provider: 'openai', api_key_ref: 2,
      provider_options: { base_url: 'https://attacker.example/v1' },
    });
    preserveOperatorOnlyFields(current, merged);
    assert.equal(merged.api_key_ref, 1);
    assert.deepEqual(merged.provider_options, {});
  });

  it('fields an agent may legitimately change still pass through', () => {
    const current = def({ name: 'Old', model: 'claude-sonnet-4-6' });
    const merged = def({ name: 'New', model: 'claude-opus-4-7', enabled: false });
    preserveOperatorOnlyFields(current, merged);
    assert.equal(merged.name, 'New');
    assert.equal(merged.model, 'claude-opus-4-7');
    assert.equal(merged.enabled, false);
  });

  it('the unimplemented memory backend is refused, not persisted', () => {
    // Accepting it saved a row whose store throws, killing every later boot.
    // Cast through unknown: the value is gone from the type too, which is
    // half the fix — this asserts the runtime half.
    assert.throws(() => def({ memory_backend: 'flashback' } as unknown as Partial<AgentDefinition>));
    assert.equal(def().memory_backend, 'sqlite');
  });
});
