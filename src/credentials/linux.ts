import type { Runner } from '../platform/exec.js';
import { SERVICE_NAME, type Availability, type CredentialStore } from './types.js';

/**
 * Linux Secret Service (GNOME Keyring, KWallet, etc.) through the `secret-tool` program
 * from libsecret. The secret is passed on stdin, never as a command-line argument.
 */
export class LinuxSecretToolStore implements CredentialStore {
  readonly name = 'Linux Secret Service (secret-tool)';
  constructor(private readonly run: Runner) {}

  async isAvailable(): Promise<Availability> {
    const result = await this.run(
      'secret-tool',
      ['lookup', 'service', SERVICE_NAME, 'account', '__mia_probe__'],
      {
        timeoutMs: 5000,
      },
    );
    if (result.error) {
      return {
        available: false,
        reason: 'secret-tool is not installed (package: libsecret-tools or libsecret).',
      };
    }
    if (result.timedOut)
      return { available: false, reason: 'secret-tool timed out (is a keyring daemon running?).' };
    // Exit 1 with no stderr means "no such secret", which proves the service answered.
    if (result.exitCode === 0 || (result.exitCode === 1 && result.stderr.trim() === '')) {
      return { available: true };
    }
    return {
      available: false,
      reason: `The Secret Service is not reachable (${result.stderr.trim().split('\n')[0] ?? 'unknown error'}).`,
    };
  }

  async get(account: string): Promise<string | null> {
    const result = await this.run(
      'secret-tool',
      ['lookup', 'service', SERVICE_NAME, 'account', account],
      {
        timeoutMs: 10_000,
      },
    );
    if (result.exitCode !== 0) return null;
    const secret = result.stdout.trim();
    return secret === '' ? null : secret;
  }

  async set(account: string, secret: string): Promise<void> {
    const result = await this.run(
      'secret-tool',
      ['store', '--label', `Mia Code (${account})`, 'service', SERVICE_NAME, 'account', account],
      { input: secret, timeoutMs: 15_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `secret-tool could not store the key: ${result.stderr.trim() || 'unknown error'}`,
      );
    }
  }

  async delete(account: string): Promise<boolean> {
    const result = await this.run(
      'secret-tool',
      ['clear', 'service', SERVICE_NAME, 'account', account],
      {
        timeoutMs: 10_000,
      },
    );
    return result.exitCode === 0;
  }
}
