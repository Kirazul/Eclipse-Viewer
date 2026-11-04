import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CustomOption, type CustomizationData, GATED_NONE, classTag, decodeLook, encodeLook, lookBoneSets, lookGeosets, lookPaint, lookParts, randomLook, settleLook } from "@eclipse/format";
import { describe, expect, it } from "vitest";
import { boneMatrix, boneSetMatrices, mergeBoneSets, readBoneFile } from "../src/m2/bone";
import { type RawOption, firstLook, loadTree, pruneColourRows } from "../src/chr/tree";
import { Db2 } from "../src/db2/db2";
import { LOCAL_PACKS, WORK } from "../src/lib/env";

/** A small body: the rules, with no game data. */
const choice = (id: number, extra: Partial<CustomOption["choices"][number]> = {}) => ({ id, name: "", req: 3, cls: -1, ...extra });
const data = (options: CustomOption[], over: Partial<CustomizationData> = {}): CustomizationData => ({
  formatVersion: 1,
  id: "t",
  chrModel: 1,
  tabs: [],
  options,
  textures: [],
  boneSets: [],
  layers: [],
  modelTextures: [],
  baseMats: [],
  parts: [],
  owned: [0, 7, 14, 17, 22, 32, 33, 51, 60],
  has: [0, 2, 3, 401, 402, 501, 701, 702, 703, 1301, 1401, 1701, 1801, 2001, 2002, 2201, 3201, 3202, 3203, 3301, 3401, 5101],
  width: 1024,
  height: 512,
  ...over,
});

describe("the geosets a look shows", () => {
  const owned = [0, 7, 14, 17, 22, 32, 33, 34, 51, 60];
  const hair: CustomOption = { id: 1, name: "Hair Style", tab: 2, choices: [choice(10, { geo: [[0, 0, 0]] }), choice(11, { geo: [[0, 2, 0]] }), choice(12, { geo: [[0, 3, 0]] })] };

  it("shows retail's equipped defaults where no option decides, and no under-helm caps", () => {
    const d = data([hair], { owned });
    const g = lookGeosets(d, { 1: 11 });
    for (const id of [0, 2, 401, 501, 702, 1301, 1801, 2001, 2201, 3202, 3301, 5101]) expect(g.has(id), `geoset ${id}`).toBe(true);
    // 3201 is the head cap under a helm, 1701 a Death Knight's glow, 1401 the Demon Hunter's loincloth.
    for (const id of [3, 3201, 3203, 1401, 1701, 402, 701, 703]) expect(g.has(id), `geoset ${id}`).toBe(false);
  });

  it("a value of 0 hides the group; the bare body stays", () => {
    const g = lookGeosets(data([hair], { owned }), { 1: 10 });
    expect(g.has(0)).toBe(true);
    expect(g.has(2)).toBe(false);
    expect(g.has(3)).toBe(false);
  });

  it("drops what the skin doesn't carry", () => {
    const d = data([{ id: 1, name: "Ears", tab: 2, choices: [choice(10, { geo: [[7, 9, 0]] })] }], { owned });
    expect(lookGeosets(d, { 1: 10 }).has(709)).toBe(false);
  });

  it("an element waits for its related choice", () => {
    const o: CustomOption[] = [
      { id: 1, name: "a", tab: 2, choices: [choice(10), choice(11)] },
      { id: 2, name: "b", tab: 2, choices: [choice(20, { geo: [[7, 3, 11]] })] },
    ];
    expect(lookGeosets(data(o, { owned }), { 1: 10, 2: 20 }).has(703)).toBe(false);
    expect(lookGeosets(data(o, { owned }), { 1: 11, 2: 20 }).has(703)).toBe(true);
  });

  it("a choice's own foot shape replaces the bare foot", () => {
    const d = data([{ id: 1, name: "Foot", tab: 2, choices: [choice(10), choice(11, { geo: [[20, 2, 0]] })] }], { owned: [...owned, 20] });
    expect(lookGeosets(d, { 1: 10 }).has(2001)).toBe(true);
    const clawed = lookGeosets(d, { 1: 11 });
    expect(clawed.has(2002)).toBe(true);
    expect(clawed.has(2001)).toBe(false);
  });
});

