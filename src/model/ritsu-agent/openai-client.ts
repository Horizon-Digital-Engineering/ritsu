/**
 * Minimal OpenAI-compatible Chat Completions client. Speaks the standard
 *  POST /v1/chat/completions shape that every aggregator/proxy has
 *  converged on: OpenRouter, Together, Groq, Anyscale, Mistral,
 *  Ollama (local), LiteLLM (proxy), and many more. The provider name on
 *  the agent definition (`openai-compat`, `litellm`) selects a default
 *  base_url; everything else is identical. First-party providers
 *  (`openai`, `gemini`) use their official SDK clients instead.
 *
 *  Tool calling: standard `tools: [{type: 'function', function: {...}}]`
 *  input format; response includes `tool_calls` on the assistant message
 *  when the model wants to invoke functions. We translate verbatim.
 */
import type { RaClient, RaMessage, RaTool, RaCompletion, RaToolCall, RaProviderOptions } from './types.js';
import { stripTrailingSlashes } from '../../util/path-utils.js';

export type CompatProvider = 'openai-compat' | 'litellm';

/** Default base URLs per provider hint. `openai-compat` is a catch-all —
 *  the caller is expected to set base_url in provider_options. */
const DEFAULT_BASE_URLS: Record<CompatProvider, string> = {
  'openai-compat': 'https://openrouter.ai/api/v1',  // sane default; configurable
  litellm: 'http://localhost:4000/v1',
};

interface OpenAIChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason: string;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
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
    this.baseUrl = stripTrailingSlashes(opts.providerOptions?.base_url ?? DEFAULT_BASE_URLS[opts.provider]);
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.temperature = opts.providerOptions?.temperature ?? 0.7;
    this.maxTokens = opts.providerOptions?.max_tokens ?? 4096;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** One round-trip. Sends current messages + tool defs; receives the
   *  assistant's reply (text and/or tool_calls). */
  async chat(messages: RaMessage[], tools: RaTool[]): Promise<RaCompletion> {
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

    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`provider ${res.status}: ${text.slice(0, 400)}`);
    }

    const json = await res.json() as OpenAIResponse;
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
