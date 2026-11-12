# ShulkerDB

Storage for the Bedrock Script API. I made it because I needed to save a lot of player data and items in my packs, and the databases I tried were either slow with many keys, broke with big strings, or saved items through structures, which gets slow when you have a lot of keys.

There are two things in here:

- `ShulkerDB` saves JSON data (stats, profiles, configs) in world dynamic properties, but it packs many records into each property, so 10,000 records end up as around 60 keys instead of 10,000.
- `ShulkerVault` saves real `ItemStack`s with everything on them (enchants, name, lore, durability, books, filled shulkers) inside storage entities, no structures.

Both have a `Map`-like API (`get`, `set`, `has`, `delete`, `keys`...), have no dependencies and come with TypeScript types. Needs `@minecraft/server` 2.11 or newer.

## Install

Copy `src/` into your pack's `scripts/` folder and rename it to `shulkerdb/`. If you're going to use the vault, also copy `entities/sdb_vault.json` into your pack's `entities/` folder.

Create the stores inside `worldLoad`, dynamic properties can't be read before that:

```js
import { world } from "@minecraft/server";
import { ShulkerDB, ShulkerVault } from "./shulkerdb/index.js";

let db, vault;

world.afterEvents.worldLoad.subscribe(async () => {
  db = new ShulkerDB("mypack");
  vault = new ShulkerVault("mypack");
  await vault.ready;
});

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (initialSpawn && !db.has(player.id)) db.set(player.id, { kills: 0, money: 0 });
});
```

Use `player.id` for keys, not the name. Names can change.

## ShulkerDB

```js
const db = new ShulkerDB("stats");

db.set(player.id, { kills: 3, money: 120 });

const data = db.get(player.id);
data.kills++;
db.set(player.id, data); // get gives you the live object, call set again so the change is saved

for (const [key, value] of db.entries()) console.log(key, value.kills);
```

Other methods: `delete`, `clear`, `size`, `keys()`, `flush()` to write everything now, `pending` to see how much is waiting to be written, and `dispose()` if you want to stop it. If you go through `keys()` or `entries()` across several ticks, take a copy first (`[...db.keys()]`), a save in the middle can move records around.

A few rules:
- keys are strings up to 512 bytes and can't have the characters `\u0000`, `\u0001`, `\u0002` or broken surrogate pairs (the game cuts strings at `\u0000`)
- values have to be JSON, so `Map`, `Set` and classes won't survive. A value that can't be saved at all, like a `BigInt` or a circular object, logs a warning when it's flushed and the key keeps the last value that was saved (or disappears if it was never saved)
- opening the same namespace twice gives you the same instance, and namespaces starting with `sv_` are used by the vault
- use one namespace per feature instead of one giant store, each one loads and saves only its own data
- everything is kept in script memory, and Bedrock kills a pack's scripts past 250 MB. 10 MB of records works fine, 100 MB ran out of memory, so don't put huge stuff in here

Options, with their defaults:

```js
new ShulkerDB("stats", {
  bucketSize: 12000, // bytes per dynamic property, bigger means fewer keys but each update rewrites more
  flushEvery: 20,    // ticks between saves, 0 turns the timer off (then only flush() and shutdown save)
  budgetMs: 3,       // time per save, goes up to 4x on its own when there's a backlog
  batchSize: 256,    // max keys per setDynamicProperties call
});
```

## ShulkerVault

```js
const vault = new ShulkerVault("kits");
await vault.ready;

vault.set("starter", [sword, shield, bread]);
vault.set("reward", diamond);

vault.get("starter"); // same shape you saved, array or single item
```

The vault needs its chunk loaded, which takes a few seconds after `worldLoad`, and then it checks every entry. That check runs over several ticks so it doesn't lag, it took about 0.7 s with 200 items and 8 s with 100,000. Before `ready` resolves, `set` and `delete` get queued and applied later, but `get`, `has`, `keys` and `size` throw, since the items aren't verified yet. You can check `vault.isReady`.

