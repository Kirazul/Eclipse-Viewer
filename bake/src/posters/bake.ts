import sharp from "sharp";
import { BUILD, R2, packUrl, paths, toStraightAlpha, type ItemManifest, type ModelManifest, type SlotId } from "@eclipse/format";
import { type BakeContext, type BakeRecord, readRecord, writeRecord } from "../bake/context";
import { itemUnitId } from "../items/bake";
import type { LineRow, LineSet } from "../items/lines";
import type { MountFamily } from "../mounts/scan";
import { modelIdOfDisplay } from "../mounts/bake";
import { recordsOf } from "../commands/catalog";
import type { Unit } from "../commands/scope";
import { PosterBrowser } from "./browser";
import {
  CELL_SIZE,
  POSTER_BAKER,
  POSTER_BODIES,
  SET_SIZE,
  WEAPON_SLOTS,
  modelSignature,
  posterKey,
  posterUnitId,
  wornSignature,
  type PosterSize,
  type PosterSpec,
} from "./spec";

/**
 * `posters:<scope>`: mounts, mount:<id>, model:<model id>, sample-mounts:<n>, items,
 * items:<line>, display:<id>, sample:<n>, sets, sets:<line>, set:<id>, sample-sets:<n>, all, or a
 * comma list of those, each after `posters:`. Only what passed its own bake has a poster.
 *
 * Models come from the bucket, or from POSTER_BASE: a local proof reads R2's real packs
 * over the public URL and writes its posters only to site/public/packs.
 */

/** About 8 KB for a poster, by measurement: the ladder only comes down for a busy one. */
const QUALITY_LADDER = [
  { quality: 74, alpha: 78, under: 9_500 },
  { quality: 62, alpha: 68, under: 11_000 },
  { quality: 48, alpha: 56, under: 13_000 },
  { quality: 36, alpha: 44, under: Infinity },
] as const;

/** A frame with less than this on it drew nothing a person could call a poster. */
const MIN_COVERAGE = 0.005;

/** No retry changes this: the entry keeps its icon, and the report says why. */
class PosterRefused extends Error {}

export async function encodePoster(pixels: Uint8Array, width: number, height: number, size: PosterSize): Promise<{ webp: Buffer; coverage: number; edge: number }> {
  const { rgba, stats } = toStraightAlpha(pixels, width, height);
  const small = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .resize(size.width, size.height, { kernel: "lanczos3", fit: "fill" })
    .raw()
    .toBuffer();
  let webp: Buffer = Buffer.alloc(0);
  for (const step of QUALITY_LADDER) {
    webp = await sharp(small, { raw: { width: size.width, height: size.height, channels: 4 } }).webp({ quality: step.quality, alphaQuality: step.alpha, effort: 6, smartSubsample: true }).toBuffer();
    if (webp.length <= step.under * (size.width * size.height) / (CELL_SIZE.width * CELL_SIZE.height)) break;
  }
  return { webp, coverage: stats.coverage, edge: stats.edge };
}

// --- The inputs -------------------------------------------------------------

/** Where this run reads from: one place for JSON, and the same base for the browser. */
interface Inputs {
  base: string;
  json<T>(key: string): Promise<T | null>;
  records(): Promise<Map<string, BakeRecord>>;
}

const inputsFor = new WeakMap<object, Inputs>();

function inputs(ctx: BakeContext): Inputs {
  let hit = inputsFor.get(ctx);
  if (hit) return hit;
  const publicBase = process.env.POSTER_BASE;
  if (publicBase) {
    hit = {
      base: publicBase,
      json: async <T,>(key: string) => {
        const res = await fetch(packUrl(publicBase, key));
        return res.ok ? ((await res.json()) as T) : null;
      },
      records: async () => {
        const res = await fetch(packUrl(publicBase, "reports/records.json"));
        const list = res.ok ? ((await res.json()) as BakeRecord[]) : [];
        return new Map(list.map((r) => [r.id, r]));
      },
    };
  } else {
    hit = {
      base: ctx.store.name === "r2" ? R2.publicBase : "/packs",
      json: async <T,>(key: string) => {
        const b = await ctx.store.get(key);
        return b ? (JSON.parse(b.toString("utf8")) as T) : null;
      },
      records: () => recordsOf(ctx.store),
    };
  }
  inputsFor.set(ctx, hit);
  return hit;
}

