import type { Context } from '../context.js';
import { resolveApiKey } from '../credentials/resolve.js';
import { UserError } from '../errors.js';
import { describeCapabilities, resolveCapabilities } from '../providers/capabilities.js';
import type { ModelInfo } from '../providers/types.js';
import { hostOf } from '../security/endpoint.js';
import { confirm } from '../ui/prompts.js';
import { getProviderConfig, openProvider } from './runtime.js';
import { printSteps } from './provider.js';
import {
  recordToolSupport,
  loginProvider,
  promptProviderChoice,
  readApiKey,
  saveProvider,
  selectModel,
  testProvider,
} from './setup.js';

export async function initCommand(_args: string[], ctx: Context): Promise<number> {
  if (!ctx.terminal().interactive) {
    throw new UserError(
      '"mia init" is interactive and needs a terminal. For scripted setup use:\n' +
        '  mia provider add --preset <id> --use\n' +
        '  printf %s "$KEY" | mia auth login <id> --stdin\n' +
        '  mia model use <model>',
    );
  }
  const { style } = ctx;
  ctx.print(style.bold('Mia Code setup'));
  ctx.print('');
  ctx.print('Mia Code is bring-your-own-key: you connect your own AI provider account.');
  ctx.print(
    "  - Your key is stored in your operating system's credential store, never in a config file.",
  );
  ctx.print(
    '  - Requests go straight from this computer to the provider you pick. Mia Code has no server.',
  );
  ctx.print(
    '  - What you type, and a short overview of your project, is sent to that provider. You pay them directly.',
  );
  ctx.print('');

  const cfg = await ctx.config.load();
  const choice = await promptProviderChoice(ctx, cfg);
  if (choice.preset)
    ctx.print(`Official documentation (where to get a key): ${choice.preset.docsUrl}`);
  await saveProvider(ctx, choice.name, choice.config, true);

  let models: ModelInfo[] | null = null;
  const existing = await resolveApiKey(choice.name, choice.config, ctx.env, ctx.credentials);
  if (
    existing &&
    (await confirm(
      ctx,
      `A key for "${choice.name}" is already available (${existing.source}). Use it?`,
      true,
    ))
  ) {
    try {
      const runtime = await openProvider(ctx, await ctx.config.load(), choice.name);
      models = await runtime.provider.listModels();
      ctx.print(`${style.green('[ok]')} Key accepted (${models.length} models visible).`);
    } catch (error) {
      ctx.print(
        `${style.yellow('[!!]')} Could not list models with the existing key: ${(error as Error).message}`,
      );
    }
  } else {
    ctx.print(`The key will be sent only to ${style.bold(hostOf(choice.config.baseUrl))}.`);
    const key = await readApiKey(ctx, choice.name);
    const result = await loginProvider(ctx, choice.name, key, { validate: true });
    models = result.models;
    if (result.models)
      ctx.print(`${style.green('[ok]')} Key accepted (${result.models.length} models visible).`);
    for (const warning of result.warnings) ctx.print(`${style.yellow('[!!]')} ${warning}`);
    if (result.storedIn) ctx.print(`${style.green('[ok]')} Key stored in ${result.storedIn}.`);
    else {
      ctx.print(
        'The key was not saved. Set it as an environment variable before running Mia Code:',
      );
      for (const line of result.envInstructions) ctx.print(`  ${line}`);
    }
  }

  const model = await selectModel(ctx, choice.name, models);
  const latest = await ctx.config.load();
  getProviderConfig(latest, choice.name);
  const discovered = models?.find((m) => m.id === model);
  ctx.print('');
  ctx.print(`Known about ${model} (nothing is guessed from the name):`);
  for (const line of describeCapabilities(
    resolveCapabilities(latest, choice.name, model, discovered),
  )) {
    ctx.print(style.dim(`  ${line}`));
  }

  ctx.print('');
  if (
    await confirm(
      ctx,
      'Run a minimal connectivity test? (sends one tiny prompt, a few tokens)',
      true,
    )
  ) {
    let outcome = await testProvider(ctx, latest, choice.name);
    printSteps(ctx, outcome.steps);
    if (!outcome.ok) {
      ctx.print(
        'Setup is saved, but the test failed. Fix the problem above, then run "mia provider test".',
      );
      return 1;
    }
    await recordToolSupport(ctx, choice.name, model, outcome.toolSupport);
    for (
      let attempt = 0;
      attempt < 3 &&
      outcome.toolSupport === 'unsupported' &&
      ctx.terminal().interactive &&
      (await confirm(ctx, 'This model cannot use tools. Pick a different model now?', true));
      attempt++
    ) {
      const next = await selectModel(ctx, choice.name, models);
      outcome = await testProvider(ctx, await ctx.config.load(), choice.name);
      printSteps(ctx, outcome.steps);
      if (!outcome.ok) return 1;
      await recordToolSupport(ctx, choice.name, next, outcome.toolSupport);
    }
  }

  ctx.print('');
  ctx.print(style.bold('Done.') + ' Open a project folder and run "mia" to start.');
  ctx.print(
    style.dim(
      'Mia Code asks before editing files or running commands (see "mia help run"); try: mia run "explain this project" or just "mia".',
    ),
  );
  return 0;
}
