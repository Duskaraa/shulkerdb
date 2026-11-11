import { world, system, DimensionTypes } from "@minecraft/server";
import { ShulkerDB, checkKey, inner } from "./shulkerdb.js";

const type = "sdb:vault";
const boxSize = 256;
const areas = new Map();
const vaults = new Map();
export function _resetVaults() { vaults.clear(); areas.clear(); }

function boxOf(ent) {
  const c = ent.getComponent("inventory").container;
  if (c.size !== boxSize) throw new Error(`sdb:vault has ${c.size} slots, ShulkerVault stores ${boxSize} per box; check inventory_size in the entity file`);
  return c;
}

function fpItem(it, deep) {
  if (!it) return "-";
  let s = `${it.typeId}*${it.amount}*${it.nameTag ?? ""}`;
  if (!deep) return s;
  s += `*${JSON.stringify(it.getLore())}*${it.getDynamicPropertyTotalByteCount()}*${it.lockMode}*${it.keepOnDeath ? 1 : 0}`;
  if (it.maxAmount === 1) {
    const d = it.getComponent("durability");
    if (d) s += `*${d.damage}`;
    const e = it.getComponent("enchantable");
    if (e) s += `*${e.getEnchantments().map(x => x.type.id + x.level).sort().join(",")}`;
  }
  return s;
}

