import type { MaxTokensParam, ProviderConfig } from '../config/schema.js';
import { PROVIDER_NAME } from '../config/schema.js';
import type { Context } from '../context.js';
import { resolveApiKey } from '../credentials/resolve.js';
import { UsageError, UserError } from '../errors.js';
import { findPreset, presetToConfig } from '../providers/registry.js';
import { EndpointError, hostOf, normalizeBaseUrl } from '../security/endpoint.js';
import { formatTable } from '../ui/format.js';
import { confirm } from '../ui/prompts.js';
import { suggest } from '../util/suggest.js';
import { flag, parseFlags, str } from './flags.js';
import { getProviderConfig, pickProviderName } from './runtime.js';
import {
  promptProviderChoice,
  recordToolSupport,
  saveProvider,
  testProvider,
  type TestStep,
} from './setup.js';

const SUBCOMMANDS = ['list', 'add', 'test', 'use', 'remove'];

export async function providerCommand(args: string[], ctx: Context): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      return list(ctx);
    case 'add':
      return add(rest, ctx);
    case 'test':
      return test(rest, ctx);
    case 'use':
      return use(rest, ctx);
    case 'remove':
      return remove(rest, ctx);
    default: {
      const hint = sub ? suggest(sub, SUBCOMMANDS) : undefined;
      throw new UsageError(
        sub
          ? `Unknown command "provider ${sub}".${hint ? ` Did you mean "provider ${hint}"?` : ''}`
          : 'Usage: mia provider <list|add|test|use|remove>. See "mia help provider".',
      );
    }
  }
}

async function list(ctx: Context): Promise<number> {
  const cfg = await ctx.config.load();
  const names = Object.keys(cfg.providers).sort();
  if (names.length === 0) {
    ctx.print('No providers configured. Run "mia init", or "mia provider add".');
    return 0;
  }
  const rows: string[][] = [['', 'NAME', 'KIND', 'ENDPOINT', 'MODEL', 'API KEY']];
  for (const name of names) {
    const p = cfg.providers[name];
    if (!p) continue;
    const key = await resolveApiKey(name, p, ctx.env, ctx.credentials);
    rows.push([
      cfg.defaultProvider === name ? '*' : '',
      name,
      p.kind,
      p.baseUrl,
      p.model ?? '(none)',
      key ? 'found' : 'missing',
    ]);
  }
  for (const line of formatTable(rows)) ctx.print(line);
  ctx.print(ctx.style.dim('* = default provider'));
  return 0;
}

async function add(args: string[], ctx: Context): Promise<number> {
  const { values } = parseFlags(
    args,
    {
      name: { type: 'string' },
      preset: { type: 'string' },
      kind: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key-env': { type: 'string' },
      model: { type: 'string' },
      'max-tokens-param': { type: 'string' },
      use: { type: 'boolean' },
      force: { type: 'boolean' },
    },
    false,
  );
  const cfg = await ctx.config.load();
  const anyFlag = Object.keys(values).some((k) => k !== 'force' && k !== 'use');

  let name: string;
  let config: ProviderConfig;

  if (!anyFlag) {
    if (!ctx.terminal().interactive) {
      throw new UsageError(
        'Provide flags (--preset <id>, or --kind and --base-url, plus --name), or run this in a terminal for prompts.',
      );
    }
    const choice = await promptProviderChoice(ctx, cfg);
    name = choice.name;
    config = choice.config;
    if (
      cfg.providers[name] &&
      !flag(values, 'force') &&
      !(await confirm(ctx, `"${name}" already exists. Replace its settings?`, false))
    ) {
      ctx.print('Nothing changed.');
      return 0;
    }
  } else {
    const presetId = str(values, 'preset');
    const preset = findPreset(presetId);
    if (presetId && !preset) {
      throw new UserError(
        `Unknown preset "${presetId}". Available: ${['openai', 'anthropic', 'openrouter', 'groq', 'deepseek'].join(', ')}.`,
      );
    }
    const requestedName = str(values, 'name') ?? preset?.id;
    if (!requestedName) throw new UsageError('--name is required when not using --preset.');
    name = requestedName;
    if (!PROVIDER_NAME.test(name))
      throw new UserError('Provider names use 1-32 characters: a-z, 0-9, "-" or "_".');

    if (preset) config = presetToConfig(preset);
    else {
      const kind = str(values, 'kind');
      if (kind !== 'openai-compatible' && kind !== 'anthropic') {
        throw new UsageError(
          '--kind must be "openai-compatible" or "anthropic" (or use --preset).',
        );
      }
      if (!str(values, 'base-url'))
        throw new UsageError('--base-url is required for a custom provider.');
      config = { kind, baseUrl: '' };
    }
    const baseUrl = str(values, 'base-url');
    try {
      config.baseUrl = normalizeBaseUrl(baseUrl ?? config.baseUrl);
    } catch (error) {
      throw new UserError(error instanceof EndpointError ? error.message : 'Invalid base URL.');
    }
    const apiKeyEnv = str(values, 'api-key-env');
    if (apiKeyEnv) config.apiKeyEnv = apiKeyEnv;
    const model = str(values, 'model');
    if (model) config.model = model;
    const mtp = str(values, 'max-tokens-param');
    if (mtp) {
      if (mtp !== 'max_tokens' && mtp !== 'max_completion_tokens') {
        throw new UsageError('--max-tokens-param must be "max_tokens" or "max_completion_tokens".');
      }
      config.maxTokensParam = mtp as MaxTokensParam;
    }
    if (cfg.providers[name] && !flag(values, 'force')) {
      throw new UserError(`Provider "${name}" already exists. Pass --force to replace it.`);
    }
  }

  await saveProvider(ctx, name, config, flag(values, 'use'));
  ctx.print(`${ctx.style.green('[ok]')} Provider "${name}" saved (${hostOf(config.baseUrl)}).`);
  ctx.print(
    `Next: "mia auth login ${name}", then "mia model use <id>" and "mia provider test ${name}".`,
  );
  return 0;
}

