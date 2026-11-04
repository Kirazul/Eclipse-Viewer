import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { SlotId } from "@eclipse/format";
import type { BakeContext } from "../bake/context";
import { type Db2, type Row, byId, groupBy, num } from "../db2/db2";
import { facetOf, slotOfDisplayType } from "./resolve";

/**
 * The four item lines. Midnight and War Within are read from retail's tables, by the
 * scope rules of Eclipse's tools/midnight/midnight_curate.py and midnight_inventory.py
 * and tools/warwithin/warwithin_scope.py, minus that pipeline's exclusion of what Eclipse
 * already ships: here a line says what it holds, and a display is baked once, however
 * many lines hold it. The client's and the realm's come from bake/data/lines.json.gz,
 * made on the owner's PC by bake/tools/lines_map.py, because only that PC can read them.
 */
export const LINES: Record<string, { title: string; expansion?: number; entryKey?: number; premium?: boolean }> = {
  eclipse: { title: "Eclipse" },
  client: { title: "This client" },
  midnight: { title: "Midnight", expansion: 11, entryKey: 0x03000000, premium: true },
  warwithin: { title: "War Within", expansion: 10, entryKey: 0x04000000 },
};
/** The order of the source chips. */
export const LINE_ORDER = ["eclipse", "client", "midnight", "warwithin"];

/** Retail's placeholders are not content. */
export function isPlaceholder(name: string): boolean {
  return /\[(DNT|PH)\]/i.test(name) || /^\s*$/.test(name);
}

/** One row of a line: what the grid lists. Many rows can wear one display. */
export interface LineRow {
  display: number;
  itemId: number;
  name: string;
  iconFdid: number;
  slot: SlotId;
  line: string;
  facet?: string;
  /** What the game's wardrobe knows this row as. */
  entry?: number;
  inventoryType: number;
  sheatheType: number;
}

export interface LineSet {
  id: string;
  name: string;
  line: string;
  pieces: Partial<Record<SlotId, number>>;
}

export interface LineCoverage {
  /** Rows the source holds, before anything was left out. */
  total: number;
  /** Rows that reached a retail display, by route (client and eclipse only). */
  routes?: Record<string, number>;
  unresolved: number;
  unresolvedSample?: [number, string][];
  /** Rows with a display but no name retail knows, or a placeholder's. */
  unnamed: number;
  /** Rows whose display no slot can wear. */
  noSlot: number;
  /** Rows sharing a display with an earlier row of this line. */
  duplicates: number;
  /** Rows of the catalogue that are not items at all (the realm's creatures, spell visuals). */
  otherRows?: number;
}

export interface LineScope {
  line: string;
  rows: LineRow[];
  sets: LineSet[];
  coverage: LineCoverage;
}

// ---------------------------------------------------------------- the tables, once
interface Tables {
  item: Map<string, Row>;
  sparse: Map<string, Row>;
  appearance: Map<string, Row>;
  appearanceOfDisplay: Map<string, Row[]>;
  ima: Map<string, Row>;
  imaByItem: Map<string, Row[]>;
  imaByAppearance: Map<string, Row[]>;
}

const memo = new WeakMap<Db2, Promise<Tables>>();

async function tablesOf(db: Db2): Promise<Tables> {
  let hit = memo.get(db);
  if (!hit) {
    hit = (async () => {
      const appearanceRows = await db.table("ItemAppearance");
      const imaRows = await db.table("ItemModifiedAppearance");
      return {
        item: byId(await db.table("Item")),
        sparse: byId(await db.table("ItemSparse")),
        appearance: byId(appearanceRows),
        appearanceOfDisplay: groupBy(appearanceRows, "ItemDisplayInfoID"),
        ima: byId(imaRows),
        imaByItem: groupBy(imaRows, "ItemID"),
        imaByAppearance: groupBy(imaRows, "ItemAppearanceID"),
      };
    })();
    memo.set(db, hit);
  }
  return hit;
}

