import type { ChatRequest, ChatResponse, ModelDispatcher } from './dispatcher.js';
import { logger } from '../util/log.js';

/**
 * Talks to a local LiteLLM proxy over its OpenAI-compatible HTTP API.
 * LiteLLM handles auth to the underlying provider.
 */
export class LiteLLMDispatcher implements ModelDispatcher {
  readonly kind = 'litellm' as const;

  constructor(
    readonly defaultModel: string,
    private readonly baseUrl: string = process.env.LITELLM_URL ?? 'http://localhost:4000',
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = {
      model: req.model ?? this.defaultModel,
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      max_tokens: req.max_tokens ?? 4096,
    };

    logger.debug('litellm.chat', { model: body.model, msg_count: body.messages.length });

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.LITELLM_API_KEY ? { Authorization: `Bearer ${process.env.LITELLM_API_KEY}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LiteLLM ${res.status}: ${text}`);
    }

    const json = await res.json() as {
      choices: Array<{ message: { content: string } }>;
      model: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      content: json.choices[0]?.message?.content ?? '',
      model: json.model,
      usage: {
        input_tokens: json.usage?.prompt_tokens,
        output_tokens: json.usage?.completion_tokens,
      },
      raw: json,
    };
  }
}
