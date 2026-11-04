import type { BakeContext } from "../bake/context";
import { type Row, byId, groupBy, num } from "../db2/db2";
import { isPlaceholder, readLineData } from "../items/lines";

/**
 * Every mount the game offers, as Eclipse's Mounts page lists them (UiMounts.cpp): a row
 * is an animal, one model file, and its colours are the MountXDisplay rows of every mount
 * riding that file. No colour is invented: a variant is a display the game itself gives.
 * Chain: tools/retailmounts/mount_inventory.py. What is left out: mount_exclude.py, minus
 * its exclusions of what Eclipse already ships.
 */

/** creature/invisiblestalker: retail draws nothing, the rider is the visual. */
const INVISIBLE = new Set([124640, 124641, 124642, 343863, 439302, 1347127]);
/** Taken out of Eclipse's list by its owner, 2026-10-17: creature/hippogryphmount. */
const OWNER_REMOVED = new Set([124410]);
const FLIES = 0x2;
/** A name no player was meant to read: Blizzard's own marks, and a test rig under any other name. */
const INTERNAL_NAME = /\[(?:DND|DNT|PH|NYI|TEST|WIP)\]|\bTest Mount\b|\bModel Test\b|\bNYI\b/i;

/**
 * Mounts the game keeps from its players, by measurement at 12.1.0.69933. Mount.Flags 0x40
 * "hide if unknown" is NOT one of these: it is on 436 rows, Swift Razzashi Raptor and every
 * Gladiator's mount among them, because it only means the Journal hides what you can't get.
 * What marks an internal row is no words at all: no description and no source text, so the
 * Journal has nothing to say about it (Lightforged Ruinstrider 1567, Whelpling 1690 and 1796).
 */
export function isInternalMount(m: { Name_lang?: string; Description_lang?: string; SourceText_lang?: string }): boolean {
  if (INTERNAL_NAME.test(m.Name_lang ?? "") || /^\s*NYI\s*$/i.test(m.Description_lang ?? "")) return true;
  return !(m.Description_lang ?? "").trim() && !(m.SourceText_lang ?? "").trim();
}

export interface MountVariantSpec {
  display: number;
  mountId: number;
  name: string;
  iconFdid: number;
  m2: number;
  scale: number;
  /** TextureVariationFileDataID_0..3: M2 texture types 11, 12, 13, and 5 for retail's fourth. */
  skins: [number, number, number, number];
  extra: number;
  /** CreatureModelData.CreatureGeosetDataID. */
  geosetData: number;
  entry?: number;
}

export interface MountFamily {
  id: string;
  name: string;
  m2: number;
  mountId: number;
  flying: boolean;
  variants: MountVariantSpec[];
}

export interface MountScan {
  families: MountFamily[];
  /** Displays left out, by why. */
  excluded: Record<string, number>;
  mounts: number;
  displays: number;
}

export function lookKey(v: Pick<MountVariantSpec, "m2" | "skins" | "extra">, geosets: readonly string[]): string {
  return [v.m2, ...v.skins, v.extra, ...geosets].join(",");
}

export async function scanMounts(ctx: BakeContext): Promise<MountScan> {
  const db = ctx.db;
  const mounts = byId(await db.table("Mount"));
  const links = await db.table("MountXDisplay");
  const displays = byId(await db.table("CreatureDisplayInfo"));
  const models = byId(await db.table("CreatureModelData"));
  const chrModels = await db.table("ChrModel");
  const chrDisplay = new Set(chrModels.map((r) => r.DisplayID ?? ""));
  const chrModelData = new Set(chrModels.map((r) => displays.get(r.DisplayID ?? "")?.ModelID ?? ""));
  const typeCaps = groupBy(await db.table("MountTypeXCapability"), "MountTypeID");
  const caps = byId(await db.table("MountCapability"));
  const geosetRows = groupBy(await db.table("CreatureDisplayInfoGeosetData"), "CreatureDisplayInfoID");
  const spellIcon = async (spell: number): Promise<number> => num((await db.where("SpellMisc", "SpellID", spell))[0]?.SpellIconFileDataID);
  const entries = readLineData()?.mounts ?? {};

  const flying = (m: Row): boolean => (typeCaps.get(m.MountTypeID ?? "") ?? []).some((c) => (num(caps.get(c.MountCapabilityID ?? "")?.Flags) & FLIES) !== 0);
  const excluded: Record<string, number> = {};
  const drop = (why: string) => {
    excluded[why] = (excluded[why] ?? 0) + 1;
  };
  const byModel = new Map<number, MountVariantSpec[]>();
  const seen = new Set<string>();
  for (const x of links) {
    const mountId = num(x.MountID);
    const m = mounts.get(String(mountId));
    if (!m) {
      drop("no Mount row");
      continue;
    }
    const name = m.Name_lang ?? "";
    if (isPlaceholder(name)) {
      drop("placeholder name");
      continue;
    }
    if (isInternalMount(m)) {
      drop("internal");
      continue;
    }
    const display = num(x.CreatureDisplayInfoID);
    const c = displays.get(String(display));
    const md = c ? models.get(c.ModelID ?? "") : undefined;
    const m2 = num(md?.FileDataID);
    if (!c || !md || !m2) {
      drop("no model");
      continue;
    }
    if (INVISIBLE.has(m2)) {
      drop("invisible model");
      continue;
    }
    if (OWNER_REMOVED.has(m2)) {
      drop("taken out by the owner");
      continue;
    }
    const extra = num(c.ExtendedDisplayInfoID);
    // A body with no baked skin and no choices: retail draws every option at once.
    if (!extra && chrModelData.has(c.ModelID ?? "") && !chrDisplay.has(String(display))) {
      drop("character model with no look");
      continue;
    }
    const skins: MountVariantSpec["skins"] = [num(c.TextureVariationFileDataID_0), num(c.TextureVariationFileDataID_1), num(c.TextureVariationFileDataID_2), num(c.TextureVariationFileDataID_3)];
    const geosetData = num(md.CreatureGeosetDataID);
    const geosetIds = (geosetRows.get(String(display)) ?? []).map((g) => `${g.GeosetIndex}.${g.GeosetValue}`).sort();
    const key = lookKey({ m2, skins, extra }, geosetIds);
    if (seen.has(key)) {
      drop("same look as another display");
      continue;
    }
    seen.add(key);
    const scale = (Number(c.CreatureModelScale) || 1) * (Number(md.ModelScale) || 1);
    const entry = entries[String(display)];
    const spec: MountVariantSpec = { display, mountId, name, iconFdid: 0, m2, scale, skins, extra, geosetData, ...(entry ? { entry } : {}) };
    const list = byModel.get(m2);
    if (list) list.push(spec);
    else byModel.set(m2, [spec]);
  }

  const families: MountFamily[] = [];
  for (const [m2, variants] of byModel) {
    variants.sort((a, b) => a.mountId - b.mountId || a.display - b.display);
    for (const v of variants) {
      const spell = num(mounts.get(String(v.mountId))?.SourceSpellID);
      v.iconFdid = spell ? await spellIcon(spell) : 0;
    }
    const first = variants[0]!;
    families.push({ id: `mount-${first.mountId}`, name: first.name, m2, mountId: first.mountId, flying: flying(mounts.get(String(first.mountId))!), variants });
  }
  families.sort((a, b) => a.mountId - b.mountId);
  return { families, excluded, mounts: mounts.size, displays: links.length };
}
