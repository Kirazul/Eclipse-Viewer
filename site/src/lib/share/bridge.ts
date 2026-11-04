/**
 * Between what the site shows and what a code holds. Pure: everything it needs from
 * the catalogue comes in as a function, so a test can run it without a page.
 *
 * THE RULE IS A DIFF. A code is read into `Loaded`: the outfit as it came, and the
 * site's state once dressed in it. Exporting starts from that outfit and changes only
 * what the player changed on the site since. So a game-made code imported and exported
 * comes back byte for byte, and everything the site can't draw or edit (glows, slot
 * colours, skins, cosmetics, scale, sheathe, morph, unknown items, lines from a newer
 * build) stays exactly as it was, even through edits to the rest.
 */
import type { Look, SlotId } from "@eclipse/format";
import { sscanf } from "./cstdio";
import { cloneOutfit, newOutfit, type Outfit } from "./outfit";

/** morph::Slot: the equipment slot a site slot wears in (MorphOffsets.h). */
export const MORPH_SLOT: Record<SlotId, number> = {
  head: 0, shoulder: 2, shirt: 3, chest: 4, waist: 5, legs: 6, feet: 7, wrist: 8, hands: 9,
  back: 14, mainhand: 15, offhand: 16, ranged: 17, tabard: 18,
};
const SITE_SLOTS = Object.keys(MORPH_SLOT) as SlotId[];
/** morph::SlotIsVisual's complement: neck, rings, trinkets. A code can hold them; nothing draws them. */
const UNSEEN_SLOTS = [1, 10, 11, 12, 13];

/** ChrRaces ids of a `look` line, the game's own bodies. The site draws the retail body of the same race. */
const CLASSIC_RACE: Record<number, string> = {
  1: "human", 2: "orc", 3: "dwarf", 4: "nightelf", 5: "undead", 6: "tauren", 7: "gnome", 8: "troll", 9: "goblin", 10: "bloodelf", 11: "draenei",
};

export interface SiteState {
  /** Body id: `<race key>-male` or `-female`. */
  body: string;
  /** Slot -> item id. */
  worn: Partial<Record<SlotId, string>>;
  /** Option id -> choice id, retail's ids. Null: the site isn't choosing, the body's first look stands. */
  choices: Look | null;
  /** In-game display ids (MountVariant.entry). */
  mount: number;
  mountFly: number;
}

/** A code once it is on the figure. */
export interface Loaded {
  outfit: Outfit;
  at: SiteState;
}

export interface Lookup {
  /** The in-game entry of a catalogue item. Undefined: this item can't go to the game. */
  entryOf(itemId: string): number | undefined;
}

/**
 * A player without the race pack wears a classic body instead of their own: the code
 * holds `look` then `rlook`. The DLL's reader tries the retail line and, when it can't
 * wear it, leaves the classic one standing (Morph.cpp Deserialize, CharCustom.cpp
 * Deserialize). Keys are tools/races/races_manifest.py's; ids are 3.3.5 ChrRaces.
 *
 * The bytes stay 0: races::ToLook has no retail-to-classic mapping to reuse (it writes
 * zeros and a slot), and Import does not sanitise (Share.cpp -> ApplyLoadout), so a
 * guessed value could reach the compositor unchecked. Zero is a real row on all 20
 * classic bodies, measured in re/models/charcolor_tools/charsections_live.json.
 */
export const CLASSIC_FALLBACK: Record<string, number> = {
  human: 1, kultiran: 1, worgen: 1, gilnean: 1, pandaren: 1,
  orc: 2, maghar: 2, orcupright: 2, magharupright: 2,
  dwarf: 3, darkiron: 3, earthen: 3,
  nightelf: 4, nightborne: 4, haranir: 4,
  undead: 5,
  tauren: 6, highmountain: 6,
  gnome: 7, mechagnome: 7, goblin: 7, vulpera: 7,
  troll: 8, zandalari: 8,
  bloodelf: 10, voidelf: 10, visage: 10, dracthyr: 10,
  draenei: 11, lightforged: 11,
};

/** The classic look a retail body falls back to. A key not in the table has none. */
export function classicFallback(key: string, sex: "m" | "f") {
  const race = CLASSIC_FALLBACK[key];
  return race ? { managed: true, race, gender: sex === "f" ? 1 : 0, skin: 0, face: 0, hairStyle: 0, hairColour: 0, facialHair: 0 } : null;
}

