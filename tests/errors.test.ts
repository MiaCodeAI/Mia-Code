import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  errorFromException,
  errorFromResponse,
  extractDetail,
  parseRetryAfter,
} from '../src/providers/errors.js';
import { clearRegisteredSecrets } from '../src/security/redact.js';

const h = (init: Record<string, string> = {}) => new Headers(init);

describe('errorFromResponse', () => {
  it('maps auth failures with an actionable hint', () => {
    const e = errorFromResponse(
      'openai',
      401,
      '{"error":{"message":"Incorrect API key provided: sk-abcdefghijklmnopqrstuvwx"}}',
      h(),
    );
    expect(e.code).toBe('auth');
    expect(e.retryable).toBe(false);
    expect(e.describe()).toContain('mia auth login openai');
    expect(e.describe()).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });

  it('separates quota exhaustion from rate limiting', () => {
    const quota = errorFromResponse(
      'p',
      429,
      '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
      h(),
    );
    expect(quota.code).toBe('quota');
    expect(quota.retryable).toBe(false);
    const rate = errorFromResponse(
      'p',
      429,
      '{"error":{"message":"slow down"}}',
      h({ 'retry-after': '3' }),
    );
    expect(rate.code).toBe('rate_limit');
    expect(rate.retryable).toBe(true);
    expect(rate.retryAfterMs).toBe(3000);
    expect(errorFromResponse('p', 402, '', h()).code).toBe('quota');
  });

  it('recognizes missing models, context overflow, bad requests and server errors', () => {
    expect(
      errorFromResponse('p', 404, '{"error":{"message":"The model `x` does not exist"}}', h()).code,
    ).toBe('model_not_found');
    expect(errorFromResponse('p', 404, 'nope', h()).code).toBe('not_found');
    expect(
      errorFromResponse(
        'p',
        400,
        '{"error":{"message":"maximum context length is 8192 tokens"}}',
        h(),
      ).code,
    ).toBe('context_length');
    expect(errorFromResponse('p', 400, '{"error":{"message":"bad field"}}', h()).code).toBe(
      'bad_request',
    );
    const server = errorFromResponse('p', 503, 'overloaded', h());
    expect(server.code).toBe('server');
    expect(server.retryable).toBe(true);
  });

  it('truncates very long provider messages', () => {
    expect(extractDetail('x'.repeat(5000)).length).toBeLessThan(400);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and dates, ignores junk', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfter(future) ?? 0;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(5000);
  });
});

describe('errorFromException', () => {
  it('distinguishes timeouts, cancellation and network failures', () => {
    expect(errorFromException('p', new Error('x'), { timedOut: true, aborted: false }).code).toBe(
      'timeout',
    );
    expect(errorFromException('p', new Error('x'), { timedOut: false, aborted: true }).code).toBe(
      'cancelled',
    );
    const dns = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    const e = errorFromException('p', dns, { timedOut: false, aborted: false });
    expect(e.code).toBe('network');
    expect(e.message).toContain('ENOTFOUND');
    const tls = new TypeError('fetch failed', {
      cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    });
    expect(errorFromException('p', tls, { timedOut: false, aborted: false }).hint).toContain(
      'NODE_EXTRA_CA_CERTS',
    );
  });

  it('passes ProviderErrors through unchanged', () => {
    const original = new ProviderError({ provider: 'p', code: 'auth', message: 'm' });
    expect(errorFromException('p', original, { timedOut: false, aborted: false })).toBe(original);
  });
});

clearRegisteredSecrets();
