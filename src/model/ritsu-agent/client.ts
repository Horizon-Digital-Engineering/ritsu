/**
 * Provider → client selection for the ritsu-agent runtime. First-party
 * providers get their official SDK client; aggregators/proxies share the
 * minimal Chat-Completions wire client.
 */
import type { RaClient, RaProvider, RaProviderOptions } from './types.js';
import { OpenAICompatClient } from './openai-client.js';
import { OpenAISdkClient } from './openai-sdk-client.js';
import { GeminiClient } from './gemini-client.js';

export interface RaClientOpts {
  provider: RaProvider;
  apiKey: string;
  model: string;
  providerOptions?: RaProviderOptions;
  /** Injected by tests; honored by the openai + compat clients. The gemini
   *  SDK has no fetch seam — its tests inject generateContentImpl instead. */
  fetchImpl?: typeof fetch;
}

export function buildRaClient(opts: RaClientOpts): RaClient {
  switch (opts.provider) {
    case 'openai': return new OpenAISdkClient(opts);
    case 'gemini': return new GeminiClient(opts);
    case 'openai-compat':
    case 'litellm':
      return new OpenAICompatClient({ ...opts, provider: opts.provider });
    default: {
      const _exhaustive: never = opts.provider;
      throw new Error(`Unknown ritsu-agent provider: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
