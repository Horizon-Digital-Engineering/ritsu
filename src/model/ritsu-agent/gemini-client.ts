/**
 * Gemini provider client backed by the official @google/genai SDK, speaking
 * the native generateContent API (not Google's OpenAI-compat shim): system
 * prompts via systemInstruction, tools as functionDeclarations carrying raw
 * JSON Schema (parametersJsonSchema), images as inlineData parts.
 *
 * Gemini's FunctionCall may omit an id; the loop needs one to pair tool
 * results with calls, so absent ids are synthesized (`gcall_*`). Synthesized
 * ids are never echoed back in functionResponse parts — Gemini pairs by
 * name/order; only ids the API itself issued are returned to it.
 */
import { GoogleGenAI } from '@google/genai';
import type { Content, GenerateContentConfig, GenerateContentParameters, GenerateContentResponse, Part } from '@google/genai';
import type { RaClient, RaMessage, RaTool, RaCompletion, RaToolCall, RaProviderOptions } from './types.js';
import { stripTrailingSlashes } from '../../util/path-utils.js';

const SYNTH_ID_PREFIX = 'gcall_';

export interface GeminiClientOpts {
  apiKey: string;
  model: string;
  providerOptions?: RaProviderOptions;
  /** Injected by tests; defaults to the live SDK call. */
  generateContentImpl?: (req: GenerateContentParameters) => Promise<GenerateContentResponse>;
}

export class GeminiClient implements RaClient {
  private readonly model: string;
  private readonly providerOptions: RaProviderOptions | undefined;
  private readonly generate: (req: GenerateContentParameters) => Promise<GenerateContentResponse>;

  constructor(opts: GeminiClientOpts) {
    this.model = opts.model;
    this.providerOptions = opts.providerOptions;
    if (opts.generateContentImpl) {
      this.generate = opts.generateContentImpl;
    } else {
      const httpOptions = {
        ...(opts.providerOptions?.base_url ? { baseUrl: stripTrailingSlashes(opts.providerOptions.base_url) } : {}),
        ...(opts.providerOptions?.api_version ? { apiVersion: opts.providerOptions.api_version } : {}),
      };
      const ai = new GoogleGenAI({
        apiKey: opts.apiKey,
        ...(Object.keys(httpOptions).length > 0 ? { httpOptions } : {}),
      });
      this.generate = req => ai.models.generateContent(req);
    }
  }

  async chat(messages: RaMessage[], tools: RaTool[]): Promise<RaCompletion> {
    const req = toGeminiRequest(this.model, messages, tools, this.providerOptions);
    const res = await this.generate(req);
    return fromGeminiResponse(res, this.model);
  }
}

/** Translate the loop's transcript + tool defs into a generateContent
 *  request. Exported for tests. */
export function toGeminiRequest(
  model: string,
  messages: RaMessage[],
  tools: RaTool[],
  options?: RaProviderOptions,
): GenerateContentParameters {
  const systemParts: string[] = [];
  const contents: Content[] = [];
  // tool_call id → function name, so role:'tool' results (which only carry
  // the id) can be rendered as functionResponse parts (which need the name).
  const callNames = new Map<string, string>();

  for (const m of messages) {
    appendMessage(m, systemParts, contents, callNames);
  }

  const config = buildConfig(systemParts, tools, options);
  return Object.keys(config).length > 0 ? { model, contents, config } : { model, contents };
}

/** Render one transcript turn into `systemParts`/`contents`. */
function appendMessage(
  m: RaMessage,
  systemParts: string[],
  contents: Content[],
  callNames: Map<string, string>,
): void {
  if (m.role === 'system') {
    const t = textOf(m.content);
    if (t) systemParts.push(t);
    return;
  }
  if (m.role === 'assistant') {
    const parts = assistantParts(m, callNames);
    if (parts.length > 0) contents.push({ role: 'model', parts });
    return;
  }
  if (m.role === 'tool') {
    contents.push(toolResponseContent(m, callNames));
    return;
  }
  const parts = userParts(m.content);
  if (parts.length > 0) contents.push({ role: 'user', parts });
}

function assistantParts(m: RaMessage, callNames: Map<string, string>): Part[] {
  const parts: Part[] = [];
  const t = textOf(m.content);
  if (t) parts.push({ text: t });
  for (const call of m.tool_calls ?? []) {
    callNames.set(call.id, call.function.name);
    parts.push({
      functionCall: {
        ...(call.id.startsWith(SYNTH_ID_PREFIX) ? {} : { id: call.id }),
        name: call.function.name,
        args: parseArgs(call.function.arguments),
      },
    });
  }
  return parts;
}

function toolResponseContent(m: RaMessage, callNames: Map<string, string>): Content {
  const id = m.tool_call_id;
  return {
    role: 'user',
    parts: [{
      functionResponse: {
        ...(id && !id.startsWith(SYNTH_ID_PREFIX) ? { id } : {}),
        name: (id ? callNames.get(id) : undefined) ?? 'unknown',
        response: { output: textOf(m.content) },
      },
    }],
  };
}

function buildConfig(systemParts: string[], tools: RaTool[], options?: RaProviderOptions): GenerateContentConfig {
  const config: GenerateContentConfig = {};
  if (systemParts.length > 0) config.systemInstruction = systemParts.join('\n\n');
  if (options?.temperature !== undefined) config.temperature = options.temperature;
  if (options?.max_tokens !== undefined) config.maxOutputTokens = options.max_tokens;
  if (tools.length > 0) {
    config.tools = [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.parameters,
      })),
    }];
  }
  return config;
}

/** Translate a generateContent response back into the loop's shape.
 *  Exported for tests. */
export function fromGeminiResponse(res: GenerateContentResponse, fallbackModel: string): RaCompletion {
  const candidate = res.candidates?.[0];
  if (!candidate) {
    const reason = res.promptFeedback?.blockReason;
    throw new Error(reason ? `gemini blocked the prompt: ${reason}` : 'gemini returned no candidates');
  }

  const parts = candidate.content?.parts ?? [];
  const content = parts
    .filter(p => typeof p.text === 'string' && !p.thought)
    .map(p => p.text)
    .join('');

  const toolCalls: RaToolCall[] = [];
  for (const p of parts) {
    const fc = p.functionCall;
    if (!fc?.name) continue;
    toolCalls.push({
      id: fc.id ?? `${SYNTH_ID_PREFIX}${toolCalls.length}_${fc.name}`,
      type: 'function',
      function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
    });
  }

  const u = res.usageMetadata;
  return {
    content,
    tool_calls: toolCalls,
    model: res.modelVersion ?? fallbackModel,
    usage: u
      ? { prompt_tokens: u.promptTokenCount, completion_tokens: u.candidatesTokenCount, total_tokens: u.totalTokenCount }
      : undefined,
    raw: res,
  };
}

function textOf(content: RaMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
}

function userParts(content: RaMessage['content']): Part[] {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  const parts: Part[] = [];
  for (const b of content) {
    if (b.type === 'text') {
      if (b.text) parts.push({ text: b.text });
    } else {
      parts.push({ inlineData: { mimeType: b.media_type, data: b.data } });
    }
  }
  return parts;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
