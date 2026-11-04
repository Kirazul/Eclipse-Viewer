import { toWire, type Store } from "./store";
import { log } from "../lib/env";
import { checkObject } from "./check";

/**
 * R2's free tier is a hard rule, so it is enforced here and not hoped for: every byte
 * and every write goes through this store, the running total lives in R2 itself, and an
 * upload past the limit ends the job with a report.
 *
 * It also answers what a job used to ask R2 once per object. `stat` and `list` read an
 * index of what is up there, so `plan` and a rerun cost one GET of `reports/objects.json`
 * and no HEAD and no LIST at all, and "done" is one GET of `reports/records.json`.
 *
 * A matrix of shards cannot share a running total: R2 has no atomic add. So each shard
 * gets its fair part of what is left, keeps its own delta under `reports/shards/`, and
 * `report` folds the deltas in, one at a time, with nothing racing.
 */

/** Below Cloudflare's 10 GB and 1,000,000 Class A, so a surprise still lands inside the tier. */
export const LIMITS = { bytes: 9_000_000_000, classA: 800_000 } as const;

const USAGE_KEY = "reports/usage.json";
const OBJECTS_KEY = "reports/objects.json";
const RECORDS_KEY = "reports/records.json";

export interface Usage {
  /** `2026-11`. Class A and B are per month, storage is not. */
  month: string;
  bytes: number;
  objects: number;
  classA: number;
  classB: number;
  updatedAt: string;
}

export interface KnownObject {
  /** Decoded size, what a manifest talks about. */
  raw: number;
  /** Size in R2, what the storage limit counts. */
  wire: number;
  /** Passed `checkObject` when it was written. */
  ok: boolean;
  /** What a manifest needs without decoding it again: a texture's size and alpha. */
  meta?: unknown;
}

interface ObjectRow {
  k: string;
  r: number;
  w: number;
  o: 0 | 1;
  m?: unknown;
}

/** Where a shard's work goes until `report` folds it in. */
export interface ShardDelta {
  usage: { bytes: number; objects: number; classA: number; classB: number };
  objects: ObjectRow[];
  removed: string[];
  records: { id: string }[];
}

export class BudgetExceeded extends Error {
  constructor(
    readonly what: "storage" | "writes",
    readonly detail: string,
  ) {
    super(`R2 budget: refusing to go past the ${what} limit. ${detail}`);
    this.name = "BudgetExceeded";
  }
}

export interface BudgetOptions {
  limitBytes?: number;
  limitClassA?: number;
  /** A matrix job. Absent: a single run, which writes the totals itself. */
  shard?: { index: number; count: number };
  now?: () => Date;
  /** Local runs write decoded bytes, but count what R2 would store: the projection is the same either way. */
  flushEvery?: number;
}

export function monthOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

function emptyUsage(month: string): Usage {
  return { month, bytes: 0, objects: 0, classA: 0, classB: 0, updatedAt: "" };
}

function toRow(k: string, v: KnownObject): ObjectRow {
  return { k, r: v.raw, w: v.wire, o: v.ok ? 1 : 0, ...(v.meta !== undefined ? { m: v.meta } : {}) };
}

function fromRow(r: ObjectRow): KnownObject {
  return { raw: r.r, wire: r.w, ok: r.o === 1, ...(r.m !== undefined ? { meta: r.m } : {}) };
}

export class BudgetStore implements Store {
  readonly name: string;
  private readonly known = new Map<string, KnownObject>();
  readonly records = new Map<string, { id: string; [k: string]: unknown }>();
  usage: Usage;
  private opened: Promise<void> | null = null;
  private readonly limitBytes: number;
  private readonly limitClassA: number;
  private readonly now: () => Date;
  /** What this process did, on top of `usage` as it was read. */
  private delta = { bytes: 0, objects: 0, classA: 0, classB: 0 };
  private newObjects = new Map<string, KnownObject>();
  private removed = new Set<string>();
  private newRecords = new Map<string, { id: string; [k: string]: unknown }>();
  private dirty = 0;
  /** One overwrite of a key in this process: a rerun's manifest counts one write, not a new object. */
  private readonly shard?: { index: number; count: number };
  private readonly flushEvery: number;
  private allowance = { bytes: 0, classA: 0 };

