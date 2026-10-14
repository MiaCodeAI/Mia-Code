import type { MiaConfig, ProviderConfig } from '../config/schema.js';
import { PROVIDER_NAME } from '../config/schema.js';
import type { Context } from '../context.js';
import { keyAccount } from '../credentials/resolve.js';
import { UserError } from '../errors.js';
import { ProviderError } from '../providers/errors.js';
import {
  PRESETS,
  createProvider,
  findPreset,
  presetToConfig,
  type ProviderPreset,
} from '../providers/registry.js';
import { makeRetryPolicy } from '../providers/retry.js';
import type { ModelInfo } from '../providers/types.js';
import { EndpointError, hostOf, isLoopbackHost, normalizeBaseUrl } from '../security/endpoint.js';
import { registerSecret } from '../security/redact.js';
import { ask, choose, confirm } from '../ui/prompts.js';
import { defaultEnvName, getProviderConfig, openProvider } from './runtime.js';

export interface ProviderChoice {
  name: string;
  config: ProviderConfig;
  preset?: ProviderPreset;
}

/** Interactive: pick a preset or describe a custom endpoint. Validates the URL before any key is requested. */
export async function promptProviderChoice(
  ctx: Context,
  existing: MiaConfig,
): Promise<ProviderChoice> {
  const labels = [
    ...PRESETS.map((p) => `${p.label} (${p.id})`),
    'Custom endpoint (OpenAI-compatible or Anthropic-compatible)',
  ];
  const index = await choose(ctx, 'Which provider?', labels);
  const preset = PRESETS[index];

  let name: string;
  let config: ProviderConfig;
  if (preset) {
    name = await promptName(ctx, existing, preset.id);
    config = presetToConfig(preset);
    return { name, config, preset };
  }

  const kindIndex = await choose(ctx, 'API style?', [
    'OpenAI-compatible (/chat/completions)',
    'Anthropic Messages (/v1/messages)',
  ]);
  const kind = kindIndex === 1 ? 'anthropic' : 'openai-compatible';
  let baseUrl: string;
  for (;;) {
    const raw = await ask(
      ctx,
      'Base URL (for example https://api.example.com/v1 or http://localhost:11434/v1)',
    );
    try {
      baseUrl = normalizeBaseUrl(raw);
      break;
    } catch (error) {
      ctx.print(ctx.style.red(error instanceof EndpointError ? error.message : 'Invalid URL.'));
    }
  }
  if (!isLoopbackHost(new URL(baseUrl).hostname)) {
    ctx.print(
      `Your API key will be sent to ${ctx.style.bold(hostOf(baseUrl))} and to nowhere else.`,
    );
    if (!(await confirm(ctx, 'Do you trust this endpoint?', false)))
      throw new UserError('Setup cancelled.');
  }
  name = await promptName(ctx, existing, 'custom');
  config = { kind, baseUrl };
  return { name, config };
}

async function promptName(ctx: Context, existing: MiaConfig, suggestion: string): Promise<string> {
  for (;;) {
    const name = await ask(ctx, 'Name for this provider', suggestion);
    if (PROVIDER_NAME.test(name)) return name;
    ctx.print(ctx.style.red('Use 1-32 characters: a-z, 0-9, "-" or "_".'));
    void existing;
  }
}

export async function saveProvider(
  ctx: Context,
  name: string,
  config: ProviderConfig,
  makeDefault: boolean,
): Promise<void> {
  await ctx.config.update((cfg) => {
    const previous = cfg.providers[name];
    cfg.providers[name] =
      previous?.model && !config.model ? { ...config, model: previous.model } : config;
    if (makeDefault || !cfg.defaultProvider) cfg.defaultProvider = name;
  });
}

const MIN_KEY_LENGTH = 8;

/** Reads a key without echo (terminal) or as a plain line (pipe). */
export async function readApiKey(ctx: Context, providerName: string): Promise<string> {
  const terminal = ctx.terminal();
  const line = await terminal.readSecret(`API key for "${providerName}" (input is hidden): `);
  if (line === null) throw new UserError('No key was provided.');
  const key = line.trim();
  if (key.length < MIN_KEY_LENGTH)
    throw new UserError('That does not look like an API key (too short). Nothing was stored.');
  if (/\s/.test(key) || [...key].some((ch) => ch.charCodeAt(0) < 32)) {
    throw new UserError(
      'An API key cannot contain spaces or control characters. Nothing was stored.',
    );
  }
  return key;
}

