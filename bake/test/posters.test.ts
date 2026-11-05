import { packListSheets, packShardSheets, packSheet } from "../src/posters/sheets";
import { describe, expect, test } from "vitest";
import sharp from "sharp";
import { POSTER, SHEET, itemOfRow, posterFor, sheetFor, sheetRect, toStraightAlpha, type ItemManifest, type ItemRow, type ItemShard, type SetEntry } from "@eclipse/format";
import { buildMounts, buildSets, buildShards, type LineSnapshot } from "../src/commands/catalog";
import { MEASURED, projectUnits } from "../src/commands/scope";
import type { BakeRecord } from "../src/bake/context";
import { isInternalMount, type MountFamily } from "../src/mounts/scan";
import { encodePoster } from "../src/posters/bake";
import { modelSignature, posterHash, posterKey, posterUnitId, wornSignature } from "../src/posters/spec";
import { LocalStore } from "../src/store/store";

function record(id: string, over: Partial<BakeRecord> = {}): BakeRecord {
  return { id, kind: "item", status: "ok", build: "t", baker: "t", source: "t", inputs: {}, warnings: [], seconds: 0, bakedAt: "t", validated: true, ...over };
}

const store = new LocalStore("does-not-exist");

describe("which mounts a player may see", () => {
  const real = { Description_lang: "It feeds on your thoughts.", SourceText_lang: "Drop: somewhere" };

  test("the marks Blizzard leaves on its own test rigs", () => {
    expect(isInternalMount({ ...real, Name_lang: "[DND] Test Mount JZB" })).toBe(true);
    expect(isInternalMount({ ...real, Name_lang: "Dragon Isles Drake Model Test" })).toBe(true);
    expect(isInternalMount({ Name_lang: "Fine Name", Description_lang: "NYI", SourceText_lang: "" })).toBe(true);
    expect(isInternalMount({ ...real, Name_lang: "[PH] Something" })).toBe(true);
  });

  test("no words at all: the Journal has nothing to say about it", () => {
    expect(isInternalMount({ Name_lang: "Whelpling", Description_lang: "", SourceText_lang: "" })).toBe(true);
    expect(isInternalMount({ Name_lang: "Lightforged Ruinstrider", Description_lang: " ", SourceText_lang: "" })).toBe(true);
  });

  test("real mounts stay, those with one line of words too", () => {
    for (const Name_lang of ["Swift Razzashi Raptor", "Deadly Gladiator's Frost Wyrm", "Testudo", "Contest Winner's Pony", "Fastest Mount"]) {
      expect(isInternalMount({ ...real, Name_lang })).toBe(false);
    }
    expect(isInternalMount({ Name_lang: "Tiger", Description_lang: "", SourceText_lang: "Legacy" })).toBe(false);
    expect(isInternalMount({ Name_lang: "Honeyback Hivemother", Description_lang: "Destined to become queen.", SourceText_lang: "" })).toBe(false);
  });
});

describe("a poster's name", () => {
  test("stable, hashed, in the store's immutable folder, and short in a row", () => {
    const k = posterKey("creature", "abc");
    expect(k).toBe(posterKey("creature", "abc"));
    expect(k).toMatch(/^objects\/[0-9a-f]{16}\.webp$/);
    expect(posterHash(k)).toHaveLength(16);
    expect(posterKey("creature", "abd")).not.toBe(k);
    expect(posterKey("alone", "abc")).not.toBe(k);
    expect(posterUnitId("item-5")).toBe("poster-item-5");
  });

  const item = (over: Partial<ItemManifest>): ItemManifest => ({ formatVersion: 1, id: "item-1", slot: "head", attached: [{ attachment: 11, manifest: "m-1" }], collections: {}, bodyLayers: [], geosetGroups: {}, ...over });

  test("two displays wearing the same files share one poster", () => {
    expect(wornSignature(item({ id: "item-1", name: "Helm" }), "human-male")).toBe(wornSignature(item({ id: "item-2", name: "Other Name" }), "human-male"));
  });

  test("what changes the picture changes the name", () => {
    const base = wornSignature(item({}), "human-male");
    expect(wornSignature(item({ attached: [{ attachment: 11, manifest: "m-2" }] }), "human-male")).not.toBe(base);
    expect(wornSignature(item({ geosetGroups: { 1: 2 } }), "human-male")).not.toBe(base);
    expect(wornSignature(item({ helmetHide: { "*": [3] } }), "human-male")).not.toBe(base);
  });

  test("a per-body cut is that body's", () => {
    const m = item({ attached: [], attachedBy: { "human-male": [{ attachment: 11, manifest: "m-a" }], "human-female": [{ attachment: 11, manifest: "m-b" }] } });
    expect(wornSignature(m, "human-male")).not.toBe(wornSignature(m, "human-female"));
  });

  test("key order in a manifest doesn't split a poster", () => {
    expect(wornSignature(item({ geosetGroups: { 1: 2, 3: 4 } }), "x")).toBe(wornSignature(item({ geosetGroups: { 3: 4, 1: 2 } }), "x"));
  });

  test("a model's look is what its files and geosets say", () => {
    const m = { glb: { key: "a", bytes: 1 }, textures: [], defaultGeosets: [2, 1], defaultClip: "0.0" };
    expect(modelSignature(m)).toBe(modelSignature({ ...m, defaultGeosets: [1, 2] }));
    expect(modelSignature({ ...m, glb: { key: "b", bytes: 1 } })).not.toBe(modelSignature(m));
  });
});

