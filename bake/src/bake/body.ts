import { BUILD, FORMAT_VERSION, OWNED_BASE, type BoneSetData, type CompositeLayer, type CustomChoice, type CustomLayer, type CustomModelTexture, type CustomOption, type CustomPart, type CustomTab, type CustomTexture, type CustomizationData, type Look, type ModelManifest, type TextureEntry, lookBoneSets, lookGeosets, lookPaint, lookParts, paths } from "@eclipse/format";
import { loadLayout } from "../chr/look";
import { type BodySpec } from "../chr/races";
import { type RawChoice, type RawOption, firstLook, loadTree, pruneColourRows } from "../chr/tree";
import { byId, num } from "../db2/db2";
import { BAKER_VERSION, STAGE, inputKey, log, mapLimit } from "../lib/env";
import { readBoneFile, boneSetMatrices, mergeBoneSets } from "../m2/bone";
import { MissingFile } from "../sources/source";
import { toWire } from "../store/store";
import type { M2Model, Skin } from "../m2/model";
import { type BakeContext, type BakeRecord, Tracked, writeRecord } from "./context";
import { type BakedModel, type ModelLook, bakeModel, blankTexture, putIfAbsent } from "./model";
import { type BakedTexture, bakeTexture } from "./texture";

/** Target canvas for the runtime composite: Eclipse's, the size retail's own layers are cut for. */
const COMPOSITE_WIDTH = 1024;
/** Largest side for a non-composite texture: the client's texture cap, races_layers.MAX_TEXTURE. */
const TEXTURE_CAP = 1024;

const hex = (rgb: number): string => `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`;

/** Which texture targets the look can paint: the composite's layers and every model texture's. */
interface PaintedLayout {
  width: number;
  height: number;
  scale: number;
  layers: CustomLayer[];
  modelTextures: CustomModelTexture[];
  sections: Record<number, { x: number; y: number; w: number; h: number }>;
  /** Target -> the size its art is composited at. */
  sizeOf: Map<number, { w: number; h: number }>;
}

async function paintedLayout(ctx: BakeContext, chrModel: number, types: ReadonlySet<number>, warnings: string[]): Promise<PaintedLayout> {
  const layout = await loadLayout(ctx.db, chrModel);
  const scale = layout.width > COMPOSITE_WIDTH ? COMPOSITE_WIDTH / layout.width : 1;
  const scaleRect = (r: { x: number; y: number; w: number; h: number }) => ({
    x: Math.round(r.x * scale),
    y: Math.round(r.y * scale),
    w: Math.round(r.w * scale),
    h: Math.round(r.h * scale),
  });
  const sections: PaintedLayout["sections"] = {};
  for (const [id, r] of layout.sections) sections[id] = scaleRect(r);

  const sizeOf = new Map<number, { w: number; h: number }>();
  const layers: CustomLayer[] = [];
  for (const row of layout.rows.filter((r) => r.type === 1)) {
    const target = row.targets[0];
    if (!target) continue;
    const rect = scaleRect(row.rect);
    layers.push({ target, rect, blend: row.blend, role: row.mask === 32 ? 1 : row.mask === 8 ? 2 : 0, ...(row.emissiveBlend ? { emode: row.emissiveBlend } : {}) });
    sizeOf.set(target, { w: rect.w, h: rect.h });
  }

  // Retail composites each model texture from its own layer rows, every layer stretched
  // over the whole texture, at its ChrModelMaterial size halved to the client's cap.
  const sizes = new Map<number, { w: number; h: number }>();
  for (const r of await ctx.db.table("ChrModelMaterial")) {
    if (num(r.CharComponentTextureLayoutsID) === layout.id) sizes.set(num(r.TextureType), { w: num(r.Width), h: num(r.Height) });
  }
  const modelTextures: CustomModelTexture[] = [];
  for (const type of [...new Set(layout.rows.map((r) => r.type))].sort((a, b) => a - b)) {
    if (type === 1 || !types.has(type)) continue;
    const size = sizes.get(type);
    if (!size) {
      warnings.push(`layout ${layout.id} has type-${type} layers but no material size: not painted`);
      continue;
    }
    let { w, h } = size;
    while (w > TEXTURE_CAP || h > TEXTURE_CAP) {
      w = w >> 1;
      h = h >> 1;
    }
    const rows = layout.rows.filter((r) => r.type === type && r.targets[0]);
    modelTextures.push({ type, width: w, height: h, layers: rows.map((r) => [r.targets[0]!, r.blend]) });
    for (const r of rows) sizeOf.set(r.targets[0]!, { w, h });
  }
  return { width: Math.round(layout.width * scale), height: Math.round(layout.height * scale), scale, layers, modelTextures, sections, sizeOf };
}

