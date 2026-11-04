import { type Db2, type Row, byId, groupBy, num } from "../db2/db2";

/**
 * Every retail race and body, as data. Port of Eclipse's
 * tools/races/races_manifest.py all_races(). Ids and models are read from the
 * tables; only stable names and the icon stems are written here.
 */

/** key -> retail race id. */
const RACE_IDS: Record<string, number> = {
  human: 1,
  orc: 2,
  dwarf: 3,
  nightelf: 4,
  undead: 5,
  tauren: 6,
  gnome: 7,
  troll: 8,
  goblin: 9,
  bloodelf: 10,
  draenei: 11,
  worgen: 22,
  gilnean: 23,
  pandaren: 24,
  nightborne: 27,
  highmountain: 28,
  voidelf: 29,
  lightforged: 30,
  zandalari: 31,
  kultiran: 32,
  darkiron: 34,
  vulpera: 35,
  maghar: 36,
  mechagnome: 37,
  dracthyr: 52,
  visage: 75,
  earthen: 84,
  haranir: 86,
};

const NAME_OVERRIDE: Record<string, string> = { visage: "Dracthyr (Visage)", gilnean: "Worgen (Gilnean)" };

/** Retail's character creator, top to bottom, then the allied races. */
const UI_ORDER = [
  "human", "orc", "dwarf", "undead", "nightelf", "tauren", "gnome", "troll", "draenei", "bloodelf", "worgen",
  "goblin", "pandaren", "dracthyr", "voidelf", "nightborne", "lightforged", "highmountain", "darkiron", "maghar",
  "kultiran", "zandalari", "mechagnome", "vulpera", "earthen", "haranir", "gilnean", "visage",
];

/** The race's portrait in atlas 897 (raceicon128-<icon>-<sex>) where its name differs from the key. */
const ICON: Record<string, string> = { darkiron: "darkirondwarf", maghar: "magharorc", visage: "dracthyrvisage", gilnean: "human" };

/**
 * Retail's posture choice (ChrCustomizationCondModel): the Orc and Mag'har males'
 * Upright / Hunched swaps the whole body to another model on the same options.
 */
const POSTURE: Record<string, { base: string; condModel: number; label: string }> = {
  orcupright: { base: "orc", condModel: 1, label: "Upright" },
  magharupright: { base: "maghar", condModel: 2, label: "Upright" },
};

const ALLIED_FLAG = 0x800000;

export type Sex = "male" | "female";

export interface BodySpec {
  /** `human-male`, `orcupright-male`. */
  id: string;
  name: string;
  raceKey: string;
  sex: Sex;
  /** ChrModel row: its options, layout and default look. */
  chrModel: number;
  /** The `.m2`. */
  m2: number;
  icon: string;
  posture?: string;
}

export interface RaceSpec {
  key: string;
  name: string;
  raceId: number;
  faction: "Alliance" | "Horde" | "Neutral";
  allied: boolean;
  description: string;
  icon: string;
  bodies: BodySpec[];
}

export const BODY_TABLES = ["ChrRaces", "ChrModel", "ChrRaceXChrModel", "CreatureDisplayInfo", "CreatureModelData", "ChrCustomizationCondModel"];

export async function allRaces(db: Db2): Promise<RaceSpec[]> {
  const races = byId(await db.table("ChrRaces"));
  const models = byId(await db.table("ChrModel"));
  const links = groupBy(await db.table("ChrRaceXChrModel"), "ChrRacesID");
  const displays = byId(await db.table("CreatureDisplayInfo"));
  const modelData = byId(await db.table("CreatureModelData"));
  const cond = byId(await db.table("ChrCustomizationCondModel"));

  const m2OfModelData = (id: string): number => {
    const r = modelData.get(id);
    if (!r) throw new Error(`CreatureModelData has no row ${id}`);
    return num(r.FileDataID);
  };
  const m2OfChrModel = (cm: number): number => {
    const row = models.get(String(cm));
    if (!row) throw new Error(`ChrModel has no row ${cm}`);
    const d = displays.get(row.DisplayID ?? "");
    if (!d) throw new Error(`CreatureDisplayInfo has no row ${row.DisplayID}`);
    return m2OfModelData(d.ModelID ?? "");
  };

  // A race retail splits into one playable row per faction is offered to both, as Pandaren is.
  const playablePrefix = new Map<string, number>();
  for (const r of races.values()) {
    if (num(r.PlayableRaceBit) >= 0) {
      const p = (r.ClientPrefix ?? "").toLowerCase();
      playablePrefix.set(p, (playablePrefix.get(p) ?? 0) + 1);
    }
  }

  const out: RaceSpec[] = [];
  for (const key of UI_ORDER) {
    const raceId = RACE_IDS[key]!;
    const row: Row | undefined = races.get(String(raceId));
    if (!row) throw new Error(`ChrRaces has no row ${raceId} (${key})`);
    const bySex = new Map<number, Row>();
    for (const l of links.get(String(raceId)) ?? []) {
      if (!bySex.has(num(l.Sex))) bySex.set(num(l.Sex), l);
    }
    if (bySex.size === 0) throw new Error(`${key}: retail race ${raceId} has no ChrModel`);
    const male = num((bySex.get(0) ?? bySex.get(1))!.ChrModelID);
    const female = num((bySex.get(1) ?? bySex.get(0))!.ChrModelID);
    const name = NAME_OVERRIDE[key] ?? row.Name_lang ?? key;
    const icon = ICON[key] ?? key;
    const bodies: BodySpec[] = [{ id: `${key}-male`, name: male === female ? name : `${name} Male`, raceKey: key, sex: "male", chrModel: male, m2: m2OfChrModel(male), icon }];
    // A one-model race (the Dracthyr dragon) is one body.
    if (female !== male) bodies.push({ id: `${key}-female`, name: `${name} Female`, raceKey: key, sex: "female", chrModel: female, m2: m2OfChrModel(female), icon });
    for (const [pk, p] of Object.entries(POSTURE)) {
      if (p.base !== key) continue;
      const c = cond.get(String(p.condModel));
      if (!c) throw new Error(`ChrCustomizationCondModel has no row ${p.condModel}`);
      bodies.push({ id: `${pk}-male`, name: `${name} Male (${p.label})`, raceKey: key, sex: "male", chrModel: male, m2: m2OfModelData(c.CreatureModelDataID ?? ""), icon, posture: pk });
    }
    const a = num(row.Alliance);
    const neutral = a === 2 || (playablePrefix.get((row.ClientPrefix ?? "").toLowerCase()) ?? 0) > 1;
    out.push({
      key,
      name,
      raceId,
      faction: neutral ? "Neutral" : a === 0 ? "Alliance" : "Horde",
      allied: (num(row.Flags) & ALLIED_FLAG) !== 0,
      description: row.LoreDescription_lang ?? "",
      icon,
      bodies,
    });
  }
  return out;
}

export function allBodies(races: RaceSpec[]): BodySpec[] {
  return races.flatMap((r) => r.bodies);
}
