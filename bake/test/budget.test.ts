import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BakeContext, type BakeRecord, isUpToDate, readRecord, writeRecord } from "../src/bake/context";
import { Db2 } from "../src/db2/db2";
import { BudgetExceeded, BudgetStore, LIMITS, monthOf } from "../src/store/budget";
import { checkGlb, checkKtx2, checkObject, checkWebp } from "../src/store/check";
import type { Store } from "../src/store/store";

/** A store that counts what reaches R2, which is the whole point of the budget store. */
class CountingStore implements Store {
  readonly name = "r2";
  readonly data = new Map<string, Uint8Array>();
  heads = 0;
  lists = 0;
  puts = 0;
  gets = 0;

  async stat(key: string): Promise<number | null> {
    this.heads++;
    return this.data.get(key)?.length ?? null;
  }
  async get(key: string): Promise<Buffer | null> {
    this.gets++;
    const b = this.data.get(key);
    return b ? Buffer.from(b) : null;
  }
  async put(key: string, body: Uint8Array): Promise<void> {
    this.puts++;
    this.data.set(key, body);
  }
  async list(prefix: string): Promise<string[]> {
    this.lists++;
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}

const NOT_COMPRESSED = "objects/a.ktx2";
const bytes = (n: number) => new Uint8Array(n).fill(7);
const dir = () => mkdtempSync(join(tmpdir(), "budget-"));

let root = "";
beforeEach(() => {
  root = dir();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the budget guard", () => {
  it("refuses an upload past the storage limit, before sending it", async () => {
    const inner = new CountingStore();
    const store = new BudgetStore(inner, { limitBytes: 1000 });
    await store.put("objects/1.bin", bytes(900));
    await expect(store.put("objects/2.bin", bytes(200))).rejects.toBeInstanceOf(BudgetExceeded);
    expect(inner.data.has("objects/2.bin")).toBe(false);
    expect(store.current().bytes).toBe(900);
  });

  it("refuses past the monthly Class A limit", async () => {
    const inner = new CountingStore();
    const store = new BudgetStore(inner, { limitClassA: 3 });
    await store.put("objects/1.bin", bytes(1));
    await store.put("objects/2.bin", bytes(1));
    await expect(store.put("objects/3.bin", bytes(1))).resolves.toBeUndefined();
    await expect(store.put("objects/4.bin", bytes(1))).rejects.toMatchObject({ what: "writes" });
  });

  it("a force re-bake overwrites and does not count the bytes twice", async () => {
    const store = new BudgetStore(new CountingStore());
    await store.put(NOT_COMPRESSED, bytes(500));
    const once = store.current();
    await store.put(NOT_COMPRESSED, bytes(500));
    const twice = store.current();
    expect(twice.bytes).toBe(once.bytes);
    expect(twice.objects).toBe(once.objects);
    expect(twice.classA).toBe(once.classA + 1);
  });

  it("counts what R2 stores: the brotli, not the raw", async () => {
    const store = new BudgetStore(new CountingStore());
    await store.put("objects/a.json", Buffer.from(JSON.stringify({ a: "x".repeat(10_000) })));
    expect(store.current().bytes).toBeLessThan(200);
    expect(await store.stat("objects/a.json")).toBeGreaterThan(10_000);
  });

  it("keeps the running total in the bucket, and the next job starts from it", async () => {
    const inner = new CountingStore();
    const a = new BudgetStore(inner);
    await a.put(NOT_COMPRESSED, bytes(400));
    await a.flush();
    expect(inner.data.has("reports/usage.json")).toBe(true);
    const b = new BudgetStore(inner);
    await b.open();
    expect(b.current().bytes).toBe(400);
    expect(b.current().objects).toBe(1);
    expect(b.current().classA).toBeGreaterThan(0);
    await expect(new BudgetStore(inner, { limitBytes: 500 }).put("objects/b.ktx2", bytes(200))).rejects.toBeInstanceOf(BudgetExceeded);
  });

  it("Class A starts over in a new month, storage does not", async () => {
    const inner = new CountingStore();
    const a = new BudgetStore(inner, { now: () => new Date("2026-11-20T00:00:00Z") });
    await a.put(NOT_COMPRESSED, bytes(100));
    await a.flush();
    const b = new BudgetStore(inner, { now: () => new Date("2026-12-02T00:00:00Z") });
    await b.open();
    expect(b.current().month).toBe("2026-12");
    expect(b.current().bytes).toBe(100);
    expect(b.current().classA).toBeLessThan(5);
  });

  it("a run longer than one periodic write still finishes, and writes its ledger", async () => {
    const inner = new CountingStore();
    const store = new BudgetStore(inner, { flushEvery: 3 });
    for (let i = 0; i < 10; i++) await store.put(`objects/${i}.bin`, bytes(1));
    await store.flush();
    expect(inner.data.has("reports/usage.json")).toBe(true);
    const objects = JSON.parse(Buffer.from(inner.data.get("reports/objects.json")!).toString("utf8")) as unknown[];
    expect(objects).toHaveLength(10);
  });

  it("has a month, and its limits sit inside the free tier", () => {
    expect(monthOf(new Date("2026-11-04T12:00:00Z"))).toBe("2026-11");
    expect(LIMITS.bytes).toBeLessThanOrEqual(9_000_000_000);
    expect(LIMITS.classA).toBeLessThanOrEqual(800_000);
  });
});

describe("a plan costs one read, however big the bucket", () => {
  const record = (id: string): BakeRecord => ({ id, kind: "item", status: "ok", build: "12.1.0.69933", baker: "x", source: "wago", inputs: {}, warnings: [], seconds: 0, bakedAt: "" });

  it("sends no HEAD and no LIST to answer what is done", async () => {
    const inner = new CountingStore();
    const seed = new BudgetStore(inner);
    for (let i = 0; i < 50; i++) {
      await seed.put(`items/item-${i}/manifest.json`, Buffer.from("{}"));
      await writeRecord(seed, record(`item-${i}`));
    }
    await seed.flush();
    inner.heads = 0;
    inner.lists = 0;
    inner.gets = 0;
    inner.puts = 0;

    const store = new BudgetStore(inner);
    const ctx = { source: { identity: async () => null }, db: new Db2(), store, force: false } as unknown as BakeContext;
    for (let i = 0; i < 50; i++) await isUpToDate(ctx, `item-${i}`, `items/item-${i}/manifest.json`);
    expect(inner.heads).toBe(0);
    expect(inner.lists).toBe(0);
    expect(inner.gets).toBeLessThanOrEqual(3);
    expect(await readRecord(store, "item-7")).not.toBeNull();
  });

  it("a stat is answered from the ledger", async () => {
    const inner = new CountingStore();
    const store = new BudgetStore(inner);
    await store.put(NOT_COMPRESSED, bytes(10));
    inner.heads = 0;
    expect(await store.stat(NOT_COMPRESSED)).toBe(10);
    expect(await store.stat("objects/nothing.glb")).toBeNull();
    expect(inner.heads).toBe(0);
  });
});

describe("a matrix of shards", () => {
  it("each takes its fair part, and report folds the deltas in", async () => {
    const inner = new CountingStore();
    const seed = new BudgetStore(inner);
    await seed.open();
    await seed.flush();
    const shard = (index: number) => new BudgetStore(inner, { limitBytes: 1000, shard: { index, count: 2 } });
    const a = shard(0);
    const b = shard(1);
    await a.put("objects/a.bin", bytes(400));
    await expect(a.put("objects/a2.bin", bytes(200))).rejects.toBeInstanceOf(BudgetExceeded);
    await b.put("objects/b.bin", bytes(300));
    await writeRecord(b, { id: "u", kind: "item", status: "ok", build: "", baker: "", source: "", inputs: {}, warnings: [], seconds: 0, bakedAt: "" });
    await a.flush();
    await b.flush();
    expect(inner.data.has("reports/shards/0.json")).toBe(true);

    const report = new BudgetStore(inner);
    expect(await report.foldShards(2)).toBe(2);
    expect(report.current().bytes).toBe(700);
    expect(report.has("objects/a.bin")).toBe(true);
    expect(report.records.has("u")).toBe(true);
    await report.flush();
    expect(inner.data.has("reports/shards/0.json")).toBe(false);
    const next = new BudgetStore(inner);
    await next.open();
    expect(next.current().bytes).toBe(700);
    expect(next.current().objects).toBe(2);
  });
});

describe("the load check", () => {
  const glb = (json: object, declared?: number) => {
    const j = Buffer.from(JSON.stringify(json));
    const pad = Buffer.alloc((4 - (j.length % 4)) % 4, 0x20);
    const total = 12 + 8 + j.length + pad.length;
    const out = Buffer.alloc(total);
    out.writeUInt32LE(0x46546c67, 0);
    out.writeUInt32LE(2, 4);
    out.writeUInt32LE(declared ?? total, 8);
    out.writeUInt32LE(j.length + pad.length, 12);
    out.writeUInt32LE(0x4e4f534a, 16);
    j.copy(out, 20);
    pad.copy(out, 20 + j.length);
    return out;
  };

  it("passes a sound GLB and refuses a truncated one", () => {
    expect(checkGlb(glb({ asset: { version: "2.0" } }))).toBe(true);
    expect(checkGlb(glb({ asset: { version: "2.0" } }, 9999))).toBe(false);
    expect(checkGlb(glb({}))).toBe(false);
    expect(checkGlb(new Uint8Array(4))).toBe(false);
  });

  it("knows KTX2 and WebP by their headers", () => {
    const ktx = Buffer.alloc(80);
    Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ktx);
    ktx.writeUInt32LE(4, 20);
    ktx.writeUInt32LE(4, 24);
    expect(checkKtx2(ktx)).toBe(true);
    expect(checkKtx2(Buffer.alloc(80))).toBe(false);
    expect(checkWebp(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe(true);
    expect(checkWebp(Buffer.from("notawebpfile!"))).toBe(false);
  });

  it("an empty object never passes, and the ledger remembers", async () => {
    expect(checkObject("objects/a.json", new Uint8Array(0))).toBe(false);
    const store = new BudgetStore(new CountingStore());
    await store.put("objects/bad.glb", bytes(100));
    await store.put("objects/good.json", Buffer.from("{}"));
    expect(store.object("objects/bad.glb")?.ok).toBe(false);
    expect(store.object("objects/good.json")?.ok).toBe(true);
  });
});
