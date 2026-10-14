import { ProviderError } from '../providers/errors.js';
import type { PooledKey } from './resolve.js';

export type RotationReason = 'quota' | 'rate_limit' | 'auth' | 'outage';

interface Slot {
  key: PooledKey;
  /** Epoch ms until which this key is skipped; Infinity means "for the rest of the session". */
  unavailableUntil: number;
  reason: RotationReason | null;
  uses: number;
}

export interface KeyStatus {
  label: string;
  source: string;
  active: boolean;
  state: 'ready' | 'cooling-down' | 'disabled';
  reason: RotationReason | null;
  retryInMs?: number;
}

const COOLDOWN_MS = { rate_limit: 60_000, quota: 6 * 3_600_000, outage: 30_000 } as const;

/** Maps an error to a rotation reason, or null when another key would not help (bad request, context length, ...). */
export function rotationReason(error: unknown): RotationReason | null {
  if (!(error instanceof ProviderError)) return null;
  switch (error.code) {
    case 'quota':
      return 'quota';
    case 'rate_limit':
      return 'rate_limit';
    case 'auth':
    case 'permission':
      return 'auth';
    case 'server':
    case 'network':
    case 'timeout':
      return 'outage';
    default:
      return null;
  }
}

/**
 * A set of API keys for one provider. It stays on one key until that key fails in a way another
 * key could fix (quota exhausted, rate limited, rejected, or the endpoint is failing), then moves
 * to the next usable key. Keys that ran out of quota or were rejected are parked for a long time;
 * rate-limited and outage keys come back after a short cooldown. The pool only lives in memory.
 */
export class KeyPool {
  private readonly slots: Slot[];
  private index = 0;

  constructor(
    keys: readonly PooledKey[],
    private readonly now: () => number = Date.now,
  ) {
    this.slots = keys.map((key) => ({ key, unavailableUntil: 0, reason: null, uses: 0 }));
  }

  get size(): number {
    return this.slots.length;
  }

  private usable(slot: Slot): boolean {
    return slot.unavailableUntil <= this.now();
  }

  /** The key to use now, or null when every key is parked. */
  current(): PooledKey | null {
    for (let step = 0; step < this.slots.length; step++) {
      const i = (this.index + step) % this.slots.length;
      const slot = this.slots[i];
      if (slot && this.usable(slot)) {
        this.index = i;
        slot.uses++;
        return slot.key;
      }
    }
    return null;
  }

  /** Parks the key that failed. Returns what happened, or null if the error is not rotatable. */
  report(
    key: PooledKey,
    error: unknown,
  ): { reason: RotationReason; next: PooledKey | null } | null {
    const reason = rotationReason(error);
    if (!reason) return null;
    const slot = this.slots.find((s) => s.key.key === key.key);
    if (!slot) return null;
    let cooldown: number = reason === 'auth' ? Infinity : COOLDOWN_MS[reason];
    if (
      reason === 'rate_limit' &&
      error instanceof ProviderError &&
      error.retryAfterMs !== undefined
    ) {
      cooldown = Math.min(Math.max(error.retryAfterMs, 1000), 3_600_000);
    }
    slot.unavailableUntil = cooldown === Infinity ? Infinity : this.now() + cooldown;
    slot.reason = reason;
    this.index = (this.slots.indexOf(slot) + 1) % this.slots.length;
    return { reason, next: this.peek() };
  }

  /** The next usable key without consuming it. */
  peek(): PooledKey | null {
    for (let step = 0; step < this.slots.length; step++) {
      const slot = this.slots[(this.index + step) % this.slots.length];
      if (slot && this.usable(slot)) return slot.key;
    }
    return null;
  }

  /** Time until some key becomes usable again; null if none ever will (all disabled). */
  soonestRetryMs(): number | null {
    const times = this.slots.map((s) => s.unavailableUntil).filter((t) => t !== Infinity);
    if (times.length === 0) return null;
    return Math.max(0, Math.min(...times) - this.now());
  }

  status(): KeyStatus[] {
    const current = this.slots[this.index];
    return this.slots.map((slot) => {
      const usable = this.usable(slot);
      const status: KeyStatus = {
        label: slot.key.label,
        source: slot.key.source,
        active: slot === current && usable,
        state: usable ? 'ready' : slot.unavailableUntil === Infinity ? 'disabled' : 'cooling-down',
        reason: usable ? null : slot.reason,
      };
      if (!usable && slot.unavailableUntil !== Infinity)
        status.retryInMs = slot.unavailableUntil - this.now();
      return status;
    });
  }

  /** Brings every parked key back (used by /keys reset). */
  reset(): void {
    for (const slot of this.slots) {
      slot.unavailableUntil = 0;
      slot.reason = null;
    }
  }
}
