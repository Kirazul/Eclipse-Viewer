import { atom } from "nanostores";
import type { ViewerEngine } from "@eclipse/engine/api";
import type { CatalogEntry, ItemEntry, SetEntry, SlotId } from "@eclipse/format";

export type Tab = "items" | "sets" | "customization" | "loadout" | "viewer";
export const TABS: Tab[] = ["items", "sets", "customization", "loadout", "viewer"];

export interface RoomBody {
  id: string;
  name: string;
  circle: string;
  description?: string;
  model?: string;
}
export interface RoomRace {
  id: string;
  name: string;
  circle: string;
  faction?: "Alliance" | "Horde" | "Neutral";
  /** "Core" or "Allied". */
  group?: string;
  bodies: RoomBody[];
}

/** The live engine, once mounted. Panels and ring read it from here. */
export const $engine = atom<ViewerEngine | null>(null);
export const $body = atom<string>("");
export const $tab = atom<Tab>("items");
/** The slot the Items browser is showing: the ring's gold frame. */
export const $slot = atom<SlotId>("head");
/** Worn slot -> item id. */
export const $worn = atom<Partial<Record<SlotId, string>>>({});
/** The look as a link holds it: the choices that differ from the first look, `<option>.<choice>,...`. */
export const $lookText = atom<string>("");
export const $races = atom<RoomRace[]>([]);

export const $items = atom<ItemEntry[]>([]);
export const $sets = atom<SetEntry[]>([]);
export const $mounts = atom<CatalogEntry[]>([]);
export const $catalogState = atom<"loading" | "ready" | "error">("loading");

/** Class scene behind the figure, or "off" for a flat colour. */
export const DEFAULT_SCENE = "mage";
export const $scene = atom<string>(DEFAULT_SCENE);

export const SCENES = ["warrior", "paladin", "hunter", "rogue", "priest", "deathknight", "shaman", "mage", "warlock", "druid"] as const;
