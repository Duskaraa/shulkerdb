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
db.set(player.id, data); // get gives you the live object, so call set again or the change won't be saved

for (const [key, value] of db.entries()) console.log(key, value.kills);
```

Other methods: `delete`, `clear`, `size`, `keys()`, `flush()` to write everything now, `pending` to see how much is waiting to be written, and `dispose()` if you want to stop it.

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

So ShulkerDB puts many records in one property (a bucket of about 12 KB). `set` only marks the record as changed, and every second it writes the changed buckets with a small time limit, so it never freezes the game. When the world closes it writes whatever is left. A record bigger than a bucket gets split into parts of 32,000 bytes. The limit is about 32 KB of UTF-8, not 32K characters, and in my tests Con-Database, Tendrock and QuickDB all failed with 32 KB records.

About crashes: nothing is on disk until the next autosave or until the world closes normally, that's how every Script API storage works. If the game crashes you lose the changes since the last autosave, but what's left is never half-written. Records moving between buckets get written to the new place first, and big records get a new set of parts before the old one is removed. I tested it closing the game with Alt+F4 while it was writing.

The vault uses a ticking area from `world.tickingAreaManager`, which belongs to the pack and doesn't count against the 10 command ticking areas. Items and their index get saved at different moments, so every update goes to new slots and the old ones are kept for a minute. On boot, every entry is checked against a fingerprint of its items (type, amount, name, lore, lock mode, the size of its dynamic properties and, for items that don't stack, enchantments and durability). If it doesn't match it goes back to the previous version, and if that doesn't match either it gets dropped, so it never gives you empty slots or another key's items.

## Performance

I ran the same tests for every DB on a Bedrock Dedicated Server 1.26.60, with the same pack and the same data, so the only thing that changes is the DB. Every number is measured, nothing is estimated. Write and updates include the time it takes to actually save, and reopen is restarting the server, opening the store and reading everything back.

What matters most in a real pack is updates: player data changes all the time, and every key you have is something the game has to save on each autosave. That's what ShulkerDB is built around.

### 2,000 records of 100 bytes

| | Write | Updates | Reopen | Keys | World size |
|---|---:|---:|---:|---:|---:|
| **ShulkerDB** | **70 ms** | **37 ms** | 28 ms | **12** | **228 KB** |
| Raw dynamic properties | 101 ms | 79 ms | 15 ms | 2,000 | 240 KB |
| [QuickDB](https://github.com/nperma/QuickDB) | 97 ms | 111 ms | 32 ms | 2,000 | 267 KB |
| [Con-Database](https://github.com/Con-JS-Development/Con-Database) | 108 ms | 149 ms | 27 ms | 2,000 | 275 KB |
| [Tendrock](https://github.com/AbbottMc/tendrock-database) | 90 ms | 84 ms | 2 ms | 2,000 | 298 KB |
| [bedrock-database](https://github.com/smell-of-curry/bedrock-database) | 16,053 ms | 31,521 ms | 14 ms | 32 | 232 KB |

### Bigger loads

| | 5,000 × 100 B updates | 5,000 × 2 KB updates | 50,000 × 100 B write | 50,000 × 100 B updates | Keys at 50,000 |
|---|---:|---:|---:|---:|---:|
| **ShulkerDB** | **159 ms** | **316 ms** | 2,877 ms | 2,141 ms | **488** |
| Raw dynamic properties | 306 ms | 520 ms | 1,338 ms | 2,008 ms | 50,000 |
| QuickDB | 323 ms | 583 ms | 1,999 ms | 4,215 ms | 50,000 |
| Con-Database | 417 ms | 610 ms | 1,750 ms | 2,997 ms | 50,000 |
| Tendrock | 539 ms | 643 ms | 87,494 ms | 160,070 ms | 50,000 |

Writing 5,000 records of 2 KB froze the server for more than 100 ms on 19 ticks with ShulkerDB and on 30 to 37 ticks with the others.

Where it doesn't win: reopening. ShulkerDB unpacks its buckets when it opens, so with 50,000 records it takes 728 ms while raw properties take 294 ms and Tendrock 124 ms. It happens once per restart and it's spread over several ticks.

### Edge cases

Empty and 512-byte keys, unicode and split emojis, 30 KB to 1 MB values, 10,000-item arrays, and grow/shrink and churn runs, all read back after a restart:

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
| **ShulkerVault** | **2 ms** | **704 ms** | **39 ms** | **64 KB** | **8 / 8** |
| QIDB | 10,000 ms | 2,001 ms | 1,182 ms | 3,142 KB | 7 / 8 |

The tests ran on four server copies at the same time (Ryzen AI 9 HX 370, 32 GB), so take the absolute times as a reference. The comparison between DBs is what counts.

## License

MIT
