import { SLOT_RING, type SlotId } from "@eclipse/format";

export { SLOT_RING };
export type { SlotId };

export const ALL_SLOTS: SlotId[] = [...SLOT_RING.left, ...SLOT_RING.right, ...SLOT_RING.bottom];

/** The ring's tooltip names and the catalogue's chips, the game's words. */
export const SLOT_LABEL: Record<SlotId, string> = {
  head: "Head",
  shoulder: "Shoulders",
  back: "Back",
  chest: "Chest",
  shirt: "Shirt",
  tabard: "Tabard",
  wrist: "Wrists",
  hands: "Hands",
  waist: "Waist",
  legs: "Legs",
  feet: "Feet",
  mainhand: "Main-Hand",
  offhand: "Off-Hand",
  ranged: "Ranged",
};

/** The chip rail's order (UiMorph.cpp's catalogue order, not the ring's). */
export const CHIP_ORDER: SlotId[] = [
  "head", "shoulder", "back", "chest", "tabard", "shirt", "wrist", "hands", "waist", "legs", "feet",
  "ranged", "mainhand", "offhand",
];

/** Armour materials only mean something on armour. */
export const ARMOR_SLOTS = new Set<SlotId>(["head", "shoulder", "chest", "wrist", "hands", "waist", "legs", "feet"]);

/** ui_art.py names the bare-slot art after retail's atlas: shoulders is plural there. */
export function emptySprite(slot: SlotId): string {
  return `empty-${slot === "shoulder" ? "shoulders" : slot}`;
}

export function isSlot(v: string | null | undefined): v is SlotId {
  return !!v && (ALL_SLOTS as string[]).includes(v);
}
