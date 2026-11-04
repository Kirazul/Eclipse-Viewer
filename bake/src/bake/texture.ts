import { STAGE, inputKey } from "../lib/env";
import { blpInfo, blpLevelUnder, decodeBlp, hasAlpha, type BlpInfo } from "../tex/blp";
import { ETC1S_QUALITY, encodeKtx2 } from "../tex/ktx2";
import type { Store } from "../store/store";
import type { BakeContext, Tracked } from "./context";

export interface BakedTexture {
  key: string;
  bytes: number;
  width: number;
  height: number;
  alpha: boolean;
}

type MetaIndex = Store & { object?: (key: string) => { meta?: unknown } | undefined; setMeta?: (key: string, meta: unknown) => void };

/** How big a texture needs to be, picked from the levels the BLP already stores. */
export type Want = { w: number; h: number } | { cap: number };

/** The smallest stored level at least (w, h): the texture's author made it, and nothing is resampled. */
export function pickLevel(info: BlpInfo, want: Want): number {
  if ("cap" in want) return blpLevelUnder(info, want.cap);
  let best = 0;
  info.levels.forEach(([a, b], i) => {
    if (a >= want.w && b >= want.h) best = i;
  });
  return best;
}

function wantLabel(want: Want): string {
  return "cap" in want ? `cap${want.cap}` : `${want.w}x${want.h}`;
}

/**
 * A BLP as a hashed KTX2. The key covers the source file's identity, so the same
 * art used by two bodies is one object, and a texture already baked costs one stat
 * and no download. The `.meta.json` beside it holds what a manifest needs without
 * decoding again.
 */
export async function bakeTexture(ctx: BakeContext, files: Tracked, fdid: number, want: Want): Promise<BakedTexture> {
  const known = await files.identity(fdid);
  const hashFor = (id: string) => inputKey("tex", STAGE.tex, id, wantLabel(want), ETC1S_QUALITY);
  if (known && !ctx.force) {
    const key = `objects/${hashFor(known)}.ktx2`;
    const index = ctx.store as MetaIndex;
    const kept = index.object?.(key)?.meta;
    if (kept) return kept as BakedTexture;
    if (!index.object) {
      const meta = await ctx.store.get(key.replace(".ktx2", ".meta.json"));
      if (meta && (await ctx.store.stat(key)) !== null) return JSON.parse(meta.toString("utf8")) as BakedTexture;
    }
  }
  const file = await files.read(fdid);
  const key = `objects/${hashFor(file.id)}.ktx2`;
  const info = blpInfo(file.bytes);
  const img = decodeBlp(file.bytes, pickLevel(info, want));
  const alpha = hasAlpha(img);
  const ktx = await encodeKtx2(img);
  await ctx.store.put(key, ktx);
  const baked: BakedTexture = { key, bytes: ktx.length, width: img.width, height: img.height, alpha };
  // The ledger holds this when there is one: a meta object per texture would double the writes.
  const index = ctx.store as MetaIndex;
  if (index.setMeta) index.setMeta(key, baked);
  else await ctx.store.put(key.replace(".ktx2", ".meta.json"), Buffer.from(JSON.stringify(baked)));
  return baked;
}

