import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { messageText, messageImages, type ChatMessage } from '../model/dispatcher.js';
import { formatMessages } from '../model/claude-direct-dispatcher.js';
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
});

describe('ritsu-agent OpenAI client (image_url translation)', () => {
  it('renders an image block as a data-URL image_url part', async () => {
    let captured: any = null;
    const fakeFetch = (async (_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          id: 'x', model: 'gpt-4o',
          choices: [{ index: 0, message: { role: 'assistant', content: 'a cat' }, finish_reason: 'stop' }],
        }),
      };
    }) as unknown as typeof fetch;

    const client = new OpenAICompatClient({
      provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o', fetchImpl: fakeFetch,
    });
    const messages: RaMessage[] = [
      { role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', media_type: 'image/jpeg', data: PNG_1PX },
      ] },
    ];
    await client.chat(messages, []);

    const parts = captured.messages[0].content;
    assert.ok(Array.isArray(parts));
    assert.deepEqual(parts[0], { type: 'text', text: 'what is this?' });
    assert.equal(parts[1].type, 'image_url');
    assert.equal(parts[1].image_url.url, `data:image/jpeg;base64,${PNG_1PX}`);
  });

  it('leaves a plain-string message as a string (no needless multi-part)', async () => {
    let captured: any = null;
    const fakeFetch = (async (_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          id: 'x', model: 'gpt-4o',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        }),
      };
    }) as unknown as typeof fetch;
    const client = new OpenAICompatClient({
      provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o', fetchImpl: fakeFetch,
    });
    await client.chat([{ role: 'user', content: 'hi' }], []);
    assert.equal(captured.messages[0].content, 'hi');
  });
});