  constructor(
    readonly inner: Store,
    opts: BudgetOptions = {},
  ) {
    this.name = inner.name;
    this.limitBytes = opts.limitBytes ?? LIMITS.bytes;
    this.limitClassA = opts.limitClassA ?? LIMITS.classA;
    this.shard = opts.shard;
    this.now = opts.now ?? (() => new Date());
    this.flushEvery = opts.flushEvery ?? 400;
    this.usage = emptyUsage(monthOf(this.now()));
  }

  open(): Promise<void> {
    this.opened ??= this.load().catch((e) => {
      this.opened = undefined;
      throw e;
    });
    return this.opened;
  }

  /** Reads the ledger. Each file is one GET, whatever the bucket holds. */
  private async load(): Promise<void> {
    const month = monthOf(this.now());
    const usage = await this.inner.get(USAGE_KEY);
    this.delta.classB++;
    let parsed: Usage | null = null;
    if (usage) {
      parsed = JSON.parse(usage.toString("utf8")) as Usage;
      this.usage = parsed;
      if (this.usage.month !== month) this.usage = { ...this.usage, month, classA: 0, classB: 0 };
    }
    const objects = await this.inner.get(OBJECTS_KEY);
    this.delta.classB++;
    if (objects) {
      for (const r of JSON.parse(objects.toString("utf8")) as ObjectRow[]) this.known.set(r.k, fromRow(r));
    } else {
      await this.seed();
    }
    const records = await this.inner.get(RECORDS_KEY);
    this.delta.classB++;
    if (records) {
      for (const r of JSON.parse(records.toString("utf8")) as { id: string }[]) this.records.set(r.id, r);
    } else {
      await this.seedRecords();
    }
    if (this.inner.name === "local") await this.seedRecords();
    const part = this.shard?.count ?? 1;
    this.allowance = {
      bytes: Math.max(0, this.limitBytes - this.usage.bytes) / part,
      classA: Math.max(0, this.limitClassA - this.usage.classA) / part,
    };
  }

  /**
   * A bucket from before the ledger: one LIST through it, once, and the totals are true.
   * LIST is 1 Class A per 1,000 keys, so even a full bucket costs a few hundred.
   */
  private async seed(): Promise<void> {
    const inner = this.inner as Store & { listSizes?: (prefix: string) => Promise<Map<string, number>> };
    let total = 0;
    if (inner.listSizes) {
      const sizes = await inner.listSizes("");
      this.delta.classA += Math.ceil(sizes.size / 1000) + 1;
      for (const [k, size] of sizes) {
        this.known.set(k, { raw: size, wire: size, ok: true });
        total += size;
      }
    } else {
      for (const k of await this.inner.list("")) {
        const size = (await this.inner.stat(k)) ?? 0;
        this.known.set(k, { raw: size, wire: size, ok: true });
        total += size;
      }
    }
    this.usage.bytes = total;
    this.usage.objects = this.known.size;
    log(`budget: first run on this bucket, seeded ${this.known.size} object(s), ${(total / 1e9).toFixed(3)} GB`);
  }

  private async seedRecords(): Promise<void> {
    const keys = this.inner.name === "local" ? await this.inner.list("records/") : [...this.known.keys()].filter((k) => k.startsWith("records/"));
    for (const k of keys) {
      if (!k.endsWith(".json")) continue;
      if (this.inner.name === "local" && this.records.has(k.slice("records/".length, -".json".length))) continue;
      const b = await this.inner.get(k);
      this.delta.classB++;
      if (b) {
        const r = JSON.parse(b.toString("utf8")) as { id: string };
        this.records.set(r.id, r);
      }
    }
  }

  // --- The store ------------------------------------------------------------

  async stat(key: string): Promise<number | null> {
    await this.open();
    const hit = this.known.get(key)?.raw;
    if (hit !== undefined) return hit;
    // A local folder costs nothing to ask, and other runs on this machine write to it.
    return this.inner.name === "local" ? this.inner.stat(key) : null;
  }

  has(key: string): boolean {
    return this.known.has(key);
  }

  object(key: string): KnownObject | undefined {
    return this.known.get(key);
  }

