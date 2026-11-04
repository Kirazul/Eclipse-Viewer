import sharp from "sharp";
import { BUILD, FORMAT_VERSION, type AttachedPiece, type ItemManifest, type ModelManifest, type SlotId, type TextureEntry, paths } from "@eclipse/format";
import { type BakeContext, type BakeRecord, Tracked, writeRecord } from "../bake/context";
import { type BakedModel, type ModelLook, bakeModel, blankTexture } from "../bake/model";
import { type BakedTexture, type Want, bakeTexture } from "../bake/texture";
import { num } from "../db2/db2";
import { BAKER_VERSION, STAGE, inputKey, log, md5Hex } from "../lib/env";
import type { M2Model, Skin } from "../m2/model";
import { MissingFile } from "../sources/source";
import { particleColorsOf } from "../fx/emitters";
import { blpInfo, blpLevelUnder, decodeBlp } from "../tex/blp";
import { type BodyInfo, bodyTable, donorsOf, measureFit } from "./bodies";
import { type LineRow } from "./lines";
import { type GeosetFilter, type ModelFile, type ResolvedDisplay, attachmentFor, facetOf, fileForBody, geosetFilter, isCombined, isSkinnedModel, padBits, pickTexture, resolveDisplay, sheathMatrix, sheathPointsOf, slotOfDisplayType } from "./resolve";

export { fileForBody };

/** A model slot's texture cap on an item. Retail authors these at 1024 at most. At 512 the whole line is 0.9 GB smaller, should the budget ever need it. */
export const ITEM_TEXTURE_CAP = 1024;
/** A body section on the 1024 x 512 canvas is at most 256 wide. */
const SECTION_CAP = 256;
const ICON_SIZE = 64;

export interface ItemSpec {
  displayId: number;
  itemId: number;
  name: string;
  slot: SlotId;
  line: string;
  /** Every icon a row of this display shows, across lines. */
  icons: number[];
  inventoryType: number;
  sheatheType: number;
  facet?: string;
}

export function itemUnitId(displayId: number): string {
  return `item-${displayId}`;
}

/** Rows of every line, one unit per display: one look is baked once, whoever lists it. */
export function specsOfRows(rows: readonly LineRow[]): ItemSpec[] {
  const by = new Map<number, ItemSpec>();
  for (const r of rows) {
    const hit = by.get(r.display);
    if (hit) {
      if (r.iconFdid && !hit.icons.includes(r.iconFdid)) hit.icons.push(r.iconFdid);
      continue;
    }
    by.set(r.display, {
      displayId: r.display,
      itemId: r.itemId,
      name: r.name,
      slot: r.slot,
      line: r.line,
      icons: r.iconFdid ? [r.iconFdid] : [],
      inventoryType: r.inventoryType,
      sheatheType: r.sheatheType,
      ...(r.facet ? { facet: r.facet } : {}),
    });
  }
  return [...by.values()].sort((a, b) => a.displayId - b.displayId);
}

/** The first item that wears this display, read through the tables. */
export async function specOfItem(ctx: BakeContext, itemId: number, line = ""): Promise<ItemSpec> {
  const db = ctx.db;
  const ima = (await db.where("ItemModifiedAppearance", "ItemID", itemId)).sort((a, b) => num(a.OrderIndex) - num(b.OrderIndex))[0];
  if (!ima) throw new Error(`item ${itemId} has no appearance`);
  const app = (await db.where("ItemAppearance", "ID", ima.ItemAppearanceID ?? ""))[0];
  if (!app) throw new Error(`item ${itemId}: no ItemAppearance ${ima.ItemAppearanceID}`);
  const slot = slotOfDisplayType(num(app.DisplayType));
  if (!slot) throw new Error(`item ${itemId}: display type ${app.DisplayType} has no slot`);
  const item = (await db.where("Item", "ID", itemId))[0];
  const sparse = (await db.where("ItemSparse", "ID", itemId))[0];
  const expansion = num(sparse?.ExpansionID);
  const facet = item ? facetOf(num(item.ClassID), num(item.SubclassID)) : undefined;
  const icon = num(app.DefaultIconFileDataID) || num(item?.IconFileDataID);
  return {
    displayId: num(app.ItemDisplayInfoID),
    itemId,
    name: sparse?.Display_lang ?? "",
    slot,
    line: line || (expansion === 11 ? "midnight" : expansion === 10 ? "warwithin" : `expansion-${expansion}`),
    icons: icon ? [icon] : [],
    inventoryType: num(item?.InventoryType),
    sheatheType: num(item?.SheatheType),
    ...(facet ? { facet } : {}),
  };
}

