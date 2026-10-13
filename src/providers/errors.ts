import { redact } from '../security/redact.js';
import { asString, isRecord } from '../util/json.js';

export type ProviderErrorCode =
  | 'auth'
  | 'permission'
  | 'rate_limit'
  | 'quota'
  | 'model_not_found'
  | 'not_found'
  | 'bad_request'
  | 'context_length'
  | 'server'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'invalid_response'
  | 'unknown';

export interface ProviderErrorInit {
  code: ProviderErrorCode;
  provider: string;
  message: string;
  status?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  hint?: string;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly hint: string | undefined;

  constructor(init: ProviderErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'ProviderError';
    this.code = init.code;
    this.provider = init.provider;
    this.status = init.status;
    this.retryable = init.retryable ?? false;
    this.retryAfterMs = init.retryAfterMs;
    this.hint = init.hint;
  }

  /** Message plus hint, ready to show to the user. */
  describe(): string {
    return this.hint ? `${this.message}\n  ${this.hint}` : this.message;
  }
}

const MAX_DETAIL = 300;

function clean(text: string): string {
  const flat = redact(text).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL)}…` : flat;
}

/** Pulls a human-readable message out of the common provider error body shapes. */
export function extractDetail(body: string): string {
  if (body.trim() === '') return '';
  try {
    const json: unknown = JSON.parse(body);
    if (isRecord(json)) {
      const err = json['error'];
      if (isRecord(err)) {
        const message = asString(err['message']);
        if (message) return clean(message);
      }
      if (typeof err === 'string') return clean(err);
      const message = asString(json['message']);
      if (message) return clean(message);
    }
  } catch {
    // not JSON; fall through to raw text
  }
  return clean(body);
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

const QUOTA =
  /insufficient_quota|exceeded your current quota|billing|credit balance|out of credits|payment required|insufficient (?:balance|funds)/i;
const CONTEXT =
  /context[_ ]length|maximum context|context window|too long|too many tokens|prompt is too long|reduce the length/i;

export function errorFromResponse(
  provider: string,
  status: number,
  body: string,
  headers: Headers,
): ProviderError {
  const detail = extractDetail(body);
  const suffix = detail ? ` Provider said: ${detail}` : '';
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'));
  const base = { provider, status } as const;

  if (status === 401) {
    return new ProviderError({
      ...base,
      code: 'auth',
      message: `Authentication failed (HTTP 401): the provider rejected the API key.${suffix}`,
      hint: `Re-enter the key with "mia auth login ${provider}". Keys only work with the provider that issued them.`,
    });
  }
  if (status === 403) {
    return new ProviderError({
      ...base,
      code: 'permission',
      message: `Access denied (HTTP 403).${suffix}`,
      hint: 'The key may lack access to this model, organization or region.',
    });
  }
  if (status === 402 || (status === 429 && QUOTA.test(body))) {
    return new ProviderError({
      ...base,
      code: 'quota',
      message: `The account is out of quota or credit (HTTP ${status}).${suffix}`,
      hint: 'Check billing and usage limits with your provider. Mia Code never switches provider or model on its own.',
    });
  }
  if (status === 429) {
    const init: ProviderErrorInit = {
      ...base,
      code: 'rate_limit',
      message: `Rate limited by the provider (HTTP 429).${suffix}`,
      retryable: true,
      hint: 'Wait a moment and try again, or reduce request frequency.',
    };
    if (retryAfterMs !== undefined) init.retryAfterMs = retryAfterMs;
    return new ProviderError(init);
  }
  if (status === 404) {
    const modelRelated = /model/i.test(body);
    return new ProviderError({
      ...base,
      code: modelRelated ? 'model_not_found' : 'not_found',
      message: modelRelated
        ? `The model was not found or is not available to this key (HTTP 404).${suffix}`
        : `Endpoint not found (HTTP 404).${suffix}`,
      hint: modelRelated
        ? 'List valid names with "mia model list" and pick one with "mia model use <id>".'
        : 'Check the provider base URL ("mia provider list").',
    });
  }
  if (status === 408) {
    return new ProviderError({
      ...base,
      code: 'timeout',
      message: `The provider timed out (HTTP 408).${suffix}`,
      retryable: true,
    });
  }
  if (status === 413 || ((status === 400 || status === 422) && CONTEXT.test(body))) {
    return new ProviderError({
      ...base,
      code: 'context_length',
      message: `The request is too large for this model's context window.${suffix}`,
      hint: 'Use /clear to start a fresh conversation, or choose a model with a larger context window.',
    });
  }
  if (status === 400 || status === 422) {
    return new ProviderError({
      ...base,
      code: 'bad_request',
      message: `The provider rejected the request (HTTP ${status}).${suffix}`,
    });
  }
  if (status >= 500) {
    const init: ProviderErrorInit = {
      ...base,
      code: 'server',
      message: `The provider had a server error (HTTP ${status}).${suffix}`,
      retryable: true,
    };
    if (retryAfterMs !== undefined) init.retryAfterMs = retryAfterMs;
    return new ProviderError(init);
  }
  return new ProviderError({
    ...base,
    code: 'unknown',
    message: `Unexpected response from the provider (HTTP ${status}).${suffix}`,
  });
}

/** Maps an error object delivered inside a stream (after HTTP 200) to a ProviderError. */
export function errorFromStreamError(provider: string, error: unknown): ProviderError {
  const record = isRecord(error) ? error : {};
  const type = (asString(record['type']) ?? asString(record['code']) ?? '').toLowerCase();
  const message = clean(
    asString(record['message']) ?? 'The provider reported an error during streaming.',
  );
  let code: ProviderErrorCode = 'unknown';
  if (type.includes('auth')) code = 'auth';
  else if (type.includes('rate')) code = 'rate_limit';
  else if (type.includes('overload') || type.includes('server') || type.includes('api_error'))
    code = 'server';
  else if (type.includes('invalid_request')) code = 'bad_request';
  return new ProviderError({
    provider,
    code,
    message: `Provider error during streaming: ${message}`,
  });
}

const TLS_CODES = /^(?:UNABLE_TO_|CERT_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS)/;

export function errorFromException(
  provider: string,
  error: unknown,
  state: { timedOut: boolean; aborted: boolean },
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (state.timedOut) {
    return new ProviderError({
      provider,
      code: 'timeout',
      message: 'The provider did not respond in time.',
      retryable: true,
      hint: 'Raise "limits.requestTimeoutMs" in the config if the model needs longer.',
      cause: error,
    });
  }
  const name = error instanceof Error ? error.name : '';
  if (state.aborted || name === 'AbortError') {
    return new ProviderError({
      provider,
      code: 'cancelled',
      message: 'Request cancelled.',
      cause: error,
    });
  }
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const causeCode = isRecord(cause) ? asString(cause['code']) : undefined;
  if (causeCode && TLS_CODES.test(causeCode)) {
    return new ProviderError({
      provider,
      code: 'network',
      message: `TLS certificate verification failed (${causeCode}).`,
      hint: 'If you are behind a corporate proxy, set NODE_EXTRA_CA_CERTS to your CA bundle. Never disable certificate checks.',
      cause: error,
    });
  }
  return new ProviderError({
    provider,
    code: 'network',
    message: `Could not reach the provider${causeCode ? ` (${causeCode})` : ''}.`,
    retryable: true,
    hint: 'Check your internet connection and the provider base URL.',
    cause: error,
  });
}
