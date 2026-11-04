import { FORMAT_VERSION, type SetEntry, type SetManifest, type SlotId, paths } from "@eclipse/format";
import type { BakeContext } from "../bake/context";
import { groupBy, num } from "../db2/db2";
import { type ItemSpec, itemUnitId } from "./bake";
import { facetOf, slotOfDisplayType } from "./resolve";

/**
 * What each item line covers, from Eclipse's tools/midnight/mn_common.py LINES and
 * tools/warwithin/warwithin_scope.py, minus its exclusion of what Eclipse already
 * ships: a set of TransmogSet.ExpansionID, and items by ItemSparse.ExpansionID.
 */
export const LINES: Record<string, { expansion: number; title: string }> = {
  midnight: { expansion: 11, title: "Midnight" },
  warwithin: { expansion: 10, title: "War Within" },
};

/** Retail's placeholders are not content. */
export function isPlaceholder(name: string): boolean {
  return /\[(DNT|PH)\]/i.test(name) || /^\s*$/.test(name);
}

export interface LineScope {
  items: ItemSpec[];
  sets: { id: string; name: string; line: string; pieces: Partial<Record<SlotId, string>> }[];
}

/**
 * A whole line, from whole tables. Cloud only: Item, ItemSparse and the appearance
 * tables run to tens of megabytes each.
 */
export async function scanLine(ctx: BakeContext, line: string): Promise<LineScope> {
  const def = LINES[line];
  if (!def) throw new Error(`unknown item line ${line}`);
  const db = ctx.db;
  const sparse = (await db.table("ItemSparse")).filter((r) => num(r.ExpansionID) === def.expansion);
  const items = new Map((await db.table("Item")).map((r) => [r.ID ?? "", r]));
  const appearanceRows = await db.table("ItemAppearance");
  const appearance = new Map(appearanceRows.map((r) => [r.ID ?? "", r]));
  const imaById = new Map((await db.table("ItemModifiedAppearance")).map((r) => [r.ID ?? "", r]));
  const imaByItem = groupBy(await db.table("ItemModifiedAppearance"), "ItemID");
  const sparseById = new Map((await db.table("ItemSparse")).map((r) => [r.ID ?? "", r]));

  const byDisplay = new Map<number, ItemSpec>();
  const add = (itemId: string, appearanceId: string): ItemSpec | null => {
    const app = appearance.get(appearanceId);
    if (!app) return null;
    const displayId = num(app.ItemDisplayInfoID);
    if (!displayId) return null;
    const slot = slotOfDisplayType(num(app.DisplayType));
    if (!slot) return null;
    const hit = byDisplay.get(displayId);
    if (hit) return hit;
    const item = items.get(itemId);
    const s = sparseById.get(itemId);
    const name = s?.Display_lang ?? "";
    if (isPlaceholder(name)) return null;
    const facet = item ? facetOf(num(item.ClassID), num(item.SubclassID)) : undefined;
    const spec: ItemSpec = {
      displayId,
      itemId: num(itemId),
      name,
      slot,
      line,
      iconFdid: num(app.DefaultIconFileDataID) || num(item?.IconFileDataID),
      inventoryType: num(item?.InventoryType),
      ...(facet ? { facet } : {}),
    };
    byDisplay.set(displayId, spec);
    return spec;
  };

  // Sets, whatever the expansion of their items.
  const setRows = (await db.table("TransmogSet")).filter((r) => num(r.ExpansionID) === def.expansion && !isPlaceholder(r.Name_lang ?? ""));
  const setItems = groupBy(await db.table("TransmogSetItem"), "TransmogSetID");
  const sets: LineScope["sets"] = [];
  for (const s of setRows) {
    const pieces: Partial<Record<SlotId, string>> = {};
    for (const row of setItems.get(s.ID ?? "") ?? []) {
      const ima = imaById.get(row.ItemModifiedAppearanceID ?? "");
      if (!ima) continue;
      const spec = add(ima.ItemID ?? "", ima.ItemAppearanceID ?? "");
      if (spec && !pieces[spec.slot]) pieces[spec.slot] = itemUnitId(spec.displayId);
    }
    if (Object.keys(pieces).length) sets.push({ id: `set-${s.ID}`, name: s.Name_lang ?? "", line, pieces });
  }

  // Weapons, shields, held off-hands, and worn armour no set carries.
  for (const s of sparse) {
    const item = items.get(s.ID ?? "");
    if (!item) continue;
    const cls = num(item.ClassID);
    const sub = num(item.SubclassID);
    const wearable = cls === 2 || (cls === 4 && sub >= 0 && sub <= 6);
    if (!wearable) continue;
    const ima = (imaByItem.get(s.ID ?? "") ?? []).sort((a, b) => num(a.OrderIndex) - num(b.OrderIndex))[0];
    if (ima) add(s.ID ?? "", ima.ItemAppearanceID ?? "");
  }
  return { items: [...byDisplay.values()].sort((a, b) => a.displayId - b.displayId), sets };
}

/** Sets go up at plan time: they are small and have no game files behind them. */
export async function writeSets(ctx: BakeContext, sets: LineScope["sets"]): Promise<void> {
  for (const s of sets) {
    const m: SetManifest = { formatVersion: FORMAT_VERSION, id: s.id, pieces: s.pieces };
    await ctx.store.put(paths.set(s.id), Buffer.from(JSON.stringify(m)));
    const entry: SetEntry = { id: s.id, name: s.name, circle: "", tile: "", line: s.line, pieces: s.pieces };
    await ctx.store.put(`sets/${s.id}/entry.json`, Buffer.from(JSON.stringify(entry)));
  }
}
