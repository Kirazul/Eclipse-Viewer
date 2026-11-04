import type { BakeContext } from "../bake/context";
import { type Row, byId, groupBy, num } from "../db2/db2";

/**
 * A character-model mount, resolved as retail does: port of Eclipse's
 * tools/retailmounts/mount_chr.py. The Dragonriding drakes, the Rostrum bodies and the
 * customizable panthers are ChrModel rows, and their look is a choice per option:
 *
 *   choices   the display's CreatureDisplayInfoExtra lists them; a display with no Extra
 *             that is a ChrModel's own wears the model's default (flag 0x10, else the first)
 *   geosets   every chosen element's, the eyes 3301 unless a choice owns group 33
 *   textures  per M2 texture type, the chosen materials its layers name. Type 1 is the
 *             composite retail ships baked when the Extra has BakeMaterialResources.
 */
const DEFAULT_FLAG = 0x10;
const EYES = 3301;

export interface ChrLook {
  geosets: Set<number>;
  /** M2 texture type -> what paints it, in layer order. */
  textures: Map<number, { kind: "bake" | "file"; fdid: number } | { kind: "composite"; layers: [blend: number, fdid: number][] }>;
  how: string;
}

interface ChrTables {
  displays: Map<string, Row>;
  extras: Map<string, Row>;
  optionsOfExtra: Map<string, Row[]>;
  options: Map<string, Row>;
  optionsOfModel: Map<string, Row[]>;
  choices: Map<string, Row>;
  choicesOfOption: Map<string, Row[]>;
  elements: Map<string, Row[]>;
  geosets: Map<string, Row>;
  materials: Map<string, Row>;
  textures: Map<string, Row[]>;
  chrModels: Map<string, Row>;
  chrModelOfDisplay: Map<string, Row>;
  layers: Map<string, Row[]>;
}

const memo = new WeakMap<object, Promise<ChrTables>>();

function tablesOf(ctx: BakeContext): Promise<ChrTables> {
  let hit = memo.get(ctx.db);
  if (!hit) {
    hit = (async () => {
      const db = ctx.db;
      const options = await db.table("ChrCustomizationOption");
      const choices = await db.table("ChrCustomizationChoice");
      const chrModels = await db.table("ChrModel");
      return {
        displays: byId(await db.table("CreatureDisplayInfo")),
        extras: byId(await db.table("CreatureDisplayInfoExtra")),
        optionsOfExtra: groupBy(await db.table("CreatureDisplayInfoOption"), "CreatureDisplayInfoExtraID"),
        options: byId(options),
        optionsOfModel: groupBy(options, "ChrModelID"),
        choices: byId(choices),
        choicesOfOption: groupBy(choices, "ChrCustomizationOptionID"),
        elements: groupBy(await db.table("ChrCustomizationElement"), "ChrCustomizationChoiceID"),
        geosets: byId(await db.table("ChrCustomizationGeoset")),
        materials: byId(await db.table("ChrCustomizationMaterial")),
        textures: groupBy(await db.table("TextureFileData"), "MaterialResourcesID"),
        chrModels: byId(chrModels),
        chrModelOfDisplay: new Map(chrModels.map((r) => [r.DisplayID ?? "", r])),
        layers: groupBy(await db.table("ChrModelTextureLayer"), "CharComponentTextureLayoutsID"),
      };
    })();
    memo.set(ctx.db, hit);
  }
  return hit;
}

function defaultChoice(t: ChrTables, optionId: string): Row | undefined {
  const list = (t.choicesOfOption.get(optionId) ?? []).slice().sort((a, b) => num(a.OrderIndex) - num(b.OrderIndex) || num(a.ID) - num(b.ID));
  return list.find((c) => (num(c.Flags) & DEFAULT_FLAG) !== 0) ?? list[0];
}

