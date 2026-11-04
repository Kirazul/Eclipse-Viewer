import type { SlotId } from "@eclipse/format";
import type { Db2, Row } from "../db2/db2";
import { num } from "../db2/db2";

/**
 * One item display, resolved through retail's tables as Eclipse's
 * tools/midnight/midnight_plan.py walks them:
 *   ModelResourcesID_k -> ModelFileData -> ComponentModelFileData (race, sex, class, position)
 *   ModelMaterialResourcesID_k -> TextureFileData -> ComponentTextureFileData
 *   ItemDisplayInfoModelMatRes: extra model textures, by TextureType and ModelIndex
 *   ItemDisplayInfoMaterialRes: body textures, by ComponentSection
 */

/** ItemAppearance.DisplayType -> slot. */
const DISPLAY_SLOT: Record<number, SlotId> = {
  0: "head", 1: "shoulder", 2: "shirt", 3: "chest", 4: "waist", 5: "legs", 6: "feet", 7: "wrist", 8: "hands",
  9: "back", 10: "tabard", 11: "mainhand", 12: "offhand", 13: "ranged", 14: "offhand", 15: "offhand",
};

export function slotOfDisplayType(t: number): SlotId | null {
  return DISPLAY_SLOT[t] ?? null;
}

/** Armour facet from Item.ClassID/SubclassID. */
export function facetOf(classId: number, subclass: number): string | undefined {
  if (classId !== 4) return undefined;
  return { 1: "cloth", 2: "leather", 3: "mail", 4: "plate" }[subclass] ?? "none";
}

export interface ModelFile {
  /** Which ModelResourcesID_k named it. */
  k: number;
  fdid: number;
  /** 0: race-agnostic, no ComponentModelFileData row. */
  race: number;
  /** 0 male, 1 female, anything else both. */
  sex: number;
  classId: number;
  /** ComponentModelFileData.PositionIndex: 0 left, 1 right, -1 none. */
  position: number;
}

export interface TextureFile {
  fdid: number;
  usage: number;
  race: number;
  sex: number;
  classId: number;
}

export interface ResolvedDisplay {
  id: number;
  row: Row;
  flags: number;
  modelTypes: [number, number];
  geosetGroups: number[];
  /** AttachmentGeosetGroup_0..5: picks the variants of an item's own model. */
  attachmentGroups: number[];
  groupOverride: number;
  helmetVis: [number, number];
  models: ModelFile[];
  /** ModelMaterialResourcesID_k's files, by k. */
  modelTextures: TextureFile[][];
  /** ItemDisplayInfoModelMatRes: extra textures per (TextureType, ModelIndex). */
  extraTextures: { type: number; modelIndex: number; files: TextureFile[] }[];
  sections: { section: number; files: TextureFile[] }[];
}

async function textureFiles(db: Db2, materialRes: number): Promise<TextureFile[]> {
  if (!materialRes) return [];
  const out: TextureFile[] = [];
  for (const t of await db.where("TextureFileData", "MaterialResourcesID", materialRes)) {
    const fdid = num(t.FileDataID);
    const c = (await db.where("ComponentTextureFileData", "ID", fdid))[0];
    out.push({ fdid, usage: num(t.UsageType), race: c ? num(c.RaceID) : 0, sex: c ? num(c.GenderIndex) : 3, classId: c ? num(c.ClassID) : 0 });
  }
  return out;
}

export async function resolveDisplay(db: Db2, displayId: number): Promise<ResolvedDisplay> {
  const row = (await db.where("ItemDisplayInfo", "ID", displayId))[0];
  if (!row) throw new Error(`ItemDisplayInfo has no row ${displayId}`);
  const models: ModelFile[] = [];
  for (const k of [0, 1]) {
    const res = num(row[`ModelResourcesID_${k}`]);
    if (!res) continue;
    for (const f of await db.where("ModelFileData", "ModelResourcesID", res)) {
      const fdid = num(f.FileDataID);
      const c = (await db.where("ComponentModelFileData", "ID", fdid))[0];
      models.push({ k, fdid, race: c ? num(c.RaceID) : 0, sex: c ? num(c.GenderIndex) : 3, classId: c ? num(c.ClassID) : 0, position: c ? num(c.PositionIndex) : -1 });
    }
  }
  const modelTextures: TextureFile[][] = [];
  for (const k of [0, 1]) modelTextures.push(await textureFiles(db, num(row[`ModelMaterialResourcesID_${k}`])));
  const extraTextures: ResolvedDisplay["extraTextures"] = [];
  for (const mm of await db.where("ItemDisplayInfoModelMatRes", "ItemDisplayInfoID", displayId)) {
    extraTextures.push({ type: num(mm.TextureType), modelIndex: num(mm.ModelIndex), files: await textureFiles(db, num(mm.MaterialResourcesID)) });
  }
  const sections: ResolvedDisplay["sections"] = [];
  for (const sm of await db.where("ItemDisplayInfoMaterialRes", "ItemDisplayInfoID", displayId)) {
    sections.push({ section: num(sm.ComponentSection), files: await textureFiles(db, num(sm.MaterialResourcesID)) });
  }
  return {
    id: displayId,
    row,
    flags: num(row.Flags),
    modelTypes: [num(row.ModelType_0), num(row.ModelType_1)],
    geosetGroups: [0, 1, 2, 3, 4, 5].map((i) => num(row[`GeosetGroup_${i}`])),
    attachmentGroups: [0, 1, 2, 3, 4, 5].map((i) => num(row[`AttachmentGeosetGroup_${i}`])),
    groupOverride: num(row.GeosetGroupOverride),
    helmetVis: [num(row.HelmetGeosetVis_0), num(row.HelmetGeosetVis_1)],
    models,
    modelTextures,
    extraTextures,
    sections,
  };
}