/** A .bone file per model file: the set authored for this body's model, else one for any. */
function boneFileOf(c: RawChoice, m2: number): number {
  const sets = c.elems.filter((e) => e.kind === "bone");
  return (sets.find((e) => e.model === m2) ?? sets.find((e) => !e.model))?.fdid ?? 0;
}

/**
 * Textures, most useful first: the first look's, then what one change from it needs,
 * then the rest. A partial local bake (--tex-budget-mb) stops once its downloads are
 * spent, so what it leaves out is what a sweep of single changes needs last.
 */
function textureOrder(data: CustomizationData, look: Look): number[] {
  const seen = new Set<number>();
  const order: number[] = [];
  const take = (t: number) => {
    if (t >= 0 && !seen.has(t)) {
      seen.add(t);
      order.push(t);
    }
  };
  const addLook = (l: Look) => {
    const p = lookPaint(data, l);
    for (const t of p.mats.values()) take(t);
    for (const t of p.emissive.values()) take(t);
  };
  addLook(look);
  for (const o of data.options) for (const c of o.choices) addLook({ ...look, [o.id]: c.id });
  data.textures.forEach((_t, i) => take(i));
  return order;
}

interface BuiltLook {
  data: CustomizationData;
  first: Look;
  /** Texture index -> what it baked to. */
  layout: PaintedLayout;
  boneSet?: BoneSetData;
}

/**
 * The whole tree for one body. A skinned part is its own model, shared by every body
 * that wears the file.
 */
