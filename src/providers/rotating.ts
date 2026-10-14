import { KeyPool, type RotationReason } from '../credentials/pool.js';
import type { PooledKey } from '../credentials/resolve.js';
import { ProviderError } from './errors.js';
import type { ChatRequest, ModelInfo, Provider, StreamEvent } from './types.js';

export interface RotationNotice {
  provider: string;
  from: string;
  to: string | null;
  reason: RotationReason;
  remaining: number;
}

export interface RotatingOptions {
  name: string;
  kind: Provider['kind'];
  baseUrl: string;
  pool: KeyPool;
  /** Builds an adapter for one key. */
  create: (key: PooledKey) => Provider;
  onRotate?: (notice: RotationNotice) => void;
}

const REASON_TEXT: Record<RotationReason, string> = {
  quota: 'ran out of quota',
  rate_limit: 'is rate limited',
  auth: 'was rejected',
  outage: 'hit a provider problem',
};
export function describeRotation(n: RotationNotice): string {
  const base = `API key "${n.from}" ${REASON_TEXT[n.reason]}`;
  return n.to
    ? `${base}; switched to "${n.to}" (${n.remaining} key(s) still usable).`
    : `${base}; no other key is usable.`;
}

/**
 * Provider that fails over between several API keys. A request is moved to the next key only
 * when nothing has been streamed yet (so a reply is never duplicated or spliced); once output has
 * started, errors are reported as they are. Each key is tried at most once per request.
 */
export class RotatingProvider implements Provider {
  readonly name: string;
  readonly kind: Provider['kind'];
  readonly baseUrl: string;
  constructor(private readonly options: RotatingOptions) {
    this.name = options.name;
    this.kind = options.kind;
    this.baseUrl = options.baseUrl;
  }

  private exhausted(last: ProviderError | undefined): ProviderError {
    const wait = this.options.pool.soonestRetryMs();
    const status = this.options.pool
      .status()
      .map(
        (s) =>
          `${s.label}: ${s.state === 'ready' ? 'ready' : `${s.state}${s.reason ? ` (${s.reason.replace('_', ' ')})` : ''}`}`,
      )
      .join('; ');
    return new ProviderError({
      provider: this.name,
      code: last?.code ?? 'unknown',
      message:
        `All ${this.options.pool.size} API key(s) for "${this.name}" are unusable right now. ${last ? `Last error: ${last.message}` : ''}`.trim(),
      ...(last?.status !== undefined ? { status: last.status } : {}),
      hint:
        `Key status — ${status}. ` +
        (wait !== null
          ? `The soonest key is usable again in about ${Math.ceil(wait / 1000)}s. `
          : '') +
        'Add another key with "mia auth login <provider> --label <name>", or check your plan and billing.',
    });
  }

  /** 'none': another key would not help; 'rotated': moved on; 'exhausted': no usable key remains. */
  private rotate(key: PooledKey, error: unknown): 'none' | 'rotated' | 'exhausted' {
    const outcome = this.options.pool.report(key, error);
    if (!outcome) return 'none';
    this.options.onRotate?.({
      provider: this.name,
      from: key.label,
      to: outcome.next?.label ?? null,
      reason: outcome.reason,
      remaining: this.options.pool.status().filter((s) => s.state === 'ready').length,
    });
    return outcome.next ? 'rotated' : 'exhausted';
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let last: ProviderError | undefined;
    for (let attempt = 0; attempt < this.options.pool.size; attempt++) {
      const key = this.options.pool.current();
      if (!key) break;
      try {
        return await this.options.create(key).listModels(signal);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        last = error;
        const result = this.rotate(key, error);
        if (result === 'none') throw error;
        if (result === 'exhausted') throw this.exhausted(error);
      }
    }
    throw this.exhausted(last);
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<StreamEvent> {
    let last: ProviderError | undefined;
    for (let attempt = 0; attempt < this.options.pool.size; attempt++) {
      const key = this.options.pool.current();
      if (!key) break;
      let yielded = false;
      try {
        for await (const event of this.options.create(key).streamChat(request)) {
          yielded = true;
          yield event;
        }
        return;
      } catch (error) {
        if (!(error instanceof ProviderError) || yielded) throw error;
        last = error;
        const result = this.rotate(key, error);
        if (result === 'none') throw error;
        if (result === 'exhausted') throw this.exhausted(error);
      }
    }
    throw this.exhausted(last);
  }
}
