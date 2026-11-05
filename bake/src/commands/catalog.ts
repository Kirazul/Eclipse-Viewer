import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import sharp from "sharp";
import { BUILD, FORMAT_VERSION, POSTER, type Catalog, type CatalogEntry, type ItemRow, type ItemShard, type ItemShardRef, type LineInfo, type MountEntry, type MountVariant, type RaceEntry, type SearchRow, type SetEntry, type SetManifest, type SlotId, paths } from "@eclipse/format";
import type { BakeContext, BakeRecord } from "../bake/context";
import { type RaceSpec, allRaces } from "../chr/races";
import { byId, num } from "../db2/db2";
import { itemUnitId } from "../items/bake";
import { bodyTable, measureFit } from "../items/bodies";
import { LINE_ORDER, LINES, type LineCoverage, type LineRow, type LineSet } from "../items/lines";
import { SITE_CATALOG, STAGE, inputKey, log } from "../lib/env";
import { modelIdOfDisplay } from "../mounts/bake";
import type { MountFamily } from "../mounts/scan";
import type { Store } from "../store/store";
import { decodeBlp } from "../tex/blp";
import { packListSheets, packShardSheets } from "../posters/sheets";
import { posterHash, posterUnitId } from "../posters/spec";
import { lineScope, mountScope } from "./scope";

/** UiTextureAtlas 897: retail's character-creator race portraits (Eclipse's races_pack.py). */
const ICON_ATLAS = "897";
const LINES_KEY = "reports/lines.json";
const MOUNTS_KEY = "reports/mounts.json";
const LISTING_KEY = "reports/listing.json";
/** What the home page needs of the mounts; the rest stays in `catalog/mounts.json`. */
const HOME_MOUNTS = 24;

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

// ---------------------------------------------------------------- what may be listed

type RecordIndex = Store & { records?: Map<string, unknown>; object?: (k: string) => { ok: boolean } | undefined };

/** Every record, from the ledger when there is one, and that is one GET however many. */
export async function recordsOf(store: Store): Promise<Map<string, BakeRecord>> {
  const index = store as RecordIndex & { open?: () => Promise<void> };
  await index.open?.();
  if (index.records) return index.records as Map<string, BakeRecord>;
  const out = new Map<string, BakeRecord>();
  for (const key of await store.list("records/")) {
    const b = await store.get(key);
    if (b) {
      const r = JSON.parse(b.toString("utf8")) as BakeRecord;
      out.set(r.id, r);
    }
  }
  return out;
}

/**
 * The gate. Nothing reaches the site unless its bake finished, its self-check passed, and
 * the object it promises is in the bucket and passed its load check.
 */
export function listable(store: Store, rec: BakeRecord | undefined, output: string): boolean {
  if (!rec || rec.status !== "ok" || rec.validated !== true) return false;
  const index = store as RecordIndex;
  if (index.object) return index.object(output)?.ok === true;
  return true;
}

/** A poster's objects for one catalogue entry, when its own unit finished and each passed its load check. */
function postersOf(store: Store, records: ReadonlyMap<string, BakeRecord>, entryId: string): { male?: string; female?: string } {
  const rec = records.get(posterUnitId(entryId));
  if (!rec?.posters || rec.status !== "ok" || rec.validated !== true) return {};
  const index = store as RecordIndex;
  const ok = (k: string | undefined) => (k && index.object?.(k)?.ok !== false ? k : undefined);
  const male = ok(rec.posters.male);
  const female = ok(rec.posters.female);
  return { ...(male ? { male } : {}), ...(female ? { female } : {}) };
}

export interface LineSnapshot {
  line: string;
  rows: LineRow[];
  sets: LineSet[];
  coverage: LineCoverage;
}

export interface Listing {
  lines: Record<string, { rows: number; listed: number; notBaked: number; failed: number; entries: number; coverage: LineCoverage }>;
  sets: Record<string, { total: number; listed: number }>;
  mounts: { families: number; listed: number; variants: number; variantsListed: number; failed: number; entries: number; excluded: Record<string, number> };
  posters: { mounts: number; items: number; sets: number };
}

const KNOWN_FACETS = ["cloth", "leather", "mail", "plate"];

function iconHash(key: string | undefined): string {
  return key ? key.slice("objects/".length, -".webp".length) : "";
}

export interface ShardOutput {
  refs: ItemShardRef[];
  shards: Map<string, ItemShard>;
  iconOf: Map<number, string>;
  listedCount: Map<string, number>;
  stats: Map<string, { listed: number; notBaked: number; failed: number; entries: number; posters: number }>;
}

