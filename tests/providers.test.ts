import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { ProviderError } from '../src/providers/errors.js';
import { OpenAICompatibleProvider } from '../src/providers/openai.js';
import { makeRetryPolicy } from '../src/providers/retry.js';
import type { Provider, StreamEvent } from '../src/providers/types.js';
import { fakeFetch, jsonResponse, sseResponse } from './helpers/fakes.js';

const retry = (n = 2) => makeRetryPolicy(n, { sleep: async () => undefined });

async function drain(provider: Provider, signal?: AbortSignal): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of provider.streamChat({
    model: 'm',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    ...(signal ? { signal } : {}),
  })) {
    events.push(e);
  }
  return events;
}

const openaiStream =
  'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n' +
  'data: [DONE]\n\n';

function openai(
  f: typeof fetch,
  extra: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {},
) {
  return new OpenAICompatibleProvider({
    name: 'oa',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'test-key-12345678',
    timeoutMs: 5000,
    retry: retry(),
    fetchImpl: f,
    ...extra,
  });
}

describe('OpenAICompatibleProvider', () => {
  it('streams text, usage and stop reason, sending the key only as a bearer header', async () => {
    const { fetch, calls } = fakeFetch([() => sseResponse(openaiStream, 9)]);
    const events = await drain(openai(fetch));
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Hello');
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 11, outputTokens: 2 } });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });

    const call = calls[0]!;
    expect(call.url).toBe('https://api.example.com/v1/chat/completions');
    expect(call.headers['authorization']).toBe('Bearer test-key-12345678');
    expect(JSON.stringify(call.body)).not.toContain('test-key-12345678');
    expect(call.body).toMatchObject({
      model: 'm',
      stream: true,
      messages: [{ role: 'system' }, { role: 'user' }],
    });
  });

  it('uses the configured max-tokens parameter name', async () => {
    const { fetch, calls } = fakeFetch([() => sseResponse(openaiStream)]);
    const p = openai(fetch, { maxTokensParam: 'max_completion_tokens' });
    for await (const _ of p.streamChat({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 50,
    }))
      void _;
    expect(calls[0]!.body).toMatchObject({ max_completion_tokens: 50 });
    expect(calls[0]!.body).not.toHaveProperty('max_tokens');
  });

  it('omits the Authorization header for key-less local endpoints', async () => {
    const { fetch, calls } = fakeFetch([() => sseResponse(openaiStream)]);
    const p = new OpenAICompatibleProvider({
      name: 'local',
      baseUrl: 'http://localhost:11434/v1',
      timeoutMs: 5000,
      retry: retry(),
      fetchImpl: fetch,
    });
    await drain(p);
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('retries a rate limit before any output and then succeeds', async () => {
    const { fetch, calls } = fakeFetch([
      () => jsonResponse({ error: { message: 'slow' } }, 429, { 'retry-after': '1' }),
      () => sseResponse(openaiStream),
    ]);
    const events = await drain(openai(fetch));
    expect(calls).toHaveLength(2);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('does not retry authentication failures, and never echoes the key', async () => {
    const { fetch, calls } = fakeFetch([
      () => jsonResponse({ error: { message: 'bad key test-key-12345678' } }, 401),
    ]);
    const error = await drain(openai(fetch)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('auth');
    expect(calls).toHaveLength(1);
  });

  it('gives up after maxRetries on persistent server errors', async () => {
    const { fetch, calls } = fakeFetch([
      () => new Response('x', { status: 503 }),
      () => new Response('x', { status: 503 }),
      () => new Response('x', { status: 503 }),
    ]);
    const error = (await drain(openai(fetch)).catch((e: unknown) => e)) as ProviderError;
    expect(error.code).toBe('server');
    expect(calls).toHaveLength(3);
  });

  it('does not retry after text has been delivered (would duplicate output)', async () => {
    const broken = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
    const { fetch, calls } = fakeFetch([
      () => sseResponse(broken),
      () => sseResponse(openaiStream),
    ]);
    const seen: StreamEvent[] = [];
    const p = openai(fetch);
    const error = await (async () => {
      try {
        for await (const e of p.streamChat({
          model: 'm',
          messages: [{ role: 'user', content: 'x' }],
        }))
          seen.push(e);
      } catch (e) {
        return e as ProviderError;
      }
    })();
    expect(seen).toEqual([{ type: 'text', text: 'partial' }]);
    expect(error?.code).toBe('invalid_response');
    expect(error?.message).toMatch(/ended before the model finished/);
    expect(calls).toHaveLength(1);
  });

  it('reports errors delivered inside a 200 stream', async () => {
    const { fetch } = fakeFetch([
      () => sseResponse('data: {"error":{"message":"overloaded","type":"server_error"}}\n\n'),
    ]);
    const error = (await drain(openai(fetch, { retry: retry(0) })).catch(
      (e: unknown) => e,
    )) as ProviderError;
    expect(error.code).toBe('server');
    expect(error.message).toContain('overloaded');
  });

  it('refuses to follow redirects (which could leak the key to another host)', async () => {
    const { fetch, calls } = fakeFetch([
      () =>
        new Response(null, { status: 307, headers: { location: 'https://evil.example/steal' } }),
    ]);
    const error = (await drain(openai(fetch)).catch((e: unknown) => e)) as ProviderError;
    expect(error.code).toBe('invalid_response');
    expect(error.message).toMatch(/redirect/);
    expect(calls).toHaveLength(1);
  });

  it('retries without stream_options if the endpoint rejects it, remembering the result', async () => {
    const { fetch, calls } = fakeFetch([
      () => jsonResponse({ error: { message: 'Unknown parameter: stream_options' } }, 400),
      () => sseResponse(openaiStream),
      () => sseResponse(openaiStream),
    ]);
    const p = openai(fetch);
    await drain(p);
    await drain(p);
    expect(calls[0]!.body).toHaveProperty('stream_options');
    expect(calls[1]!.body).not.toHaveProperty('stream_options');
    expect(calls[2]!.body).not.toHaveProperty('stream_options');
  });

  it('lists models, including reported context windows, sorted', async () => {
    const { fetch, calls } = fakeFetch([
      () => jsonResponse({ data: [{ id: 'b', context_length: 1000 }, { id: 'a' }, { nope: 1 }] }),
    ]);
    const models = await openai(fetch).listModels();
    expect(models).toEqual([{ id: 'a' }, { id: 'b', contextWindow: 1000 }]);
    expect(calls[0]!.url).toBe('https://api.example.com/v1/models');
  });

  it('rejects a non-API endpoint that answers with HTML', async () => {
    const { fetch } = fakeFetch([() => new Response('<html></html>', { status: 200 })]);
    const error = (await openai(fetch)
      .listModels()
      .catch((e: unknown) => e)) as ProviderError;
    expect(error.code).toBe('invalid_response');
  });

  it('cancels promptly when the signal aborts', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as typeof fetch;
    const pending = drain(openai(fetchImpl), controller.signal).catch((e: unknown) => e);
    controller.abort();
    expect(((await pending) as ProviderError).code).toBe('cancelled');
  });

  it('times out when the provider stops responding', async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as typeof fetch;
    const p = openai(fetchImpl, { timeoutMs: 20, retry: retry(0) });
    expect(((await drain(p).catch((e: unknown) => e)) as ProviderError).code).toBe('timeout');
  });
});

const anthropicStream =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: ping\ndata: {"type":"ping"}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

function anthropic(f: typeof fetch) {
  return new AnthropicProvider({
    name: 'an',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'ant-key-12345678',
    timeoutMs: 5000,
    retry: retry(),
    fetchImpl: f,
  });
}

describe('AnthropicProvider', () => {
  it('maps system messages to the system field and streams text with usage', async () => {
    const { fetch, calls } = fakeFetch([() => sseResponse(anthropicStream, 11)]);
    const events = await drain(anthropic(fetch));
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Hi there');
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 25 } });
    expect(events).toContainEqual({ type: 'usage', usage: { outputTokens: 7 } });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' });

    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['x-api-key']).toBe('ant-key-12345678');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.headers['authorization']).toBeUndefined();
    expect(call.body).toMatchObject({
      system: 'sys',
      stream: true,
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('surfaces mid-stream errors', async () => {
    const { fetch } = fakeFetch([
      () =>
        sseResponse(
          'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
        ),
    ]);
    const p = new AnthropicProvider({
      name: 'an',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'ant-key-12345678',
      timeoutMs: 5000,
      retry: retry(0),
      fetchImpl: fetch,
    });
    const error = (await drain(p).catch((e: unknown) => e)) as ProviderError;
    expect(error.code).toBe('server');
  });

  it('lists models with display names', async () => {
    const { fetch, calls } = fakeFetch([
      () => jsonResponse({ data: [{ id: 'm1', display_name: 'Model One' }] }),
    ]);
    expect(await anthropic(fetch).listModels()).toEqual([{ id: 'm1', displayName: 'Model One' }]);
    expect(calls[0]!.url).toContain('/v1/models');
  });

  it('fails when the stream ends without message_stop', async () => {
    const { fetch } = fakeFetch([
      () => sseResponse(anthropicStream.replace(/event: message_stop[\s\S]*$/, '')),
    ]);
    const p = new AnthropicProvider({
      name: 'an',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'ant-key-12345678',
      timeoutMs: 5000,
      retry: retry(0),
      fetchImpl: fetch,
    });
    const error = (await drain(p).catch((e: unknown) => e)) as ProviderError;
    expect(error.code).toBe('invalid_response');
  });
});
