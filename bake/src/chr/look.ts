import { type Db2, byId, groupBy, num } from "../db2/db2";

/**
 * A body's default look, from the customization tables. Port of Eclipse's
 * tools/races/races_spec.py load_tree and tools/retailmounts/mount_chr.py resolve,
 * with the groups no option decides following src/eclipse/races/RetailGeo.h.
 */

const DEFAULT_FLAG = 0x10;
/** ChrCustomizationReq.ReqType 4: retail's "Transmog" placeholder choices, no art. */
const REQ_TRANSMOG_PLACEHOLDER = 4;

/**
 * Retail's per-group {naked default, equipped default}, dword_1034E1C80 in
 * 12.1.0.69933 (RetailGeo.h kDefault). With nothing worn every group starts at
 * "equipped default".
 */
const GROUP_DEFAULT: readonly (readonly [number, number])[] = [
  [1, 1], [1, 1], [1, 1], [0, 1], [1, 1], [0, 1], [1, 1], [1, 2], [1, 1], [0, 1], [1, 1], [0, 1],
  [1, 1], [0, 1], [0, 0], [1, 1], [0, 0], [0, 0], [1, 1], [1, 1], [0, 1], [1, 1], [1, 1], [1, 1],
  [0, 0], [0, 0], [1, 1], [0, 0], [1, 1], [0, 0], [0, 0], [0, 0], [1, 2], [0, 1], [0, 1], [0, 0],
  [0, 0], [0, 0], [0, 1], [0, 0], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1],
  [0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1],
];

export interface LookElement {
  kind: "geo" | "mat" | "bone" | "skinned" | "cond";
  cond: number;
  group?: number;
  value?: number;
  target?: number;
  fdid?: number;
  emissive?: number;
  raw?: number;
}

export interface LookChoice {
  id: number;
  name: string;
  order: number;
  flags: number;
  reqType: number;
  classMask: number;
  elems: LookElement[];
}

export interface LookOption {
  id: number;
  name: string;
  order: number;
  gated: boolean;
  choices: LookChoice[];
}

export const LOOK_TABLES = [
  "ChrCustomizationOption", "ChrCustomizationChoice", "ChrCustomizationElement", "ChrCustomizationGeoset", "ChrCustomizationMaterial",
  "TextureFileData", "ChrCustomizationReq",
];

export async function loadOptions(db: Db2, chrModel: number): Promise<LookOption[]> {
  const m = String(chrModel);
  const geo = byId(await db.table("ChrCustomizationGeoset"));
  const mat = byId(await db.table("ChrCustomizationMaterial"));
  const reqs = byId(await db.table("ChrCustomizationReq"));
  const tfd = groupBy(await db.table("TextureFileData"), "MaterialResourcesID");
  const choicesOf = groupBy(await db.table("ChrCustomizationChoice"), "ChrCustomizationOptionID");
  const elemsOf = groupBy(await db.table("ChrCustomizationElement"), "ChrCustomizationChoiceID");

  const options = (await db.table("ChrCustomizationOption")).filter((o) => o.ChrModelID === m);
  options.sort((a, b) => num(a.OrderIndex) - num(b.OrderIndex) || num(a.ID) - num(b.ID));

  return options.map((o) => {
    const choices: LookChoice[] = [];
    const rows = [...(choicesOf.get(o.ID ?? "") ?? [])];
    rows.sort((a, b) => num(a.OrderIndex) - num(b.OrderIndex) || num(a.ID) - num(b.ID));
    for (const c of rows) {
      const req = reqs.get(c.ChrCustomizationReqID ?? "");
      const reqType = num(req?.ReqType);
      if (reqType === REQ_TRANSMOG_PLACEHOLDER) continue;
      const elems: LookElement[] = [];
      for (const e of elemsOf.get(c.ID ?? "") ?? []) {
        const cond = num(e.RelatedChrCustomizationChoiceID);
        if (num(e.ChrCustomizationGeosetID)) {
          const g = geo.get(e.ChrCustomizationGeosetID ?? "");
          if (g) elems.push({ kind: "geo", group: num(g.GeosetType), value: num(g.GeosetID), cond });
        }
        if (num(e.ChrCustomizationMaterialID)) {
          const mt = mat.get(e.ChrCustomizationMaterialID ?? "");
          if (mt) {
            const files = tfd.get(mt.MaterialResourcesID ?? "") ?? [];
            const diffuse = files.filter((f) => num(f.UsageType) === 0).map((f) => num(f.FileDataID)).sort((a, b) => a - b);
            const emissive = files.filter((f) => num(f.UsageType) === 2).map((f) => num(f.FileDataID)).sort((a, b) => a - b);
            elems.push({ kind: "mat", target: num(mt.ChrModelTextureTargetID), fdid: diffuse[0] ?? 0, emissive: emissive[0] ?? 0, cond });
          }
        }
        if (num(e.ChrCustomizationBoneSetID)) elems.push({ kind: "bone", raw: num(e.ChrCustomizationBoneSetID), cond });
        if (num(e.ChrCustomizationSkinnedModelID)) elems.push({ kind: "skinned", raw: num(e.ChrCustomizationSkinnedModelID), cond });
        if (num(e.ChrCustomizationCondModelID)) elems.push({ kind: "cond", raw: num(e.ChrCustomizationCondModelID), cond });
      }
      choices.push({
        id: num(c.ID),
        name: c.Name_lang ?? "",
        order: num(c.OrderIndex),
        flags: num(c.Flags),
        reqType,
        classMask: num(req?.ClassMask),
        elems,
      });
    }
    return { id: num(o.ID), name: o.Name_lang ?? "", order: num(o.OrderIndex), gated: num(o.Requirement) !== 0, choices };
  });
}

