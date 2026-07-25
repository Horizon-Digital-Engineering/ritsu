import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { AnthropicClient, toAnthropicMessages } from '../model/ritsu-agent/anthropic-client.js';
import type { RaMessage, RaTool } from '../model/ritsu-agent/types.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

interface Captured { url: string; apiKey: string | null; body: Record<string, unknown> }

function captureFetch(sink: Captured[], reply: unknown): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit) => {
    sink.push({
      url: url instanceof Request ? url.url : String(url),
      apiKey: new Headers(init?.headers).get('x-api-key'),
      body: JSON.parse(init?.body as string) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const textReply = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test-001',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 9, output_tokens: 2 },
};

const toolReply = {
  ...textReply,
  content: [
    { type: 'text', text: 'calling echo' },
    { type: 'tool_use', id: 'toolu_1', name: 'echo', input: { msg: 'x' } },
  ],
  stop_reason: 'tool_use',
};

const echoTool: RaTool = {
  name: 'echo',
  description: 'echo back',
  parameters: { type: 'object', properties: { msg: { type: 'string' } } },
  handler: async () => 'ok',
};

describe('toAnthropicMessages', () => {
  it('hoists system, maps roles, renders images as base64 source blocks', () => {
    const messages: RaMessage[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', media_type: 'image/png', data: PNG_1PX },
      ] },
      { role: 'assistant', content: 'a pixel' },
    ];
    const { system, turns } = toAnthropicMessages(messages);
    assert.equal(system, 'be terse');
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0].content, [
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX } },
    ]);
    assert.deepEqual(turns[1], { role: 'assistant', content: [{ type: 'text', text: 'a pixel' }] });
  });

  it('merges parallel tool results into the single next user message', () => {
    const messages: RaMessage[] = [
      { role: 'user', content: 'do both' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'toolu_a', type: 'function', function: { name: 'echo', arguments: '{"msg":"a"}' } },
        { id: 'toolu_b', type: 'function', function: { name: 'echo', arguments: '{"msg":"b"}' } },
      ] },
      { role: 'tool', tool_call_id: 'toolu_a', content: 'result-a' },
      { role: 'tool', tool_call_id: 'toolu_b', content: 'result-b' },
    ];
    const { turns } = toAnthropicMessages(messages);
    assert.equal(turns.length, 3);
    assert.deepEqual(turns[1].content, [
      { type: 'tool_use', id: 'toolu_a', name: 'echo', input: { msg: 'a' } },
      { type: 'tool_use', id: 'toolu_b', name: 'echo', input: { msg: 'b' } },
    ]);
    assert.deepEqual(turns[2], {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: 'result-a' },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: 'result-b' },
      ],
    });
  });
});

describe('AnthropicClient', () => {
  it('hits the Messages API with the key header, default max_tokens, and input_schema tools', async () => {
    const sink: Captured[] = [];
    const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-test', fetchImpl: captureFetch(sink, toolReply) });

    const out = await client.chat([{ role: 'user', content: 'run echo' }], [echoTool]);

    assert.equal(sink.length, 1);
    assert.equal(sink[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(sink[0].apiKey, 'sk-ant-test');
    assert.equal(sink[0].body.max_tokens, 4096);
    assert.ok(!('temperature' in sink[0].body));
    assert.deepEqual(sink[0].body.tools, [
      { name: 'echo', description: 'echo back', input_schema: echoTool.parameters },
    ]);

    assert.equal(out.content, 'calling echo');
    assert.equal(out.model, 'claude-test-001');
    assert.deepEqual(out.tool_calls, [
      { id: 'toolu_1', type: 'function', function: { name: 'echo', arguments: '{"msg":"x"}' } },
    ]);
    assert.deepEqual(out.usage, { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 });
  });

  it('honors provider_options temperature/max_tokens', async () => {
    const sink: Captured[] = [];
    const client = new AnthropicClient({
      apiKey: 'sk-ant-test', model: 'claude-test',
      providerOptions: { temperature: 0.3, max_tokens: 512 },
      fetchImpl: captureFetch(sink, textReply),
    });
    await client.chat([{ role: 'user', content: 'hi' }], []);
    assert.equal(sink[0].body.temperature, 0.3);
    assert.equal(sink[0].body.max_tokens, 512);
  });
});