function fpList(list, deep = true) {
  let h = 2166136261;
  for (const it of list) {
    const s = fpItem(it, deep);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= 0x7c; h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + (deep ? "~" : "");
}

function same(list, f) {
  return fpList(list, typeof f === "string" && f.endsWith("~")) === f;
}

function ranges(slots) {
  const r = [];
  for (const s of slots) {
    const last = r.length - 2;
    if (last >= 0 && r[last] + r[last + 1] === s) r[last + 1]++;
    else r.push(s, 1);
  }
  return r;
}

function top(r) {
  let n = 0;
  if (r) for (let i = 0; i < r.length; i += 2) n = Math.max(n, (((r[i] + r[i + 1] - 1) / boxSize) | 0) + 1);
  return n;
}

function job(g) {
  return new Promise((done, fail) => system.runJob((function* () { try { done(yield* g); } catch (e) { fail(e); } })()));
}

function expand(r) {
  const out = [];
  if (r) for (let i = 0; i < r.length; i += 2) for (let s = r[i]; s < r[i] + r[i + 1]; s++) out.push(s);
  return out;
}

export class ShulkerVault {
  constructor(ns, opt = {}) {
    if (typeof ns !== "string" || /[\u0000-\u0002]/.test(ns)) throw new TypeError("invalid namespace");
    if (vaults.has(ns)) return vaults.get(ns);
    this.ns = ns;
    this.dim = world.getDimension(opt.dimension ?? "overworld");
    this.at = opt.location ?? { x: 0.5, y: this.dim.heightRange.max - 2, z: 0.5 };
    this.quarantine = opt.quarantineTicks ?? 1200;
    this.idx = new ShulkerDB(`sv_${ns}`, { flushEvery: opt.flushEvery ?? 20, [inner]: true });
    this.boxes = [];
    this.ents = [];
    this.free = [];
    this.queue = [];
    this.isReady = false;
    this.held = [];
    this.stats = { recovered: 0, lost: 0, missing: 0 };
    this.lostId = `sv\u0001lost\u0001${ns}`;
    this.lost = new Set();
    this.genId = `sv\u0001gen\u0001${ns}`;
    this.gen = new Map();
    this.lilId = `sv\u0001lil\u0001${ns}`;
    this.lil = new Map();
    this.upId = `sv\u0001up\u0001${ns}`;
    this.bye = system.beforeEvents.shutdown.subscribe(() => { if (this.up) try { world.setDynamicProperty(this.upId, undefined); } catch {} });
    vaults.set(ns, this);
    this.ready = this.#boot().catch(e => { this.#fail(); throw e; });
  }

  async #boot() {
    const at = { x: Math.floor(this.at.x), y: Math.floor(this.at.y), z: Math.floor(this.at.z) };
    this.area = `sdb:${this.dim.id}_${at.x >> 4}_${at.z >> 4}`;
    let shared = areas.get(this.area);
    if (!shared) {
      shared = { n: 0 };
      areas.set(this.area, shared);
    }
    shared.n++;
    for (let t = 0; !this.gone && !this.#loaded(); t++) {
      if (t >= 1200) throw new Error(`ShulkerVault "${this.ns}": the storage chunk did not load`);
      await system.waitTicks(1);
    }
    if (this.gone) return;
    try { for (const i of JSON.parse(world.getDynamicProperty(this.lostId) ?? "[]")) if (Number.isInteger(i)) this.lost.add(i); } catch {}
    try { for (const [b, g] of JSON.parse(world.getDynamicProperty(this.genId) ?? "[]")) this.gen.set(b, g); } catch {}
    try { for (const [b, t] of JSON.parse(world.getDynamicProperty(this.lilId) ?? "[]")) this.lil.set(b, t); } catch {}
    const crashed = world.getDynamicProperty(this.upId) !== undefined;
    world.setDynamicProperty(this.upId, 1);
    this.up = true;

    const need = (this.need = await job(this.#span()));
    if (this.gone) return;
    for (let t = 0, grace = -1; t < 400; t++) {
      const last = grace === 0;
      for (const ent of last || t % 20 === 19 ? this.#everywhere() : this.#near()) this.#adopt(ent, ent.getDynamicProperty("i"));
      let have = 0;
      for (let b = 0; b < need; b++) if (this.boxes[b] || this.lost.has(b)) have++;
      if (have >= need || last) break;
      if (grace < 0 && this.#full()) grace = 2;
      else if (grace > 0) grace--;
      await system.waitTicks(1);
      if (this.gone) return;
    }
    for (let b = 0; b < need; b++) if (!this.boxes[b] && !this.lost.has(b)) this.#mark(b);
    this.doubt = new Set(crashed ? [...this.lil.keys()].filter(b => this.lost.has(b)) : []);
    if (this.boxes.length < need) this.boxes.length = need;
    this.#pickTwins();

    const used = new Set();
    this.refd = new Set();
    const last = await job(this.#verify(used));
    if (this.gone) return;
    for (const b of [...this.lost]) if (!this.refd.has(b)) { this.lost.delete(b); this.#retire(b); }
    for (const b of [...this.doubt]) if (!this.lost.has(b)) this.doubt.delete(b);
    this.refd = null;
    while (this.boxes.length > last) {
      const b = this.boxes.length - 1;
      this.ents[b]?.remove();
      this.lost.delete(b);
      this.ents.length = b;
      this.boxes.length = b;
    }
    this.#saveLost();
    for (const b of [...this.lil.keys()]) if (!this.doubt.has(b)) this.lil.delete(b);
    await job(this.#fill(used));
    this.#saveLil();
    if (this.gone) return;
    this.isReady = true;
    for (const [op, k, items] of this.queue.splice(0)) {
      try { op ? this.set(k, items) : this.delete(k); } catch (e) { console.warn(`[ShulkerVault ${this.ns}] queued ${op ? "set" : "delete"} of "${k}" failed: ${e}`); }
    }
    this.since = this.aged = system.currentTick;
    this.timer = system.runInterval(() => this.#tick(), 200);
    this.idx.flush();
  }

  #tick() {
    if (this.gone) return;
    const now = system.currentTick, dt = now - (this.aged ?? now);
    this.aged = now;
    let aged = false;
    if (dt > 0) for (const [b, t] of this.lil) {
      if (this.doubt.has(b)) continue;
      if (t + dt >= 6000) this.lil.delete(b); else this.lil.set(b, t + dt);
      aged = true;
    }
    if (!this.#guard()) { if (aged) this.#saveLil(); return; }
    for (const b of [...this.doubt]) {
      if (this.lost.has(b) && now - this.since < 1200) continue;
      this.doubt.delete(b);
      this.lil.delete(b);
      aged = true;
      if (this.lost.has(b)) this.#abandon(b);
    }
    if (aged) this.#saveLil();
    this.#release();
  }

  #abandon(b) {
    const out = s => ((s / boxSize) | 0) === b;
    const away = r => expand(r).some(s => !out(s) && this.lost.has((s / boxSize) | 0));
    const ila = a => { const x = a.filter(s => !out(s)); if (x.length) this.held.push({ at: system.currentTick, slots: x }); };
    let back = 0, gone = 0;
    for (const k of [...this.idx.keys()]) {
      const e = this.idx.get(k);
      if (!e) continue;
      const c = expand(e.c), p = expand(e.p);
      if (c.some(out)) {
        if (e.p && !p.some(out) && (away(e.p) || this.#matches(e.p, e.g))) { this.idx.set(k, { m: e.pm ?? e.m, c: e.p, f: e.g }); ila(c); back++; this.stats.recovered++; }
        else { this.idx.delete(k); ila(c); ila(p); gone++; this.stats.lost++; }
      } else if (p.some(out)) { this.idx.set(k, { m: e.m, c: e.c, f: e.f }); ila(p); }
    }
    this.held = this.held.map(h => ({ ...h, slots: h.slots.filter(s => !out(s)) }));
    this.free = this.free.filter(s => !out(s));
    this.lost.delete(b);
    this.#retire(b);
    this.boxes[b] = this.#spawn(b);
    for (let i = boxSize - 1; i >= 0; i--) this.free.push(b * boxSize + i);
    this.free.sort((x, y) => y - x);
    this.#saveLost();
    this.idx.flush();
    console.warn(`[ShulkerVault ${this.ns}] storage entity ${b} was created shortly before the game stopped unexpectedly and never came back, so it was not saved; ${back} records went back to their previous version${gone ? `, ${gone} were dropped` : ""}`);
  }

  #saveLil() {
    world.setDynamicProperty(this.lilId, this.lil.size ? JSON.stringify([...this.lil]) : undefined);
  }

  #near() {
    return this.dim.getEntities({ type, location: this.at, maxDistance: 2 }).filter(e => e.getDynamicProperty("ns") === this.ns);
  }

  #everywhere() {
    const out = [];
    const ids = new Set(DimensionTypes.getAll().map(d => d.typeId));
    ids.add(this.dim.id);
    for (const id of ids) {
      let d;
      try { d = world.getDimension(id); } catch { continue; }
      for (const e of d.getEntities({ type })) if (e.getDynamicProperty("ns") === this.ns) out.push(e);
    }
    return out;
  }

  #mine(ent, i) {
    return (ent.getDynamicProperty("g") ?? 0) === (this.gen.get(i) ?? 0);
  }

  #own(ent, i) {
    return this.#mine(ent, i) && (!this.ents[i] || this.ents[i].id === ent.id);
  }

  #retire(b) {
    this.gen.set(b, (this.gen.get(b) ?? 0) + 1);
    world.setDynamicProperty(this.genId, JSON.stringify([...this.gen]));
  }

  #saveLost() {
    this.stats.missing = this.lost.size;
    world.setDynamicProperty(this.lostId, this.lost.size ? JSON.stringify([...this.lost]) : undefined);
  }

  #mark(b) {
    if (this.lost.has(b)) return;
    this.lost.add(b);
    this.boxes[b] = undefined;
    console.warn(`[ShulkerVault ${this.ns}] storage entity ${b} is missing (moved away or removed); its records stay and come back if it returns`);
  }

  #fail() {
    if (this.gone) return;
    this.gone = true;
    if (vaults.get(this.ns) === this) vaults.delete(this.ns);
    if (this.timer !== undefined) system.clearRun(this.timer);
    try { system.beforeEvents.shutdown.unsubscribe(this.bye); } catch {}
    try { this.idx.dispose(); } catch {}
    const shared = areas.get(this.area);
    if (shared && --shared.n <= 0) {
      areas.delete(this.area);
      try { if (world.tickingAreaManager.hasTickingArea(this.area)) world.tickingAreaManager.removeTickingArea(this.area); } catch {}
    }
  }

  *#span() {
    let need = 0;
    for (const k of this.idx.keys()) {
      const e = this.idx.get(k);
      if (e) need = Math.max(need, top(e.c), top(e.p));
      yield;
    }
    return need;
  }

  *#verify(used) {
    let last = 0;
    const away = r => expand(r).some(s => this.lost.has((s / boxSize) | 0));
    for (const k of [...this.idx.keys()]) {
      if (this.gone) return 0;
      const e = this.idx.get(k);
      if (!e) continue;
      let keep = null;
      if (away(e.c) || this.#matches(e.c, e.f)) keep = [e.c, e.p];
      else if (e.p && away(e.p)) {
        this.idx.set(k, { m: e.pm ?? e.m, c: e.p, f: e.g });
        keep = [e.p];
      }
      else if (e.p && this.#matches(e.p, e.g)) {
        this.idx.set(k, { m: e.pm ?? e.m, c: e.p, f: e.g });
        keep = [e.p];
        this.stats.recovered++;
      } else {
        this.idx.delete(k);
        this.stats.lost++;
        console.warn(`[ShulkerVault ${this.ns}] record "${k}" does not match stored items, dropped`);
      }
      if (keep) for (const r of keep) { for (const s of expand(r)) { used.add(s); this.refd.add((s / boxSize) | 0); } last = Math.max(last, top(r)); }
      yield;
    }
    return last;
  }

  *#fill(used) {
    for (let b = this.boxes.length - 1; b >= 0; b--) {
      if (this.lost.has(b)) continue;
      if (!this.boxes[b]) this.boxes[b] = this.#spawn(b);
      const box = this.boxes[b];
      let mine = 0;
      for (let i = 0; i < boxSize; i++) if (used.has(b * boxSize + i)) mine++;
      const stale = box.size - box.emptySlotsCount > mine;
      for (let i = boxSize - 1; i >= 0; i--) {
        if (used.has(b * boxSize + i)) continue;
        if (stale && box.getItem(i)) box.setItem(i);
        this.free.push(b * boxSize + i);
      }
      yield;
    }
  }

  #adopt(ent, i) {
    if (!Number.isInteger(i) || i < 0 || i > Math.max(this.need ?? 0, this.ents.length) + 64 || !this.#mine(ent, i)) { ent.remove(); return; }
    if (this.lost.has(i)) { if (this.isReady) { this.#restore([[ent, i]]); return; } this.lost.delete(i); }
    const cur = this.ents[i];
    if (cur?.id === ent.id && cur.isValid) return;
    if (cur?.isValid) {
      if (this.isReady) ent.remove();
      else (this.twins ??= new Map()).set(ent.id, ent);
      return;
    }
    this.ents[i] = ent;
    this.boxes[i] = boxOf(ent);
    this.#home(ent);
  }

  #pickTwins() {
    for (const ent of this.twins?.values() ?? []) {
      if (!ent.isValid) continue;
      const i = ent.getDynamicProperty("i"), cur = this.ents[i];
      const box = boxOf(ent);
      const a = this.#score(i, this.boxes[i]), b = this.#score(i, box);
      if (cur?.isValid && (b > a || (b === a && box.emptySlotsCount < this.boxes[i].emptySlotsCount))) {
        this.ents[i] = ent; this.boxes[i] = box; this.#home(ent);
        cur.remove();
      } else ent.remove();
    }
    this.twins = null;
  }

  #score(b, box) {
    let n = 0;
    for (const k of this.idx.keys()) {
      const e = this.idx.get(k);
      if (!e) continue;
      for (const [r, f] of [[e.c, e.f], [e.p, e.g]]) {
        if (!r) continue;
        const slots = expand(r);
        if (slots.every(s => ((s / boxSize) | 0) === b) && same(slots.map(s => box.getItem(s % boxSize)), f)) n++;
      }
    }
    return n;
  }

  #strays() {
    const back = [];
    for (const ent of this.#near()) {
      const i = ent.getDynamicProperty("i");
      if (this.lost.has(i) && this.#own(ent, i)) { back.push([ent, i]); continue; }
      if (this.lost.has(i) || this.ents[i]?.id !== ent.id) ent.remove();
    }
    if (back.length && !this.miss?.size) this.#restore(back);
  }

  #restore(list) {
    const back = new Set();
    for (const [ent, b] of list) {
      if (!this.lost.has(b) || back.has(b)) continue;
      this.#home(ent);
      if (!ent.isValid) continue;
      this.ents[b] = ent;
      this.boxes[b] = boxOf(ent);
      back.add(b);
    }
    if (!back.size) return;
    for (const b of back) this.lost.delete(b);
    const at = s => (s / boxSize) | 0;
    const hit = r => expand(r).some(s => back.has(at(s)));
    const away = r => expand(r).some(s => this.lost.has(at(s)));
    const used = new Set();
    const keep = r => { for (const s of expand(r)) used.add(s); };
    let ok = 0, gone = 0;
    for (const k of [...this.idx.keys()]) {
      const e = this.idx.get(k);
      if (!e || (!hit(e.c) && !hit(e.p))) continue;
      if (!hit(e.c) || away(e.c) || this.#matches(e.c, e.f)) { keep(e.c); keep(e.p); if (!away(e.c)) ok++; continue; }
      if (e.p && (away(e.p) || this.#matches(e.p, e.g))) {
        this.idx.set(k, { m: e.pm ?? e.m, c: e.p, f: e.g });
        this.#hold(e.c); keep(e.p);
        if (!away(e.p)) { ok++; this.stats.recovered++; }
      } else { this.idx.delete(k); this.#hold(e.c); this.#hold(e.p); gone++; this.stats.lost++; }
    }
    for (const h of this.held) for (const s of h.slots) if (back.has(at(s))) used.add(s);
    for (const b of back) {
      const box = this.boxes[b];
      for (let i = boxSize - 1; i >= 0; i--) {
        const s = b * boxSize + i;
        if (used.has(s)) continue;
        if (box.getItem(i)) box.setItem(i);
        this.free.push(s);
      }
    }
    this.free.sort((x, y) => y - x);
    this.#saveLost();
    console.warn(`[ShulkerVault ${this.ns}] storage ${back.size > 1 ? "entities" : "entity"} ${[...back].join(", ")} came back; ${ok} records available again${gone ? `, ${gone} did not match and were dropped` : ""}`);
  }

  #home(ent) {
    const { x, y, z } = ent.location;
    if (ent.dimension.id !== this.dim.id || Math.abs(x - this.at.x) + Math.abs(y - this.at.y) + Math.abs(z - this.at.z) > 1) ent.teleport(this.at, { dimension: this.dim });
  }

  #loaded() {
    const tam = world.tickingAreaManager;
    if (!tam.hasTickingArea(this.area)) {
      const at = { x: Math.floor(this.at.x), y: Math.floor(this.at.y), z: Math.floor(this.at.z) };
      try { tam.createTickingArea(this.area, { dimension: this.dim, from: at, to: at }).catch(() => {}); } catch (e) { if (!this.warned) console.warn(`[ShulkerVault ${this.ns}] could not create ticking area "${this.area}": ${e}`); this.warned = true; }
    }
    try { return this.dim.isChunkLoaded(this.at); } catch { return false; }
  }

  #full() {
    try { return !!world.tickingAreaManager.getTickingArea(this.area)?.isFullyLoaded; } catch { return false; }
  }

  #reattach(b, near) {
    let ent = this.ents[b];
    if (!ent?.isValid) {
      const again = near().find(x => x.isValid && x.getDynamicProperty("ns") === this.ns && x.getDynamicProperty("i") === b && this.#own(x, b));
      if (again) { this.ents[b] = ent = again; this.boxes[b] = boxOf(again); }
    }
    if (!ent?.isValid) return false;
    if (!this.boxes[b]?.isValid) this.boxes[b] = boxOf(ent);
    this.#home(ent);
    return true;
  }

  #guard() {
    if (!this.#loaded()) return false;
    let list;
    const near = () => list ??= this.dim.getEntities({ type, location: this.at, maxDistance: 2 });
    const missing = [];
    this.miss ??= new Map();
    for (let b = 0; b < this.ents.length; b++) {
      if (this.lost.has(b)) continue;
      if (this.#reattach(b, near)) { this.miss.delete(b); continue; }
      const n = (this.miss.get(b) ?? 0) + 1;
      this.miss.set(b, n);
      if (n === 1) system.runTimeout(() => this.#tick(), 40);
      else missing.push(b);
    }
    if (missing.length || this.lost.size) {
      const back = [];
      for (const ent of this.#everywhere()) {
        const i = ent.getDynamicProperty("i");
        if (!this.#mine(ent, i)) { ent.remove(); continue; }
        if (!this.#own(ent, i)) continue;
        if (this.lost.has(i)) back.push([ent, i]);
        else if (missing.includes(i) && !this.ents[i]?.isValid) { this.#home(ent); if (ent.isValid) { this.ents[i] = ent; this.boxes[i] = boxOf(ent); } }
      }
      for (const b of missing) if (!this.#reattach(b, () => this.#near())) this.#lose(b); else this.miss.delete(b);
      if (!this.miss.size) this.#restore(back);
    }
    this.#strays();
    return this.miss.size === 0;
  }

  #lose(b) {
    this.miss.delete(b);
    const out = s => ((s / boxSize) | 0) === b;
    for (const k of [...this.idx.keys()]) {
      const e = this.idx.get(k);
      if (!e || expand(e.c).some(out) || !expand(e.p).some(out)) continue;
      this.idx.set(k, { m: e.m, c: e.c, f: e.f });
      const rest = expand(e.p).filter(s => !out(s));
      if (rest.length) this.held.push({ at: system.currentTick, slots: rest });
    }
    this.held = this.held.map(h => ({ ...h, slots: h.slots.filter(s => !out(s)) }));
    this.free = this.free.filter(s => !out(s));
    this.#mark(b);
    this.#saveLost();
    this.idx.flush();
  }

  #need() {
    if (!this.isReady) throw new Error(`ShulkerVault "${this.ns}" is not ready; await vault.ready first`);
  }

  #box(s) {
    const b = (s / boxSize) | 0;
    if (this.lost.has(b)) throw new Error(`ShulkerVault "${this.ns}": storage entity ${b} is missing; its records come back if it returns`);
    const box = this.boxes[b];
    if (box && !box.isValid && this.isReady) {
      if (!this.#reattach(b, () => this.dim.getEntities({ type, location: this.at, maxDistance: 2 }))) {
        throw new Error(`ShulkerVault "${this.ns}": storage entity ${b} is not loaded or was removed`);
      }
      return this.boxes[b];
    }
    return box;
  }

  #matches(r, f) {
    if (!r) return false;
    const list = [];
    for (const s of expand(r)) {
      const box = this.boxes[(s / boxSize) | 0];
      if (!box) return false;
      if (!box.isValid) throw new Error(`ShulkerVault "${this.ns}": storage entity ${(s / boxSize) | 0} can't be read right now`);
      list.push(box.getItem(s % boxSize));
    }
    return same(list, f);
  }

  #spawn(i) {
    const old = this.dim.getEntities({ type, location: this.at, maxDistance: 2 })
      .find(x => x.getDynamicProperty("ns") === this.ns && x.getDynamicProperty("i") === i && x.id !== this.ents[i]?.id && this.#mine(x, i));
    if (old) {
      const c = boxOf(old);
      c.clearAll();
      this.ents[i] = old;
      this.#home(old);
      return c;
    }
    if (this.lost.has(i)) throw new Error(`ShulkerVault "${this.ns}": box ${i} is reserved for a missing entity`);
    const e = this.dim.spawnEntity(type, this.at);
    let c;
    try { e.setDynamicProperties({ ns: this.ns, i, g: this.gen.get(i) ?? 0 }); c = boxOf(e); } catch (x) { e.remove(); throw x; }
    this.ents[i] = e;
    this.lil.set(i, 0);
    if (this.isReady) this.#saveLil();
    return c;
  }

  #take(n) {
    while (this.free.length < n) {
      let b = this.boxes.length;
      while (this.lost.has(b)) this.boxes.length = ++b;
      this.boxes.push(this.#spawn(b));
      for (let i = boxSize - 1; i >= 0; i--) this.free.push(b * boxSize + i);
    }
    const got = [];
    for (let i = 0; i < n; i++) got.push(this.free.pop());
    return got.sort((a, b) => a - b);
  }

  #hold(r) {
    if (r) this.held.push({ at: system.currentTick, slots: expand(r) });
  }

  #release() {
    const now = system.currentTick;
    let changed = false;
    if (this.held.length && now - this.held[0].at >= this.quarantine && this.idx.pending) this.idx.flush();
    while (this.held.length && now - this.held[0].at >= this.quarantine) {
      for (const s of this.held.shift().slots) {
        const b = (s / boxSize) | 0;
        if (this.lost.has(b) || !this.boxes[b]) continue;
        this.boxes[b].setItem(s % boxSize);
        this.free.push(s);
      }
      changed = true;
    }
    if (changed) this.free.sort((a, b) => b - a);
  }

  has(k) { this.#need(); return this.idx.has(k); }
  keys() { this.#need(); return this.idx.keys(); }
  get size() { this.#need(); return this.idx.size; }

  set(k, items) {
    if (this.gone) throw new Error(`ShulkerVault "${this.ns}" was disposed`);
    checkKey(k);
    if (!this.isReady) { this.queue.push([1, k, Array.isArray(items) ? items.map(x => x?.clone()) : items?.clone()]); return; }
    const many = Array.isArray(items);
    const list = many ? items : [items];
    const old = this.idx.get(k);
    const slots = this.#take(list.length);
    try {
      for (let i = 0; i < list.length; i++) this.#box(slots[i]).setItem(slots[i] % boxSize, list[i]);
    } catch (e) {
      for (const s of slots) { try { this.#box(s).setItem(s % boxSize); } catch {} this.free.push(s); }
      this.free.sort((x, y) => y - x);
      throw e;
    }
    const c = ranges(slots), f = fpList(list);
    if (old) this.#hold(old.p);
    this.idx.set(k, old ? { m: many ? 1 : 0, c, f, p: old.c, g: old.f, pm: old.m } : { m: many ? 1 : 0, c, f });
  }

  get(k) {
    this.#need();
    const e = this.idx.get(k);
    if (!e) return undefined;
    const out = [];
    for (const s of expand(e.c)) out.push(this.#box(s).getItem(s % boxSize));
    return e.m ? out : out[0];
  }

  delete(k) {
    if (this.gone) throw new Error(`ShulkerVault "${this.ns}" was disposed`);
    if (!this.isReady) { this.queue.push([0, k]); return true; }
    const e = this.idx.get(k);
    if (!e) return false;
    this.#hold(e.c);
    this.#hold(e.p);
    this.idx.delete(k);
    return true;
  }

  flush() { return this.idx.flush(); }

  dispose() {
    if (this.gone) return;
    try { this.idx.flush(); } finally { this.#fail(); }
  }
}
