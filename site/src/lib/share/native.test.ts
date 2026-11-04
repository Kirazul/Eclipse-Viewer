/**
 * The port against the real C++, live: mo::Serialize, mo::Deserialize, share::Encode,
 * share::Decode and races::Deserialize, compiled from Eclipse's sources by golden/build.py.
 * Skipped, and says so, on a machine without the compiled harness; code.test.ts still
 * runs there against the fixture the same C++ wrote.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLASSIC_FALLBACK, composeOutfit } from "./bridge";
import { base64Decode, base64Encode, decode, encode, looksLikeCode } from "./code";
import { dump } from "./dump";
import {
  AXIS_COUNT, COLOUR_SLOTS, COSMETIC_MODES, MAX_COSMETICS, MOUNT_SLOTS, SHEATHE_POSITIONS, SKIN_PALETTES, SKIN_PLACEMENTS, SKIN_PRESETS, SKIN_SLOTS, SLOT_COUNT,
  deserialize, newOutfit, serialize,
} from "./outfit";

const dir = fileURLToPath(new URL("../../../../work/share-harness/", import.meta.url));
const exe = `${dir}share_harness.exe`;
const have = existsSync(exe);
if (!have) console.warn(`[share] ${exe} is not built: native.test.ts is skipped. Run python site/src/lib/share/golden/build.py`);

function runOn(bin: string, args: string[]): string[] {
  const r = spawnSync(bin, args, { encoding: "latin1", maxBuffer: 1 << 27 });
  if (r.status) throw new Error(r.stderr || `exit ${r.status}`);
  return r.stdout.trim().split(/\r?\n/);
}
const run = (args: string[]) => runOn(exe, args);
/** The harness as built before the classic fallback: the old parser, for the proof it still reads new codes. */
const oldExe = `${dir}share_harness_old.exe`;
const haveOld = existsSync(oldExe);
const runOld = (args: string[]) => runOn(oldExe, args);
const toHex = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => h.replace(/../g, (b) => String.fromCharCode(parseInt(b, 16)));
function withFile<T>(name: string, lines: string[], go: (path: string) => T): T {
  mkdirSync(dir, { recursive: true });
  const path = `${dir}${name}`;
  writeFileSync(path, `${lines.join("\n")}\n`, "latin1");
  return go(path);
}

/** A small seeded generator, so a failure names a run that can be repeated. */
function rng(seed: number) {
  let x = seed >>> 0;
  return (n: number) => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return Math.floor((x / 2 ** 32) * n);
  };
}

