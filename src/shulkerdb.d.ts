/**
 * Options for {@link ShulkerDB}.
 */
export interface ShulkerDBOptions {
  /**
   * Target size of a storage bucket, in UTF-8 bytes. Values above the
   * dynamic property limit of 32000 bytes are clamped to 32000.
   * @default 12000
   */
  bucketSize?: number;
  /**
   * Time budget, in milliseconds, that each {@link ShulkerDB.flushSome} call
   * may spend writing. It is raised automatically while many writes are pending.
   * @default 3
   */
  budgetMs?: number;
  /**
   * Maximum number of dynamic properties sent per `setDynamicProperties` call.
   * @default 256
   */
  batchSize?: number;
  /**
   * Interval, in ticks, between automatic background flushes.
   * Use `0` (or a negative value) to disable the timer and flush manually.
   * @default 20
   */
  flushEvery?: number;
}

/**
 * A fast key-value database stored in world dynamic properties.
 * Values are JSON-serializable, cached in memory, and written back in the
 * background in crash-consistent batches. Pending writes are also flushed when
 * the server shuts down.
 *
 * @typeParam T Type of the stored values.
 * @example
 * import { ShulkerDB } from "shulkerdb";
 *
 * const db = new ShulkerDB<{ coins: number }>("players");
 * db.set("steve", { coins: 10 });
 * db.get("steve")?.coins; // 10
 * db.flush();             // optional, writes happen automatically
 */
export class ShulkerDB<T = unknown> {
  /**
   * Opens (and loads) the database stored under a namespace.
   * @param ns Namespace that isolates this database from others. Must be a string without the control characters U+0001 and U+0002.
   * @param opt Tuning options.
   * @throws {TypeError} If the namespace is invalid.
   */
  constructor(ns: string, opt?: ShulkerDBOptions);

  /** The namespace this database was opened with. */
  readonly ns: string;

  /** Number of stored keys. */
  readonly size: number;

  /** Number of storage units (buckets and large records) waiting to be written. */
  readonly pending: number;

  /**
   * Returns the value stored under a key.
   * @param k The key.
   * @returns The value, or `undefined` if the key does not exist or its record was corrupt (corrupt records are dropped).
   */
  get(k: string): T | undefined;

  /**
   * Stores a value. Passing `undefined` deletes the key.
   * @param k Key, at most 512 UTF-8 bytes and free of U+0001 and U+0002.
   * @param v JSON-serializable value.
   * @returns This database, for chaining.
   * @throws {TypeError} If the key is new and invalid.
   */
  set(k: string, v: T): this;

  /**
   * Checks whether a key exists.
   * @param k The key.
   */
  has(k: string): boolean;

  /**
   * Removes a key.
   * @param k The key.
   * @returns `true` if the key existed.
   */
  delete(k: string): boolean;

  /** Iterates over all keys. */
  keys(): IterableIterator<string>;

  /** Iterates over all `[key, value]` pairs. Values are parsed lazily. */
  entries(): Generator<[string, T | undefined], void, undefined>;

  /** Removes every key and flushes immediately. */
  clear(): void;

  /**
   * Writes all pending changes synchronously.
   * @returns Number of storage units written.
   */
  flush(): number;

  /**
   * Writes some pending changes, limited by the time budget
   * ({@link ShulkerDBOptions.budgetMs}). Called automatically on a timer
   * unless `flushEvery` is `0`.
   * @returns Number of storage units written.
   */
  flushSome(): number;

  /** Flushes pending changes, stops the background timer, and unsubscribes from shutdown events. */
  dispose(): void;
}
