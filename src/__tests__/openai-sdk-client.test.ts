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

describe('OpenAICompatClient provider defaults', () => {
  it('xai routes to api.x.ai; keyless litellm sends no Authorization header', async () => {
    const { OpenAICompatClient } = await import('../model/ritsu-agent/openai-client.js');
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      seen.push({ url: url instanceof Request ? url.url : String(url), auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await new OpenAICompatClient({ provider: 'xai', apiKey: 'xai-test', model: 'grok-test', fetchImpl })
      .chat([{ role: 'user', content: 'hi' }], []);
    assert.equal(seen[0].url, 'https://api.x.ai/v1/chat/completions');
    assert.equal(seen[0].auth, 'Bearer xai-test');

    await new OpenAICompatClient({ provider: 'litellm', apiKey: '', model: 'm', fetchImpl })
      .chat([{ role: 'user', content: 'hi' }], []);
    assert.equal(seen[1].url, 'http://localhost:4000/v1/chat/completions');
    assert.equal(seen[1].auth, null);
  });

  it("custom without base_url refuses to construct", async () => {
    const { OpenAICompatClient } = await import('../model/ritsu-agent/openai-client.js');
    assert.throws(() => new OpenAICompatClient({ provider: 'custom', apiKey: 'k', model: 'm' }), /base_url/);
  });
});

const KEY = 'key for the test';

interface Sent { body: Record<string, unknown>; signal: AbortSignal | null | undefined }

/** With `hold` the body stays open, and an abort errors it as real fetch does. */
function eventStream(sent: Sent[], text: string, opts: { hold?: boolean; step?: number } = {}): typeof fetch {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push({ body: JSON.parse(init?.body as string) as Record<string, unknown>, signal: init?.signal });
    const bytes = new TextEncoder().encode(text);
    const step = opts.step ?? 5;
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

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1731600000, model: 'gpt-test-001',
    service_tier: 'default', system_fingerprint: 'fp_test', obfuscation: 'pad',
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    usage: null,
  };
}

const finalUsage = {
  ...chunk({}), choices: [],
  usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } },
};

