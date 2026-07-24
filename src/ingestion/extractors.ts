/**
 * Extractors turn a raw document (text or image) into candidate structured
 * data for a doc type. Injected into the pipeline so it's swappable:
 *   - StaticExtractor: canned output, for tests + wiring the flow.
 *   - SdkVisionExtractor: a real one-shot vision/LLM call over the Max-plan SDK
 *     ($0 marginal) that reads the doc and returns JSON matching the doc type.
 * The pipeline validates whatever comes back against the doc-type zod schema,
 * so a bad extraction fails the record rather than corrupting the domain.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Extractor, ExtractInput, DocType } from './pipeline.js';

/** Test / passthrough extractor — returns a fixed object (or a per-call fn). */
type ExtractorFn = (i: ExtractInput, d: DocType) => unknown;
export class StaticExtractor implements Extractor {
  constructor(private readonly out: unknown) {}
  async extract(input: ExtractInput, docType: DocType): Promise<unknown> {
    return typeof this.out === 'function' ? (this.out as ExtractorFn)(input, docType) : this.out;
  }
}

/** Pull the first JSON object/array out of a model reply (tolerates ``` fences
 *  and surrounding prose). */
export function parseModelJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start === -1) throw new Error('extractor returned no JSON');
  // Walk to the matching close so trailing prose doesn't break the parse.
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === open) depth++;
    else if (body[i] === close && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  return JSON.parse(body.slice(start)); // let JSON.parse throw a precise error
}

const EXTRACT_SYSTEM = [
  'You extract structured data from a document. Read it carefully and output ONLY',
  'valid JSON matching the requested shape — no prose, no code fences, no explanation.',
  'Use null for anything not present. Never invent values.',
].join(' ');

async function* imageUserMessage(text: string, imageBase64: string, mediaType: string): AsyncGenerator<unknown> {
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [
      { type: 'text', text },
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
    ] },
  };
}

/**
 * Extraction against ANY OpenAI-compatible vision endpoint — a local model
 * (Ollama, vLLM, LM Studio) or a hosted cheap tier. Keeps grunt-work OCR/
 * extraction OFF the frontier/Max compute (and, for a local endpoint, keeps
 * sensitive docs on the box). Point it at whatever server you run.
 */
export interface OpenAiVisionOpts { baseUrl: string; model: string; apiKey?: string; fetchImpl?: typeof fetch }

export class OpenAiCompatVisionExtractor implements Extractor {
  constructor(private readonly o: OpenAiVisionOpts) {}
  async extract(input: ExtractInput, docType: DocType): Promise<unknown> {
    const ask = `${docType.instructions}\n\nReturn JSON only.`;
    const content = input.imageBase64
      ? [
          { type: 'text', text: ask },
          { type: 'image_url', image_url: { url: `data:${input.mediaType ?? 'image/png'};base64,${input.imageBase64}` } },
        ]
      : `${ask}\n\n---\n${input.text ?? ''}`;
    const doFetch = this.o.fetchImpl ?? fetch;
    const res = await doFetch(`${this.o.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.o.model,
        temperature: 0,
        messages: [{ role: 'system', content: EXTRACT_SYSTEM }, { role: 'user', content }],
      }),
    });
    if (!res.ok) throw new Error(`extraction endpoint returned ${res.status}`);
    const json = await res.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const out = json.choices?.[0]?.message?.content;
    if (typeof out !== 'string') throw new Error('extraction endpoint returned no content');
    return parseModelJson(out);
  }
}

/**
 * Pick the extractor from the environment. A configured local/cheap endpoint
 * (RITSU_INGEST_ENDPOINT) wins — that's the tier for trivial extraction;
 * otherwise fall back to the Max-session vision read. Grunt work stays cheap,
 * the frontier model is reserved for reasoning.
 */
export function resolveExtractor(): Extractor {
  const endpoint = process.env.RITSU_INGEST_ENDPOINT?.trim();
  if (endpoint) {
    return new OpenAiCompatVisionExtractor({
      baseUrl: endpoint,
      model: process.env.RITSU_INGEST_MODEL?.trim() || 'qwen2.5-vl',
      apiKey: process.env.RITSU_INGEST_API_KEY?.trim() || undefined,
    });
  }
  return new SdkVisionExtractor();
}

export class SdkVisionExtractor implements Extractor {
  constructor(private readonly model = 'claude-sonnet-4-6') {}

  async extract(input: ExtractInput, docType: DocType): Promise<unknown> {
    const ask = `${docType.instructions}\n\nReturn JSON only.`;
    const prompt = input.imageBase64
      ? imageUserMessage(ask, input.imageBase64, input.mediaType ?? 'image/png')
      : `${ask}\n\n---\n${input.text ?? ''}`;
    let out = '';
    for await (const ev of query({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      prompt: prompt as any,
      options: {
        systemPrompt: EXTRACT_SYSTEM,
        model: this.model,
        settingSources: [],
        permissionMode: 'default',
        // No tools — this is a pure read→JSON turn.
        allowedTools: [],
      },
    })) {
      const e = ev as { type?: string; subtype?: string; result?: string };
      if (e.type === 'result' && e.subtype === 'success' && typeof e.result === 'string') out = e.result;
    }
    if (!out.trim()) throw new Error('extractor produced no output');
    return parseModelJson(out);
  }
}
