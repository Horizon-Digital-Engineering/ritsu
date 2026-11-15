/**
 * Minimal OpenAI-compatible Chat Completions client. Speaks the standard
 *  POST /v1/chat/completions shape that everything without a first-party
 *  JS SDK has converged on: xAI (their documented path), OpenRouter,
 *  Together, Groq, Ollama (local), LiteLLM (proxy), and many more. The
 *  provider name selects a default base_url; everything else is identical.
 *  First-party providers (`anthropic`, `openai`, `gemini`) use their
 *  official SDK clients instead.
 *
 *  Tool calling: standard `tools: [{type: 'function', function: {...}}]`
 *  input format; response includes `tool_calls` on the assistant message
 *  when the model wants to invoke functions. We translate verbatim.
 *
 *  Streams fold back into the unstreamed body so both paths share one
 *  translation. Some servers ignore `stream: true` and send plain JSON.
 */
import type { RaClient, RaChatOptions, RaMessage, RaTool, RaCompletion, RaToolCall, RaProviderOptions } from './types.js';
import { stripTrailingSlashes } from '../../util/path-utils.js';

export type CompatProvider = 'xai' | 'openrouter' | 'litellm' | 'custom';

/** Default base URLs per provider hint. `custom` has none by design —
 *  the definition schema requires provider_options.base_url for it. */
const DEFAULT_BASE_URLS: Record<CompatProvider, string> = {
  xai: 'https://api.x.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  litellm: 'http://localhost:4000/v1',
  custom: '',
};

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: string | null;
}

export interface OpenAIResponse {
  id: string;
  object?: string;
  created?: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** Loose on purpose: compatible servers differ in what they omit. */
export interface OpenAIStreamChunk {
  id?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: { content?: string | null; tool_calls?: ToolCallDelta[] } | null;
    finish_reason?: string | null;
  }>;
  usage?: OpenAIResponse['usage'] | null;
}

export interface OpenAIClientOpts {
  provider: CompatProvider;
  apiKey: string;
  model: string;
  providerOptions?: RaProviderOptions;
  /** Injected by tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class OpenAICompatClient implements RaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIClientOpts) {
    const baseUrl = opts.providerOptions?.base_url ?? DEFAULT_BASE_URLS[opts.provider];
    if (!baseUrl) throw new Error(`provider '${opts.provider}' requires provider_options.base_url`);
    this.baseUrl = stripTrailingSlashes(baseUrl);
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.temperature = opts.providerOptions?.temperature ?? 0.7;
    this.maxTokens = opts.providerOptions?.max_tokens ?? 4096;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** One round-trip. Sends current messages + tool defs; receives the
   *  assistant's reply (text and/or tool_calls). */
  async chat(messages: RaMessage[], tools: RaTool[], opts: RaChatOptions = {}): Promise<RaCompletion> {
    const { onText, signal } = opts;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toOpenAIMessage),
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }

    if (!onText) {
      const res = await this.post(body, 'stream', signal);
      return toCompletion(await res.json() as OpenAIResponse);
    }

    const emit = (delta: string): void => {
      if (!signal?.aborted) onText(delta);
    };
    const { sent: res, omit } = await sendStreamed(`${this.baseUrl} ${this.model}`, signal, o => this.post(body, o, signal), readProviderError);
    if (omit === 'stream' || isJsonResponse(res)) {
      const completion = toCompletion(await res.json() as OpenAIResponse);
      if (completion.content) emit(completion.content);
      return completion;
    }
    if (!res.body) throw new Error('provider sent an empty stream');
    const fold = new ChunkFold(emit);
    for await (const data of sseData(res.body, signal)) fold.add(parseChunk(data));
    signal?.throwIfAborted();
    return toCompletion(fold.response());
  }

  private async post(body: Record<string, unknown>, omit: StreamField | undefined, signal: AbortSignal | undefined): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Keyless local proxies (litellm/custom) get no Authorization header.
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...body,
        ...(omit === 'stream' ? {} : { stream: true }),
        ...(omit ? {} : { stream_options: { include_usage: true } }),
      }),
      signal,
    });
    if (!res.ok) throw new ProviderError(res.status, await res.text());
    return res;
  }
}

class ProviderError extends Error {
  constructor(readonly status: number, readonly text: string) {
    super(`provider ${status}: ${text.slice(0, 400)}`);
  }
}

function readProviderError(err: unknown): Refusal | undefined {
  return err instanceof ProviderError ? { status: err.status, param: errorParam(err.text), text: err.text } : undefined;
}

function toCompletion(json: OpenAIResponse): RaCompletion {
  const choice = json.choices[0];
  if (!choice) throw new Error('provider returned no choices');

  const toolCalls: RaToolCall[] = (choice.message.tool_calls ?? []).map(tc => ({
    id: tc.id,
    type: 'function',
    function: { name: tc.function.name, arguments: tc.function.arguments },
  }));

  return {
    content: choice.message.content ?? '',
    tool_calls: toolCalls,
    model: json.model,
    usage: json.usage,
    raw: json,
  };
}

export function isJsonResponse(res: Response): boolean {
  const type = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  return type === 'application/json' || type.endsWith('+json');
}

/** A streaming param a provider refused. Leaving out `stream` leaves out both. */
export type StreamField = 'stream' | 'stream_options';

export interface Refusal { status: number; param: unknown; text: string }

/** Per process, not per client: the dispatcher builds a client per turn. */
const streamRefusals = new Map<string, StreamField>();