function textureEntry(t: { key: string; bytes: number; width: number; height: number; alpha: boolean }, type: number, fdid: number): TextureEntry {
  return { ...blankTexture(type), key: t.key, bytes: t.bytes, width: t.width, height: t.height, alpha: t.alpha, fileDataId: fdid };
}

/** A part the look cannot do without: a batch that draws names a file nobody can read. */
export class MissingPart extends Error {
  constructor(what: string) {
    super(what);
    this.name = "MissingPart";
  }
}

async function tryTexture(ctx: BakeContext, files: Tracked, fdid: number, want: Want, warnings: string[]): Promise<BakedTexture | null> {
  try {
    return await bakeTexture(ctx, files, fdid, want);
  } catch (e) {
    if (!(e instanceof MissingFile)) throw e;
    warnings.push(`texture ${fdid}: ${e.message}`);
    return null;
  }
}

/** Which texture slots the visible batches read. */
export function texturesInUse(model: M2Model, skin: Skin, geosets: ReadonlySet<number>): Set<number> {
  const used = new Set<number>();
  for (const b of skin.batches) {
    const s = skin.submeshes[b.submesh];
    if (!s || !geosets.has(s.id)) continue;
    for (let k = 0; k < b.textureCount; k++) {
      const t = model.texLookup[b.textureCombo + k];
      if (t !== undefined && t >= 0) used.add(t);
    }
  }
  return used;
}

/** The textures of one piece: hard-coded ones, then the display's for each texture type. */
async function pieceLook(ctx: BakeContext, d: ResolvedDisplay, file: ModelFile, filter: GeosetFilter, picked: { race: number; sex: number; chain: readonly (readonly [number, number])[] }, model: M2Model, skin: Skin, files: Tracked): Promise<ModelLook> {
  const warnings: string[] = [];
  const textures: TextureEntry[] = [];
  const geosets = new Set(skin.submeshes.map((s) => s.id).filter((id) => filter.keep(id)));
  if (geosets.size === 0) throw new MissingPart(`no submesh of ${file.fdid} shows under ${filter.tag}`);
  const used = texturesInUse(model, skin, geosets);
  for (let i = 0; i < model.textures.length; i++) {
    const tex = model.textures[i]!;
    let fdid = tex.type === 0 ? tex.fileDataId : 0;
    if (!fdid) {
      const extra = d.extraTextures.find((e) => e.type === tex.type && e.modelIndex === file.k);
      const list = extra?.files ?? (tex.type === 2 ? d.modelTextures[file.k] : undefined) ?? [];
      fdid = pickTexture(list, picked.race, picked.sex, picked.chain)?.fdid ?? 0;
    }
    if (!fdid) {
      textures.push(blankTexture(tex.type));
      continue;
    }
    const t = await tryTexture(ctx, files, fdid, { cap: ITEM_TEXTURE_CAP }, warnings);
    if (!t && used.has(i)) throw new MissingPart(`texture ${fdid} of ${file.fdid} cannot be read`);
    textures.push(t ? textureEntry(t, tex.type, fdid) : blankTexture(tex.type));
  }
  const particleColors = await particleColorsOf(ctx.db, model, num(d.row.ParticleColorID));
  return { geosets, textures, warnings, ...(particleColors ? { manifest: { particleColors } } : {}) };
}

async function iconObject(ctx: BakeContext, files: Tracked, fdid: number): Promise<string> {
  if (!fdid) return "";
  const known = await files.identity(fdid);
  if (known && !ctx.force) {
    const key = `objects/${inputKey("itemicon", STAGE.icon, known)}.webp`;
    if ((await ctx.store.stat(key)) !== null) return key;
  }
  const f = await files.read(fdid);
  const key = `objects/${inputKey("itemicon", STAGE.icon, f.id)}.webp`;
  if (ctx.force || (await ctx.store.stat(key)) === null) {
    const info = blpInfo(f.bytes);
    const img = decodeBlp(f.bytes, blpLevelUnder(info, ICON_SIZE));
    const raw = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
    const body = await sharp(raw, { raw: { width: img.width, height: img.height, channels: 4 } }).webp({ quality: 84, effort: 6 }).toBuffer();
    await ctx.store.put(key, body);
  }
  return key;
}

