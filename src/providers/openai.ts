import type { MaxTokensParam } from '../config/schema.js';
import { asNumber, asString, isRecord } from '../util/json.js';
import { ProviderError, errorFromException, errorFromStreamError } from './errors.js';
import { RequestScope, readJson, sendRequest } from './http.js';
import { streamWithRetry, withRetry, type RetryPolicy } from './retry.js';
import { parseSse } from './sse.js';
import { buildToolCall } from './tools.js';
import type { ChatMessage, ChatRequest, ModelInfo, Provider, StreamEvent } from './types.js';

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  /** Omitted for local servers that need no key. */
  apiKey?: string;
  timeoutMs: number;
  retry: RetryPolicy;
  maxTokensParam?: MaxTokensParam;
  fetchImpl?: typeof fetch;
}

/**
 * Adapter for the OpenAI Chat Completions wire format (`/chat/completions`, `/models`).
 * Many providers implement this format; compatibility of tools, streaming options and
 * parameters varies, so nothing beyond plain streamed chat is assumed here.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly kind = 'openai-compatible' as const;
  readonly name: string;
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly maxTokensParam: MaxTokensParam;
  private readonly fetchImpl: typeof fetch;
  /** Cleared if the endpoint rejects `stream_options`, so later requests skip it. */
  private sendUsageOption = true;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.retry = options.retry;
    this.maxTokensParam = options.maxTokensParam ?? 'max_tokens';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'mia-code',
    };
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
    return headers;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    return withRetry(this.retry, signal, async () => {
      const scope = new RequestScope(this.timeoutMs, signal);
      try {
        const response = await sendRequest(
          scope,
          this.name,
          this.fetchImpl,
          `${this.baseUrl}/models`,
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
          const ctx = asNumber(item['context_length']) ?? asNumber(item['context_window']);
          if (ctx !== undefined) info.contextWindow = ctx;
          models.push(info);
        }
        return models.sort((a, b) => a.id.localeCompare(b.id));
      } finally {
        scope.close();
      }
    });
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const run = (includeUsage: boolean) =>
      streamWithRetry(this.retry, request.signal, () => this.attempt(request, includeUsage));

    let yielded = false;
    try {
      for await (const event of run(this.sendUsageOption)) {
        yielded = true;
        yield event;
      }
      return;
    } catch (error) {
      const rejected =
        error instanceof ProviderError &&
        error.code === 'bad_request' &&
        /stream_options|include_usage/i.test(error.message);
      if (yielded || !rejected || !this.sendUsageOption) throw error;
      this.sendUsageOption = false;
    }
    yield* run(false);
  }

  private async *attempt(request: ChatRequest, includeUsage: boolean): AsyncGenerator<StreamEvent> {
    const scope = new RequestScope(this.timeoutMs, request.signal);
    try {
      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages.map(toWireMessage),
        stream: true,
      };
      if (request.tools && request.tools.length > 0) {
        body['tools'] = request.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }
      if (includeUsage) body['stream_options'] = { include_usage: true };
      if (request.maxOutputTokens !== undefined)
        body[this.maxTokensParam] = request.maxOutputTokens;
      if (request.temperature !== undefined) body['temperature'] = request.temperature;

      const response = await sendRequest(
        scope,
        this.name,
        this.fetchImpl,
        `${this.baseUrl}/chat/completions`,
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
      const pending = new Map<number, { id: string; name: string; args: string }>();
      try {
        for await (const sse of parseSse(response.body, () => scope.touch())) {
          if (sse.data === '[DONE]') {
            finished = true;
            break;
          }
          let chunk: unknown;
          try {
            chunk = JSON.parse(sse.data);
          } catch {
            throw new ProviderError({
              provider: this.name,
              code: 'invalid_response',
              message: 'The provider sent a malformed stream chunk.',
            });
          }
          if (!isRecord(chunk)) continue;
          if (chunk['error'] !== undefined && chunk['error'] !== null) {
            throw errorFromStreamError(this.name, chunk['error']);
          }
          const choices = chunk['choices'];
          const choice = Array.isArray(choices) ? choices[0] : undefined;
          if (isRecord(choice)) {
            const delta = choice['delta'];
            const text = isRecord(delta) ? asString(delta['content']) : undefined;
            if (text) yield { type: 'text', text };
            const calls = isRecord(delta) ? delta['tool_calls'] : undefined;
            if (Array.isArray(calls)) {
              for (const raw of calls) {
                if (!isRecord(raw)) continue;
                const index = asNumber(raw['index']) ?? 0;
                const entry = pending.get(index) ?? { id: '', name: '', args: '' };
                const id = asString(raw['id']);
                if (id) entry.id = id;
                const fn = raw['function'];
                if (isRecord(fn)) {
                  const name = asString(fn['name']);
                  if (name) entry.name += name;
                  const args = asString(fn['arguments']);
                  if (args) entry.args += args;
                }
                pending.set(index, entry);
              }
            }
            const reason = asString(choice['finish_reason']);
            if (reason) {
              stopReason = reason;
              finished = true;
            }
          }
          const usage = chunk['usage'];
          if (isRecord(usage)) {
            const u: { inputTokens?: number; outputTokens?: number } = {};
            const input = asNumber(usage['prompt_tokens']);
            const output = asNumber(usage['completion_tokens']);
            if (input !== undefined) u.inputTokens = input;
            if (output !== undefined) u.outputTokens = output;
            yield { type: 'usage', usage: u };
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
      for (const [index, entry] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        if (entry.name === '') continue;
        yield {
          type: 'tool_call',
          call: buildToolCall(entry.id || `call_${index}`, entry.name, entry.args),
        };
      }
      yield stopReason === undefined ? { type: 'done' } : { type: 'done', stopReason };
    } finally {
      scope.close();
    }
  }
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content === '' ? null : m.content,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}
