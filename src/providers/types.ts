import type { ProviderKind } from '../config/schema.js';

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatRequest {
  model: string;
  /** May include system messages; adapters map them to each API's convention. */
  messages: ChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stopReason?: string };

export interface ModelInfo {
  id: string;
  displayName?: string;
  /** Only present when the provider's model listing reports it. */
  contextWindow?: number;
}

/**
 * The common surface every provider adapter implements.
 * Tool calling and structured output are intentionally not part of this interface yet
 * (they arrive with the agent engine in Phase 3).
 */
export interface Provider {
  readonly name: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  /** Lists models. Also serves as the authentication check. */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Streams a chat completion. Throws ProviderError on failure. */
  streamChat(request: ChatRequest): AsyncGenerator<StreamEvent>;
}