export interface LoginResult {
  models: ModelInfo[] | null;
  /** Name of the secure store used, or null when the key must come from an environment variable. */
  storedIn: string | null;
  /** Shown to the user when no secure store was available. */
  envInstructions: string[];
  warnings: string[];
}

export function envInstructionsFor(ctx: Context, envName: string): string[] {
  if (ctx.platform === 'win32') {
    return [
      `PowerShell (this window):      $env:${envName} = "<your key>"`,
      `PowerShell (persist for you):  [Environment]::SetEnvironmentVariable("${envName}", "<your key>", "User")`,
    ];
  }
  return [`export ${envName}="<your key>"   # add to your shell profile to keep it`];
}

/**
 * Validates a key against the provider (a model-list request, sent only to the configured host),
 * then stores it in the OS credential store. If the key is rejected nothing is stored.
 */
export async function loginProvider(
  ctx: Context,
  name: string,
  key: string,
  options: { validate: boolean; label?: string },
): Promise<LoginResult> {
  const cfg = await ctx.config.load();
  const providerConfig = getProviderConfig(cfg, name);
  registerSecret(key);
  const warnings: string[] = [];
  let models: ModelInfo[] | null = null;

  if (options.validate) {
    const provider = createProvider(name, providerConfig, key, {
      retry: makeRetryPolicy(Math.min(1, cfg.limits.maxRetries), { sleep: ctx.sleep }),
      timeoutMs: Math.min(cfg.limits.requestTimeoutMs, 30_000),
      fetchImpl: ctx.fetchImpl,
    });
    try {
      models = await provider.listModels();
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (error.code === 'auth') {
        throw new UserError(`${error.describe()}\n  The key was not stored.`);
      }
      if (
        error.code === 'permission' ||
        error.code === 'not_found' ||
        error.code === 'invalid_response'
      ) {
        warnings.push(
          `Could not confirm the key by listing models (${error.code.replace('_', ' ')}). It was stored anyway; run "mia provider test ${name}" to check it works.`,
        );
      } else {
        throw new UserError(
          `${error.describe()}\n  Could not verify the key, so nothing was stored. Use --no-validate to store it without checking.`,
        );
      }
    }
  }

  const availability = await ctx.credentials.isAvailable();
  if (availability.available) {
    try {
      await ctx.credentials.set(keyAccount(name, options.label), key);
      if (options.label) {
        const label = options.label;
        await ctx.config.update((c) => {
          const p = c.providers[name];
          if (p) p.keyLabels = [...new Set([...(p.keyLabels ?? []), label])];
        });
      }
      return { models, storedIn: ctx.credentials.name, envInstructions: [], warnings };
    } catch (error) {
      warnings.push(`Secure storage failed: ${(error as Error).message}`);
    }
  } else {
    warnings.push(
      `Secure credential storage is unavailable: ${(availability.reason ?? 'unknown reason').replace(/\.$/, '')}.`,
    );
  }

  // Fall back to the explicit, opt-in environment-variable method. The key itself is not saved.
  const envName = providerConfig.apiKeyEnv ?? defaultEnvName(name);
  if (!providerConfig.apiKeyEnv) {
    await ctx.config.update((c) => {
      const p = c.providers[name];
      if (p && !findPreset(p.preset)) p.apiKeyEnv = envName;
    });
  }
  const effectiveEnv = findPreset(providerConfig.preset)?.envVar ?? envName;
  return {
    models,
    storedIn: null,
    envInstructions: envInstructionsFor(ctx, effectiveEnv),
    warnings,
  };
}

