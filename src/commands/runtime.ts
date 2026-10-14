import type { MiaConfig, ProviderConfig } from '../config/schema.js';
import type { Context } from '../context.js';
import { KeyPool } from '../credentials/pool.js';
import { envVarCandidates, resolveApiKeys } from '../credentials/resolve.js';
import { UserError } from '../errors.js';
import { createProvider } from '../providers/registry.js';
import { makeRetryPolicy, type RetryInfo } from '../providers/retry.js';
import { RotatingProvider, describeRotation, type RotationNotice } from '../providers/rotating.js';
import type { Provider } from '../providers/types.js';
import { isLoopbackHost } from '../security/endpoint.js';
import { registerSecret } from '../security/redact.js';

export interface ProviderRuntime {
  name: string;
  config: ProviderConfig;
  provider: Provider;
  /** Where the key came from (`env:NAME` or `store:<backend>`), or null for key-less local servers. */
  keySource: string | null;
  /** Present when several keys are available; rotation happens automatically. */
  pool: KeyPool | null;
  keyCount: number;
}

export function defaultEnvName(providerName: string): string {
  return `${providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

export function pickProviderName(config: MiaConfig, requested?: string): string {
  const name = requested ?? config.defaultProvider;
  if (!name) throw new UserError('No provider is configured yet. Run "mia init" to set one up.');
  return name;
}

export function getProviderConfig(config: MiaConfig, name: string): ProviderConfig {
  const found = config.providers[name];
  if (!found) {
    const known = Object.keys(config.providers);
    throw new UserError(
      `Unknown provider "${name}".` +
        (known.length > 0
          ? ` Configured providers: ${known.join(', ')}.`
          : ' None are configured; run "mia init".'),
    );
  }
  return found;
}

export function missingKeyMessage(name: string, config: ProviderConfig): string {
  const envNames = envVarCandidates(config);
  const env = envNames.length > 0 ? envNames.join(' or ') : defaultEnvName(name);
  return `No API key found for "${name}". Run "mia auth login ${name}", or set the ${env} environment variable.`;
}

/** Resolves every key and builds the provider adapter (rotating between keys when there are several). The keys are never printed. */
export async function openProvider(
  ctx: Context,
  config: MiaConfig,
  name: string,
  onRetry?: (info: RetryInfo) => void,
  onRotate?: (notice: RotationNotice, message: string) => void,
): Promise<ProviderRuntime> {
  const providerConfig = getProviderConfig(config, name);
  const keys = await resolveApiKeys(name, providerConfig, ctx.env, ctx.credentials);
  const keyless =
    providerConfig.kind === 'openai-compatible' &&
    isLoopbackHost(new URL(providerConfig.baseUrl).hostname);
  if (keys.length === 0 && !keyless) throw new UserError(missingKeyMessage(name, providerConfig));
  for (const k of keys) registerSecret(k.key);

  // With several keys, fail over quickly instead of waiting out a rate limit on one key.
  const retry = makeRetryPolicy(
    keys.length > 1 ? Math.min(1, config.limits.maxRetries) : config.limits.maxRetries,
    {
      sleep: ctx.sleep,
      ...(onRetry ? { onRetry } : {}),
    },
  );
  const build = (key: string | undefined): Provider =>
    createProvider(name, providerConfig, key, {
      retry,
      timeoutMs: config.limits.requestTimeoutMs,
      fetchImpl: ctx.fetchImpl,
    });

  if (keys.length > 1) {
    const pool = new KeyPool(keys);
    const provider = new RotatingProvider({
      name,
      kind: providerConfig.kind,
      baseUrl: providerConfig.baseUrl,
      pool,
      create: (k) => build(k.key),
      ...(onRotate ? { onRotate: (n) => onRotate(n, describeRotation(n)) } : {}),
    });
    return {
      name,
      config: providerConfig,
      provider,
      keySource: `${keys.length} keys`,
      pool,
      keyCount: keys.length,
    };
  }
  const only = keys[0];
  return {
    name,
    config: providerConfig,
    provider: build(only?.key),
    keySource: only?.source ?? null,
    pool: null,
    keyCount: keys.length,
  };
}