describe("what a canvas holds, made a file", () => {
  test("a solid pixel stays what it is, an empty one is nothing", () => {
    const px = new Uint8Array([200, 100, 50, 255, 0, 0, 0, 0]);
    const { rgba } = toStraightAlpha(px, 2, 1);
    expect([...rgba]).toEqual([200, 100, 50, 255, 0, 0, 0, 0]);
  });

  test("a half-covered pixel unpremultiplies", () => {
    const { rgba } = toStraightAlpha(new Uint8Array([100, 50, 0, 128]), 1, 1);
    expect(rgba[3]).toBe(128);
    expect(rgba[0]).toBe(199);
    expect(rgba[1]).toBe(100);
  });

  test("a glow has colour and no alpha, and keeps every bit of it over the black plate", () => {
    // An additive pass: light added, alpha untouched.
    const glow = [120, 200, 40, 0];
    const { rgba } = toStraightAlpha(new Uint8Array(glow), 1, 1);
    expect(rgba[3]).toBe(200);
    for (let c = 0; c < 3; c++) expect(Math.abs((rgba[c]! * rgba[3]!) / 255 - glow[c]!)).toBeLessThanOrEqual(1);
  });

  test("it says how much is drawn and how much touches the frame", () => {
    // 4 x 4, the middle four solid.
    const px = new Uint8Array(4 * 4 * 4);
    for (const i of [5, 6, 9, 10]) px.set([255, 255, 255, 255], i * 4);
    const { stats } = toStraightAlpha(px, 4, 4);
    expect(stats.coverage).toBeCloseTo(0.25, 5);
    expect(stats.edge).toBe(0);
  });

  test("it comes out a transparent WebP of the poster's size, around 8 KB at worst for flat art", async () => {
    const w = POSTER.cell.width * 2;
    const h = POSTER.cell.height * 2;
    const px = new Uint8Array(w * h * 4);
    for (let y = h / 4; y < (3 * h) / 4; y++) {
      for (let x = w / 4; x < (3 * w) / 4; x++) px.set([(x * 3) & 255, (y * 5) & 255, 90, 255], (y * w + x) * 4);
    }
    const { webp, coverage } = await encodePoster(px, w, h, POSTER.cell);
    expect(coverage).toBeCloseTo(0.25, 2);
    const m = await sharp(webp).metadata();
    expect(m.format).toBe("webp");
    expect(m.width).toBe(POSTER.cell.width);
    expect(m.height).toBe(POSTER.cell.height);
    expect(m.hasAlpha).toBe(true);
    expect(webp.length).toBeLessThan(16_000);
  });
});

