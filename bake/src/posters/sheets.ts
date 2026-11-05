import { createHash } from "node:crypto";
import sharp from "sharp";
import { POSTER, SHEET, type ItemShard, type MountEntry, type SetEntry, type SheetSlot } from "@eclipse/format";
import { mapLimit } from "../lib/env";
import type { Store } from "../store/store";

/**
 * A page of cards as one file. r2.dev speaks HTTP/1.1: six sockets, a first byte of 0.3 to 0.8 s
 * each. Thirty-two posters are 32 reads and 2.1 s of a page filling in, however small they are,
 * measured on real objects; one sheet of the same bytes is one read and about a second.
 *
 * Sheets are made from posters already baked, so they redraw nothing. A sheet is named by what
 * it holds, so a catalogue run that changes nothing writes nothing. A new row in a shard moves
 * the rows after it into other sheets, which is why they are made on request (`catalog --sheets`)
 * once a poster bake has finished, not on every catalogue a bake publishes along the way. Every
 * catalogue lists the sheets that already exist; a page whose rows moved has none until the next
 * `--sheets`, and its cards read their own posters meanwhile.
 */

const QUALITY = { quality: 74, alphaQuality: 78, effort: 4 } as const;
const AT_ONCE = 6;

type Size = { width: number; height: number };

/** The sheet of these posters, in slot order, by object hash. Empty when there is none and `make` is off, or nothing to put in it. */
export async function packSheet(store: Store, keys: readonly (string | undefined)[], size: Size, make: boolean): Promise<string> {
  if (!keys.some(Boolean)) return "";
  const hash = createHash("sha256").update(["sheet", size.width, size.height, SHEET.cols, ...keys.map((k) => k ?? "")].join("\0")).digest("hex").slice(0, 16);
  const key = `objects/${hash}.webp`;
  if ((await store.stat(key)) !== null) return hash;
  if (!make) return "";
  const parts = await Promise.all(
    keys.map(async (k, at) => {
      const input = k ? await store.get(k) : null;
      if (!input) return null;
      // Whatever size it was baked at, it fills its slot: the page only knows the slot.
      const raw = await sharp(input).resize(size.width, size.height, { fit: "fill" }).png().toBuffer();
      return { input: raw, left: (at % SHEET.cols) * size.width, top: Math.floor(at / SHEET.cols) * size.height };
    }),
  );
  const webp = await sharp({ create: { width: SHEET.cols * size.width, height: SHEET.rows * size.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(parts.filter((p) => p !== null))
    .webp(QUALITY)
    .toBuffer();
  await store.put(key, webp);
  return hash;
}

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += SHEET.count) out.push(list.slice(i, i + SHEET.count));
  return out;
}

const objectOf = (hash: string | null | undefined) => (hash ? `objects/${hash}.webp` : undefined);

/** Adds its sheets to each shard: the n-th 32 of its rows, male then female. */
export async function packShardSheets(store: Store, shards: Iterable<ItemShard>, make: boolean): Promise<number> {
  let made = 0;
  await mapLimit([...shards], AT_ONCE, async (shard) => {
    const male = await Promise.all(chunks(shard.rows).map((rows) => packSheet(store, rows.map((r) => objectOf(r[6])), POSTER.cell, make)));
    const hasFemale = shard.rows.some((r) => r[7]);
    const female = hasFemale ? await Promise.all(chunks(shard.rows).map((rows) => packSheet(store, rows.map((r) => objectOf(r[7] ?? r[6])), POSTER.cell, make))) : null;
    if (male.some(Boolean)) {
      shard.sheets = { male, ...(female ? { female } : {}) };
      made += male.filter(Boolean).length + (female?.filter(Boolean).length ?? 0);
    }
  });
  return made;
}

/** Each set and each mount carries its own place, as neither list has rows to count. */
export async function packListSheets(store: Store, list: readonly (SetEntry | MountEntry)[], size: Size, make: boolean): Promise<number> {
  let made = 0;
  await mapLimit(chunks(list), AT_ONCE, async (page) => {
    const male = await packSheet(store, page.map((e) => e.poster), size, make);
    const hasFemale = page.some((e) => e.posterFemale);
    const female = hasFemale ? await packSheet(store, page.map((e) => e.posterFemale ?? e.poster), size, make) : "";
    page.forEach((e, at) => {
      if (male && e.poster) e.sheet = [male, at] satisfies SheetSlot;
      if (female && (e.posterFemale ?? e.poster)) e.sheetFemale = [female, at] satisfies SheetSlot;
    });
    if (male) made++;
    if (female) made++;
  });
  return made;
}
