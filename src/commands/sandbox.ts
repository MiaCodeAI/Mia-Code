import path from 'node:path';
import type { Context } from '../context.js';
import { UsageError, UserError } from '../errors.js';
import type { PermissionMode } from '../agent/policy.js';
import type { RepoIndex } from '../repo/index.js';
import {
  SANDBOX_SETTINGS,
  chooseSandbox,
  defaultSandboxConfig,
  type ActiveSandbox,
  type SandboxSetting,
} from '../sandbox/index.js';
import { flag, str, type FlagSpec, type ParsedFlags } from './flags.js';

export const SANDBOX_FLAGS: FlagSpec = {
  sandbox: { type: 'string' },
  network: { type: 'boolean' },
  'sandbox-image': { type: 'string' },
  'allow-write': { type: 'string' },
  'unsafe-no-sandbox': { type: 'boolean' },
};

export const SANDBOX_USAGE =
  '[--sandbox auto|off|bwrap|seatbelt|docker] [--network] [--sandbox-image <img>] [--allow-write <dir>] [--unsafe-no-sandbox]';

/**
 * Decides the sandbox for a session. `auto` permission mode refuses to run unsandboxed unless the
 * user passes --unsafe-no-sandbox. Other modes use a sandbox when one is available and say so when not.
 */
export async function resolveSandbox(
  ctx: Context,
  values: ParsedFlags['values'],
  index: RepoIndex,
  mode: PermissionMode | 'chat',
): Promise<ActiveSandbox | null> {
  const setting = (str(values, 'sandbox') ?? 'auto') as SandboxSetting;
  if (!SANDBOX_SETTINGS.includes(setting))
    throw new UsageError(`--sandbox must be one of: ${SANDBOX_SETTINGS.join(', ')}`);
  if (mode === 'chat' || mode === 'readonly') return null;
  const unsafe = flag(values, 'unsafe-no-sandbox');
  const root = index.inventory.root;
  const extra = str(values, 'allow-write');
  const config = {
    ...defaultSandboxConfig(),
    mode: setting,
    network: flag(values, 'network') ? ('on' as const) : ('off' as const),
    ...(str(values, 'sandbox-image') ? { image: str(values, 'sandbox-image') as string } : {}),
    writable: extra ? [path.resolve(ctx.cwd, extra)] : [],
  };
  const choice = await chooseSandbox(
    ctx.run,
    ctx.platform,
    config,
    root,
    index.inventory.secretFiles,
  );
  if (choice.sandbox) return choice.sandbox;
  if (mode === 'auto' && !unsafe) {
    throw new UserError(
      `Mode "auto" runs commands without asking, so it requires an OS sandbox, and none is available: ${choice.reason}. ` +
        'Install one (Linux: bubblewrap; macOS: built in; any OS: Docker with --sandbox docker --sandbox-image <img>), ' +
        'use --mode auto-edit, or pass --unsafe-no-sandbox to accept the risk.',
    );
  }
  ctx.printErr(
    ctx.style.yellow(`[no sandbox] Commands run with your full user permissions: ${choice.reason}`),
  );
  return null;
}