The items are stored in `sdb:vault` entities at `0, 0`, two blocks below the build limit of the overworld (256 slots each). They can't die and if something moves them they go back. Don't build there, or pass a different `location` (and `dimension`) in the options. The only thing that can destroy them is `Entity.remove()`, so if you have a script that removes entities, skip `sdb:vault`.

If a storage entity goes missing, because it was removed or moved somewhere that isn't loaded, the vault logs it and keeps its entries. Reading one of them throws until the entity shows up again, and the vault looks for it in every dimension and brings it back on its own, even after a restart. Entries whose current items are in another entity keep working. If the vault's chunk unloads it waits until it loads again instead of treating it as a loss, and it doesn't spawn a second entity when the first one loads late. Old copies of an entity that show up later are recognized and removed, they're never read as the real one.

The one exception is a crash right after the vault created a new storage entity (a normal shutdown always saves it): if the game never saved that entity, the vault waits about a minute after the next boot in case it's only loading late, and then the entries stored in it go back to their previous version or are dropped, instead of waiting forever for an entity that doesn't exist.

`vault.stats` tells you how many entries were rolled back to their previous version, how many were dropped because their items didn't match, and how many storage entities are missing right now. It should be `{ recovered: 0, lost: 0, missing: 0 }` unless the game crashed or an entity was moved.

## How it works

Dynamic properties are kept in memory and the game writes all of a pack's properties to disk together on every autosave. That cost goes up with the number of keys, not the size: 5,000 small keys took 379 ms to save, and the same data in 50 keys of 12 KB took 5 ms. Also, setting a lot of keys in one `setDynamicProperties` call gets really slow, 50,000 keys took 35 s.

So ShulkerDB puts many records in one property (a bucket of about 12 KB). Each bucket keeps its keys apart from its values, so opening a store only reads the keys, and a bucket's values get parsed in one go the first time you read one of them. `set` only marks the bucket as changed, and every second it writes the changed buckets with a small time limit, so it never freezes the game. When the world closes it writes whatever is left. A record that doesn't fit in one property gets split into parts of 32,000 bytes. The limit is about 32 KB of UTF-8, not 32K characters, and in my tests Con-Database, Tendrock and QuickDB all failed with 32 KB records.

About crashes: nothing is on disk until the next autosave or until the world closes normally, that's how every Script API storage works. If the game crashes you lose the changes since the last autosave, but what's left is never half-written. Records moving between buckets get written to the new place first, even when one save moves them several times, and big records get a new set of parts before the old one is removed. Data saved by 1.1.0 or older is read as is and rewritten in the new format the next time it's saved. Going back to 1.1.0 after that doesn't work, it can't read the new format. I tested it closing the game with Alt+F4 while it was writing.

The vault uses a ticking area from `world.tickingAreaManager`, which belongs to the pack and doesn't count against the 10 command ticking areas. Items and their index get saved at different moments, so every update goes to new slots and the old ones are kept for a minute. On boot, every entry is checked against a fingerprint of its items (type, amount, name, lore, lock mode, the size of its dynamic properties and, for items that don't stack, enchantments and durability). If it doesn't match it goes back to the previous version, and if that doesn't match either it gets dropped, so it never gives you empty slots or another key's items.

## Performance

I ran the same tests for every DB on a Bedrock Dedicated Server 1.26.60, with the same pack and the same data, so the only thing that changes is the DB. Every number is measured, nothing is estimated. Write and updates include the time it takes to actually save. Reopen is restarting the server, opening the store and reading everything back, and it includes the work a DB does on its own when the world loads (Tendrock reads all its properties there).

What matters most in a real pack is updates: player data changes all the time, and every key you have is something the game has to save on each autosave. That's what ShulkerDB is built around.

### 2,000 records of 100 bytes