function sse(events: unknown[]): string {
  return events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

describe('OpenAISdkClient streaming', () => {
  it('streams with usage in the final chunk and hands text deltas over in order', async () => {
    const sent: Sent[] = [];
    const events = [
      chunk({ role: 'assistant', content: '', refusal: null }),
      chunk({ content: 'Two' }), chunk({ content: ' plus two' }), chunk({ content: ' is four.' }),
      chunk({}, 'stop'),
      finalUsage,
    ];
    const deltas: string[] = [];
    const out = await new OpenAISdkClient({ apiKey: KEY, model: 'gpt-test', fetchImpl: eventStream(sent, sse(events)) })
      .chat([{ role: 'user', content: '2+2?' }], [], { onText: d => deltas.push(d) });

    assert.equal(sent[0].body.stream, true);
    assert.deepEqual(sent[0].body.stream_options, { include_usage: true });
    assert.deepEqual(deltas, ['Two', ' plus two', ' is four.']);
    assert.equal(out.content, 'Two plus two is four.');
    assert.equal(out.model, 'gpt-test-001');
    assert.deepEqual(out.tool_calls, []);
    assert.deepEqual(out.usage, { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 });
  });

  it('assembles parallel tool calls from fragments into what the unstreamed reply returns', async () => {
    const events = [
      chunk({ role: 'assistant', content: null, refusal: null, tool_calls: [
        { index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '' } },
      ] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"m' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'echo', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'sg":"x"}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '{"msg":"y"}' } }] }),
      chunk({}, 'tool_calls'),
      finalUsage,
    ];
    const whole = {
      ...reply,
      choices: [{
        ...reply.choices[0],
        message: { ...reply.choices[0].message, tool_calls: [
          ...reply.choices[0].message.tool_calls,
          { id: 'call_2', type: 'function', function: { name: 'echo', arguments: '{"msg":"y"}' } },
        ] },
      }],
    };
    const deltas: string[] = [];
    const streamed = await new OpenAISdkClient({ apiKey: KEY, model: 'gpt-test', fetchImpl: eventStream([], sse(events)) })
      .chat([{ role: 'user', content: 'run echo twice' }], [echoTool], { onText: d => deltas.push(d) });
    const unstreamed = await new OpenAISdkClient({ apiKey: KEY, model: 'gpt-test', fetchImpl: captureFetch([], whole) })
      .chat([{ role: 'user', content: 'run echo twice' }], [echoTool]);

    assert.deepEqual(deltas, []);
    assert.deepEqual(streamed.tool_calls, [
      { id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"msg":"x"}' } },
      { id: 'call_2', type: 'function', function: { name: 'echo', arguments: '{"msg":"y"}' } },
    ]);
    const { raw: _streamedRaw, ...streamedRest } = streamed;
    const { raw: _unstreamedRaw, ...unstreamedRest } = unstreamed;
    assert.deepEqual(streamedRest, unstreamedRest);
    assert.deepEqual((streamed.raw as typeof whole).choices[0].message, { role: 'assistant', content: null, tool_calls: whole.choices[0].message.tool_calls });
  });

  it('reads a JSON answer to a stream request as the whole reply, handing its text over once', async () => {
    const sent: Captured[] = [];
    const text = { ...reply, choices: [{ index: 0, message: { role: 'assistant', content: 'in one piece' }, finish_reason: 'stop' }] };
    const deltas: string[] = [];
    const out = await new OpenAISdkClient({ apiKey: KEY, model: 'gpt-test', fetchImpl: captureFetch(sent, text) })
      .chat([{ role: 'user', content: 'hi' }], [], { onText: d => deltas.push(d) });
    assert.equal(sent[0].body.stream, true);
    assert.deepEqual(deltas, ['in one piece']);
    assert.equal(out.content, 'in one piece');
    assert.deepEqual(out.usage, { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 });
  });

  it('rejects promptly when aborted mid-stream, with no text after the abort', { timeout: 5000 }, async () => {
    const sent: Sent[] = [];
    const ac = new AbortController();
    const deltas: string[] = [];
    const text = sse([chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hel' }), chunk({ content: 'lo' })]).replace('data: [DONE]\n\n', '');
    const started = Date.now();
    // One read, so the second event is already buffered when the abort lands.
    const fetchImpl = eventStream(sent, text, { hold: true, step: text.length });

    await assert.rejects(new OpenAISdkClient({ apiKey: KEY, model: 'gpt-test', fetchImpl }).chat(
      [{ role: 'user', content: 'hi' }], [],
      { signal: ac.signal, onText: d => { deltas.push(d); ac.abort(); } },
    ), { name: 'AbortError' });

    assert.ok(Date.now() - started < 1000);
    assert.ok(sent[0].signal instanceof AbortSignal);
    assert.deepEqual(deltas, ['Hel']);
  });

  it('leaves the unstreamed request as it was and honors its signal', async () => {
    const sent: Captured[] = [];
    const client = new OpenAISdkClient({ apiKey: KEY, model: 'gpt-test', fetchImpl: captureFetch(sent, reply) });
    const out = await client.chat([{ role: 'user', content: 'hi' }], [], { signal: new AbortController().signal });
    assert.ok(!('stream' in sent[0].body));
    assert.ok(!('stream_options' in sent[0].body));
    assert.equal(out.tool_calls.length, 1);

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(client.chat([{ role: 'user', content: 'hi' }], [], { signal: ac.signal }));
    assert.equal(sent.length, 1);
  });
});

/** OpenAI's answer to a streamed request from an organization not verified to stream the model. */
const mustVerify = {
  error: {
    message: 'Your organization must be verified to stream this model.',
    type: 'invalid_request_error', param: 'stream', code: 'unsupported_value',
  },
};

/** A strict server's answer to a field it does not know (Mistral's shape). */
const extraInput = {
  object: 'error',
  message: { detail: [{ type: 'extra_forbidden', loc: ['body', 'stream_options'], msg: 'Extra inputs are not permitted', input: { include_usage: true } }] },
  type: 'invalid_request_error', param: null, code: null,
};

