import { world, system } from "@minecraft/server";

const sep = "\u0001";
const end = "\u0002";
const reserved = /[\u0001\u0002]/;
const limit = 32000;
const raw = Symbol("raw");

function bytes(s) {
  const n = s.length;
  if (n * 3 <= limit) {
    let b = n;
    for (let i = 0; i < n; i++) { const c = s.charCodeAt(i); if (c > 0x7f) b += c > 0x7ff && (c < 0xd800 || c > 0xdfff) ? 2 : 1; }
    return b;
  }
  let b = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    b += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3;
  }
  return b;
}

function split(s) {
  const out = [];
  let la = 0, b = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const w = c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : c >= 0xdc00 && c <= 0xdfff ? 0 : 3;
    if (b + w > limit) { out.push(s.slice(la, i)); la = i; b = 0; }
    b += w;
    if (w === 4) i++;
  }
  out.push(s.slice(la));
  return out;
}

function commit(rec, first, size) {
  let part = {}, n = 0;
  const put = (k) => {
    part[k] = rec[k];
    if (++n === size) { world.setDynamicProperties(part); part = {}; n = 0; }
  };
  if (first?.size) {
    for (const k of first) if (k in rec) put(k);
    for (const k in rec) if (!first.has(k)) put(k);
    first.clear();
  } else for (const k in rec) put(k);
  if (n) world.setDynamicProperties(part);
}

export class ShulkerDB {
  constructor(ns, opt = {}) {
    if (typeof ns !== "string" || reserved.test(ns)) throw new TypeError("invalid namespace");
    this.ns = ns;
    this.pre = `sdb${sep}${ns}${sep}`;
    this.cap = Math.min(opt.bucketSize ?? 12000, limit);
    this.budget = opt.budgetMs ?? 3;
    this.batch = opt.batchSize ?? 256;
    this.vals = new Map();
    this.strs = new Map();
    this.lens = new Map();
    this.stale = new Set();
    this.home = new Map();
    this.bins = [];
    this.big = new Map();
    this.avg = 64;
    this.dirty = new Set();
    this.bigDirty = new Set();
    this.must = new Set();
    this.mustBig = new Set();
    this.first = new Set();
    this.#load();
    const every = opt.flushEvery ?? 20;
    if (every > 0) this.timer = system.runInterval(() => this.flushSome(), every);
    this.off = system.beforeEvents.shutdown.subscribe(() => this.flush());
  }

  #load() {
    const pre = this.pre, n = pre.length;
    const lila = [];
    for (const id of world.getDynamicPropertyIds()) {
      if (!id.startsWith(pre)) continue;
      const tag = id[n], rest = id.slice(n + 1);
      if (tag === "p") { lila.push(id); continue; }
      const str = world.getDynamicProperty(id);
      if (typeof str !== "string") continue;
      if (tag === "b") {
        const at = parseInt(rest, 36);
        const bin = (this.bins[at] = { keys: new Set(), size: str.length, est: true });
        let i = 0;
        while (i < str.length) {
          let j = str.indexOf(end, i);
          if (j < 0) j = str.length;
          const a = str.indexOf(sep, i);
          const k = str.slice(i, a), s = str.slice(a + 1, j);
          i = j + 1;
          if (this.vals.has(k)) { this.dirty.add(at); continue; }
          this.vals.set(k, raw); this.strs.set(k, s); this.home.set(k, at);
          bin.keys.add(k);
        }
      } else if (tag === "h") {
        const [k, parts, g = 0] = JSON.parse(str);
        let s = "";
        for (let i = 0; i < parts; i++) {
          const p = world.getDynamicProperty(this.#part(k, g, i));
          if (typeof p !== "string") { s = null; break; }
          s += p;
        }
        if (s === null) { console.warn(`[ShulkerDB ${this.ns}] incomplete record "${k}" dropped`); continue; }
        if (this.home.has(k)) { const at = this.home.get(k); this.bins[at].keys.delete(k); this.dirty.add(at); this.home.delete(k); }
        this.vals.set(k, raw); this.strs.set(k, s); this.big.set(k, { n: parts, g });
      }
    }
    const orphans = {};
    for (const id of lila) {
      const [k, g, i] = id.slice(n + 1).split(sep);
      const b = this.big.get(k);
      if (!b || b.g !== +g || !(+i < b.n)) orphans[id] = undefined;
    }
    commit(orphans, null, this.batch);
    for (let i = 0; i < this.bins.length; i++) this.bins[i] ??= { keys: new Set(), size: 0 };
    this.open = this.bins.findIndex(b => b.size < this.cap * 0.75);
  }