const HOSTILE = [
  "", "\n", "#comment\nslot 0 1\n", "slot 0 1\r\nslot 2 3 \r\n", "slot0 1\nslot 2 3 4\n", "slot 99 5\nslot -1 5\n", "slot 0 -1\nslot 1 99999999999\nslot 2 18446744073709551616\n",
  "slot 3 0\n", "slot x 1\nslot 1\nslot\n", "SLOT 1 2\n", "  slot 1 2\n", "slot\t1\t2\n", "slot 1 +7\nslot 2 0x10\n",
  "display 5\n", "display 5 1\n", "display 5 x\n", "display x\n", "display 0 1\n", "display -5\n",
  "mount 5\nmountfly 6\nmounthidden 1\n", "mountfly 0\nmount 0\n", "mount5\nmountfly6\n", "mounthidden 0\nmounthidden 2\nmounthidden x\n", "mounth 1\nmountfl 2\n",
  "sheathe 0 1\nsheathe 1 3\n", "sheathe 0 4\nsheathe 2 1\nsheathe -1 1\n", "sheathe 0 -1\n",
  "glowok 1\n", "glowok 0\n", "glowok x\n", "glow 0 3789 1 1 FF00FF\n", "glow 1 0 0 0 0\n", "glow 2 1 1 1 1\n", "glow 0 1 1 1 ffffffffff\n", "glow 0 1 1 1 0xABC\n", "glow 0 1 5 -3 12\n", "glow 0 1 1 1\n", "glow0 1 1 1 7\n",
  "scale 1\n", "scale 1.5\n", "scale 0\n", "scale -1\n", "scale .5\n", "scale 5.\n", "scale 1e2\n", "scale 1E-2\n", "scale 1d2\n", "scale 1e\n", "scale 1e+\n", "scale inf\n", "scale INF\n", "scale infinity\n", "scale nan\n", "scale 1e50\n", "scale 1e-50\n", "scale 0x10\n", "scale 0x1p3\n", "scale 0x1.8p1\n", "scale +2\n", "scale x\n", "scale\n", "scale 0.03125\n", "scale 0.09375\n", "scale 16777217\n", "scale 16777219\n", "scale 16777217.0000000001\n", "scale 1.00000005960464477539\n", "scale 1.00000005960464477540\n", "scale 340282346638528859811704183484516925440\n", "scale 340282366920938463463374607431768211456\n", "scale 0.000000000000000000000000000000000000000000001\n", "scale 0.0000000000000000000000000000000000000000000007\n",
  "look 4 1 3 5 2 7 1\n", "look 4 1 3 5 2 7\n", "look 300 2 300 300 300 300 300\n", "look -1 -1 -1 -1 -1 -1 -1\n", "look4 1 3 5 2 7 1\n",
  "rlook pandaren f 1:2\n", "rlook x\n", "rlook \n", "rlook\n", "look 1 0 0 0 0 0 0\nrlook human m 1:2\n", "rlook human m 1:2\nlook 1 0 0 0 0 0 0\n", "rlook a m\nrlook b f\n",
  "ccolok 1\n", "ccolok 0\n", "ccol 0 FF00FF\n", "ccol 4 abc\n", "ccol 5 abc\n", "ccol -1 abc\n", "ccol 0 0xFFFFFFFFF\n", "ccol 1\n", "ccolok\n",
  "wcolok 1\n", "gcolok 1\nwcolok 0\n", "wcol 0 5 3600 256 300 999\n", "wcol 3 5 7 8 9 10\n", "wcol 14 5 1 1 1 1\n", "wcol -1 5 1 1 1 1\n", "wcol 0 0 1 1 1 1\n", "wcol 0 5 1 1 1\n", "wcol x\n", "wcolx 0 5 1 1 1 1\n", "wcol 2 4294967295 4294967295 1 1 1\n",
  "skinok 1\n", "skinok 0\n", "skin 3 900 5 1 2 10 20 30 40 50 60 70 80 90 100 110 120 1 2 3\n", "skin 14 1 0 0 0 128 128 128 128 128 128 0 0 0 255 128 0 255 255 255\n", "skin 15 1 0 0 0 128 128 128 128 128 128 0 0 0 255 128 0 255 255 255\n", "skin 3 900 264 1 2 10 20 30 40 50 60 70 80 90 100 110 120 1 2 3\n", "skin 3 900 263 9 9 300 300 300 300 300 300 300 300 7200 300 300 300 300 300 300\n", "skin 3 0 5 1 2 10 20 30 40 50 60 70 80 90 100 110 120 1 2 3\n", "skin 3 900 5 1 2 10\n", "skin 3 900 65536 1 2 10 20 30 40 50 60 70 80 90 100 110 120 1 2 3\n", "skinx 3 900\n",
  "mskinok 1\n", "mskin 0 1 5 1 2 10 20 30 40 50 60 70 80 90 100 110 120 1 2 3\n", "mount 7\nmskin 0 1 5 1 2 10 20 30 40 50 60 70 80 90 100 110 120 1 2 3\n", "mskin 0 1 5 1 2 10 20 30 40 50 60 70 80 90 100 110 120 1 2 3\nmount 7\n", "mount 7\nmskin 0 7 5 1 2 10 20 30 40 50 60 70 80 90 100 110 120 1 2 3\n", "mount 7\nmskin 0 8 5 1 2 10 20 30 40 50 60 70 80 90 100 110 120 1 2 3\n", "mskin 2 1 5 1 2 10 20 30 40 50 60 70 80 90 100 110 120 1 2 3\n",
  "mcolok 1\n", "mount 7\nmcol 0 7 3601 256 2 3\n", "mount 7\nmcol 0 8 1 2 3 4\n", "mountfly 7\nmcol 1 7 1 2 3 4\n", "mcol 0 7 1 2 3 4\n", "mcol 2 7 1 2 3 4\n", "mcol 0 0 1 2 3 4\n",
  "cosok 1\n", "cosm 5 1 2 0.1 0.2 0.3 1 2 3 1 1 90 1 1 0.5 0 0 20 1\n", "cosm 0 1 2 0.1 0.2 0.3 1 2 3 1 1 90 1 1 0.5 0 0 20 1\n", "cosm 5 1 0 0.1 0.2 0.3 1 2 3 1 1 90 1 1 0.5 0 0 20 1\n", "cosm 5 1 -1 0.1 0.2 0.3 1 2 3 1 1 90 1 1 0.5 0 0 20 1\n", "cosm 5 1 inf 0.1 0.2 0.3 1 2 3 1 1 90 1 1 0.5 0 0 20 1\n", "cosm 5 1 2 inf 0.2 0.3 1 2 3 1 1 90 1 1 0.5 0 0 20 1\n", "cosm 5 1 2 0.1 0.2 0.3 1 2 nan 1 1 90 1 1 0.5 0 0 20 1\n", "cosm 5 1 2 0.1 0.2 0.3 1 2 3 1 2 90 1 1 0.5 0 0 20 1\n", "cosm 5 1 2 0.1 0.2 0.3 1 2 3 1 1 90 1 1 0.5 0 0 20 2\n", "cosm 5 1 2 0.1 0.2 0.3 1 2 3 1 1 inf 1 1 0.5 0 0 20 1\n", "cosm 5 1 2 0.1 0.2 0.3 1 2 3 1 1 nan 1 1 0.5 0 0 20 1\n", "cosm 5 1 2 0.1 0.2 0.3 1 2 3 1 1 90 1 1\n", `cosm 5 1 1e38 1e38 1e38 1e38 1e38 1e38 1e38 1 1 1e38 1e38 1e38 1e38 1e38 1e38 1e38 1\nslot 0 1\n`,
  Array.from({ length: 20 }, (_, i) => `cosm ${i + 1} 0 1 0 0 0 0 0 0 0 0 1 1 1 1 1 1 1 0\n`).join(""),
  "whatever\nfuture 1 2 3\n", "glowing 1\n", "mountain 3\n", "scaled 2\n", "slots 1 2\n", "skins 1\n", "looks 1\n", "lookat 1 2 3 4 5 6 7\n",
  "slot 0 1\0slot 1 2\nslot 2 3\n", "\0slot 0 1\n", "slot 0 1\xFF\n", "\xFF\xFE\n",
];

