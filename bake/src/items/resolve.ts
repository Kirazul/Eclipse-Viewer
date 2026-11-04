import { SLOT_GEOSET_GROUPS, type SlotId } from "@eclipse/format";
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
// Measured on Item + ItemModifiedAppearance + ItemAppearance at the pinned build: shields are
// type 13 (2,946 rows), bows, guns, crossbows and wands type 12 (4,169). Not the other way round.
const DISPLAY_SLOT: Record<number, SlotId> = {
  0: "head", 1: "shoulder", 2: "shirt", 3: "chest", 4: "waist", 5: "legs", 6: "feet", 7: "wrist", 8: "hands",
  9: "back", 10: "tabard", 11: "mainhand", 12: "ranged", 13: "offhand", 14: "offhand", 15: "offhand",
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
export function pickTexture(files: TextureFile[], race: number, sex: number, chain: readonly RaceSex[] = []): TextureFile | undefined {
  const diffuse = files.filter((f) => f.usage === 0);
  const pool = diffuse.length ? diffuse : files;
  const sexOk = (f: TextureFile, s = sex) => f.sex !== 0 && f.sex !== 1 ? true : f.sex === s;
  const own = pool.find((f) => f.race === race && sexOk(f));
  if (own) return own;
  for (const [r, s] of chain) {
    const hit = pool.find((f) => f.race === r && sexOk(f, s));
    if (hit) return hit;
  }
  return pool.find((f) => f.race === 0 && sexOk(f)) ?? pool.find((f) => sexOk(f)) ?? pool[0];
}

/** A race and sex: 0 male, 1 female. */
export type RaceSex = readonly [race: number, sex: number];

/**
 * The file a body wears, as retail 12.1 `sub_10005F080` picks it: this race and sex, then
 * ChrRaces' Male/FemaleModelFallback in turn, then a race-agnostic file. A class-locked
 * cut is passed over while anything else fits, and worn if nothing does: nothing in the
 * catalogue is locked to a class. Undefined: retail draws nothing here, and only a
 * donor can show it.
 */
export function fileForBody(models: ModelFile[], raceId: number, sex: number, chain: readonly RaceSex[] = []): ModelFile | undefined {
  const sexFits = (m: ModelFile, s: number) => m.sex === s || (m.sex !== 0 && m.sex !== 1);
  const look = (open: (m: ModelFile) => boolean): ModelFile | undefined => {
    const own = models.find((m) => open(m) && m.race === raceId && sexFits(m, sex));
    if (own) return own;
    for (const [r, s] of chain) {
      const hit = models.find((m) => open(m) && m.race === r && sexFits(m, s));
      if (hit) return hit;
    }
    return models.find((m) => open(m) && m.race === 0 && sexFits(m, sex));
  };
  return look((m) => m.classId === 0) ?? look(() => true);
}

/** Steps through a ChrRaces fallback column until it ends or comes back round. */
export function fallbackChain(start: RaceSex, step: (at: RaceSex) => RaceSex | null): RaceSex[] {
  const out: RaceSex[] = [];
  const seen = new Set([`${start[0]}.${start[1]}`]);
  let at = step(start);
  while (at && !seen.has(`${at[0]}.${at[1]}`)) {
    seen.add(`${at[0]}.${at[1]}`);
    out.push(at);
    at = step(at);
  }
  return out;
}

/** Item.SheatheType -> where it rests [main hand, off hand]: 0x4EAF5C, 0x4EAF48 in the 3.3.5 client. */
const SHEATH_POINTS: Record<number, readonly [number, number]> = {
  1: [26, 27], // over the shoulder
  2: [30, 31], // polearm, staff: from its balance point
  3: [32, 33], // the hip
  4: [28, 28], // a shield on the back
  // Retail's later types have no 3.3.5 slot: these rest as a hip weapon.
  6: [32, 33],
  7: [32, 33],
  8: [32, 33],
};

export function sheathPointsOf(sheatheType: number): readonly [number, number] | undefined {
  return SHEATH_POINTS[sheatheType];
}

/**
 * A TransformMatrix row as retail builds it (0x10012BAE0, Eclipse's
 * midnight_tables.transform_matrix): a rotation Rz(yaw) Ry(pitch) Rx(roll) x scale, and
 * Pos. Returned column-major in the baker's axes: retail (x, y, z) is baked (y, z, x).
 */
export function sheathMatrix(pos: readonly [number, number, number], yawDeg: number, pitchDeg: number, rollDeg: number, scale: number): number[] {
  const k = 0.017453292;
  const [y, p, r] = [yawDeg * k, pitchDeg * k, rollDeg * k];
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(y), Math.sin(y), Math.cos(p), Math.sin(p), Math.cos(r), Math.sin(r)];
  const Rz = [[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]];
  const Ry = [[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]];
  const Rx = [[1, 0, 0], [0, cr, -sr], [0, sr, cr]];
  const mul = (a: number[][], b: number[][]) => a.map((row) => [0, 1, 2].map((j) => row[0]! * b[0]![j]! + row[1]! * b[1]![j]! + row[2]! * b[2]![j]!));
  const R = mul(Rz, mul(Ry, Rx));
  // Baked axis i is retail axis map[i].
  const map = [1, 2, 0];
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 3; c++) {
    for (let row = 0; row < 3; row++) out[c * 4 + row] = R[map[row]!]![map[c]!]! * scale;
    out[12 + c] = pos[map[c]!]!;
  }
  out[15] = 1;
  return out;
}

const SLOT_GROUPS = SLOT_GEOSET_GROUPS;

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

/**
 * Does more than one slot wear this ModelResources? Stops at the first proof. Most rows
 * naming a resource have no appearance at all (a set's first hundred can be such rows),
 * so every one is read: stopping early called a set's combined model single-slot, and then
 * wearing its gloves drew the whole set.
 */
export async function isCombined(db: Db2, res: number, slot: SlotId): Promise<boolean> {
  if (!res) return false;
  for (const k of [0, 1]) {
    for (const row of await db.where("ItemDisplayInfo", `ModelResourcesID_${k}`, res)) {
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
