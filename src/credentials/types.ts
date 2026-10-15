export const SERVICE_NAME = 'mia-code';

export interface Availability {
  available: boolean;
  reason?: string;
  /** When unavailable: an alternative the user may opt into (for example a private key file). */
  offer?: { description: string; enable(): Promise<void> };
}

/** Stores API keys outside of config files. `account` is the provider name. */
export interface CredentialStore {
  /** Short name shown to the user, e.g. "macOS Keychain". */
  readonly name: string;
  isAvailable(): Promise<Availability>;
  get(account: string): Promise<string | null>;
  /** Throws if the secret could not be stored. */
  set(account: string, secret: string): Promise<void>;
  /** Returns true if something was removed. */
  delete(account: string): Promise<boolean>;
}

/** Used on platforms with no supported secure store, and as a safe default. */
export class UnavailableCredentialStore implements CredentialStore {
  constructor(
    readonly name = 'none',
    private readonly reason = 'No supported secure credential store on this platform.',
  ) {}
  async isAvailable(): Promise<Availability> {
    return { available: false, reason: this.reason };
  }
  async get(): Promise<string | null> {
    return null;
  }
  async set(): Promise<void> {
    throw new Error(this.reason);
  }
  async delete(): Promise<boolean> {
    return false;
  }
}

/** In-memory store, for tests and embedding. */
export class MemoryCredentialStore implements CredentialStore {
  readonly name = 'memory';
  private readonly secrets = new Map<string, string>();
  async isAvailable(): Promise<Availability> {
    return { available: true };
  }
  async get(account: string): Promise<string | null> {
    return this.secrets.get(account) ?? null;
  }
  async set(account: string, secret: string): Promise<void> {
    this.secrets.set(account, secret);
  }
  async delete(account: string): Promise<boolean> {
    return this.secrets.delete(account);
  }
}