const FIRST_IMA = (a: Row, b: Row) => num(a.OrderIndex) - num(b.OrderIndex) || num(a.ItemAppearanceModifierID) - num(b.ItemAppearanceModifierID);

function rowOf(t: Tables, line: string, itemId: string, app: Row, name: string, entry?: number): LineRow | null {
  const slot = slotOfDisplayType(num(app.DisplayType));
  if (!slot) return null;
  const item = t.item.get(itemId);
  const facet = item ? facetOf(num(item.ClassID), num(item.SubclassID)) : undefined;
  return {
    display: num(app.ItemDisplayInfoID),
    itemId: num(itemId),
    name,
    iconFdid: num(app.DefaultIconFileDataID) || num(item?.IconFileDataID),
    slot,
    line,
    inventoryType: num(item?.InventoryType),
    sheatheType: num(item?.SheatheType),
    ...(facet ? { facet } : {}),
    ...(entry ? { entry } : {}),
  };
}

// ---------------------------------------------------------------- what the set curation keeps
export interface SetRow {
  ID: string;
  Name_lang: string;
  ClassMask: string;
  ParentTransmogSetID: string;
  TransmogSetGroupID: string;
}

const singleClass = (mask: string): boolean => {
  const m = num(mask);
  return m !== 0 && (m & (m - 1)) === 0;
};

const FILLER = /\b(weathered|well-worn|worn|tattered|ragged)\b/;

/**
 * Port of midnight_curate.py. One family is a look and its colourways: a parent and the
 * sets naming it, or one class's sets of one name (tier difficulties, PvP ranks). Best
 * categories claim first, so an "other" set that only repeats them is left out.
 */
export function curateSets(
  sets: SetRow[],
  groupName: (id: string) => string,
  appsOf: (setId: string) => Set<string>,
  qualityOf: (setId: string) => number,
  opts: { premium: boolean; seasonPrefix: string },
): { kept: string[]; excluded: Record<string, number> } {
  const ids = new Map(sets.map((s) => [s.ID, s]));
  const families = new Map<string, string[]>();
  for (const s of sets) {
    const root = ids.has(s.ParentTransmogSetID) ? s.ParentTransmogSetID : s.ID;
    const key = singleClass(s.ClassMask) ? `n|${s.Name_lang.trim().toLowerCase()}|${s.ClassMask}` : `p|${root}`;
    const list = families.get(key);
    if (list) list.push(s.ID);
    else families.set(key, [s.ID]);
  }
  const groupSize = new Map<string, number>();
  for (const s of sets) groupSize.set(s.TransmogSetGroupID, (groupSize.get(s.TransmogSetGroupID) ?? 0) + 1);
  const category = (root: SetRow): "tier" | "season" | "pvp" | "other" => {
    const g = groupName(root.TransmogSetGroupID);
    if (`${g}${root.Name_lang}`.toLowerCase().includes("gladiator")) return "pvp";
    if (g.toLowerCase().startsWith(opts.seasonPrefix)) return "season";
    if (singleClass(root.ClassMask) && (groupSize.get(root.TransmogSetGroupID) ?? 0) >= 4 * 13) return "tier";
    return "other";
  };
  const order = { tier: 0, season: 1, pvp: 2, other: 3 };
  const fams = [...families.values()]
    .map((members) => {
      const root = ids.get(members.reduce((a, b) => (Number(a) < Number(b) ? a : b)))!;
      return { root, members, cat: category(root) };
    })
    .sort((a, b) => order[a.cat] - order[b.cat] || Number(a.root.ID) - Number(b.root.ID));

  const kept: string[] = [];
  const excluded: Record<string, number> = {};
  const seenSigs = new Set<string>();
  const seenApps = new Set<string>();
  const drop = (why: string) => {
    excluded[why] = (excluded[why] ?? 0) + 1;
  };
  for (const f of fams) {
    const apps = new Set<string>();
    let quality = 0;
    for (const m of f.members) {
      for (const a of appsOf(m)) apps.add(a);
      quality = Math.max(quality, qualityOf(m));
    }
    const sig = [...apps].sort().join(",");
    if (f.root.Name_lang.trimStart().startsWith("[")) {
      drop("placeholder");
      continue;
    }
    if (seenSigs.has(sig)) {
      drop("identical to a kept set");
      continue;
    }
    if (opts.premium && f.cat === "other") {
      if (quality <= 2) {
        drop("common or uncommon");
        continue;
      }
      if (apps.size > 0 && [...apps].every((a) => seenApps.has(a))) {
        drop("every piece already kept");
        continue;
      }
      if (FILLER.test(f.root.Name_lang.toLowerCase())) {
        drop("filler name");
        continue;
      }
    }
    kept.push(...f.members);
    seenSigs.add(sig);
    for (const a of apps) seenApps.add(a);
  }
  return { kept, excluded };
}