// --- One browser per run ------------------------------------------------------

let opened: Promise<PosterBrowser> | null = null;

function browser(ctx: BakeContext): Promise<PosterBrowser> {
  opened ??= PosterBrowser.open(inputs(ctx).base, Number(process.env.POSTER_PAGES ?? 2));
  return opened;
}

export async function closePosterBrowser(): Promise<void> {
  const b = opened;
  opened = null;
  if (b) await (await b).close();
}

// --- The bodies, once each ----------------------------------------------------

const bodySignatures = new Map<string, Promise<string>>();

function bodySignature(ctx: BakeContext, id: string): Promise<string> {
  let hit = bodySignatures.get(id);
  if (!hit) {
    hit = inputs(ctx)
      .json<ModelManifest>(paths.manifest(id))
      .then((m) => {
        if (!m) throw new Error(`body ${id} is not baked`);
        return modelSignature(m);
      });
    bodySignatures.set(id, hit);
  }
  return hit;
}

// --- Drawing -----------------------------------------------------------------

interface Made {
  key: string;
  bytes: number;
  reused: boolean;
  coverage: number;
  edge: number;
}

/** A poster already in the store is not drawn again: this is where a shared model pays once. */
async function makePoster(ctx: BakeContext, key: string, spec: PosterSpec, size: PosterSize): Promise<Made | { nothing: true }> {
  if (!ctx.force) {
    const there = await ctx.store.stat(key);
    if (there !== null) return { key, bytes: there, reused: true, coverage: 1, edge: 0 };
  }
  const drawn = await (await browser(ctx)).draw(spec, size.width, size.height);
  if (drawn.nothing) return { nothing: true };
  const { webp, coverage, edge } = await encodePoster(drawn.pixels, drawn.width, drawn.height, size);
  if (coverage < MIN_COVERAGE) throw new PosterRefused(`the frame is empty: ${(coverage * 100).toFixed(2)}% covered`);
  await ctx.store.put(key, webp);
  return { key, bytes: webp.length, reused: false, coverage, edge };
}

function baseRecord(id: string, started: number): BakeRecord {
  return { id, kind: "poster", status: "ok", build: BUILD.version, baker: POSTER_BAKER, source: "posters", inputs: {}, warnings: [], seconds: (Date.now() - started) / 1000, bakedAt: new Date().toISOString(), validated: true };
}

async function finish(ctx: BakeContext, id: string, started: number, work: () => Promise<Record<string, string>>): Promise<BakeRecord> {
  let rec: BakeRecord;
  try {
    const posters = await work();
    if (Object.keys(posters).length === 0) throw new PosterRefused("nothing to show on either body");
    rec = { ...baseRecord(id, started), posters };
  } catch (e) {
    if ((e as Error).name === "BudgetExceeded") throw e;
    rec = { ...baseRecord(id, started), status: "failed", error: e instanceof Error ? e.message : String(e), validated: false, ...(e instanceof PosterRefused ? { final: true } : {}) };
  }
  rec.seconds = (Date.now() - started) / 1000;
  await writeRecord(ctx.store, rec);
  return rec;
}

function mountUnit(modelId: string): Unit {
  const id = posterUnitId(modelId);
  return {
    id,
    kind: "poster",
    output: paths.manifest(modelId),
    done: (ctx) => posterDone(ctx, id),
    bake: (ctx) =>
      finish(ctx, id, Date.now(), async () => {
        const m = await inputs(ctx).json<ModelManifest>(paths.manifest(modelId));
        if (!m) throw new PosterRefused(`${modelId} is not baked`);
        const made = await makePoster(ctx, posterKey("creature", modelSignature(m)), { bodyId: modelId }, CELL_SIZE);
        if ("nothing" in made) throw new PosterRefused("nothing to show");
        return { male: made.key };
      }),
  };
}

