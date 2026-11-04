import type { Catalog, CatalogEntry, ItemEntry } from "@eclipse/format";
import { FALLBACK_CATALOG } from "./catalog.fallback";

/** `catalog.json` is written by the bake. Globbing means a missing file is not a build error. */
const found = import.meta.glob<{ default: Catalog }>("./catalog.json", { eager: true });
const baked = Object.values(found)[0]?.default;

/** True while no real catalogue exists: the site shows it says so, it never pretends. */
export const IS_FALLBACK = !baked;
export const catalog: Catalog = baked ?? FALLBACK_CATALOG;

const firstBaked = (list: CatalogEntry[]) => list.find((e) => e.model);

/**
 * The model the home page and a bare /wardrobe open on: the first baked body.
 * `model` only says an entry is baked (it holds the manifest's path); the id is what
 * the engine and the URLs use.
 */
export const FEATURED: CatalogEntry | undefined =
  catalog.races.flatMap((r) => r.bodies).find((b) => b.id === "human-male" && b.model) ??
  firstBaked(catalog.races.flatMap((r) => r.bodies)) ??
  firstBaked(catalog.mounts);

export interface LetterGroup<T> {
  letter: string;
  entries: T[];
}

export function byLetter<T extends { name: string }>(entries: T[]): LetterGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = e.name.charAt(0).toUpperCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  return [...groups].map(([letter, list]) => ({ letter, entries: list }));
}

export interface Addition {
  label: string;
  entries: { entry: CatalogEntry; href: "body" | "item" }[];
}

/** Newest first, by the build each entry first appeared in. */
export function latestAdditions(limit = 24): Addition[] {
  const all: Addition["entries"] = [
    ...catalog.races.flatMap((r) => r.bodies).filter((b) => b.model).map((entry) => ({ entry, href: "body" as const })),
    ...catalog.mounts.filter((m) => m.model).map((entry) => ({ entry, href: "body" as const })),
    ...(catalog.items as ItemEntry[]).map((entry) => ({ entry, href: "item" as const })),
  ];
  const groups = new Map<string, Addition["entries"]>();
  for (const row of all) {
    const key = row.entry.addedIn ?? catalog.build;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return [...groups]
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
    .slice(0, 3)
    .map(([label, entries]) => ({ label, entries: entries.slice(0, limit) }));
}
