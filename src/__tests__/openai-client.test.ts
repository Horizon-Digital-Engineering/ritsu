import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { OpenAICompatClient } from '../model/ritsu-agent/openai-client.js';
import type { RaTool } from '../model/ritsu-agent/types.js';

const KEY = 'key for the test';

interface Sent { url: string; body: Record<string, unknown>; signal: AbortSignal | null | undefined }

/** `step`-byte reads split lines, events and multi-byte characters across reads;
 *  `abortErrors` errors the body on abort, as real fetch does. */
function body(text: string, opts: { step?: number; hold?: boolean; abortErrors?: AbortSignal | null } = {}): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const step = opts.step ?? 5;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += step) controller.enqueue(bytes.slice(i, i + step));
      if (!opts.hold) {
        controller.close();
        return;
      }
      const signal = opts.abortErrors;
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
}

function eventStream(sent: Sent[], text: string, opts: { step?: number; hold?: boolean; ignoreAbort?: boolean } = {}): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: url instanceof Request ? url.url : String(url), body: JSON.parse(init?.body as string) as Record<string, unknown>, signal: init?.signal });
    const abortErrors = opts.ignoreAbort ? null : init?.signal;
    return new Response(body(text, { ...opts, abortErrors }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  };
}

function jsonReply(sent: Sent[], reply: unknown): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: url instanceof Request ? url.url : String(url), body: JSON.parse(init?.body as string) as Record<string, unknown>, signal: init?.signal });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/** One chunk in the shape OpenRouter streams them. */
function chunk(delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) {
  return {
    id: 'gen-1', provider: 'Example', model: 'vendor/model-001', object: 'chat.completion.chunk', created: 1731600000,
    choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: finish, native_finish_reason: finish, logprobs: null }],
    ...extra,
  };
}

const usageChunk = chunk({ content: '' }, null, { usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 } });

function sse(events: unknown[], eol = '\n'): string {
  return events.map(e => `data: ${JSON.stringify(e)}${eol}${eol}`).join('') + `data: [DONE]${eol}${eol}`;
}

const echoTool: RaTool = {
  name: 'echo',
  description: 'echo back',
  parameters: { type: 'object', properties: { msg: { type: 'string' } } },
  handler: async () => 'ok',
};

const toolCallEvents = [
  chunk({ content: 'Running both.' }),
  chunk({ content: null, tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'echo', arguments: '' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"ms' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: 'g":"a"}' } }] }),
  chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'echo', arguments: '{"msg":' } }] }),
  chunk({ tool_calls: [{ index: 1, function: { arguments: '"b"}' } }] }),
  chunk({}, 'tool_calls'),
  usageChunk,
];

const toolCallReply = {
  id: 'gen-1', object: 'chat.completion', created: 1731600000, model: 'vendor/model-001',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: 'Running both.',
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'echo', arguments: '{"msg":"a"}' } },
        { id: 'call_b', type: 'function', function: { name: 'echo', arguments: '{"msg":"b"}' } },
      ],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 },
};

function client(fetchImpl: typeof fetch) {
  return new OpenAICompatClient({ provider: 'openrouter', apiKey: KEY, model: 'vendor/model', fetchImpl });
}

