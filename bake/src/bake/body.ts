import { BUILD, type CompositeLayer, type ModelManifest, type TextureEntry, paths } from "@eclipse/format";
import { defaultLook, loadLayout, loadOptions } from "../chr/look";
import { type BodySpec } from "../chr/races";
import { BAKER_VERSION } from "../lib/env";
import { toWire } from "../store/store";
import type { M2Model, Skin } from "../m2/model";
import { type BakeContext, type BakeRecord, type Tracked, writeRecord } from "./context";
import { type BakedModel, type ModelLook, bakeModel, blankTexture } from "./model";
import { bakeTexture } from "./texture";

/** Target canvas for the runtime composite: Eclipse's, the size retail's own layers are cut for. */
const COMPOSITE_WIDTH = 1024;
/** Largest side for a non-composite texture. */
const TEXTURE_CAP = 1024;

/** A body's default look: geosets from the tables, layers to composite, textures per slot. */
async function bodyLook(ctx: BakeContext, spec: BodySpec, model: M2Model, skin: Skin, files: Tracked): Promise<ModelLook> {
  const warnings: string[] = [];
  const options = await loadOptions(ctx.db, spec.chrModel);
  const look = defaultLook(options, new Set(skin.submeshes.map((s) => s.id)));
  warnings.push(...look.warnings);

  const layout = await loadLayout(ctx.db, spec.chrModel);
  const scale = layout.width > COMPOSITE_WIDTH ? COMPOSITE_WIDTH / layout.width : 1;
  const canvasW = Math.round(layout.width * scale);
  const canvasH = Math.round(layout.height * scale);
  const scaleRect = (r: { x: number; y: number; w: number; h: number }) => ({
    x: Math.round(r.x * scale),
    y: Math.round(r.y * scale),
    w: Math.round(r.w * scale),
    h: Math.round(r.h * scale),
  });
  const sections: Record<number, { x: number; y: number; w: number; h: number }> = {};
  for (const [id, r] of layout.sections) sections[id] = scaleRect(r);

  const layers: CompositeLayer[] = [];
  for (const row of layout.rows.filter((r) => r.type === 1)) {
    for (const target of row.targets) {
      const mat = look.mats.get(target);
      if (!mat) continue;
      if (row.emissiveBlend || mat.emissive) warnings.push(`layer ${row.layer} (target ${target}) has an emissive channel, not baked yet`);
      const rect = scaleRect(row.rect);
      const t = await bakeTexture(ctx, files, mat.fdid, { w: rect.w, h: rect.h });
      layers.push({ layer: row.layer, targetType: 1, rect, blend: row.blend, key: t.key, bytes: t.bytes });
    }
  }

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
      entry.width = canvasW;
      entry.height = canvasH;
    } else {
      const active = layout.rows.filter((r) => r.type === tex.type).flatMap((r) => r.targets.map((t) => ({ row: r, mat: look.mats.get(t) }))).filter((x) => x.mat);
      if (active.length === 1) {
        const fdid = active[0]!.mat!.fdid;
        const t = await bakeTexture(ctx, files, fdid, { cap: TEXTURE_CAP });
        Object.assign(entry, { key: t.key, bytes: t.bytes, width: t.width, height: t.height, alpha: t.alpha, fileDataId: fdid });
      } else if (active.length > 1) {
        // Painted by several layers at once: composited at runtime, like type 1.
        for (const { row, mat } of active) {
          const t = await bakeTexture(ctx, files, mat!.fdid, { cap: TEXTURE_CAP });
          layers.push({ layer: row.layer, targetType: tex.type, rect: { x: 0, y: 0, w: t.width, h: t.height }, blend: row.blend, key: t.key, bytes: t.bytes });
          entry.width = Math.max(entry.width, t.width);
          entry.height = Math.max(entry.height, t.height);
        }
      }
    }
    textures.push(entry);
  }
  return { geosets: look.geosets, textures, composite: { width: canvasW, height: canvasH, layers, sections }, warnings };
}

export function bakeBody(ctx: BakeContext, spec: BodySpec): Promise<BakedModel> {
  return bakeModel(ctx, { id: spec.id, kind: "body", name: spec.name, m2: spec.m2, look: (model, skin, files) => bodyLook(ctx, spec, model, skin, files) });
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
    const sizes = { ...out.sizes, firstLoadWire: await firstLoadWire(ctx, out.manifest, out.sizes) };
    const rec: BakeRecord = { ...base, status: "ok", inputs: out.inputs, warnings: out.manifest.warnings, sizes, seconds: (Date.now() - start) / 1000 };
    await writeRecord(ctx.store, rec);
    return rec;
  } catch (e) {
    const rec: BakeRecord = { ...base, status: "failed", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), inputs: {}, warnings: [], seconds: (Date.now() - start) / 1000 };
    await writeRecord(ctx.store, rec);
    return rec;
  }
}