// ---------------------------------------------------------------- the two retail lines
const WEAPON_INV = new Set([13, 14, 15, 17, 21, 22, 23, 25, 26]);
const ARMOR_INV = new Set([1, 3, 4, 5, 6, 7, 8, 9, 10, 16, 19, 20]);

export function isWeapon(classId: number, subclass: number, inv: number): boolean {
  return classId === 2 || (classId === 4 && subclass === 6) || WEAPON_INV.has(inv);
}

export function isWornArmor(classId: number, subclass: number, inv: number): boolean {
  return classId === 4 && subclass >= 0 && subclass <= 5 && ARMOR_INV.has(inv);
}

/** War Within's set rule: its expansion, its two extra groups, its patches. */
function warWithinSet(s: Row): boolean {
  const p = num(s.PatchIntroduced);
  return num(s.ExpansionID) === 10 || s.TransmogSetGroupID === "321" || s.TransmogSetGroupID === "198" || (p >= 110000 && p <= 119999);
}

async function scanRetailLine(ctx: BakeContext, line: string): Promise<LineScope> {
  const def = LINES[line]!;
  const db = ctx.db;
  const t = await tablesOf(db);
  const data = readLineData();
  const offered = data ? new Set(data.entries[line] ?? []) : null;
  // The DLL's line holds it under its own key. A display that line left out, because the
  // realm's catalogue already has it, is worn by the realm's item id.
  const realm = new Map((data?.eclipse.rows ?? []).map((r) => [r[1], r[0]]));
  const entryOf = (display: number) => (offered?.has(display) ? def.entryKey! + display : realm.get(display));

  const allSets = (await db.table("TransmogSet")) as unknown as (SetRow & Row)[];
  const inScope = line === "warwithin" ? allSets.filter(warWithinSet) : allSets.filter((s) => num(s.ExpansionID) === def.expansion);
  const groups = byId(await db.table("TransmogSetGroup"));
  const labels = byId(await db.table("ItemNameDescription"));
  const setItems = groupBy(await db.table("TransmogSetItem"), "TransmogSetID");
  const appsOf = (id: string) => {
    const out = new Set<string>();
    for (const r of setItems.get(id) ?? []) {
      const a = t.ima.get(r.ItemModifiedAppearanceID ?? "")?.ItemAppearanceID;
      if (a) out.add(a);
    }
    return out;
  };
  const qualityOf = (id: string) => {
    let q = 0;
    for (const r of setItems.get(id) ?? []) {
      const item = t.ima.get(r.ItemModifiedAppearanceID ?? "")?.ItemID;
      if (item) q = Math.max(q, num(t.sparse.get(item)?.OverallQualityID));
    }
    return q;
  };
  const { kept } = curateSets(inScope, (id) => groups.get(id)?.Name_lang ?? "", appsOf, qualityOf, { premium: def.premium === true, seasonPrefix: `${def.title.toLowerCase()} season` });
  const keptIds = new Set(kept);

  const byDisplay = new Map<number, LineRow>();
  const coverage: LineCoverage = { total: 0, unresolved: 0, unnamed: 0, noSlot: 0, duplicates: 0 };
  const add = (itemId: string, appearanceId: string): LineRow | null => {
    coverage.total++;
    const app = t.appearance.get(appearanceId);
    const display = num(app?.ItemDisplayInfoID);
    if (!app || !display) {
      coverage.unresolved++;
      return null;
    }
    const hit = byDisplay.get(display);
    if (hit) {
      coverage.duplicates++;
      return hit;
    }
    const name = t.sparse.get(itemId)?.Display_lang ?? "";
    if (isPlaceholder(name)) {
      coverage.unnamed++;
      return null;
    }
    const row = rowOf(t, line, itemId, app, name, entryOf(display));
    if (!row) {
      coverage.noSlot++;
      return null;
    }
    byDisplay.set(display, row);
    return row;
  };

  // Each colourway is a set of its own, as in the game's list.
  const sets: LineSet[] = [];
  for (const s of inScope.filter((x) => keptIds.has(x.ID)).sort((a, b) => num(a.ID) - num(b.ID))) {
    const pieces: LineSet["pieces"] = {};
    for (const r of setItems.get(s.ID) ?? []) {
      const ima = t.ima.get(r.ItemModifiedAppearanceID ?? "");
      if (!ima) continue;
      const row = add(ima.ItemID ?? "", ima.ItemAppearanceID ?? "");
      if (row && !pieces[row.slot]) pieces[row.slot] = row.display;
    }
    if (Object.keys(pieces).length === 0) continue;
    const label = labels.get((s as unknown as Row).ItemNameDescriptionID ?? "")?.Description_lang;
    sets.push({ id: `set-${s.ID}`, name: label ? `${s.Name_lang} (${label})` : s.Name_lang, line, pieces });
  }

  // Weapons and held things in every appearance. Worn armour no set carries, for the
  // line whose owner asked for everything: Midnight keeps to its curated sets.
  for (const [id, s] of t.sparse) {
    if (num(s.ExpansionID) !== def.expansion) continue;
    const item = t.item.get(id);
    if (!item) continue;
    const cls = num(item.ClassID);
    const sub = num(item.SubclassID);
    const inv = num(item.InventoryType);
    const weapon = isWeapon(cls, sub, inv);
    const armor = !def.premium && isWornArmor(cls, sub, inv);
    if (!weapon && !armor) continue;
    const list = (t.imaByItem.get(id) ?? []).slice().sort(FIRST_IMA);
    if (weapon) for (const ima of list) add(id, ima.ItemAppearanceID ?? "");
    else if (list[0]) add(id, list[0].ItemAppearanceID ?? "");
  }
  return { line, rows: [...byDisplay.values()].sort((a, b) => a.display - b.display), sets, coverage };
}