/** Rows that passed, by line and slot: what the browser fetches when it opens one. */
export function buildShards(store: Store, snapshots: readonly LineSnapshot[], records: ReadonlyMap<string, BakeRecord>): ShardOutput {
  const refs: ItemShardRef[] = [];
  const shards = new Map<string, ItemShard>();
  const iconOf = new Map<number, string>();
  const listedCount = new Map<string, number>();
  const stats = new Map<string, { listed: number; notBaked: number; failed: number; entries: number; posters: number }>();
  for (const snap of snapshots) {
    const stat = { listed: 0, notBaked: 0, failed: 0, entries: 0, posters: 0 };
    stats.set(snap.line, stat);
    const bySlot = new Map<SlotId, ItemRow[]>();
    const sorted = [...snap.rows].sort((a, b) => a.name.localeCompare(b.name) || a.display - b.display);
    for (const r of sorted) {
      const id = itemUnitId(r.display);
      const rec = records.get(id);
      if (!rec) {
        stat.notBaked++;
        continue;
      }
      if (!listable(store, rec, paths.item(id))) {
        stat.failed++;
        continue;
      }
      const icon = rec.icons?.[String(r.iconFdid)] ?? Object.values(rec.icons ?? {})[0];
      if (icon) iconOf.set(r.display, icon);
      const row: ItemRow = rec.notOn?.length ? [r.display, r.name, iconHash(icon), r.facet ?? "", r.entry ?? 0, rec.notOn] : [r.display, r.name, iconHash(icon), r.facet ?? "", r.entry ?? 0];
      // The posters follow, and only when there are any: a row with none is the row it was.
      const { male, female } = postersOf(store, records, id);
      if (male || female) {
        row[5] = rec.notOn?.length ? rec.notOn : null;
        row[6] = posterHash(male);
        if (female) row[7] = posterHash(female);
        stat.posters++;
      }
      const list = bySlot.get(r.slot);
      if (list) list.push(row);
      else bySlot.set(r.slot, [row]);
      stat.listed++;
      if (r.entry) stat.entries++;
    }
    for (const [slot, rows] of bySlot) {
      const key = paths.itemShard(snap.line, slot);
      shards.set(key, { line: snap.line, slot, rows });
      const facets = KNOWN_FACETS.filter((f) => rows.some((r) => r[3] === f));
      refs.push({ line: snap.line, slot, key, count: rows.length, facets });
    }
    listedCount.set(snap.line, stat.listed);
  }
  return { refs, shards, iconOf, listedCount, stats };
}

