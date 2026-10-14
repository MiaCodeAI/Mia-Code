import { presetToConfig, findPreset } from '../providers/registry.js';
import type { Context } from '../context.js';
import { envVarCandidates, keyAccount, resolveApiKeys } from '../credentials/resolve.js';
import { KEY_LABEL } from '../config/schema.js';
import { UsageError, UserError } from '../errors.js';
import { hostOf } from '../security/endpoint.js';
import { formatTable } from '../ui/format.js';
import { confirm } from '../ui/prompts.js';
import { suggest } from '../util/suggest.js';
import { flag, parseFlags, str } from './flags.js';
import { getProviderConfig } from './runtime.js';
import { loginProvider, readApiKey, saveProvider } from './setup.js';

const SUBCOMMANDS = ['login', 'list', 'remove'];

export async function authCommand(args: string[], ctx: Context): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'login':
      return login(rest, ctx);
    case 'list':
      return list(ctx);
    case 'remove':
      return remove(rest, ctx);
    default: {
      const hint = sub ? suggest(sub, SUBCOMMANDS) : undefined;
      throw new UsageError(
        sub
          ? `Unknown command "auth ${sub}".${hint ? ` Did you mean "auth ${hint}"?` : ''}`
          : 'Usage: mia auth <login|list|remove>. See "mia help auth".',
      );
    }
  }
}

async function login(args: string[], ctx: Context): Promise<number> {
  const { values, positionals } = parseFlags(args, {
    stdin: { type: 'boolean' },
    'no-validate': { type: 'boolean' },
    label: { type: 'string' },
  });
  const label = str(values, 'label');
  if (label !== undefined && !KEY_LABEL.test(label))
    throw new UsageError(
      '--label must be 1-24 characters of a-z, 0-9, "-" or "_" (starting with a letter or digit).',
    );
  const cfg = await ctx.config.load();
  const name = positionals[0] ?? cfg.defaultProvider;
  if (!name)
    throw new UserError(
      'Say which provider: "mia auth login <provider>" (see "mia provider list"), or run "mia init".',
    );

  if (!cfg.providers[name]) {
    const preset = findPreset(name);
    if (!preset)
      getProviderConfig(cfg, name); // throws a helpful "unknown provider" error
    else {
      await saveProvider(ctx, name, presetToConfig(preset), false);
      ctx.print(`Added the "${name}" provider (${preset.baseUrl}).`);
    }
  }
  const providerConfig = getProviderConfig(await ctx.config.load(), name);

  const terminal = ctx.terminal();
  if (!terminal.interactive && !flag(values, 'stdin')) {
    throw new UserError(
      'stdin is not a terminal, so the key cannot be typed here. Pipe it with --stdin (for example: printf %s "$KEY" | mia auth login ' +
        `${name} --stdin), or set an environment variable instead.`,
    );
  }
  const preset = findPreset(providerConfig.preset);
  if (terminal.interactive && preset)
    ctx.print(`Get a key from the official docs: ${preset.docsUrl}`);
  if (terminal.interactive)
    ctx.print(`The key will be sent only to ${ctx.style.bold(hostOf(providerConfig.baseUrl))}.`);

  if (label && (providerConfig.keyLabels ?? []).includes(label))
    ctx.print(`Replacing the stored key labelled "${label}".`);
  const key = await readApiKey(ctx, name);
  const result = await loginProvider(ctx, name, key, {
    validate: !flag(values, 'no-validate'),
    ...(label ? { label } : {}),
  });

  if (result.models)
    ctx.print(
      `${ctx.style.green('[ok]')} Key accepted by ${hostOf(providerConfig.baseUrl)} (${result.models.length} models visible).`,
    );
  for (const warning of result.warnings) ctx.print(`${ctx.style.yellow('[!!]')} ${warning}`);
  if (result.storedIn) {
    ctx.print(
      `${ctx.style.green('[ok]')} Key${label ? ` "${label}"` : ''} stored in ${result.storedIn}. It is not written to any config file.${label ? ' Mia Code rotates to it when another key runs out or fails.' : ''}`,
    );
  } else {
    ctx.print('The key was NOT saved. Set it as an environment variable so Mia Code can find it:');
    for (const line of result.envInstructions) ctx.print(`  ${line}`);
  }
  const after = await ctx.config.load();
  if (!after.providers[name]?.model)
    ctx.print(`Next: choose a model with "mia model list ${name}" and "mia model use <id>".`);
  return 0;
}

async function list(ctx: Context): Promise<number> {
  const cfg = await ctx.config.load();
  const names = Object.keys(cfg.providers).sort();
  if (names.length === 0) {
    ctx.print('No providers configured. Run "mia init".');
    return 0;
  }
  const rows: string[][] = [['', 'PROVIDER', 'ENDPOINT', 'API KEYS']];
  for (const name of names) {
    const providerConfig = cfg.providers[name];
    if (!providerConfig) continue;
    const keys = await resolveApiKeys(name, providerConfig, ctx.env, ctx.credentials);
    rows.push([
      cfg.defaultProvider === name ? '*' : '',
      name,
      hostOf(providerConfig.baseUrl),
      keys.length === 0
        ? 'missing'
        : `${keys.length} found: ${keys.map((k) => `${k.label} (${k.source})`).join(', ')}`,
    ]);
  }
  for (const line of formatTable(rows)) ctx.print(line);
  ctx.print(
    ctx.style.dim(
      'Keys are never displayed. * = default provider. With several keys Mia Code switches automatically when one runs out or fails.',
    ),
  );
  return 0;
}

async function remove(args: string[], ctx: Context): Promise<number> {
  const { values, positionals } = parseFlags(args, {
    yes: { type: 'boolean' },
    label: { type: 'string' },
    all: { type: 'boolean' },
  });
  const label = str(values, 'label');
  const name = positionals[0];
  if (!name)
    throw new UsageError('Usage: mia auth remove <provider> [--label <name> | --all] [--yes]');
  const cfg = await ctx.config.load();
  const providerConfig = getProviderConfig(cfg, name);

  if (!flag(values, 'yes')) {
    if (!ctx.terminal().interactive)
      throw new UsageError('Refusing to delete without confirmation. Pass --yes.');
    if (
      !(await confirm(
        ctx,
        `Delete the stored API key${label ? ` "${label}"` : flag(values, 'all') ? 's' : ''} for "${name}"?`,
        false,
      ))
    ) {
      ctx.print('Nothing deleted.');
      return 0;
    }
  }
  const targets: (string | undefined)[] = flag(values, 'all')
    ? [undefined, ...(providerConfig.keyLabels ?? [])]
    : [label];
  let removedAny = false;
  for (const target of targets) {
    if (await ctx.credentials.delete(keyAccount(name, target))) removedAny = true;
  }
  const dropLabels = flag(values, 'all') ? (providerConfig.keyLabels ?? []) : label ? [label] : [];
  if (dropLabels.length > 0)
    await ctx.config.update((c) => {
      const p = c.providers[name];
      if (p?.keyLabels) {
        p.keyLabels = p.keyLabels.filter((l) => !dropLabels.includes(l));
        if (p.keyLabels.length === 0) delete p.keyLabels;
      }
    });
  ctx.print(
    removedAny
      ? `Deleted the stored key${targets.length > 1 ? 's' : ''} for "${name}" from ${ctx.credentials.name}.`
      : `No stored key was found for "${name}".`,
  );
  for (const envName of envVarCandidates(providerConfig)) {
    if (ctx.env[envName])
      ctx.print(
        `Note: the ${envName} environment variable is still set; unset it yourself if you want it gone.`,
      );
  }
  return 0;
}