// ---------------------------------------------------------------- the two local lines
export interface LineData {
  build: string;
  routes: string[];
  client: LocalLine;
  eclipse: LocalLine;
  /** Display ids the DLL's own Midnight and War Within catalogues hold. */
  entries: Record<string, number[]>;
  /** Retail mount display -> the id the game's morph takes. */
  mounts?: Record<string, number>;
}

interface LocalLine {
  /** entry, retail display, route, InventoryType, class, subclass, name if retail's differs */
  rows: [number, number, number, number, number, number, string?][];
  total: number;
  catalogueRows?: number;
  routes: number[];
  unresolved: number;
  unresolvedSample: [number, string][];
  sets: [number, string, number[]][];
}

let lineData: LineData | null | undefined;

export function readLineData(path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "lines.json.gz")): LineData | null {
  if (lineData !== undefined) return lineData;
  lineData = existsSync(path) ? (JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as LineData) : null;
  return lineData;
}

/** A slot for an InventoryType, when the display's own appearance row has none. */
const INV_SLOT: Record<number, SlotId> = {
  1: "head", 3: "shoulder", 4: "shirt", 5: "chest", 6: "waist", 7: "legs", 8: "feet", 9: "wrist", 10: "hands",
  13: "mainhand", 14: "offhand", 15: "ranged", 16: "back", 17: "mainhand", 19: "tabard", 20: "chest", 21: "mainhand",
  22: "offhand", 23: "offhand", 25: "ranged", 26: "ranged",
};

