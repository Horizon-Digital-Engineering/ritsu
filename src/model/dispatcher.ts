import { logger } from '../util/log.js';

/** A text span inside a multi-part message. */
export interface ChatTextBlock {
  type: 'text';
  text: string;
}

/** An image attached to a user turn. `data` is raw base64 (NO `data:` URL
 *  prefix); `media_type` is the MIME type (image/png, image/jpeg, …). Each
 *  dispatcher translates this into its provider's native shape (Anthropic
 *  `{type:'image',source:{type:'base64',…}}`, OpenAI `image_url` data-URL). */
export interface ChatImageBlock {
  type: 'image';
  media_type: string;
  data: string;
}

export type ChatContentBlock = ChatTextBlock | ChatImageBlock;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Plain string for the common case; a block array when the turn carries
   *  images (only user turns do today). */
  content: string | ChatContentBlock[];
}

/** Flatten a message's content to plain text — joins text blocks, drops
 *  images. Used wherever a string is needed (logging, the claude-direct
 *  flattened-prompt blob, providers without vision). */
export function messageText(content: string | ChatContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content.filter((b): b is ChatTextBlock => b.type === 'text').map(b => b.text).join('');
}

/** Pull the image blocks out of a message's content (empty for string content). */
export function messageImages(content: string | ChatContentBlock[]): ChatImageBlock[] {
  if (typeof content === 'string') return [];
  return content.filter((b): b is ChatImageBlock => b.type === 'image');
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Override the dispatcher's default model for this call. */
  model?: string;
  /** The conversation this turn belongs to. Used to scope human-in-the-loop
   *  approval cards to the right thread (so they render inline in the chat
   *  panel). Undefined for callers that don't track a conversation. */
  conversation_id?: number;
  /** Who initiated this turn. `scheduler:<jobId>` when a scheduled job woke the
   *  agent — which is what suppresses the scheduling tools, so one fire cannot
   *  create more work. Provenance-only otherwise. */
  caller_label?: string | null;
  onEvent?: (e: TurnEvent) => void;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  raw: unknown;
  tool_calls?: ToolActivity[];
  stopped?: boolean;
}

/** direct runtime → a vendor dispatcher ('claude-direct' today, more as
 *  vendor runtimes ship); api runtime → 'ritsu-agent' (our loop). */
export type DispatcherKind = 'claude-direct' | 'ritsu-agent';

export interface ModelDispatcher {
  readonly kind: DispatcherKind;
  readonly defaultModel: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface ToolActivity {
  /** Unique within the turn. */
  id: string;
  name: string;
  args: string;
  status: 'running' | 'done' | 'error';
  result?: string;
}

export type TurnEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; call: ToolActivity };

export const TOOL_ARGS_MAX = 2_000;
export const TOOL_RESULT_MAX = 4_000;

export function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max - 1);
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;   // never split a surrogate pair
  return s.slice(0, end) + '…';
}

function argsText(args: unknown): string {
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return String(args);
  }
}

/** Ignores callbacks after `finish`, so a tool still settling after a stop
 *  cannot publish into a turn that has ended. */
export class TurnRecorder {
  private streamed = '';
  private toolSinceText = false;
  private ended = false;
  private readonly calls: ToolActivity[] = [];
  private readonly byId = new Map<string, ToolActivity>();

  constructor(private readonly onEvent?: (e: TurnEvent) => void) {}

  get text(): string { return this.streamed; }

  write(delta: string): void {
    if (this.ended || !delta) return;
    if (this.toolSinceText && this.streamed) this.emitText('\n\n');
    this.toolSinceText = false;
    this.emitText(delta);
  }

  /** A repeated id is the same call announced again. */
  toolStart(id: string, name: string, args: unknown): void {
    if (this.ended || this.byId.has(id)) return;
    const call: ToolActivity = { id, name, args: clipText(argsText(args), TOOL_ARGS_MAX), status: 'running' };
    this.calls.push(call);
    this.byId.set(id, call);
    this.toolSinceText = true;
    this.emit({ type: 'tool', call: { ...call } });
  }

  toolEnd(id: string, result: string, isError: boolean): void {
    const call = this.byId.get(id);
    if (this.ended || call?.status !== 'running') return;
    call.status = isError ? 'error' : 'done';
    call.result = clipText(result, TOOL_RESULT_MAX);
    this.emit({ type: 'tool', call: { ...call } });
  }

  finish(note: string): ToolActivity[] {
    this.ended = true;
    for (const c of this.calls) {
      if (c.status === 'running') { c.status = 'error'; c.result = note; }
    }
    return this.calls.map(c => ({ ...c }));
  }

  private emitText(delta: string): void {
    this.streamed += delta;
    this.emit({ type: 'text', delta });
  }

  private emit(e: TurnEvent): void {
    // A broken listener (a UI feed) must never fail the turn it is watching.
    try {
      this.onEvent?.(e);
    } catch (err) {
      logger.warn('turn.listener-failed', { err: (err as Error).message });
    }
  }
}

/** Rejects once `signal` aborts; a late settle of `p` is absorbed. */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('stopped'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (err: unknown) => { signal.removeEventListener('abort', onAbort); reject(err instanceof Error ? err : new Error(String(err))); },
    );
  });
}
