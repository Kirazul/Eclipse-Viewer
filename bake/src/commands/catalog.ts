import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import sharp from "sharp";
import { BUILD, FORMAT_VERSION, type Catalog, type CatalogEntry, type ItemEntry, type RaceEntry, type SearchRow, type SetEntry, paths } from "@eclipse/format";
import type { BakeContext } from "../bake/context";
import { type RaceSpec, allRaces } from "../chr/races";
import { byId, num } from "../db2/db2";
import { SITE_CATALOG, STAGE, inputKey, log } from "../lib/env";
import type { Store } from "../store/store";
import { decodeBlp } from "../tex/blp";

/** UiTextureAtlas 897: retail's character-creator race portraits (Eclipse's races_pack.py). */
const ICON_ATLAS = "897";

interface IconCutter {
  (stem: string, sex: "male" | "female"): Promise<string>;
}

async function iconCutter(ctx: BakeContext): Promise<IconCutter> {
  const atlas = byId(await ctx.db.table("UiTextureAtlas")).get(ICON_ATLAS);
  if (!atlas) throw new Error(`UiTextureAtlas has no row ${ICON_ATLAS}`);
  const members = new Map<string, Record<string, string>>();
  for (const m of await ctx.db.table("UiTextureAtlasMember")) {
    if (m.UiTextureAtlasID === ICON_ATLAS) members.set(m.CommittedName ?? "", m);
  }
  const file = await ctx.source.read(num(atlas.FileDataID));
  const sheet = decodeBlp(file.bytes);
  const memo = new Map<string, string>();
  return async (stem, sex) => {
    const name = `raceicon128-${stem}-${sex}`;
    const hit = memo.get(name);
    if (hit) return hit;
    const m = members.get(name);
    if (!m) throw new Error(`atlas ${ICON_ATLAS} has no member ${name}`);
    const x0 = num(m.CommittedLeft);
    const y0 = num(m.CommittedTop);
    const w = num(m.CommittedRight) - x0;
    const h = num(m.CommittedBottom) - y0;
    const key = `objects/${inputKey("icon", STAGE.icon, file.id, name)}.webp`;
    if (ctx.force || (await ctx.store.stat(key)) === null) {
      const cut = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) {
        const from = ((y0 + y) * sheet.width + x0) * 4;
        Buffer.from(sheet.data.buffer, sheet.data.byteOffset + from, w * 4).copy(cut, y * w * 4);
      }
      const webp = await sharp(cut, { raw: { width: w, height: h, channels: 4 } }).resize(128, 128, { kernel: "lanczos3" }).webp({ quality: 86, alphaQuality: 90, effort: 6 }).toBuffer();
      await ctx.store.put(key, webp);
    }
    memo.set(name, key);
    return key;
  };
}

function raceEntry(r: RaceSpec, circle: string, bodies: CatalogEntry[]): RaceEntry {
  return {
    id: r.key,
    name: r.name,
    circle,
    // No renderer in the cloud yet: the site falls back to its placeholder.
    tile: "",
    raceId: r.raceId,
    faction: r.faction,
    group: r.allied ? "Allied" : "Core",
    ...(r.description ? { description: r.description } : {}),
    bodies,
  };
}

/**
 * Items and sets as baked so far: each item unit leaves its entry beside its
 * manifest, and a set is listed once any of its pieces can be worn.
 */