/** Null: a creature display. Throws when retail's look needs what this does not port. */
export async function resolveChrLook(ctx: BakeContext, display: number): Promise<ChrLook | null> {
  const t = await tablesOf(ctx);
  const c = t.displays.get(String(display));
  if (!c) return null;
  const ext = c.ExtendedDisplayInfoID ?? "0";
  const rows = ext !== "0" && ext !== "" ? t.optionsOfExtra.get(ext) ?? [] : [];
  let model: string;
  const chosen = new Set<string>();
  let how: string;
  if (rows.length) {
    const ids = new Set(rows.map((r) => t.options.get(r.ChrCustomizationOptionID ?? "")?.ChrModelID ?? ""));
    if (ids.size !== 1) throw new Error(`display ${display}: its options span ${ids.size} ChrModels`);
    model = [...ids][0]!;
    for (const r of rows) chosen.add(r.ChrCustomizationChoiceID ?? "");
    how = `extra ${ext} options`;
  } else {
    const own = t.chrModelOfDisplay.get(String(display));
    if (!own) return null;
    model = own.ID ?? "";
    for (const o of t.optionsOfModel.get(model) ?? []) {
      const d = defaultChoice(t, o.ID ?? "");
      if (d) chosen.add(d.ID ?? "");
    }
    how = `ChrModel ${model} defaults`;
  }

  const order = (choice: string): [number, number, number] => {
    const o = t.options.get(t.choices.get(choice)?.ChrCustomizationOptionID ?? "");
    return [num(o?.OrderIndex), num(o?.ID), num(choice)];
  };
  const ordered = [...chosen].sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  const geosets = new Set<number>();
  const mats = new Map<number, number>();
  for (const ch of ordered) {
    for (const e of t.elements.get(ch) ?? []) {
      const rel = e.RelatedChrCustomizationChoiceID ?? "0";
      if (rel !== "0" && rel !== "" && !chosen.has(rel)) continue;
      for (const k of ["ChrCustomizationSkinnedModelID", "ChrCustomizationBoneSetID", "ChrCustomizationCondModelID"]) {
        if (num(e[k])) throw new Error(`display ${display} choice ${ch} uses ${k}, not ported`);
      }
      const geo = t.geosets.get(e.ChrCustomizationGeosetID ?? "");
      if (geo) geosets.add(num(geo.GeosetType) * 100 + num(geo.GeosetID));
      const mat = t.materials.get(e.ChrCustomizationMaterialID ?? "");
      if (mat) {
        const diffuse = (t.textures.get(mat.MaterialResourcesID ?? "") ?? []).filter((f) => num(f.UsageType) === 0).map((f) => num(f.FileDataID)).sort((a, b) => a - b);
        if (!diffuse.length) throw new Error(`display ${display} material ${mat.ID} has no diffuse file`);
        // Options apply in retail's order: a later option's material for a target replaces an earlier one.
        mats.set(num(mat.ChrModelTextureTargetID), diffuse[0]!);
      }
    }
  }
  if (![...geosets].some((g) => Math.floor(g / 100) === 33)) geosets.add(EYES);

  const layout = t.chrModels.get(model)?.CharComponentTextureLayoutID ?? "";
  const byType = new Map<number, [layer: number, blend: number, fdid: number][]>();
  for (const l of t.layers.get(layout) ?? []) {
    for (const col of ["ChrModelTextureTargetID_0", "ChrModelTextureTargetID_1"]) {
      const tgt = num(l[col]);
      const fdid = tgt ? mats.get(tgt) : undefined;
      if (!fdid) continue;
      const type = num(l.TextureType);
      const list = byType.get(type);
      const row: [number, number, number] = [num(l.Layer), num(l.BlendMode), fdid];
      if (list) list.push(row);
      else byType.set(type, [row]);
    }
  }
  const bakeRes = t.extras.get(ext)?.BakeMaterialResourcesID ?? "0";
  const bake = bakeRes !== "0" && bakeRes !== "" ? num((t.textures.get(bakeRes) ?? []).find((f) => num(f.UsageType) === 0)?.FileDataID) : 0;
  const textures: ChrLook["textures"] = new Map();
  for (const [type, list] of byType) {
    list.sort((a, b) => a[0] - b[0]);
    if (type === 1 && bake) textures.set(type, { kind: "bake", fdid: bake });
    else if (list.length === 1) textures.set(type, { kind: "file", fdid: list[0]![2] });
    else textures.set(type, { kind: "composite", layers: list.map((x) => [x[1], x[2]]) });
  }
  if (!textures.has(1) && bake) textures.set(1, { kind: "bake", fdid: bake });
  return { geosets, textures, how };
}
