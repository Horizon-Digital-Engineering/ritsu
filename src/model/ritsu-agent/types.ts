/**
 * Provider-agnostic types for the ritsu-agent runtime. The runtime models
 * itself on the OpenAI Chat Completions tool-calling shape because that's
 * the lingua franca (OpenAI, OpenRouter, Groq, Together, Ollama, LiteLLM
 * all speak it natively). An Anthropic-native adapter can layer on later
 * by translating to/from these types.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** Model providers the api runtime can talk to. anthropic/openai/gemini use
 *  their official SDKs; xai's documented path is its OpenAI-compatible API;
 *  openrouter (aggregator), litellm (local proxy), and custom (any
 *  OpenAI-compatible base_url) share the minimal wire client. */
export type RaProvider = 'anthropic' | 'openai' | 'gemini' | 'xai' | 'openrouter' | 'litellm' | 'custom';

/** One provider round-trip: current transcript + tool defs in, the
 *  assistant's reply (text and/or tool calls) out. Each provider client
 *  implements this; the dispatcher loop is provider-agnostic. */
export interface RaClient {
  chat(messages: RaMessage[], tools: RaTool[]): Promise<RaCompletion>;
}

/** A part of a multi-part message. Mirrors the dispatcher-level ChatContentBlock;
 *  the OpenAI client renders images as `image_url` data-URLs. */
export type RaContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: string; data: string };

/** One conversation turn passed to the provider. `tool_call_id` is set on
 *  role:'tool' messages so the provider can match results back to the
 *  call that produced them. */
export interface RaMessage {
  role: Role;
  /** Plain string for the common case; a block array when a user turn carries
   *  images. */
  content: string | RaContentBlock[];
  /** Set on role:'tool' rows. */
  tool_call_id?: string;
  /** Set on role:'assistant' rows that have tool calls to make. */
  tool_calls?: RaToolCall[];
  /** Optional friendly name; some providers use it to disambiguate
   *  tools in shared chats. Safe to omit. */
  name?: string;
}

/** One tool call the assistant wants to make this turn. */
export interface RaToolCall {
  id: string;
  /** Always 'function' in the OpenAI shape; provided for forward-compat. */
  type: 'function';
  function: {
    name: string;
    /** Raw JSON-string from the provider (the function arguments). The
     *  dispatcher parses this before invoking the handler. */
    arguments: string;
  };
}

/** A tool the agent has access to. The schema is JSON Schema, sent
 *  verbatim to the provider. Handler runs in-process. */
export interface RaTool {
  name: string;
  description: string;
  /** Standard JSON Schema, sent as `parameters` to OpenAI-compatible providers
   *  and as `input_schema` to the Anthropic client. */
  parameters: Record<string, unknown>;
  /** Pure function: takes the parsed args, returns the result text the
   *  model will see. Errors should be caught + stringified so the model
   *  can still continue (it sees the error and decides what to do). */
  handler: (args: Record<string, unknown>) => Promise<string>;
  /**
   * This handler raises its own operator approval on every call, so the loop
   * must NOT gate it as well. Without this an operator who also names the tool
   * in `approval_tools` gets two identical cards for one action, and has to
   * approve twice. The tool still cannot act unapproved — it owns the gate.
   */
  selfGated?: boolean;
}

export interface RaResponseUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** One round-trip with the provider. */
export interface RaCompletion {
  /** The assistant's final text for this round; may be empty when the
   *  assistant only made tool calls. */
  content: string;
  /** Tool calls to execute before the next round. Empty when the
   *  assistant is done. */
  tool_calls: RaToolCall[];
  model: string;
  usage?: RaResponseUsage;
  /** Whatever the provider sent back, retained for debug. */
  raw: unknown;
}

/** Free-form, provider-specific options. Everything is optional; the
 *  dispatcher fills in safe defaults when missing. */
export interface RaProviderOptions {
  base_url?: string;        // override (e.g. localhost OpenRouter / Ollama)
  temperature?: number;
  max_tokens?: number;
  /** Some providers (Groq, Together) want this on the URL path; harmless
   *  elsewhere. */
  api_version?: string;
}
