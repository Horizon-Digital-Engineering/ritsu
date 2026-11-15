export const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
export const OPENAI_MODEL = 'gpt-transcribe';
const TIMEOUT_MS = 120_000;

export type Fetch = typeof fetch;

function form(wav: Buffer, fields: Record<string, string>): FormData {
  const f = new FormData();
  f.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

function clip(s: string): string {
  const t = s.replaceAll(/\s+/g, ' ').trim();
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}

function upstreamMessage(body: string): string {
  try {
    const v = JSON.parse(body) as { error?: unknown };
    if (typeof v.error === 'string') return v.error;
    if (v.error && typeof (v.error as { message?: unknown }).message === 'string') return (v.error as { message: string }).message;
  } catch { /* not JSON; the body itself says it */ }
  return body;
}

async function post(who: string, url: string, body: FormData, headers: Record<string, string>, fetchFn: Fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    if (err.name === 'TimeoutError') throw new Error(`${who} did not answer within ${TIMEOUT_MS / 1000} s`);
    throw new Error(`${who} could not be reached: ${err.cause?.message ?? err.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${who} answered ${res.status}: ${clip(upstreamMessage(text)) || res.statusText}`);
  let v: unknown;
  try { v = JSON.parse(text); }
  catch { throw new Error(`${who} answered something that is not JSON`); }
  const words = (v as { text?: unknown } | null)?.text;
  if (typeof words !== 'string') throw new Error(`${who} answered without any text`);
  return words;
}

export function transcribeLocal(url: string, wav: Buffer, context: string, fetchFn: Fetch = fetch): Promise<string> {
  const fields: Record<string, string> = { response_format: 'json', temperature: '0.0' };
  if (context) fields.prompt = context;
  return post(`The whisper server at ${url}`, url, form(wav, fields), {}, fetchFn);
}

export function transcribeOpenAi(apiKey: string, wav: Buffer, context: string, fetchFn: Fetch = fetch): Promise<string> {
  const fields: Record<string, string> = { model: OPENAI_MODEL };
  if (context) fields.prompt = context;
  return post('OpenAI', OPENAI_URL, form(wav, fields), { Authorization: `Bearer ${apiKey}` }, fetchFn);
}
