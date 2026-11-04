import sharp from "sharp";
import { BUILD, type UiAtlas, type UiSprite, paths } from "@eclipse/format";
import { type BakeContext, type BakeRecord, Tracked, writeRecord } from "../bake/context";
import { byId, num } from "../db2/db2";
import { BAKER_VERSION, log } from "../lib/env";
import { type Rgba, decodeBlp } from "../tex/blp";
import { crop, opaqueBounds, overhangOf, rangedFromClassic, toWhite } from "./image";
import { CLASSIC, CLASSIC_RIM, FILE_SCENES, SCENES, SPRITES, type SpriteSpec } from "./sprites";

/** A scene is shown one at a time, and a flipbook only when it plays: each stays a file of its own. */
const STANDS_ALONE = /^(scene-|flip-)/;
/** A gutter wide enough that no neighbour bleeds in when a sprite is cut out at its exact rect. */
const ATLAS_GUTTER = 2;
const ATLAS_WIDTH = 2048;

/** Tallest first on shelves: nothing clever, and these are few. */
export function shelfPack(sizes: readonly { name: string; w: number; h: number }[], width = ATLAS_WIDTH, gutter = ATLAS_GUTTER): { rects: UiAtlas["sprites"]; width: number; height: number } {
  const order = [...sizes].sort((a, b) => b.h - a.h || a.name.localeCompare(b.name));
  const rects: UiAtlas["sprites"] = {};
  let x = 0;
  let y = 0;
  let shelf = 0;
  let used = 0;
  for (const s of order) {
    if (x + s.w > width) {
      x = 0;
      y += shelf + gutter;
      shelf = 0;
    }
    rects[s.name] = { x, y, w: s.w, h: s.h };
    x += s.w + gutter;
    used = Math.max(used, x);
    shelf = Math.max(shelf, s.h);
  }
  return { rects, width: Math.max(1, used - gutter), height: Math.max(1, y + shelf) };
}

async function packAtlas(items: readonly { name: string; img: Rgba }[]): Promise<{ image: Buffer; map: UiAtlas }> {
  const layout = shelfPack(items.map((i) => ({ name: i.name, w: i.img.width, h: i.img.height })));
  const image = await sharp({ create: { width: layout.width, height: layout.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(items.map((i) => {
      const r = layout.rects[i.name]!;
      return { input: Buffer.from(i.img.data.buffer, i.img.data.byteOffset, i.img.data.length), raw: { width: i.img.width, height: i.img.height, channels: 4 as const }, left: r.x, top: r.y };
    }))
    .webp({ lossless: true, effort: 6 })
    .toBuffer();
  return { image, map: { width: layout.width, height: layout.height, sprites: layout.rects } };
}

/** Retail's pixels exactly: no lossy step on art this soft-edged. */
async function webp(img: Rgba): Promise<Buffer> {
  return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.width, height: img.height, channels: 4 } }).webp({ lossless: true, effort: 6 }).toBuffer();
}

async function resized(img: Rgba, width: number, height: number): Promise<Rgba> {
  const data = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize(width, height, { kernel: "lanczos3", fit: "fill" })
    .raw()
    .toBuffer();
  return { width, height, data };
}

/** Retail's atlas members by lowercased name, and the sheets they live on. */
async function atlasReader(ctx: BakeContext, files: Tracked) {
  const sheets = byId(await ctx.db.table("UiTextureAtlas"));
  const members = new Map<string, Record<string, string>>();
  for (const r of await ctx.db.table("UiTextureAtlasMember")) members.set((r.CommittedName ?? "").toLowerCase(), r);
  const images = new Map<number, Rgba>();
  const has = (name: string) => members.has(name.toLowerCase());
  const read = async (name: string): Promise<Rgba> => {
    const m = members.get(name.toLowerCase());
    if (!m) throw new Error(`no atlas member ${name} at ${BUILD.version}`);
    const sheet = sheets.get(m.UiTextureAtlasID ?? "");
    if (!sheet) throw new Error(`atlas member ${name} names an unknown sheet`);
    const fdid = num(sheet.FileDataID);
    let img = images.get(fdid);
    if (!img) {
      img = decodeBlp((await files.read(fdid)).bytes);
      images.set(fdid, img);
    }
    const l = num(m.CommittedLeft);
    const t = num(m.CommittedTop);
    return crop(img, l, t, num(m.CommittedRight) - l, num(m.CommittedBottom) - t);
  };
  return { has, read };
}

/**
 * The art comes out as files the site can use one at a time, not a sheet: a page
 * that needs eleven sprites fetches eleven small files, and each is lossless, as in
 * Eclipse, because DXT and JPEG both band these soft glows.
 */