/** A set with what its pieces that passed: a piece that did not is simply not in it. */
export function buildSets(snapshots: readonly LineSnapshot[], out: ShardOutput, records: ReadonlyMap<string, BakeRecord>, store: Store): Map<string, SetEntry[]> {
  const nameOf = new Map<number, string>();
  for (const snap of snapshots) for (const r of snap.rows) if (!nameOf.has(r.display)) nameOf.set(r.display, r.name);
  const lines = new Map<string, SetEntry[]>();
  for (const snap of snapshots) {
    const list: SetEntry[] = [];
    for (const s of snap.sets) {
      const pieces: SetEntry["pieces"] = {};
      const icons: NonNullable<SetEntry["icons"]> = {};
      const names: NonNullable<SetEntry["names"]> = {};
      for (const [slot, display] of Object.entries(s.pieces) as [SlotId, number][]) {
        const id = itemUnitId(display);
        if (!listable(store, records.get(id), paths.item(id))) continue;
        pieces[slot] = id;
        const icon = out.iconOf.get(display);
        if (icon) icons[slot] = icon;
        const name = nameOf.get(display);
        if (name) names[slot] = name;
      }
      if (Object.keys(pieces).length === 0) continue;
      const { male, female } = postersOf(store, records, s.id);
      list.push({ id: s.id, name: s.name, circle: Object.values(icons)[0] ?? "", tile: "", line: s.line, pieces, icons, names, model: paths.set(s.id), ...(male ? { poster: male } : {}), ...(female ? { posterFemale: female } : {}) });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    lines.set(snap.line, list);
  }
  return lines;
}

export function buildMounts(store: Store, families: readonly MountFamily[], records: ReadonlyMap<string, BakeRecord>): { entries: MountEntry[]; failed: number } {
  const entries: MountEntry[] = [];
  let failed = 0;
  for (const f of families) {
    const rec = records.get(f.id);
    if (!rec) continue;
    const ok = new Set(rec.variants ?? []);
    const variants: MountVariant[] = [];
    if (rec.status === "ok" && rec.validated === true) {
      for (const v of f.variants) {
        const id = modelIdOfDisplay(v.display);
        if (!ok.has(v.display) || (store as RecordIndex).object?.(paths.manifest(id))?.ok === false) continue;
        const poster = postersOf(store, records, id).male;
        variants.push({ id, display: v.display, name: v.name, icon: rec.icons?.[String(v.iconFdid)] ?? "", mountId: v.mountId, ...(v.entry ? { entry: v.entry } : {}), ...(poster ? { poster } : {}) });
      }
    }
    if (!variants.length) {
      failed++;
      continue;
    }
    const first = variants[0]!;
    entries.push({ id: f.id, name: first.name, circle: first.icon, tile: "", ...(first.poster ? { poster: first.poster } : {}), model: paths.manifest(first.id), mountId: first.mountId, flying: f.flying, variants });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, failed };
}

/** A body has a `model` when it passed, and a race when any of its bodies did. */
async function applyBaked(store: Store, catalog: Catalog, withSheets = false): Promise<Map<string, unknown>> {
  const files = new Map<string, unknown>();
  const records = await recordsOf(store);
  const linesRaw = await store.get(LINES_KEY);
  const snapshots: LineSnapshot[] = linesRaw ? (JSON.parse(linesRaw.toString("utf8")) as LineSnapshot[]) : [];
  const out = buildShards(store, snapshots, records);
  const sets = buildSets(snapshots, out, records, store);
  const lines: LineInfo[] = [];
  for (const id of LINE_ORDER) {
    const items = out.listedCount.get(id) ?? 0;
    const setList = sets.get(id) ?? [];
    if (items === 0 && setList.length === 0) continue;
    lines.push({ id, title: LINES[id]?.title ?? id, items, sets: setList.length });
  }
  catalog.items = [];
  catalog.sets = [];
  catalog.lines = lines;
  catalog.itemShards = out.refs;
  catalog.setShards = [...sets].filter(([, l]) => l.length).map(([line, l]) => ({ line, key: paths.setShard(line), count: l.length }));
  const mountsRaw = await store.get(MOUNTS_KEY);
  const mountScan = mountsRaw ? (JSON.parse(mountsRaw.toString("utf8")) as { families: MountFamily[]; excluded: Record<string, number> }) : { families: [], excluded: {} };
  const { entries: mounts, failed: mountsFailed } = buildMounts(store, mountScan.families, records);
  // A sheet already made stays in, on every catalogue. Only `--sheets` makes new ones.
  let sheets = await packShardSheets(store, out.shards.values(), withSheets);
  for (const list of sets.values()) sheets += await packListSheets(store, list, POSTER.set, withSheets);
  sheets += await packListSheets(store, mounts, POSTER.cell, withSheets);
  if (sheets) log(`catalog: ${sheets} poster sheet(s) in the shards`);
  for (const [key, shard] of out.shards) files.set(key, shard);
  for (const [line, list] of sets) if (list.length) files.set(paths.setShard(line), list);

  catalog.mounts = mounts.slice(0, HOME_MOUNTS);
  catalog.mountCount = mounts.length;
  files.set(paths.mounts(), mounts);

  for (const race of catalog.races) {
    delete race.model;
    for (const body of race.bodies) {
      const key = paths.manifest(body.id);
      if (records.get(body.id)?.status === "ok" && (await store.stat(key)) !== null) {
        body.model = key;
        race.model ??= key;
      } else {
        delete body.model;
      }
    }
  }

  const listing: Listing = {
    lines: Object.fromEntries(
      snapshots.map((s) => {
        const st = out.stats.get(s.line)!;
        return [s.line, { rows: s.rows.length, listed: st.listed, notBaked: st.notBaked, failed: st.failed, entries: st.entries, coverage: s.coverage }];
      }),
    ),
    sets: Object.fromEntries(snapshots.map((s) => [s.line, { total: s.sets.length, listed: sets.get(s.line)?.length ?? 0 }])),
    mounts: {
      families: mountScan.families.length,
      listed: mounts.length,
      variants: mountScan.families.reduce((n, f) => n + f.variants.length, 0),
      variantsListed: mounts.reduce((n, m) => n + m.variants.length, 0),
      failed: mountsFailed,
      entries: mounts.reduce((n, m) => n + m.variants.filter((v) => v.entry).length, 0),
      excluded: mountScan.excluded,
    },
    // What a bake of posters still has to do: a card with none draws its picture in the page.
    posters: {
      mounts: mounts.reduce((n, m) => n + m.variants.filter((v) => v.poster).length, 0),
      items: [...out.stats.values()].reduce((n, s) => n + s.posters, 0),
      sets: [...sets.values()].reduce((n, l) => n + l.filter((s) => s.poster).length, 0),
    },
  };
  files.set(LISTING_KEY, listing);
  return files;
}

/** A body, a race, a mount, a set. Items are searched from their own file, on the first keystroke. */
export function searchRows(c: Catalog, mounts: readonly CatalogEntry[] = c.mounts, sets: readonly SetEntry[] = c.sets ?? []): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const r of c.races) {
    rows.push({ n: r.name, i: r.id, g: "race", c: r.circle });
    for (const b of r.bodies) rows.push({ n: b.name, i: b.id, g: "body", c: b.circle });
  }
  for (const m of mounts) rows.push({ n: m.name, i: m.id, g: "mount", c: m.circle });
  for (const it of c.items) rows.push({ n: it.name, i: it.id, g: "item", c: it.circle });
  for (const set of sets) rows.push({ n: set.name, i: set.id, g: "set", c: set.circle });
  return rows;
}

