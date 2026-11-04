/**
 * mo::Outfit, mo::Serialize and mo::Deserialize (src/eclipse/wardrobe/Morph.h, Morph.cpp),
 * line for line. `golden/` proves it against the real C++.
 *
 * Text here is a byte string: each char is one byte, as std::string holds it.
 *
 * Three things differ from the C++ on purpose, so the site can carry what it reads:
 *  - Display ids stay as the file has them. tmerge::DisplayFromPortable turns a portable
 *    id into this client's and PortableDisplay turns it back; the site has no client,
 *    so it keeps the portable id, which is what the code means on every client.
 *  - An `rlook` line is kept whole, however long. The C++ keeps it in a 1152-byte
 *    buffer on a client without the race pack, sized for the longest real line. A
 *    `look` before it is the classic fallback: this reads and writes both, as the C++
 *    does without the pack (races.ClassicFallback, Morph.cpp Serialize).
 *  - Lines the C++ would skip go in `extra` (a key from a newer build, a preset this
 *    build lacks). serialize() is the exact port and ignores them; writeBack() below
 *    puts them back where they were.
 */
import { fixed, sscanf } from "./cstdio";

export const SLOT_COUNT = 19;
export const COLOUR_SLOTS = 14;
export const SKIN_SLOTS = 15;
export const MOUNT_SLOTS = 2;
export const AXIS_COUNT = 5;
export const MAX_COSMETICS = 16;
export const SHEATHE_POSITIONS = 4;
/** skins::PresetCount() today. A share from a newer build can name more; those go to `extra`. */
export const SKIN_PRESETS = 264;
export const SKIN_PALETTES = 3;
export const SKIN_PLACEMENTS = 5;
export const COSMETIC_MODES = 2;
/** mo::kAnyRide: a mount look chosen with no mount. */
export const ANY_RIDE = 1;
/** mo::kHidden: a managed slot holding this shows nothing. */
export const HIDDEN = 0;

export interface WcolLook { hue: number; sat: number; light: number; dye: number }
export interface Tint { item: number; look: WcolLook }
export interface SkinLook {
  item: number; preset: number; palette: number; placement: number;
  strength: number; speed: number; scale: number; rim: number; sparkle: number; depth: number;
  seed: number; dir: number; color: WcolLook; accent: [number, number, number];
}
export interface EnchantLook { id: number; colour: number; managed: boolean; tint: boolean }
export interface CosmeticColour {
  mode: number; hue: number; saturation: number; intensity: number;
  whiteCore: number; windowHue: number; window: number; feather: number;
}
export interface CosmeticLook {
  target: number; catalog: boolean; scale: number;
  offset: [number, number, number]; turn: [number, number, number];
  coloured: boolean; colour: CosmeticColour; scope: number;
}
export interface CcLook {
  managed: boolean; race: number; gender: number; skin: number; face: number;
  hairStyle: number; hairColour: number; facialHair: number;
}

/** A line this build does not read, and the line it followed. */
export interface ExtraLine { after: string | null; line: string }

export interface Outfit {
  item: number[];
  managed: boolean[];
  display: number;
  displayNative: boolean;
  mount: number;
  mountHidden: boolean;
  mountFly: number;
  scale: number;
  sheathe: [number, number];
  enchant: [EnchantLook, EnchantLook];
  glowKnown: boolean;
  look: CcLook;
  /** A retail body's whole `rlook` line, its race key and every choice. */
  rlookKept: string;
  colors: { rgb: number[]; on: boolean[] };
  colorsKnown: boolean;
  wtint: Tint[];
  wtintKnown: boolean;
  skin: SkinLook[];
  skinOn: boolean;
  skinKnown: boolean;
  mskin: SkinLook[];
  mskinKnown: boolean;
  gtintKnown: boolean;
  mtint: Tint[];
  mtintKnown: boolean;
  cosmetic: CosmeticLook[];
  cosmeticsKnown: boolean;
  extra: ExtraLine[];
  /** Set by decode: the code as it came, so an untouched one goes back the same. */
  source?: { body: string; tail: string; written: string };
}

const noWcol = (): WcolLook => ({ hue: 0, sat: 255, light: 128, dye: 0 });
const noTint = (): Tint => ({ item: 0, look: noWcol() });
const noSkin = (): SkinLook => ({
  item: 0, preset: 0, palette: 0, placement: 0, strength: 128, speed: 128, scale: 128, rim: 128, sparkle: 128, depth: 128,
  seed: 0, dir: 0, color: noWcol(), accent: [255, 255, 255],
});
const noEnchant = (): EnchantLook => ({ id: 0, colour: 0, managed: false, tint: false });