/** "human-female" -> race key and sex; a body id is exactly `<key>-<sex>`. */
export function splitBody(body: string): { key: string; sex: "m" | "f" } | null {
  const m = /^(.+)-(male|female)$/.exec(body);
  return m ? { key: m[1]!, sex: m[2] === "female" ? "f" : "m" } : null;
}

/**
 * races::Serialize: `rlook <key> <m|f> <option>:<choice> ...`, retail's ids. The client
 * finds the race by key, so this needs no number that only one client knows. Options
 * the line leaves out wear their first choice (races::Settle).
 */
export function rlookLine(body: string, choices: Look | null, order?: readonly number[]): string | null {
  const b = splitBody(body);
  if (!b) return null;
  let s = `rlook ${b.key} ${b.sex}`;
  if (choices) {
    const seen = new Set<number>();
    for (const id of order ?? []) {
      if (choices[id] !== undefined) {
        s += ` ${id}:${choices[id]}`;
        seen.add(id);
      }
    }
    for (const k of Object.keys(choices)) {
      const id = Number(k);
      if (!seen.has(id)) s += ` ${id}:${choices[id]}`;
    }
  }
  return s;
}

export interface RLook {
  key: string;
  sex: "m" | "f";
  choices: Look;
}

/** races::Deserialize's reading, with no manifest to check it against. */
export function parseRlook(line: string): RLook | null {
  const head = sscanf(line, "rlook %63s %7s%n");
  if (head.count < 2) return null;
  const choices: Look = {};
  let p = head.values[2] as number;
  for (;;) {
    const r = sscanf(line.slice(p), " %u:%u%n");
    if (r.count !== 2) break;
    choices[r.values[0] as number] = r.values[1] as number;
    p += r.values[2] as number;
  }
  return { key: head.values[0] as string, sex: (head.values[1] as string)[0] === "f" ? "f" : "m", choices };
}

/** The body a code asks for, and what it says about it. Null: it leaves the body alone. */
export function bodyOf(o: Outfit, hasBody: (id: string) => boolean): { body: string | null; choices: Look | null; race: string; sex: "m" | "f" } | null {
  const classic = () => {
    const key = CLASSIC_RACE[o.look.race];
    const sex = o.look.gender ? "female" : "male";
    return { body: key && hasBody(`${key}-${sex}`) ? `${key}-${sex}` : null, choices: null, race: key ?? String(o.look.race), sex: o.look.gender ? ("f" as const) : ("m" as const) };
  };
  // Holding both, the retail line is the look; the classic one is for a client without the pack.
  const r = o.rlookKept ? parseRlook(o.rlookKept) : null;
  if (!r) {
    if (o.look.managed) return classic();
    return o.rlookKept ? { body: null, choices: null, race: "", sex: "m" } : null;
  }
  let body: string | null = `${r.key}-${r.sex === "f" ? "female" : "male"}`;
  // races::Settle: a single-model race's female is its male.
  if (!hasBody(body)) body = hasBody(`${r.key}-male`) ? `${r.key}-male` : null;
  if (!body && o.look.managed) return classic();
  return { body, choices: r.choices, race: r.key, sex: r.sex };
}

const sameChoices = (a: Look | null, b: Look | null): boolean => {
  // Null is "not known yet" (the body's manifest was still on the wire): no edit either.
  if (!a || !b) return true;
  // A settled look may name more options than the code did. What the code named is what counts.
  for (const k of Object.keys(a)) if (a[Number(k)] !== b[Number(k)]) return false;
  return true;
};

export interface Composed {
  outfit: Outfit;
  /** Worn on the site, no in-game entry: left out of the code. */
  notExportable: SlotId[];
}

