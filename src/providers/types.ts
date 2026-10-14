import type { ProviderKind } from '../config/schema.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object) describing the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments; empty object when the model sent none or invalid JSON (see `invalidArguments`). */
  arguments: Record<string, unknown>;
  /** Set when the model's arguments could not be parsed as a JSON object. */
  invalidArguments?: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** On assistant messages: tool calls the model made. */
  toolCalls?: ToolCall[];
  /** On tool messages: which call this answers. */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
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
  /** Tools the model may call. Providers/endpoints that do not support tools reject the request. */
  tools?: ToolSpec[];
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
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
 * Tool calls are streamed as complete `tool_call` events (arguments fully assembled).
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
