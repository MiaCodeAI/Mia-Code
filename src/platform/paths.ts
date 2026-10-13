import os from 'node:os';
import path from 'node:path';

export interface PathContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
}

export function defaultPathContext(): PathContext {
  return { platform: process.platform, env: process.env, homedir: os.homedir() };
}

function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Directory for Mia Code's user-level configuration.
 * `MIA_CONFIG_DIR` overrides the platform default (used by tests and portable installs).
 */
export function configDir(ctx: PathContext = defaultPathContext()): string {
  const p = pathFor(ctx.platform);
  const override = ctx.env['MIA_CONFIG_DIR'];
  if (override && override.trim() !== '') return p.resolve(override);

  switch (ctx.platform) {
    case 'win32': {
      const appData = ctx.env['APPDATA'];
      return p.join(
        appData && appData !== '' ? appData : p.join(ctx.homedir, 'AppData', 'Roaming'),
        'mia-code',
      );
    }
    case 'darwin':
      return p.join(ctx.homedir, 'Library', 'Application Support', 'mia-code');
    default: {
      const xdg = ctx.env['XDG_CONFIG_HOME'];
      return p.join(xdg && xdg !== '' ? xdg : p.join(ctx.homedir, '.config'), 'mia-code');
    }
  }
}

export function configFile(ctx: PathContext = defaultPathContext()): string {
  return pathFor(ctx.platform).join(configDir(ctx), 'config.json');
}
