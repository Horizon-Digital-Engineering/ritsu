import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { z } from 'zod';
import { openDatabase } from '../db.js';
import { ScopedDb } from '../plugins/host.js';
import { IngestionStore, IngestionPipeline, migrateIngestion } from '../ingestion/pipeline.js';
import { StaticExtractor, parseModelJson, OpenAiCompatVisionExtractor } from '../ingestion/extractors.js';
import type { DocType } from '../ingestion/pipeline.js';

const LabSchema = z.array(z.object({ label: z.string(), value: z.number() }));

function setup(extractorOut: unknown) {
  const db = new ScopedDb(openDatabase(':memory:'), 'health');
  migrateIngestion(db);
  const store = new IngestionStore(db);
  const committed: Array<{ label: string; value: number }> = [];
  const p = new IngestionPipeline(store, new StaticExtractor(extractorOut));
  p.registerType({ id: 'lab_report', label: 'Lab report', schema: LabSchema, instructions: 'pull labs', commit: (d) => committed.push(...(d as Array<{ label: string; value: number }>)) });
  return { p, committed, store };
}

describe('parseModelJson', () => {
  it('handles ``` fences and surrounding prose', () => {
    assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseModelJson('Here you go: [{"x":2}] — done.'), [{ x: 2 }]);
    assert.deepEqual(parseModelJson('{"nested":{"y":3}} trailing'), { nested: { y: 3 } });
  });
  it('throws when there is no JSON', () => {
    assert.throws(() => parseModelJson('no json here'), /no JSON/);
  });
});

describe('OpenAiCompatVisionExtractor (local / cheap tier)', () => {
  const docType = { instructions: 'pull the labs' } as DocType;

  it('posts an OpenAI vision message to the configured endpoint and parses the JSON reply', async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    const fetchImpl = (async (url: string, init: { body: string }) => {
      seen = { url, body: JSON.parse(init.body) as Record<string, unknown> };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '```json\n[{"label":"LDL","value":120}]\n```' } }] }) };
    }) as unknown as typeof fetch;
    const ex = new OpenAiCompatVisionExtractor({ baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-vl', fetchImpl });
    const out = await ex.extract({ title: 't', source: 'upload', imageBase64: 'AAAA', mediaType: 'image/png' }, docType);
    assert.deepEqual(out, [{ label: 'LDL', value: 120 }]);
    assert.equal(seen!.url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(seen!.body.model, 'qwen2.5-vl');
    // image is sent as an OpenAI data-URL image part
    const userMsg = (seen!.body.messages as Array<{ role: string; content: unknown }>).find(m => m.role === 'user');
    const parts = userMsg!.content as Array<{ type: string; image_url?: { url: string } }>;
    assert.ok(parts.some(p => p.type === 'image_url' && p.image_url!.url.startsWith('data:image/png;base64,AAAA')));
  });
});

describe('IngestionPipeline', () => {
  it('submit stores original + validated candidate as pending; confirm routes to the domain', async () => {
    const { p, committed } = setup([{ label: 'LDL', value: 120 }, { label: 'HDL', value: 55 }]);
    const rec = await p.submit({ title: 'Labs 2026-07', source: 'paste', text: 'LDL 120 HDL 55' }, 'lab_report');
    assert.equal(rec.status, 'pending');
    assert.equal(rec.original, 'LDL 120 HDL 55');
    assert.ok(rec.extracted && JSON.parse(rec.extracted).length === 2);
    assert.equal(committed.length, 0); // not committed until confirmed

    const done = p.confirm(rec.id);
    assert.equal(done.status, 'committed');
    assert.ok(done.committed_at);
    assert.deepEqual(committed.map(c => c.label), ['LDL', 'HDL']);
  });

  it('confirm can override the extraction with human-edited data', async () => {
    const { p, committed } = setup([{ label: 'LDL', value: 120 }]);
    const rec = await p.submit({ title: 't', source: 'paste', text: 'x' }, 'lab_report');
    p.confirm(rec.id, [{ label: 'LDL', value: 118 }]); // operator fixed a misread digit
    assert.equal(committed[0].value, 118);
  });

  it('a bad extraction fails the record (never corrupts the domain)', async () => {
    const { p, committed } = setup([{ label: 'LDL' }]); // missing value → schema fails
    const rec = await p.submit({ title: 't', source: 'paste', text: 'x' }, 'lab_report');
    assert.equal(rec.status, 'error');
    assert.ok(rec.error);
    assert.equal(committed.length, 0);
  });

  it('reject flips status to rejected but retains the original', async () => {
    const { p, store } = setup([{ label: 'LDL', value: 1 }]);
    const rec = await p.submit({ title: 't', source: 'paste', text: 'keep-me' }, 'lab_report');
    p.reject(rec.id);
    const after = store.get(rec.id)!;
    assert.equal(after.status, 'rejected');
    assert.equal(after.original, 'keep-me');
  });
});
