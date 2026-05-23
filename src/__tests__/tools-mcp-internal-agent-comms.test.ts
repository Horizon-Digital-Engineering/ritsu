import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  currentCallContext, runInCallContext, MAX_CALL_DEPTH, buildDenialMessage,
} from '../tools/mcp-internal/agent-comms.js';

describe('agent-comms-mcp call context', () => {
  it('returns undefined outside a call', () => {
    assert.equal(currentCallContext(), undefined);
  });

  it('exposes the context to code running inside runInCallContext', async () => {
    const result = await runInCallContext({ depth: 2, chain: ['a', 'b'] }, async () => {
      const ctx = currentCallContext();
      return ctx;
    });
    assert.deepEqual(result, { depth: 2, chain: ['a', 'b'] });
  });

  it('isolates nested contexts (each frame sees its own)', async () => {
    const seen: Array<{ depth: number; chain: string[] }> = [];
    await runInCallContext({ depth: 1, chain: ['a'] }, async () => {
      seen.push(currentCallContext()!);
      await runInCallContext({ depth: 2, chain: ['a', 'b'] }, async () => {
        seen.push(currentCallContext()!);
      });
      // After the inner frame exits, the outer frame's context is restored.
      seen.push(currentCallContext()!);
    });
    assert.deepEqual(seen.map(c => c.depth), [1, 2, 1]);
    assert.deepEqual(seen.map(c => c.chain.join('->')), ['a', 'a->b', 'a']);
  });

  it('MAX_CALL_DEPTH is set conservatively (<=5)', () => {
    // If someone bumps this high they should know what they're doing — the
    // guard is the only thing keeping a model loop from runaway.
    assert.ok((MAX_CALL_DEPTH) <= (5));
    assert.ok((MAX_CALL_DEPTH) >= (2));
  });
});

describe('buildDenialMessage', () => {
  it('lists callable agents and suggests an obvious typo', () => {
    // The real incident: agent-one kept calling "agent-twoo".
    const msg = buildDenialMessage('agent-one', 'agent-twoo', [
      'agent-ops',
      'agent-two',
      'agent-three',
    ]);
    assert.ok((msg).includes('agent-ops, agent-two, agent-three'));
    assert.ok((msg).includes('Did you mean "agent-two"?'));
  });

  it('does not suggest when the target is nowhere near an allowed id', () => {
    const msg = buildDenialMessage('a', 'totally-different', ['agent-ops', 'agent-three']);
    assert.ok((msg).includes('agent-ops, agent-three'));
    assert.ok(!(msg).includes('Did you mean'));
  });

  it('explains the fix when the allowlist is empty', () => {
    const msg = buildDenialMessage('lonely-agent', 'anyone', []);
    assert.ok((msg).includes('no agents in its can_call allowlist'));
    assert.ok(!(msg).includes('Did you mean'));
  });
});
