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
  /**
   * Texture units in retail order. `tex` indexes ModelManifest.textures; -1 = none.
   * `uvSet`: 0 TEXCOORD_0, 1 TEXCOORD_1, 2 sphere map (the shader computes it). The
   * shader id implies it; retail models have no explicit UV-set table.
   */
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
  /**
   * Bone pivots, flat xyz per retail bone index, in the baker's axes. Optional, but
   * without them a crossfade blends the baked translation T = pivot + t - R(S*pivot)
   * and limbs shrink mid-fade; with them the engine blends t and R about the pivot.
   */
  pivots?: number[];
  clips: ClipEntry[];
  /** ClipEntry.id to play first. */
  defaultClip: string;
  textures: TextureEntry[];
  /** Default-look geosets: visible at load. Every other submesh starts hidden. */
  defaultGeosets: number[];
  /** Layers for the default look of a body. `sections`: rect of each component section, pixels; absent: retail's 2:1 layout. */
  composite?: {
    width: number;
    height: number;
    layers: CompositeLayer[];
    sections?: Record<number, { x: number; y: number; w: number; h: number }>;
  };
  attachments: Attachment[];
  /** Keys of retail bone indices used as named reference points, e.g. ground. */
  groundBone?: number;
  /** A bake never hides a problem: anything skipped is listed. */
  warnings: string[];
}

/**
 * One animated value in FxData. `clips` maps a ClipEntry.id, or "*" for any clip,
 * to [timesMs, values]; a value is a number or a number[] of the track's stride.
 * `globalLoop` indexes FxData.globalLoops: such a track runs on wall time modulo
 * the loop and ignores the clip. Absent tracks are constant.
 */
export interface FxTrack {
  globalLoop?: number;
  clips: Record<string, [number[], (number | number[])[]]>;
}
/** FxData.colors[i]: rgb 0..1, alpha 0..1. */
export interface FxColor {
  color?: FxTrack;
  alpha?: FxTrack;
}
/** FxData.uvAnims[i]: translation xyz, rotation quaternion xyzw, scale xyz, about (.5, .5). */
export interface FxUvAnim {
  translation?: FxTrack;
  rotation?: FxTrack;
  scale?: FxTrack;
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
  /** Transmog sets. Absent in a catalogue from before sets were baked. */
  sets?: SetEntry[];
}

export interface SearchRow {
  /** name */
  n: string;
  /** id */
  i: string;
  /** group: race, body, mount, item, set */
  g: "race" | "body" | "mount" | "item" | "set";
  /** circle key */
  c: string;
}

/**
 * Eclipse's slot ring, in the game's own order (src/eclipse/ui/UiMorph.cpp): one
 * column down each side of the figure and the weapons under its feet.
 */
export type SlotId =
  | "head" | "shoulder" | "back" | "chest" | "shirt" | "tabard" | "wrist"
  | "hands" | "waist" | "legs" | "feet"
  | "mainhand" | "offhand" | "ranged";

export const SLOT_RING: { left: SlotId[]; right: SlotId[]; bottom: SlotId[] } = {
  left: ["head", "shoulder", "back", "chest", "shirt", "tabard", "wrist"],
  right: ["hands", "waist", "legs", "feet"],
  bottom: ["mainhand", "offhand", "ranged"],
};

/** What a slot wears: one catalogue row in the Items or Sets browser. */
export interface ItemEntry extends CatalogEntry {
  slot: SlotId;
  /** Item line, e.g. "midnight", "warwithin". */
  line: string;
  /** Hashed WebP of the game's icon. */
  icon: string;
  /** Armour facet: cloth, leather, mail, plate, or none. */
  facet?: string;
}

export interface SetEntry extends CatalogEntry {
  line: string;
  /** Slot -> ItemEntry.id. Wearing a set replaces the whole look. */
  pieces: Partial<Record<SlotId, string>>;
}

/**
 * A wearable: the parts of one item display, resolved for one body at runtime.
 * Attached models hang on `attachments[n].id`; collections share the body's
 * skeleton by bone name; body textures draw into the composite.
 */
export interface ItemManifest {
  formatVersion: number;
  id: string;
  slot: SlotId;
  /**
   * Models pinned to a body attachment (helm, shoulders, weapons, sheath).
   * `manifest` is a model id. `handFlags`: ItemDisplayInfo.Flags & 0x1D00, the
   * mirror and turn bits of a hand item. `sheath`: its transform on a sheath point,
   * column-major, in the baker's axes.
   */
  attached: { attachment: number; manifest: string; handFlags?: number; sheath?: number[] }[];
  /**
   * When pieces differ per body (helms and shoulders are cut per race and sex): the
   * list for each body id, used in place of `attached`. Absent: `attached` for all.
   */
  attachedBy?: Record<string, { attachment: number; manifest: string; handFlags?: number; sheath?: number[] }[]>;
  /** Skinned pieces by body id or race/sex key, falling back as retail does. */
  collections: Record<string, { manifest: string }>;
  /**
   * Body-texture pieces: section -> texture, drawn in the runtime composite. `sex`
   * present: for that sex only (0 male, 1 female). Absent: both.
   */
  bodyLayers: { section: number; key: string; bytes: number; sex?: number }[];
  /** What the item puts on the body's own texture slots, by type: a cloak's is type 2, on geoset 15xx. */
  bodyTextures?: { type: number; key: string; bytes: number; width: number; height: number; alpha: boolean }[];
  /** Geoset rules: group -> value, retail's GeosetGroup of this display. */
  geosetGroups: Record<number, number>;
  phys?: { key: string; bytes: number };
  /** Geoset rule pad bits (engine logic/retailGeo.ts PAD). Absent: 0. */
  pad?: number;
  /** Sections this item paints, as bits. Absent: read from bodyLayers. */
  regions?: number;
  /** 0x20 the chest suppresses the legs, 0x40 a guild tabard. */
  compFlags?: number;
  /** HelmetGeosetData: groups this helm hides, by body id, or "*" for any body. */
  helmetHide?: Record<string, number[]>;
}

/** A set's pieces, fetched at `paths.set(id)`. Same shape as SetEntry.pieces. */
export interface SetManifest {
  formatVersion: number;
  id: string;
  pieces: Partial<Record<SlotId, string>>;
}

/**
 * One entry of `ui/sprites.json`, keyed by sprite name (`paths.ui(name)` is its file).
 * Sizes are in retail's 1x pixels; the file is `density` times that.
 */
export interface UiSprite {
  width: number;
  height: number;
  density: number;
  /** How far the sprite reaches past the frame it is drawn over, per side, in 1x pixels. */
  overhang: [number, number];
  /** Nine-slice inset, in 1x pixels. 0: not sliced. */
  slice: number;
  /** The sprite's measured colour, for lighting it or for drawing a white overlay. */
  tint: [number, number, number];
  /** The file is white with its intensity in alpha: draw it multiplied by `tint`, or any colour. */
  white: boolean;
  /** Columns and rows, for a flipbook played in order. */
  grid?: [number, number];
}

export const paths = {
  ui: (sprite: string) => `ui/${sprite}.webp`,
  sprites: () => `ui/sprites.json`,
  item: (id: string) => `items/${id}/manifest.json`,
  set: (id: string) => `sets/${id}/manifest.json`,
  manifest: (id: string) => `models/${id}/manifest.json`,
  catalog: () => `catalog/catalog.json`,
  search: () => `catalog/search.json`,
  report: () => `reports/latest.json`,
};

export * from "./config";

export function packUrl(base: string, key: string): string {
  return `${base.replace(/\/$/, "")}/${key}`;
}