async function buildCustomization(ctx: BakeContext, spec: BodySpec, model: M2Model, skin: Skin, files: Tracked, warnings: string[]): Promise<BuiltLook> {
  const tree: RawOption[] = await loadTree(ctx.db, spec.chrModel);
  pruneColourRows(tree);

  // ---------------------------------------------------------------- skinned parts
  const collections: number[] = [];
  for (const o of tree) for (const c of o.choices) for (const e of c.elems) if (e.kind === "skinned" && !collections.includes(e.collection!)) collections.push(e.collection!);
  const parts: CustomPart[] = [];
  const types = new Set(model.textures.map((t) => t.type));
  for (const fdid of collections) {
    const owned = new Set<number>();
    for (const o of tree) for (const c of o.choices) for (const e of c.elems) if (e.kind === "skinned" && e.collection === fdid) owned.add(e.group!);
    // One GLB per file, whichever body wears it: a joint is found on the body by its retail name hash.
    const partId = `chrpart-${fdid}`;
    let has: number[] = [];
    const baked = await bakeModel(ctx, {
      id: partId,
      kind: "body",
      name: `${spec.name} part ${fdid}`,
      m2: fdid,
      noClips: true,
      look: async (part, partSkin, partFiles) => {
        has = [...new Set(partSkin.submeshes.map((s) => s.id))].sort((a, b) => a - b);
        for (const t of part.textures) types.add(t.type);
        const textures: TextureEntry[] = [];
        for (const t of part.textures) {
          const entry = blankTexture(t.type);
          if (t.type === 0 && t.fileDataId) {
            const baked = await bakeTexture(ctx, partFiles, t.fileDataId, { cap: TEXTURE_CAP });
            Object.assign(entry, { key: baked.key, bytes: baked.bytes, width: baked.width, height: baked.height, alpha: baked.alpha, fileDataId: t.fileDataId });
          }
          textures.push(entry);
        }
        return { geosets: new Set<number>(), textures, warnings: [] };
      },
    });
    Object.assign(files.inputs, baked.inputs);
    warnings.push(...baked.manifest.warnings);
    parts.push({ manifest: partId, owned: [...owned].sort((a, b) => a - b), has });
  }

  const layout = await paintedLayout(ctx, spec.chrModel, types, warnings);
  const painted = new Set(layout.sizeOf.keys());

  // ---------------------------------------------------------------- textures, by need
  const textures: CustomTexture[] = [];
  const texIndex = new Map<string, number>();
  const texOf = (fdid: number, target: number): number => {
    const size = layout.sizeOf.get(target)!;
    const key = `${fdid}:${size.w}x${size.h}`;
    let i = texIndex.get(key);
    if (i === undefined) {
      i = textures.length;
      texIndex.set(key, i);
      textures.push({ key: "", bytes: 0, width: size.w, height: size.h, alpha: false, fileDataId: fdid });
    }
    return i;
  };

  // ---------------------------------------------------------------- bone sets
  const boneFiles: number[] = [];
  const boneIndex = new Map<number, number>();
  const boneOf = (fdid: number): number => {
    let i = boneIndex.get(fdid);
    if (i === undefined) {
      i = boneFiles.length;
      boneIndex.set(fdid, i);
      boneFiles.push(fdid);
    }
    return i;
  };

  // A posture's two bodies offer the same options; a choice says which it wears.
  const postureBody = (e: { condModel?: number }): string => {
    if (e.condModel === 1) return "orcupright-male";
    if (e.condModel === 2) return "magharupright-male";
    return "";
  };
  const baseBodyId = spec.posture ? `${spec.raceKey}-male` : spec.id;

  const options: CustomOption[] = tree.map((o) => {
    const isPosture = o.choices.some((c) => c.elems.some((e) => e.kind === "cond"));
    const choices = o.choices.map((c): CustomChoice => {
      const geo = c.elems.filter((e) => e.kind === "geo").map((e): [number, number, number] => [e.group!, e.value!, e.cond]);
      const pgeo = c.elems.filter((e) => e.kind === "skinned").map((e): [number, number, number, number] => [collections.indexOf(e.collection!), e.group!, e.value!, e.cond]);
      const mat = c.elems
        .filter((e) => e.kind === "mat" && e.fdid && painted.has(e.target!))
        .map((e): [number, number, number, number] => [e.target!, texOf(e.fdid!, e.target!), e.cond, e.emissive ? texOf(e.emissive, e.target!) : -1]);
      const mod = c.elems.filter((e) => e.kind === "mod").map((e): [number, number, number] => [e.group!, e.from!, e.to!]);
      const bone = boneFileOf(c, spec.m2);
      const cond = c.elems.find((e) => e.kind === "cond");
      const out: CustomChoice = { id: c.id, name: c.name, req: c.req, cls: c.cls };
      if (c.flags) out.flags = c.flags;
      if (c.swatch[0]) out.sw = c.swatch[1] ? [hex(c.swatch[0]), hex(c.swatch[1])] : [hex(c.swatch[0])];
      if (c.needs.length) out.needs = c.needs;
      if (geo.length) out.geo = geo;
      if (pgeo.length) out.pgeo = pgeo;
      if (mat.length) out.mat = mat;
      if (mod.length) out.mod = mod;
      if (bone) out.bone = boneOf(bone);
      if (isPosture) out.body = cond ? postureBody(cond) || baseBodyId : baseBodyId;
      return out;
    });
    return { id: o.id, name: o.name, tab: o.category, ...(o.gated ? { gated: true } : {}), choices };
  });

  // base_mats: a model texture's base layer no option of this body paints would stay
  // empty (the Gilnean's eyes). The donor is retail's texture fallback, else the Human
  // of the same sex; its first unconditioned choice painting that target.
  const baseMats: [number, number][] = [];
  const provided = new Set<number>();
  for (const o of tree) for (const c of o.choices) for (const e of c.elems) if (e.kind === "mat") provided.add(e.target!);
  const needBase = layout.modelTextures.map((t) => t.layers[0]?.[0]).filter((t): t is number => t !== undefined && !provided.has(t));
  if (needBase.length) {
    const row = byId(await ctx.db.table("ChrModel")).get(String(spec.chrModel));
    const fallback = num(row?.TextureFallbackChrModelID);
    const donor = await loadTree(ctx.db, fallback || (spec.sex === "male" ? 1 : 2));
    for (const t of needBase) {
      let fd = 0;
      for (const o of donor) for (const c of o.choices) for (const e of c.elems) if (!fd && e.kind === "mat" && e.target === t && e.fdid && !e.cond) fd = e.fdid;
      if (fd) baseMats.push([t, texOf(fd, t)]);
    }
  }

  // Eclipse's owned groups: the base set plus every group a choice decides.
  const owned = new Set(OWNED_BASE);
  for (const o of options) for (const c of o.choices) for (const g of c.geo ?? []) owned.add(g[0]);

  const cats = byId(await ctx.db.table("ChrCustomizationCategory"));
  const tabs: CustomTab[] = [...new Set(tree.map((o) => o.category))]
    .map((id) => {
      const r = cats.get(String(id));
      return { id, name: r?.CategoryName_lang ?? "", order: num(r?.OrderIndex ?? "99"), zoom: num(r?.CameraZoomLevel ?? "100") };
    })
    .sort((a, b) => a.order - b.order || a.id - b.id);

  const data: CustomizationData = {
    formatVersion: FORMAT_VERSION,
    id: spec.id,
    chrModel: spec.chrModel,
    tabs,
    options,
    textures,
    boneSets: boneFiles.map((f) => ({ key: "", bytes: 0, fileDataId: f })),
    layers: layout.layers,
    modelTextures: layout.modelTextures,
    baseMats,
    parts,
    owned: [...owned].sort((a, b) => a - b),
    has: [...new Set(skin.submeshes.map((s) => s.id))].sort((a, b) => a - b),
    width: layout.width,
    height: layout.height,
  };
  const first = firstLook(options, spec.id);

  // ---------------------------------------------------------------- the files
  const order = textureOrder(data, first);
  const needed = new Set([...lookPaint(data, first).mats.values(), ...lookPaint(data, first).emissive.values()]);
  let left = 0;
  await mapLimit(order, 6, async (i) => {
    const t = textures[i]!;
    // Within a budget, only what the first look needs is certain to be baked.
    if (!needed.has(i) && ctx.overTextureBudget?.()) {
      left++;
      return;
    }
    try {
      const baked: BakedTexture = await bakeTexture(ctx, files, t.fileDataId, { w: t.width, h: t.height });
      Object.assign(t, { key: baked.key, bytes: baked.bytes, width: baked.width, height: baked.height, alpha: baked.alpha });
    } catch (e) {
      if (!(e instanceof MissingFile)) throw e;
      warnings.push(`texture ${t.fileDataId} could not be read: ${e.message}`);
    }
  });
  if (left) warnings.push(`local partial bake: ${left} of ${textures.length} customization textures left out by --tex-budget-mb`);

  await mapLimit(data.boneSets, 6, async (set) => {
    try {
      const f = await files.read(set.fileDataId);
      const matrices = boneSetMatrices(readBoneFile(f.bytes), model);
      const key = `objects/${inputKey("boneset", STAGE.look, f.id, model.bones.length, String(spec.m2))}.json`;
      const body = Buffer.from(JSON.stringify(matrices));
      set.key = key;
      set.bytes = await putIfAbsent(ctx, key, () => body);
    } catch (e) {
      if (!(e instanceof MissingFile)) throw e;
      // A .bone retail ships encrypted at the pinned build: never guessed.
      warnings.push(`bone set ${set.fileDataId} could not be read: ${e.message}`);
    }
  });

  let boneSet: BoneSetData | undefined;
  const wornSets = lookBoneSets(options, first);
  if (wornSets.length) {
    const lists: BoneSetData[] = [];
    for (const i of wornSets) {
      const set = data.boneSets[i]!;
      if (!set.key) continue;
      const stored = await ctx.store.get(set.key);
      if (stored) lists.push(JSON.parse(stored.toString("utf8")) as BoneSetData);
    }
    boneSet = mergeBoneSets(lists);
  }
  return { data, first, layout, boneSet };
}

