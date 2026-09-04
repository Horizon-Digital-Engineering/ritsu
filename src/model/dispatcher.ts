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
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  raw: unknown;
}

/** direct runtime → a vendor dispatcher ('claude-direct' today, more as
 *  vendor runtimes ship); api runtime → 'ritsu-agent' (our loop). */
export type DispatcherKind = 'claude-direct' | 'ritsu-agent';

export interface ModelDispatcher {
  readonly kind: DispatcherKind;
  readonly defaultModel: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}
