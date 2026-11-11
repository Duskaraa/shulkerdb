import type { ItemStack, Vector3 } from "@minecraft/server";

/**
 * Options for {@link ShulkerVault}.
 */
export interface ShulkerVaultOptions {
  /**
   * Dimension id that hosts the storage entities.
   * @default "overworld"
   */
  dimension?: string;
  /**
   * Location of the storage entities. A ticking area is created here.
   * @default { x: 0.5, y: dimension.heightRange.max - 2, z: 0.5 }
   */
  location?: Vector3;
  /**
   * Ticks that slots of overwritten or deleted items are kept before being
   * reused, so an interrupted save can be recovered.
   * @default 1200
   */
  quarantineTicks?: number;
  /**
   * Interval, in ticks, between background flushes of the index.
   * @default 20
   */
  flushEvery?: number;
}

/**
 * Stores {@link ItemStack}s, with all their data, in hidden storage entities,
 * indexed by a {@link ShulkerDB}.
 *
 * The vault boots asynchronously. Await {@link ShulkerVault.ready} or check
 * {@link ShulkerVault.isReady}. Calls to `set` and `delete` made before it is
 * ready are queued and applied once it is. Reads (`get`, `has`, `keys`, `size`) before it is ready throw an `Error`.
 *
 * Storage entities that are moved (for example with `/tp`) are returned to their location every 200 ticks.
 * If a storage entity goes missing (removed, or moved to a chunk that is not loaded), its records are kept
 * and reading them throws until the entity comes back. The vault searches every dimension for it and restores
 * it automatically; `stats.missing` counts storage entities currently missing.
 *
 * @example
 * import { ShulkerVault } from "./shulkerdb/index.js";
 *
 * const vault = new ShulkerVault("kits");
 * await vault.ready;
 * vault.set("starter", [sword, shield]);
 * const kit = vault.get("starter"); // ItemStack | ItemStack[] | undefined
 */
export class ShulkerVault {
  /**
   * Creates a vault.
   * Creating a vault for a namespace that is already open returns the existing instance (its options are not changed).
   * @param ns Namespace that isolates this vault from others.
   * @param opt Options.
   */
  constructor(ns: string, opt?: ShulkerVaultOptions);

  /** The namespace this vault was created with. */
  readonly ns: string;

  /**
   * Resolves when the vault has booted and is fully usable. Rejects if the
   * storage chunk does not load within 1200 ticks or the storage can't be
   * read during boot; the vault is then disposed and queued calls are discarded.
   */
  readonly ready: Promise<void>;

  /** `true` once {@link ShulkerVault.ready} has resolved. */
  readonly isReady: boolean;

  /** Recovery counters: records restored from their previous version, records dropped as unrecoverable, and storage entities currently missing. */
  readonly stats: { recovered: number; lost: number; missing: number };

  /**
   * Number of stored keys.
   * @throws {Error} If the vault is not ready yet.
   */
  readonly size: number;

  /**
   * Checks whether a key exists.
   * @param k The key.
   * @throws {Error} If the vault is not ready yet.
   */
  has(k: string): boolean;

  /**
   * Iterates over all keys.
   * @throws {Error} If the vault is not ready yet.
   */
  keys(): IterableIterator<string>;

  /**
   * Stores a single item. Queued if the vault is not ready yet.
   * @param k The key.
   * @param item The item to store.
   * @throws {TypeError} If the key is invalid.
   * @throws {Error} If the vault was disposed, or the storage entity that receives the items can't be written right now.
   */
  set(k: string, item: ItemStack): void;
  /**
   * Stores a list of items, preserving order. Queued if the vault is not ready yet.
   * @param k The key.
   * @param items The items to store.
   * @throws {TypeError} If the key is invalid.
   * @throws {Error} If the vault was disposed, or the storage entity that receives the items can't be written right now.
   */
  set(k: string, items: ItemStack[]): void;

  /**
   * Reads the items stored under a key.
   * @param k The key.
   * @returns An `ItemStack` if stored as a single item, an array if stored as a list, or `undefined` if missing.
   * @throws {Error} If the vault is not ready yet, or if the storage entity holding the items is missing or not loaded.
   */
  get(k: string): ItemStack | ItemStack[] | undefined;

  /**
   * Removes a key. Queued if the vault is not ready yet.
   * @param k The key.
   * @returns `true` if the key existed, or `true` when the call is queued before the vault is ready.
   */
  delete(k: string): boolean;

  /**
   * Writes pending index changes immediately.
   * @returns Number of storage units written.
   */
  flush(): number;

  /**
   * Flushes the index and stops the background timers. The ticking area is removed when no other vault in the same chunk uses it.
   */
  dispose(): void;
}
