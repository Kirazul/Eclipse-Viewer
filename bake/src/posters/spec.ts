import { createHash } from "node:crypto";
import { POSTER, type ItemManifest, type ModelManifest, type SlotId } from "@eclipse/format";

/** What a poster shows, as the engine's cell options. */
export interface PosterSpec {
  bodyId?: string;
  itemId?: string;
  pieces?: Partial<Record<SlotId, string>>;
}

/**
 * A poster's stage, on its own and not in the baker's version: a framing change redraws
 * posters, and leaves every model and item as baked.
 */
export const POSTER_STAGE = 2;
export const POSTER_BAKER = `poster${POSTER_STAGE}`;
/** The neutral body an armour poster stands on. */
export const POSTER_BODIES = { male: "human-male", female: "human-female" } as const;
export const WEAPON_SLOTS: readonly SlotId[] = ["mainhand", "offhand", "ranged"];

/**
 * Sixteen hex digits. A poster is named in every catalogue row, and a hash doesn't
 * compress: half the length is half of what a slot's shard pays for it, and 64 bits
 * still leave a collision in 100,000 posters at about one in 3,700,000,000.
 */
export function posterKey(...parts: (string | number)[]): string {
  const hash = createHash("sha256").update(["poster", POSTER_STAGE, ...parts].join("\0")).digest("hex").slice(0, 16);
  return `objects/${hash}.webp`;
}

/** The hash a catalogue row carries. */
export function posterHash(key: string | undefined): string {
  return key ? key.slice("objects/".length, -".webp".length) : "";
}

export function posterUnitId(entryId: string): string {
  return `poster-${entryId}`;
}

export type PosterSize = { width: number; height: number };
export const CELL_SIZE: PosterSize = POSTER.cell;
export const SET_SIZE: PosterSize = POSTER.set;

function stable(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

/** What of a model decides how it looks: its files, and which of its parts show. */
export function modelSignature(m: Pick<ModelManifest, "glb" | "textures" | "defaultGeosets" | "defaultClip"> & Partial<Pick<ModelManifest, "composite" | "look" | "fx" | "particleColors">>): string {
  return stable({
    glb: m.glb.key,
    tex: m.textures.map((t) => t.key),
    geo: [...m.defaultGeosets].sort((a, b) => a - b),
    clip: m.defaultClip,
    layers: m.composite?.layers.map((l) => [l.key, l.blend, l.rect]),
    look: m.look,
    fx: m.fx?.key,
    colors: m.particleColors,
  });
}

/**
 * What of an item decides how it looks on this body. Two displays that wear the same
 * files come to the same text, so they share one poster and one write.
 */
export function wornSignature(m: ItemManifest, bodyId: string): string {
  return stable({
    slot: m.slot,
    attached: (m.attachedBy ? m.attachedBy[bodyId] ?? [] : m.attached ?? []).map((a) => [a.attachment, a.manifest, a.handFlags ?? 0]),
    collections: m.collections,
    layers: m.bodyLayersBy ? m.bodyLayersBy[bodyId] ?? [] : m.bodyLayers ?? [],
    textures: m.bodyTextures,
    groups: m.geosetGroups,
    pad: m.pad ?? 0,
    regions: m.regions,
    flags: m.compFlags ?? 0,
    hide: m.helmetHide?.[bodyId] ?? m.helmetHide?.["*"],
  });
}
