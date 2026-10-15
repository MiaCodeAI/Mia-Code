/**
 * Opt-in integration checks against real services. Skipped unless MIA_LIVE=1.
 * Run: MIA_LIVE=1 npm run test:live  (see docs/verification.md). These may spend a few tokens.
 *
 * Providers:  MIA_LIVE_OPENAI_KEY / MIA_LIVE_OPENAI_BASE_URL / MIA_LIVE_OPENAI_MODEL
 *             MIA_LIVE_ANTHROPIC_KEY / MIA_LIVE_ANTHROPIC_MODEL
 * Credential store: runs on the current OS (macOS Keychain, Windows DPAPI, Linux secret-tool).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCredentialStore } from '../../src/credentials/resolve.js';
import { defaultPathContext } from '../../src/platform/paths.js';
import { runCommand } from '../../src/platform/exec.js';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { OpenAICompatibleProvider } from '../../src/providers/openai.js';
import type { Provider, StreamEvent } from '../../src/providers/types.js';

const live = process.env['MIA_LIVE'] === '1';
const retry = {
  maxRetries: 1,
  baseDelayMs: 500,
  maxDelayMs: 2000,
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

async function collect(provider: Provider, model: string, tools = false): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of provider.streamChat({
    model,
    maxOutputTokens: 64,
    messages: [
      {
        role: 'user',
        content: tools ? 'Call the tool "ping" with {"n": 1}.' : 'Reply with the single word: pong',
      },
    ],
    ...(tools
      ? {
          tools: [
            {
              name: 'ping',
              description: 'ping',
              parameters: {
                type: 'object',
                properties: { n: { type: 'integer' } },
                required: ['n'],
              },
            },
          ],
        }
      : {}),
  }))
    events.push(e);
  return events;
}

describe.skipIf(!live)('live: credential store round trip (current OS)', () => {
  it('stores, reads, overwrites and deletes a secret', async () => {
    const store = createCredentialStore(defaultPathContext(), runCommand);
    const avail = await store.isAvailable();
    if (!avail.available) {
      console.warn(`credential store unavailable here: ${avail.reason}`);
      return;
    }
    const account = `mia-live-test-${randomUUID()}`;
    const secret = `s3cret-${randomUUID()}-with spaces "quotes" $dollar`;
    try {
      await store.set(account, secret);
      expect(await store.get(account)).toBe(secret);
      await store.set(account, 'second');
      expect(await store.get(account)).toBe('second');
    } finally {
      await store.delete(account);
    }
    expect(await store.get(account)).toBeNull();
    expect(await store.delete(account)).toBe(false);
  });
});

const oKey = process.env['MIA_LIVE_OPENAI_KEY'];
describe.skipIf(!live || !oKey)('live: OpenAI-compatible provider', () => {
  const base = process.env['MIA_LIVE_OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1';
  const model = process.env['MIA_LIVE_OPENAI_MODEL'] ?? '';
  const p = new OpenAICompatibleProvider({
    name: 'live',
    baseUrl: base,
    apiKey: oKey as string,
    timeoutMs: 60_000,
    retry,
  });
  it('lists models (auth check)', async () => {
    expect((await p.listModels()).length).toBeGreaterThan(0);
  });
  it.skipIf(!model)('streams text and usage', async () => {
    const ev = await collect(p, model);
    expect(ev.some((e) => e.type === 'text')).toBe(true);
    expect(ev.at(-1)?.type).toBe('done');
  });
  it.skipIf(!model)('emits a complete tool call', async () => {
    const ev = await collect(p, model, true);
    expect(ev.some((e) => e.type === 'tool_call')).toBe(true);
  });
});

const aKey = process.env['MIA_LIVE_ANTHROPIC_KEY'];
describe.skipIf(!live || !aKey)('live: Anthropic provider', () => {
  const model = process.env['MIA_LIVE_ANTHROPIC_MODEL'] ?? '';
  const p = new AnthropicProvider({
    name: 'live',
    baseUrl: 'https://api.anthropic.com',
    apiKey: aKey as string,
    timeoutMs: 60_000,
    retry,
  });
  it('lists models (auth check)', async () => {
    expect((await p.listModels()).length).toBeGreaterThan(0);
  });
  it.skipIf(!model)('streams text', async () => {
    const ev = await collect(p, model);
    expect(ev.some((e) => e.type === 'text')).toBe(true);
  });
  it.skipIf(!model)('emits a complete tool call', async () => {
    const ev = await collect(p, model, true);
    expect(ev.some((e) => e.type === 'tool_call')).toBe(true);
  });
});
