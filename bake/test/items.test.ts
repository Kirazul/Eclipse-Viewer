import { describe, expect, it } from "vitest";
import { fileForBody, itemUnitId } from "../src/items/bake";
import { LINES, isPlaceholder } from "../src/items/lines";
import { ownedGeosets } from "@eclipse/format";
import { type ModelFile, type TextureFile, attachmentFor, facetOf, geosetFilter, isCombined, isSkinnedModel, padBits, pickTexture, slotOfDisplayType } from "../src/items/resolve";

const model = (over: Partial<ModelFile> = {}): ModelFile => ({ k: 0, fdid: 1, race: 0, sex: 3, classId: 0, position: -1, ...over });
const tex = (over: Partial<TextureFile> = {}): TextureFile => ({ fdid: 1, usage: 0, race: 0, sex: 3, classId: 0, ...over });

describe("slots", () => {
  it("maps ItemAppearance.DisplayType as retail's enum does", () => {
    expect(slotOfDisplayType(0)).toBe("head");
    expect(slotOfDisplayType(3)).toBe("chest");
    expect(slotOfDisplayType(9)).toBe("back");
    expect(slotOfDisplayType(11)).toBe("mainhand");
    expect(slotOfDisplayType(15)).toBe("offhand");
    expect(slotOfDisplayType(99)).toBeNull();
  });

  it("reads the armour facet", () => {
    expect(facetOf(4, 1)).toBe("cloth");
    expect(facetOf(4, 4)).toBe("plate");
    expect(facetOf(4, 5)).toBe("none");
    expect(facetOf(2, 1)).toBeUndefined();
  });
});

describe("the geoset filter, port of midnight_build.py slot_filter", () => {
  const d = (agg: number[], override = 0) => ({ attachmentGroups: agg, groupOverride: override });

  it("on a combined model: a slot shows only its groups, at 1 + AGG", () => {
    const hands = geosetFilter(d([1, 0, 0, 0, 0, 0]), "hands", true);
    expect(hands.keep(402)).toBe(true); // group 4, AGG 1
    expect(hands.keep(401)).toBe(false);
    expect(hands.keep(2301)).toBe(true); // group 23, AGG 0
    expect(hands.keep(2201)).toBe(false); // the chest's part
    expect(hands.keep(5)).toBe(true); // ungrouped always draws
  });

  it("on a model one slot wears: everything else is its own", () => {
    const helm = geosetFilter(d([0, 0, 0, 0, 0, 0]), "head", false);
    expect(helm.keep(2701)).toBe(true);
    expect(helm.keep(2702)).toBe(false);
    expect(helm.keep(1401)).toBe(true);
  });

  it("the override lifts a one-slot model's variant, never a combined one's", () => {
    expect(geosetFilter(d([0, 0, 0, 0, 0, 0], 1), "shoulder", false).keep(2602)).toBe(true);
    expect(geosetFilter(d([0, 0, 0, 0, 0, 0], 1), "chest", true).keep(802)).toBe(false);
    expect(geosetFilter(d([0, 0, 0, 0, 0, 0], 1), "chest", true).keep(801)).toBe(true);
  });

  it("a negative AGG shows none of the group's variants on a combined model", () => {
    const f = geosetFilter(d([-1, 0, 0, 0, 0, 0]), "waist", true);
    expect(f.keep(1801)).toBe(false);
  });

  it("the tag changes with what shows, so two looks of one file are two models", () => {
    expect(geosetFilter(d([0, 0, 0, 0, 0, 0]), "chest", true).tag).not.toBe(geosetFilter(d([1, 0, 0, 0, 0, 0]), "chest", true).tag);
    expect(geosetFilter(d([0, 0, 0, 0, 0, 0]), "chest", true).tag).not.toBe(geosetFilter(d([0, 0, 0, 0, 0, 0]), "legs", true).tag);
  });
});

describe("pad bits, port of races_itemgeo.py pad_bits", () => {
  it("reads the flags the geoset builder reads", () => {
    expect(padBits(0x100000, [-1, -1])).toBe(1);
    expect(padBits(0x1000000, [-1, -1])).toBe(2);
    expect(padBits(0x2000000, [-1, -1])).toBe(4);
  });
  it("marks kind 0 models", () => {
    expect(padBits(0, [1, -1])).toBe(8);
    expect(padBits(0, [0, -1])).toBe(8);
    expect(padBits(0, [5, -1])).toBe(8);
    expect(padBits(0, [2, 1])).toBe(16);
  });
});

