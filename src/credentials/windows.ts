import fs from 'node:fs/promises';
import path from 'node:path';
import type { Runner } from '../platform/exec.js';
import { type Availability, type CredentialStore } from './types.js';

const SAFE_ACCOUNT = /^[a-z0-9_-]+$/;

function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const PROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$plain = [Console]::In.ReadToEnd().Trim()
ConvertTo-SecureString $plain -AsPlainText -Force | ConvertFrom-SecureString
`;

const UNPROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$blob = [Console]::In.ReadToEnd().Trim()
$secure = ConvertTo-SecureString $blob
[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
`;

const PROBE_SCRIPT = `Write-Output 'ok'`;

/**
 * Windows: keys are encrypted with the Windows Data Protection API (DPAPI), scoped to the
 * current Windows user, and stored as one small file per provider in the config directory's
 * `credentials` folder. Only the same Windows user on the same machine can decrypt them.
 * (Windows Credential Manager cannot be read back from the command line, so DPAPI is used.)
 * The secret travels to PowerShell on stdin, never on the command line.
 */
export class WindowsDpapiStore implements CredentialStore {
  readonly name = 'Windows DPAPI (current user)';
  private readonly dir: string;

  constructor(
    private readonly run: Runner,
    configDirectory: string,
  ) {
    this.dir = path.join(configDirectory, 'credentials');
  }

  private ps(script: string, input?: string): ReturnType<Runner> {
    return this.run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodeCommand(script),
      ],
      { timeoutMs: 20_000, ...(input !== undefined ? { input } : {}) },
    );
  }

  private fileFor(account: string): string {
    if (!SAFE_ACCOUNT.test(account))
      throw new Error('Unsupported provider name for credential storage.');
    return path.join(this.dir, `${account}.dpapi`);
  }

  async isAvailable(): Promise<Availability> {
    const result = await this.ps(PROBE_SCRIPT);
    if (result.error) return { available: false, reason: 'powershell.exe was not found.' };
    return result.exitCode === 0 && result.stdout.includes('ok')
      ? { available: true }
      : { available: false, reason: 'PowerShell could not be run.' };
  }

  async get(account: string): Promise<string | null> {
    let blob: string;
    try {
      blob = await fs.readFile(this.fileFor(account), 'utf8');
    } catch {
      return null;
    }
    const result = await this.ps(UNPROTECT_SCRIPT, blob);
    if (result.exitCode !== 0) return null;
    const secret = result.stdout.trim();
    return secret === '' ? null : secret;
  }

  async set(account: string, secret: string): Promise<void> {
    const file = this.fileFor(account);
    const result = await this.ps(PROTECT_SCRIPT, secret);
    const blob = result.stdout.trim();
    if (result.exitCode !== 0 || blob === '') {
      throw new Error(
        `Windows could not protect the key: ${result.stderr.trim() || 'unknown error'}`,
      );
    }
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, blob + '\n', { mode: 0o600 });
  }

  async delete(account: string): Promise<boolean> {
    try {
      await fs.rm(this.fileFor(account));
      return true;
    } catch {
      return false;
    }
  }
}