/** The outfit for what the site is showing now: the loaded code, changed where the player changed it. */
export function composeOutfit(loaded: Loaded | null, site: SiteState, lookup: Lookup, order?: readonly number[]): Composed {
  const o = loaded ? cloneOutfit(loaded.outfit) : newOutfit();
  const at = loaded?.at;
  const notExportable: SlotId[] = [];
  let edited = !at;
  for (const slot of SITE_SLOTS) {
    const m = MORPH_SLOT[slot];
    const now = site.worn[slot];
    if (at && now === at.worn[slot]) continue;
    edited = true;
    const entry = now ? lookup.entryOf(now) : undefined;
    if (now && !entry) notExportable.push(slot);
    o.managed[m] = !!entry;
    o.item[m] = entry ?? 0;
  }
  if (!at || site.mount !== at.mount) {
    edited = edited || !!at;
    o.mount = site.mount;
  }
  if (!at || site.mountFly !== at.mountFly) {
    edited = edited || !!at;
    o.mountFly = site.mountFly;
  }
  const bodyEdited = !at || site.body !== at.body || !sameChoices(at.choices, site.choices);
  const line = bodyEdited ? rlookLine(site.body, site.choices, order) : null;
  if (bodyEdited) edited = true;
  if (line) o.rlookKept = line;
  // Built or edited here: a retail line gets its classic fallback, ahead of it. A code
  // nobody touched is left as it came, and that is the round-trip gate.
  if (edited && o.rlookKept) {
    const r = parseRlook(o.rlookKept);
    const f = r && classicFallback(r.key, r.sex);
    // Bytes already chosen for that very race and sex are a better fallback than zeros.
    if (f) { if (!(o.look.managed && o.look.race === f.race && o.look.gender === f.gender)) o.look = f; }
    // No fallback for a new retail line: the old look must not win over it on any client.
    else if (line) o.look = { ...o.look, managed: false };
  }
  return { outfit: o, notExportable };
}

export interface WornFromCode {
  worn: Partial<Record<SlotId, string>>;
  /** Slots holding an item the catalogue doesn't list. */
  unknown: SlotId[];
  /** Slots the code shows as nothing (mo::kHidden). */
  hidden: SlotId[];
}

/** What a code puts on the ring. A slot it leaves alone stays empty on the site. */
export function wornFromCode(o: Outfit, itemOfEntry: (slot: SlotId, entry: number) => string | undefined): WornFromCode {
  const out: WornFromCode = { worn: {}, unknown: [], hidden: [] };
  for (const slot of SITE_SLOTS) {
    const m = MORPH_SLOT[slot];
    if (!o.managed[m]) continue;
    if (!o.item[m]) {
      out.hidden.push(slot);
      continue;
    }
    const id = itemOfEntry(slot, o.item[m]!);
    if (id) out.worn[slot] = id;
    else out.unknown.push(slot);
  }
  return out;
}

export interface Kept {
  /** How many things the code holds that the site can't draw. */
  count: number;
  /** "2 slot colours" and so on, for the tip. */
  parts: string[];
}

const counted = (n: number, one: string, many = `${one}s`) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/**
 * What goes back into the code untouched but can't be drawn here. `shownMounts` is how
 * many of the code's two mount slots the site could name.
 */
export function keptInCode(o: Outfit, unknownSlots: number, bodyShown: boolean, shownMounts: number): Kept {
  const parts: [number, string][] = [];
  const add = (n: number, text: string) => { if (n) parts.push([n, text]); };
  const unseen = UNSEEN_SLOTS.filter((m) => o.managed[m]).length;
  add(unknownSlots, counted(unknownSlots, "item"));
  add(unseen, counted(unseen, "neck, ring or trinket", "neck, ring or trinket slots"));
  add(o.display ? 1 : 0, "a creature morph");
  const mounts = (o.mount ? 1 : 0) + (o.mountFly && o.mountFly !== o.mount ? 1 : 0) - shownMounts;
  if (mounts > 0) add(mounts, counted(mounts, "mount"));
  add(o.mountHidden ? 1 : 0, "mount hidden");
  const sheathe = o.sheathe.filter(Boolean).length;
  add(sheathe, counted(sheathe, "sheathe position"));
  const glows = o.enchant.filter((e) => e.managed || e.tint || e.id).length;
  add(glows, counted(glows, "weapon glow"));
  add(o.scale > 0 ? 1 : 0, "scale");
  const colours = o.colors.on.filter(Boolean).length;
  add(colours, counted(colours, "body colour"));
  const tints = o.wtint.filter((t) => t.item).length;
  add(tints, counted(tints, "slot colour"));
  const skins = o.skin.filter((l) => l.item).length + o.mskin.filter((l) => l.item).length;
  add(skins, counted(skins, "skin"));
  const mcol = o.mtint.filter((t) => t.item).length;
  add(mcol, counted(mcol, "mount colour"));
  add(o.cosmetic.length, counted(o.cosmetic.length, "cosmetic"));
  // A fallback under a retail line isn't something the site fails to draw: the retail body is shown.
  const classic = o.look.managed && !o.rlookKept && (o.look.skin || o.look.face || o.look.hairStyle || o.look.hairColour || o.look.facialHair) ? 1 : 0;
  add(classic, "classic face and hair");
  const hasBody = o.look.managed || !!o.rlookKept;
  add(hasBody && !bodyShown ? 1 : 0, "a body not on the site");
  add(o.extra.length, counted(o.extra.length, "line from a newer build", "lines from a newer build"));
  return { count: parts.reduce((n, p) => n + p[0], 0), parts: parts.map((p) => p[1]) };
}

