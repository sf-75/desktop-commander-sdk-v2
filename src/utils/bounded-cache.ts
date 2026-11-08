/** A small LRU cache with optional per-entry expiration. */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt?: number }>();

  constructor(private readonly maxEntries: number, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive integer');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order so frequently used entries survive eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs < 0)) {
      throw new RangeError('ttlMs must be a non-negative finite number');
    }
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      ...(ttlMs === undefined ? {} : { expiresAt: this.now() + ttlMs }),
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
