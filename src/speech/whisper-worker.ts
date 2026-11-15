/** ONNX Runtime loads and runs models in synchronous native calls; on this
 *  thread they hold it, not the event loop that serves every request. */
import { basename, dirname } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { env, pipeline, LogLevel } from '@huggingface/transformers';
import type { WorkerReply, WorkerRequest } from './builtin.js';

const port = parentPort;
if (!port) throw new Error('whisper-worker runs only as a worker thread');

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useFSCache = false;
env.logLevel = LogLevel.ERROR;

const open = (dir: string, threads: number) => {
  env.localModelPath = dirname(dir);
  return pipeline('automatic-speech-recognition', basename(dir), {
    dtype: 'q8',
    device: 'cpu',
    session_options: { intraOpNumThreads: threads },
  });
};
let asr: Awaited<ReturnType<typeof open>> | null = null;

async function answer(req: WorkerRequest): Promise<string> {
  if ('pcm' in req) {
    if (!asr) throw new Error('no model is loaded');
    return (await asr(req.pcm, { chunk_length_s: 30, stride_length_s: 5 })).text;
  }
  await asr?.dispose();
  asr = null;
  if ('load' in req) asr = await open(req.load.dir, req.load.threads);
  return '';
}

port.on('message', async (req: WorkerRequest) => {
  let reply: WorkerReply;
  try {
    reply = { id: req.id, text: await answer(req) };
  } catch (e) {
    reply = { id: req.id, error: e instanceof Error ? e.message : String(e) };
  }
  port.postMessage(reply);
});
