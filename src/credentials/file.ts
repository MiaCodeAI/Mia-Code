import fs from 'node:fs/promises';
import path from 'node:path';
import { type Availability, type CredentialStore } from './types.js';

const SAFE_ACCOUNT = /^[a-z0-9_-]+$/;
const MARKER = '.enabled';

/**
 * Fallback for systems with no keyring (servers, minimal desktops, containers, WSL without a
 * Secret Service). Each key is one small file, readable only by the current user (directory 0700,
 * files 0600). It is **not encrypted**: anyone who can read your files as you, or as root, can read
 * it. It is only used after the user explicitly agrees (a marker file records the consent).
 */
export class FileCredentialStore implements CredentialStore {
  readonly name: string;
  constructor(readonly dir: string) {
    this.name = `private key file (${dir}; owner-only, not encrypted)`;
  }

  private fileFor(account: string): string {
    if (!SAFE_ACCOUNT.test(account))
      throw new Error('Unsupported provider name for credential storage.');
    return path.join(this.dir, `${account}.key`);
  }

  async isEnabled(): Promise<boolean> {
    try {
      await fs.stat(path.join(this.dir, MARKER));
      return true;
    } catch {
      return false;
    }
  }

  /** Records consent and prepares an owner-only directory. */
  async enable(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700);
    await fs.writeFile(path.join(this.dir, MARKER), 'Mia Code private key file store enabled.\n', {
      mode: 0o600,
    });
  }

  async isAvailable(): Promise<Availability> {
    return (await this.isEnabled())
      ? { available: true }
      : { available: false, reason: 'the private key file store has not been enabled.' };
  }

  async get(account: string): Promise<string | null> {
    const file = this.fileFor(account);
    try {
      const st = await fs.stat(file);
      // Refuse keys that other users could have read or replaced.
      if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) await fs.chmod(file, 0o600);
      const text = (await fs.readFile(file, 'utf8')).trim();
      return text === '' ? null : text;
    } catch {
      return null;
    }
  }

  async set(account: string, secret: string): Promise<void> {
    const file = this.fileFor(account);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${secret}\n`, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  }

  async delete(account: string): Promise<boolean> {
    try {
      await fs.unlink(this.fileFor(account));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Prefers the system keyring. When it is unavailable, uses the private key file store, but only
 * once the user has agreed to it (see `Availability.offer`).
 */
export class FallbackCredentialStore implements CredentialStore {
  private active: CredentialStore;
  constructor(
    private readonly primary: CredentialStore,
    private readonly file: FileCredentialStore,
  ) {
    this.active = primary;
  }

  get name(): string {
    return this.active.name;
  }

  async isAvailable(): Promise<Availability> {
    const p = await this.primary.isAvailable();
    if (p.available) {
      this.active = this.primary;
      return p;
    }
    if (await this.file.isEnabled()) {
      this.active = this.file;
      return { available: true };
    }
    return {
      available: false,
      reason: p.reason ?? 'no system keyring is available',
      offer: {
        description: `Mia Code can store the key in a private file instead: ${this.file.dir}.`,
        enable: () => this.file.enable(),
      },
    };
  }

  async get(account: string): Promise<string | null> {
    const fromPrimary = await this.primary.get(account);
    if (fromPrimary !== null) {
      this.active = this.primary;
      return fromPrimary;
    }
    const fromFile = await this.file.get(account);
    if (fromFile !== null) this.active = this.file;
    return fromFile;
  }

  async set(account: string, secret: string): Promise<void> {
    const a = await this.isAvailable();
    if (!a.available) throw new Error(a.reason ?? 'no credential store is available');
    await this.active.set(account, secret);
  }

  async delete(account: string): Promise<boolean> {
    const a = await this.primary.delete(account);
    const b = await this.file.delete(account);
    return a || b;
  }
}