/** Random lines of every key, with extreme and normal numbers. Display ids stay under the portable tag. */
function fuzz(seed: number, count: number): string[] {
  const r = rng(seed);
  const u32 = () => (r(3) ? r(100000) + 1 : r(4294967295) + 1);
  const small = (n: number) => r(n);
  const disp = () => r(0x3fffffff) + 1;
  const byte = () => (r(5) ? r(256) : r(1000));
  const float = () => {
    const k = r(8);
    if (k === 0) return "0";
    if (k === 1) return `${r(100)}.${r(10000)}`;
    if (k === 2) return `-${r(100)}.${r(1000)}`;
    if (k === 3) return `${r(1000)}e${r(9) - 4}`;
    if (k === 4) return String(r(2 ** 31));
    if (k === 5) return `${r(16777216)}.5`;
    if (k === 6) return `0.${"0".repeat(r(6))}${r(1000)}`;
    return `${(r(4096) * 2 + 1)}e-3`;
  };
  const makers: (() => string)[] = [
    () => `slot ${small(22) - 1} ${u32()}`,
    () => `display ${disp()} ${small(2)}`,
    () => `mount ${disp()}`,
    () => `mountfly ${disp()}`,
    () => `mounthidden ${small(3)}`,
    () => `sheathe ${small(3)} ${small(6)}`,
    () => `glowok ${small(2)}`,
    () => `glow ${small(3)} ${u32()} ${small(2)} ${small(2)} ${(r(4294967295)).toString(16)}`,
    () => `scale ${float()}`,
    () => `look ${byte()} ${byte()} ${byte()} ${byte()} ${byte()} ${byte()} ${byte()}`,
    () => `rlook ${["human", "pandaren", "orcupright"][small(3)]} ${"mf"[small(2)]} ${r(100)}:${r(100000)}`,
    () => `ccolok ${small(2)}`,
    () => `ccol ${small(7)} ${(r(4294967295)).toString(16)}`,
    () => `wcolok ${small(2)}`,
    () => `gcolok ${small(2)}`,
    () => `wcol ${small(16)} ${u32()} ${r(8000)} ${byte()} ${byte()} ${byte()}`,
    () => `skinok ${small(2)}`,
    () => `skin ${small(17)} ${u32()} ${r(300)} ${small(5)} ${small(7)} ${Array.from({ length: 8 }, byte).join(" ")} ${r(8000)} ${byte()} ${byte()} ${byte()} ${byte()} ${byte()} ${byte()}`,
    () => `mskinok ${small(2)}`,
    () => `mskin ${small(3)} ${[1, disp()][small(2)]} ${r(300)} ${small(5)} ${small(7)} ${Array.from({ length: 8 }, byte).join(" ")} ${r(8000)} ${byte()} ${byte()} ${byte()} ${byte()} ${byte()} ${byte()}`,
    () => `mcolok ${small(2)}`,
    () => `mcol ${small(3)} ${disp()} ${r(8000)} ${byte()} ${byte()} ${byte()}`,
    () => `cosok ${small(2)}`,
    () => `cosm ${u32()} ${small(2)} ${float()} ${float()} ${float()} ${float()} ${float()} ${float()} ${float()} ${small(2)} ${small(3)} ${float()} ${float()} ${float()} ${float()} ${float()} ${float()} ${float()} ${small(3)}`,
  ];
  return Array.from({ length: count }, () => {
    let text = "";
    for (let n = 1 + r(14); n > 0; n--) text += `${makers[r(makers.length)]!()}\n`;
    return text;
  });
}

