import { describe, expect, it } from "vitest";
import { itemOfRow, paths } from "@eclipse/format";
import type { BakeRecord } from "../src/bake/context";
import { bodyClipWanted, mountClipWanted } from "../src/bake/clips";
import { buildMounts, buildSets, buildShards, listable, type LineSnapshot } from "../src/commands/catalog";
import { everyNth, projectUnits } from "../src/commands/scope";
import { failedObjects, hasAnyPart, objectsOfItem, specsOfRows } from "../src/items/bake";
import { DONOR_MAX_DISTANCE, modelStep, skeletonDistance } from "../src/items/bodies";
import { curateSets, isWeapon, isWornArmor, readLineData, type LineRow } from "../src/items/lines";
import { fallbackChain, fileForBody, pickTexture, sheathMatrix, sheathPointsOf, type ModelFile, type TextureFile } from "../src/items/resolve";
import { chrGeosets, creatureGeosets } from "../src/mounts/bake";
import { lookKey, type MountFamily } from "../src/mounts/scan";
import { BudgetStore } from "../src/store/budget";
import type { Store } from "../src/store/store";
import { shelfPack } from "../src/ui/bake";

const model = (over: Partial<ModelFile> = {}): ModelFile => ({ k: 0, fdid: 1, race: 0, sex: 3, classId: 0, position: -1, ...over });
const tex = (over: Partial<TextureFile> = {}): TextureFile => ({ fdid: 1, usage: 0, race: 0, sex: 3, classId: 0, ...over });

describe("retail's fallback, own race then ChrRaces then nothing", () => {
  const cuts = [model({ fdid: 2, race: 2, sex: 0 }), model({ fdid: 6, race: 6, sex: 1 })];

  it("walks the chain with its sex", () => {
    expect(fileForBody(cuts, 2, 0)?.fdid).toBe(2);
    expect(fileForBody(cuts, 36, 0, [[2, 0]])?.fdid).toBe(2);
    expect(fileForBody(cuts, 36, 0, [[99, 0], [6, 1]])?.fdid).toBe(6);
    expect(fileForBody(cuts, 36, 0, [[99, 0]])).toBeUndefined();
  });

  it("wears a class-locked cut when nothing else fits: nothing is locked", () => {
    expect(fileForBody([model({ fdid: 9, race: 1, sex: 0, classId: 12 })], 1, 0)?.fdid).toBe(9);
    expect(fileForBody([model({ fdid: 9, race: 1, sex: 0, classId: 12 }), model({ fdid: 8, race: 0, sex: 3 })], 1, 0)?.fdid).toBe(8);
  });

  it("follows the ChrRaces columns to their end, and stops if they come back round", () => {
    const races = new Map([
      ["28", { MaleModelFallbackRaceID: "6", MaleModelFallbackSex: "0" }],
      ["6", { MaleModelFallbackRaceID: "0", MaleModelFallbackSex: "0" }],
      ["7", { MaleModelFallbackRaceID: "8", MaleModelFallbackSex: "0" }],
      ["8", { MaleModelFallbackRaceID: "7", MaleModelFallbackSex: "0" }],
    ]);
    expect(fallbackChain([28, 0], (at) => modelStep(races, at))).toEqual([[6, 0]]);
    expect(fallbackChain([7, 0], (at) => modelStep(races, at))).toEqual([[8, 0]]);
  });

  it("a texture follows the chain before a race-agnostic file", () => {
    const list = [tex({ fdid: 1, race: 0 }), tex({ fdid: 2, race: 6, sex: 0 })];
    expect(pickTexture(list, 28, 0, [[6, 0]])?.fdid).toBe(2);
    expect(pickTexture(list, 28, 0)?.fdid).toBe(1);
  });
});

