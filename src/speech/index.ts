import type { SettingsStore } from '../settings-store.js';
import type { ApiKeyStore } from '../auth/api-key-store.js';
import { logger } from '../util/log.js';
import { BuiltinWhisper, type BuiltinOptions } from './builtin.js';
import { transcribeLocal, transcribeOpenAi, type Fetch } from './engines.js';
import { readInstalled } from './model.js';
import { readWav, whisperSamples, type Wav } from './wav.js';

export const MAX_SECONDS = 300;
/** Recordings a little past the limit are the page stopping late, not a longer recording. */
const GRACE_SECONDS = 1;
const MIN_SECONDS = 0.3;
/** Just above five minutes of 16 kHz mono 16-bit audio plus its header. */
export const WAV_BODY_LIMIT = 9_700_000;
export const ENGINES = ['builtin', 'local', 'openai'] as const;
export const CHOICES = ['auto', ...ENGINES, 'off'] as const;
export type EngineId = (typeof ENGINES)[number];
export type Choice = (typeof CHOICES)[number];
export const SPEECH_ENGINE = 'speech.engine';
export const WHISPER_URL = 'speech.whisper_url';
export const NOTHING_HEARD = 'Nothing was heard; check the microphone and speak again.';
export const NOT_WAV = 'The recording did not arrive as a 16-bit PCM WAV.';
export const TOO_LONG = `A recording is at most ${MAX_SECONDS / 60} minutes.`;

const LABELS: Record<EngineId, string> = {
  builtin: 'Built-in Whisper',
  local: 'Whisper server',
  openai: 'OpenAI gpt-transcribe',
};

export interface EngineStatus {
  id: EngineId;
  label: string;
  available: boolean;
  detail: string;
  cost: string;
}

export interface SpeechStatus {
  choice: Choice;
  engine: EngineId | null;
  sentence: string;
  engines: EngineStatus[];
  max_seconds: number;
  whisper_url: string;
  model: string | null;
}

export interface Heard {
  text: string;
  engine: EngineId | null;
  seconds: number;
  note?: string;
}

export class SpeechError extends Error {
  constructor(readonly status: 400 | 413 | 422 | 502, message: string) {
    super(message);
    this.name = 'SpeechError';
  }
}

/** The doctor supplies these from a read-only database. */
export interface StatusSources {
  dataDir: string;
  setting(key: string): string | null;
  hasOpenAiKey(): boolean;
}

export function isChoice(v: string): v is Choice {
  return (CHOICES as readonly string[]).includes(v);
}

