/**
 * Provider → client selection for the api runtime. First-party providers
 * get their official SDK client; everything else shares the minimal
 * OpenAI-compatible wire client.
 */
import type { RaClient, RaProvider, RaProviderOptions } from './types.js';
import { OpenAICompatClient } from './openai-client.js';
import { OpenAISdkClient } from './openai-sdk-client.js';
import { AnthropicClient } from './anthropic-client.js';
import { GeminiClient } from './gemini-client.js';

/** SecretStore namespace + keys for the LiteLLM proxy connection. The
 *  factory resolves these into base_url / key fallbacks for keyless
 *  litellm agents. */
export const LITELLM_NS = 'litellm';
export const LITELLM_SECRET_KEYS = ['url', 'api_key'] as const;

export interface RaClientOpts {
  provider: RaProvider;
  apiKey: string;
  model: string;
  providerOptions?: RaProviderOptions;
  /** Injected by tests; honored by every client except gemini — that SDK
   *  has no fetch seam, so its tests inject generateContentImpl instead. */
  fetchImpl?: typeof fetch;
}

export function buildRaClient(opts: RaClientOpts): RaClient {
  switch (opts.provider) {
    case 'anthropic': return new AnthropicClient(opts);
    case 'openai': return new OpenAISdkClient(opts);
    case 'gemini': return new GeminiClient(opts);
    case 'xai':
    case 'openrouter':
    case 'litellm':
    case 'custom':
      return new OpenAICompatClient({ ...opts, provider: opts.provider });
    default: {
      const _exhaustive: never = opts.provider;
      throw new Error(`Unknown api-runtime provider: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
