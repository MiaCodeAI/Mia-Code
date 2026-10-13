import type { Runner } from '../platform/exec.js';
import { SERVICE_NAME, type Availability, type CredentialStore } from './types.js';

/** Characters found in real API keys. Anything else is refused rather than risk mis-quoting. */
const SAFE_SECRET = /^[A-Za-z0-9._~+/=:-]+$/;
const SAFE_ACCOUNT = /^[a-z0-9_-]+$/;

/**
 * macOS Keychain through the `security` program. The secret is sent on stdin to
 * `security -i` so it never appears in the process list.
 */
export class MacOSKeychainStore implements CredentialStore {
  readonly name = 'macOS Keychain';
  constructor(private readonly run: Runner) {}

  async isAvailable(): Promise<Availability> {
    const result = await this.run('security', ['list-keychains'], { timeoutMs: 5000 });
    if (result.error)
      return { available: false, reason: 'The macOS "security" tool was not found.' };
    return result.exitCode === 0
      ? { available: true }
      : {
          available: false,
          reason: `The keychain is not accessible (${result.stderr.trim() || 'unknown error'}).`,
        };
  }

  async get(account: string): Promise<string | null> {
    const result = await this.run(
      'security',
      ['find-generic-password', '-s', SERVICE_NAME, '-a', account, '-w'],
      {
        timeoutMs: 10_000,
      },
    );
    if (result.exitCode !== 0) return null;
    const secret = result.stdout.trim();
    return secret === '' ? null : secret;
  }

  async set(account: string, secret: string): Promise<void> {
    if (!SAFE_ACCOUNT.test(account)) throw new Error('Unsupported provider name for the keychain.');
    if (!SAFE_SECRET.test(secret)) {
      throw new Error(
        'This key contains characters the keychain integration does not support. Use an environment variable instead.',
      );
    }
    const command = `add-generic-password -U -s ${SERVICE_NAME} -a ${account} -w "${secret}"\n`;
    const result = await this.run('security', ['-i'], { input: command, timeoutMs: 15_000 });
    if (result.exitCode !== 0 || /\b(?:error|failed)\b/i.test(result.stderr)) {
      throw new Error(
        `The keychain could not store the key: ${result.stderr.trim() || 'unknown error'}`,
      );
    }
  }

  async delete(account: string): Promise<boolean> {
    const result = await this.run(
      'security',
      ['delete-generic-password', '-s', SERVICE_NAME, '-a', account],
      {
        timeoutMs: 10_000,
      },
    );
    return result.exitCode === 0;
  }
}