  async get(key: string): Promise<Buffer | null> {
    await this.open();
    this.delta.classB++;
    return this.inner.get(key);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.open();
    const wire = await toWire(key, body);
    this.charge(key, wire.length);
    const inner = this.inner as Store & { putWire?: (key: string, wire: Uint8Array, raw: number) => Promise<void> };
    if (inner.putWire) await inner.putWire(key, wire, body.length);
    else await inner.put(key, body);
    const old = this.known.get(key);
    const entry: KnownObject = { raw: body.length, wire: wire.length, ok: checkObject(key, body), ...(old?.meta !== undefined ? { meta: old.meta } : {}) };
    this.known.set(key, entry);
    this.newObjects.set(key, entry);
    this.removed.delete(key);
    this.tick();
  }

  /** A fact about an object, kept in the index instead of an object of its own. */
  setMeta(key: string, meta: unknown): void {
    const e = this.known.get(key);
    if (!e) return;
    e.meta = meta;
    this.newObjects.set(key, e);
  }

  /** Refuses before anything is sent. A `force` re-bake overwrites: it adds only what grew. */
  private charge(key: string, wire: number): void {
    const old = this.known.get(key);
    const grow = wire - (old?.wire ?? 0);
    if (this.delta.classA + 1 > this.allowance.classA) {
      throw new BudgetExceeded("writes", `${this.usage.classA + this.delta.classA} Class A this month, this job may add ${Math.floor(this.allowance.classA)}. Limit ${this.limitClassA}.`);
    }
    if (grow > 0 && this.delta.bytes + grow > this.allowance.bytes) {
      throw new BudgetExceeded("storage", `${((this.usage.bytes + this.delta.bytes) / 1e9).toFixed(3)} GB stored, ${key} needs ${grow} more, and this job may add ${Math.floor(this.allowance.bytes)} bytes. Limit ${(this.limitBytes / 1e9).toFixed(1)} GB.`);
    }
    this.delta.classA++;
    this.delta.bytes += grow;
    if (!old) this.delta.objects++;
  }

  /** From the index: no LIST goes to R2. */
  async list(prefix: string): Promise<string[]> {
    await this.open();
    return [...this.known.keys()].filter((k) => k.startsWith(prefix) && !k.endsWith(".tmp")).sort();
  }

  async remove(key: string): Promise<void> {
    await this.open();
    const old = this.known.get(key);
    await this.inner.remove(key);
    if (old) {
      this.delta.bytes -= old.wire;
      this.delta.objects--;
      this.known.delete(key);
      this.newObjects.delete(key);
      this.removed.add(key);
    }
  }

  // --- Records --------------------------------------------------------------

  async record(id: string): Promise<{ id: string; [k: string]: unknown } | null> {
    await this.open();
    return this.records.get(id) ?? null;
  }

  async putRecord(rec: { id: string }): Promise<void> {
    await this.open();
    const r = rec as { id: string; [k: string]: unknown };
    this.records.set(r.id, r);
    this.newRecords.set(r.id, r);
    this.tick();
  }

  // --- The ledger -----------------------------------------------------------

  private tick(): void {
    if (++this.dirty >= this.flushEvery) {
      this.dirty = 0;
      this.flushing = this.flushing.then(() => this.writeOut()).catch((e) => log(`budget: flush failed, will retry: ${(e as Error).message}`));
    }
  }

  private flushing: Promise<void> = Promise.resolve();

  /** The totals as they stand with this process's work added. */
  current(): Usage {
    return {
      month: this.usage.month,
      bytes: this.usage.bytes + this.delta.bytes,
      objects: this.usage.objects + this.delta.objects,
      classA: this.usage.classA + this.delta.classA,
      classB: this.usage.classB + this.delta.classB,
      updatedAt: this.now().toISOString(),
    };
  }

  /** Written by a single run itself; a shard leaves a delta for `report` to fold in. */
  async flush(): Promise<void> {
    await this.open();
    // Chained, never awaited from inside: a periodic write that waited on itself would
    // leave nothing for the process to do but exit, with nothing written and exit code 0.
    this.flushing = this.flushing.then(() => this.writeOut());
    await this.flushing;
  }

  private async writeOut(): Promise<void> {
    if (this.shard) {
      const delta: ShardDelta = {
        usage: { ...this.delta },
        objects: [...this.newObjects].map(([k, v]) => toRow(k, v)),
        removed: [...this.removed],
        records: [...this.newRecords.values()],
      };
      this.delta.classA++;
      await this.writeLedger(`reports/shards/${this.shard.index}.json`, JSON.stringify(delta));
      return;
    }
    await this.writeTotals();
  }