  get size() { return this.vals.size; }
  get pending() { return this.dirty.size + this.bigDirty.size; }
  has(k) { return this.vals.has(k); }
  keys() { return this.vals.keys(); }
  *entries() { for (const k of this.vals.keys()) yield [k, this.get(k)]; }

  get(k) {
    let v = this.vals.get(k);
    if (v === raw) {
      try { v = JSON.parse(this.strs.get(k)); }
      catch { console.warn(`[ShulkerDB ${this.ns}] corrupt record "${k}" dropped`); this.delete(k); return undefined; }
      this.vals.set(k, v);
    }
    return v;
  }

  set(k, v) {
    if (v === undefined) { this.delete(k); return this; }
    if (!this.vals.has(k) && (typeof k !== "string" || reserved.test(k) || bytes(k) > 512)) throw new TypeError("invalid key");
    this.vals.set(k, v);
    this.stale.add(k);
    if (this.big.has(k)) this.bigDirty.add(k);
    else {
      const at = this.home.get(k);
      if (at === undefined) this.#bin(k, this.#len(k));
      else this.dirty.add(at);
    }
    return this;
  }

  delete(k) {
    if (!this.vals.has(k)) return false;
    if (this.big.has(k)) this.#dropBig(k);
    else this.#unbin(k);
    this.vals.delete(k); this.strs.delete(k); this.lens.delete(k); this.stale.delete(k);
    return true;
  }

  clear() { for (const k of [...this.vals.keys()]) this.delete(k); this.flush(); }

