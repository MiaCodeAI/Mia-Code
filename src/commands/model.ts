import type { Context } from '../context.js';
import { UsageError, UserError } from '../errors.js';
import { describeCapabilities, resolveCapabilities } from '../providers/capabilities.js';
import { suggest } from '../util/suggest.js';
import { parseFlags, str } from './flags.js';
import { getProviderConfig, openProvider, pickProviderName } from './runtime.js';

const SUBCOMMANDS = ['list', 'use'];

export async function modelCommand(args: string[], ctx: Context): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      return list(rest, ctx);
    case 'use':
      return use(rest, ctx);
    default: {
      const hint = sub ? suggest(sub, SUBCOMMANDS) : undefined;
      throw new UsageError(
        sub
          ? `Unknown command "model ${sub}".${hint ? ` Did you mean "model ${hint}"?` : ''}`
          : 'Usage: mia model <list|use>. See "mia help model".',
      );
    }
  }
}

async function list(args: string[], ctx: Context): Promise<number> {
  const { values, positionals } = parseFlags(args, { filter: { type: 'string' } });
  const cfg = await ctx.config.load();
  const name = pickProviderName(cfg, positionals[0]);
  const runtime = await openProvider(ctx, cfg, name);
  const models = await runtime.provider.listModels();
  const filter = str(values, 'filter')?.toLowerCase();
  const shown = filter ? models.filter((m) => m.id.toLowerCase().includes(filter)) : models;
  if (shown.length === 0) {
    ctx.print(
      models.length === 0 ? 'The provider returned no models.' : `No model matches "${filter}".`,
    );
    return 0;
  }
  for (const model of shown) {
    const mark = model.id === runtime.config.model ? '*' : ' ';
    const extra = model.contextWindow
      ? `  (context ${model.contextWindow.toLocaleString('en-US')} tokens)`
      : '';
    ctx.print(`${mark} ${model.id}${extra}`);
  }
  ctx.print(
    ctx.style.dim(
      `${shown.length} of ${models.length} model(s). * = selected. Select one with "mia model use <id>".`,
    ),
  );
  return 0;
}

async function use(args: string[], ctx: Context): Promise<number> {
  const { values, positionals } = parseFlags(args, { provider: { type: 'string' } });
  const model = positionals[0];
  if (!model) throw new UsageError('Usage: mia model use <model> [--provider <name>]');
  if (/\s/.test(model)) throw new UserError('A model id cannot contain spaces.');
  const cfg = await ctx.config.load();
  const name = pickProviderName(cfg, str(values, 'provider'));
  getProviderConfig(cfg, name);
  await ctx.config.update((c) => {
    const p = c.providers[name];
    if (p) p.model = model;
  });
  ctx.print(`Provider "${name}" will use model "${model}".`);
  ctx.print(
    ctx.style.dim(
      'The name is not checked until the first request; "mia provider test" verifies it.',
    ),
  );
  const caps = resolveCapabilities(cfg, name, model);
  for (const line of describeCapabilities(caps)) ctx.print(ctx.style.dim(`  ${line}`));
  return 0;
}
