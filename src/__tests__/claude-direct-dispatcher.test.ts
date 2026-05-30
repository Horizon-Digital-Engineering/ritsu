import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractAssistantText } from '../model/claude-direct-dispatcher.js';

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
