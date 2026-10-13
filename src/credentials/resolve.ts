import type { ProviderConfig } from '../config/schema.js';
import { configDir, type PathContext } from '../platform/paths.js';
import { runCommand, type Runner } from '../platform/exec.js';
import { findPreset } from '../providers/registry.js';
import { LinuxSecretToolStore } from './linux.js';
import { MacOSKeychainStore } from './macos.js';
import { UnavailableCredentialStore, type CredentialStore } from './types.js';
import { WindowsDpapiStore } from './windows.js';

export function createCredentialStore(
  pathContext: PathContext,
  run: Runner = runCommand,
): CredentialStore {
  switch (pathContext.platform) {
    case 'darwin':
      return new MacOSKeychainStore(run);
    case 'linux':
      return new LinuxSecretToolStore(run);
    case 'win32':
      return new WindowsDpapiStore(run, configDir(pathContext));
    default:
      return new UnavailableCredentialStore();
  }
}

export interface ResolvedKey {
  key: string;
  /** Where the key came from, without revealing it: `env:NAME` or `store:<backend>`. */
  source: string;
}

/**
 * The environment variable names that may supply this provider's key.
 * A provider's own `apiKeyEnv` is always honoured. The preset's conventional variable
 * (for example OPENAI_API_KEY) is used only when the endpoint is still the preset's official
 * URL, so a key issued by one company is never sent to a different endpoint.
 */
export function envVarCandidates(config: ProviderConfig): string[] {
  const names: string[] = [];
  if (config.apiKeyEnv) names.push(config.apiKeyEnv);
  const preset = findPreset(config.preset);
  if (preset && preset.baseUrl === config.baseUrl && !names.includes(preset.envVar)) {
    names.push(preset.envVar);
  }
  return names;
}

export async function resolveApiKey(
  providerName: string,
  config: ProviderConfig,
  env: NodeJS.ProcessEnv,
  store: CredentialStore,
): Promise<ResolvedKey | null> {
  for (const name of envVarCandidates(config)) {
    const value = env[name]?.trim();
    if (value) return { key: value, source: `env:${name}` };
  }
  try {
    const stored = await store.get(providerName);
    if (stored) return { key: stored, source: `store:${store.name}` };
  } catch {
    // an unreadable store is treated as "no key"; `mia doctor` explains why
  }
  return null;
}