describe("what a look paints", () => {
  const layers = [{ target: 1, rect: { x: 0, y: 0, w: 1024, h: 512 }, blend: 1, role: 0 }, { target: 5, rect: { x: 512, y: 0, w: 512, h: 512 }, blend: 15, role: 0 }, { target: 13, rect: { x: 256, y: 192, w: 256, h: 128 }, blend: 15, role: 1 }];

  it("takes elements whose related choice is worn, a later option over an earlier", () => {
    const o: CustomOption[] = [
      { id: 1, name: "Skin", tab: 2, choices: [choice(1, { mat: [[1, 100, 0, -1], [5, 900, 0, -1]] }), choice(2, { mat: [[1, 101, 0, -1]] })] },
      { id: 2, name: "Face", tab: 2, choices: [choice(20, { mat: [[5, 200, 1, -1], [5, 201, 2, -1]] })] },
    ];
    const p = lookPaint(data(o, { layers }), { 1: 2, 2: 20 });
    expect(p.mats.get(1)).toBe(101);
    expect(p.mats.get(5)).toBe(201);
  });

  it("a colour whose family doesn't fit the style draws its place in the family that does", () => {
    const o: CustomOption[] = [
      { id: 1, name: "Style", tab: 2, choices: [choice(10), choice(11)] },
      { id: 2, name: "Colour", tab: 2, choices: [choice(20, { needs: [10], mat: [[10, 500, 0, -1]] }), choice(21, { needs: [10], mat: [[10, 501, 0, -1]] }), choice(30, { needs: [11], mat: [[10, 600, 0, -1]] }), choice(31, { needs: [11], mat: [[10, 601, 0, -1]] })] },
    ];
    const d = data(o, { layers: [] });
    expect(lookPaint(d, { 1: 10, 2: 21 }).mats.get(10)).toBe(501);
    // The straight colour 21 on the wavy style 11: the second colour of that family.
    expect(lookPaint(d, { 1: 11, 2: 21 }).mats.get(10)).toBe(601);
  });

  it("a shape is drawn whatever its colour option says", () => {
    const o: CustomOption[] = [
      { id: 1, name: "Tattoo", tab: 2, choices: [choice(10), choice(11, { mat: [] }), choice(12)] },
      { id: 2, name: "Tattoo Color", tab: 2, choices: [choice(20), choice(21, { sw: ["#ff0000"], mat: [[16, 700, 11, -1]] }), choice(22, { sw: ["#00ff00"], mat: [[16, 701, 11, -1], [16, 702, 12, -1]] })] },
    ];
    const d = data(o);
    // Colour on None, shape worn: the shape's first colour.
    expect(lookPaint(d, { 1: 11, 2: 20 }).mats.get(16)).toBe(700);
    // The shape worn off: nothing at all.
    expect(lookPaint(d, { 1: 10, 2: 20 }).mats.has(16)).toBe(false);
  });

  it("the underwear is never left off", () => {
    const o: CustomOption[] = [{ id: 1, name: "Skin", tab: 2, choices: [choice(1, { mat: [[1, 100, 0, -1], [13, 300, 0, -1]] }), choice(2, { mat: [[1, 101, 0, -1]] })] }];
    expect(lookPaint(data(o, { layers }), { 1: 2 }).mats.get(13)).toBe(300);
  });

  it("the glow is what's drawn's own emissive art", () => {
    const o: CustomOption[] = [{ id: 1, name: "Tattoo", tab: 2, choices: [choice(1, { mat: [[16, 100, 0, 200]] }), choice(2, { mat: [[16, 101, 0, -1]] })] }];
    expect(lookPaint(data(o), { 1: 1 }).emissive.get(16)).toBe(200);
    expect(lookPaint(data(o), { 1: 2 }).emissive.size).toBe(0);
  });
});

describe("skinned parts", () => {
  const parts = [{ manifest: "p", owned: [25, 26], has: [2501, 2502, 2601] }];
  it("an option on None never hides another option's shape", () => {
    const o: CustomOption[] = [
      { id: 1, name: "Blindfold", tab: 2, choices: [choice(10, { pgeo: [[0, 25, 0, 0]] }), choice(11, { pgeo: [[0, 25, 2, 0]] })] },
      { id: 2, name: "Blindfold Color", tab: 2, choices: [choice(20, { pgeo: [[0, 25, 0, 0]] })] },
    ];
    const d = data(o, { parts });
    expect([...lookParts(d, { 1: 11, 2: 20 }).get(0)!]).toEqual([2502]);
    expect(lookParts(d, { 1: 10, 2: 20 }).size).toBe(0);
  });
});