function itemUnit(display: number): Unit {
  const entryId = itemUnitId(display);
  const id = posterUnitId(entryId);
  return {
    id,
    kind: "poster",
    output: paths.item(entryId),
    done: (ctx) => posterDone(ctx, id),
    bake: (ctx) =>
      finish(ctx, id, Date.now(), async () => {
        const m = await inputs(ctx).json<ItemManifest>(paths.item(entryId));
        if (!m) throw new PosterRefused(`${entryId} is not baked`);
        const first = m.attached?.[0];
        if (WEAPON_SLOTS.includes(m.slot) && first) {
          // Alone, so one poster whatever the body, and the model is all that decides it.
          const piece = m.models?.[first.manifest] ?? (await inputs(ctx).json<ModelManifest>(paths.manifest(first.manifest)));
          if (!piece) throw new PosterRefused(`${first.manifest} is not baked`);
          const made = await makePoster(ctx, posterKey("alone", m.slot, first.attachment, modelSignature(piece)), { itemId: entryId }, CELL_SIZE);
          if ("nothing" in made) throw new PosterRefused("nothing to show");
          return { male: made.key };
        }
        const out: Record<string, string> = {};
        for (const [sex, bodyId] of Object.entries(POSTER_BODIES)) {
          if (ctx.onlyBodies && !ctx.onlyBodies.has(bodyId)) continue;
          const key = posterKey("worn", bodyId, await bodySignature(ctx, bodyId), wornSignature(m, bodyId));
          const made = await makePoster(ctx, key, { bodyId, itemId: entryId }, CELL_SIZE);
          if (!("nothing" in made)) out[sex] = made.key;
        }
        return out;
      }),
  };
}

function setUnit(set: { id: string; pieces: Partial<Record<SlotId, string>> }): Unit {
  const id = posterUnitId(set.id);
  return {
    id,
    kind: "poster",
    output: paths.item(Object.values(set.pieces)[0]!),
    done: (ctx) => posterDone(ctx, id),
    bake: (ctx) =>
      finish(ctx, id, Date.now(), async () => {
        const entries = Object.entries(set.pieces) as [SlotId, string][];
        const read = await Promise.all(entries.map(([, p]) => inputs(ctx).json<ItemManifest>(paths.item(p))));
        // A piece that isn't baked is not in the set, as the catalogue lists it.
        const pieces = Object.fromEntries(entries.filter((_, i) => read[i])) as Partial<Record<SlotId, string>>;
        const manifests = read.filter((m): m is ItemManifest => !!m);
        if (!manifests.length) throw new PosterRefused("no piece of this set is baked");
        const out: Record<string, string> = {};
        for (const [sex, bodyId] of Object.entries(POSTER_BODIES)) {
          if (ctx.onlyBodies && !ctx.onlyBodies.has(bodyId)) continue;
          const signature = manifests.map((m) => wornSignature(m, bodyId)).sort().join("\0");
          const key = posterKey("set", bodyId, await bodySignature(ctx, bodyId), signature);
          const made = await makePoster(ctx, key, { bodyId, pieces }, SET_SIZE);
          if (!("nothing" in made)) out[sex] = made.key;
        }
        return out;
      }),
  };
}

/** Finished by this stage of the poster baker, whatever build or baker made the model. */
async function posterDone(ctx: BakeContext, id: string): Promise<boolean> {
  if (ctx.force) return false;
  const r = await readRecord(ctx.store, id);
  if (!r || r.status !== "ok" || r.baker !== POSTER_BAKER || !r.posters) return false;
  for (const key of Object.values(r.posters)) if ((await ctx.store.stat(key)) === null) return false;
  return true;
}

// --- Scopes -------------------------------------------------------------------

interface Snapshot {
  line: string;
  rows: LineRow[];
  sets: LineSet[];
}

const memo = new WeakMap<object, { lines: Promise<Snapshot[]>; families: Promise<MountFamily[]>; records: Promise<Map<string, BakeRecord>> }>();

function data(ctx: BakeContext) {
  let hit = memo.get(ctx);
  if (!hit) {
    const from = inputs(ctx);
    hit = {
      lines: from.json<Snapshot[]>("reports/lines.json").then((l) => l ?? []),
      families: from.json<{ families: MountFamily[] }>("reports/mounts.json").then((m) => m?.families ?? []),
      records: from.records(),
    };
    memo.set(ctx, hit);
  }
  return hit;
}

function passed(records: ReadonlyMap<string, BakeRecord>, id: string): boolean {
  const r = records.get(id);
  return !!r && r.status === "ok" && r.validated === true;
}

