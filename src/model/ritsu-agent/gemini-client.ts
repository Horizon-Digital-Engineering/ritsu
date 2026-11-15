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
 *
 * Streamed chunks merge back into one response so both paths share one translation.
 */
import { GoogleGenAI, GenerateContentResponse } from '@google/genai';
import type { Candidate, Content, GenerateContentConfig, GenerateContentParameters, Part } from '@google/genai';
import type { RaClient, RaChatOptions, RaMessage, RaTool, RaCompletion, RaToolCall, RaProviderOptions } from './types.js';
import { stripTrailingSlashes } from '../../util/path-utils.js';

const SYNTH_ID_PREFIX = 'gcall_';

export interface GeminiClientOpts {
  apiKey: string;
  model: string;
  providerOptions?: RaProviderOptions;
  /** Injected by tests; defaults to the live SDK call. */
  generateContentImpl?: (req: GenerateContentParameters) => Promise<GenerateContentResponse>;
  /** Injected by tests. */
  generateContentStreamImpl?: (req: GenerateContentParameters) => Promise<AsyncGenerator<GenerateContentResponse>>;
}

export class GeminiClient implements RaClient {
  private readonly model: string;
  private readonly providerOptions: RaProviderOptions | undefined;
  private readonly generate: (req: GenerateContentParameters) => Promise<GenerateContentResponse>;
  private readonly generateStream: (req: GenerateContentParameters) => Promise<AsyncGenerator<GenerateContentResponse>>;

  constructor(opts: GeminiClientOpts) {
    this.model = opts.model;
    this.providerOptions = opts.providerOptions;
    let ai: GoogleGenAI | undefined;
    const live = (): GoogleGenAI => {
      if (!ai) {
        const httpOptions = {
          ...(opts.providerOptions?.base_url ? { baseUrl: stripTrailingSlashes(opts.providerOptions.base_url) } : {}),
          ...(opts.providerOptions?.api_version ? { apiVersion: opts.providerOptions.api_version } : {}),
        };
        ai = new GoogleGenAI({
          apiKey: opts.apiKey,
          ...(Object.keys(httpOptions).length > 0 ? { httpOptions } : {}),
        });
      }
      return ai;
    };
    this.generate = opts.generateContentImpl ?? (req => live().models.generateContent(req));
    this.generateStream = opts.generateContentStreamImpl ?? (req => live().models.generateContentStream(req));
  }

  async chat(messages: RaMessage[], tools: RaTool[], opts: RaChatOptions = {}): Promise<RaCompletion> {
    const { onText, signal } = opts;
    const req = toGeminiRequest(this.model, messages, tools, this.providerOptions);
    if (signal) req.config = { ...req.config, abortSignal: signal };
    if (!onText) return fromGeminiResponse(await this.generate(req), this.model);

    const chunks: GenerateContentResponse[] = [];
    for await (const chunk of await this.generateStream(req)) {
      chunks.push(chunk);
      for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (p.text && !p.thought && !signal?.aborted) onText(p.text);
      }
      if (signal?.aborted) break;
    }
    signal?.throwIfAborted();
    return fromGeminiResponse(mergeGeminiChunks(chunks), this.model);
  }
}

function mergeGeminiChunks(chunks: GenerateContentResponse[]): GenerateContentResponse {
  const merged = new GenerateContentResponse();
  const parts: Part[] = [];
  let candidate: Candidate | undefined;
  for (const chunk of chunks) {
    const { candidates, ...fields } = chunk;
    Object.assign(merged, fields);
    const first = candidates?.[0];
    if (!first) continue;
    const { content: _content, ...meta } = first;
    candidate = { ...candidate, ...meta };
    for (const part of first.content?.parts ?? []) appendPart(parts, part);
  }
  if (candidate) merged.candidates = [{ ...candidate, content: { role: 'model', parts } }];
  return merged;
}

function appendPart(parts: Part[], part: Part): void {
  const last = parts.at(-1);
  if (last && isPlainText(last) && isPlainText(part) && Boolean(last.thought) === Boolean(part.thought)) {
    parts[parts.length - 1] = { ...last, text: (last.text ?? '') + (part.text ?? '') };
    return;
  }
  parts.push({ ...part });
}

/** Text with nothing else attached (no thought signature), so safe to join. */
function isPlainText(p: Part): boolean {
  return typeof p.text === 'string' && Object.keys(p).every(k => k === 'text' || k === 'thought');
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