/** Everything a manifest names, so nothing reaches the site with a hole in it. */
export function objectsOfItem(m: ItemManifest): string[] {
  const out: string[] = [];
  for (const model of Object.values(m.models ?? {})) {
    out.push(model.glb.key);
    if (model.fx) out.push(model.fx.key);
    if (model.phys) out.push(model.phys.key);
    for (const t of model.textures) if (t.key) out.push(t.key);
    for (const c of model.clips) out.push(c.key);
  }
  for (const l of m.bodyLayers) out.push(l.key);
  for (const list of Object.values(m.bodyLayersBy ?? {})) for (const l of list) out.push(l.key);
  for (const t of m.bodyTextures ?? []) out.push(t.key);
  if (m.phys) out.push(m.phys.key);
  return [...new Set(out)];
}

/** The self-check: empty means every object exists and passed its load check. */
export function failedObjects(store: unknown, keys: readonly string[]): string[] {
  const index = store as { object?: (k: string) => { ok: boolean } | undefined };
  if (!index.object) return [];
  return keys.filter((k) => !index.object!(k)?.ok);
}

export function hasAnyPart(m: ItemManifest): boolean {
  return m.attached.length > 0 || Object.keys(m.attachedBy ?? {}).length > 0 || Object.keys(m.collections).length > 0 || m.bodyLayers.length > 0 || Object.keys(m.bodyLayersBy ?? {}).length > 0 || (m.bodyTextures?.length ?? 0) > 0;
}

/**
 * One wearable. The manifest is written last, so its presence means finished, and it
 * only names objects that are already up. Geometry is one object per file: every body,
 * own cut or donor, points at the same GLB, and only the manifest names which.
 */