describe("choosing", () => {
  const options: CustomOption[] = [
    { id: 1, name: "Hair Style", tab: 2, choices: [choice(10, { name: "Bald", geo: [[0, 0, 0]] }), choice(11, { name: "Peasant", geo: [[0, 2, 0]] })] },
    { id: 2, name: "Beard", tab: 2, choices: [choice(20, { name: "None", geo: [[1, 0, 0]] }), choice(21, { name: "Goatee", geo: [[1, 2, 0]] })] },
    { id: 3, name: "Eye Style", tab: 3, gated: true, choices: [choice(GATED_NONE | 3, { name: "None", req: 0, cls: 0 }), choice(30, { name: "Slit", req: 2, cls: 0 })] },
    { id: 4, name: "Eye Color", tab: 3, choices: [choice(40, { req: 3, cls: 32, name: "Death Knight" }), choice(41, { req: 3, cls: -1 }), choice(42, { req: 2, cls: 0, name: "Unlock" }), choice(43, { req: 3, cls: 32735, name: "All but DK" })] },
    { id: 5, name: "Upright", tab: 5, choices: [choice(50, { body: "orc-male" }), choice(51, { body: "orcupright-male" })] },
  ];

  it("the first look has hair and a beard, a gated option unset, no class's choice, and its body's posture", () => {
    const look = firstLook(options, "orcupright-male");
    expect(look[1]).toBe(11);
    expect(look[2]).toBe(21);
    expect(look[3]).toBe(GATED_NONE | 3);
    expect(look[4]).toBe(41);
    expect(look[5]).toBe(51);
    expect(firstLook(options, "orc-male")[5]).toBe(50);
  });

  it("retail's default flag wins", () => {
    const o: CustomOption[] = [{ id: 1, name: "Horns", tab: 2, choices: [choice(10), choice(11, { flags: 0x10 })] }];
    expect(firstLook(o, "x")[1]).toBe(11);
  });

  it("Randomize deals only what any player can pick, and leaves a posture alone", () => {
    const seen = new Set<number>();
    let i = 0;
    for (let k = 0; k < 200; k++) {
      const l = randomLook(options, { 5: 51 }, () => ((i += 0.37) % 1));
      seen.add(l[4]!);
      expect(l[5]).toBe(51);
      expect(l[3]).toBeUndefined();
    }
    // 41 anyone, 43 every class but one; never the Death Knight's or the unlock.
    expect([...seen].sort()).toEqual([41, 43]);
  });

  it("names the class a choice is kept for, and not a mask that means nearly everyone", () => {
    expect(classTag(32)).toBe("Death Knight");
    expect(classTag(32 | 2048)).toBe("Death Knight or Demon Hunter");
    expect(classTag(-1)).toBe("");
    expect(classTag(0)).toBe("");
    expect(classTag(32735)).toBe("");
  });

  it("a shared link holds only what differs, and ignores what the body doesn't offer", () => {
    const defaults = firstLook(options, "orc-male");
    const look = { ...defaults, 1: 10, 4: 40 };
    const text = encodeLook(look, defaults);
    expect(text).toBe("1.10,4.40");
    expect(decodeLook(text, options, defaults)).toEqual(look);
    expect(decodeLook("1.999,77.3,garbage,4.40", options, defaults)).toEqual({ ...defaults, 4: 40 });
    expect(decodeLook(null, options, defaults)).toEqual(defaults);
    expect(settleLook(options, { 1: 999 })[1]).toBe(10);
  });

  it("wears a body's bone set per option, in order", () => {
    const o: CustomOption[] = [{ id: 1, name: "Face", tab: 2, choices: [choice(10, { bone: 3 })] }, { id: 2, name: "Jaw", tab: 2, choices: [choice(20, { bone: 1 })] }];
    expect(lookBoneSets(o, { 1: 10, 2: 20 })).toEqual([3, 1]);
  });
});

describe("a colour row lists colours", () => {
  const raw = (id: number, swatch: number, elems: RawOption["choices"][number]["elems"]) => ({ id, name: "", order: id, flags: 0, req: 3, cls: -1, needs: [], swatch: [swatch, 0] as [number, number], elems });
  it("drops a None that paints nothing where every colour waits on a shape", () => {
    const o: RawOption = { id: 1, name: "Tattoo Color", order: 1, category: 5, gated: false, choices: [raw(1, 0, []), raw(2, 0xff0000, [{ kind: "mat", target: 16, fdid: 5, cond: 9 }])] };
    pruneColourRows([o]);
    expect(o.choices.map((c) => c.id)).toEqual([2]);
  });
  it("keeps it where it is the row's own off switch", () => {
    const o: RawOption = { id: 1, name: "Highlights", order: 1, category: 5, gated: false, choices: [raw(1, 0, []), raw(2, 0xff0000, [{ kind: "mat", target: 16, fdid: 5, cond: 0 }])] };
    pruneColourRows([o]);
    expect(o.choices.map((c) => c.id)).toEqual([1, 2]);
  });
});