export function whisperUrlError(v: string): string | null {
  let u: URL;
  try { u = new URL(v); }
  catch { return 'the whisper server address is not a URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'the whisper server address must be http or https';
  // fetch refuses such a URL, and every failure would echo the password into the log and the error.
  return u.username || u.password ? 'the whisper server address cannot carry a user name or password' : null;
}

export function speechStatus(src: StatusSources): SpeechStatus {
  const stored = src.setting(SPEECH_ENGINE)?.trim() ?? '';
  const choice: Choice = isChoice(stored) ? stored : 'auto';
  const url = src.setting(WHISPER_URL)?.trim() ?? '';
  const urlOk = url !== '' && whisperUrlError(url) === null;
  const model = readInstalled(src.dataDir);
  const openai = src.hasOpenAiKey();
  const engines: EngineStatus[] = [
    {
      id: 'builtin', label: LABELS.builtin, available: model !== null,
      detail: model
        ? `${model.name} on this machine's processor; the audio never leaves it.`
        : 'Not set up: run `sudo ritsu speech-model` on the server.',
      cost: 'free',
    },
    {
      id: 'local', label: LABELS.local, available: urlOk,
      detail: urlOk
        ? `whisper.cpp at ${url}; the audio goes only there.`
        : 'Not set up: start a whisper.cpp server and enter its /inference address below.',
      cost: 'free',
    },
    {
      id: 'openai', label: LABELS.openai, available: openai,
      detail: openai ? 'Uses the newest OpenAI key under API Keys; the audio goes to OpenAI.' : 'Needs an OpenAI key under API Keys.',
      cost: '$0.0045 a minute',
    },
  ];
  let engine: EngineId | null = null;
  if (choice === 'auto') engine = engines.find(e => e.available)?.id ?? null;
  else if (choice !== 'off') engine = engines.find(e => e.id === choice && e.available)?.id ?? null;
  return {
    choice, engine, sentence: sentenceFor(choice, engine, model?.name ?? null, url), engines,
    max_seconds: MAX_SECONDS, whisper_url: url, model: model?.name ?? null,
  };
}

function sentenceFor(choice: Choice, engine: EngineId | null, model: string | null, url: string): string {
  if (choice === 'off') return 'Voice is off.';
  if (engine === 'builtin') return `Speech goes to the built-in Whisper (${model}).`;
  if (engine === 'local') return `Speech goes to the whisper server at ${url}.`;
  if (engine === 'openai') return 'Speech goes to OpenAI gpt-transcribe, at $0.0045 a minute.';
  if (choice === 'builtin') return 'The built-in Whisper is chosen but has no model: run `sudo ritsu speech-model` on the server, or pick another engine in Settings.';
  if (choice === 'local') return 'The whisper server is chosen but has no address: enter its /inference address in Settings, or pick another engine.';
  if (choice === 'openai') return 'OpenAI is chosen but no key is stored: add one under API Keys, or pick another engine in Settings.';
  return 'No speech engine can run yet: run `ritsu speech-model` on the server, set a whisper server address, or add an OpenAI key.';
}

export interface SpeechDeps extends StatusSources {
  /** Revealed only to transcribe. */
  openAiKey(): string | null;
  fetch?: Fetch;
  builtin?: BuiltinOptions;
}

export function storeSources(dataDir: string, settings: SettingsStore, apiKeys: ApiKeyStore): SpeechDeps {
  const newest = () => apiKeys.list().find(k => k.provider === 'openai' && k.revoked_at === null) ?? null;
  return {
    dataDir,
    setting: key => settings.get(key),
    hasOpenAiKey: () => newest() !== null,
    openAiKey: () => {
      const row = newest();
      return row ? apiKeys.reveal(row.id)?.plaintext ?? null : null;
    },
  };
}

export class SpeechService {
  private readonly builtin: BuiltinWhisper;

  constructor(private readonly deps: SpeechDeps) {
    this.builtin = new BuiltinWhisper(deps.dataDir, deps.builtin);
  }

  status(): SpeechStatus {
    return speechStatus(this.deps);
  }

  async transcribe(body: Buffer, context = ''): Promise<Heard> {
    const wav = readWav(body);
    if (!wav) throw new SpeechError(400, NOT_WAV);
    const seconds = Math.round(wav.seconds * 100) / 100;
    if (wav.seconds > MAX_SECONDS + GRACE_SECONDS) throw new SpeechError(413, TOO_LONG);
    if (wav.seconds < MIN_SECONDS || wav.silent) return { text: '', engine: null, seconds, note: NOTHING_HEARD };
    const st = this.status();
    if (!st.engine) throw new SpeechError(422, st.sentence);
    const t0 = Date.now();
    let text: string;
    try {
      text = await this.run(st.engine, body, wav, context, st.whisper_url);
    } catch (e) {
      const why = (e as Error).message;
      logger.warn('speech.failed', { engine: st.engine, seconds, err: why });
      throw new SpeechError(502, `${LABELS[st.engine]} failed: ${why}`);
    }
    logger.info('speech.transcribed', { engine: st.engine, seconds, ms: Date.now() - t0 });
    return { text: text.trim(), engine: st.engine, seconds };
  }

  close(): Promise<void> {
    return this.builtin.close();
  }

  private async run(engine: EngineId, body: Buffer, wav: Wav, context: string, url: string): Promise<string> {
    if (engine === 'builtin') return this.builtin.transcribe(whisperSamples(wav));
    if (engine === 'local') return transcribeLocal(url, body, context, this.deps.fetch);
    const apiKey = this.deps.openAiKey();
    if (!apiKey) throw new Error('no OpenAI key is stored');
    return transcribeOpenAi(apiKey, body, context, this.deps.fetch);
  }
}