export async function bakeUi(ctx: BakeContext): Promise<Record<string, string>> {
  const files = new Tracked(ctx.source);
  const atlas = await atlasReader(ctx, files);
  const out: Record<string, UiSprite> = {};
  let total = 0;
  const packed: { name: string; img: Rgba }[] = [];
  const put = async (name: string, img: Rgba) => {
    // A page's frames are read by every visitor: they go in one file, one read per visit.
    if (!STANDS_ALONE.test(name)) {
      packed.push({ name, img });
      return;
    }
    const body = await webp(img);
    total += body.length;
    await ctx.store.put(paths.ui(name), body);
  };

  const classic = async (fdid: number): Promise<Rgba> => {
    const img = decodeBlp((await files.read(fdid)).bytes);
    const k = Math.round(img.width * CLASSIC_RIM);
    return crop(img, k, k, img.width - 2 * k, img.height - 2 * k);
  };

  for (const [name, spec] of Object.entries(SPRITES) as [string, SpriteSpec][]) {
    let one: Rgba;
    if (spec.keep === "derived") {
      const ref = await atlas.read("transmog-gearslot-unassigned-mainhand");
      const main = await resized(await classic(CLASSIC.mainhand), ref.width, ref.height);
      const ranged = await resized(await classic(CLASSIC.ranged), ref.width, ref.height);
      one = rangedFromClassic(main, ranged, ref);
    } else {
      one = await atlas.read(spec.member!);
    }
    const measured = toWhite(one);
    const density = spec.density ?? 2;
    let file: Rgba;
    if (density === 1) {
      file = one;
    } else {
      // Retail's own -2x twin when it has one, kept the way its 1x is kept.
      const twin = spec.member && atlas.has(`${spec.member}-2x`) ? await atlas.read(`${spec.member}-2x`) : null;
      if (twin && twin.width === one.width * 2 && twin.height === one.height * 2) file = twin;
      else file = await resized(one, one.width * 2, one.height * 2);
    }
    if (spec.keep === "white") file = toWhite(file).img;
    await put(name, file);
    const [ox, oy] = overhangOf(one.width, one.height, spec.frame);
    out[name] = {
      width: one.width,
      height: one.height,
      density,
      overhang: [ox, oy],
      slice: spec.slice,
      tint: measured.tint,
      white: spec.keep === "white",
      ...(spec.grid ? { grid: [spec.grid[0], spec.grid[1]] as [number, number] } : {}),
    };
  }

  const scene = async (name: string, img: Rgba) => {
    // Scenes are opaque pictures; a stray alpha would only cost bytes.
    const opaque = new Uint8Array(img.data);
    for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
    const flat: Rgba = { width: img.width, height: img.height, data: opaque };
    await put(`scene-${name}`, flat);
    out[`scene-${name}`] = { width: img.width, height: img.height, density: 1, overhang: [0, 0], slice: 0, tint: toWhite(flat).tint, white: false };
  };
  for (const [name, member] of Object.entries(SCENES)) await scene(name, await atlas.read(member));
  for (const [name, fdid] of Object.entries(FILE_SCENES)) {
    const img = decodeBlp((await files.read(fdid)).bytes);
    const b = opaqueBounds(img);
    await scene(name, crop(img, b.x, b.y, b.w, b.h));
  }

  const atlasBody = await packAtlas(packed);
  total += atlasBody.image.length;
  await ctx.store.put(paths.atlas(), atlasBody.image);
  await ctx.store.put(paths.atlasMap(), Buffer.from(JSON.stringify(atlasBody.map)));
  await ctx.store.put(paths.sprites(), Buffer.from(JSON.stringify(out)));
  log(`  ui: ${Object.keys(out).length} sprites, ${(total / 1024).toFixed(0)} KB`);
  return files.inputs;
}

export async function bakeUiUnit(ctx: BakeContext): Promise<BakeRecord> {
  const start = Date.now();
  const base = { id: "ui", kind: "ui", build: BUILD.version, baker: BAKER_VERSION, source: ctx.source.name, bakedAt: new Date().toISOString() };
  try {
    const inputs = await bakeUi(ctx);
    const rec: BakeRecord = { ...base, status: "ok", inputs, warnings: [], seconds: (Date.now() - start) / 1000 };
    await writeRecord(ctx.store, rec);
    return rec;
  } catch (e) {
    if (e instanceof Error && e.name === "BudgetExceeded") throw e;
    const rec: BakeRecord = { ...base, status: "failed", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), inputs: {}, warnings: [], seconds: (Date.now() - start) / 1000 };
    await writeRecord(ctx.store, rec);
    return rec;
  }
}