export interface DefaultLook {
  chosen: Set<number>;
  /** Geoset ids to show, before checking which the model has. */
  geosets: Set<number>;
  /** Texture target -> file painted on it. */
  mats: Map<number, { fdid: number; emissive: number }>;
  warnings: string[];
}

/**
 * Default choice: flagged 0x10, else the first by retail's order (Eclipse's
 * default_choice). A choice locked to some classes is passed over unless a warrior
 * has it: ClassMask -1 is every class, and bit 0 is the plain case. Requirements
 * between choices are the creator's rules for what it offers, not for a default:
 * Human male's first skin "needs" other faces than its first face, and the first
 * hair colour needs a hair style its bald default isn't.
 */
function pickChoice(o: LookOption): LookChoice | null {
  const open = o.choices.filter((c) => c.classMask === 0 || (c.classMask & 1) !== 0);
  const pool = open.length ? open : o.choices;
  return pool.find((c) => c.flags & DEFAULT_FLAG) ?? pool[0] ?? null;
}

export function defaultLook(options: LookOption[], have: Set<number>): DefaultLook {
  const warnings: string[] = [];
  // A gated option (Requirement set) is unset until met: retail shows it nowhere.
  const open = options.filter((o) => !o.gated);
  const chosen = new Set<number>();
  const pick = new Map<number, LookChoice>();
  for (const o of open) {
    const c = pickChoice(o);
    if (!c) continue;
    pick.set(o.id, c);
    chosen.add(c.id);
  }

  // A choice whose art exists only under a gated option's choices (draconic eye
  // colours: one texture per Eye Style) would paint nothing while that option is
  // unset. Its art for the gated option's first real choice is its base.
  const gateOf = new Map<number, LookOption>();
  for (const o of options) if (o.gated) for (const c of o.choices) gateOf.set(c.id, o);
  const elemsOf = (c: LookChoice): LookElement[] => {
    if (c.elems.length === 0 || c.elems.some((e) => e.cond === 0)) return c.elems;
    if (!c.elems.every((e) => gateOf.has(e.cond))) return c.elems;
    const g = gateOf.get(c.elems[0]!.cond)!;
    const first = g.choices.find((x) => c.elems.some((e) => e.cond === x.id));
    if (!first) return c.elems;
    return [...c.elems.filter((e) => e.cond === first.id).map((e) => ({ ...e, cond: 0 })), ...c.elems];
  };

  const want = new Map<number, number>();
  let hair = 0;
  const mats = new Map<number, { fdid: number; emissive: number }>();
  const unported = new Map<string, number>();
  // Options apply in retail's order; a later one's material for a target replaces an earlier one's.
  for (const o of open) {
    const c = pick.get(o.id);
    if (!c) continue;
    for (const e of elemsOf(c)) {
      if (e.cond !== 0 && !chosen.has(e.cond)) continue;
      if (e.kind === "geo") {
        want.set(e.group!, e.value!);
        if (e.group === 0) hair = e.value!;
      } else if (e.kind === "mat") {
        if (e.fdid) mats.set(e.target!, { fdid: e.fdid, emissive: e.emissive ?? 0 });
      } else {
        unported.set(e.kind, (unported.get(e.kind) ?? 0) + 1);
      }
    }
  }
  if (unported.get("bone")) warnings.push(`default look applies ${unported.get("bone")} face bone set(s) (.bone); not applied yet`);
  if (unported.get("skinned")) warnings.push(`default look uses ${unported.get("skinned")} skinned customization part(s); not baked yet`);
  if (unported.get("cond")) warnings.push(`default look uses a conditional model (posture); baked as its own body`);

  const geosets = new Set<number>([0]);
  if (hair) geosets.add(hair);
  const groups = new Set<number>();
  for (const id of have) groups.add(Math.floor(id / 100));
  GROUP_DEFAULT.forEach((_d, g) => groups.add(g));
  for (const g of groups) {
    if (g === 0) continue;
    const v = want.get(g) ?? GROUP_DEFAULT[g]?.[1] ?? 0;
    if (v) geosets.add(g * 100 + v);
  }
  const visible = new Set([...geosets].filter((id) => have.has(id)));
  return { chosen, geosets: visible, mats, warnings };
}

