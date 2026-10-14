import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { KeyPool } from '../src/credentials/pool.js';
import { MemoryCredentialStore } from '../src/credentials/types.js';
import { resolveApiKeys, splitKeys } from '../src/credentials/resolve.js';
import { ProviderError } from '../src/providers/errors.js';
import { RotatingProvider, type RotationNotice } from '../src/providers/rotating.js';
import type { ChatRequest, Provider, StreamEvent } from '../src/providers/types.js';
import { fakeFetch, jsonResponse, makeHarness, sseResponse } from './helpers/fakes.js';

const key = (label: string) => ({ key: `sk-${label}-0123456789abcdef`, source: 'test', label });
const err = (code: ProviderError['code'], retryAfterMs?: number) =>
  new ProviderError({
    provider: 'p',
    code,
    message: `${code} happened`,
    ...(retryAfterMs ? { retryAfterMs } : {}),
  });

function fakeProvider(
  script: Record<string, (req: ChatRequest) => StreamEvent[] | ProviderError>,
): (k: { key: string; label: string }) => Provider {
  return (k) => ({
    name: 'p',
    kind: 'openai-compatible',
    baseUrl: 'https://x.test',
    async listModels() {
      const r = script[k.label]?.({ model: 'm', messages: [] });
      if (r instanceof ProviderError) throw r;
      return [{ id: 'm' }];
    },
    async *streamChat(req) {
      const r = script[k.label]?.(req);
      if (r instanceof ProviderError) throw r;
      for (const e of r ?? []) yield e;
    },
  });
}
const ok = (t: string): StreamEvent[] => [{ type: 'text', text: t }, { type: 'done' }];
async function collect(p: Provider): Promise<string> {
  let t = '';
  for await (const e of p.streamChat({ model: 'm', messages: [] }))
    if (e.type === 'text') t += e.text;
  return t;
}

describe('KeyPool', () => {
  it('sticks to one key and fails over on quota, rate limit and auth errors', () => {
    let now = 1000;
    const pool = new KeyPool([key('a'), key('b'), key('c')], () => now);
    expect(pool.current()?.label).toBe('a');
    expect(pool.current()?.label).toBe('a');
    expect(pool.report(key('a'), err('quota'))?.next?.label).toBe('b');
    expect(pool.report(key('b'), err('auth'))?.next?.label).toBe('c');
    expect(pool.report(key('c'), err('rate_limit', 5000))?.next).toBeNull();
    expect(pool.current()).toBeNull();
    now += 6000; // rate-limit cooldown over; quota and auth stay parked
    expect(pool.current()?.label).toBe('c');
    expect(pool.status().map((s) => s.state)).toEqual(['cooling-down', 'disabled', 'ready']);
  });

  it('ignores errors another key cannot fix', () => {
    const pool = new KeyPool([key('a'), key('b')]);
    expect(pool.report(key('a'), err('bad_request'))).toBeNull();
    expect(pool.report(key('a'), err('context_length'))).toBeNull();
    expect(pool.current()?.label).toBe('a');
  });
});

