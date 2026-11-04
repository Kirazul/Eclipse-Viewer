import { R2, packUrl, paths } from "@eclipse/format";

const raw = import.meta.env.BASE_URL || "/";
/** The site's root path, always ending in a slash. Everything internal goes through `u`. */
export const BASE = raw.endsWith("/") ? raw : `${raw}/`;

/** An internal link or public file. `u("races/")` -> `/Eclipse-Viewer/races/`. */
export function u(path = ""): string {
  return BASE + path.replace(/^\/+/, "");
}

export const PACK_BASE: string = (
  import.meta.env.PUBLIC_PACK_BASE || (import.meta.env.DEV ? `${BASE}packs` : R2.publicBase)
).replace(/\/$/, "");

/** The pack host's origin when it is another host, for preconnect. */
export const PACK_ORIGIN: string | null = /^https?:\/\//.test(PACK_BASE) ? new URL(PACK_BASE).origin : null;

/** A catalogue image; an empty key means not baked. */
export function art(key: string | undefined): string {
  return key ? packUrl(PACK_BASE, key) : u("placeholder.webp");
}

export function sprite(name: string): string {
  return packUrl(PACK_BASE, paths.ui(name));
}

export function wardrobeHref(modelId: string): string {
  return `${u("wardrobe/")}?body=${encodeURIComponent(modelId)}`;
}

export const LINKS = {
  support: "https://ko-fi.com/eclipsewow",
  discord: "https://discord.gg/RvY5VjHgTA",
};
