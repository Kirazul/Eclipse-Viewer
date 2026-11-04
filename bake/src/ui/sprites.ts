/**
 * The wardrobe's retail art, as Eclipse's tools/art/ui_art.py lists it: every piece
 * cut by the rectangle retail's own UiTextureAtlasMember row gives it, so a sprite
 * here IS retail's atlas entry of the same name.
 */

export type Keep = "as" | "white" | "derived";

/** Retail's geometry: the framed thing's size, and the size the sprite is drawn over it. */
export type Frame = readonly [number, number, number | null, number | null];

export interface SpriteSpec {
  member: string | null;
  /** "as" is retail's pixels; "white" keeps intensity in alpha, plus the measured tint. */
  keep: Keep;
  /** Nine-slice inset, in 1x pixels. */
  slice: number;
  frame: Frame | null;
  /** Grid of frames, for a flipbook played in order. */
  grid?: readonly [number, number];
  /** Density kept: 2 uses retail's -2x member, else Lanczos x2 of the 1x. */
  density?: number;
}

const CARD: Frame = [100, 132, 114, 146]; // TransmogItemModelTemplate, its Border
const SETC: Frame = [178, 218, 194, 234]; // TransmogSetBaseModelTemplate, its Border
const SLOT: Frame = [59, 59, null, null]; // TransmogAppearanceSlotTemplate

const s = (member: string, keep: Keep, slice = 0, frame: Frame | null = null): SpriteSpec => ({ member, keep, slice, frame });

export const SPRITES: Record<string, SpriteSpec> = {
  // item card: resting, worn, pending, the "applied" flash
  card: s("transmog-itemcard-default", "as", 14, CARD),
  "card-worn": s("transmog-itemcard-transmogrified", "white", 14, CARD),
  "card-pending": s("transmog-itemcard-transmogrified-pending", "white", 14, CARD),
  // Two hues; drawn at its own size (137x175 over the 100x132 card).
  "card-flash": s("transmog-itemcard-electrified", "as", 24, [100, 132, null, null]),
  // set card: resting, incomplete, worn, pending
  setcard: s("transmog-setcard-default", "as", 14, SETC),
  "setcard-part": s("transmog-setcard-incomplete", "as", 14, SETC),
  "setcard-worn": s("transmog-setcard-transmogrified", "white", 14, SETC),
  "setcard-pend": s("transmog-setcard-transmogrified-pending", "white", 14, SETC),
  // gear slot: the border by state, then the overlays
  slot: s("transmog-gearslot-default", "as", 16, SLOT),
  "slot-worn": s("transmog-gearslot-transmogrified", "as", 16, SLOT),
  "slot-hidden": s("transmog-gearslot-transmogrified-hidden", "as", 16, SLOT),
  "slot-off": s("transmog-gearslot-disabled", "as", 16, SLOT),
  "slot-sel": s("transmog-gearslot-selected", "white", 18, SLOT),
  "slot-pending": s("transmog-gearslot-pending", "white", 24, SLOT),
  "slot-glow": s("transmog-gearslot-transmogrified-glw", "white", 24, SLOT),
  "slot-hl": s("transmog-gearslot-transmogrified-hl", "white", 20, SLOT),
  // the rest of a gear slot's apply, each drawn at its own size on the slot's centre
  "slot-line": s("transmog-gearSlot-lineSquare", "as"),
  "slot-sparkbg": s("transmog-gearSlot-FX-spark-BG", "as"),
  "slot-frameglw": s("transmog-gearSlot-transmogrified-Frame-Glw", "as"),
  // the item card's lightning along its top and bottom edges
  "flip-card-top": { ...s("transmog-itemSlot-flipbook-startTop", "as"), grid: [4, 3] },
  "flip-card-bot": { ...s("transmog-itemSlot-flipbook-startBottom", "as"), grid: [4, 3] },
  // round frames (the enchant tiles)
  ring: s("transmog-appearance-circframe", "as"),
  "ring-on": s("transmog-appearance-circframe-active", "as"),
  // panels: the transmog frame's left column
  "panel-dark": s("transmog-outfit-darkbg", "as"),
  "panel-top": s("transmog-outfit-toptexture", "as"),
  "panel-bottom": s("transmog-outfit-bottomtexture", "as"),
  "panel-line": s("transmog-outfit-darkbg-cornerline", "as"),
  divider: s("transmog-outfit-dividerline", "white"),
  "tab-hl": s("transmog-tab-hl", "white"),
  filigree: s("collections-background-filagree", "as"),
  // small marks
  star: s("transmog-icon-favorite", "as"),
  hidden: s("transmog-icon-hidden", "as"),
  // The apply's flipbooks. The card's at retail's 2x; the gear slot's at 1x, as the
  // ring draws a slot at 40 px against retail's 59.
  "flip-card-left": { ...s("transmog-itemSlot-flipbook-startLeft", "as"), grid: [14, 1], density: 2 },
  "flip-card-right": { ...s("transmog-itemSlot-flipbook-startRight", "as"), grid: [14, 1], density: 2 },
  "flip-card-sparks": { ...s("transmog-itemSlot-flipbook-sparks", "as"), grid: [6, 3], density: 2 },
  "flip-slot-start": { ...s("transmog-gearSlot-flipbook-start", "as"), grid: [6, 4], density: 1 },
  "flip-slot-sparks": { ...s("transmog-gearSlot-flipbook-sparks", "as"), grid: [6, 4], density: 1 },
  // Retail has no ranged slot, so this one is derived: see rangedSprite.
  "empty-ranged": { member: null, keep: "derived", slice: 0, frame: null },
};

// An empty gear slot shows retail's own silhouette of what goes there.
for (const slot of ["head", "shoulders", "back", "chest", "shirt", "tabard", "wrist", "hands", "waist", "legs", "feet", "mainhand", "offhand", "enchant"]) {
  SPRITES[`empty-${slot}`] = s(`transmog-gearslot-unassigned-${slot}`, "as");
}

/** Classic paper doll silhouettes, for the ranged slot retail dropped. */
export const CLASSIC = { mainhand: 136518, ranged: 136520 } as const;
export const CLASSIC_RIM = 5 / 64;

/** What DressUpFrame stands the character in, per class; Midnight's transmog room for the rest. */
export const SCENES: Record<string, string> = {
  warrior: "dressingroom-background-warrior",
  paladin: "dressingroom-background-paladin",
  hunter: "dressingroom-background-hunter",
  rogue: "dressingroom-background-rogue",
  priest: "dressingroom-background-priest",
  deathknight: "dressingroom-background-deathknight",
  shaman: "dressingroom-background-shaman",
  mage: "dressingroom-background-mage",
  warlock: "dressingroom-background-warlock",
  druid: "dressingroom-background-druid",
  room: "transmog-locationbg",
};

/** Scenes that are whole files: the mount journal's, cropped to its opaque part. */
export const FILE_SCENES: Record<string, number> = { mount: 651761 };