describe("placement", () => {
  it("uses retail's attachment ids", () => {
    expect(attachmentFor("head", model(), 1)).toBe(11);
    expect(attachmentFor("shoulder", model({ k: 0 }), 3)).toBe(6);
    expect(attachmentFor("shoulder", model({ k: 1 }), 3)).toBe(5);
    expect(attachmentFor("waist", model(), 6)).toBe(53);
    expect(attachmentFor("mainhand", model(), 13)).toBe(1);
    expect(attachmentFor("offhand", model(), 14)).toBe(0);
    expect(attachmentFor("offhand", model(), 23)).toBe(2);
    expect(attachmentFor("chest", model(), 5)).toBeNull();
  });

  it("ModelType 1 is skinned whatever the slot, 0 is pinned where a point exists", () => {
    expect(isSkinnedModel({ modelTypes: [1, -1] }, model(), "waist", 6)).toBe(true);
    expect(isSkinnedModel({ modelTypes: [0, -1] }, model(), "waist", 6)).toBe(false);
    expect(isSkinnedModel({ modelTypes: [0, -1] }, model(), "chest", 5)).toBe(true);
  });
});

describe("which file a body wears", () => {
  const files = [model({ fdid: 10, race: 1, sex: 0 }), model({ fdid: 11, race: 1, sex: 1 }), model({ fdid: 12, race: 2, sex: 0 }), model({ fdid: 20, race: 0, sex: 3 })];

  it("its race and sex, then a race-agnostic one", () => {
    expect(fileForBody(files, 1, 0)?.fdid).toBe(10);
    expect(fileForBody(files, 1, 1)?.fdid).toBe(11);
    expect(fileForBody(files, 99, 0)?.fdid).toBe(20);
    expect(fileForBody(files.slice(0, 2), 99, 0)).toBeUndefined();
  });

  it("passes over class-locked cuts", () => {
    expect(fileForBody([model({ fdid: 30, race: 1, sex: 0, classId: 12 }), model({ fdid: 31, race: 1, sex: 0 })], 1, 0)?.fdid).toBe(31);
  });
});

describe("which texture a slot wears", () => {
  it("prefers its race and sex, then any race, and takes diffuse over others", () => {
    const list = [tex({ fdid: 1, race: 2 }), tex({ fdid: 2, race: 0, sex: 1 }), tex({ fdid: 3, race: 0, sex: 0 }), tex({ fdid: 4, race: 1, sex: 0 })];
    expect(pickTexture(list, 1, 0)?.fdid).toBe(4);
    expect(pickTexture(list, 99, 1)?.fdid).toBe(2);
    expect(pickTexture([tex({ fdid: 8, usage: 2 }), tex({ fdid: 9, usage: 0 })], 0, 0)?.fdid).toBe(9);
    expect(pickTexture([], 0, 0)).toBeUndefined();
  });
});

describe("lines", () => {
  it("names the two item lines", () => {
    expect(LINES.midnight?.expansion).toBe(11);
    expect(LINES.warwithin?.expansion).toBe(10);
    expect(itemUnitId(698194)).toBe("item-698194");
  });
  it("leaves retail's placeholders out", () => {
    expect(isPlaceholder("[DNT] Test Set")).toBe(true);
    expect(isPlaceholder("[PH] thing")).toBe(true);
    expect(isPlaceholder("  ")).toBe(true);
    expect(isPlaceholder("Void Nemesis' Raiment")).toBe(false);
  });
});

describe("is a model file worn by more than one slot?", () => {
  /** Rows in table order: most rows naming a resource have no appearance at all. */
  const db = (rows: { id: string; res: number; displayType?: number }[]) =>
    ({
      where: async (table: string, column: string, value: string | number) => {
        if (table === "ItemDisplayInfo") return column === "ModelResourcesID_0" ? rows.filter((r) => r.res === value).map((r) => ({ ID: r.id })) : [];
        if (table === "ItemAppearance") return rows.filter((r) => r.id === value && r.displayType !== undefined).map((r) => ({ DisplayType: String(r.displayType) }));
        return [];
      },
    }) as never;

  it("finds the other slot past any number of rows with no appearance", async () => {
    // Display 740942's resource: 54 of its 78 rows have no appearance, and they come first.
    const rows = [
      ...Array.from({ length: 54 }, (_, i) => ({ id: `none-${i}`, res: 86614 })),
      { id: "gloves", res: 86614, displayType: 8 },
      { id: "chest", res: 86614, displayType: 3 },
    ];
    expect(await isCombined(db(rows), 86614, "hands")).toBe(true);
  });

  it("a file only this slot wears is not combined", async () => {
    const rows = [{ id: "a", res: 1, displayType: 0 }, { id: "b", res: 1 }, { id: "c", res: 1, displayType: 0 }];
    expect(await isCombined(db(rows), 1, "head")).toBe(false);
    expect(await isCombined(db(rows), 0, "head")).toBe(false);
  });
});

describe("what a slot shows of a combined model", () => {
  it("its own groups and ungrouped geometry, nothing of another slot", () => {
    expect(ownedGeosets([0, 401, 1101, 1301, 2001, 2201, 2301, 2801], "hands")).toEqual([0, 401, 2301]);
    expect(ownedGeosets([501, 1101, 2001, 2701], "head")).toEqual([2701]);
    expect(ownedGeosets([401, 1301, 1801], "wrist")).toEqual([]);
    // A slot with no rule leaves a model alone: a weapon's geosets are its own.
    expect(ownedGeosets([0, 401], "mainhand")).toEqual([0, 401]);
  });
});