describe("a donor", () => {
  const bones = (crc: number[], offset: number) => ({ crc, pivot: crc.flatMap((_, i) => [i + offset, 0, 0]), head: -1 });
  const ids = Array.from({ length: 20 }, (_, i) => i + 1);

  it("is measured by the median bone both skeletons have", () => {
    expect(skeletonDistance(bones(ids, 0), bones(ids, 0))).toBe(0);
    expect(skeletonDistance(bones(ids, 0), bones(ids, 0.5))).toBeCloseTo(0.5);
  });

  it("too few shared bones is no fit at all", () => {
    expect(skeletonDistance(bones([1, 2, 3], 0), bones([1, 2, 3], 0))).toBe(Infinity);
    expect(DONOR_MAX_DISTANCE).toBeGreaterThan(0);
  });
});

describe("the sheath", () => {
  it("rests where the 3.3.5 tables say", () => {
    expect(sheathPointsOf(1)).toEqual([26, 27]);
    expect(sheathPointsOf(2)).toEqual([30, 31]);
    expect(sheathPointsOf(3)).toEqual([32, 33]);
    expect(sheathPointsOf(4)).toEqual([28, 28]);
    expect(sheathPointsOf(0)).toBeUndefined();
  });

  it("is identity for a zero row with scale 1", () => {
    expect(sheathMatrix([0, 0, 0], 0, 0, 0, 1)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it("moves in the baker's axes: retail (x, y, z) is baked (y, z, x)", () => {
    const m = sheathMatrix([1, 2, 3], 0, 0, 0, 1);
    expect([m[12], m[13], m[14]]).toEqual([2, 3, 1]);
  });

  it("a yaw about retail's Z turns about baked Y, keeping handedness", () => {
    const m = sheathMatrix([0, 0, 0], 90, 0, 0, 1);
    // Retail: x -> y under Rz(90). Baked x is retail y, baked z is retail x, so baked z -> baked x.
    expect(m[8]).toBeCloseTo(1, 5);
    expect(m[5]).toBeCloseTo(1, 5);
    const det = m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!) + m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!);
    expect(det).toBeCloseTo(1, 5);
  });
});

describe("what the lines hold", () => {
  const set = (ID: string, Name_lang: string, ClassMask = "0", ParentTransmogSetID = "0", TransmogSetGroupID = "1") => ({ ID, Name_lang, ClassMask, ParentTransmogSetID, TransmogSetGroupID });

  it("keeps a parent and its colourways as one family", () => {
    const sets = [set("1", "A"), set("2", "A Blue", "0", "1"), set("3", "[DNT] Test")];
    const apps = new Map([["1", new Set(["a"])], ["2", new Set(["b"])], ["3", new Set(["c"])]]);
    const { kept, excluded } = curateSets(sets, () => "", (id) => apps.get(id)!, () => 4, { premium: true, seasonPrefix: "midnight season" });
    expect(kept.sort()).toEqual(["1", "2"]);
    expect(excluded.placeholder).toBe(1);
  });

  it("Midnight leaves out what is common, repeated, or filler", () => {
    const sets = [set("1", "Epic"), set("2", "Green"), set("3", "Repeat"), set("4", "Tattered Rags")];
    const apps = new Map([["1", new Set(["a"])], ["2", new Set(["b"])], ["3", new Set(["a"])], ["4", new Set(["d"])]]);
    const q = new Map([["1", 4], ["2", 2], ["3", 3], ["4", 3]]);
    const { kept, excluded } = curateSets(sets, () => "", (id) => apps.get(id)!, (id) => q.get(id)!, { premium: true, seasonPrefix: "midnight season" });
    expect(kept).toEqual(["1"]);
    expect(excluded).toEqual({ "common or uncommon": 1, "identical to a kept set": 1, "filler name": 1 });
  });

  it("War Within keeps everything that is not a placeholder or a copy", () => {
    const sets = [set("1", "Epic"), set("2", "Green")];
    const apps = new Map([["1", new Set(["a"])], ["2", new Set(["b"])]]);
    const { kept } = curateSets(sets, () => "", (id) => apps.get(id)!, () => 1, { premium: false, seasonPrefix: "war within season" });
    expect(kept.sort()).toEqual(["1", "2"]);
  });

  it("tells weapons from worn armour", () => {
    expect(isWeapon(2, 7, 13)).toBe(true);
    expect(isWeapon(4, 6, 14)).toBe(true);
    expect(isWornArmor(4, 4, 5)).toBe(true);
    expect(isWornArmor(4, 4, 12)).toBe(false);
  });

  it("one look is one unit, whichever lines list it, with all its icons", () => {
    const row = (over: Partial<LineRow>): LineRow => ({ display: 5, itemId: 1, name: "A", iconFdid: 10, slot: "head", line: "eclipse", inventoryType: 1, sheatheType: 0, ...over });
    const specs = specsOfRows([row({}), row({ line: "client", iconFdid: 11 }), row({ display: 6, line: "client" })]);
    expect(specs.map((s) => s.displayId)).toEqual([5, 6]);
    expect(specs[0]!.icons).toEqual([10, 11]);
  });

  it("the committed map has both local lines, ids and names only, and stays small", () => {
    const data = readLineData();
    expect(data).not.toBeNull();
    expect(data!.client.rows.length).toBeGreaterThan(20_000);
    expect(data!.eclipse.rows.length).toBeGreaterThan(20_000);
    expect(data!.eclipse.total).toBe(34_937);
    const r = data!.client.rows[0]!;
    expect(typeof r[0]).toBe("number");
    expect(typeof r[1]).toBe("number");
    expect(Object.keys(data!.entries)).toEqual(["midnight", "warwithin"]);
  });

  it("samples across the whole list", () => {
    expect(everyNth([1, 2, 3, 4, 5, 6, 7, 8], 4)).toEqual([1, 3, 5, 7]);
    expect(everyNth([1, 2], 5)).toEqual([1, 2]);
    expect(projectUnits([{ kind: "item" }, { kind: "nothing" }]).bytes).toBeGreaterThan(0);
  });
});

describe("the catalogue validates itself", () => {
  const rec = (id: string, over: Partial<BakeRecord> = {}): BakeRecord => ({ id, kind: "item", status: "ok", build: "", baker: "", source: "", inputs: {}, warnings: [], seconds: 0, bakedAt: "", validated: true, icons: { "10": "objects/abc.webp" }, ...over });
  const row = (display: number, over: Partial<LineRow> = {}): LineRow => ({ display, itemId: display, name: `Item ${display}`, iconFdid: 10, slot: "head", line: "midnight", inventoryType: 1, sheatheType: 0, facet: "cloth", entry: display + 0x03000000, ...over });
  const snap = (rows: LineRow[], sets: LineSnapshot["sets"] = []): LineSnapshot => ({ line: "midnight", rows, sets, coverage: { total: rows.length, unresolved: 0, unnamed: 0, noSlot: 0, duplicates: 0 } });

  /** A bucket that holds what it says, and answers for each object's load check. */
  const bucket = (objects: Record<string, boolean>): Store => ({ object: (k: string) => (k in objects ? { ok: objects[k] } : undefined) }) as unknown as Store;

  it("lists only what finished, passed its self-check, and is in the bucket", () => {
    const store = bucket({ [paths.item("item-1")]: true, [paths.item("item-3")]: false, [paths.item("item-4")]: true, [paths.item("item-5")]: true });
    const records = new Map([
      ["item-1", rec("item-1")],
      ["item-2", rec("item-2")], // recorded, its manifest is not up there
      ["item-3", rec("item-3")], // its manifest failed the load check
      ["item-4", rec("item-4", { status: "failed" })],
      ["item-5", rec("item-5", { validated: undefined })],
    ]);
    const out = buildShards(store, [snap([1, 2, 3, 4, 5, 6].map((d) => row(d)))], records);
    expect(out.shards.get(paths.itemShard("midnight", "head"))!.rows.map((r) => r[0])).toEqual([1]);
    const s = out.stats.get("midnight")!;
    expect(s).toEqual({ listed: 1, notBaked: 1, failed: 4, entries: 1 });
    expect(listable(store, records.get("item-1"), paths.item("item-1"))).toBe(true);
    expect(listable(store, undefined, paths.item("item-1"))).toBe(false);
  });

  it("a shard row expands into the entry the site works with, entry included", () => {
    const store = bucket({ [paths.item("item-1")]: true });
    const out = buildShards(store, [snap([row(1)])], new Map([["item-1", rec("item-1")]]));
    const ref = out.refs[0]!;
    expect(ref).toEqual({ line: "midnight", slot: "head", key: paths.itemShard("midnight", "head"), count: 1, facets: ["cloth"] });
    const e = itemOfRow(out.shards.get(ref.key)!.rows[0]!, "midnight", "head");
    expect(e).toMatchObject({ id: "item-1", name: "Item 1", slot: "head", line: "midnight", icon: "objects/abc.webp", facet: "cloth", entry: 0x03000001, model: paths.item("item-1") });
  });

  it("what a body cannot wear is said on the row, and only then", () => {
    const store = bucket({ [paths.item("item-1")]: true, [paths.item("item-2")]: true });
    const out = buildShards(store, [snap([row(1), row(2)])], new Map([["item-1", rec("item-1", { notOn: ["tauren-male"] })], ["item-2", rec("item-2")]]));
    const [a, b] = out.shards.get(paths.itemShard("midnight", "head"))!.rows;
    expect(itemOfRow(a!, "midnight", "head").notOn).toEqual(["tauren-male"]);
    expect(itemOfRow(b!, "midnight", "head").notOn).toBeUndefined();
  });

  it("a chip's facets are only what the shard holds", () => {
    const store = bucket({ [paths.item("item-1")]: true, [paths.item("item-2")]: true });
    const out = buildShards(store, [snap([row(1, { facet: "plate" }), row(2, { facet: "none" })])], new Map([["item-1", rec("item-1")], ["item-2", rec("item-2")]]));
    expect(out.refs[0]!.facets).toEqual(["plate"]);
  });

  it("a set wears only the pieces that passed, and a set with none is gone", () => {
    const store = bucket({ [paths.item("item-1")]: true });
    const snapshots = [snap([row(1), row(2, { slot: "chest" })], [
      { id: "set-9", name: "Half", line: "midnight", pieces: { head: 1, chest: 2 } },
      { id: "set-8", name: "None", line: "midnight", pieces: { chest: 2 } },
    ])];
    const records = new Map([["item-1", rec("item-1")]]);
    const sets = buildSets(snapshots, buildShards(store, snapshots, records), records, store).get("midnight")!;
    expect(sets.map((s) => s.id)).toEqual(["set-9"]);
    expect(sets[0]!.pieces).toEqual({ head: "item-1" });
    expect(sets[0]!.icons).toEqual({ head: "objects/abc.webp" });
  });

  it("a mount lists only the colours the game gave and the bake finished", () => {
    const family: MountFamily = {
      id: "mount-1", name: "Horse", m2: 7, mountId: 1, flying: false,
      variants: [
        { display: 100, mountId: 1, name: "Brown", iconFdid: 10, m2: 7, scale: 1, skins: [0, 0, 0, 0], extra: 0, geosetData: 0, entry: 100 },
        { display: 101, mountId: 2, name: "White", iconFdid: 10, m2: 7, scale: 1, skins: [1, 0, 0, 0], extra: 0, geosetData: 0 },
      ],
    };
    const store = bucket({ [paths.manifest("mountd-100")]: true });
    const { entries } = buildMounts(store, [family], new Map([["mount-1", rec("mount-1", { kind: "mount", variants: [100] })]]));
    expect(entries[0]!.variants.map((v) => v.display)).toEqual([100]);
    expect(entries[0]!.variants[0]!.entry).toBe(100);
    const none = buildMounts(store, [family], new Map([["mount-1", rec("mount-1", { status: "failed" })]]));
    expect(none.entries).toEqual([]);
    expect(none.failed).toBe(1);
  });

  it("a manifest with a hole in it is caught before it is written", () => {
    const m = {
      formatVersion: 1, id: "item-1", slot: "head", attached: [{ attachment: 11, manifest: "m" }], collections: {}, bodyLayers: [{ section: 1, key: "objects/l.ktx2", bytes: 1 }], geosetGroups: {},
      models: { m: { glb: { key: "objects/g.glb", bytes: 1 }, textures: [{ key: "objects/t.ktx2" }, { key: "" }], clips: [{ key: "objects/c.glb" }] } },
    } as never;
    expect(objectsOfItem(m).sort()).toEqual(["objects/c.glb", "objects/g.glb", "objects/l.ktx2", "objects/t.ktx2"]);
    const store = bucket({ "objects/g.glb": true, "objects/t.ktx2": false, "objects/l.ktx2": true });
    expect(failedObjects(store, objectsOfItem(m)).sort()).toEqual(["objects/c.glb", "objects/t.ktx2"]);
    expect(hasAnyPart(m)).toBe(true);
    expect(hasAnyPart({ attached: [], collections: {}, bodyLayers: [] } as never)).toBe(false);
  });

  it("works on the real budget store too", async () => {
    const store = new BudgetStore({ name: "x", stat: async () => null, get: async () => null, put: async () => undefined, list: async () => [], remove: async () => undefined });
    await store.open();
    expect(failedObjects(store, ["objects/none.glb"])).toEqual(["objects/none.glb"]);
  });
});

describe("mounts", () => {
  it("retail's creature geosets: 1..3299 hide, each row shows its value", () => {
    const ids = [0, 101, 102, 201, 3300];
    expect([...creatureGeosets(ids, 0, [])]).toEqual(ids);
    expect([...creatureGeosets(ids, 5, [{ index: 0, value: 2 }])]).toEqual([0, 102, 3300]);
  });

  it("a character-model mount shows its choices and what no choice owns", () => {
    expect([...chrGeosets([0, 5, 101, 102, 3301], new Set([102, 3301]))]).toEqual([0, 5, 102, 3301]);
  });

  it("two displays with one look are one colour", () => {
    expect(lookKey({ m2: 1, skins: [1, 2, 3, 4], extra: 0 }, [])).toBe(lookKey({ m2: 1, skins: [1, 2, 3, 4], extra: 0 }, []));
    expect(lookKey({ m2: 1, skins: [1, 2, 3, 4], extra: 0 }, [])).not.toBe(lookKey({ m2: 1, skins: [9, 2, 3, 4], extra: 0 }, []));
  });
});

describe("what is worth storing", () => {
  it("a body keeps what a viewer plays and drops the internal", () => {
    for (const [id, want] of [[0, true], [4, true], [5, true], [26, true], [69, true]] as const) expect(bodyClipWanted(id)).toBe(want);
    expect(mountClipWanted(0, 0)).toBe(true);
    expect(mountClipWanted(0, 2)).toBe(true);
    expect(mountClipWanted(4, 0)).toBe(true);
    expect(mountClipWanted(26, 0)).toBe(false);
  });
});

describe("the UI atlas", () => {
  it("nothing overlaps, and a gutter keeps neighbours from bleeding in", () => {
    const sizes = Array.from({ length: 40 }, (_, i) => ({ name: `s${i}`, w: 20 + (i % 7) * 13, h: 10 + (i % 5) * 9 }));
    const { rects, width, height } = shelfPack(sizes, 200, 2);
    const list = Object.values(rects);
    expect(list).toHaveLength(40);
    expect(width).toBeLessThanOrEqual(200);
    for (const r of list) {
      expect(r.x + r.w).toBeLessThanOrEqual(width);
      expect(r.y + r.h).toBeLessThanOrEqual(height);
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i]!, list[j]!];
        const apart = a.x + a.w + 2 <= b.x || b.x + b.w + 2 <= a.x || a.y + a.h + 2 <= b.y || b.y + b.h + 2 <= a.y;
        expect(apart).toBe(true);
      }
    }
  });
});
