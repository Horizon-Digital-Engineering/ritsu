export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Override the dispatcher's default model for this call. */
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  raw: unknown;
}

export type DispatcherKind = 'claude-direct' | 'litellm' | 'ritsu-agent';

export interface ModelDispatcher {
  readonly kind: DispatcherKind;
  readonly defaultModel: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}
