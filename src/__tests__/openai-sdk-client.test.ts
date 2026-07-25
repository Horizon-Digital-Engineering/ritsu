import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { OpenAISdkClient } from '../model/ritsu-agent/openai-sdk-client.js';
import type { RaTool } from '../model/ritsu-agent/types.js';

interface Captured { url: string; auth: string | null; body: Record<string, unknown> }

/** Capture the SDK's outgoing request and reply with a canned completion. */
function captureFetch(sink: Captured[], reply: unknown): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit) => {
    sink.push({
      url: url instanceof Request ? url.url : String(url),
      auth: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(init?.body as string) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const reply = {
  id: 'c1', model: 'gpt-test-001', object: 'chat.completion',
  choices: [{
    index: 0,
    message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"msg":"x"}' } }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
};

const echoTool: RaTool = {
  name: 'echo',
  description: 'echo back',
  parameters: { type: 'object', properties: { msg: { type: 'string' } } },
  handler: async () => 'ok',
};

describe('OpenAISdkClient', () => {
  it('hits the official endpoint with the bearer key and translates tool calls back', async () => {
    const sink: Captured[] = [];
    const client = new OpenAISdkClient({ apiKey: 'sk-test', model: 'gpt-test', fetchImpl: captureFetch(sink, reply) });

    const out = await client.chat([{ role: 'user', content: 'run echo' }], [echoTool]);

    assert.equal(sink.length, 1);
    assert.equal(sink[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(sink[0].auth, 'Bearer sk-test');
    assert.deepEqual(sink[0].body.tools, [{
      type: 'function',
      function: { name: 'echo', description: 'echo back', parameters: echoTool.parameters },
    }]);
    assert.equal(sink[0].body.tool_choice, 'auto');

    assert.equal(out.model, 'gpt-test-001');
    assert.deepEqual(out.tool_calls, [
      { id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"msg":"x"}' } },
    ]);
    assert.deepEqual(out.usage, { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 });
  });

  it('sends sampling params only when set (reasoning models reject defaults)', async () => {
    const sink: Captured[] = [];
    const bare = new OpenAISdkClient({ apiKey: 'sk-test', model: 'gpt-test', fetchImpl: captureFetch(sink, reply) });
    await bare.chat([{ role: 'user', content: 'hi' }], []);
    assert.ok(!('temperature' in sink[0].body));
    assert.ok(!('max_tokens' in sink[0].body));
    assert.ok(!('max_completion_tokens' in sink[0].body));

    const tuned = new OpenAISdkClient({
      apiKey: 'sk-test', model: 'gpt-test',
      providerOptions: { temperature: 0.1, max_tokens: 256 },
      fetchImpl: captureFetch(sink, reply),
    });
    await tuned.chat([{ role: 'user', content: 'hi' }], []);
    assert.equal(sink[1].body.temperature, 0.1);
    assert.equal(sink[1].body.max_completion_tokens, 256);
    assert.ok(!('max_tokens' in sink[1].body));
  });

  it('honors a base_url override', async () => {
    const sink: Captured[] = [];
    const client = new OpenAISdkClient({
      apiKey: 'sk-test', model: 'gpt-test',
      providerOptions: { base_url: 'http://localhost:9999/v1/' },
      fetchImpl: captureFetch(sink, reply),
    });
    await client.chat([{ role: 'user', content: 'hi' }], []);
    assert.equal(sink[0].url, 'http://localhost:9999/v1/chat/completions');
  });
});
