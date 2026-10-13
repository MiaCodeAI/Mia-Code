import { asNumber, asString, isRecord } from '../util/json.js';
import { ProviderError, errorFromException, errorFromStreamError } from './errors.js';
import { RequestScope, readJson, sendRequest } from './http.js';
import { streamWithRetry, withRetry, type RetryPolicy } from './retry.js';
import { parseSse } from './sse.js';
import type { ChatRequest, ModelInfo, Provider, StreamEvent } from './types.js';

export const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retry: RetryPolicy;
  fetchImpl?: typeof fetch;
}

/** Native adapter for the Anthropic Messages API (`/v1/messages`, `/v1/models`). */
export class AnthropicProvider implements Provider {
  readonly kind = 'anthropic' as const;
  readonly name: string;
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.retry = options.retry;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'user-agent': 'mia-code',
    };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    return withRetry(this.retry, signal, async () => {
      const scope = new RequestScope(this.timeoutMs, signal);
      try {
        const response = await sendRequest(
          scope,
          this.name,
          this.fetchImpl,
          `${this.baseUrl}/v1/models?limit=1000`,
          {
            method: 'GET',
            headers: this.headers(),
          },
        );
        const json = await readJson(scope, this.name, response);
        const data = isRecord(json) ? json['data'] : undefined;
        if (!Array.isArray(data)) {
          throw new ProviderError({
            provider: this.name,
            code: 'invalid_response',
            message: 'The models endpoint returned an unexpected shape (no "data" list).',
          });
        }
        const models: ModelInfo[] = [];
        for (const item of data) {
          if (!isRecord(item)) continue;
          const id = asString(item['id']);
          if (!id) continue;
          const info: ModelInfo = { id };
          const displayName = asString(item['display_name']);
          if (displayName) info.displayName = displayName;
          models.push(info);
        }
        return models.sort((a, b) => a.id.localeCompare(b.id));
      } finally {
        scope.close();
      }
    });
  }

  streamChat(request: ChatRequest): AsyncGenerator<StreamEvent> {
    return streamWithRetry(this.retry, request.signal, () => this.attempt(request));
  }

  private async *attempt(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const scope = new RequestScope(this.timeoutMs, request.signal);
    try {
      const system = request.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const body: Record<string, unknown> = {
        model: request.model,
        max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        messages: request.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      };
      if (system !== '') body['system'] = system;
      if (request.temperature !== undefined) body['temperature'] = request.temperature;

      const response = await sendRequest(
        scope,
        this.name,
        this.fetchImpl,
        `${this.baseUrl}/v1/messages`,
        {
          method: 'POST',
          headers: { ...this.headers(), accept: 'text/event-stream' },
          body: JSON.stringify(body),
        },
      );
      if (!response.body) {
        throw new ProviderError({
          provider: this.name,
          code: 'invalid_response',
          message: 'The provider sent an empty response.',
        });
      }

      let stopReason: string | undefined;
      let finished = false;
      try {
        for await (const sse of parseSse(response.body, () => scope.touch())) {
          let data: unknown;
          try {
            data = JSON.parse(sse.data);
          } catch {
            throw new ProviderError({
              provider: this.name,
              code: 'invalid_response',
              message: 'The provider sent a malformed stream event.',
            });
          }
          if (!isRecord(data)) continue;
          const type = asString(data['type']) ?? sse.event;

          if (type === 'error') throw errorFromStreamError(this.name, data['error']);

          if (type === 'message_start') {
            const message = data['message'];
            const usage = isRecord(message) ? message['usage'] : undefined;
            const input = isRecord(usage) ? asNumber(usage['input_tokens']) : undefined;
            if (input !== undefined) yield { type: 'usage', usage: { inputTokens: input } };
          } else if (type === 'content_block_delta') {
            const delta = data['delta'];
            if (isRecord(delta) && delta['type'] === 'text_delta') {
              const text = asString(delta['text']);
              if (text) yield { type: 'text', text };
            }
          } else if (type === 'message_delta') {
            const delta = data['delta'];
            const reason = isRecord(delta) ? asString(delta['stop_reason']) : undefined;
            if (reason) stopReason = reason;
            const usage = data['usage'];
            const output = isRecord(usage) ? asNumber(usage['output_tokens']) : undefined;
            if (output !== undefined) yield { type: 'usage', usage: { outputTokens: output } };
          } else if (type === 'message_stop') {
            finished = true;
            break;
          }
        }
      } catch (error) {
        throw errorFromException(this.name, error, scope.state());
      }
      if (!finished) {
        throw new ProviderError({
          provider: this.name,
          code: 'invalid_response',
          message:
            'The response stream ended before the model finished. The answer above may be incomplete.',
        });
      }
      yield stopReason === undefined ? { type: 'done' } : { type: 'done', stopReason };
    } finally {
      scope.close();
    }
  }
}
