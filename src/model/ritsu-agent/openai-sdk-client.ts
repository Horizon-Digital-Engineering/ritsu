/**
 * OpenAI provider client backed by the official `openai` SDK (typed
 * params, automatic retries, request-id surfacing). Only used for the
 * `openai` provider hint — aggregators/proxies keep the minimal wire
 * client in openai-client.ts.
 *
 * Parameter policy: temperature and max tokens are sent ONLY when set in
 * provider_options. OpenAI's reasoning models (o-series, gpt-5 family)
 * reject non-default temperature and require `max_completion_tokens`, so
 * unconditional defaults would break them.
 */
import OpenAI from 'openai';
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import type { RaClient, RaChatOptions, RaMessage, RaTool, RaCompletion, RaToolCall, RaProviderOptions } from './types.js';
import { ChunkFold, isJsonResponse, sendStreamed, toOpenAIMessage, type OpenAIResponse, type Refusal, type StreamField } from './openai-client.js';
import { stripTrailingSlashes } from '../../util/path-utils.js';

export interface OpenAISdkClientOpts {
  apiKey: string;
  model: string;
  providerOptions?: RaProviderOptions;
  /** Injected by tests; defaults to the SDK's own fetch. */
  fetchImpl?: typeof fetch;
}

export class OpenAISdkClient implements RaClient {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly providerOptions: RaProviderOptions;

  constructor(opts: OpenAISdkClientOpts) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.providerOptions?.base_url
        ? { baseURL: stripTrailingSlashes(opts.providerOptions.base_url) }
        : {}),
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
    this.model = opts.model;
    this.providerOptions = opts.providerOptions ?? {};
  }

  async chat(messages: RaMessage[], tools: RaTool[], opts: RaChatOptions = {}): Promise<RaCompletion> {
    const { onText, signal } = opts;
    const body: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      // We render the wire shape ourselves (shared with the compat client);
      // cast into the SDK's param union.
      messages: messages.map(toOpenAIMessage) as unknown as ChatCompletionCreateParamsNonStreaming['messages'],
    };
    if (this.providerOptions.temperature !== undefined) body.temperature = this.providerOptions.temperature;
    if (this.providerOptions.max_tokens !== undefined) body.max_completion_tokens = this.providerOptions.max_tokens;
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }

    if (!onText) return toCompletion(await this.client.chat.completions.create(body, { signal }));

    const emit = (delta: string): void => {
      if (!signal?.aborted) onText(delta);
    };
    const whole = (completion: RaCompletion): RaCompletion => {
      if (completion.content) emit(completion.content);
      return completion;
    };
    const { sent } = await sendStreamed(`${this.client.baseURL} ${this.model}`, signal, omit => this.send(body, omit, signal), readApiError);
    if ('completion' in sent) return whole(toCompletion(sent.completion));
    const { data: stream, response } = sent;
    // A base_url server may ignore `stream: true` and answer with plain JSON.
    if (isJsonResponse(response)) return whole(toCompletion(await response.json() as ChatCompletion));
    const fold = new ChunkFold(emit);
    for await (const chunk of stream) fold.add(chunk);
    // The SDK ends an aborted stream quietly instead of throwing.
    signal?.throwIfAborted();
    return toCompletion(fold.response());
  }

  private async send(body: ChatCompletionCreateParamsNonStreaming, omit: StreamField | undefined, signal: AbortSignal | undefined) {
    if (omit === 'stream') return { completion: await this.client.chat.completions.create(body, { signal }) };
    return this.client.chat.completions
      .create({ ...body, stream: true, ...(omit ? {} : { stream_options: { include_usage: true } }) }, { signal })
      .withResponse();
  }
}

function readApiError(err: unknown): Refusal | undefined {
  return err instanceof OpenAI.BadRequestError || err instanceof OpenAI.UnprocessableEntityError
    ? { status: err.status, param: err.param, text: err.message }
    : undefined;
}

function toCompletion(res: ChatCompletion | OpenAIResponse): RaCompletion {
  const choice = res.choices[0];
  if (!choice) throw new Error('openai returned no choices');

  const toolCalls: RaToolCall[] = (choice.message.tool_calls ?? [])
    .filter(tc => tc.type === 'function')
    .map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

  return {
    content: choice.message.content ?? '',
    tool_calls: toolCalls,
    model: res.model,
    usage: res.usage
      ? {
          prompt_tokens: res.usage.prompt_tokens,
          completion_tokens: res.usage.completion_tokens,
          total_tokens: res.usage.total_tokens,
        }
      : undefined,
    raw: res,
  };
}
