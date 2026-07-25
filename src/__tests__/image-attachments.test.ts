import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { messageText, messageImages, type ChatMessage } from '../model/dispatcher.js';
import { formatMessages, imagePrompt } from '../model/claude-direct-dispatcher.js';
import { OpenAICompatClient } from '../model/ritsu-agent/openai-client.js';
import type { RaMessage } from '../model/ritsu-agent/types.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

describe('content-block helpers', () => {
  it('messageText flattens text blocks and drops images', () => {
    const content: ChatMessage['content'] = [
      { type: 'text', text: 'look at ' },
      { type: 'image', media_type: 'image/png', data: PNG_1PX },
      { type: 'text', text: 'this' },
    ];
    assert.equal(messageText(content), 'look at this');
    assert.equal(messageText('plain'), 'plain');
  });

  it('messageImages returns only the image blocks', () => {
    const content: ChatMessage['content'] = [
      { type: 'text', text: 'x' },
      { type: 'image', media_type: 'image/jpeg', data: PNG_1PX },
    ];
    const imgs = messageImages(content);
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0].media_type, 'image/jpeg');
    assert.deepEqual(messageImages('plain'), []);
  });
});

describe('claude-direct formatMessages (Anthropic image translation)', () => {
  it('pulls images into Anthropic base64 blocks and keeps the text prompt', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'you are a helper' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', media_type: 'image/png', data: PNG_1PX },
        ],
      },
    ];
    const { systemMsg, userPrompt, images } = formatMessages(messages);
    assert.equal(systemMsg, 'you are a helper');
    assert.match(userPrompt, /USER: what is this\?/);
    assert.equal(images.length, 1);
    assert.deepEqual(images[0], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG_1PX },
    });
  });

  it('a text-only conversation yields no images (string-prompt fast path)', () => {
    const { images, userPrompt } = formatMessages([{ role: 'user', content: 'hi' }]);
    assert.equal(images.length, 0);
    assert.equal(userPrompt, 'USER: hi');
  });

  it('imagePrompt streams a single user message carrying the text + image blocks', async () => {
    const gen = imagePrompt('describe', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX } },
    ]);
    const first = await gen.next();
    assert.equal(first.done, false);
    assert.equal(first.value.type, 'user');
    const content = first.value.message.content as Array<{ type: string; text?: string; source?: { data: string } }>;
    assert.deepEqual(content[0], { type: 'text', text: 'describe' });
    assert.equal(content[1].type, 'image');
    assert.equal(content[1].source?.data, PNG_1PX);
    // single-turn: the generator closes after one yield
    assert.equal((await gen.next()).done, true);
  });
});

interface CapturedBody { messages: Array<{ role: string; content: unknown }>; }
type OpenAIPart = { type: string; text?: string; image_url?: { url: string } };

/** A fetch stub that captures the request body into `sink` and replies with a
 *  minimal Chat Completions response. Typed (no `any`) so the lint gate stays
 *  green. */
function captureFetch(sink: { body: CapturedBody | null }, replyContent: string): typeof fetch {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    sink.body = JSON.parse(init?.body as string) as CapturedBody;
    return {
      ok: true,
      json: async () => ({
        id: 'x', model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: replyContent }, finish_reason: 'stop' }],
      }),
    } as unknown as Response;
  };
}

describe('ritsu-agent OpenAI client (image_url translation)', () => {
  it('renders an image block as a data-URL image_url part', async () => {
    const sink: { body: CapturedBody | null } = { body: null };
    const client = new OpenAICompatClient({
      provider: 'openrouter', apiKey: 'sk-test', model: 'gpt-4o', fetchImpl: captureFetch(sink, 'a cat'),
    });
    const messages: RaMessage[] = [
      { role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', media_type: 'image/jpeg', data: PNG_1PX },
      ] },
    ];
    await client.chat(messages, []);

    const parts = sink.body?.messages[0].content as OpenAIPart[];
    assert.ok(Array.isArray(parts));
    assert.deepEqual(parts[0], { type: 'text', text: 'what is this?' });
    assert.equal(parts[1].type, 'image_url');
    assert.equal(parts[1].image_url?.url, `data:image/jpeg;base64,${PNG_1PX}`);
  });

  it('leaves a plain-string message as a string (no needless multi-part)', async () => {
    const sink: { body: CapturedBody | null } = { body: null };
    const client = new OpenAICompatClient({
      provider: 'openrouter', apiKey: 'sk-test', model: 'gpt-4o', fetchImpl: captureFetch(sink, 'hi'),
    });
    await client.chat([{ role: 'user', content: 'hi' }], []);
    assert.equal(sink.body?.messages[0].content, 'hi');
  });
});