async function scanLocalLine(ctx: BakeContext, line: "client" | "eclipse"): Promise<LineScope> {
  const data = readLineData();
  if (!data) throw new Error("bake/data/lines.json.gz is missing: run bake/tools/lines_map.py on the owner's PC");
  const src = data[line];
  const t = await tablesOf(ctx.db);
  const coverage: LineCoverage = {
    total: src.total,
    routes: Object.fromEntries(data.routes.map((r, i) => [r, src.routes[i] ?? 0])),
    unresolved: src.unresolved,
    unresolvedSample: src.unresolvedSample,
    unnamed: 0,
    noSlot: 0,
    duplicates: 0,
    ...(src.catalogueRows ? { otherRows: src.catalogueRows - src.total } : {}),
  };
  const nameOfDisplay = (display: number): string => {
    for (const app of t.appearanceOfDisplay.get(String(display)) ?? []) {
      for (const ima of t.imaByAppearance.get(app.ID ?? "") ?? []) {
        const n = t.sparse.get(ima.ItemID ?? "")?.Display_lang;
        if (n && !isPlaceholder(n)) return n;
      }
    }
    return "";
  };
  const byDisplay = new Map<number, LineRow>();
  const displayOfEntry = new Map<number, number>();
  for (const [entry, display, _route, inv, cls, sub, ownName] of src.rows) {
    displayOfEntry.set(entry, display);
    if (byDisplay.has(display)) {
      coverage.duplicates++;
      continue;
    }
    const name = ownName || t.sparse.get(String(entry))?.Display_lang || nameOfDisplay(display);
    if (!name || isPlaceholder(name)) {
      coverage.unnamed++;
      continue;
    }
    const app = (t.appearanceOfDisplay.get(String(display)) ?? [])[0];
    const slot = app ? slotOfDisplayType(num(app.DisplayType)) ?? INV_SLOT[inv] : INV_SLOT[inv];
    if (!slot) {
      coverage.noSlot++;
      continue;
    }
    const item = t.item.get(String(entry));
    const facet = facetOf(cls, sub);
    byDisplay.set(display, {
      display,
      itemId: entry,
      name,
      iconFdid: num(app?.DefaultIconFileDataID) || num(item?.IconFileDataID),
      slot,
      line,
      inventoryType: inv,
      sheatheType: num(item?.SheatheType),
      entry,
      ...(facet ? { facet } : {}),
    });
  }
  const prefix = line === "client" ? "setc" : "sete";
  const sets: LineSet[] = [];
  for (const [id, name, displays] of src.sets) {
    if (isPlaceholder(name)) continue;
    const pieces: LineSet["pieces"] = {};
    for (const d of displays) {
      const row = byDisplay.get(d) ?? byDisplay.get(displayOfEntry.get(d) ?? -1);
      if (row && !pieces[row.slot]) pieces[row.slot] = row.display;
    }
    if (Object.keys(pieces).length > 1) sets.push({ id: `${prefix}-${id}`, name, line, pieces });
  }
  return { line, rows: [...byDisplay.values()].sort((a, b) => a.display - b.display), sets, coverage };
}

/** A whole line, from whole tables. The tables come from wago at the pin, in the cloud and here. */
export async function scanLine(ctx: BakeContext, line: string): Promise<LineScope> {
  if (!LINES[line]) throw new Error(`unknown item line ${line}`);
  if (line === "client" || line === "eclipse") return scanLocalLine(ctx, line);
  return scanRetailLine(ctx, line);
}