/** Lets the user pick a model from the provider's list, or type an id. Saves the choice. */
export async function selectModel(
  ctx: Context,
  name: string,
  models: ModelInfo[] | null,
): Promise<string> {
  let chosen: string | undefined;
  if (!models || models.length === 0) {
    ctx.print(
      'This provider did not offer a model list, so type the model id exactly as the provider documents it.',
    );
    chosen = await ask(ctx, 'Model id');
  } else if (models.length <= 12) {
    const index = await choose(
      ctx,
      'Which model?',
      models.map((m) => m.id),
    );
    chosen = models[index]?.id;
  } else {
    ctx.print(
      `${models.length} models are available. Type part of a name to filter, or the full id.`,
    );
    while (!chosen) {
      const term = await ask(ctx, 'Model (id or filter)');
      const exact = models.find((m) => m.id === term);
      if (exact) {
        chosen = exact.id;
        break;
      }
      const matches = models
        .filter((m) => m.id.toLowerCase().includes(term.toLowerCase()))
        .slice(0, 15);
      if (matches.length === 0) ctx.print('No model matches that text.');
      else if (matches.length === 1 && matches[0]) chosen = matches[0].id;
      else {
        const index = await choose(
          ctx,
          'Pick one (or press Ctrl-C to cancel)',
          matches.map((m) => m.id),
        );
        chosen = matches[index]?.id;
      }
    }
  }
  if (!chosen) throw new UserError('No model selected.');
  const model = chosen;
  await ctx.config.update((cfg) => {
    const p = cfg.providers[name];
    if (p) p.model = model;
  });
  return model;
}

export interface TestStep {
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface TestOutcome {
  ok: boolean;
  steps: TestStep[];
}

/** Authentication check, model check and a minimal streamed request (a few tokens). */
export async function testProvider(
  ctx: Context,
  config: MiaConfig,
  name: string,
): Promise<TestOutcome> {
  const steps: TestStep[] = [];
  const fail = (label: string, detail: string): TestOutcome => {
    steps.push({ label, status: 'fail', detail });
    return { ok: false, steps };
  };

  let runtime;
  try {
    runtime = await openProvider(ctx, config, name);
  } catch (error) {
    return fail('API key', (error as Error).message);
  }
  steps.push({
    label: 'API key',
    status: 'ok',
    detail: runtime.keySource
      ? `found (${runtime.keySource})`
      : 'not required for this local endpoint',
  });

  let models: ModelInfo[] | null = null;
  try {
    models = await runtime.provider.listModels();
    steps.push({
      label: 'Authentication',
      status: 'ok',
      detail: `${models.length} model(s) listed by ${hostOf(runtime.config.baseUrl)}`,
    });
  } catch (error) {
    if (
      error instanceof ProviderError &&
      (error.code === 'not_found' ||
        error.code === 'permission' ||
        error.code === 'invalid_response')
    ) {
      steps.push({
        label: 'Authentication',
        status: 'warn',
        detail: `model listing unavailable (${error.code.replace('_', ' ')}); checking with a chat request instead`,
      });
    } else if (error instanceof ProviderError) {
      return fail('Authentication', error.describe());
    } else throw error;
  }

  const model = runtime.config.model;
  if (!model) {
    steps.push({
      label: 'Model',
      status: 'warn',
      detail: `none selected; run "mia model use <id>"`,
    });
    return { ok: true, steps };
  }
  if (models && !models.some((m) => m.id === model)) {
    steps.push({
      label: 'Model',
      status: 'warn',
      detail: `"${model}" is not in the provider's model list`,
    });
  } else {
    steps.push({ label: 'Model', status: 'ok', detail: model });
  }

  const started = Date.now();
  let text = '';
  let tokens = '';
  try {
    for await (const event of runtime.provider.streamChat({
      model,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      maxOutputTokens: 64,
    })) {
      if (event.type === 'text') text += event.text;
      if (event.type === 'usage') {
        if (event.usage.inputTokens !== undefined)
          tokens = `${tokens} in ${event.usage.inputTokens}`;
        if (event.usage.outputTokens !== undefined)
          tokens = `${tokens} out ${event.usage.outputTokens}`;
      }
    }
  } catch (error) {
    if (error instanceof ProviderError) return fail('Streaming request', error.describe());
    throw error;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  steps.push({
    label: 'Streaming request',
    status: text.trim() === '' ? 'warn' : 'ok',
    detail:
      text.trim() === ''
        ? `completed in ${seconds}s but returned no text (a reasoning model may have used the small token budget)`
        : `completed in ${seconds}s${tokens ? `, tokens${tokens}` : ''}`,
  });
  return { ok: true, steps };
}
