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

const KEY = 'key for the test';

interface Sent { body: Record<string, unknown>; signal: AbortSignal | null | undefined }

/** With `hold` the body stays open, and an abort errors it as real fetch does. */
function eventStream(sent: Sent[], text: string, opts: { hold?: boolean; step?: number } = {}): typeof fetch {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push({ body: JSON.parse(init?.body as string) as Record<string, unknown>, signal: init?.signal });
    const bytes = new TextEncoder().encode(text);
    const step = opts.step ?? 6;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += step) controller.enqueue(bytes.slice(i, i + step));
        if (!opts.hold) {
          controller.close();
          return;
        }
        const signal = init?.signal;
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  };
}

function ev(type: string, data: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function messageStart(inputTokens: number): string {
  return ev('message_start', { message: {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test-001', content: [],
    stop_reason: null, stop_sequence: null,
    usage: { input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
  } });
}

/** `toolReply`, streamed. */
const toolStream = [
  messageStart(9),
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  ev('ping'),
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'calling' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' echo' } }),
  ev('content_block_stop', { index: 0 }),
  ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'echo', input: {} } }),
  ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '' } }),
  ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"msg": "' } }),
  ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'x"}' } }),
  ev('content_block_stop', { index: 1 }),
  ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } }),
  ev('message_stop'),
].join('');

describe('AnthropicClient streaming', () => {
  it('hands text deltas over in order and returns what the unstreamed call returns', async () => {
    const sent: Sent[] = [];
    const deltas: string[] = [];
    const streamed = await new AnthropicClient({ apiKey: KEY, model: 'claude-test', fetchImpl: eventStream(sent, toolStream) })
      .chat([{ role: 'user', content: 'run echo' }], [echoTool], { onText: d => deltas.push(d) });
    const unstreamed = await new AnthropicClient({ apiKey: KEY, model: 'claude-test', fetchImpl: captureFetch([], toolReply) })
      .chat([{ role: 'user', content: 'run echo' }], [echoTool]);

    assert.equal(sent[0].body.stream, true);
    assert.equal(sent[0].body.max_tokens, 4096);
    assert.deepEqual(deltas, ['calling', ' echo']);
    assert.equal(streamed.content, deltas.join(''));
    const { raw: _streamedRaw, ...streamedRest } = streamed;
    const { raw: _unstreamedRaw, ...unstreamedRest } = unstreamed;
    assert.deepEqual(streamedRest, unstreamedRest);
    assert.equal((streamed.raw as { id: string }).id, 'msg_1');
  });

  it('assembles several tool calls from fragmented input and keeps thinking out of the text', async () => {
    const text = [
      messageStart(30),
      ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Both at once.' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-for-the-test' } }),
      ev('content_block_stop', { index: 0 }),
      ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_a', name: 'echo', input: {} } }),
      ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"ms' } }),
      ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'g": "a"}' } }),
      ev('content_block_stop', { index: 1 }),
      ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_b', name: 'echo', input: {} } }),
      ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"msg": "b", "opts": {"n"' } }),
      ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: ': 2}}' } }),
      ev('content_block_stop', { index: 2 }),
      ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 45 } }),
      ev('message_stop'),
    ].join('');
    const deltas: string[] = [];
    const out = await new AnthropicClient({ apiKey: KEY, model: 'claude-test', fetchImpl: eventStream([], text) })
      .chat([{ role: 'user', content: 'echo a and b' }], [echoTool], { onText: d => deltas.push(d) });

    assert.deepEqual(deltas, []);
    assert.equal(out.content, '');
    assert.deepEqual(out.tool_calls, [
      { id: 'toolu_a', type: 'function', function: { name: 'echo', arguments: '{"msg":"a"}' } },
      { id: 'toolu_b', type: 'function', function: { name: 'echo', arguments: '{"msg":"b","opts":{"n":2}}' } },
    ]);
    assert.deepEqual(out.usage, { prompt_tokens: 30, completion_tokens: 45, total_tokens: 75 });
  });

  it('rejects promptly when aborted mid-stream, with no text after the abort', { timeout: 5000 }, async () => {
    const sent: Sent[] = [];
    const ac = new AbortController();
    const deltas: string[] = [];
    const text = [
      messageStart(9),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo' } }),
    ].join('');
    const started = Date.now();
    // One read, so 'lo' is already buffered in the SDK when the abort lands.
    const fetchImpl = eventStream(sent, text, { hold: true, step: text.length * 4 });

    await assert.rejects(new AnthropicClient({ apiKey: KEY, model: 'claude-test', fetchImpl }).chat(
      [{ role: 'user', content: 'hi' }], [],
      { signal: ac.signal, onText: d => { deltas.push(d); ac.abort(); } },
    ), /aborted/);

    assert.ok(Date.now() - started < 1000);
    assert.ok(sent[0].signal instanceof AbortSignal);
    assert.deepEqual(deltas, ['Hel']);
  });

  it('leaves the unstreamed request as it was and honors its signal', async () => {
    const sink: Captured[] = [];
    const client = new AnthropicClient({ apiKey: KEY, model: 'claude-test', fetchImpl: captureFetch(sink, textReply) });
    const out = await client.chat([{ role: 'user', content: 'hi' }], [], { signal: new AbortController().signal });
    assert.ok(!('stream' in sink[0].body));
    assert.equal(out.content, 'hello');

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(client.chat([{ role: 'user', content: 'hi' }], [], { signal: ac.signal }), /aborted/);
    assert.equal(sink.length, 1);
  });
});
