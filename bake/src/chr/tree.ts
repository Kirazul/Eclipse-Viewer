import { GATED_NONE, classTag, type CustomOption, type Look, REQ_ANY } from "@eclipse/format";
import { type Db2, byId, groupBy, num } from "../db2/db2";

/**
 * A body's customization tree, as retail authors it. Port of Eclipse's
 * tools/races/races_spec.py load_tree: every option retail authors for a body is
 * offered ("unlock everything, never drop anything"). The one drop is ReqType 4:
 * retail's "Transmog" placeholder choices, which have no art.
 */

/** ChrCustomizationReq.ReqType 4: retail's "Transmog" placeholder choices. */
const REQ_TRANSMOG_PLACEHOLDER = 4;
/** ChrCustomizationChoice.Flags: this is the model's default (mount_chr.py, measured). */
const DEFAULT_FLAG = 0x10;

export interface RawElement {
  kind: "geo" | "mat" | "bone" | "skinned" | "cond" | "mod";
  cond: number;
  group?: number;
  value?: number;
  target?: number;
  fdid?: number;
  emissive?: number;
  /** A bone set's own model file: one set per posture. */
  model?: number;
  collection?: number;
  /** ChrCustomizationCondModel id. */
  condModel?: number;
  from?: number;
  to?: number;
}

export interface RawChoice {
  id: number;
  name: string;
  order: number;
  flags: number;
  req: number;
  cls: number;
  needs: number[];
  swatch: [number, number];
  elems: RawElement[];
}

export interface RawOption {
  id: number;
  name: string;
  order: number;
  category: number;
  gated: boolean;
  choices: RawChoice[];
}

export const TREE_TABLES = [
  "ChrCustomizationOption", "ChrCustomizationChoice", "ChrCustomizationElement", "ChrCustomizationGeoset", "ChrCustomizationMaterial",
  "TextureFileData", "ChrCustomizationReq", "ChrCustomizationReqChoice", "ChrCustomizationBoneSet", "ChrCustomizationSkinnedModel",
  "ChrCustomizationCategory", "ChrCustItemGeoModify", "ChrModelMaterial",
];