export function newOutfit(): Outfit {
  return {
    item: Array<number>(SLOT_COUNT).fill(0),
    managed: Array<boolean>(SLOT_COUNT).fill(false),
    display: 0, displayNative: false,
    mount: 0, mountHidden: false, mountFly: 0,
    scale: 0,
    sheathe: [0, 0],
    enchant: [noEnchant(), noEnchant()],
    glowKnown: false,
    look: { managed: false, race: 0, gender: 0, skin: 0, face: 0, hairStyle: 0, hairColour: 0, facialHair: 0 },
    rlookKept: "",
    colors: { rgb: Array<number>(AXIS_COUNT).fill(0), on: Array<boolean>(AXIS_COUNT).fill(false) },
    colorsKnown: false,
    wtint: Array.from({ length: COLOUR_SLOTS }, noTint),
    wtintKnown: false,
    skin: Array.from({ length: SKIN_SLOTS }, noSkin),
    skinOn: false, skinKnown: false,
    mskin: Array.from({ length: MOUNT_SLOTS }, noSkin),
    mskinKnown: false,
    gtintKnown: false,
    mtint: Array.from({ length: MOUNT_SLOTS }, noTint),
    mtintKnown: false,
    cosmetic: [],
    cosmeticsKnown: false,
    extra: [],
  };
}

export function cloneOutfit(o: Outfit): Outfit {
  return structuredClone(o);
}

/** wcol::kMorphSlotOf: the wardrobe slot of each colour slot. */
export const MORPH_SLOT_OF_COLOUR = [15, 16, 17, 0, 2, 14, 4, 3, 18, 8, 9, 5, 6, 7];

const hex6 = (v: number) => v.toString(16).toUpperCase().padStart(6, "0");
const line128 = (s: string) => s.slice(0, 127); // _snprintf_s(line, 128, _TRUNCATE, ...)

function skinLine(tag: string, slot: number, item: number, l: SkinLook): string {
  return line128(
    `${tag} ${slot} ${item} ${l.preset} ${l.palette} ${l.placement} ${l.strength} ${l.speed} ${l.scale} ${l.rim} ` +
    `${l.sparkle} ${l.depth} ${l.seed} ${l.dir} ${l.color.hue} ${l.color.sat} ${l.color.light} ${l.color.dye} ` +
    `${l.accent[0]} ${l.accent[1]} ${l.accent[2]}\n`,
  );
}

