/**
 * Anthropic provider client backed by the official @anthropic-ai/sdk,
 * speaking the Messages API: system prompts via the `system` param, tools
 * as input_schema declarations, tool traffic as tool_use/tool_result
 * blocks, images as base64 source blocks.
 *
 * The Messages API requires max_tokens (default 4096 here) and expects all
 * tool_result blocks for a parallel tool_use turn in the single next user
 * message — adjacent user-role turns are merged for that reason.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParamsNonStreaming, MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import type { RaClient, RaMessage, RaTool, RaCompletion, RaToolCall, RaProviderOptions } from './types.js';
import { stripTrailingSlashes } from '../../util/path-utils.js';

const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicClientOpts {
  apiKey: string;
  model: string;
  providerOptions?: RaProviderOptions;
  /** Injected by tests; defaults to the SDK's own fetch. */
  fetchImpl?: typeof fetch;
}

export class AnthropicClient implements RaClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly providerOptions: RaProviderOptions;

  constructor(opts: AnthropicClientOpts) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.providerOptions?.base_url
        ? { baseURL: stripTrailingSlashes(opts.providerOptions.base_url) }
        : {}),
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
    this.model = opts.model;
    this.providerOptions = opts.providerOptions ?? {};
  }

  async chat(messages: RaMessage[], tools: RaTool[]): Promise<RaCompletion> {
    const { system, turns } = toAnthropicMessages(messages);
    const body: MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.providerOptions.max_tokens ?? DEFAULT_MAX_TOKENS,
      messages: turns,
    };
    if (system) body.system = system;
    if (this.providerOptions.temperature !== undefined) body.temperature = this.providerOptions.temperature;
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool['input_schema'],
      }));
    }

    const res = await this.client.messages.create(body);

    const content = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');
    const toolCalls: RaToolCall[] = res.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map(b => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));

    return {
      content,
      tool_calls: toolCalls,
      model: res.model,
      usage: {
        prompt_tokens: res.usage.input_tokens,
        completion_tokens: res.usage.output_tokens,
        total_tokens: res.usage.input_tokens + res.usage.output_tokens,
      },
      raw: res,
    };
  }
}

/** Translate the loop's transcript into Messages-API shape. Exported for
 *  tests. */
export function toAnthropicMessages(messages: RaMessage[]): { system: string; turns: MessageParam[] } {
  const systemParts: string[] = [];
  const turns: MessageParam[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      const t = textOf(m.content);
      if (t) systemParts.push(t);
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = assistantBlocks(m);
      if (blocks.length > 0) turns.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (m.role === 'tool') {
      appendUserBlocks(turns, [toolResultBlock(m)]);
      continue;
    }
    appendUserBlocks(turns, userBlocks(m.content));
  }

  return { system: systemParts.join('\n\n'), turns };
}

function assistantBlocks(m: RaMessage): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  const t = textOf(m.content);
  if (t) blocks.push({ type: 'text', text: t });
  for (const call of m.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseArgs(call.function.arguments),
    });
  }
  return blocks;
}

function toolResultBlock(m: RaMessage): ContentBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: m.tool_call_id ?? '',
    content: textOf(m.content),
  };
}

/** Append blocks to the trailing user turn, or start a new one. Merging
 *  adjacent user turns is what puts parallel tool_results into the single
 *  next user message the API requires. */
function appendUserBlocks(turns: MessageParam[], blocks: ContentBlockParam[]): void {
  if (blocks.length === 0) return;
  const last = turns[turns.length - 1];
  if (last?.role === 'user' && Array.isArray(last.content)) {
    last.content.push(...blocks);
    return;
  }
  turns.push({ role: 'user', content: blocks });
}

function userBlocks(content: RaMessage['content']): ContentBlockParam[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  const blocks: ContentBlockParam[] = [];
  for (const b of content) {
    if (b.type === 'text') {
      if (b.text) blocks.push({ type: 'text', text: b.text });
    } else {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: b.media_type as Anthropic.Base64ImageSource['media_type'], data: b.data },
      });
    }
  }
  return blocks;
}

function textOf(content: RaMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
