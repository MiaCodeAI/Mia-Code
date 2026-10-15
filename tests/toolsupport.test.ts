import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { ProviderError } from '../src/providers/errors.js';
import { isToolsUnsupported, probeToolCalling } from '../src/providers/toolsupport.js';
import { OpenAICompatibleProvider } from '../src/providers/openai.js';
import {
  fakeFetch,
  jsonResponse,
  makeHarness,
  sseResponse,
  type TestHarness,
} from './helpers/fakes.js';

let h: TestHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const err = (message: string, status = 400): ProviderError =>
  new ProviderError({ code: 'bad_request', provider: 'groq', message, status });
const retry = { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined };
const KEY = 'sk-test-abcdefghijklmnopqrstuvwx';

describe('isToolsUnsupported', () => {
  it('recognises provider rejections of tools', () => {
    expect(isToolsUnsupported(err('`tool calling` is not supported with this model'))).toBe(true);
    expect(isToolsUnsupported(err('Extra inputs are not permitted: tools'))).toBe(true);
    expect(isToolsUnsupported(err('This model does not support function calling'))).toBe(true);
    expect(isToolsUnsupported(err('No endpoints found that support tool use', 404))).toBe(true);
  });
  it('does not treat bad tool calls or other errors as unsupported', () => {
    expect(isToolsUnsupported(err('tool_use_failed: Failed to call a function'))).toBe(false);
    expect(isToolsUnsupported(err('max_tokens is too large'))).toBe(false);
    expect(isToolsUnsupported(new Error('tool not supported'))).toBe(false);
  });
});

describe('tool probe', () => {
  const mk = (fetchImpl: typeof fetch) =>
    new OpenAICompatibleProvider({
      name: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: KEY,
      timeoutMs: 5000,
      retry,
      fetchImpl,
    });

  it('reports unsupported when the provider rejects tools', async () => {
    const f = fakeFetch([
      () =>
        jsonResponse(
          { error: { message: '`tool calling` is not supported with this model' } },
          400,
        ),
    ]);
    expect((await probeToolCalling(mk(f.fetch), 'allam-2-7b')).status).toBe('unsupported');
  });
  it('reports supported when the model emits a tool call', async () => {
    const body =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ping","arguments":"{\\"value\\":\\"hello\\"}"}}]}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
    const f = fakeFetch([() => sseResponse(body)]);
    expect((await probeToolCalling(mk(f.fetch), 'm')).status).toBe('supported');
  });
  it('reports unclear for a text answer and unknown for other failures', async () => {
    const text = 'data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n';
    expect(
      (await probeToolCalling(mk(fakeFetch([() => sseResponse(text)]).fetch), 'm')).status,
    ).toBe('unclear');
    const f = fakeFetch([() => jsonResponse({ error: { message: 'boom' } }, 500)]);
    expect((await probeToolCalling(mk(f.fetch), 'm')).status).toBe('unknown');
  });
});

describe('session fallback', () => {
  it('answers in chat mode when the model rejects tools, instead of failing', async () => {
    const chat =
      'data: {"choices":[{"delta":{"content":"This project is empty."}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const f = fakeFetch([
      () =>
        jsonResponse(
          { error: { message: '`tool calling` is not supported with this model' } },
          400,
        ),
      () => sseResponse(chat),
    ]);
    h = await makeHarness({
      input: ['scan project', '/mode', '/quit'],
      fetchImpl: f.fetch,
      env: { OPENAI_API_KEY: KEY },
    });
    await run(['provider', 'add', '--preset', 'openai', '--use', '--model', 'allam-2-7b'], h.ctx);
    expect(await run([], h.ctx)).toBe(0);
    const out = h.out.join('\n');
    expect(out).toContain('does not support tool calling');
    expect(out).toContain('Switching to chat mode');
    expect(out).toContain('This project is empty.');
    expect(out).toMatch(/Mode: chat/);
    expect(f.calls.length).toBe(2);
    expect((f.calls[0]!.body as { tools?: unknown }).tools).toBeDefined();
    expect((f.calls[1]!.body as { tools?: unknown }).tools).toBeUndefined();
  });

  it('starts in chat mode when the model is recorded as unsupported', async () => {
    h = await makeHarness({ input: ['/quit'], env: { OPENAI_API_KEY: KEY } });
    await run(['provider', 'add', '--preset', 'openai', '--use', '--model', 'm1'], h.ctx);
    await h.ctx.config.update((c) => {
      c.capabilities['openai/m1'] = { tools: false };
    });
    expect(await run([], h.ctx)).toBe(0);
    expect(h.out.join('\n')).toContain('starts in chat mode');
  });

  it('mia run explains and exits 1', async () => {
    const f = fakeFetch([
      () =>
        jsonResponse(
          { error: { message: '`tool calling` is not supported with this model' } },
          400,
        ),
    ]);
    h = await makeHarness({ fetchImpl: f.fetch, env: { OPENAI_API_KEY: KEY } });
    await run(['provider', 'add', '--preset', 'openai', '--use', '--model', 'm1'], h.ctx);
    expect(await run(['run', '--mode', 'readonly', 'scan project'], h.ctx)).toBe(1);
    expect(h.err.join('\n')).toMatch(/does not support tool calling/);
    expect(h.err.join('\n')).toMatch(/mia model use/);
  });
});