async function bakedItems(store: Store): Promise<{ items: ItemEntry[]; sets: SetEntry[] }> {
  const items: ItemEntry[] = [];
  for (const key of await store.list("items/")) {
    if (!key.endsWith("/entry.json")) continue;
    const b = await store.get(key);
    if (b) items.push(JSON.parse(b.toString("utf8")) as ItemEntry);
  }
  items.sort((a, b) => a.line.localeCompare(b.line) || a.name.localeCompare(b.name));
  const have = new Map(items.map((i) => [i.id, i]));
  const sets: SetEntry[] = [];
  for (const key of await store.list("sets/")) {
    if (!key.endsWith("/entry.json")) continue;
    const b = await store.get(key);
    if (!b) continue;
    const set = JSON.parse(b.toString("utf8")) as SetEntry;
    const worn = Object.values(set.pieces).filter((id) => id && have.has(id));
    if (worn.length === 0) continue;
    const firstIcon = worn.map((id) => have.get(id!)?.icon).find(Boolean) ?? "";
    sets.push({ ...set, circle: firstIcon, model: paths.set(set.id) });
  }
  sets.sort((a, b) => a.name.localeCompare(b.name));
  return { items, sets };
}

/** A body has a `model` when its manifest exists, and a race when any of its bodies does. */
async function applyBaked(store: Store, catalog: Catalog): Promise<void> {
  const { items, sets } = await bakedItems(store);
  catalog.items = items;
  catalog.sets = sets;
  for (const race of catalog.races) {
    delete race.model;
    for (const body of race.bodies) {
      const key = paths.manifest(body.id);
      if ((await store.stat(key)) !== null) {
        body.model = key;
        race.model ??= key;
      } else {
        delete body.model;
      }
    }
  }
}

export function searchRows(c: Catalog): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const r of c.races) {
    rows.push({ n: r.name, i: r.id, g: "race", c: r.circle });
    for (const b of r.bodies) rows.push({ n: b.name, i: b.id, g: "body", c: b.circle });
  }
  for (const m of c.mounts) rows.push({ n: m.name, i: m.id, g: "mount", c: m.circle });
  for (const it of c.items) rows.push({ n: it.name, i: it.id, g: "item", c: it.circle });
  for (const set of c.sets ?? []) rows.push({ n: set.name, i: set.id, g: "set", c: set.circle });
  return rows;
}

async function publish(store: Store, catalog: Catalog): Promise<void> {
  await store.put(paths.catalog(), Buffer.from(JSON.stringify(catalog)));
  await store.put(paths.search(), Buffer.from(JSON.stringify(searchRows(catalog))));
  // The snapshot the site builds against. The one file this package writes under site/.
  mkdirSync(dirname(SITE_CATALOG), { recursive: true });
  writeFileSync(SITE_CATALOG, `${JSON.stringify(catalog, null, 1)}\n`);
}

export async function runCatalog(ctx: BakeContext): Promise<Catalog> {
  const races = await allRaces(ctx.db);
  const cut = await iconCutter(ctx);
  const entries: RaceEntry[] = [];
  for (const r of races) {
    const bodies: CatalogEntry[] = [];
    for (const b of r.bodies) {
      bodies.push({ id: b.id, name: b.name, circle: await cut(b.icon, b.sex), tile: "", group: r.key });
    }
    entries.push(raceEntry(r, bodies[0]?.circle ?? "", bodies));
  }
  const catalog: Catalog = { formatVersion: FORMAT_VERSION, build: BUILD.version, generatedAt: new Date().toISOString(), races: entries, mounts: [], items: [] };
  await applyBaked(ctx.store, catalog);
  await publish(ctx.store, catalog);
  const bodyCount = entries.reduce((n, r) => n + r.bodies.length, 0);
  log(`catalog: ${entries.length} races, ${bodyCount} bodies, ${entries.flatMap((r) => r.bodies).filter((b) => b.model).length} baked; ${catalog.items.length} items, ${catalog.sets?.length ?? 0} sets`);
  return catalog;
}

/** After a bake: refresh `model` marks without touching the game data again. */
export async function markBaked(store: Store): Promise<void> {
  const b = await store.get(paths.catalog());
  if (!b) {
    log("report: no catalogue in the store yet, nothing to mark");
    return;
  }
  const catalog = JSON.parse(b.toString("utf8")) as Catalog;
  await applyBaked(store, catalog);
  await publish(store, catalog);
}
