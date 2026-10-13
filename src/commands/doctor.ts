import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../config/schema.js';
import type { Context } from '../context.js';
import { resolveApiKey } from '../credentials/resolve.js';
import { ProviderError } from '../providers/errors.js';
import { hostOf } from '../security/endpoint.js';
import { flag, parseFlags } from './flags.js';
import { openProvider } from './runtime.js';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
}

const MIN_NODE_MAJOR = 20;

async function nearestExistingDir(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      const stat = await fs.stat(current);
      if (stat.isDirectory()) return current;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

export async function runChecks(ctx: Context, online: boolean): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string): void => {
    checks.push({ name, status, detail });
  };

  const major = Number(process.versions.node.split('.')[0]);
  add(
    'Node.js',
    major >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    `v${process.versions.node}${major >= MIN_NODE_MAJOR ? '' : ` (Mia Code needs Node ${MIN_NODE_MAJOR} or newer)`}`,
  );
  add('Platform', 'info', `${ctx.platform} ${ctx.arch}`);

  const dir = path.dirname(ctx.config.file);
  const base = await nearestExistingDir(dir);
  try {
    await fs.access(base, fs.constants.W_OK);
    add('Config directory', 'ok', `${dir} (writable)`);
  } catch {
    add(
      'Config directory',
      'fail',
      `${dir} is not writable; set MIA_CONFIG_DIR to a folder you can write to`,
    );
  }

  let config;
  try {
    config = await ctx.config.load();
    add(
      'Config file',
      'ok',
      `${ctx.config.file} (${Object.keys(config.providers).length} provider(s))`,
    );
  } catch (error) {
    add(
      'Config file',
      'fail',
      error instanceof ConfigError ? error.message : (error as Error).message,
    );
  }

  const availability = await ctx.credentials.isAvailable();
  add(
    'Secure key storage',
    availability.available ? 'ok' : 'warn',
    availability.available
      ? ctx.credentials.name
      : `${ctx.credentials.name}: ${(availability.reason ?? 'unavailable').replace(/\.$/, '')}. You can still use environment variables for API keys.`,
  );

  const git = await ctx.run('git', ['--version'], { timeoutMs: 5000 });
  add(
    'git',
    git.exitCode === 0 ? 'ok' : 'warn',
    git.exitCode === 0
      ? git.stdout.trim()
      : 'not found; branch and change information will be unavailable',
  );
  const rg = await ctx.run('rg', ['--version'], { timeoutMs: 5000 });
  add(
    'ripgrep',
    rg.exitCode === 0 ? 'info' : 'info',
    rg.exitCode === 0
      ? `${rg.stdout.split('\n')[0] ?? 'installed'} (used by later versions)`
      : 'not installed (optional; later versions will use it for fast search)',
  );

  add(
    'Terminal (output)',
    'info',
    `${ctx.stdoutIsTTY ? 'interactive' : 'not a terminal'}, colour ${ctx.style.enabled ? 'on' : 'off'}${ctx.env['NO_COLOR'] ? ' (NO_COLOR set)' : ''}`,
  );
  const interactive = ctx.terminal().interactive;
  add(
    'Terminal (input)',
    interactive ? 'ok' : 'info',
    interactive
      ? 'interactive (hidden key entry available)'
      : 'not a terminal (use "mia auth login --stdin" to supply keys)',
  );

  if (config) {
    if (!config.defaultProvider) add('Default provider', 'warn', 'none set; run "mia init"');
    for (const [name, provider] of Object.entries(config.providers).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const key = await resolveApiKey(name, provider, ctx.env, ctx.credentials);
      const marks = [
        config.defaultProvider === name ? 'default' : '',
        provider.model ? `model ${provider.model}` : 'no model selected',
      ]
        .filter(Boolean)
        .join(', ');
      add(
        `Provider "${name}"`,
        key || provider.baseUrl.startsWith('http://') ? (provider.model ? 'ok' : 'warn') : 'warn',
        `${hostOf(provider.baseUrl)}; key ${key ? `found (${key.source})` : 'missing'}; ${marks}`,
      );
      if (online && key) {
        try {
          const runtime = await openProvider(ctx, config, name);
          const models = await runtime.provider.listModels();
          add(`Online check "${name}"`, 'ok', `authenticated, ${models.length} model(s) visible`);
        } catch (error) {
          add(
            `Online check "${name}"`,
            'fail',
            error instanceof ProviderError ? error.describe() : (error as Error).message,
          );
        }
      }
    }
    if (!online)
      add('Network checks', 'info', 'skipped (add --online to test configured providers)');
  }

  add(
    'Telemetry',
    'info',
    'none. Mia Code only contacts the providers you configure (and package registries when you install it).',
  );
  return checks;
}

export async function doctorCommand(args: string[], ctx: Context): Promise<number> {
  const { values } = parseFlags(
    args,
    { online: { type: 'boolean' }, json: { type: 'boolean' } },
    false,
  );
  const checks = await runChecks(ctx, flag(values, 'online'));
  const failures = checks.filter((c) => c.status === 'fail').length;

  if (flag(values, 'json')) {
    ctx.print(JSON.stringify({ ok: failures === 0, checks }, null, 2));
    return failures === 0 ? 0 : 1;
  }
  ctx.print(ctx.style.bold(`Mia Code ${ctx.version} - doctor`));
  const tags: Record<Check['status'], string> = {
    ok: ctx.style.green('[ok]  '),
    warn: ctx.style.yellow('[!!]  '),
    fail: ctx.style.red('[FAIL]'),
    info: ctx.style.dim('[--]  '),
  };
  for (const check of checks) ctx.print(`${tags[check.status]} ${check.name}: ${check.detail}`);
  const warnings = checks.filter((c) => c.status === 'warn').length;
  ctx.print();
  ctx.print(
    failures > 0
      ? `${failures} problem(s) need attention.`
      : warnings > 0
        ? `No blocking problems; ${warnings} warning(s).`
        : 'Everything looks good.',
  );
  return failures === 0 ? 0 : 1;
}