/** mo::Serialize, cc::Serialize and skins::FormatLookLine. */
export function serialize(o: Outfit): string {
  let s = "";
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (o.managed[i]) s += `slot ${i} ${o.item[i]}\n`;
  }
  if (o.display) s += `display ${o.display} ${o.displayNative ? 1 : 0}\n`;
  if (o.mount) s += `mount ${o.mount}\n`;
  if (o.mountFly) s += `mountfly ${o.mountFly}\n`;
  if (o.mountHidden) s += "mounthidden 1\n";
  for (let h = 0; h < 2; h++) {
    if (o.sheathe[h] !== 0) s += `sheathe ${h} ${o.sheathe[h]}\n`;
  }
  if (o.glowKnown) s += "glowok 1\n";
  for (let h = 0; h < 2; h++) {
    const e = o.enchant[h]!;
    if (!e.managed && !e.tint && !e.id && !e.colour) continue;
    s += `glow ${h} ${e.id} ${e.managed ? 1 : 0} ${e.tint ? 1 : 0} ${hex6(e.colour)}\n`;
  }
  if (o.scale > 0) s += line128(`scale ${fixed(o.scale, 4)}\n`);
  if (o.look.managed) {
    const l = o.look;
    s += `look ${l.race} ${l.gender} ${l.skin} ${l.face} ${l.hairStyle} ${l.hairColour} ${l.facialHair}\n`;
  }
  if (o.rlookKept) s += `${o.rlookKept}\n`;
  if (o.colorsKnown) s += "ccolok 1\n";
  for (let a = 0; a < AXIS_COUNT; a++) {
    if (o.colors.on[a]) s += `ccol ${a} ${hex6(o.colors.rgb[a]! & 0xffffff)}\n`;
  }
  if (o.wtintKnown) s += "wcolok 1\n";
  if (o.gtintKnown) s += "gcolok 1\n";
  for (let w = 0; w < COLOUR_SLOTS; w++) {
    const t = o.wtint[w]!;
    if (t.item) s += `wcol ${w} ${t.item} ${t.look.hue} ${t.look.sat} ${t.look.light} ${t.look.dye}\n`;
  }
  if (o.skinKnown) s += "skinok 1\n";
  for (let k = 0; k < SKIN_SLOTS; k++) {
    if (o.skin[k]!.item) s += skinLine("skin", k, o.skin[k]!.item, o.skin[k]!);
  }
  if (o.mskinKnown) s += "mskinok 1\n";
  for (let m = 0; m < MOUNT_SLOTS; m++) {
    if (o.mskin[m]!.item) s += skinLine("mskin", m, o.mskin[m]!.item, o.mskin[m]!);
  }
  if (o.mtintKnown) s += "mcolok 1\n";
  for (let m = 0; m < MOUNT_SLOTS; m++) {
    const t = o.mtint[m]!;
    if (t.item) s += `mcol ${m} ${t.item} ${t.look.hue} ${t.look.sat} ${t.look.light} ${t.look.dye}\n`;
  }
  if (o.cosmeticsKnown) s += "cosok 1\n";
  for (const c of o.cosmetic) {
    if (!c.target) continue;
    const k = c.colour;
    s += (
      `cosm ${c.target} ${c.catalog ? 1 : 0} ${fixed(c.scale, 4)} ${fixed(c.offset[0], 4)} ${fixed(c.offset[1], 4)} ` +
      `${fixed(c.offset[2], 4)} ${fixed(c.turn[0], 3)} ${fixed(c.turn[1], 3)} ${fixed(c.turn[2], 3)} ${c.coloured ? 1 : 0} ` +
      `${k.mode} ${fixed(k.hue, 3)} ${fixed(k.saturation, 4)} ${fixed(k.intensity, 4)} ` +
      `${fixed(k.whiteCore, 4)} ${fixed(k.windowHue, 3)} ${fixed(k.window, 3)} ${fixed(k.feather, 3)} ${c.scope}\n`
    ).slice(0, 319); // char cl[320], _TRUNCATE
  }
  return s;
}

const byte255 = (u: number) => (u > 255 ? 255 : u);

/** MountTintsFollowSlots: a mount's colour and look live only with that mount. */
function mountTintsFollowSlots(o: Outfit) {
  for (let m = 0; m < MOUNT_SLOTS; m++) {
    const held = m ? o.mountFly : o.mount;
    if (o.mtint[m]!.item && o.mtint[m]!.item !== held) o.mtint[m] = noTint();
    if (o.mskin[m]!.item && o.mskin[m]!.item === ANY_RIDE) {
      if (held) o.mskin[m]!.item = held;
    } else if (o.mskin[m]!.item && o.mskin[m]!.item !== held) o.mskin[m] = noSkin();
  }
}

/** skins::ParseLookLine. */
function parseSkinLine(line: string, tag: string): { slot: number; item: number; look: SkinLook } | null {
  if (!line.startsWith(tag) || line[tag.length] !== " ") return null;
  const r = sscanf(line.slice(tag.length), " %d %u %u %u %u %u %u %u %u %u %u %u %u %u %u %u %u %u %u %u");
  if (r.count !== 20 || !r.values[1]) return null;
  const n = r.values as number[];
  const u = n.slice(1);
  const look = noSkin();
  look.item = u[0]!;
  look.preset = u[1]! & 0xffff;
  look.palette = u[2]! < SKIN_PALETTES ? u[2]! : 0;
  look.placement = u[3]! < SKIN_PLACEMENTS ? u[3]! : 0;
  look.strength = byte255(u[4]!);
  look.speed = byte255(u[5]!);
  look.scale = byte255(u[6]!);
  look.rim = byte255(u[7]!);
  look.sparkle = byte255(u[8]!);
  look.depth = byte255(u[9]!);
  look.seed = byte255(u[10]!);
  look.dir = byte255(u[11]!);
  look.color = { hue: u[12]! % 3600, sat: byte255(u[13]!), light: byte255(u[14]!), dye: byte255(u[15]!) };
  look.accent = [byte255(u[16]!), byte255(u[17]!), byte255(u[18]!)];
  return { slot: n[0]!, item: u[0]!, look };
}