export async function bakeItem(ctx: BakeContext, spec: ItemSpec): Promise<{ manifest: ItemManifest; warnings: string[]; inputs: Record<string, string>; icons: Record<string, string>; notOn: string[] }> {
  const d = await resolveDisplay(ctx.db, spec.displayId);
  const id = itemUnitId(spec.displayId);
  const files = new Tracked(ctx.source);
  const warnings: string[] = [];
  const table = await bodyTable(ctx);
  const collections: ItemManifest["collections"] = {};
  const models = new Map<string, Promise<BakedModel>>();
  let phys: ItemManifest["phys"];
  const handFlags = d.flags & 0x1d00;

  const asked = table.bodies.filter((b) => !ctx.onlyBodies || ctx.onlyBodies.has(b.spec.id));

  const lookKey = (file: ModelFile, filter: GeosetFilter, race: number, sex: number, chain: readonly (readonly [number, number])[]): string => {
    const parts: (number | string)[] = [filter.tag, num(d.row.ParticleColorID)];
    for (const list of [d.modelTextures[file.k] ?? [], ...d.extraTextures.filter((e) => e.modelIndex === file.k).map((e) => e.files)]) {
      parts.push(pickTexture(list, race, sex, chain)?.fdid ?? 0);
    }
    return md5Hex(Buffer.from(parts.join(","))).slice(0, 12);
  };

  /** One model, once. A piece's clip: its own stand, if anything in it moves. */
  const modelFor = (modelId: string, file: ModelFile, filter: GeosetFilter, picked: { race: number; sex: number; chain: readonly (readonly [number, number])[] }, kind: "pinned" | "skinned"): Promise<BakedModel> => {
    let hit = models.get(modelId);
    if (!hit) {
      hit = bakeModel(ctx, {
        id: modelId,
        kind: "item",
        name: spec.name,
        m2: file.fdid,
        inline: true,
        noClips: kind === "skinned",
        clipFilter: (seq) => seq.id === 0 && seq.variation === 0,
        skipStaticClips: true,
        look: (model, skin, f) => pieceLook(ctx, d, file, filter, picked, model, skin, f),
      }).then((m) => {
        Object.assign(files.inputs, m.inputs);
        warnings.push(...m.manifest.warnings);
        if (m.manifest.phys && !phys) phys = m.manifest.phys;
        return m;
      });
      models.set(modelId, hit);
    }
    return hit;
  };

  // A model file can be shared with other slots, and then this slot shows only its part.
  const combined = new Map<number, boolean>();
  for (const k of [0, 1]) {
    const res = num(d.row[`ModelResourcesID_${k}`]);
    if (res && !combined.has(res)) combined.set(res, await isCombined(ctx.db, res, spec.slot));
  }
  const combinedK = (k: number) => combined.get(num(d.row[`ModelResourcesID_${k}`])) ?? false;

  /**
   * The file for one body, and the race whose textures it wears. Own race, retail's chain,
   * a race-agnostic file; then the best donor. A donor is the file of the closest body
   * retail did cut it for, referenced as it is.
   */
  const pick = (list: ModelFile[], body: BodyInfo): { file: ModelFile; race: number; sex: number; chain: readonly (readonly [number, number])[]; donor?: string } | null => {
    const file = fileForBody(list, body.raceId, body.sex, body.modelChain);
    if (file) return { file, race: file.race || body.raceId, sex: body.sex, chain: body.textureChain };
    for (const donor of donorsOf(table, body, spec.slot === "head" ? "head" : "skinned")) {
      const hit = fileForBody(list, donor.raceId, donor.sex);
      if (hit) return { file: hit, race: donor.raceId, sex: donor.sex, chain: donor.textureChain, donor: donor.spec.id };
    }
    return null;
  };

  const sheathRow = num(d.row.SheatheTransformMatrixID);
  let sheath: number[] | undefined;
  if (sheathRow) {
    const r = (await ctx.db.where("TransformMatrix", "ID", sheathRow))[0];
    if (r) sheath = sheathMatrix([num(r.Pos_0), num(r.Pos_1), num(r.Pos_2)], num(r.Yaw), num(r.Pitch), num(r.Roll), num(r.Scale));
  }
  const sheathPoints = spec.slot === "mainhand" || spec.slot === "offhand" || spec.slot === "ranged" ? sheathPointsOf(spec.sheatheType) : undefined;

  // Only a body retail draws nothing on needs a donor, and only then are the skeletons read.
  const needDonor = asked.some((b) => {
    for (const k of [0, 1]) {
      const list = d.models.filter((m) => m.k === k);
      if (list.length && !fileForBody(list, b.raceId, b.sex, b.modelChain)) return true;
    }
    return false;
  });
  if (needDonor) await measureFit(ctx, table);

  // ---- pieces pinned to an attachment, per body: helms are cut per race and sex
  const pinned = d.models.filter((m) => !isSkinnedModel(d, m, spec.slot, spec.inventoryType));
  const attachedBy: NonNullable<ItemManifest["attachedBy"]> = {};
  let pinnedFailure: Error | null = null;
  if (pinned.length) {
    for (const body of asked) {
      const list: AttachedPiece[] = [];
      for (const k of [0, 1]) {
        // A shoulder's two sides can name one resource: position says which file is which.
        const ofK = pinned.filter((m) => m.k === k);
        const sided = ofK.some((m) => m.position >= 0) ? ofK.filter((m) => m.position === k) : ofK;
        const hit = pick(sided, body);
        if (!hit) continue;
        const attachment = attachmentFor(spec.slot, hit.file, spec.inventoryType);
        if (attachment === null || list.some((a) => a.attachment === attachment)) continue;
        const filter = geosetFilter(d, spec.slot, combinedK(k));
        const modelId = `itemm-${hit.file.fdid}-${lookKey(hit.file, filter, hit.race, hit.sex, hit.chain)}`;
        try {
          await modelFor(modelId, hit.file, filter, hit, "pinned");
        } catch (e) {
          if (!(e instanceof MissingFile) && !(e instanceof MissingPart)) throw e;
          // This body's cut cannot be read: this body goes without, and it is said.
          warnings.push(`${body.spec.id}: ${e.message}`);
          pinnedFailure = e;
          models.delete(modelId);
          continue;
        }
        list.push({
          attachment,
          manifest: modelId,
          ...(handFlags ? { handFlags } : {}),
          ...(sheath ? { sheath } : {}),
          ...(sheathPoints ? { sheathPoints: [sheathPoints[0], sheathPoints[1]] as [number, number] } : {}),
          ...(hit.donor ? { donor: hit.donor } : {}),
        });
      }
      if (list.length) attachedBy[body.spec.id] = list;
    }
    if (Object.keys(attachedBy).length === 0 && pinnedFailure) throw pinnedFailure;
  }
  // Every body wearing the same pieces is the common case: weapons, and capes.
  const lists = Object.values(attachedBy);
  const attached = lists[0] ?? [];
  const samePieces = lists.length === asked.length && lists.every((l) => JSON.stringify(l) === JSON.stringify(attached));

  // ---- skinned collections: the body's bones are found by name hash, at load
  const skinned = d.models.filter((m) => isSkinnedModel(d, m, spec.slot, spec.inventoryType));
  if (skinned.length) {
    let failure: Error | null = null;
    for (const body of asked) {
      const hit = pick(skinned, body);
      if (!hit) continue;
      const filter = geosetFilter(d, spec.slot, combinedK(hit.file.k));
      const modelId = `itemc-${hit.file.fdid}-${lookKey(hit.file, filter, hit.race, hit.sex, hit.chain)}`;
      try {
        await modelFor(modelId, hit.file, filter, hit, "skinned");
      } catch (e) {
        if (!(e instanceof MissingFile) && !(e instanceof MissingPart)) throw e;
        warnings.push(`${body.spec.id}: ${e.message}`);
        failure = e;
        models.delete(modelId);
        continue;
      }
      collections[body.spec.id] = { manifest: modelId, ...(hit.donor ? { donor: hit.donor } : {}) };
    }
    if (Object.keys(collections).length === 0 && failure) throw failure;
  }

  // ---- what the item paints on the body's own texture slots: a cloak's type 2
  const bodyTextures: NonNullable<ItemManifest["bodyTextures"]> = [];
  if (d.models.length === 0) {
    const list = d.modelTextures[0] ?? [];
    const file = pickTexture(list, 0, 0);
    if (file) {
      const t = await tryTexture(ctx, files, file.fdid, { cap: ITEM_TEXTURE_CAP }, warnings);
      if (!t) throw new MissingPart(`texture ${file.fdid} cannot be read`);
      bodyTextures.push({ type: 2, key: t.key, bytes: t.bytes, width: t.width, height: t.height, alpha: t.alpha });
    }
  }

  // ---- body-texture pieces, per body: its race, retail's texture chain, any race
  const perBody = new Map<string, Map<number, number>>();
  let regions = 0;
  for (const s of d.sections) {
    regions |= 1 << s.section;
    const usable = s.files.filter((f) => f.usage === 0);
    if (!usable.length) continue;
    for (const body of asked) {
      const file = pickTexture(usable, body.raceId, body.sex, body.textureChain);
      if (!file) continue;
      let list = perBody.get(body.spec.id);
      if (!list) perBody.set(body.spec.id, (list = new Map()));
      list.set(s.section, file.fdid);
    }
  }
  const layerObject = new Map<number, BakedTexture>();
  for (const fdid of new Set([...perBody.values()].flatMap((m) => [...m.values()]))) {
    const t = await tryTexture(ctx, files, fdid, { cap: SECTION_CAP }, warnings);
    if (!t) throw new MissingPart(`body texture ${fdid} cannot be read`);
    layerObject.set(fdid, t);
  }
  const bodyLayers: ItemManifest["bodyLayers"] = [];
  let bodyLayersBy: ItemManifest["bodyLayersBy"];
  const signature = (bodies: BodyInfo[]) => new Set(bodies.map((b) => JSON.stringify([...(perBody.get(b.spec.id) ?? new Map<number, number>())].sort((x, y) => x[0] - y[0]))));
  const males = asked.filter((b) => b.sex === 0);
  const females = asked.filter((b) => b.sex === 1);
  if (perBody.size) {
    if (signature(males).size <= 1 && signature(females).size <= 1) {
      // Each sex has one answer, which is nearly every item: a few bytes per item.
      const male = males[0] ? perBody.get(males[0].spec.id) : undefined;
      const female = females[0] ? perBody.get(females[0].spec.id) : undefined;
      for (const section of new Set([...(male?.keys() ?? []), ...(female?.keys() ?? [])])) {
        const m = male?.get(section);
        const f = female?.get(section);
        if (m !== undefined && m === f) {
          const t = layerObject.get(m)!;
          bodyLayers.push({ section, key: t.key, bytes: t.bytes });
          continue;
        }
        if (m !== undefined) {
          const t = layerObject.get(m)!;
          bodyLayers.push({ section, key: t.key, bytes: t.bytes, sex: 0 });
        }
        if (f !== undefined) {
          const t = layerObject.get(f)!;
          bodyLayers.push({ section, key: t.key, bytes: t.bytes, sex: 1 });
        }
      }
    } else {
      bodyLayersBy = {};
      for (const [bodyId, list] of perBody) {
        bodyLayersBy[bodyId] = [...list].map(([section, fdid]) => {
          const t = layerObject.get(fdid)!;
          return { section, key: t.key, bytes: t.bytes };
        });
      }
    }
  }

  // ---- geoset rules
  const geosetGroups: Record<number, number> = {};
  d.geosetGroups.forEach((v, i) => {
    if (v) geosetGroups[i] = v;
  });
  const helmetHide: Record<string, number[]> = {};
  if (spec.slot === "head") {
    for (const vis of d.helmetVis) {
      if (!vis) continue;
      for (const row of await ctx.db.where("HelmetGeosetData", "HelmetGeosetVisDataID", vis)) {
        const group = num(row.HideGeosetGroup);
        const race = num(row.RaceID);
        const targets = race === 0 ? ["*"] : table.bodies.filter((b) => b.raceId === race).map((b) => b.spec.id);
        for (const t of targets) {
          const list = (helmetHide[t] ??= []);
          if (!list.includes(group)) list.push(group);
        }
      }
    }
  }

  const icons: Record<string, string> = {};
  for (const fdid of spec.icons) {
    try {
      const key = await iconObject(ctx, files, fdid);
      if (key) icons[String(fdid)] = key;
    } catch (e) {
      if (!(e instanceof MissingFile)) throw e;
      warnings.push(`icon ${fdid}: ${e.message}`);
    }
  }

  const inline: Record<string, ModelManifest> = {};
  for (const [modelId, promise] of models) {
    const { manifest } = await promise;
    const { warnings: _dropped, ...rest } = manifest;
    inline[modelId] = { ...rest, warnings: [] };
  }

  const pad = padBits(d.flags, d.modelTypes);
  const manifest: ItemManifest = {
    formatVersion: FORMAT_VERSION,
    id,
    slot: spec.slot,
    attached,
    ...(samePieces ? {} : { attachedBy }),
    collections,
    bodyLayers,
    ...(bodyLayersBy ? { bodyLayersBy } : {}),
    ...(bodyTextures.length ? { bodyTextures } : {}),
    geosetGroups,
    ...(phys ? { phys } : {}),
    ...(pad ? { pad } : {}),
    regions,
    // The chest's display flag 4 suppresses the legs.
    ...(spec.slot === "chest" && d.flags & 4 ? { compFlags: 0x20 } : {}),
    ...(Object.keys(helmetHide).length ? { helmetHide } : {}),
    models: inline,
    name: spec.name,
    ...(Object.values(icons)[0] ? { icon: Object.values(icons)[0] } : {}),
  };
  if (!hasAnyPart(manifest)) throw new MissingPart(`display ${spec.displayId} draws nothing on any body`);
  const bad = failedObjects(ctx.store, objectsOfItem(manifest));
  if (bad.length) throw new MissingPart(`${bad.length} object(s) failed their load check, first ${bad[0]}`);
  await ctx.store.put(paths.item(id), Buffer.from(JSON.stringify(manifest)));
  // A piece with models that a body gets nothing of, not even a layer, is hidden on that body.
  const notOn = d.models.length === 0 ? [] : asked.filter((b) => !attachedBy[b.spec.id] && !collections[b.spec.id] && !perBody.get(b.spec.id)?.size).map((b) => b.spec.id);
  return { manifest, warnings: [...new Set(warnings)], inputs: files.inputs, icons, notOn };
}

export async function bakeItemUnit(ctx: BakeContext, spec: ItemSpec): Promise<BakeRecord> {
  const start = Date.now();
  const id = itemUnitId(spec.displayId);
  const base = { id, kind: "item", build: BUILD.version, baker: BAKER_VERSION, source: ctx.source.name, bakedAt: new Date().toISOString() };
  try {
    const out = await bakeItem(ctx, spec);
    const rec: BakeRecord = { ...base, status: "ok", inputs: {}, warnings: out.warnings, seconds: (Date.now() - start) / 1000, validated: true, icons: out.icons, ...(out.notOn.length ? { notOn: out.notOn } : {}) };
    await writeRecord(ctx.store, rec);
    log(`  ${id}: ${spec.name}, ${out.manifest.attached.length} attached, ${Object.keys(out.manifest.collections).length} collection(s), ${out.manifest.bodyLayers.length} layer(s)`);
    return rec;
  } catch (e) {
    if (e instanceof Error && e.name === "BudgetExceeded") throw e;
    const rec: BakeRecord = { ...base, status: "failed", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), inputs: {}, warnings: [], seconds: (Date.now() - start) / 1000 };
    await writeRecord(ctx.store, rec);
    return rec;
  }
}
