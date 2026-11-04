/**
 * The contract between bake/, engine/ and site/. If a shape here changes, all
 * three change together, and FORMAT_VERSION goes up.
 *
 * Object keys are relative to the pack base URL (R2, or /packs in local dev).
 * Everything except catalog/ and models/<id>/manifest.json is content-hashed and
 * served as immutable.
 */

export const FORMAT_VERSION = 1;

export type Vec3 = [number, number, number];

/**
 * Coordinates: retail is Z-up, X forward, Y left. The baker writes Y-up with the
 * model facing +Z: (x, y, z) -> (y, z, x), and quaternions (x, y, z, w) ->
 * (y, z, x, w). That is a cyclic permutation, so handedness is preserved.
 *
 * Skeleton: joints are nodes named `b<index>` (retail bone index), with identity
 * rest transforms and identity inverse bind matrices, because retail vertices
 * are already in bind pose in model space. A sampled bone is
 *   T = pivot + translation - R * (S * pivot),  R = rotation,  S = scale.
 * So a stopped mixer is the bind pose ("T-Pose").
 */

export type ModelKind = "body" | "mount" | "item";

/** Stored per primitive in material.extras: each submesh has its own material. */
export interface SubmeshExtras {
  /** Stable id: `<submesh index>`. The Model Parts list keys off this. */
  hash: number;
  /** Geoset id = group*100 + value. */
  geoset: number;
  /** Texture units in retail order. `tex` indexes ModelManifest.textures; -1 = none. */
  units: { tex: number; uvSet: number; wrapS: boolean; wrapT: boolean; uvAnim: number }[];
  /** Retail M2 batch shader id. */
  shader: number;
  /** Retail M2 blend mode: 0 opaque, 1 alpha key, 2 alpha, 3 no-alpha add, 4 add, 5 mod, 6 mod2x, 7 blend-add. */
  blend: number;
  /** Retail render flags: 1 unlit, 2 unfogged, 4 two-sided, 8 billboard, 16 no-depth-write. */
  flags: number;
  /** Batch priority plane, order within a submesh. */
  priority: number;
  /** Index into FxData.colors, -1 = none. */
  color: number;
  /** Index into FxData.opacity, -1 = none. */
  opacity: number;
}

export interface ClipEntry {
  /** `<animId>.<variation>`. */
  id: string;
  /** Name from AnimationData, e.g. "Stand". */
  name: string;
  animId: number;
  variation: number;
  durationMs: number;
  /** Retail sequence flag: the clip loops. */
  loops: boolean;
  /** GLB holding one animation over the `b<n>` nodes. Omitted key: clip not baked. */
  key: string;
  bytes: number;
}

export type TextureKind =
  | "static"      // hard-wired to a batch
  | "skin"        // type 1: composite
  | "hair"        // type 6
  | "fur"         // type 8
  | "eyes"        // type 19
  | "object"      // type 2 / item
  | "monster";    // type 11-13

export interface TextureEntry {
  /** Retail texture type: 0 hard-coded, 1 composite, 2 object, 6 hair, 8 fur, 11-13 monster, 19 eyes... */
  type: number;
  kind: TextureKind;
  /** Hashed KTX2. Empty when it is produced at runtime (type 1 composite). */
  key: string;
  bytes: number;
  width: number;
  height: number;
  alpha: boolean;
  /** Source file, when there is one. */
  fileDataId?: number;
}

/** A layer drawn into the runtime composite for a body. */
export interface CompositeLayer {
  /** ChrModelTextureLayer order. */
  layer: number;
  /** Target texture type (usually 1). */
  targetType: number;
  /** Rect in the target, pixels. */
  rect: { x: number; y: number; w: number; h: number };
  /** 0/1 copy, 9/15 alpha, 4 multiply, 6 overlay, 7 screen. */
  blend: number;
  key: string;
  bytes: number;
}

export interface Attachment {
  id: number;
  bone: number;
  position: Vec3;
}

export interface ModelManifest {
  formatVersion: number;
  id: string;
  kind: ModelKind;
  name: string;
  /** Pinned retail build this was baked from. */
  build: string;
  source: { m2: number; skin: number; skel?: number };
  /** Hashed GLB: geometry, skeleton, one primitive per submesh, no animations. */
  glb: { key: string; bytes: number };
  /** Hashed JSON of FxData. */
  fx?: { key: string; bytes: number };
  /** Hashed .phys payload. */
  phys?: { key: string; bytes: number };
  /** Computed from the mesh: retail headers can't be trusted. */
  bounds: { min: Vec3; max: Vec3 };
  boneCount: number;
  clips: ClipEntry[];
  /** ClipEntry.id to play first. */
  defaultClip: string;
  textures: TextureEntry[];
  /** Default-look geosets: visible at load. Every other submesh starts hidden. */
  defaultGeosets: number[];
  /** Layers for the default look of a body. */
  composite?: { width: number; height: number; layers: CompositeLayer[] };
  attachments: Attachment[];
  /** Keys of retail bone indices used as named reference points, e.g. ground. */
  groundBone?: number;
  /** A bake never hides a problem: anything skipped is listed. */
  warnings: string[];
}

export interface FxData {
  globalLoops: number[];
  /** Keyed tracks as [timesMs, values] per clip id; keep small, sampled when needed. */
  colors: unknown[];
  opacity: unknown[];
  uvAnims: unknown[];
  particles: unknown[];
  ribbons: unknown[];
}

export interface CatalogEntry {
  /** Used in URLs: `human-male`, `mount-1234`. */
  id: string;
  name: string;
  /** Hashed WebP paths; empty string falls back to /placeholder.webp. */
  circle: string;
  tile: string;
  /** Present when baked. An entry without a model is not listed by the site. */
  model?: string;
  group?: string;
  description?: string;
  /** Build it first appeared in, for "Latest Additions". */
  addedIn?: string;
}

export interface RaceEntry extends CatalogEntry {
  raceId: number;
  faction?: "Alliance" | "Horde" | "Neutral";
  bodies: CatalogEntry[];
}

export interface Catalog {
  formatVersion: number;
  build: string;
  generatedAt: string;
  races: RaceEntry[];
  mounts: CatalogEntry[];
  items: CatalogEntry[];
}

export interface SearchRow {
  /** name */
  n: string;
  /** id */
  i: string;
  /** group: race, body, mount, item */
  g: "race" | "body" | "mount" | "item";
  /** circle key */
  c: string;
}

export const paths = {
  manifest: (id: string) => `models/${id}/manifest.json`,
  catalog: () => `catalog/catalog.json`,
  search: () => `catalog/search.json`,
  report: () => `reports/latest.json`,
};

export * from "./config";

export function packUrl(base: string, key: string): string {
  return `${base.replace(/\/$/, "")}/${key}`;
}
