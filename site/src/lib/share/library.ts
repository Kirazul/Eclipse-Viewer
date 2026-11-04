/**
 * The saved looks: this browser's copy of Eclipse's loadouts. Each one is its code,
 * verbatim, so whatever a game-made code held is still there when it is shared on.
 * A private window has no storage: the list then lives as long as the page does.
 */
export interface SavedLook {
  name: string;
  code: string;
  /** Art key of its picture, from when it was saved: a row needs no catalogue to draw. */
  cover: string;
}

const KEY = "loadouts";

/** mo::OutfitKey: brackets and newlines can't stay, nor space at either end. */
export function cleanName(name: string): string {
  return name.replace(/[[\]\n\r]/g, "").replace(/^ +| +$/g, "");
}

export function readLibrary(): SavedLook[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter((l) => typeof l?.name === "string" && typeof l?.code === "string")
      .map((l) => ({ name: l.name, code: l.code, cover: typeof l.cover === "string" ? l.cover : "" }));
  } catch {
    return [];
  }
}

/**
 * An old code's picture can be megabytes. If the list doesn't fit, the pictures go:
 * the game ignores them, and the outfit is before the first `~`.
 */
export function writeLibrary(list: readonly SavedLook[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    try {
      localStorage.setItem(KEY, JSON.stringify(list.map((l) => ({ ...l, code: l.code.split("~", 1)[0] }))));
    } catch { /* no storage: the list stays in memory */ }
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Saved under a name it replaces in place, keeping its picture unless given one, as the game keeps a chosen icon. */
export function saveLook(list: readonly SavedLook[], look: SavedLook): SavedLook[] {
  const at = list.findIndex((l) => same(l.name, look.name));
  if (at < 0) return [...list, look];
  const next = [...list];
  next[at] = { ...look, name: list[at]!.name, cover: look.cover || list[at]!.cover };
  return next;
}

export const removeLook = (list: readonly SavedLook[], name: string) => list.filter((l) => !same(l.name, name));

export function renameLook(list: readonly SavedLook[], from: string, to: string): SavedLook[] {
  return list.map((l) => (same(l.name, from) ? { ...l, name: to } : l));
}

export const hasLook = (list: readonly SavedLook[], name: string) => list.some((l) => same(l.name, name));
