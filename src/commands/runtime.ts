import type { MiaConfig, ProviderConfig } from '../config/schema.js';
import type { Context } from '../context.js';
import { envVarCandidates, resolveApiKey } from '../credentials/resolve.js';
import { UserError } from '../errors.js';
import { createProvider } from '../providers/registry.js';
import { makeRetryPolicy, type RetryInfo } from '../providers/retry.js';
import type { Provider } from '../providers/types.js';
import { isLoopbackHost } from '../security/endpoint.js';
import { registerSecret } from '../security/redact.js';

export interface ProviderRuntime {
  name: string;
  config: ProviderConfig;
  provider: Provider;
  /** Where the key came from (`env:NAME` or `store:<backend>`), or null for key-less local servers. */
  keySource: string | null;
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

/** Resolves the key and builds the provider adapter. The key is never printed. */
export async function openProvider(
  ctx: Context,
  config: MiaConfig,
  name: string,
  onRetry?: (info: RetryInfo) => void,
): Promise<ProviderRuntime> {
  const providerConfig = getProviderConfig(config, name);
  const resolved = await resolveApiKey(name, providerConfig, ctx.env, ctx.credentials);
  const keyless =
    providerConfig.kind === 'openai-compatible' &&
    isLoopbackHost(new URL(providerConfig.baseUrl).hostname);
  if (!resolved && !keyless) throw new UserError(missingKeyMessage(name, providerConfig));
  if (resolved) registerSecret(resolved.key);

  const retry = makeRetryPolicy(config.limits.maxRetries, {
    sleep: ctx.sleep,
    ...(onRetry ? { onRetry } : {}),
  });
  const provider = createProvider(name, providerConfig, resolved?.key, {
    retry,
    timeoutMs: config.limits.requestTimeoutMs,
    fetchImpl: ctx.fetchImpl,
  });
  return { name, config: providerConfig, provider, keySource: resolved?.source ?? null };
}