export const LAYER_TABLES = ["ChrModel", "ChrModelTextureLayer", "CharComponentTextureSections", "CharComponentTextureLayouts"];

export interface LayerRow {
  type: number;
  layer: number;
  blend: number;
  /** Whole-layout rect, in layout pixels. */
  rect: { x: number; y: number; w: number; h: number };
  targets: number[];
  emissiveBlend: number;
}

export interface Layout {
  width: number;
  height: number;
  rows: LayerRow[];
  /** Component section -> rect, in layout pixels. */
  sections: Map<number, { x: number; y: number; w: number; h: number }>;
}

export async function loadLayout(db: Db2, chrModel: number): Promise<Layout> {
  const model = byId(await db.table("ChrModel")).get(String(chrModel));
  if (!model) throw new Error(`ChrModel has no row ${chrModel}`);
  const id = model.CharComponentTextureLayoutID ?? "";
  const row = byId(await db.table("CharComponentTextureLayouts")).get(id);
  if (!row) throw new Error(`no texture layout ${id}`);
  const width = num(row.Width);
  const height = num(row.Height);
  const secs = new Map<number, { x: number; y: number; w: number; h: number }>();
  for (const s of await db.table("CharComponentTextureSections")) {
    if (s.CharComponentTextureLayoutID === id) secs.set(num(s.SectionType), { x: num(s.X), y: num(s.Y), w: num(s.Width), h: num(s.Height) });
  }
  const rows: LayerRow[] = [];
  for (const r of await db.table("ChrModelTextureLayer")) {
    if (r.CharComponentTextureLayoutsID !== id) continue;
    const mask = num(r.TextureSectionTypeBitMask);
    let rect = { x: 0, y: 0, w: width, h: height };
    if (mask !== -1) {
      const parts: { x: number; y: number; w: number; h: number }[] = [];
      for (let b = 0; b < 31; b++) {
        const s = secs.get(b);
        if (mask & (1 << b) && s) parts.push(s);
      }
      if (parts.length === 0) continue;
      const x0 = Math.min(...parts.map((p) => p.x));
      const y0 = Math.min(...parts.map((p) => p.y));
      rect = { x: x0, y: y0, w: Math.max(...parts.map((p) => p.x + p.w)) - x0, h: Math.max(...parts.map((p) => p.y + p.h)) - y0 };
    }
    rows.push({
      type: num(r.TextureType),
      layer: num(r.Layer),
      blend: num(r.BlendMode),
      rect,
      targets: [num(r.ChrModelTextureTargetID_0), num(r.ChrModelTextureTargetID_1)].filter((t) => t !== 0),
      emissiveBlend: num(r.Field_9_0_1_34365_006_2),
    });
  }
  rows.sort((a, b) => a.layer - b.layer);
  return { width, height, rows, sections: secs };
}