describe("the catalogue", () => {
  const row = (display: number) => ({ display, itemId: display, name: `Item ${display}`, iconFdid: 0, slot: "head" as const, line: "midnight", inventoryType: 1, sheatheType: 0 });
  const snap = (rows: ReturnType<typeof row>[], sets: LineSnapshot["sets"] = []): LineSnapshot => ({ line: "midnight", rows, sets, coverage: {} as LineSnapshot["coverage"] });
  const M = posterKey("m");
  const F = posterKey("f");

  test("a row with no poster is the row it was, byte for byte", () => {
    const out = buildShards(store, [snap([row(1)])], new Map([["item-1", record("item-1")]]));
    expect(out.shards.get("catalog/items/midnight-head.json")!.rows[0]).toEqual([1, "Item 1", "", "", 0]);
    expect(out.stats.get("midnight")!.posters).toBe(0);
  });

  test("a row names its posters, and the browser reads them back", () => {
    const records = new Map([["item-1", record("item-1")], [posterUnitId("item-1"), record(posterUnitId("item-1"), { kind: "poster", posters: { male: M, female: F } })]]);
    const out = buildShards(store, [snap([row(1)])], records);
    const r = out.shards.get("catalog/items/midnight-head.json")!.rows[0]!;
    expect(r.slice(5)).toEqual([null, posterHash(M), posterHash(F)]);
    const entry = itemOfRow(r as ItemRow, "midnight", "head");
    expect(entry.poster).toBe(M);
    expect(entry.posterFemale).toBe(F);
    expect(entry.notOn).toBeUndefined();
    expect(posterFor(entry, "orc-female")).toBe(F);
    expect(posterFor(entry, "orc-male")).toBe(M);
    expect(out.stats.get("midnight")!.posters).toBe(1);
  });

  test("the bodies it cannot show on stay on the row", () => {
    const records = new Map([["item-1", record("item-1", { notOn: ["tauren-male"] })], [posterUnitId("item-1"), record(posterUnitId("item-1"), { kind: "poster", posters: { male: M } })]]);
    const r = buildShards(store, [snap([row(1)])], records).shards.get("catalog/items/midnight-head.json")!.rows[0]!;
    const entry = itemOfRow(r as ItemRow, "midnight", "head");
    expect(entry.notOn).toEqual(["tauren-male"]);
    expect(posterFor(entry, "orc-female")).toBe(M);
  });

  test("a poster that failed its own check is not named", () => {
    const records = new Map([["item-1", record("item-1")], [posterUnitId("item-1"), record(posterUnitId("item-1"), { kind: "poster", status: "failed", validated: false, posters: { male: M } })]]);
    const r = buildShards(store, [snap([row(1)])], records).shards.get("catalog/items/midnight-head.json")!.rows[0]!;
    expect(r).toHaveLength(5);
  });

  test("a set carries its posters", () => {
    const snapshots = [snap([row(1)], [{ id: "set-1", name: "Set", line: "midnight", pieces: { head: 1 } }] as LineSnapshot["sets"])];
    const records = new Map([["item-1", record("item-1")], [posterUnitId("set-1"), record(posterUnitId("set-1"), { kind: "poster", posters: { male: M, female: F } })]]);
    const set = buildSets(snapshots, buildShards(store, snapshots, records), records, store).get("midnight")![0]!;
    expect(set.poster).toBe(M);
    expect(set.posterFemale).toBe(F);
  });

  test("a mount and each of its colours carry theirs", () => {
    const family: MountFamily = {
      id: "mount-1", name: "Ram", m2: 1, mountId: 1, flying: false,
      variants: [100, 101].map((display) => ({ display, mountId: 1, name: `Ram ${display}`, iconFdid: 0, m2: 1, scale: 1, skins: [0, 0, 0, 0], extra: 0, geosetData: 0 })),
    };
    const records = new Map([["mount-1", record("mount-1", { kind: "mount", variants: [100, 101] })], [posterUnitId("mountd-100"), record(posterUnitId("mountd-100"), { kind: "poster", posters: { male: M } })]]);
    const { entries } = buildMounts(store, [family], records);
    expect(entries[0]!.poster).toBe(M);
    expect(entries[0]!.variants[0]!.poster).toBe(M);
    // The colour with none has none, and the rest of it is what it was.
    expect(entries[0]!.variants[1]!.poster).toBeUndefined();
    expect(entries[0]!.variants[1]!.display).toBe(101);
  });
});

describe("the budget", () => {
  test("a plan can say what posters will cost before they start", () => {
    const units = Array.from({ length: 1000 }, () => ({ kind: "poster" }));
    const p = projectUnits(units);
    expect(p.bytes).toBe(1000 * MEASURED.poster.bytes);
    expect(p.writes).toBeCloseTo(1000 * MEASURED.poster.writes, 6);
  });
});