export function printSteps(ctx: Context, steps: readonly TestStep[]): void {
  for (const step of steps) {
    const tag =
      step.status === 'ok'
        ? ctx.style.green('[ok]')
        : step.status === 'warn'
          ? ctx.style.yellow('[!!]')
          : ctx.style.red('[FAIL]');
    ctx.print(`${tag} ${step.label}: ${step.detail}`);
  }
}

async function test(args: string[], ctx: Context): Promise<number> {
  const { positionals } = parseFlags(args, {});
  const cfg = await ctx.config.load();
  const name = pickProviderName(cfg, positionals[0]);
  getProviderConfig(cfg, name);
  ctx.print(
    `Testing "${name}" (sends one tiny prompt to ${hostOf(cfg.providers[name]?.baseUrl ?? '')}; uses a few tokens)...`,
  );
  const outcome = await testProvider(ctx, cfg, name);
  printSteps(ctx, outcome.steps);
  const model = cfg.providers[name]?.model;
  if (outcome.ok && model) await recordToolSupport(ctx, name, model, outcome.toolSupport);
  return outcome.ok ? 0 : 1;
}

async function use(args: string[], ctx: Context): Promise<number> {
  const { positionals } = parseFlags(args, {});
  const name = positionals[0];
  if (!name) throw new UsageError('Usage: mia provider use <name>');
  const cfg = await ctx.config.load();
  getProviderConfig(cfg, name);
  await ctx.config.update((c) => {
    c.defaultProvider = name;
  });
  ctx.print(`Default provider is now "${name}".`);
  return 0;
}

async function remove(args: string[], ctx: Context): Promise<number> {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean' } });
  const name = positionals[0];
  if (!name) throw new UsageError('Usage: mia provider remove <name> [--yes]');
  const cfg = await ctx.config.load();
  getProviderConfig(cfg, name);
  if (!flag(values, 'yes')) {
    if (!ctx.terminal().interactive)
      throw new UsageError('Refusing to remove without confirmation. Pass --yes.');
    if (!(await confirm(ctx, `Remove provider "${name}" and delete its stored API key?`, false))) {
      ctx.print('Nothing removed.');
      return 0;
    }
  }
  await ctx.config.update((c) => {
    delete c.providers[name];
    if (c.defaultProvider === name) delete c.defaultProvider;
    for (const key of Object.keys(c.capabilities))
      if (key.startsWith(`${name}/`)) delete c.capabilities[key];
    for (const key of Object.keys(c.pricing)) if (key.startsWith(`${name}/`)) delete c.pricing[key];
  });
  const deleted = await ctx.credentials.delete(name);
  ctx.print(`Removed provider "${name}"${deleted ? ' and deleted its stored key' : ''}.`);
  return 0;
}