export async function loadTree(db: Db2, chrModel: number): Promise<RawOption[]> {
  const m = String(chrModel);
  const geo = byId(await db.table("ChrCustomizationGeoset"));
  const mat = byId(await db.table("ChrCustomizationMaterial"));
  const reqs = byId(await db.table("ChrCustomizationReq"));
  const bset = byId(await db.table("ChrCustomizationBoneSet"));
  const skinned = byId(await db.table("ChrCustomizationSkinnedModel"));
  const mods = byId(await db.table("ChrCustItemGeoModify"));
  const tfd = groupBy(await db.table("TextureFileData"), "MaterialResourcesID");
  const reqChoices = groupBy(await db.table("ChrCustomizationReqChoice"), "ChrCustomizationReqID");
  const choicesOf = groupBy(await db.table("ChrCustomizationChoice"), "ChrCustomizationOptionID");
  const elemsOf = groupBy(await db.table("ChrCustomizationElement"), "ChrCustomizationChoiceID");

  const rows = (await db.table("ChrCustomizationOption")).filter((o) => o.ChrModelID === m);
  rows.sort((a, b) => num(a.OrderIndex) - num(b.OrderIndex) || num(a.ID) - num(b.ID));

  const opts: RawOption[] = rows.map((o) => {
    const choices: RawChoice[] = [];
    const list = [...(choicesOf.get(o.ID ?? "") ?? [])];
    list.sort((a, b) => num(a.OrderIndex) - num(b.OrderIndex) || num(a.ID) - num(b.ID));
    for (const c of list) {
      const req = reqs.get(c.ChrCustomizationReqID ?? "");
      if (num(req?.ReqType) === REQ_TRANSMOG_PLACEHOLDER) continue;
      const elems: RawElement[] = [];
      for (const e of elemsOf.get(c.ID ?? "") ?? []) {
        const cond = num(e.RelatedChrCustomizationChoiceID);
        if (num(e.ChrCustomizationGeosetID)) {
          const g = geo.get(e.ChrCustomizationGeosetID ?? "");
          if (!g) throw new Error(`element ${e.ID}: no geoset ${e.ChrCustomizationGeosetID}`);
          elems.push({ kind: "geo", group: num(g.GeosetType), value: num(g.GeosetID), cond });
        }
        if (num(e.ChrCustomizationMaterialID)) {
          const mt = mat.get(e.ChrCustomizationMaterialID ?? "");
          if (!mt) throw new Error(`element ${e.ID}: no material ${e.ChrCustomizationMaterialID}`);
          const files = tfd.get(mt.MaterialResourcesID ?? "") ?? [];
          const diffuse = files.filter((f) => num(f.UsageType) === 0).map((f) => num(f.FileDataID)).sort((a, b) => a - b);
          const emissive = files.filter((f) => num(f.UsageType) === 2).map((f) => num(f.FileDataID)).sort((a, b) => a - b);
          elems.push({ kind: "mat", target: num(mt.ChrModelTextureTargetID), fdid: diffuse[0] ?? 0, emissive: emissive[0] ?? 0, cond });
        }
        if (num(e.ChrCustomizationBoneSetID)) {
          const b = bset.get(e.ChrCustomizationBoneSetID ?? "");
          if (!b) throw new Error(`element ${e.ID}: no bone set ${e.ChrCustomizationBoneSetID}`);
          elems.push({ kind: "bone", fdid: num(b.BoneFileDataID), model: num(b.ModelFileDataID), cond });
        }
        if (num(e.ChrCustomizationCondModelID)) elems.push({ kind: "cond", condModel: num(e.ChrCustomizationCondModelID), cond });
        if (num(e.ChrCustomizationSkinnedModelID)) {
          const s = skinned.get(e.ChrCustomizationSkinnedModelID ?? "");
          if (s) elems.push({ kind: "skinned", collection: num(s.CollectionsFileDataID), group: num(s.GeosetType), value: num(s.GeosetID), cond });
        }
        if (num(e.ChrCustItemGeoModifyID)) {
          const g = mods.get(e.ChrCustItemGeoModifyID ?? "");
          if (g) elems.push({ kind: "mod", group: num(g.GeosetType), from: num(g.Original), to: num(g.Override), cond });
        }
      }
      choices.push({
        id: num(c.ID),
        name: c.Name_lang ?? "",
        order: num(c.OrderIndex),
        flags: num(c.Flags),
        req: num(req?.ReqType),
        cls: num(req?.ClassMask),
        needs: (reqChoices.get(c.ChrCustomizationReqID ?? "") ?? []).map((r) => num(r.ChrCustomizationChoiceID)).sort((a, b) => a - b),
        swatch: [num(c.SwatchColor_0) >>> 0, num(c.SwatchColor_1) >>> 0],
        elems,
      });
    }
    // An option retail gates is unset by default: while its requirement isn't met retail
    // shows it nowhere and applies none of its choices, and none of them is "none".
    const gated = num(o.Requirement) !== 0;
    if (gated && choices.length) {
      choices.unshift({ id: GATED_NONE | num(o.ID), name: "None", order: -1, flags: 0, req: 0, cls: 0, needs: [], swatch: [0, 0], elems: [] });
    }
    return { id: num(o.ID), name: o.Name_lang ?? "", order: num(o.OrderIndex), category: num(o.ChrCustomizationCategoryID), gated, choices };
  });

  // A choice whose art exists only under a gated option's choices (the 14 draconic Eye
  // Colors: one texture per Eye Style) would paint nothing while that option is unset.
  // Its art for the gated option's first real choice becomes its unconditioned base,
  // placed first: a later active element wins a target, so Star and Glow replace it.
  const gateOf = new Map<number, RawOption>();
  for (const o of opts) if (o.gated) for (const c of o.choices) gateOf.set(c.id, o);
  for (const o of opts) {
    for (const c of o.choices) {
      if (c.elems.length === 0 || c.elems.some((e) => e.cond === 0)) continue;
      if (!c.elems.every((e) => gateOf.has(e.cond))) continue;
      const owners = new Set(c.elems.map((e) => gateOf.get(e.cond)));
      if (owners.size !== 1) continue;
      const g = gateOf.get(c.elems[0]!.cond)!;
      const first = g.choices.find((x) => x.id < GATED_NONE && c.elems.some((e) => e.cond === x.id));
      if (first) c.elems = [...c.elems.filter((e) => e.cond === first.id).map((e) => ({ ...e, cond: 0 })), ...c.elems];
    }
  }

  // A choice whose every element waits on a choice that isn't offered draws nothing
  // anywhere: the transmog placeholders' dependants.
  const kept = new Set<number>();
  for (const o of opts) for (const c of o.choices) kept.add(c.id);
  for (const o of opts) {
    o.choices = o.choices.filter((c) => {
      const live = c.elems.filter((e) => e.cond === 0 || kept.has(e.cond));
      if (c.elems.length && live.length === 0) return false;
      c.elems = live;
      return true;
    });
    for (const c of o.choices) c.needs = c.needs.filter((n) => kept.has(n));
  }
  return opts.filter((o) => o.choices.length > 0);
}

