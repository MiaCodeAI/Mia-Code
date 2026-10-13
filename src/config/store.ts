import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { containsSecretToken } from '../security/redact.js';
import { ConfigError, defaultConfig, validateConfig, type MiaConfig } from './schema.js';

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

export class ConfigStore {
  constructor(readonly file: string) {}

  /** Loads the config. A missing file yields the defaults; an invalid file throws ConfigError. */
  async load(): Promise<MiaConfig> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return defaultConfig();
      throw new ConfigError(`Could not read ${this.file}: ${(error as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`${this.file} is not valid JSON: ${(error as Error).message}`);
    }
    const { config, errors } = validateConfig(parsed);
    if (errors.length > 0) {
      throw new ConfigError(`${this.file} has problems:\n  - ${errors.join('\n  - ')}`, errors);
    }
    return config;
  }

  /** Validates, refuses to write secrets, then writes atomically (temp file + rename). */
  async save(config: MiaConfig): Promise<void> {
    const { errors } = validateConfig(config);
    if (errors.length > 0) {
      throw new ConfigError(
        `Refusing to save an invalid config:\n  - ${errors.join('\n  - ')}`,
        errors,
      );
    }
    const json = JSON.stringify(config, null, 2) + '\n';
    if (containsSecretToken(json)) {
      throw new ConfigError(
        'Refusing to save: the config appears to contain an API key. Keys belong in the credential store or an environment variable, never in config.json.',
      );
    }
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `.config-${randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.writeFile(temp, json, { mode: 0o600 });
      await fs.rename(temp, this.file);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  /** Load, apply a mutation to a copy, save, and return the new config. */
  async update(mutate: (config: MiaConfig) => void): Promise<MiaConfig> {
    const config = await this.load();
    mutate(config);
    await this.save(config);
    return config;
  }
}