export interface Summary {
  pieces: number;
  mount: boolean;
  glows: boolean;
  skins: boolean;
  race: boolean;
}

/** UiMorph.cpp LoadoutSummary, with its exact words. */
export function loadoutSummary(o: Outfit): string {
  const pieces = o.managed.filter(Boolean).length;
  const mount = !!(o.mount || o.mountFly || o.mountHidden);
  const glow = o.glowKnown && o.enchant.some((e) => e.managed || e.tint);
  const skinned = o.skinOn || !!o.mskin[0]!.item || !!o.mskin[1]!.item;
  const race = o.look.managed || !!o.rlookKept;
  if (!pieces && !mount && !glow && !race && !skinned) return "Empty loadout";
  return `${pieces} piece${pieces === 1 ? "" : "s"}${mount ? "  /  mount" : ""}${glow ? "  /  glows" : ""}${skinned ? "  /  skins" : ""}${race ? "  /  race" : ""}`;
}

/** The name an import is filed under: Share.cpp ImportName. */
export function importName(existing: readonly { name: string; same: boolean }[]): string {
  for (const l of existing) if (l.same) return l.name;
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? "Imported" : `Imported ${n}`;
    if (!existing.some((l) => l.name.toLowerCase() === name.toLowerCase())) return name;
  }
  return "";
}

/**
 * A code as a look URL's query: `body` and `look` say what they can. When the code
 * holds anything those two can't, `code` carries it whole, so the link loses nothing.
 */
export function urlQueryOfCode(code: string, site: SiteState, kept: Kept): string {
  const parts: string[] = [];
  if (site.body) parts.push(`body=${encodeURIComponent(site.body)}`);
  const worn = Object.entries(site.worn);
  if (worn.length) parts.push(`look=${worn.map(([s, id]) => `${s}:${encodeURIComponent(id ?? "")}`).join(",")}`);
  if (kept.count || site.choices) parts.push(`code=${encodeURIComponent(code)}`);
  return parts.join("&");
}

/**
 * The code a look URL stands for. `code` is the code, whole. Otherwise `body`, `look`
 * and `choices` compose one, exactly as Share does for a look built on the site.
 */
export function urlToOutfit(query: string, lookup: Lookup, decodeCode: (code: string) => Outfit | null): Composed | null {
  const q = new URLSearchParams(query);
  const code = q.get("code")?.replace(/ /g, "+");
  if (code) {
    const outfit = decodeCode(code);
    return outfit ? { outfit, notExportable: [] } : null;
  }
  const worn: SiteState["worn"] = {};
  for (const part of (q.get("look") ?? "").split(",")) {
    const [slot, id] = part.split(":");
    if (slot && id && slot in MORPH_SLOT) worn[slot as SlotId] = id;
  }
  const choices: Look = {};
  for (const part of (q.get("choices") ?? "").split(",")) {
    const [o, c] = part.split(".").map(Number);
    if (Number.isInteger(o) && Number.isInteger(c)) choices[o!] = c!;
  }
  const body = q.get("body") || q.get("id") || "";
  return composeOutfit(null, { body, worn, choices: Object.keys(choices).length ? choices : null, mount: 0, mountFly: 0 }, lookup);
}
