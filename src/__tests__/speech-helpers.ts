import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST, modelDir } from '../speech/model.js';

export const PROXY_LOGIN = 'operator:proxy-login-for-the-test';

export function toneWav(o: { seconds: number; rate?: number; channels?: number; amplitude?: number; freq?: number; bits?: number; format?: number }): Buffer {
  const rate = o.rate ?? 16_000;
  const channels = o.channels ?? 1;
  const amplitude = o.amplitude ?? 0.3;
  const freq = o.freq ?? 440;
  const frames = Math.round(o.seconds * rate);
  const data = Buffer.alloc(frames * channels * 2);
  for (let f = 0; f < frames; f++) {
    const v = Math.round(amplitude * Math.sin((2 * Math.PI * freq * f) / rate) * 32767);
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (f * channels + c) * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(o.format ?? 1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32);
  head.writeUInt16LE(o.bits ?? 16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** A model folder that reads as installed. */
export function fakeModel(dataDir: string, name: string, installedAt = '2026-11-14T00:00:00.000Z'): void {
  const dir = modelDir(dataDir);
  mkdirSync(join(dir, 'onnx'), { recursive: true });
  const files = [
    { path: 'config.json', body: '{}' },
    { path: 'onnx/encoder_model_quantized.onnx', body: 'encoder' },
  ];
  for (const f of files) writeFileSync(join(dir, f.path), f.body);
  writeFileSync(join(dir, MANIFEST), JSON.stringify({
    model: name, repo: `example/whisper-${name}`, revision: '0'.repeat(40), installed_at: installedAt,
    files: files.map(f => ({ path: f.path, size: Buffer.byteLength(f.body), sha256: '0'.repeat(64) })),
  }));
}