function refusing(sent: Sent[], refuses: (body: Record<string, unknown>) => boolean, status: number, error: unknown, onRequest?: () => void): typeof fetch {
  const hello = { ...reply, choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there.' }, finish_reason: 'stop' }] };
  const json = (code: number, value: unknown): Response =>
    new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } });
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    sent.push({ body, signal: init?.signal });
    onRequest?.();
    if (refuses(body)) return json(status, error);
    if (!body.stream) return json(200, hello);
    const events = [chunk({ role: 'assistant', content: '' }), chunk({ content: 'Hello' }), chunk({ content: ' there.' }), chunk({}, 'stop'), finalUsage];
    return new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

describe('OpenAISdkClient when the provider refuses a streamed request', () => {
  const ask = (client: OpenAISdkClient, deltas: string[], signal?: AbortSignal) =>
    client.chat([{ role: 'user', content: 'hi' }], [], { onText: d => deltas.push(d), signal });

  it('asks again unstreamed when refused for `stream`, hands the text over once, and later turns skip the stream', async () => {
    const sent: Sent[] = [];
    const fetchImpl = refusing(sent, b => b.stream === true, 400, mustVerify);
    // The dispatcher builds a client per turn.
    const turn = (deltas: string[]) => ask(new OpenAISdkClient({ apiKey: KEY, model: 'gpt-unverified', fetchImpl }), deltas);

    const deltas: string[] = [];
    const out = await turn(deltas);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].body.stream, true);
    assert.ok(!('stream' in sent[1].body) && !('stream_options' in sent[1].body));
    assert.deepEqual(deltas, ['Hello there.']);
    assert.equal(out.content, 'Hello there.');
    assert.deepEqual(out.usage, { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 });

    const next: string[] = [];
    await turn(next);
    assert.equal(sent.length, 3);
    assert.ok(!('stream' in sent[2].body));
    assert.deepEqual(next, ['Hello there.']);

    const other: Sent[] = [];
    await ask(new OpenAISdkClient({ apiKey: KEY, model: 'gpt-other', fetchImpl: refusing(other, () => false, 400, mustVerify) }), []);
    assert.equal(other[0].body.stream, true, 'another model at the same endpoint still streams');
  });

  it('asks again still streaming when refused for `stream_options`, and later turns leave it out', async () => {
    const sent: Sent[] = [];
    const fetchImpl = refusing(sent, b => 'stream_options' in b, 422, extraInput);
    const turn = (deltas: string[]) => ask(new OpenAISdkClient({
      apiKey: KEY, model: 'strict-model', providerOptions: { base_url: 'https://strict.example.test/v1' }, fetchImpl,
    }), deltas);

    const deltas: string[] = [];
    const out = await turn(deltas);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].body.stream_options, { include_usage: true });
    assert.equal(sent[1].body.stream, true);
    assert.ok(!('stream_options' in sent[1].body));
    assert.deepEqual(deltas, ['Hello', ' there.']);
    assert.equal(out.content, 'Hello there.');

    await turn([]);
    assert.equal(sent.length, 3);
    assert.equal(sent[2].body.stream, true);
    assert.ok(!('stream_options' in sent[2].body));
  });

  it('throws any other 400 as before, without asking again', async () => {
    const sent: Sent[] = [];
    const tooLong = { error: {
      message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
      type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded',
    } };
    await assert.rejects(
      ask(new OpenAISdkClient({ apiKey: KEY, model: 'gpt-long', fetchImpl: refusing(sent, () => true, 400, tooLong) }), []),
      { status: 400, param: 'messages', message: /maximum context length/ },
    );
    assert.equal(sent.length, 1);
  });

  it('does not ask again when the turn was stopped as the refusal came back', async () => {
    const sent: Sent[] = [];
    const ac = new AbortController();
    const fetchImpl = refusing(sent, b => b.stream === true, 400, mustVerify, () => ac.abort());
    await assert.rejects(ask(new OpenAISdkClient({ apiKey: KEY, model: 'gpt-stopped', fetchImpl }), [], ac.signal), { status: 400, param: 'stream' });
    assert.equal(sent.length, 1);
  });
});