describe(".bone", () => {
  /** A chunked file, as retail lays it out. */
  const file = (ids: number[], mats: number[][]) => {
    const head = Buffer.alloc(4);
    head.writeUInt32LE(1, 0);
    const a = Buffer.alloc(8 + ids.length * 2);
    a.write("BIDA", 0, "latin1");
    a.writeUInt32LE(ids.length * 2, 4);
    ids.forEach((v, i) => a.writeUInt16LE(v, 8 + i * 2));
    const b = Buffer.alloc(8 + mats.length * 64);
    b.write("BOMT", 0, "latin1");
    b.writeUInt32LE(mats.length * 64, 4);
    mats.forEach((m, k) => m.forEach((v, i) => b.writeFloatLE(v, 8 + k * 64 + i * 4)));
    return Buffer.concat([head, a, b]);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  it("reads its chunks", () => {
    const e = readBoneFile(file([7, 9], [I, I]));
    expect(e.map((x) => x.bone)).toEqual([7, 9]);
    expect(e[1]!.m).toEqual(I);
  });

  it("is a no-op on identity, and leaves those entries out", () => {
    expect(boneSetMatrices(readBoneFile(file([0], [I])), { bones: [{ pivot: [1, 2, 3] }] })).toEqual([]);
  });

  it("a translation lands in the baker's axes: retail (x, y, z) reads (y, z, x)", () => {
    // Stored row-vector form: translation in the fourth row.
    const t = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.1, 0.2, 0.3, 1];
    const m = boneMatrix(t, [0, 0, 0]);
    expect(m.slice(12, 15)).toEqual([0.2, 0.3, 0.1]);
    expect(m[0]).toBe(1);
    expect(m[5]).toBe(1);
    expect(m[10]).toBe(1);
  });

  it("merges a later option's set on top: posed * first * later", () => {
    const shift = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
    const merged = mergeBoneSets([[[4, shift(1)]], [[4, shift(2)], [5, shift(3)]]]);
    expect(merged.map((e) => e[0])).toEqual([4, 5]);
    expect(merged[0]![1][12]).toBe(3);
  });
});

const fixture = join(import.meta.dirname, "fixtures", "golden-custom.json");
const hasGolden = existsSync(fixture) && existsSync(join(WORK, "db2", "12.1.0.69933", "ChrCustomizationBoneSet.csv"));

describe.skipIf(!hasGolden)("against Eclipse's own load_tree and mats_of", () => {
  const golden = hasGolden ? (JSON.parse(readFileSync(fixture, "utf8")) as Record<string, unknown>) : {};
  const db = new Db2();

  for (const model of [1, 2, 3, 53, 89, 10]) {
    it(`ChrModel ${model}: the same options, the same choices, in the same order`, async () => {
      const tree = await loadTree(db, model);
      pruneColourRows(tree);
      const got = tree.map((o) => ({ id: o.id, name: o.name, choices: o.choices.map((c) => c.id) }));
      expect(got).toEqual(golden[String(model)]);
    });
  }

  for (const body of ["human-male", "orcupright-male", "dracthyr-male"]) {
    const path = join(LOCAL_PACKS, "models", body, "manifest.json");
    it.skipIf(!existsSync(path))(`${body}: what a look paints, on Eclipse's random looks`, () => {
      const m = JSON.parse(readFileSync(path, "utf8")) as { customization: { key: string } };
      const data = JSON.parse(readFileSync(join(LOCAL_PACKS, ...m.customization.key.split("/")), "utf8")) as CustomizationData;
      const looks = (golden.looks as Record<string, { look: Record<string, number>; mats: Record<string, number> }[]>)[String(data.chrModel)]!;
      let compared = 0;
      for (const l of looks) {
        const look = Object.fromEntries(Object.entries(l.look).map(([k, v]) => [Number(k), v]));
        const paint = lookPaint(data, look);
        // Only what this body's model draws is carried; a target it can't draw isn't painted.
        const carried = new Set(data.layers.map((x) => x.target));
        for (const mt of data.modelTextures) for (const [t] of mt.layers) carried.add(t);
        for (const [target, fdid] of Object.entries(l.mats)) {
          if (!carried.has(Number(target))) continue;
          const tex = paint.mats.get(Number(target));
          expect(tex === undefined ? 0 : data.textures[tex]!.fileDataId, `target ${target} of ${JSON.stringify(l.look)}`).toBe(fdid);
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(50);
    });
  }
});
