import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { GenerateContentResponse } from '@google/genai';
import { GeminiClient, toGeminiRequest, fromGeminiResponse } from '../model/ritsu-agent/gemini-client.js';
import type { RaMessage, RaTool } from '../model/ritsu-agent/types.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const echoTool: RaTool = {
  name: 'echo',
  description: 'echo back',
  parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  handler: async () => 'ok',
};

function response(partial: Partial<GenerateContentResponse>): GenerateContentResponse {
  return partial as GenerateContentResponse;
}

describe('toGeminiRequest', () => {
  it('maps roles, hoists system to systemInstruction, sends tools as raw JSON Schema', () => {
    const messages: RaMessage[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ];
    const req = toGeminiRequest('gemini-test', messages, [echoTool], { temperature: 0.2, max_tokens: 100 });

    assert.equal(req.model, 'gemini-test');
    assert.equal(req.config?.systemInstruction, 'be terse');
    assert.equal(req.config?.temperature, 0.2);
    assert.equal(req.config?.maxOutputTokens, 100);
    assert.deepEqual(
      (req.contents as Array<{ role: string }>).map(c => c.role),
      ['user', 'model', 'user'],
    );
    const decls = (req.config?.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0].functionDeclarations;
    assert.equal(decls[0].name, 'echo');
    assert.deepEqual(decls[0].parametersJsonSchema, echoTool.parameters);
  });

  it('omits sampling params unless set in provider_options', () => {
    const req = toGeminiRequest('m', [{ role: 'user', content: 'hi' }], []);
    assert.equal(req.config, undefined);
  });

  it('renders image blocks as inlineData parts', () => {
    const messages: RaMessage[] = [
      { role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', media_type: 'image/png', data: PNG_1PX },
      ] },
    ];
    const req = toGeminiRequest('m', messages, []);
    const parts = (req.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0].parts;
    assert.deepEqual(parts[0], { text: 'what is this?' });
    assert.deepEqual(parts[1], { inlineData: { mimeType: 'image/png', data: PNG_1PX } });
  });

  it('renders tool history as functionCall/functionResponse pairs, never echoing synthesized ids', () => {
    const messages: RaMessage[] = [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'gcall_0_echo', type: 'function', function: { name: 'echo', arguments: '{"msg":"x"}' } },
        { id: 'api-id-1', type: 'function', function: { name: 'echo', arguments: '{"msg":"y"}' } },
      ] },
      { role: 'tool', tool_call_id: 'gcall_0_echo', content: 'result-x' },
      { role: 'tool', tool_call_id: 'api-id-1', content: 'result-y' },
    ];
    const req = toGeminiRequest('m', messages, [echoTool]);
    const contents = req.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;

    const modelTurn = contents[1];
    assert.equal(modelTurn.role, 'model');
    assert.deepEqual(modelTurn.parts[0].functionCall, { name: 'echo', args: { msg: 'x' } });
    assert.deepEqual(modelTurn.parts[1].functionCall, { id: 'api-id-1', name: 'echo', args: { msg: 'y' } });

    assert.deepEqual(contents[2].parts[0].functionResponse, { name: 'echo', response: { output: 'result-x' } });
    assert.deepEqual(contents[3].parts[0].functionResponse, { id: 'api-id-1', name: 'echo', response: { output: 'result-y' } });
  });
});

describe('fromGeminiResponse', () => {
  it('joins text parts, skips thoughts, synthesizes ids for id-less function calls', () => {
    const res = response({
      modelVersion: 'gemini-test-001',
      candidates: [{
        content: { role: 'model', parts: [
          { text: 'thinking...', thought: true },
          { text: 'calling ' },
          { text: 'echo' },
          { functionCall: { name: 'echo', args: { msg: 'x' } } },
        ] },
      }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
    });
    const out = fromGeminiResponse(res, 'fallback');
    assert.equal(out.content, 'calling echo');
    assert.equal(out.model, 'gemini-test-001');
    assert.deepEqual(out.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
    assert.equal(out.tool_calls.length, 1);
    assert.equal(out.tool_calls[0].id, 'gcall_0_echo');
    assert.equal(out.tool_calls[0].function.arguments, '{"msg":"x"}');
  });

  it('keeps API-issued function-call ids', () => {
    const res = response({
      candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'api-id-9', name: 'echo', args: {} } }] } }],
    });
    assert.equal(fromGeminiResponse(res, 'm').tool_calls[0].id, 'api-id-9');
  });

  it('throws with the block reason when the prompt was refused', () => {
    const res = response({ promptFeedback: { blockReason: 'SAFETY' } } as Partial<GenerateContentResponse>);
    assert.throws(() => fromGeminiResponse(res, 'm'), /blocked.*SAFETY/);
  });
});

describe('GeminiClient', () => {
  it('runs a full chat round through an injected generateContent', async () => {
    const seen: unknown[] = [];
    const client = new GeminiClient({
      apiKey: 'test-key',
      model: 'gemini-test',
      generateContentImpl: async req => {
        seen.push(req);
        return response({
          candidates: [{ content: { role: 'model', parts: [{ text: 'four' }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
        });
      },
    });
    const out = await client.chat([{ role: 'user', content: '2+2?' }], []);
    assert.equal(out.content, 'four');
    assert.equal(seen.length, 1);
    assert.equal((seen[0] as { model: string }).model, 'gemini-test');
  });
});