  #len(k) {
    let n = this.lens.get(k);
    if (n === undefined) {
      const s = this.strs.get(k);
      n = (s === undefined ? this.avg : bytes(s)) + bytes(k) + 2;
      if (s !== undefined) this.lens.set(k, n);
    }
    return n;
  }

  #bin(k, len) {
    let at = this.open;
    if (at < 0 || !this.#fits(at, len)) {
      at = this.bins.findIndex((b, i) => b.size + len <= this.cap && this.#fits(i, len));
      if (at < 0) { at = this.bins.length; this.bins.push({ keys: new Set(), size: 0 }); }
      this.open = at;
    }
    const bin = this.bins[at];
    bin.keys.add(k); bin.size += len;
    this.home.set(k, at); this.dirty.add(at);
    return at;
  }

  #fits(at, len) {
    const bin = this.bins[at];
    if (bin.est) {
      let size = 0;
      for (const k of bin.keys) size += this.#len(k);
      bin.size = size; bin.est = false;
    }
    return bin.size + len <= this.cap;
  }

  #unbin(k) {
    const at = this.home.get(k);
    if (at === undefined) return;
    const bin = this.bins[at];
    bin.keys.delete(k);
    bin.size -= this.#len(k);
    this.home.delete(k); this.dirty.add(at);
    if (bin.size < this.cap * 0.5 && (this.open < 0 || at < this.open)) this.open = at;
  }

  #str(k) {
    if (!this.stale.has(k)) return this.strs.get(k);
    const s = JSON.stringify(this.vals.get(k));
    const n = bytes(s) + bytes(k) + 2;
    this.strs.set(k, s); this.lens.set(k, n); this.stale.delete(k);
    this.avg = (this.avg * 7 + n) >> 3;
    return s;
  }

  #binId(at) { return `${this.pre}b${at.toString(36)}`; }

  #part(k, g, i) { return `${this.pre}p${k}${sep}${g}${sep}${i}`; }

  #toBig(k) { this.big.set(k, { n: 0, g: 0 }); this.bigDirty.add(k); this.mustBig.add(k); this.first.add(`${this.pre}h${k}`); }

  #moveToBin(k) {
    const to = this.#bin(k, this.#len(k));
    this.must.add(to); this.first.add(this.#binId(to));
  }

  #dropBig(k, rec) {
    const { n, g } = this.big.get(k);
    const out = rec ?? {};
    out[`${this.pre}h${k}`] = undefined;
    for (let i = 0; i < n; i++) out[this.#part(k, g, i)] = undefined;
    if (!rec) commit(out, null, this.batch);
    this.big.delete(k); this.bigDirty.delete(k);
  }

  #write(rec, at) {
    const bin = this.bins[at];
    let out = "", size = 0, spill = null;
    for (const k of bin.keys) {
      if (!this.vals.has(k)) { bin.keys.delete(k); if (this.home.get(k) === at) this.home.delete(k); continue; }
      const s = this.#str(k), len = this.#len(k);
      if (len > this.cap) { bin.keys.delete(k); this.home.delete(k); this.#toBig(k); continue; }
      if (size + len > limit) { (spill ??= []).push(k); continue; }
      out += (out ? end : "") + k + sep + s;
      size += len;
    }
    bin.size = size; bin.est = false;
    rec[this.#binId(at)] = out || undefined;
    if (spill) for (const k of spill) { bin.keys.delete(k); this.home.delete(k); this.#moveToBin(k); }
  }

  #writeBig(rec, k) {
    const s = this.#str(k);
    const old = this.big.get(k);
    if (this.#len(k) <= this.cap) { this.#dropBig(k, rec); this.#moveToBin(k); return; }
    const parts = split(s), g = old.g + 1, h = `${this.pre}h${k}`;
    const lead = this.first.has(h);
    for (let i = 0; i < parts.length; i++) {
      const id = this.#part(k, g, i);
      rec[id] = parts[i];
      if (lead) this.first.add(id);
    }
    if (this.first.delete(h)) this.first.add(h);
    rec[h] = JSON.stringify([k, parts.length, g]);
    for (let i = 0; i < old.n; i++) rec[this.#part(k, old.g, i)] = undefined;
    this.big.set(k, { n: parts.length, g });
  }

  flush() {
    let n = 0;
    this.must.clear(); this.mustBig.clear();
    while (this.dirty.size || this.bigDirty.size) {
      const rec = {};
      for (const at of this.dirty) { this.dirty.delete(at); this.#write(rec, at); n++; }
      for (const k of this.bigDirty) { this.bigDirty.delete(k); this.#writeBig(rec, k); n++; }
      commit(rec, this.first, this.batch);
    }
    return n;
  }

  flushSome() {
    const lag = this.pending;
    if (!lag) return 0;
    const t = Date.now(), rec = {};
    const budget = lag > 64 ? Math.min(this.budget * 4, this.budget + lag / 64) : this.budget;
    let n = 0;
    for (const at of this.dirty) {
      this.dirty.delete(at); this.#write(rec, at); n++;
      if (Date.now() - t >= budget) break;
    }
    for (const k of this.bigDirty) {
      if (Date.now() - t >= budget) break;
      this.bigDirty.delete(k); this.#writeBig(rec, k); n++;
    }
    while (this.must.size || this.mustBig.size) {
      for (const at of this.must) { this.must.delete(at); if (this.dirty.delete(at)) { this.#write(rec, at); n++; } }
      for (const k of this.mustBig) { this.mustBig.delete(k); if (this.bigDirty.delete(k)) { this.#writeBig(rec, k); n++; } }
    }
    commit(rec, this.first, this.batch);
    return n;
  }

  dispose() {
    this.flush();
    if (this.timer !== undefined) system.clearRun(this.timer);
    system.beforeEvents.shutdown.unsubscribe(this.off);
  }
}