// Retail ItemDisplayInfo.Flags the geoset builder reads (RetailGeo.h, races_itemgeo.py).
const KEEP_FOOT = 0x100000;
const CHEST_SLEEVES = 0x1000000;
const GLOVE_SLEEVES = 0x2000000;

/** The geoset rule's pad byte: its flags, and whether each model is "kind 0" for the wrist rule. */
export function padBits(flags: number, modelTypes: readonly [number, number]): number {
  const [mt0, mt1] = modelTypes;
  let p = 0;
  if (flags & KEEP_FOOT) p |= 1;
  if (flags & CHEST_SLEEVES) p |= 2;
  if (flags & GLOVE_SLEEVES) p |= 4;
  if (mt0 === 1 || mt0 === 0 || mt0 >= 5) p |= 8;
  if (mt1 === 1) p |= 16;
  return p;
}

/**
 * The texture a model slot wears. Prefers a file for this race and sex, then for the
 * sex, then any: a slot with one file names it whatever its row says.
 */
export function pickTexture(files: TextureFile[], race: number, sex: number): TextureFile | undefined {
  const diffuse = files.filter((f) => f.usage === 0);
  const pool = diffuse.length ? diffuse : files;
  const sexOk = (f: TextureFile) => f.sex !== 0 && f.sex !== 1 ? true : f.sex === sex;
  return pool.find((f) => f.race === race && sexOk(f)) ?? pool.find((f) => f.race === 0 && sexOk(f)) ?? pool.find(sexOk) ?? pool[0];
}

/** Which geoset group a slot owns, and which AttachmentGeosetGroup column drives it. */
const SLOT_GROUPS: Partial<Record<SlotId, readonly (readonly [number, number])[]>> = {
  head: [[27, 0], [21, 1]],
  shoulder: [[26, 0]],
  chest: [[8, 0], [10, 1], [13, 2], [22, 3], [28, 4]],
  shirt: [[8, 0], [10, 1]],
  legs: [[11, 0], [9, 1], [13, 2]],
  hands: [[4, 0], [23, 1]],
  feet: [[5, 0], [20, 1]],
  waist: [[18, 0]],
  back: [[15, 0]],
  tabard: [[12, 0]],
  wrist: [],
};

export interface GeosetFilter {
  /** Goes into the model's id: two filters are two looks of one file. */
  tag: string;
  keep(submeshId: number): boolean;
}

/**
 * Which submeshes of an item's own model show. Port of midnight_build.py slot_filter
 * and attachment_want, whose rules were measured on every Midnight display:
 *  - On a combined collection model (one file shared by several slots) a group the
 *    slot owns shows group*100 + 1 + AGG, and other slots' groups are dropped.
 *  - On a model only one slot wears (helm, shoulder, buckle), a group it owns shows
 *    x01 + max(AGG, GeosetGroupOverride), and the rest is its own.
 * Ungrouped geometry (id under 100) always draws.
 */
export function geosetFilter(d: Pick<ResolvedDisplay, "attachmentGroups" | "groupOverride">, slot: SlotId, combined: boolean): GeosetFilter {
  const want = new Map<number, number>();
  const override = Math.max(0, d.groupOverride);
  for (const [group, col] of SLOT_GROUPS[slot] ?? []) {
    const agg = d.attachmentGroups[col] ?? 0;
    if (agg < 0) continue;
    want.set(group, group * 100 + 1 + (combined ? agg : Math.max(agg, override)));
  }
  const tag = `${slot}:${[...want.values()].sort((a, b) => a - b).join(",")}:${combined ? 1 : 0}`;
  return {
    tag,
    keep(id) {
      if (id < 100) return true;
      const g = Math.floor(id / 100);
      const w = want.get(g);
      return w !== undefined ? w === id : !combined;
    },
  };
}

/** Does more than one slot wear this ModelResources? Stops at the first proof. */
export async function isCombined(db: Db2, res: number, slot: SlotId, limit = 8): Promise<boolean> {
  if (!res) return false;
  let looked = 0;
  for (const k of [0, 1]) {
    for (const row of await db.where("ItemDisplayInfo", `ModelResourcesID_${k}`, res)) {
      if (looked++ >= limit) return false;
      const app = (await db.where("ItemAppearance", "ItemDisplayInfoID", row.ID ?? ""))[0];
      if (!app) continue;
      const other = slotOfDisplayType(num(app.DisplayType));
      if (other && other !== slot) return true;
    }
  }
  return false;
}

/**
 * Attachment points by slot: M2 attachment ids (races_outfit.py and midnight_build.py:
 * helm 11, left shoulder 6, right 5, belt buckle 53). Null: not pinned to a point.
 */
export function attachmentFor(slot: SlotId, m: ModelFile, inventoryType: number): number | null {
  switch (slot) {
    case "head":
      return 11;
    case "shoulder":
      return m.k === 1 ? 5 : 6;
    case "waist":
      return 53;
    case "mainhand":
      return 1;
    case "ranged":
      return inventoryType === 15 ? 2 : 1;
    case "offhand":
      // A shield straps to the arm; anything else is held.
      return inventoryType === 14 ? 0 : 2;
    default:
      return null;
  }
}

/** ModelType 1 is a skinned collection, whatever the slot. Measured on a Midnight set. */
export function isSkinnedModel(d: Pick<ResolvedDisplay, "modelTypes">, m: ModelFile, slot: SlotId, inventoryType: number): boolean {
  if (d.modelTypes[m.k] === 1) return true;
  return attachmentFor(slot, m, inventoryType) === null;
}