/** The first look as the manifest's fields: geosets from the tables, layers to composite, textures per slot. */
async function bodyLook(ctx: BakeContext, spec: BodySpec, model: M2Model, skin: Skin, files: Tracked): Promise<ModelLook> {
  const warnings: string[] = [];
  const { data, first, layout, boneSet } = await buildCustomization(ctx, spec, model, skin, files, warnings);
  const paint = lookPaint(data, first);
  const texOf = (t: number): CustomTexture => data.textures[t]!;

  const layers: CompositeLayer[] = [];
  data.layers.forEach((row, i) => {
    const tex = paint.mats.get(row.target);
    if (tex === undefined) return;
    const t = texOf(tex);
    if (!t.key) return;
    layers.push({ layer: i, targetType: 1, rect: row.rect, blend: row.blend, key: t.key, bytes: t.bytes });
  });

  const textures: TextureEntry[] = [];
  for (const tex of model.textures) {
    const entry = blankTexture(tex.type);
    if (tex.type === 0) {
      if (tex.fileDataId) {
        const t = await bakeTexture(ctx, files, tex.fileDataId, { cap: TEXTURE_CAP });
        Object.assign(entry, { key: t.key, bytes: t.bytes, width: t.width, height: t.height, alpha: t.alpha, fileDataId: tex.fileDataId });
      } else {
        warnings.push("a hard-coded texture slot has no file id");
      }
    } else if (tex.type === 1) {
      entry.width = layout.width;
      entry.height = layout.height;
    } else {
      const mt = data.modelTextures.find((m) => m.type === tex.type);
      const active = (mt?.layers ?? []).flatMap(([target, blend], i) => {
        const t = paint.mats.get(target);
        return t === undefined ? [] : [{ target, blend, tex: texOf(t), i }];
      });
      if (active.length === 1) {
        const t = active[0]!.tex;
        Object.assign(entry, { key: t.key, bytes: t.bytes, width: t.width, height: t.height, alpha: t.alpha, fileDataId: t.fileDataId });
      } else if (active.length > 1) {
        // Painted by several layers at once: composited at runtime, like type 1.
        for (const a of active) {
          layers.push({ layer: 1000 + a.i, targetType: tex.type, rect: { x: 0, y: 0, w: a.tex.width, h: a.tex.height }, blend: a.blend, key: a.tex.key, bytes: a.tex.bytes });
        }
        entry.width = mt!.width;
        entry.height = mt!.height;
      }
    }
    textures.push(entry);
  }

  const body = Buffer.from(JSON.stringify(data));
  const key = `objects/${inputKey("customization", STAGE.look, ...Object.values(files.inputs).sort(), spec.id, body.length)}.json`;
  await ctx.store.put(key, body);
  log(`  ${spec.id}: ${data.options.length} options, ${data.options.reduce((n, o) => n + o.choices.length, 0)} choices, ${data.textures.length} textures, customization ${body.length} bytes`);

  return {
    geosets: lookGeosets(data, first),
    textures,
    composite: { width: layout.width, height: layout.height, layers, sections: layout.sections },
    warnings,
    manifest: {
      customization: { key, bytes: body.length },
      look: first,
      ...(boneSet?.length ? { boneSet } : {}),
      ...(lookParts(data, first).size || paint.emissive.size ? { lookHasParts: true } : {}),
    },
  };
}