/** Reads one line into `o`. False is the C++ skipping it. */
function readLine(o: Outfit, line: string): boolean {
  let r = sscanf(line, "slot %d %u");
  if (r.count === 2) {
    const [slot, v] = r.values as number[];
    if (slot! < 0 || slot! >= SLOT_COUNT) return false;
    o.item[slot!] = v!;
    o.managed[slot!] = true;
    return true;
  }
  r = sscanf(line, "display %u %d");
  if (r.count >= 1) {
    o.display = r.values[0] as number;
    // The C++ normalizes old profiles the same way: creature morphs belong in the world.
    o.displayNative = false;
    return true;
  }
  r = sscanf(line, "mountfly %u");
  if (r.count === 1) { o.mountFly = r.values[0] as number; return true; }
  r = sscanf(line, "mount %u");
  if (r.count === 1) { o.mount = r.values[0] as number; return true; }
  r = sscanf(line, "mounthidden %d");
  if (r.count === 1) { o.mountHidden = r.values[0] !== 0; return true; }
  r = sscanf(line, "glowok %d");
  if (r.count === 1) { o.glowKnown = r.values[0] !== 0; return true; }
  r = sscanf(line, "glow %d %u %d %d %x");
  if (r.count === 5) {
    const [slot, id, managed, tint, colour] = r.values as number[];
    if (slot! < 0 || slot! >= 2) return false;
    o.enchant[slot!] = { id: id!, managed: managed !== 0, tint: tint !== 0, colour: colour! & 0xffffff };
    return true;
  }
  r = sscanf(line, "sheathe %d %u");
  if (r.count === 2) {
    const [slot, v] = r.values as number[];
    if (slot! < 0 || slot! >= 2 || v! >= SHEATHE_POSITIONS) return false;
    o.sheathe[slot!] = v!;
    return true;
  }
  r = sscanf(line, "scale %f");
  if (r.count === 1) { o.scale = r.values[0] as number; return true; }
  r = sscanf(line, "wcolok %d");
  if (r.count === 1) { o.wtintKnown = r.values[0] !== 0; return true; }
  r = sscanf(line, "gcolok %d");
  if (r.count === 1) { o.gtintKnown = r.values[0] !== 0; return true; }
  if (line.startsWith("wcol ")) {
    r = sscanf(line, "wcol %d %u %u %u %u %u");
    const [slot, item, hue, sat, light, dye] = r.values as number[];
    if (r.count !== 6 || slot! < 0 || slot! >= COLOUR_SLOTS || !item) return false;
    o.wtint[slot!] = { item: item!, look: { hue: hue! % 3600, sat: byte255(sat!), light: byte255(light!), dye: byte255(dye!) } };
    if (slot! < 3) o.wtintKnown = true;
    else o.gtintKnown = true;
    return true;
  }
  r = sscanf(line, "skinok %d");
  if (r.count === 1) { o.skinKnown = r.values[0] !== 0; return true; }
  if (line.startsWith("skin ")) {
    const p = parseSkinLine(line, "skin");
    if (!p || p.slot < 0 || p.slot >= SKIN_SLOTS || p.look.preset >= SKIN_PRESETS) return false;
    o.skin[p.slot] = p.look;
    o.skinOn = true;
    o.skinKnown = true;
    return true;
  }
  r = sscanf(line, "mskinok %d");
  if (r.count === 1) { o.mskinKnown = r.values[0] !== 0; return true; }
  if (line.startsWith("mskin ")) {
    const p = parseSkinLine(line, "mskin");
    if (!p || p.slot < 0 || p.slot >= MOUNT_SLOTS || p.look.preset >= SKIN_PRESETS) return false;
    o.mskin[p.slot] = p.look;
    o.mskinKnown = true;
    return true;
  }
  r = sscanf(line, "mcolok %d");
  if (r.count === 1) { o.mtintKnown = r.values[0] !== 0; return true; }
  if (line.startsWith("mcol ")) {
    r = sscanf(line, "mcol %d %u %u %u %u %u");
    const [slot, disp, hue, sat, light, dye] = r.values as number[];
    if (r.count !== 6 || slot! < 0 || slot! >= MOUNT_SLOTS || !disp) return false;
    o.mtint[slot!] = { item: disp!, look: { hue: hue! % 3600, sat: byte255(sat!), light: byte255(light!), dye: byte255(dye!) } };
    o.mtintKnown = true;
    return true;
  }
  r = sscanf(line, "cosok %d");
  if (r.count === 1) { o.cosmeticsKnown = r.values[0] !== 0; return true; }
  if (line.startsWith("cosm ")) {
    r = sscanf(line, "cosm %u %d %f %f %f %f %f %f %f %d %u %f %f %f %f %f %f %f %u");
    const v = r.values as number[];
    const finite = (i: number) => Number.isFinite(v[i]);
    if (r.count !== 19 || !v[0] || o.cosmetic.length >= MAX_COSMETICS || !finite(2) || !(v[2]! > 0) || v[10]! >= COSMETIC_MODES || v[18]! > 1) return false;
    if (![3, 4, 5, 6, 7, 8].every(finite)) return false;
    o.cosmetic.push({
      target: v[0]!, catalog: v[1] !== 0, scale: v[2]!,
      offset: [v[3]!, v[4]!, v[5]!], turn: [v[6]!, v[7]!, v[8]!],
      coloured: v[9] !== 0,
      colour: { mode: v[10]!, hue: v[11]!, saturation: v[12]!, intensity: v[13]!, whiteCore: v[14]!, windowHue: v[15]!, window: v[16]!, feather: v[17]! },
      scope: v[18]!,
    });
    o.cosmeticsKnown = true;
    return true;
  }
  r = sscanf(line, "ccolok %d");
  if (r.count === 1) { o.colorsKnown = r.values[0] !== 0; return true; }
  r = sscanf(line, "ccol %d %x");
  if (r.count === 2) {
    const [slot, v] = r.values as number[];
    if (slot! < 0 || slot! >= AXIS_COUNT) return false;
    o.colors.on[slot!] = true;
    o.colors.rgb[slot!] = v! & 0xffffff;
    o.colorsKnown = true;
    return true;
  }
  if (line.startsWith("rlook ")) {
    o.rlookKept = line.split("\0", 1)[0]!;
    return true;
  }
  r = sscanf(line, "look %u %u %u %u %u %u %u");
  if (r.count === 7) {
    const [race, gender, skin, face, hs, hc, fh] = r.values as number[];
    o.look = {
      managed: true, race: race! & 0xff, gender: gender ? 1 : 0, skin: skin! & 0xff, face: face! & 0xff,
      hairStyle: hs! & 0xff, hairColour: hc! & 0xff, facialHair: fh! & 0xff,
    };
    o.rlookKept = "";
    return true;
  }
  return false;
}

