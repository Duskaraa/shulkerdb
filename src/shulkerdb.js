import { world, system } from "@minecraft/server";

const sep = "\u0001";
const end = "\u0002";
const reserved = /[\u0000-\u0002]/;
const limit = 32000;
const raw = Symbol("raw");
const open = new Map();
export function _reset() { open.clear(); }
export const inner = Symbol("inner");

export function checkKey(k) {
  if (typeof k !== "string" || reserved.test(k) || lone.test(k) || bytes(k) > 512) throw new TypeError("invalid key");
}

const ascii = /^[\x00-\x7f]*$/;
const narrow = /[\x00-\x7f]+/g;
const two = /[\u0080-\u07ff]+/g;
const surr = /[\ud800-\udfff]+/g;
const pair = /[\ud800-\udbff][\udc00-\udfff]/g;
const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function bytes(s) {
  if (ascii.test(s)) return s.length;
  try { return unescape(encodeURIComponent(s)).length; } catch { return slow(s); }
}

function slow(s) {
  const r = s.replace(narrow, "");
  const t = r.length - r.replace(two, "").length;
  const sur = r.length - r.replace(surr, "").length;
  const pairs = sur ? (s.length - s.replace(pair, "").length) / 2 : 0;
  return s.length + t + (r.length - t - sur) * 2 + sur * 2 - pairs * 2;
}

function split(s) {
  const out = [];
  let la = 0;
  while (la < s.length) {
    let n = Math.min(s.length - la, limit), b;
    while ((b = bytes(s.slice(la, la + n))) > limit) n = Math.max(1, Math.floor(n * limit / b) - 1);
    const c = s.charCodeAt(la + n - 1);
    if (n > 1 && c >= 0xd800 && c <= 0xdbff && la + n < s.length) n--;
    out.push(s.slice(la, la + n));
    la += n;
  }
  return out;
}

function rank(k, v, first) {
  const t = k[k.indexOf(sep, 4) + 1];
  if (t === "p") return v === undefined ? 5 : 0;
  if (t === "h") return v === undefined ? 4 : 1;
  return first.has(k) ? 2 : 3;
}