/** The manifest's races beyond the five the retail tests pick by hand, in the order they are written. */
const OTHER_KEYS = [
  "dwarf", "nightelf", "undead", "tauren", "gnome", "troll", "goblin", "bloodelf", "draenei", "worgen", "gilnean", "nightborne", "highmountain", "voidelf",
  "lightforged", "zandalari", "kultiran", "darkiron", "vulpera", "maghar", "mechagnome", "visage", "earthen", "haranir", "magharupright",
];
/** Index in the manifest: HarnessPack gives races local ids from 64 in this order. */
const RACE_ORDER = ["human", "pandaren", "dracthyr", "orc", "orcupright", ...OTHER_KEYS];

/** A short manifest in the format races_pack.py writes, for races::ParseManifest. */
function manifest(): string {
  const L = ["eclipse-races 2"];
  const race = (key: string, canon: number, prefix: string, name: string) => L.push(`race ${key} ${canon} ${prefix} ${name}`, `raceinfo ${key} ${canon} 1 0 0 Hu`);
  race("human", 64, "EcHu", "Human");
  race("pandaren", 120, "EcPa", "Pandaren");
  race("dracthyr", 86, "EcDt", "Dracthyr");
  race("orc", 65, "EcOr", "Orc");
  race("orcupright", 90, "EcOu", "Orc_Upright");
  OTHER_KEYS.forEach((key, i) => race(key, 130 + i, `Ec${key.slice(0, 2)}`, key));
  L.push("raceposture orcupright orc 1", "raceposture magharupright maghar 2");
  const opts = (first: number, n: number, choices = 3) => {
    for (let o = 0; o < n; o++) {
      L.push(`opt ${first + o} 1 none Option_${o}`);
      for (let c = 0; c < choices; c++) L.push(`ch ${(first + o) * 100 + c} 3 0 0 0 Choice_${c}`);
    }
  };
  let index = 0;
  const body = (key: string, sex: string, path: string, go: () => void) => {
    L.push(`body ${key} ${sex} ${index++} 1 1 1 1 0 ${path}`, "layer 1 0 0 0 256 256 0", "lookfile skin a.blp");
    go();
  };
  body("human", "m", "character\\human\\male\\humanmale.m2", () => opts(101, 3));
  body("human", "f", "character\\human\\female\\humanfemale.m2", () => opts(201, 3));
  body("pandaren", "m", "character\\pandaren\\male\\pandarenmale.m2", () => opts(601, 2));
  body("pandaren", "f", "character\\pandaren\\female\\pandarenfemale.m2", () => opts(301, 12));
  body("dracthyr", "m", "character\\dracthyr\\male\\dracthyrmale.m2", () => opts(401, 45));
  body("orc", "m", "character\\orc\\male\\orcmale.m2", () => opts(501, 2));
  body("orc", "f", "character\\orc\\female\\orcfemale.m2", () => opts(551, 2));
  body("orcupright", "m", "character\\orc\\male\\orcupright.m2", () => opts(501, 2));
  // Every other key of races_manifest.py, so the fallback table meets the real reader whole.
  OTHER_KEYS.forEach((key, i) => {
    body(key, "m", `character\\${key}\\male\\${key}male.m2`, () => opts(1000 + i * 10, 2));
    if (!key.endsWith("upright")) body(key, "f", `character\\${key}\\female\\${key}female.m2`, () => opts(2000 + i * 10, 2));
  });
  L.push("end");
  return `${L.join("\n")}\n`;
}

const choices = (first: number, n: number, pick: (o: number) => number) => Array.from({ length: n }, (_, o) => ` ${first + o}:${(first + o) * 100 + pick(o)}`).join("");