describe("a page of posters as one file", () => {
  const poster = (r: number, g: number, b: number, w: number = POSTER.cell.width, h: number = POSTER.cell.height) =>
    sharp({ create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: 1 } } }).webp({ lossless: true }).toBuffer();
  const memory = async (entries: Record<string, Buffer>) => {
    const files = new Map(Object.entries(entries));
    let writes = 0;
    return {
      files,
      writes: () => writes,
      store: {
        name: "memory",
        stat: async (k: string) => files.get(k)?.length ?? null,
        get: async (k: string) => files.get(k) ?? null,
        put: async (k: string, body: Uint8Array) => { writes++; files.set(k, Buffer.from(body)); },
        list: async () => [...files.keys()],
        remove: async (k: string) => { files.delete(k); },
      } as never,
    };
  };

  test("each poster stands in its slot, left to right, top to bottom", async () => {
    const m = await memory({ "objects/a.webp": await poster(255, 0, 0), "objects/b.webp": await poster(0, 255, 0), "objects/c.webp": await poster(0, 0, 255) });
    const keys = ["objects/a.webp", undefined, "objects/b.webp", ...new Array(6).fill(undefined), "objects/c.webp"];
    const hash = await packSheet(m.store, keys, POSTER.cell, true);
    const { data, info } = await sharp(m.files.get(`objects/${hash}.webp`)!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(SHEET.cols * POSTER.cell.width);
    expect(info.height).toBe(SHEET.rows * POSTER.cell.height);
    const at = (slot: number) => {
      const r = sheetRect(slot, POSTER.cell);
      const i = ((r.y + 50) * info.width + r.x + 50) * 4;
      return [...data.subarray(i, i + 4)];
    };
    expect(at(0)[0]).toBeGreaterThan(200);
    expect(at(1)[3]).toBe(0);
    expect(at(2)[1]).toBeGreaterThan(200);
    expect(at(9)[2]).toBeGreaterThan(200);
  });

  test("named by what it holds: nothing changed, nothing written; and only --sheets makes one", async () => {
    const m = await memory({ "objects/a.webp": await poster(255, 0, 0) });
    expect(await packSheet(m.store, ["objects/a.webp"], POSTER.cell, false)).toBe("");
    expect(m.writes()).toBe(0);
    const made = await packSheet(m.store, ["objects/a.webp"], POSTER.cell, true);
    expect(m.writes()).toBe(1);
    expect(await packSheet(m.store, ["objects/a.webp"], POSTER.cell, false)).toBe(made);
    expect(await packSheet(m.store, ["objects/a.webp"], POSTER.cell, true)).toBe(made);
    expect(m.writes()).toBe(1);
  });

  test("a shard's rows find their page and slot, each body its own", async () => {
    const m = await memory({ "objects/a.webp": await poster(255, 0, 0), "objects/b.webp": await poster(0, 255, 0) });
    const rows: ItemRow[] = Array.from({ length: 40 }, (_, i) => [1000 + i, `Item ${i}`, "", "", 0, null, i === 35 ? "" : "a", i === 3 ? "b" : undefined] as ItemRow);
    const shard: ItemShard = { line: "midnight", slot: "head", rows };
    await packShardSheets(m.store, [shard], true);
    expect(shard.sheets!.male).toHaveLength(2);
    expect(shard.sheets!.female).toHaveLength(2);
    const third = itemOfRow(rows[3]!, "midnight", "head", 3, shard.sheets);
    expect(third.sheet).toEqual([shard.sheets!.male[0], 3]);
    expect(third.sheetFemale).toEqual([shard.sheets!.female![0], 3]);
    const late = itemOfRow(rows[33]!, "midnight", "head", 33, shard.sheets);
    expect(late.sheet).toEqual([shard.sheets!.male[1], 1]);
    // No poster, no slot, whatever page it falls on.
    expect(itemOfRow(rows[35]!, "midnight", "head", 35, shard.sheets).sheet).toBeUndefined();
  });

  test("sets and mounts carry their own place", async () => {
    const m = await memory({ "objects/a.webp": await poster(255, 0, 0, POSTER.set.width, POSTER.set.height) });
    const list = Array.from({ length: 33 }, (_, i) => ({ id: `s${i}`, poster: "objects/a.webp" })) as never as SetEntry[];
    await packListSheets(m.store, list, POSTER.set, true);
    expect(list[0]!.sheet![1]).toBe(0);
    expect(list[31]!.sheet![1]).toBe(31);
    expect(list[32]!.sheet![1]).toBe(0);
    expect(list[32]!.sheet![0]).not.toBe(list[0]!.sheet![0]);
    expect(sheetFor(list[0]!, "human-female")).toEqual(list[0]!.sheet);
  });
});