function commit(rec, first, size) {
  const f = first ?? new Set();
  const at = new Map();
  for (const k of f) at.set(k, at.size);
  const ks = Object.keys(rec).map((k, i) => [rank(k, rec[k], f), at.get(k) ?? i, k]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let part = {}, n = 0;
  for (const [, , k] of ks) {
    part[k] = rec[k];
    if (++n === size) { world.setDynamicProperties(part); part = {}; n = 0; }
  }
  if (n) world.setDynamicProperties(part);
  f.clear();
}

export class ShulkerDB {
  constructor(ns, opt = {}) {
    if (typeof ns !== "string" || reserved.test(ns)) throw new TypeError("invalid namespace");
    if (ns.startsWith("sv_") && opt[inner] !== true) throw new TypeError(`namespace "${ns}" is reserved for ShulkerVault`);
    if (open.has(ns)) return open.get(ns);
    this.ns = ns;
    this.pre = `sdb${sep}${ns}${sep}`;
    const cap = opt.bucketSize ?? 12000;
    this.cap = Number.isFinite(cap) ? Math.max(1, Math.min(cap, limit)) : 12000;
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
    this.left = new Map();
    this.redo = new Set();
    this.#load();
    open.set(ns, this);
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
        let head;
        try { head = JSON.parse(str); } catch { head = null; }
        if (!Array.isArray(head) || typeof head[0] !== "string") { console.warn(`[ShulkerDB ${this.ns}] corrupt header "${id}" dropped`); commit({ [id]: undefined }, null, 1); continue; }
        const [k, parts, g = 0] = head;
        let s = "";
        for (let i = 0; i < parts; i++) {
          const p = world.getDynamicProperty(this.#part(k, g, i));
          if (typeof p !== "string") { s = null; break; }
          s += p;
        }
        if (s === null) { console.warn(`[ShulkerDB ${this.ns}] incomplete record "${k}" dropped`); commit({ [id]: undefined }, null, 1); continue; }
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
    if (this.gone) throw new Error(`ShulkerDB "${this.ns}" was disposed`);
    if (!this.vals.has(k)) checkKey(k);
    this.vals.set(k, v);
    this.stale.add(k);
    if (this.big.has(k)) this.bigDirty.add(k);
    else {
      const at = this.home.get(k);
      if (at === undefined) {
        const to = this.#bin(k, this.#len(k)), from = this.left.get(k);
        if (from !== undefined && from !== to) { this.must.add(to); this.first.add(this.#binId(to)); }
      }
      else this.dirty.add(at);
    }
    return this;
  }

  delete(k) {
    if (this.gone) throw new Error(`ShulkerDB "${this.ns}" was disposed`);
    if (!this.vals.has(k)) return false;
    if (this.big.has(k)) { this.#dropBig(k); this.left.set(k, -1); }
    else { this.left.set(k, this.home.get(k)); this.#unbin(k); }
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
    this.stale.delete(k);
    let s;
    try { s = JSON.stringify(this.vals.get(k)); } catch (e) { s = e; }
    if (typeof s !== "string") {
      const old = this.strs.get(k);
      console.warn(`[ShulkerDB ${this.ns}] "${k}" can't be saved as JSON (${s instanceof Error ? s.message : "unsupported value"}), ${old === undefined ? "dropped" : "kept the last saved value"}`);
      if (old !== undefined) this.vals.set(k, raw);
      return old;
    }
    const n = bytes(s) + bytes(k) + 2;
    this.strs.set(k, s); this.lens.set(k, n);
    if (n <= this.cap) this.avg = (this.avg * 7 + Math.min(n, this.avg * 2)) >> 3;
    return s;
  }

  #forget(k) {
    this.vals.delete(k); this.strs.delete(k); this.lens.delete(k); this.stale.delete(k); this.home.delete(k);
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
      const s = this.#str(k);
      if (s === undefined) { bin.keys.delete(k); this.#forget(k); continue; }
      const len = this.#len(k);
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

  #commit(rec, took, tookBig) {
    for (const k of this.redo) if (!(k in rec)) rec[k] = undefined;
    this.redo.clear();
    try { commit(rec, this.first, this.batch); } catch (e) {
      for (const k in rec) if (rec[k] === undefined) this.redo.add(k);
      for (const at of took) this.dirty.add(at);
      for (const k of tookBig) if (this.big.has(k)) this.bigDirty.add(k);
      throw e;
    }
  }

  flush() {
    this.must.clear(); this.mustBig.clear();
    const rec = {}, took = new Set(), tookBig = new Set();
    while (this.dirty.size || this.bigDirty.size) {
      for (const at of this.dirty) { this.dirty.delete(at); took.add(at); this.#write(rec, at); }
      for (const k of this.bigDirty) { this.bigDirty.delete(k); tookBig.add(k); this.#writeBig(rec, k); }
    }
    this.#commit(rec, took, tookBig);
    this.must.clear(); this.mustBig.clear(); this.left.clear();
    return took.size + tookBig.size;
  }

  flushSome() {
    const lag = this.pending;
    if (!lag) { this.left.clear(); return 0; }
    const t = Date.now(), rec = {}, took = new Set(), tookBig = new Set();
    const budget = lag > 64 ? Math.min(this.budget * 4, this.budget + lag / 64) : this.budget;
    for (const at of this.dirty) {
      this.dirty.delete(at); took.add(at); this.#write(rec, at);
      if (Date.now() - t >= budget) break;
    }
    for (const k of this.bigDirty) {
      if (tookBig.size && Date.now() - t >= budget) break;
      this.bigDirty.delete(k); tookBig.add(k); this.#writeBig(rec, k);
    }
    while (this.must.size || this.mustBig.size) {
      for (const at of this.must) { this.must.delete(at); if (this.dirty.delete(at)) { took.add(at); this.#write(rec, at); } }
      for (const k of this.mustBig) { this.mustBig.delete(k); if (this.bigDirty.delete(k)) { tookBig.add(k); this.#writeBig(rec, k); } }
    }
    this.#commit(rec, took, tookBig);
    this.left.clear();
    return took.size + tookBig.size;
  }

  dispose() {
    if (this.gone) return;
    this.gone = true;
    try { this.flush(); } finally {
      if (this.timer !== undefined) system.clearRun(this.timer);
      system.beforeEvents.shutdown.unsubscribe(this.off);
      open.delete(this.ns);
    }
  }
}