describe('RotatingProvider', () => {
  it('moves to the next key before any output and reports the switch', async () => {
    const notices: RotationNotice[] = [];
    const p = new RotatingProvider({
      name: 'p',
      kind: 'openai-compatible',
      baseUrl: 'https://x.test',
      pool: new KeyPool([key('a'), key('b')]),
      create: fakeProvider({ a: () => err('quota'), b: () => ok('hello') }),
      onRotate: (n) => notices.push(n),
    });
    expect(await collect(p)).toBe('hello');
    expect(notices).toMatchObject([{ from: 'a', to: 'b', reason: 'quota' }]);
    expect(await collect(p)).toBe('hello'); // stays on b
    expect(notices).toHaveLength(1);
  });

  it('does not rotate after output has started, nor for errors keys cannot fix', async () => {
    const mid = new RotatingProvider({
      name: 'p',
      kind: 'openai-compatible',
      baseUrl: 'x',
      pool: new KeyPool([key('a'), key('b')]),
      create: (k) => ({
        name: 'p',
        kind: 'openai-compatible',
        baseUrl: 'x',
        listModels: async () => [],
        async *streamChat() {
          if (k.label === 'a') {
            yield { type: 'text', text: 'par' };
            throw err('server');
          }
          yield { type: 'text', text: 'never' };
        },
      }),
    });
    await expect(collect(mid)).rejects.toMatchObject({ code: 'server' });
    const bad = new RotatingProvider({
      name: 'p',
      kind: 'openai-compatible',
      baseUrl: 'x',
      pool: new KeyPool([key('a'), key('b')]),
      create: fakeProvider({ a: () => err('bad_request'), b: () => ok('x') }),
    });
    await expect(collect(bad)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('explains when every key is unusable', async () => {
    const p = new RotatingProvider({
      name: 'p',
      kind: 'openai-compatible',
      baseUrl: 'x',
      pool: new KeyPool([key('a'), key('b')]),
      create: fakeProvider({ a: () => err('quota'), b: () => err('auth') }),
    });
    const e = await collect(p).catch((x: unknown) => x as ProviderError);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).message).toMatch(/All 2 API key/);
    expect((e as ProviderError).hint).toMatch(/a: .*quota/);
    expect(JSON.stringify(e)).not.toContain('0123456789abcdef');
  });

  it('rotates listModels too', async () => {
    const p = new RotatingProvider({
      name: 'p',
      kind: 'openai-compatible',
      baseUrl: 'x',
      pool: new KeyPool([key('a'), key('b')]),
      create: fakeProvider({ a: () => err('auth'), b: () => ok('') }),
    });
    expect(await p.listModels()).toEqual([{ id: 'm' }]);
  });
});

describe('resolving several keys', () => {
  it('collects env (comma separated), default and labelled keys without duplicates', async () => {
    const store = new MemoryCredentialStore();
    await store.set('openai', 'sk-default-key-0001');
    await store.set('openai--work', 'sk-work-key-00002');
    const keys = await resolveApiKeys(
      'openai',
      {
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        preset: 'openai',
        keyLabels: ['work', 'gone'],
      },
      { OPENAI_API_KEY: 'sk-env-one-000003, sk-env-two-000004\nsk-default-key-0001' },
      store,
    );
    expect(keys.map((k) => k.label)).toEqual([
      'OPENAI_API_KEY#1',
      'OPENAI_API_KEY#2',
      'OPENAI_API_KEY#3',
      'work',
    ]);
    expect(splitKeys('a, b;c  d')).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('multi-key end to end', () => {
  it('rotates to the second key when the first is out of quota, using real adapters', async () => {
    const f = fakeFetch([
      () =>
        jsonResponse(
          { error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } },
          429,
        ),
      () =>
        sseResponse(
          'data: {"choices":[{"delta":{"content":"hi from key 2"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
    ]);
    const h = await makeHarness({
      env: { OPENAI_API_KEY: 'sk-first-key-0000001,sk-second-key-000002' },
      fetchImpl: f.fetch,
    });
    try {
      await run(['provider', 'add', '--preset', 'openai', '--model', 'm1'], h.ctx);
      expect(await run(['ask', '--no-context', 'hello'], h.ctx)).toBe(0);
      expect(h.out.join('')).toContain('hi from key 2');
      expect(h.err.join('\n')).toMatch(/ran out of quota; switched to/);
      const auth = (call: number) =>
        (f.calls[call]!.headers as Record<string, string>)['authorization'];
      expect(auth(0)).toContain('sk-first-key');
      expect(auth(1)).toContain('sk-second-key');
      expect(h.err.join('\n') + h.out.join('\n')).not.toContain('sk-second-key-000002');
    } finally {
      await h.cleanup();
    }
  });

  it('adds a labelled key with auth login --label and lists it', async () => {
    const f = fakeFetch([
      () => jsonResponse({ data: [{ id: 'm1' }] }),
      () => jsonResponse({ data: [{ id: 'm1' }] }),
    ]);
    const h = await makeHarness({ input: ['sk-labelled-key-000009'], fetchImpl: f.fetch });
    try {
      await run(['provider', 'add', '--preset', 'openai'], h.ctx);
      await h.credentials.set('openai', 'sk-default-key-0000001');
      expect(await run(['auth', 'login', 'openai', '--label', 'backup'], h.ctx)).toBe(0);
      expect((await h.ctx.config.load()).providers['openai']?.keyLabels).toEqual(['backup']);
      h.out.length = 0;
      await run(['auth', 'list'], h.ctx);
      expect(h.out.join('\n')).toMatch(/2 found: default .*backup/);
      expect(await run(['auth', 'remove', 'openai', '--label', 'backup', '--yes'], h.ctx)).toBe(0);
      expect((await h.ctx.config.load()).providers['openai']?.keyLabels).toBeUndefined();
      expect(await h.credentials.get('openai--backup')).toBeNull();
    } finally {
      await h.cleanup();
    }
  });
});