describe.skipIf(!have)("against the real C++", () => {
  it("the constants the port names are the DLL's", () => {
    const info = JSON.parse(run(["info"])[0]!);
    expect(info).toEqual({
      slotCount: SLOT_COUNT, colourSlots: COLOUR_SLOTS, skinSlots: SKIN_SLOTS, mountSlots: MOUNT_SLOTS, axes: AXIS_COUNT, presets: SKIN_PRESETS,
      palettes: SKIN_PALETTES, placements: SKIN_PLACEMENTS, cosmeticModes: COSMETIC_MODES, maxCosmetics: MAX_COSMETICS, sheathePositions: SHEATHE_POSITIONS, anyRide: 1, hidden: 0,
    });
  });

  it("the hostile lines read and write the same, byte and field", () => {
    const texts = HOSTILE;
    const out = withFile("texts-hostile.txt", texts.map(toHex), (p) => run(["texts", p]));
    expect(out.length).toBe(texts.length);
    const wrong: unknown[] = [];
    texts.forEach((text, i) => {
      const r = JSON.parse(out[i]!);
      const o = deserialize(text);
      const ser = serialize(o);
      if (ser !== fromHex(r.ser) || JSON.stringify(dump(o)) !== JSON.stringify(r.fields)) {
        wrong.push({ text, cpp: fromHex(r.ser), ts: ser, fieldsMatch: JSON.stringify(dump(o)) === JSON.stringify(r.fields) });
      }
    });
    expect(wrong).toEqual([]);
  });

  it("5000 random outfits read and write the same", () => {
    const texts = fuzz(20261104, 5000);
    const out = withFile("texts-fuzz.txt", texts.map(toHex), (p) => run(["texts", p]));
    expect(out.length).toBe(texts.length);
    const wrong: unknown[] = [];
    texts.forEach((text, i) => {
      const r = JSON.parse(out[i]!);
      const o = deserialize(text);
      const ser = serialize(o);
      if ((ser !== fromHex(r.ser) || JSON.stringify(dump(o)) !== JSON.stringify(r.fields)) && wrong.length < 5) {
        wrong.push({ text, cpp: fromHex(r.ser), ts: ser, fieldsMatch: JSON.stringify(dump(o)) === JSON.stringify(r.fields) });
      }
    });
    expect(wrong).toEqual([]);
  }, 120_000);

  it("the paste rules decode the same", () => {
    const good = "ECA1:c2xvdCAwIDEK";
    const pastes = [
      good, good.toLowerCase().slice(0, 5) + good.slice(5), `  ${good}  `, `\n\t${good}\r\n`, `ECA1:c2xv\ndCAw\r\nIDEK`, `ECA1:c2xv dCAw IDEK`, good.slice(5), `${good}~labels~picture`, `${good}~`,
      "ECA1:", "ECA1:~x", "~", "", " ", "ECA", "ECA1", "ECA1:!", "ECA1:c2xv$dCAw", "ECA1:c2xvdCAwIDE", "ECA1:c2xvdCAwIDEK==", "ECA1:c2xvdCAwIDEK=junk", "ECA1:=", "ECA1:A", "ECA1:AA", "RHP1:abc", "x ECA1:c2xvdCAwIDEK", "ECA1:\xFFabc", "ECA1:c2xvdCAwIDEK\x7F",
    ];
    const out = withFile("pastes.txt", pastes.map(toHex), (p) => run(["pastes", p]));
    // A blank line reads as a blank paste on both sides.
    expect(out.length).toBe(pastes.length);
    const seen = pastes.map((text) => {
      const o = decode(text);
      return { text, looks: looksLikeCode(text), ok: !!o, ser: o ? serialize(o) : "" };
    });
    const real = out.map((l, i) => {
      const r = JSON.parse(l);
      return { text: pastes[i]!, looks: r.looks, ok: r.ok, ser: fromHex(r.ser) };
    });
    expect(seen).toEqual(real);
  });

  it("the DLL takes every code the site writes, and writes back the identical string", () => {
    // Outfits made by the site's own writer, not by C++: every field, then a run of random ones.
    const made: string[] = [];
    const o = newOutfit();
    o.managed[0] = true; o.item[0] = 231001;
    o.managed[3] = true; o.item[3] = 0;
    o.managed[15] = true; o.item[15] = 49623;
    o.mount = 25159; o.mountFly = 31992;
    o.sheathe = [2, 3];
    o.glowKnown = true; o.enchant[0] = { id: 3789, colour: 0x00ff7f, managed: true, tint: true };
    o.scale = Math.fround(1.15);
    o.colorsKnown = true; o.colors.on[1] = true; o.colors.rgb[1] = 0xabcdef;
    o.wtintKnown = true; o.gtintKnown = true;
    o.wtint[0] = { item: 49623, look: { hue: 3599, sat: 200, light: 100, dye: 3 } };
    made.push(encode(o));
    o.look = { managed: true, race: 4, gender: 1, skin: 3, face: 5, hairStyle: 2, hairColour: 7, facialHair: 1 };
    made.push(encode(o));
    for (const text of fuzz(77, 2000)) {
      // A written code is canonical once its quirks settle (a scale that prints as
      // 0.0000 is refused on the way back in): re-read what it wrote until it stands.
      let t = text;
      for (let n = 0; n < 4; n++) t = serialize(deserialize(t));
      const settled = deserialize(t);
      expect(settled.extra).toEqual([]);
      made.push(encode(settled));
    }
    const lines = made.filter((c) => decode(c));
    const out = withFile("check.txt", lines, (p) => run(["check", p]));
    expect(out.length).toBe(lines.length);
    const wrong: unknown[] = [];
    out.forEach((l, i) => {
      const r = JSON.parse(l);
      const fields = JSON.stringify(dump(decode(lines[i]!)!)) === JSON.stringify(r.fields);
      if ((!r.decodes || !r.roundtrips || !r.looks || !fields || !r.identical) && wrong.length < 5) wrong.push({ code: lines[i], r });
    });
    expect(wrong).toEqual([]);
    expect(lines.length).toBeGreaterThan(1500);
  }, 120_000);

  describe("a retail look, with the race pack read (races.cpp's own parser and Settle)", () => {
    const code = (line: string) => `ECA1:${base64Encode(`${line}\n`)}`;
    const pack = () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}pack.txt`, manifest(), "latin1");
      return `${dir}pack.txt`;
    };
    const check = (lines: string[]) => withFile("check-pack.txt", lines.map(code), (p) => run(["--pack", pack(), "check", p]).map((l) => JSON.parse(l)));

    const classicLine = (key: string, sex: "m" | "f") => `look ${CLASSIC_FALLBACK[key]} ${sex === "f" ? 1 : 0} 0 0 0 0 0`;
    const textOf = (c: string) => base64Decode(c.slice(5))!;
    const human = `rlook human m${choices(101, 3, (o) => o)}`;
    const dragon = `rlook dracthyr m${choices(401, 45, (o) => (o * 7) % 3)}`;

    it("every choice travels: the look comes back byte for byte, its classic line first", () => {
      const looks: [string, "m" | "f", string][] = [
        ["human", "m", human],
        ["human", "f", `rlook human f${choices(201, 3, () => 2)}`],
        ["pandaren", "f", `rlook pandaren f${choices(301, 12, (o) => o % 3)}`],
        ["dracthyr", "m", dragon],
        ["orc", "m", `rlook orc m${choices(501, 2, (o) => o)}`],
      ];
      expect(dragon.length).toBeGreaterThan(320);
      const lines = looks.map(([k, s, line]) => `${classicLine(k, s)}\n${line}`);
      const r = check(lines);
      for (const x of r) {
        expect(x.decodes).toBe(true);
        expect(x.identical).toBe(true);
        expect(x.roundtrips).toBe(true);
      }
      for (const line of lines) expect(encode(decode(code(line))!)).toBe(code(line));
    });
    it("an old code with the retail line alone wears the same; the next save carries its fallback", () => {
      const [r] = check([human]);
      expect(r.fields.look[0]).toBe(1);
      expect(r.fields.look[1]).toBe(64);
      expect(r.again).toBe(code(`${classicLine("human", "m")}\n${human}`));
    });
    it("a bare race and sex is the body's first look", () => {
      const [r] = check(["rlook human m"]);
      expect(r.decodes).toBe(true);
      expect(r.again).toBe(code(`${classicLine("human", "m")}\nrlook human m${choices(101, 3, () => 0)}`));
    });
    it("a choice the body lacks falls to the option's first, the rest stand", () => {
      const [r] = check(["rlook human m 101:999 102:10201"]);
      expect(r.again).toBe(code(`${classicLine("human", "m")}\nrlook human m 101:10100 102:10201 103:10300`));
    });
    it("a body the race doesn't have is refused by the DLL, so the site never writes one", () => {
      const [r] = check(["rlook dracthyr f 401:40101"]);
      expect(r.decodes).toBe(true);
      expect(r.fields.look[0]).toBe(0);
      expect(r.fields.rlookKept).toBe("rlook dracthyr f 401:40101");
    });
    it("a race the client doesn't know is kept, not lost and not worn", () => {
      const [r] = check(["rlook futurerace m 1:2"]);
      expect(r.decodes).toBe(true);
      expect(r.identical).toBe(true);
      expect(r.fields.look[0]).toBe(0);
    });
    it("a classic look is untouched, with the pack and without", () => {
      const line = "look 4 1 3 5 2 7 1";
      const [a] = check([line]);
      const [b] = withFile("classic.txt", [code(line)], (p) => run(["check", p]).map((l) => JSON.parse(l)));
      for (const r of [a, b]) {
        expect(r.identical).toBe(true);
        expect(r.fields.look).toEqual([1, 4, 1, 3, 5, 2, 7, 1]);
      }
    });

    describe("a code holding both: the classic fallback, then the retail line", () => {
      const bodies = RACE_ORDER.flatMap((key) => (key === "dracthyr" || key.endsWith("upright") ? [[key, "male"]] : [[key, "male"], [key, "female"]])) as [string, "male" | "female"][];
      const written = bodies.map(([key, sex]) => {
        const { outfit } = composeOutfit(null, { body: `${key}-${sex}`, worn: {}, choices: null, mount: 0, mountFly: 0 }, { entryOf: () => undefined });
        const s = sex === "female" ? "f" as const : "m" as const;
        return { key, sex: s, code: encode(outfit), classic: CLASSIC_FALLBACK[key]!, line: `rlook ${key} ${s}` };
      });
      const codes = written.map((w) => w.code);
      const noPack = (name: string, lines: string[], bin = run) => withFile(name, lines, (p) => bin(["check", p]).map((l) => JSON.parse(l)));
      const withPack = (name: string, lines: string[], bin = run) => withFile(name, lines, (p) => bin(["--pack", pack(), "check", p]).map((l) => JSON.parse(l)));

      it("the site writes exactly look, then rlook, for all 30 races", () => {
        expect(RACE_ORDER.length).toBe(30);
        expect(written.length).toBe(57);
        for (const w of written) expect(textOf(w.code)).toBe(`${classicLine(w.key, w.sex)}\n${w.line}\n`);
      });
      it("pack present: the retail look wins, and what it writes carries the fallback", () => {
        const out = withPack("both-pack.txt", codes);
        written.forEach((w, i) => {
          const r = out[i];
          expect(r.decodes, w.line).toBe(true);
          expect(r.fields.look[0], w.line).toBe(1);
          expect(r.fields.look[1], w.line).toBe(64 + RACE_ORDER.indexOf(w.key));
          expect(r.fields.look[2], w.line).toBe(w.sex === "f" ? 1 : 0);
          expect(r.fields.rlookKept, w.line).toBe("");
          expect(textOf(r.again).startsWith(`${classicLine(w.key, w.sex)}\n${w.line} `), w.line).toBe(true);
        });
      });
      it("pack absent: the classic look is worn, the retail line kept, and a save writes both", () => {
        const out = noPack("both-nopack.txt", codes);
        written.forEach((w, i) => {
          const r = out[i];
          expect(r.decodes, w.line).toBe(true);
          expect(r.fields.look, w.line).toEqual([1, w.classic, w.sex === "f" ? 1 : 0, 0, 0, 0, 0, 0]);
          expect(r.fields.rlookKept, w.line).toBe(w.line);
          expect(r.identical, w.line).toBe(true);
          // The port reads it the same, field for field.
          expect(JSON.stringify(dump(decode(w.code)!)), w.line).toBe(JSON.stringify(r.fields));
        });
      });
      it("saved and reloaded without the pack, then the pack installed: the retail look is back, whole", () => {
        const looks = [`${classicLine("human", "m")}\n${human}`, `${classicLine("dracthyr", "m")}\n${dragon}`].map(code);
        const saved = noPack("life-1.txt", looks);
        const reloaded = noPack("life-2.txt", saved.map((r) => r.again));
        reloaded.forEach((r, i) => {
          expect(r.again).toBe(looks[i]);
          expect(r.fields.look[0]).toBe(1);
          expect(r.fields.look[1]).toBe(i === 0 ? 1 : 10);
        });
        const installed = withPack("life-3.txt", reloaded.map((r) => r.again));
        installed.forEach((r, i) => {
          expect(r.fields.look[1]).toBe(64 + (i === 0 ? 0 : RACE_ORDER.indexOf("dracthyr")));
          expect(r.fields.rlookKept).toBe("");
          expect(r.again).toBe(looks[i]);
        });
      });
      it("the old parser reads the new codes: pack present retail, pack absent classic", () => {
        // share_harness_old.exe: built from the sources before this change, kept in work/.
        if (!haveOld) return;
        const written_ = withPack("new-writer.txt", codes).map((r) => r.again as string);
        const absent = noPack("old-nopack.txt", written_, runOld);
        const present = withPack("old-pack.txt", written_, runOld);
        written.forEach((w, i) => {
          expect(absent[i].decodes, w.line).toBe(true);
          expect(absent[i].fields.look, w.line).toEqual([1, w.classic, w.sex === "f" ? 1 : 0, 0, 0, 0, 0, 0]);
          expect(present[i].fields.look[1], w.line).toBe(64 + RACE_ORDER.indexOf(w.key));
        });
      });
      it("the new reader takes every code the old writer wrote, the same way", () => {
        const old = JSON.parse(readFileSync(new URL("./golden/old-format.json", import.meta.url), "utf8")) as { name: string; code: string; again: string; fields: unknown }[];
        const out = noPack("old-format.txt", old.map((g) => g.code));
        old.forEach((g, i) => {
          expect(JSON.stringify(out[i].fields), g.name).toBe(JSON.stringify(g.fields));
          expect(out[i].again, g.name).toBe(g.again);
        });
        // ...and their old strings with a ~ section after the outfit.
        const pasted = withFile("old-pastes.txt", old.map((g) => toHex(`${g.code}~head|Helm~iVBORw0KGgo=`)), (p) => run(["pastes", p]));
        old.forEach((g, i) => {
          const r = JSON.parse(pasted[i]!);
          expect(r.ok, g.name).toBe(true);
          expect(fromHex(r.ser), g.name).toBe(textOf(g.again));
        });
        // With the pack, an old retail code's next save gains the fallback, and nothing else moves.
        const retail = old.find((g) => g.name === "retail body, kept")!;
        const [p] = withPack("old-retail.txt", [retail.code]);
        expect(p.fields.look[1]).toBe(64 + RACE_ORDER.indexOf("pandaren"));
        expect(textOf(p.again).startsWith(`${classicLine("pandaren", "f")}\nrlook pandaren f `)).toBe(true);
      });
      it("pack present but a race it doesn't ship: the classic look stands, the line stays", () => {
        const c = code("look 4 1 0 0 0 0 0\nrlook futurerace f 1:2");
        const [r] = check(["look 4 1 0 0 0 0 0\nrlook futurerace f 1:2"]);
        expect(r.fields.look).toEqual([1, 4, 1, 0, 0, 0, 0, 0]);
        expect(r.fields.rlookKept).toBe("rlook futurerace f 1:2");
        expect(r.again).toBe(c);
        expect(encode(decode(c)!)).toBe(c);
      });
      it("the order matters: rlook before look loses the retail line on every client", () => {
        const reversed = "rlook human m 101:10100\nlook 4 1 0 0 0 0 0";
        const [with_] = check([reversed]);
        expect(with_.fields.look).toEqual([1, 4, 1, 0, 0, 0, 0, 0]);
        const [without] = noPack("both-rev.txt", [code(reversed)]);
        expect(without.fields.look).toEqual([1, 4, 1, 0, 0, 0, 0, 0]);
        expect(without.fields.rlookKept).toBe("");
      });
      it("no way of choosing a look leaves a stale retail line over it", () => {
        const steps = run(["stale"]).map((l) => JSON.parse(l)) as { step: string; faulted: boolean; text: string }[];
        const after = (step: string) => steps.find((s) => s.step === step)!;
        const both = "look 1 1 0 0 0 0 0\nrlook pandaren f 1:2\n";
        expect(after("worn").text).toContain(both);
        // A managed pick reads client memory in Sanitise before the line that clears; no client here.
        expect(after("another look chosen").faulted).toBe(true);
        expect(after("the look taken off").faulted).toBe(false);
        expect(after("the look taken off").text).not.toContain("look ");
        expect(after("a classic loadout applied").text).toContain("look 4 0 0 0 0 0 0\n");
        expect(after("a classic loadout applied").text).not.toContain("rlook");
        expect(after("reset everything").text).toBe("");
        // Seated, the look is set aside and still written; a look chosen there replaces it.
        expect(after("in the barber's chair").text).toContain(both);
        expect(after("the look taken off in the chair").faulted).toBe(false);
        expect(after("the look taken off in the chair").text).not.toContain("rlook");
      });
      it("the table is the one the DLL compiled", () => {
        expect(JSON.parse(run(["fallback"])[0]!)).toEqual(CLASSIC_FALLBACK);
      });
    });

    it("a look wears the same with items around it", () => {
      const text = `slot 0 5\n${classicLine("human", "f")}\nrlook human f${choices(201, 3, () => 1)}\n`;
      const c = `ECA1:${base64Encode(text)}`;
      const [r] = withFile("check-pack2.txt", [c], (p) => run(["--pack", pack(), "check", p]).map((l) => JSON.parse(l)));
      expect(r.identical).toBe(true);
      expect(encode(decode(c)!)).toBe(c);
    });
  });
});
