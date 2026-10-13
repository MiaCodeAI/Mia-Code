import type { Context } from '../context.js';
import { ConfigError } from '../config/schema.js';
import { UsageError, UserError } from '../errors.js';
import fs from 'node:fs/promises';

export async function configCommand(args: string[], ctx: Context): Promise<number> {
  const [sub, ...rest] = args;
  if (rest.length > 0) throw new UsageError('Too many arguments. See "mia help config".');
  switch (sub) {
    case undefined:
    case 'show': {
      const cfg = await ctx.config.load();
      ctx.print(ctx.style.dim(`# ${ctx.config.file}`));
      ctx.print(JSON.stringify(cfg, null, 2));
      return 0;
    }
    case 'path':
      ctx.print(ctx.config.file);
      return 0;
    case 'edit':
      return edit(ctx);
    default:
      throw new UsageError(`Unknown command "config ${sub}". Use show, path or edit.`);
  }
}

async function edit(ctx: Context): Promise<number> {
  try {
    await fs.access(ctx.config.file);
  } catch {
    await ctx.config.save(await ctx.config.load()); // create a default file to edit
  }
  const result = await ctx.editFile(ctx.config.file);
  if (result.error) {
    throw new UserError(
      `Could not start the editor (${result.error}). Set the EDITOR environment variable, for example EDITOR=nano.`,
    );
  }
  try {
    await ctx.config.load();
    ctx.print('Config saved and valid.');
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      ctx.printErr(
        `${error.message}\nFix it with "mia config edit" (Mia Code will not use the file until it is valid).`,
      );
      return 1;
    }
    throw error;
  }
}
