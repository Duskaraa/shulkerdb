# ShulkerDB

Storage for the Bedrock Script API. I made it because I needed to save a lot of player data and items in my packs, and the databases I tried were either slow with many keys, broke with big strings, or used structures for items, which is really slow.

There are two things in here:

- `ShulkerDB` saves JSON data (stats, profiles, configs) in world dynamic properties, but it packs many records into each property, so 10,000 records end up as around 60 keys instead of 10,000.
- `ShulkerVault` saves real `ItemStack`s with everything on them (enchants, name, lore, durability, books, filled shulkers) inside storage entities, no structures.

Both work like a `Map` (`get`, `set`, `has`, `delete`, `keys`...), have no dependencies and come with TypeScript types. Needs `@minecraft/server` 2.11 or newer.

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
- keys are strings up to 512 bytes and can't have the characters `\u0001` or `\u0002`
- values have to be JSON, so `Map`, `Set`, `BigInt` and classes won't survive
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

The items are stored in `sdb:vault` entities at `0, 318, 0` in the overworld (256 slots each). They can't die and if something moves them they go back. Don't build there, or pass a different `location` (and `dimension`) in the options. The only thing that can destroy them is `Entity.remove()`, so if you have a script that removes entities, skip `sdb:vault`. If one gets removed anyway the vault logs it and drops those entries.

`vault.stats` tells you how many entries were rolled back to their previous version or dropped on boot, it should be `{ recovered: 0, lost: 0 }` unless the game crashed.

## How it works

Dynamic properties are kept in memory and the game writes all of a pack's properties to disk together on every autosave. That cost goes up with the number of keys, not the size: 5,000 small keys took 379 ms to save, and the same data in 50 keys of 12 KB took 5 ms. Also, setting a lot of keys in one `setDynamicProperties` call gets really slow, 50,000 keys took 35 s.

So ShulkerDB puts many records in one property (a bucket of about 12 KB). `set` only marks the record as changed, and every second it writes the changed buckets with a small time limit, so it never freezes the game. When the world closes it writes whatever is left. A record bigger than a bucket gets split into parts of 32,000 bytes. The limit is about 32 KB of UTF-8, not 32K characters, and in my tests Con-Database, Tendrock and QuickDB all failed with 32 KB records.

About crashes: nothing is on disk until the next autosave or until the world closes normally, that's how every Script API storage works. If the game crashes you lose the changes since the last autosave, but what's left is never half-written. Records moving between buckets get written to the new place first, and big records get a new set of parts before the old one is removed. I tested it closing the game with Alt+F4 while it was writing.

The vault uses a ticking area from `world.tickingAreaManager`, which belongs to the pack and doesn't count against the 10 command ticking areas. Items and their index get saved at different moments, so every update goes to new slots and the old ones are kept for a minute. On boot, if an entry doesn't match its items it goes back to the previous version, and if that doesn't match either it gets dropped, so it never gives you empty slots or another key's items.

## Performance

Same test for every DB on BDS 1.26.60, 2,000 records of 100 bytes:

| | Write | Updates | Reopen | Keys |
|---|---:|---:|---:|---:|
| Raw dynamic properties | 65 ms | 81 ms | 10 ms | 2,000 |
| [Con-Database](https://github.com/Con-JS-Development/Con-Database) | 71 ms | 127 ms | 13 ms | 2,000 |
| [QuickDB](https://github.com/nperma/QuickDB) | 109 ms | 188 ms | 11 ms | 2,000 |
| ShulkerDB | 96 ms | 57 ms | 21 ms | 12 |

Reopen is opening the store and reading everything after a restart. Writing is a bit slower than raw properties because of the packing, but updates are faster and the autosave only has to deal with 12 keys. For items, 200 items took about 15 ms with the vault, while [QIDB](https://github.com/Carchi777/QUICK-ITEM-DATABASE) took 10 s and the world grew 2.9 MB instead of 76 KB.

## License

MIT
