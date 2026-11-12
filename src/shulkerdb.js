import { world, system } from "@minecraft/server";

const sep = "\u0001";
const end = "\u0002";
const reserved = /[\u0000-\u0002]/;
const limit = 32000;
const S = 32768;
const raw = Symbol("raw");
const open = new Map();
export function _reset() { open.clear(); }
export const inner = Symbol("inner");

export function checkKey(k) {
  if (typeof k !== "string" || reserved.test(k) || (!ascii.test(k) && lone.test(k)) || (k.length > 170 && bytes(k) > 512)) throw new TypeError("invalid key");
}

const ascii = /^[\x00-\x7f]*$/;
const narrow = /[\x00-\x7f]+/g;
const two = /[\u0080-߿]+/g;
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

function commit(rec, first, size, deps) {
  const f = first ?? new Set();
  const at = new Map();
  let pos = 0;
  const go = k => {
    if (at.has(k)) return;
    at.set(k, -1);
    const d = deps?.get(k);
    if (d) for (const x of d) if (f.has(x)) go(x);
    at.set(k, pos++);
  };
  for (const k of f) go(k);
  const ks = Object.keys(rec).map((k, i) => [rank(k, rec[k], f), at.get(k) ?? i, k]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let part = {}, n = 0;
  for (const [, , k] of ks) {
    part[k] = rec[k];
    if (++n === size) { world.setDynamicProperties(part); part = {}; n = 0; }
  }
  if (n) world.setDynamicProperties(part);
  f.clear();
  deps?.clear();
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
    this.deps = new Map();
    this.src = new Set();
    this.#load();
    open.set(ns, this);
    const every = opt.flushEvery ?? 20;
    if (every > 0) this.timer = system.runInterval(() => this.flushSome(), every);
    this.off = system.beforeEvents.shutdown.subscribe(() => this.flush());
  }

  #load() {
    const pre = this.pre, n = pre.length, home = this.home, bins = this.bins;
    const lila = [], dups = [];
    let total = 0;
    for (const id of world.getDynamicPropertyIds()) {
      if (!id.startsWith(pre)) continue;
      const tag = id[n], rest = id.slice(n + 1);
      if (tag === "p") { lila.push(id); continue; }
      const str = world.getDynamicProperty(id);
      if (typeof str !== "string") continue;
      if (tag === "b") {
        const at = parseInt(rest, 36), base = at * S;
        let bin;
        if (str[0] === end) {
          const i = str.indexOf(end, 1);
          if (i < 0) { bin = { ks: [], vs: [], raw: null, size: 0, gap: 0 }; console.warn(`[ShulkerDB ${this.ns}] corrupt bucket "${id}" dropped`); this.dirty.add(at); }
          else bin = { ks: str.slice(1, i).split(sep), vs: null, raw: str.slice(i + 1), size: str.length, gap: 0 };
        } else {
          const m = this.#legacy(str);
          bin = { ks: [...m.keys()], vs: [...m.values()], raw: null, size: str.length, gap: 0 };
          this.dirty.add(at);
        }
        bins[at] = bin;
        const ks = bin.ks;
        for (let i = 0; i < ks.length; i++) {
          const c = home.size;
          home.set(ks[i], base + i);
          if (home.size === c) dups.push(at, i);
        }
        total += str.length;
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
        this.big.set(k, { n: parts, g, s, v: raw });
      }
    }
    for (let d = 0; d < dups.length; d += 2) {
      const at = dups[d], i = dups[d + 1], bin = bins[at], k = bin.ks[i];
      bin.ks[i] = null; bin.gap++; this.dirty.add(at);
      for (let j = 0; j < bins.length; j++) {
        const x = bins[j] ? bins[j].ks.indexOf(k) : -1;
        if (x >= 0) { home.set(k, j * S + x); break; }
      }
    }
    for (const k of this.big.keys()) { const h = home.get(k); if (h !== undefined) this.#out(h, k); }
    const orphans = {};
    for (const id of lila) {
      const [k, g, i] = id.slice(n + 1).split(sep);
      const b = this.big.get(k);
      if (!b || b.g !== +g || !(+i < b.n)) orphans[id] = undefined;
    }
    commit(orphans, null, this.batch);
    for (let i = 0; i < bins.length; i++) bins[i] ??= { ks: [], vs: [], raw: null, size: 0, gap: 0 };
    if (home.size) this.avg = Math.max(8, Math.ceil(total / home.size));
    this.open = bins.findIndex(b => b.size < this.cap * 0.75);
  }

  #legacy(str) {
    const m = new Map();
    let i = 0;
    while (i < str.length) {
      let j = str.indexOf(end, i);
      if (j < 0) j = str.length;
      const a = str.indexOf(sep, i);
      const k = str.slice(i, a), s = str.slice(a + 1, j);
      i = j + 1;
      if (m.has(k)) continue;
      try { m.set(k, JSON.parse(s)); } catch { console.warn(`[ShulkerDB ${this.ns}] corrupt record "${k}" dropped`); }
    }
    return m;
  }

  #wake(at) {
    const bin = this.bins[at];
    if (bin.vs) return bin;
    let vs = null;
    try { vs = JSON.parse(bin.raw); } catch {}
    bin.raw = null;
    if (!Array.isArray(vs) || vs.length !== bin.ks.length) {
      console.warn(`[ShulkerDB ${this.ns}] corrupt bucket "${this.#binId(at)}" dropped`);
      bin.ks.forEach((k, i) => { if (k !== null && this.home.get(k) === at * S + i) this.home.delete(k); });
      bin.ks = []; bin.vs = []; bin.gap = 0;
      this.dirty.add(at);
      return bin;
    }
    bin.vs = vs;
    return bin;
  }

  #pack(at) {
    const bin = this.#wake(at), ks = bin.ks, vs = bin.vs, base = at * S;
    let j = 0;
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i];
      if (k === null) continue;
      if (i !== j) { ks[j] = k; vs[j] = vs[i]; this.home.set(k, base + j); }
      j++;
    }
    ks.length = vs.length = j;
    bin.gap = 0;
    return bin;
  }

  get size() { return this.home.size + this.big.size; }
  get pending() { return this.dirty.size + this.bigDirty.size; }
  has(k) { return this.home.has(k) || this.big.has(k); }
  *keys() { yield* this.home.keys(); yield* this.big.keys(); }
  *entries() { for (const k of this.keys()) yield [k, this.get(k)]; }

  get(k) {
    const h = this.home.get(k);
    if (h !== undefined) { const at = (h / S) | 0; return (this.bins[at].vs ?? this.#wake(at).vs)[h - at * S]; }
    const b = this.big.get(k);
    if (b === undefined) return undefined;
    if (b.v === raw) {
      try { b.v = JSON.parse(b.s); }
      catch { console.warn(`[ShulkerDB ${this.ns}] corrupt record "${k}" dropped`); this.delete(k); return undefined; }
    }
    return b.v;
  }

  set(k, v) {
    if (v === undefined) { this.delete(k); return this; }
    if (this.gone) throw new Error(`ShulkerDB "${this.ns}" was disposed`);
    const h = this.home.get(k);
    if (h !== undefined) {
      const at = (h / S) | 0, bin = this.#wake(at);
      if (this.home.get(k) === h) {
        bin.vs[h - at * S] = v; this.#odd(bin, v); this.dirty.add(at);
        return this;
      }
    }
    const b = this.big.get(k);
    if (b !== undefined) { b.v = v; b.done = undefined; this.bigDirty.add(k); return this; }
    checkKey(k);
    const from = this.left.get(k);
    if (from >= 0) this.src.add(from);
    const to = this.#bin(k, v, Math.min(this.avg, this.cap));
    if (from !== undefined && from !== to) {
      this.must.add(to); this.first.add(this.#binId(to));
      if (from >= 0) this.#dep(to, from);
    }
    return this;
  }

  delete(k) {
    if (this.gone) throw new Error(`ShulkerDB "${this.ns}" was disposed`);
    const h = this.home.get(k);
    if (h !== undefined) {
      const at = this.#out(h, k), bin = this.bins[at];
      this.left.set(k, at);
      bin.size = Math.max(0, bin.size - this.avg);
      if (bin.size < this.cap * 0.5 && (this.open < 0 || at < this.open)) this.open = at;
      return true;
    }
    if (!this.big.has(k)) return false;
    this.#dropBig(k);
    this.left.set(k, -1);
    return true;
  }

  clear() { for (const k of [...this.keys()]) this.delete(k); this.flush(); }

  #odd(bin, v) {
    const t = typeof v;
    if (t === "function" || t === "symbol" || t === "bigint" || (t === "object" && v !== null && typeof v.toJSON === "function")) bin.odd = true;
  }

  #out(h, k) {
    const at = (h / S) | 0, i = h - at * S, bin = this.bins[at];
    bin.ks[i] = null;
    if (bin.vs) bin.vs[i] = undefined;
    bin.gap++;
    this.home.delete(k); this.dirty.add(at);
    return at;
  }

  #bin(k, v, len) {
    let at = this.open;
    const src = this.src;
    if (at < 0 || src.has(at) || this.bins[at].size + len > this.cap) {
      at = this.bins.findIndex((b, i) => b.size + len <= this.cap && !src.has(i));
      if (at < 0) { at = this.bins.length; this.bins.push({ ks: [], vs: [], raw: null, size: 0, gap: 0 }); }
      this.open = at;
    }
    let bin = this.#wake(at);
    if (bin.ks.length >= S - 1) bin = this.#pack(at);
    const i = bin.ks.push(k) - 1;
    (bin.fresh ??= new Set()).add(k);
    bin.vs.push(v); this.#odd(bin, v);
    bin.size += len;
    this.home.set(k, at * S + i); this.dirty.add(at);
    return at;
  }

  #binId(at) { return `${this.pre}b${at.toString(36)}`; }

  #part(k, g, i) { return `${this.pre}p${k}${sep}${g}${sep}${i}`; }

  #gen(k) {
    try { return JSON.parse(world.getDynamicProperty(`${this.pre}h${k}`))[2] ?? 0; } catch { return 0; }
  }

  #moveToBin(k, v, len) {
    const to = this.#bin(k, v, len);
    this.must.add(to); this.first.add(this.#binId(to));
    return to;
  }

  #dep(to, from) {
    const a = this.#binId(from);
    let d = this.deps.get(a);
    if (!d) this.deps.set(a, (d = new Set()));
    d.add(this.#binId(to));
  }

  #dropBig(k, rec) {
    const { n, g } = this.big.get(k);
    const out = rec ?? {};
    out[`${this.pre}h${k}`] = undefined;
    for (let i = 0; i < n; i++) out[this.#part(k, g, i)] = undefined;
    if (!rec) try { commit(out, null, this.batch); } catch (e) { this.bigDirty.add(k); this.mustBig.add(k); throw e; }
    this.big.delete(k); this.bigDirty.delete(k);
  }

  #disk(at) {
    const str = world.getDynamicProperty(this.#binId(at));
    if (typeof str !== "string") return null;
    if (str[0] !== end) return this.#legacy(str);
    const i = str.indexOf(end, 1);
    try { const ks = str.slice(1, i).split(sep), vs = JSON.parse(str.slice(i + 1)); return new Map(ks.map((k, j) => [k, vs[j]])); } catch { return null; }
  }

  #write(rec, at) {
    let bin = this.#wake(at);
    if (bin.gap) bin = this.#pack(at);
    let ks = null, out = null, size = Infinity;
    if (bin.ks.length && !bin.odd) try { out = JSON.stringify(bin.vs); ks = bin.ks.join(sep); if (out.length + ks.length < limit) size = bytes(ks) + bytes(out) + 2; } catch {}
    if (bin.ks.length && size > limit) { [ks, out] = this.#trim(at); size = bytes(ks) + bytes(out) + 2; }
    const c = bin.ks.length;
    if (!c) { bin.size = 0; rec[this.#binId(at)] = undefined; return; }
    bin.size = size;
    this.avg = Math.max(8, (this.avg * 7 + Math.min(size / c, this.avg * 2)) >> 3);
    rec[this.#binId(at)] = end + ks + end + out;
  }

  #trim(at) {
    const bin = this.bins[at], K = bin.ks.slice(), V = bin.vs, base = at * S, ks = [], vs = [];
    let size = 4, disk, spill = null;
    bin.odd = false;
    for (let i = 0; i < K.length; i++) {
      const k = K[i];
      let s;
      try { s = JSON.stringify(V[i]); } catch (e) { s = e; }
      if (typeof s !== "string") {
        disk ??= this.#disk(at) ?? new Map();
        const kept = disk.has(k) && !bin.fresh?.has(k);
        console.warn(`[ShulkerDB ${this.ns}] "${k}" can't be saved as JSON (${s instanceof Error ? s.message : "unsupported value"}), ${kept ? "kept the last saved value" : "dropped"}`);
        if (!kept) { this.#out(base + i, k); continue; }
        V[i] = disk.get(k);
        s = JSON.stringify(V[i]);
      }
      const len = bytes(s) + bytes(k) + 2;
      if (len > this.cap || len > limit - 4) {
        const w = V[i];
        this.#out(base + i, k);
        this.big.set(k, { n: 0, g: this.redo.size ? this.#gen(k) : 0, v: w, s: undefined, done: s });
        this.bigDirty.add(k); this.mustBig.add(k); this.first.add(`${this.pre}h${k}`);
        continue;
      }
      if (size + len > limit) { (spill ??= []).push(i, len); continue; }
      ks.push(k); vs.push(s);
      size += len;
    }
    if (spill) {
      bin.size = size;
      this.src.add(at);
      for (let j = 0; j < spill.length; j += 2) {
        const i = spill[j], k = K[i], v = V[i];
        this.#out(base + i, k);
        this.#dep(this.#moveToBin(k, v, spill[j + 1]), at);
      }
    }
    this.#pack(at);
    return [ks.join(sep), "[" + vs.join(",") + "]"];
  }

  #writeBig(rec, k) {
    const b = this.big.get(k);
    let s = b.s;
    if (b.done !== undefined) { s = b.done; b.done = undefined; }
    else if (b.v !== raw) {
      try { s = JSON.stringify(b.v); } catch (e) { s = e; }
      if (typeof s !== "string") {
        console.warn(`[ShulkerDB ${this.ns}] "${k}" can't be saved as JSON (${s instanceof Error ? s.message : "unsupported value"}), ${b.s === undefined ? "dropped" : "kept the last saved value"}`);
        if (b.s === undefined) this.#dropBig(k, rec);
        else b.v = raw;
        return;
      }
    }
    const len = bytes(s) + bytes(k) + 2;
    if (len <= this.cap && len <= limit - 4) { const v = b.v === raw ? JSON.parse(s) : b.v; this.#dropBig(k, rec); this.#moveToBin(k, v, len); return; }
    const parts = split(s), g = b.g + 1, h = `${this.pre}h${k}`;
    const lead = this.first.has(h);
    for (let i = 0; i < parts.length; i++) {
      const id = this.#part(k, g, i);
      rec[id] = parts[i];
      if (lead) this.first.add(id);
    }
    if (this.first.delete(h)) this.first.add(h);
    rec[h] = JSON.stringify([k, parts.length, g]);
    for (let i = 0; i < b.n; i++) rec[this.#part(k, b.g, i)] = undefined;
    b.n = parts.length; b.g = g; b.s = s;
  }

  #commit(rec, took, tookBig) {
    for (const k of this.redo) if (!(k in rec)) rec[k] = undefined;
    this.redo.clear();
    try { commit(rec, this.first, this.batch, this.deps); this.src.clear(); for (const at of took) this.bins[at].fresh = null; } catch (e) {
      for (const k in rec) if (rec[k] === undefined) this.redo.add(k);
      for (const at of took) { this.dirty.add(at); this.must.add(at); }
      for (const k of tookBig) if (this.big.has(k)) { this.bigDirty.add(k); this.mustBig.add(k); }
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