/**
 * A colour row lists colours (Races.cpp). Retail offers a colour option's swatchless
 * choice that paints nothing only while the shape option wears nothing that colour
 * paints: the shape is the off switch. Anyone may wear any shape here, so that "None"
 * would sit among the real colours and paint nothing. Dropped where every colour waits
 * on a shape; kept where it is the row's own off switch.
 */
export function pruneColourRows(opts: RawOption[]): void {
  for (const o of opts) {
    let swatched = false;
    let waits = true;
    for (const c of o.choices) {
      if (!c.swatch[0]) continue;
      swatched = true;
      for (const e of c.elems) if (e.kind === "mat" || e.kind === "geo" || e.kind === "skinned") waits &&= e.cond !== 0;
    }
    if (!swatched || !waits) continue;
    o.choices = o.choices.filter((c) => c.swatch[0] !== 0 || c.elems.some((e) => e.kind === "mat" || e.kind === "geo" || e.kind === "skinned" || e.kind === "cond"));
  }
}

const anyPlayer = (c: { req: number; cls: number }) => c.req === REQ_ANY && !classTag(c.cls);

/** Its geoset value in a group, for this choice's unconditioned elements. -1: it sets none. */
const groupValue = (c: CustomOption["choices"][number], group: number): number => c.geo?.find((g) => g[0] === group && !g[2])?.[1] ?? -1;

/**
 * The look a body first appears in. Retail stores no default look: Human male's first
 * hair is "Bald" (OrderIndex 0, no default flag), ChrModel.DisplayID 57899 has no
 * customization Extra, and retail's creator deals a random look when it opens. Eclipse's
 * races::Default takes every option's first choice, so a bald man with no beard.
 *
 * Here: the choice retail flags as default (0x10), else the first any player can pick;
 * a gated option stays on its "None"; and where that leaves no hair or no beard, the
 * first hairstyle or beard any player can pick, so a figure reads as a person. A
 * posture option wears this body's own posture.
 */
export function firstLook(options: readonly CustomOption[], bodyId: string): Look {
  const look: Look = {};
  for (const o of options) {
    const postured = o.choices.find((c) => c.body === bodyId);
    if (postured) {
      look[o.id] = postured.id;
      continue;
    }
    if (o.gated) {
      look[o.id] = o.choices[0]!.id;
      continue;
    }
    const flagged = o.choices.find((c) => (c.flags ?? 0) & DEFAULT_FLAG);
    const open = o.choices.filter(anyPlayer);
    const pool = open.length ? open : o.choices;
    let c = flagged ?? pool[0]!;
    if (!flagged) {
      if (o.choices.some((x) => groupValue(x, 0) > 0) && groupValue(c, 0) <= 0) c = pool.find((x) => groupValue(x, 0) > 0) ?? c;
      else if (/^(beard|facial hair)$/i.test(o.name) && groupValue(c, 1) === 0) c = pool.find((x) => groupValue(x, 1) > 0) ?? c;
    }
    look[o.id] = c.id;
  }
  return look;
}