  /**
   * Another run may have written since this one read, and on one machine several do. So
   * what is there is merged in, and the totals come from the index: a count that drifted
   * cannot stay wrong.
   */
  private async writeTotals(): Promise<void> {
    const there = await this.inner.get(OBJECTS_KEY);
    this.delta.classB += 3;
    if (there) {
      for (const r of JSON.parse(there.toString("utf8")) as ObjectRow[]) {
        if (!this.known.has(r.k) && !this.removed.has(r.k)) this.known.set(r.k, fromRow(r));
      }
    }
    const recs = await this.inner.get(RECORDS_KEY);
    if (recs) {
      for (const r of JSON.parse(recs.toString("utf8")) as { id: string; [k: string]: unknown }[]) {
        if (!this.newRecords.has(r.id)) this.records.set(r.id, r);
      }
    }
    const was = await this.inner.get(USAGE_KEY);
    const month = monthOf(this.now());
    const thereUsage = was ? (JSON.parse(was.toString("utf8")) as Usage) : null;
    const sameMonth = thereUsage?.month === month;
    this.delta.classA += 3;
    let bytes = 0;
    for (const v of this.known.values()) bytes += v.wire;
    const usage: Usage = {
      month,
      bytes,
      objects: this.known.size,
      // This process's writes on top of the most anyone has recorded this month.
      classA: Math.max(sameMonth ? thereUsage!.classA : 0, this.usage.classA) + this.delta.classA - this.flushedA,
      classB: Math.max(sameMonth ? thereUsage!.classB : 0, this.usage.classB) + this.delta.classB - this.flushedB,
      updatedAt: this.now().toISOString(),
    };
    this.flushedA = this.delta.classA;
    this.flushedB = this.delta.classB;
    this.usage = { ...usage, classA: usage.classA - this.delta.classA, classB: usage.classB - this.delta.classB, bytes: bytes - this.delta.bytes, objects: usage.objects - this.delta.objects };
    await this.writeLedger(OBJECTS_KEY, JSON.stringify([...this.known].map(([k, v]) => toRow(k, v))));
    await this.writeLedger(RECORDS_KEY, JSON.stringify([...this.records.values()]));
    await this.writeLedger(USAGE_KEY, JSON.stringify(usage, null, 1));
  }

  private flushedA = 0;
  private flushedB = 0;

  /** The ledger's own files: outside the index, or it would count itself forever. */
  private async writeLedger(key: string, body: string): Promise<void> {
    const inner = this.inner as Store & { putWire?: (key: string, wire: Uint8Array, raw: number) => Promise<void> };
    const bytes = Buffer.from(body);
    if (inner.putWire) await inner.putWire(key, await toWire(key, bytes), bytes.length);
    else await inner.put(key, bytes);
  }

  /** `report`: folds each shard's delta in. One GET per shard, then the deltas go. */
  async foldShards(count: number): Promise<number> {
    await this.open();
    let folded = 0;
    for (let i = 0; i < count; i++) {
      const key = `reports/shards/${i}.json`;
      const b = await this.inner.get(key);
      this.delta.classB++;
      if (!b) continue;
      const d = JSON.parse(b.toString("utf8")) as ShardDelta;
      for (const r of d.objects) this.known.set(r.k, fromRow(r));
      for (const k of d.removed) this.known.delete(k);
      for (const r of d.records as { id: string; [k: string]: unknown }[]) this.records.set(r.id, r);
      this.delta.bytes += d.usage.bytes;
      this.delta.objects += d.usage.objects;
      this.delta.classA += d.usage.classA;
      this.delta.classB += d.usage.classB;
      await this.inner.remove(key);
      folded++;
    }
    return folded;
  }

  /** Before a job starts: what this much more would do to the month. */
  wouldFit(bytes: number, writes: number): { fits: boolean; bytes: number; classA: number } {
    const u = this.current();
    return { fits: u.bytes + bytes <= this.limitBytes && u.classA + writes <= this.limitClassA, bytes: u.bytes + bytes, classA: u.classA + writes };
  }
}