async function publish(store: Store, catalog: Catalog, files: Map<string, unknown>): Promise<void> {
  for (const [key, body] of files) await store.put(key, Buffer.from(JSON.stringify(body)));
  // What a set is, for the figure cells. Thousands of small files that hardly ever change:
  // one the same size as last time is not written again.
  for (const [key, value] of files) {
    if (!key.startsWith("catalog/sets/")) continue;
    for (const s of value as SetEntry[]) {
      const m: SetManifest = { formatVersion: FORMAT_VERSION, id: s.id, pieces: s.pieces };
      const body = Buffer.from(JSON.stringify(m));
      const at = paths.set(s.id);
      if ((await store.stat(at)) !== body.length) await store.put(at, body);
    }
  }
  await store.put(paths.catalog(), Buffer.from(JSON.stringify(catalog)));
  const allMounts = (files.get(paths.mounts()) ?? catalog.mounts) as CatalogEntry[];
  const allSets = [...files].filter(([k]) => k.startsWith("catalog/sets/")).flatMap(([, v]) => v as SetEntry[]);
  await store.put(paths.search(), Buffer.from(JSON.stringify(searchRows(catalog, allMounts, allSets))));
  const seen = new Set<string>();
  const itemRows: SearchRow[] = [];
  for (const [k, v] of files) {
    if (!k.startsWith("catalog/items/")) continue;
    const shard = v as ItemShard;
    for (const r of shard.rows) {
      const id = itemUnitId(r[0]);
      if (seen.has(id)) continue;
      seen.add(id);
      itemRows.push({ n: r[1], i: id, g: "item", c: r[2] });
    }
  }
  await store.put("catalog/search-items.json", Buffer.from(JSON.stringify(itemRows)));
  // The snapshot the site builds against: races and a few mounts, never the item rows.
  mkdirSync(dirname(SITE_CATALOG), { recursive: true });
  writeFileSync(SITE_CATALOG, `${JSON.stringify(catalog, null, 1)}\n`);
}

/** The lines and mounts as scanned, kept so `report` can list what baked with no tables at hand. */
async function writeScans(ctx: BakeContext): Promise<void> {
  const snapshots: LineSnapshot[] = [];
  for (const line of LINE_ORDER) {
    const s = await lineScope(ctx, line);
    snapshots.push({ line, rows: s.rows, sets: s.sets, coverage: s.coverage });
  }
  await ctx.store.put(LINES_KEY, Buffer.from(JSON.stringify(snapshots)));
  const mounts = await mountScope(ctx);
  await ctx.store.put(MOUNTS_KEY, Buffer.from(JSON.stringify({ families: mounts.families, excluded: mounts.excluded, mounts: mounts.mounts, displays: mounts.displays })));
}

export async function runCatalog(ctx: BakeContext, withSheets = false): Promise<Catalog> {
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
  await writeScans(ctx);
  // In the cloud, once, here: twenty shards would each read all 57 body models otherwise.
  // On a slow line the first piece that needs a donor reads them, and most never do.
  if (ctx.source.name === "cdn") await measureFit(ctx, await bodyTable(ctx));
  const catalog: Catalog = { formatVersion: FORMAT_VERSION, build: BUILD.version, generatedAt: new Date().toISOString(), races: entries, mounts: [], items: [] };
  const files = await applyBaked(ctx.store, catalog, withSheets);
  await publish(ctx.store, catalog, files);
  const bodyCount = entries.reduce((n, r) => n + r.bodies.length, 0);
  log(`catalog: ${entries.length} races, ${bodyCount} bodies, ${entries.flatMap((r) => r.bodies).filter((b) => b.model).length} baked; ${(catalog.lines ?? []).map((l) => `${l.id} ${l.items}/${l.sets}`).join(", ")}; ${catalog.mountCount ?? 0} mounts`);
  return catalog;
}

/** After a bake: refresh `model` marks and shards without touching the game data again. */
export async function markBaked(store: Store): Promise<void> {
  const b = await store.get(paths.catalog());
  if (!b) {
    log("report: no catalogue in the store yet, nothing to mark");
    return;
  }
  const catalog = JSON.parse(b.toString("utf8")) as Catalog;
  const files = await applyBaked(store, catalog);
  await publish(store, catalog, files);
}