/** mo::Deserialize. Never fails, as the C++ never does: what it can't read, it keeps aside. */
export function deserialize(text: string): Outfit {
  const o = newOutfit();
  let after: string | null = null;
  let i = 0;
  while (i < text.length) {
    let e = text.indexOf("\n", i);
    if (e < 0) e = text.length;
    let line = text.slice(i, e);
    i = e + 1;
    let end = line.length;
    while (end > 0 && (line[end - 1] === "\r" || line[end - 1] === " ")) end--;
    line = line.slice(0, end);
    if (!line || line[0] === "#") continue;
    if (!readLine(o, line)) o.extra.push({ after, line });
    after = line;
  }
  mountTintsFollowSlots(o);
  return o;
}

/** Serialize's order, for placing a kept line whose neighbour has gone. */
const KEY_ORDER = [
  "slot", "display", "mount", "mountfly", "mounthidden", "sheathe", "glowok", "glow", "scale", "look", "rlook",
  "ccolok", "ccol", "wcolok", "gcolok", "wcol", "skinok", "skin", "mskinok", "mskin", "mcolok", "mcol", "cosok", "cosm",
];
const rankOf = (line: string) => {
  const k = KEY_ORDER.indexOf(line.split(" ", 1)[0]!);
  return k < 0 ? KEY_ORDER.length : k;
};

/** serialize(), with the lines this build could not read back where they were. */
export function writeBack(o: Outfit): string {
  const base = serialize(o);
  if (!o.extra.length) return base;
  const lines = base ? base.slice(0, -1).split("\n") : [];
  let from = 0;
  for (const { after, line } of o.extra) {
    let at: number;
    if (after === null) at = 0;
    else {
      const found = lines.indexOf(after, from);
      if (found >= 0) at = found + 1;
      else {
        // Its neighbour was edited away: go after the last line that sorts before it.
        const rank = rankOf(after);
        at = from;
        for (let k = from; k < lines.length; k++) if (rankOf(lines[k]!) <= rank) at = k + 1;
      }
    }
    lines.splice(at, 0, line);
    from = at + 1;
  }
  return `${lines.join("\n")}\n`;
}