/** Some servers refuse `stream_options` or `stream`: retry without it, and remember that once accepted. */
export async function sendStreamed<T>(
  endpoint: string,
  signal: AbortSignal | undefined,
  send: (omit: StreamField | undefined) => Promise<T>,
  readError: (err: unknown) => Refusal | undefined,
  omit = streamRefusals.get(endpoint),
): Promise<{ sent: T; omit: StreamField | undefined }> {
  try {
    const sent = await send(omit);
    if (omit) streamRefusals.set(endpoint, omit);
    return { sent, omit };
  } catch (err) {
    const refusal = signal?.aborted ? undefined : readError(err);
    const refused = refusal && refusedField(refusal, omit);
    if (!refused) throw err;
    return sendStreamed(endpoint, signal, send, readError, refused);
  }
}

/** OpenAI names the refused field in `param`; servers rejecting unknown fields only in the message. */
function refusedField({ status, param, text }: Refusal, omitted: StreamField | undefined): StreamField | undefined {
  if ((status !== 400 && status !== 422) || omitted === 'stream') return undefined;
  if (param === 'stream') return 'stream';
  return !omitted && (param === 'stream_options' || text.includes('stream_options')) ? 'stream_options' : undefined;
}

function errorParam(text: string): unknown {
  try {
    return (JSON.parse(text) as { error?: { param?: unknown } } | null)?.error?.param;
  } catch {
    return undefined;
  }
}

export class ChunkFold {
  private id = '';
  private created: number | undefined;
  private model = '';
  private content: string | null = null;
  private finishReason: string | null = null;
  private usage: OpenAIResponse['usage'];
  private sawChoice = false;
  private readonly calls = new Map<number, OpenAIToolCall>();
  private lastSlot = -1;

  constructor(private readonly onText: (delta: string) => void) {}

  add(chunk: OpenAIStreamChunk): void {
    this.id ||= chunk.id ?? '';
    this.created ??= chunk.created;
    if (chunk.model) this.model = chunk.model;
    if (chunk.usage) this.usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      if ((choice.index ?? 0) !== 0) continue;
      this.sawChoice = true;
      const text = choice.delta?.content;
      if (text) {
        this.content = (this.content ?? '') + text;
        this.onText(text);
      }
      for (const tc of choice.delta?.tool_calls ?? []) this.addToolCall(tc);
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
  }

  /** Calls arrive by index, id and name first, then argument fragments.
   *  Servers that leave out the index send each call whole. */
  private addToolCall(tc: ToolCallDelta): void {
    const last = this.calls.get(this.lastSlot);
    const slot = tc.index ?? (last && (!tc.id || tc.id === last.id) ? this.lastSlot : this.calls.size);
    let call = this.calls.get(slot);
    if (!call) {
      call = { id: '', type: 'function', function: { name: '', arguments: '' } };
      this.calls.set(slot, call);
    }
    this.lastSlot = slot;
    if (tc.id) call.id = tc.id;
    if (tc.function?.name) call.function.name = tc.function.name;
    if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
  }

  response(): OpenAIResponse {
    const toolCalls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    const choices: OpenAIChoice[] = this.sawChoice
      ? [{
          index: 0,
          message: {
            role: 'assistant',
            content: this.content,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: this.finishReason,
        }]
      : [];
    return {
      id: this.id,
      object: 'chat.completion',
      ...(this.created === undefined ? {} : { created: this.created }),
      model: this.model,
      choices,
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}

function parseChunk(data: string): OpenAIStreamChunk {
  let chunk: OpenAIStreamChunk & { error?: unknown };
  try {
    chunk = JSON.parse(data) as OpenAIStreamChunk & { error?: unknown };
  } catch {
    throw new Error('provider sent a malformed stream event');
  }
  if (chunk.error) {
    const message = (chunk.error as { message?: unknown }).message;
    throw new Error(`provider error: ${typeof message === 'string' ? message : JSON.stringify(chunk.error).slice(0, 400)}`);
  }
  return chunk;
}

async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  // Ends a read that a fetch ignoring the signal would leave hanging.
  const cancel = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal?.aborted) return;
      pending += decoder.decode(value, { stream: !done });
      // A trailing CR may be the first half of a CRLF split across reads.
      const held = !done && pending.endsWith('\r') ? 1 : 0;
      const lines = pending.slice(0, pending.length - held).split(/\r\n|\r|\n/);
      pending = done ? '' : (lines.pop() ?? '') + pending.slice(pending.length - held);
      if (done) lines.push('');
      for (const line of lines) {
        if (line.startsWith('data:')) {
          data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
        } else if (line === '' && data.length > 0) {
          const event = data.join('\n');
          data = [];
          if (event === '[DONE]') return;
          yield event;
        }
      }
      if (done) return;
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
  }
}

export function toOpenAIMessage(m: RaMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: toOpenAIContent(m.content) };
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.tool_calls && m.tool_calls.length > 0) out.tool_calls = m.tool_calls;
  if (m.name) out.name = m.name;
  return out;
}

/** Render content for the OpenAI Chat Completions API. Plain strings pass
 *  through; block arrays become the multi-part `[{type:'text'},{type:'image_url'}]`
 *  shape, with images as base64 `data:` URLs (the OpenAI-compat vision format). */
function toOpenAIContent(content: RaMessage['content']): unknown {
  if (typeof content === 'string') return content;
  return content.map(b =>
    b.type === 'text'
      ? { type: 'text', text: b.text }
      : { type: 'image_url', image_url: { url: `data:${b.media_type};base64,${b.data}` } },
  );
}
