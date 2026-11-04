/**
 * The little the rest of the room needs from a loaded code. Kept apart from the code
 * itself so the first page load carries none of it: the writer, the reader and the
 * panel arrive with the panels.
 */
import { atom } from "nanostores";
import type { Loaded } from "./bridge";

/** The code the figure is dressed in, as it came, with every field the site can't show. */
export const $loaded = atom<Loaded | null>(null);
/** `code=...` for the address bar when a link needs it. Empty: `body` and `look` say it all. */
export const $shareQuery = atom<string>("");

/** The look's mounts chosen on the Mounts page, game display ids. Null: nothing chosen here. */
export interface PickedMounts { mount: number; mountFly: number }
const PICKED = "loadout-mounts";

function readPicked(): PickedMounts | null {
  try {
    const v = JSON.parse(localStorage.getItem(PICKED) ?? "null");
    return v && typeof v.mount === "number" && typeof v.mountFly === "number" ? v : null;
  } catch {
    return null;
  }
}
export const $pickedMounts = atom<PickedMounts | null>(readPicked());

function setPicked(v: PickedMounts | null) {
  $pickedMounts.set(v);
  try {
    if (v) localStorage.setItem(PICKED, JSON.stringify(v));
    else localStorage.removeItem(PICKED);
  } catch { /* private window: it lasts as long as the page */ }
}

/** Mo::SetMount or SetMountFly: a flying mount takes the flying slot, the other slot stands. */
export function pickMount(display: number, flying: boolean) {
  const now = $pickedMounts.get() ?? { mount: 0, mountFly: 0 };
  setPicked(flying ? { ...now, mountFly: display } : { ...now, mount: display });
}

/** A new look starts with no mount of its own: a code brings its own, and Reset takes all off. */
export const clearPickedMounts = () => { if ($pickedMounts.get()) setPicked(null); };
