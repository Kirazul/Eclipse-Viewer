import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `pnpm bake` runs with cwd = bake/, so every path is anchored on this file. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const WORK = join(REPO, "work");
export const LOCAL_PACKS = process.env.BAKE_PACKS_DIR ?? join(REPO, "site", "public", "packs");
export const SITE_CATALOG = join(REPO, "site", "src", "data", "catalog.json");

/**
 * One version per output class. A stage's version goes into the key of everything
 * that stage writes, so a change rebuilds only that class: a material-extras fix
 * re-writes body GLBs and leaves textures and clips alone.
 */
export const STAGE = {
  body: 1,
  clip: 1,
  tex: 1,
  fx: 2,
  phys: 1,
  icon: 1,
  ui: 1,
  item: 3,
  manifest: 2,
  /** Customization data and bone sets. */
  look: 2,
} as const;

/** Everything a record has to match to count as up to date. */
export const BAKER_VERSION = Object.entries(STAGE)
  .map(([k, v]) => `${k}${v}`)
  .join(".");

export function md5Hex(data: Uint8Array): string {
  return createHash("md5").update(data).digest("hex");
}

/**
 * The hash inside an object's key. It covers the source content keys and the
 * stage version rather than the output bytes, so a finished object can be found
 * again without redoing the work.
 */
export function inputKey(...parts: (string | number)[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

/** Run `fn` over `items` with at most `limit` in flight, in order of the input. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