async function mountUnits(ctx: BakeContext, families: readonly MountFamily[]): Promise<Unit[]> {
  const records = await data(ctx).records;
  const out: Unit[] = [];
  for (const f of families) {
    const rec = records.get(f.id);
    if (!rec || !passed(records, f.id)) continue;
    const ok = new Set(rec.variants ?? []);
    for (const v of f.variants) if (ok.has(v.display)) out.push(mountUnit(modelIdOfDisplay(v.display)));
  }
  return out;
}

async function itemUnits(ctx: BakeContext, line?: string): Promise<Unit[]> {
  const { lines, records } = data(ctx);
  const baked = await records;
  const seen = new Set<number>();
  const out: Unit[] = [];
  for (const snap of await lines) {
    if (line && snap.line !== line) continue;
    for (const r of snap.rows) {
      if (seen.has(r.display) || !passed(baked, itemUnitId(r.display))) continue;
      seen.add(r.display);
      out.push(itemUnit(r.display));
    }
  }
  return out;
}

async function setUnits(ctx: BakeContext, line?: string): Promise<Unit[]> {
  const { lines, records } = data(ctx);
  const baked = await records;
  const out: Unit[] = [];
  for (const snap of await lines) {
    if (line && snap.line !== line) continue;
    for (const s of snap.sets) {
      const pieces: Partial<Record<SlotId, string>> = {};
      for (const [slot, display] of Object.entries(s.pieces) as [SlotId, number][]) {
        const id = itemUnitId(display);
        if (passed(baked, id)) pieces[slot] = id;
      }
      if (Object.keys(pieces).length) out.push(setUnit({ id: s.id, pieces }));
    }
  }
  return out;
}

async function setById(ctx: BakeContext, id: string): Promise<Unit[]> {
  for (const snap of await data(ctx).lines) {
    const s = snap.sets.find((x) => x.id === id);
    if (s) return [setUnit({ id: s.id, pieces: Object.fromEntries((Object.entries(s.pieces) as [SlotId, number][]).map(([slot, d]) => [slot, itemUnitId(d)])) })];
  }
  throw new Error(`no set ${id} in the lines`);
}

function everyNth<T>(list: readonly T[], count: number): T[] {
  if (count >= list.length) return [...list];
  const step = list.length / count;
  return Array.from({ length: count }, (_, i) => list[Math.floor(i * step)]!);
}

export async function posterUnits(ctx: BakeContext, scope: string): Promise<Unit[]> {
  const { families } = data(ctx);
  if (scope === "mounts") return mountUnits(ctx, await families);
  if (scope.startsWith("mount:")) {
    const id = Number(scope.slice(6));
    const family = (await families).find((f) => f.mountId === id || f.variants.some((v) => v.mountId === id));
    if (!family) throw new Error(`no mount ${id} in the scan`);
    return mountUnits(ctx, [family]);
  }
  if (scope.startsWith("sample-mounts:")) return everyNth(await mountUnits(ctx, await families), Number(scope.slice(14)));
  if (scope.startsWith("model:")) return [mountUnit(scope.slice(6))];
  if (scope === "items") return itemUnits(ctx);
  if (scope.startsWith("items:")) return itemUnits(ctx, scope.slice(6));
  if (scope.startsWith("sample:")) return everyNth(await itemUnits(ctx), Number(scope.slice(7)));
  if (scope.startsWith("display:")) return [itemUnit(Number(scope.slice(8)))];
  if (scope === "sets") return setUnits(ctx);
  if (scope.startsWith("sets:")) return setUnits(ctx, scope.slice(5));
  if (scope.startsWith("set:")) return setById(ctx, scope.slice(4));
  if (scope.startsWith("sample-sets:")) return everyNth(await setUnits(ctx), Number(scope.slice(12)));
  if (scope === "all") return [...(await mountUnits(ctx, await families)), ...(await itemUnits(ctx)), ...(await setUnits(ctx))];
  throw new Error(`unknown poster scope ${JSON.stringify(scope)}: mounts, mount:<id>, model:<model id>, sample-mounts:<n>, items, items:<line>, display:<id>, sample:<n>, sets, sets:<line>, sample-sets:<n> or all`);
}
