import { world, system } from "@minecraft/server";
import { ShulkerDB } from "./shulkerdb.js";

const type = "sdb:vault";
const boxSize = 256;
const areas = new Map();

function fpItem(it) {
  return it ? `${it.typeId}*${it.amount}*${it.nameTag ?? ""}` : "-";
}

function fpList(list) {
  let h = 2166136261;
  for (const it of list) {
    const s = fpItem(it);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= 0x7c; h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
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
  return new Promise(done => system.runJob((function* () { done(yield* g); })()));
}

function expand(r) {
  const out = [];
  if (r) for (let i = 0; i < r.length; i += 2) for (let s = r[i]; s < r[i] + r[i + 1]; s++) out.push(s);
  return out;
}

export class ShulkerVault {
  constructor(ns, opt = {}) {
    this.ns = ns;
    this.dim = world.getDimension(opt.dimension ?? "overworld");
    this.at = opt.location ?? { x: 0.5, y: 318, z: 0.5 };
    this.quarantine = opt.quarantineTicks ?? 1200;
    this.idx = new ShulkerDB(`sv_${ns}`, { flushEvery: opt.flushEvery ?? 20 });
    this.boxes = [];
    this.ents = [];
    this.free = [];
    this.queue = [];
    this.isReady = false;
    this.held = [];
    this.stats = { recovered: 0, lost: 0 };
    this.ready = this.#boot();
  }

  async #boot() {
    const at = { x: Math.floor(this.at.x), y: Math.floor(this.at.y), z: Math.floor(this.at.z) };
    this.area = `sdb:${this.dim.id.split(":").pop()}_${at.x >> 4}_${at.z >> 4}`;
    let shared = areas.get(this.area);
    if (!shared) {
      const tam = world.tickingAreaManager;
      shared = { n: 0, loaded: tam.hasTickingArea(this.area) ? Promise.resolve() : tam.createTickingArea(this.area, { dimension: this.dim, from: at, to: at }) };
      areas.set(this.area, shared);
    }
    shared.n++;
    await shared.loaded;
    while (!this.dim.getBlock(at)) await system.waitTicks(1);

    const need = await job(this.#span());
    for (let t = 0; t < 400; t++) {
      const near = t % 20 !== 19;
      for (const ent of this.dim.getEntities(near ? { type, location: this.at, maxDistance: 2 } : { type })) {
        if (ent.getDynamicProperty("ns") === this.ns) this.#adopt(ent, ent.getDynamicProperty("i"));
      }
      let have = 0;
      for (let b = 0; b < need; b++) if (this.boxes[b]) have++;
      if (have >= need) break;
      await system.waitTicks(1);
    }
    if (this.boxes.length < need) this.boxes.length = need;

    const used = new Set();
    const last = await job(this.#verify(used));
    while (this.boxes.length > last) {
      const b = this.boxes.length - 1;
      this.ents[b]?.remove();
      this.ents.length = b;
      this.boxes.length = b;
    }
    await job(this.#fill(used));
    this.isReady = true;
    for (const [op, k, items] of this.queue.splice(0)) op ? this.set(k, items) : this.delete(k);
    this.idx.flush();
    this.timer = system.runInterval(() => { this.#guard(); this.#release(); }, 200);
  }

  *#span() {
    let need = 0;
    for (const k of this.idx.keys()) {
      const e = this.idx.get(k);
      need = Math.max(need, top(e.c), top(e.p));
      yield;
    }
    return need;
  }

  *#verify(used) {
    let last = 0;
    for (const k of [...this.idx.keys()]) {
      const e = this.idx.get(k);
      let keep = null;
      if (this.#matches(e.c, e.f)) keep = [e.c, e.p];
      else if (e.p && this.#matches(e.p, e.g)) {
        this.idx.set(k, { m: e.m, c: e.p, f: e.g });
        keep = [e.p];
        this.stats.recovered++;
      } else {
        this.idx.delete(k);
        this.stats.lost++;
        console.warn(`[ShulkerVault ${this.ns}] record "${k}" does not match stored items, dropped`);
      }
      if (keep) for (const r of keep) { for (const s of expand(r)) used.add(s); last = Math.max(last, top(r)); }
      yield;
    }
    return last;
  }

  *#fill(used) {
    for (let b = this.boxes.length - 1; b >= 0; b--) {
      if (!this.boxes[b]) this.boxes[b] = this.#spawn(b);
      for (let i = boxSize - 1; i >= 0; i--) if (!used.has(b * boxSize + i)) this.free.push(b * boxSize + i);
      yield;
    }
  }

  #adopt(ent, i) {
    const cur = this.ents[i];
    if (cur?.isValid && cur.id !== ent.id) {
      const c = ent.getComponent("inventory").container;
      if (c.emptySlotsCount === c.size) ent.remove();
      return;
    }
    this.ents[i] = ent;
    this.boxes[i] = ent.getComponent("inventory").container;
    this.#home(ent);
  }

  #home(ent) {
    const { x, y, z } = ent.location;
    if (ent.dimension.id !== this.dim.id || Math.abs(x - this.at.x) + Math.abs(y - this.at.y) + Math.abs(z - this.at.z) > 1) ent.teleport(this.at, { dimension: this.dim });
  }

  #guard() {
    for (let b = 0; b < this.ents.length; b++) {
      const ent = this.ents[b];
      if (ent.isValid) { this.#home(ent); continue; }
      let lost = 0;
      for (const k of [...this.idx.keys()]) {
        const e = this.idx.get(k);
        const all = [...expand(e.c), ...expand(e.p)];
        if (!all.some(s => ((s / boxSize) | 0) === b)) continue;
        this.held.push({ at: system.currentTick, slots: all.filter(s => ((s / boxSize) | 0) !== b) });
        this.idx.delete(k); this.stats.lost++; lost++;
      }
      console.warn(`[ShulkerVault ${this.ns}] storage entity ${b} was removed; ${lost} records dropped`);
      this.held = this.held.map(h => ({ ...h, slots: h.slots.filter(s => ((s / boxSize) | 0) !== b) }));
      this.free = this.free.filter(s => ((s / boxSize) | 0) !== b);
      this.boxes[b] = this.#spawn(b);
      for (let i = boxSize - 1; i >= 0; i--) this.free.push(b * boxSize + i);
      this.free.sort((a, b) => b - a);
    }
  }

  #need() {
    if (!this.isReady) throw new Error(`ShulkerVault "${this.ns}" is not ready; await vault.ready first`);
  }

  #box(s) { return this.boxes[(s / boxSize) | 0]; }

  #matches(r, f) {
    if (!r) return false;
    const list = [];
    for (const s of expand(r)) {
      const box = this.#box(s);
      if (!box) return false;
      list.push(box.getItem(s % boxSize));
    }
    return fpList(list) === f;
  }

  #spawn(i) {
    const e = this.dim.spawnEntity(type, this.at);
    e.setDynamicProperties({ ns: this.ns, i });
    this.ents[i] = e;
    return e.getComponent("inventory").container;
  }

  #take(n) {
    while (this.free.length < n) {
      const b = this.boxes.length;
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
    while (this.held.length && now - this.held[0].at >= this.quarantine) {
      for (const s of this.held.shift().slots) { this.#box(s)?.setItem(s % boxSize); this.free.push(s); }
      changed = true;
    }
    if (changed) this.free.sort((a, b) => b - a);
  }

  has(k) { this.#need(); return this.idx.has(k); }
  keys() { this.#need(); return this.idx.keys(); }
  get size() { this.#need(); return this.idx.size; }

  set(k, items) {
    if (!this.isReady) { this.queue.push([1, k, items]); return; }
    const many = Array.isArray(items);
    const list = many ? items : [items];
    const old = this.idx.get(k);
    const slots = this.#take(list.length);
    for (let i = 0; i < list.length; i++) this.#box(slots[i]).setItem(slots[i] % boxSize, list[i]);
    const c = ranges(slots);
    if (old) this.#hold(old.p);
    this.idx.set(k, old ? { m: many ? 1 : 0, c, f: fpList(list), p: old.c, g: old.f } : { m: many ? 1 : 0, c, f: fpList(list) });
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
    if (this.timer !== undefined) system.clearRun(this.timer);
    this.idx.dispose();
    const shared = areas.get(this.area);
    if (shared && --shared.n === 0) {
      areas.delete(this.area);
      if (world.tickingAreaManager.hasTickingArea(this.area)) world.tickingAreaManager.removeTickingArea(this.area);
    }
  }
}