export function bakeBody(ctx: BakeContext, spec: BodySpec): Promise<BakedModel> {
  // Retail's customization reads sequence 804, StandCharacterCreate, for every body
  // (sub_101D21390 in 12.1.0.69933): a figure in the dressing room stands as it does.
  return bakeModel(ctx, { id: spec.id, kind: "body", name: spec.name, m2: spec.m2, preferClip: "804.0", look: (model, skin, files) => bodyLook(ctx, spec, model, skin, files) });
}

/**
 * What a visitor downloads to see the default look: GLB, manifest and JSON as brotli
 * (what R2 stores and serves), KTX2 as it is. Local packs stay uncompressed, because
 * a dev server won't send the header.
 */
async function firstLoadWire(ctx: BakeContext, m: ModelManifest, sizes: Record<string, number>): Promise<number> {
  const wire = async (key: string) => {
    const b = await ctx.store.get(key);
    return b ? (await toWire(key, b)).length : 0;
  };
  const idle = m.clips.find((c) => c.id === m.defaultClip);
  return (
    (await wire(m.glb.key)) +
    (m.fx ? await wire(m.fx.key) : 0) +
    (idle ? await wire(idle.key) : 0) +
    (await wire(paths.manifest(m.id))) +
    (sizes.textureDirect ?? 0) +
    (sizes.textureComposite ?? 0)
  );
}

/** Bake one body and leave its record, whether it worked or not. */
export async function bakeBodyUnit(ctx: BakeContext, spec: BodySpec): Promise<BakeRecord> {
  const start = Date.now();
  const base = { id: spec.id, kind: "body", build: BUILD.version, baker: BAKER_VERSION, source: ctx.source.name, bakedAt: new Date().toISOString() };
  try {
    const out = await bakeBody(ctx, spec);
    const sizes = { ...out.sizes, firstLoadWire: await firstLoadWire(ctx, out.manifest, out.sizes), customization: out.manifest.customization?.bytes ?? 0 };
    const rec: BakeRecord = { ...base, status: "ok", inputs: out.inputs, warnings: out.manifest.warnings, sizes, seconds: (Date.now() - start) / 1000 };
    await writeRecord(ctx.store, rec);
    return rec;
  } catch (e) {
    if (e instanceof Error && e.name === "BudgetExceeded") throw e;
    const rec: BakeRecord = { ...base, status: "failed", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), inputs: {}, warnings: [], seconds: (Date.now() - start) / 1000 };
    await writeRecord(ctx.store, rec);
    return rec;
  }
}