| | Write | Updates | Reopen | Keys | World size |
|---|---:|---:|---:|---:|---:|
| **ShulkerDB** | **44 ms** | **36 ms** | 14 ms | **11** | **228 KB** |
| Raw dynamic properties | 67 ms | 83 ms | 14 ms | 2,000 | 239 KB |
| [QuickDB](https://github.com/nperma/QuickDB) | 68 ms | 88 ms | 20 ms | 2,000 | 267 KB |
| [Con-Database](https://github.com/Con-JS-Development/Con-Database) | 68 ms | 105 ms | 12 ms | 2,000 | 275 KB |
| [Tendrock](https://github.com/AbbottMc/tendrock-database) | 84 ms | 69 ms | 19 ms | 2,000 | 298 KB |
| [bedrock-database](https://github.com/smell-of-curry/bedrock-database) | 10,713 ms | 24,820 ms | 11 ms | 32 | 232 KB |

### Bigger loads

| | 5,000 × 100 B | | | 5,000 × 2 KB | | | 50,000 × 100 B | | | Keys at 50,000 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| | Write | Updates | Reopen | Write | Updates | Reopen | Write | Updates | Reopen | |
| **ShulkerDB** | **115** | **132** | **24** | **3,116** | **246** | **67** | **1,115** | **971** | 305 | **405** |
| Raw dynamic properties | 128 | 257 | 28 | 3,244 | 484 | 85 | 1,249 | 2,218 | **289** | 50,000 |
| QuickDB | 148 | 337 | 39 | 3,450 | 542 | 97 | 1,564 | 2,815 | 397 | 50,000 |
| Con-Database | 153 | 383 | 31 | 3,399 | 594 | 97 | 1,914 | 3,114 | 412 | 50,000 |
| Tendrock | 318 | 538 | 48 | 3,217 | 571 | 81 | 29,866 | 44,454 | 405 | 50,000 |

Times in ms. Most packs don't read every record right after a restart, they open the store and read what they need. Opening a store with 50,000 records and reading one takes 39 ms with ShulkerDB and 327 to 356 ms with QuickDB, Con-Database and Tendrock, which load everything up front. Raw properties don't open anything, so they're at 0, but they're paying for 50,000 keys on every autosave.

Where it doesn't win: reading all 50,000 records back after a restart, raw properties are about 5% faster (289 ms vs 305 ms). Most of that time is the game parsing JSON, which costs the same either way.

Writing 5,000 records of 2 KB, the slowest tick was 140 ms with ShulkerDB and 156 to 217 ms with the others, but ShulkerDB had more ticks over 100 ms (19, the others 1 to 3), since it saves the backlog in bigger steps.

### Compared to 1.1.0

| 50,000 records | 1.1.0 | 1.2.0 |
|---|---:|---:|
| Write | 2,877 ms | 1,115 ms |
| Updates | 2,141 ms | 971 ms |
| Reopen | 728 ms | 305 ms |

### Edge cases

Empty and 512-byte keys, `__proto__` and `constructor` as keys, unicode and split emojis, 30 KB to 1 MB values, 10,000-item arrays, and grow/shrink and churn runs, all read back after a restart:

| | Passed |
|---|---:|
| **ShulkerDB** | **26 / 26 and 3 / 3 runs** |
| Raw dynamic properties | 22 / 26, big values get lost |
| Con-Database | 21 / 26 |
| QuickDB | 22 / 26 live, then fails to load after the restart |
| Tendrock, bedrock-database | throw while writing the cases |

### Items

[QIDB](https://github.com/Carchi777/QUICK-ITEM-DATABASE) keeps each key as a structure with an entity inside and saves 20 keys per second. With one key holding 200 items both take about the same, but with many keys it adds up. 200 keys of one item each:

| | Save | Open | Worst tick reading | World size | Edge cases |
|---|---:|---:|---:|---:|---:|
| **ShulkerVault** | **11 ms** | **706 ms** | **37 ms** | **75 KB** | **8 / 8** |
| QIDB | 9,993 ms | 2,005 ms | 1,037 ms | 2,880 KB | 7 / 8 |

The tests ran on five server copies at the same time (Ryzen AI 9 HX 370, 32 GB), so take the absolute times as a reference. The comparison between DBs is what counts.

## License

MIT