describe('OpenAICompatClient streaming', () => {
  it('asks for a stream with usage and hands text deltas over in order', async () => {
    const sent: Sent[] = [];
    // CRLF endings, a keep-alive comment and `data:` without a space, read
    // one byte at a time so CRLFs and the multi-byte characters split.
    const text = ': OPENROUTER PROCESSING\r\n\r\n'
      + [chunk({ content: '' }), chunk({ content: 'Hel' }), chunk({ content: 'lo ' }), chunk({ content: 'wörld 👋' }), chunk({}, 'stop'), usageChunk]
        .map(e => `data:${JSON.stringify(e)}\r\n\r\n`).join('')
      + 'data: [DONE]\r\n\r\n';
    const deltas: string[] = [];

    const out = await client(eventStream(sent, text, { step: 1 }))
      .chat([{ role: 'user', content: 'hi' }], [], { onText: d => deltas.push(d) });

    assert.equal(sent[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(sent[0].body.stream, true);
    assert.deepEqual(sent[0].body.stream_options, { include_usage: true });
    assert.deepEqual(deltas, ['Hel', 'lo ', 'wörld 👋']);
    assert.equal(out.content, deltas.join(''));
    assert.equal(out.model, 'vendor/model-001');
    assert.deepEqual(out.tool_calls, []);
    assert.deepEqual(out.usage, { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 });
  });

  it('assembles several tool calls from fragments into what the unstreamed reply holds', async () => {
    const deltas: string[] = [];
    const streamed = await client(eventStream([], sse(toolCallEvents)))
      .chat([{ role: 'user', content: 'echo a and b' }], [echoTool], { onText: d => deltas.push(d) });
    const whole = await client(jsonReply([], toolCallReply))
      .chat([{ role: 'user', content: 'echo a and b' }], [echoTool]);

    assert.deepEqual(deltas, ['Running both.']);
    assert.deepEqual(streamed.tool_calls, [
      { id: 'call_a', type: 'function', function: { name: 'echo', arguments: '{"msg":"a"}' } },
      { id: 'call_b', type: 'function', function: { name: 'echo', arguments: '{"msg":"b"}' } },
    ]);
    assert.deepEqual(
      { content: streamed.content, tool_calls: streamed.tool_calls, model: streamed.model, usage: streamed.usage },
      { content: whole.content, tool_calls: whole.tool_calls, model: whole.model, usage: whole.usage },
    );
    assert.deepEqual(streamed.raw, toolCallReply);
  });

  it('takes whole calls from servers that send them without an index', async () => {
    const events = [
      chunk({ tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'echo', arguments: '{"msg":"a"}' } },
        { id: 'call_b', type: 'function', function: { name: 'echo', arguments: '{"msg":"b"}' } },
      ] }, 'tool_calls'),
    ];
    const out = await client(eventStream([], sse(events))).chat([{ role: 'user', content: 'go' }], [echoTool], { onText: () => undefined });
    assert.deepEqual(out.tool_calls.map(c => [c.id, c.function.arguments]), [['call_a', '{"msg":"a"}'], ['call_b', '{"msg":"b"}']]);
    assert.equal(out.usage, undefined);
  });

  it('reads a JSON answer to a stream request as the whole reply, handing its text over once', async () => {
    const reply = { ...toolCallReply, choices: [{ index: 0, message: { role: 'assistant', content: 'all at once' }, finish_reason: 'stop' }] };
    const deltas: string[] = [];
    const out = await client(jsonReply([], reply)).chat([{ role: 'user', content: 'hi' }], [], { onText: d => deltas.push(d) });
    assert.deepEqual(deltas, ['all at once']);
    assert.equal(out.content, 'all at once');
    assert.deepEqual(out.usage, reply.usage);
  });

  it('stops reading at [DONE] even when the server keeps the connection open', { timeout: 5000 }, async () => {
    const text = sse([chunk({ content: 'done' }), chunk({}, 'stop')]);
    const out = await client(eventStream([], text, { hold: true, ignoreAbort: true }))
      .chat([{ role: 'user', content: 'hi' }], [], { onText: () => undefined });
    assert.equal(out.content, 'done');
  });

  it('rejects with the message of an error event sent mid-stream', async () => {
    const text = `data: ${JSON.stringify(chunk({ content: 'par' }))}\n\n`
      + `data: ${JSON.stringify({ error: { code: 502, message: 'upstream overloaded' } })}\n\n`;
    await assert.rejects(
      client(eventStream([], text)).chat([{ role: 'user', content: 'hi' }], [], { onText: () => undefined }),
      /upstream overloaded/,
    );
  });

  it('turns an HTTP error into a provider error', async () => {
    const fetchImpl: typeof fetch = async () => new Response('{"error":{"message":"slow down"}}', { status: 429 });
    await assert.rejects(
      client(fetchImpl).chat([{ role: 'user', content: 'hi' }], [], { onText: () => undefined }),
      /provider 429: .*slow down/,
    );
  });

  for (const ignoreAbort of [false, true]) {
    it(`rejects promptly when aborted mid-stream${ignoreAbort ? ', even if fetch ignores the signal' : ''}`, { timeout: 5000 }, async () => {
      const sent: Sent[] = [];
      const ac = new AbortController();
      const text = `data: ${JSON.stringify(chunk({ content: 'Hel' }))}\n\ndata: ${JSON.stringify(chunk({ content: 'lo' }))}\n\n`;
      const deltas: string[] = [];
      const started = Date.now();

      // One read, so the second event is already buffered when the abort lands.
      await assert.rejects(client(eventStream(sent, text, { hold: true, ignoreAbort, step: text.length })).chat(
        [{ role: 'user', content: 'hi' }], [],
        { signal: ac.signal, onText: d => { deltas.push(d); ac.abort(); } },
      ), { name: 'AbortError' });

      assert.ok(Date.now() - started < 1000);
      assert.equal(sent[0].signal, ac.signal);
      assert.deepEqual(deltas, ['Hel']);
    });
  }

  it('leaves the unstreamed request as it was and passes the signal through', async () => {
    const sent: Sent[] = [];
    const ac = new AbortController();
    const out = await client(jsonReply(sent, toolCallReply)).chat([{ role: 'user', content: 'hi' }], [echoTool], { signal: ac.signal });
    assert.ok(!('stream' in sent[0].body));
    assert.ok(!('stream_options' in sent[0].body));
    assert.equal(sent[0].body.temperature, 0.7);
    assert.equal(sent[0].body.max_tokens, 4096);
    assert.equal(sent[0].signal, ac.signal);
    assert.equal(out.tool_calls.length, 2);
    assert.deepEqual(out.raw, toolCallReply);
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
  const hello = { ...toolCallReply, choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there.' }, finish_reason: 'stop' }] };
  const json = (code: number, value: unknown): Response =>
    new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } });
  return async (url: string | URL | Request, init?: RequestInit) => {
    const sentBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    sent.push({ url: url instanceof Request ? url.url : String(url), body: sentBody, signal: init?.signal });
    onRequest?.();
    if (refuses(sentBody)) return json(status, error);
    // No JSON content type: a whole reply is read as JSON regardless, like any unstreamed one.
    if (!sentBody.stream) return new Response(JSON.stringify(hello), { status: 200 });
    const events = [chunk({ content: 'Hello' }), chunk({ content: ' there.' }), chunk({}, 'stop'), usageChunk];
    return new Response(body(sse(events)), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

describe('OpenAICompatClient when the provider refuses a streamed request', () => {
  // The dispatcher builds a client per turn.
  const ask = (baseUrl: string, fetchImpl: typeof fetch, deltas: string[] = [], signal?: AbortSignal) =>
    new OpenAICompatClient({ provider: 'custom', apiKey: KEY, model: 'strict-model', providerOptions: { base_url: baseUrl }, fetchImpl })
      .chat([{ role: 'user', content: 'hi' }], [], { onText: d => deltas.push(d), signal });

  it('asks again still streaming when refused for `stream_options`, and later turns leave it out', async () => {
    const sent: Sent[] = [];
    const fetchImpl = refusing(sent, b => 'stream_options' in b, 422, extraInput);
    const deltas: string[] = [];
    const out = await ask('https://strict.example.test/v1', fetchImpl, deltas);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].body.stream_options, { include_usage: true });
    assert.equal(sent[1].body.stream, true);
    assert.ok(!('stream_options' in sent[1].body));
    assert.deepEqual(deltas, ['Hello', ' there.']);
    assert.equal(out.content, 'Hello there.');
    assert.deepEqual(out.usage, { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 });

    await ask('https://strict.example.test/v1', fetchImpl);
    assert.equal(sent.length, 3);
    assert.equal(sent[2].body.stream, true);
    assert.ok(!('stream_options' in sent[2].body));
  });

  it('asks again unstreamed when refused for `stream`, hands the text over once, and later turns skip the stream', async () => {
    const sent: Sent[] = [];
    const fetchImpl = refusing(sent, b => b.stream === true, 400, mustVerify);
    const deltas: string[] = [];
    const out = await ask('https://unverified.example.test/v1', fetchImpl, deltas);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].body.stream, true);
    assert.ok(!('stream' in sent[1].body) && !('stream_options' in sent[1].body));
    assert.deepEqual(deltas, ['Hello there.']);
    assert.equal(out.content, 'Hello there.');

    const next: string[] = [];
    await ask('https://unverified.example.test/v1', fetchImpl, next);
    assert.equal(sent.length, 3);
    assert.ok(!('stream' in sent[2].body));
    assert.deepEqual(next, ['Hello there.']);
  });

  it('throws any other 400 as before, without asking again', async () => {
    const sent: Sent[] = [];
    const upstream = { error: { message: 'Upstream provider rejected the request: tool schema is invalid', code: 400 } };
    await assert.rejects(
      ask('https://other.example.test/v1', refusing(sent, () => true, 400, upstream)),
      /provider 400: .*Upstream provider rejected/,
    );
    assert.equal(sent.length, 1);
  });

  it('does not ask again when the turn was stopped as the refusal came back', async () => {
    const sent: Sent[] = [];
    const ac = new AbortController();
    const fetchImpl = refusing(sent, b => b.stream === true, 400, mustVerify, () => ac.abort());
    await assert.rejects(ask('https://stopped.example.test/v1', fetchImpl, [], ac.signal), /provider 400: .*verified to stream/);
    assert.equal(sent.length, 1);
  });

  it('remembers a refusal only once the request without it is accepted', async () => {
    const sent: Sent[] = [];
    // A validation error that echoes the request names stream_options without refusing it.
    const echoed = { detail: [{ type: 'value_error', loc: ['body'], msg: 'Value error, tool_choice needs tools', input: { stream: true, stream_options: { include_usage: true } } }] };
    const fetchImpl = refusing(sent, () => true, 422, echoed);
    await assert.rejects(ask('https://echo.example.test/v1', fetchImpl), /provider 422: .*tool_choice needs tools/);
    await assert.rejects(ask('https://echo.example.test/v1', fetchImpl), /provider 422/);
    assert.deepEqual(sent.map(s => 'stream_options' in s.body), [true, false, true, false]);
  });
});
