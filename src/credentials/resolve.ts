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

export interface PooledKey extends ResolvedKey {
  /** Short, non-secret name shown in messages: `env:NAME#2`, `default` or the label. */
  label: string;
}

/** Credential-store account for a provider's additional, labelled key. */
export function keyAccount(providerName: string, label?: string): string {
  return label ? `${providerName}--${label}` : providerName;
}

/** Splits an environment variable holding one or several keys (separated by commas, spaces or newlines). */
export function splitKeys(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((k) => k.trim())
        .filter((k) => k !== ''),
    ),
  ];
}

/**
 * Every key available for a provider, in rotation order: environment variables (each may hold
 * several keys), then the default stored key, then labelled stored keys. Duplicates are removed.
 */
export async function resolveApiKeys(
  providerName: string,
  config: ProviderConfig,
  env: NodeJS.ProcessEnv,
  store: CredentialStore,
): Promise<PooledKey[]> {
  const out: PooledKey[] = [];
  const seen = new Set<string>();
  const add = (key: string, source: string, label: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, source, label });
  };
  for (const name of envVarCandidates(config)) {
    const keys = splitKeys(env[name] ?? '');
    keys.forEach((k, i) => add(k, `env:${name}`, keys.length > 1 ? `${name}#${i + 1}` : name));
  }
  const accounts: { account: string; label: string }[] = [
    { account: providerName, label: 'default' },
    ...(config.keyLabels ?? []).map((label) => ({
      account: keyAccount(providerName, label),
      label,
    })),
  ];
  for (const { account, label } of accounts) {
    try {
      const stored = await store.get(account);
      if (stored) add(stored.trim(), `store:${store.name}`, label);
    } catch {
      // unreadable store: treated as no key; `mia doctor` explains why
    }
  }
  return out;
}
