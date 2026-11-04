/**
 * The owner's rule: a code made in game, imported on the site and exported again comes
 * back byte-identical, with everything the site can't show or edit still in it.
 * Run over every code the real C++ wrote (golden/), through the same steps the page takes.
 */
import { readFileSync } from "node:fs";
import type { SlotId } from "@eclipse/format";
import { describe, expect, it } from "vitest";
import {
  CLASSIC_FALLBACK, MORPH_SLOT, bodyOf, classicFallback, composeOutfit, importName, keptInCode, loadoutSummary, parseRlook, rlookLine, splitBody, urlQueryOfCode, urlToOutfit, wornFromCode, type Loaded, type Lookup, type SiteState,
} from "./bridge";
import { base64Decode, base64Encode, decode, encode } from "./code";
import { cloneOutfit, newOutfit, serialize, writeBack } from "./outfit";
import { cleanName, hasLook, removeLook, renameLook, saveLook } from "./library";

const here = new URL("./golden/", import.meta.url);
const golden = JSON.parse(readFileSync(new URL("fields.json", here), "utf8")) as { name: string; code: string; text: string }[];

/** A catalogue that knows some items of a slot and not others. */
const knownEntry = (slot: SlotId, entry: number) => (entry % 2 ? `item-${slot}-${entry}` : undefined);
const lookup: Lookup = { entryOf: (id) => Number(id.split("-").at(-1)) || undefined };
const hasBody = (id: string) => /^(human|orc|nightelf|draenei|pandaren)-(male|female)$/.test(id) || id === "dracthyr-male";

/** What the page does on Import: read it, dress the figure, remember both. */
function load(code: string, startBody = "human-male", startChoices: SiteState["choices"] = null): Loaded {
  const outfit = decode(code)!;
  const fromCode = wornFromCode(outfit, knownEntry);
  const b = bodyOf(outfit, hasBody);
  return {
    outfit,
    at: { body: b?.body ?? startBody, worn: fromCode.worn, choices: b?.choices ?? startChoices, mount: outfit.mount, mountFly: outfit.mountFly },
  };
}
const exportOf = (l: Loaded, site: SiteState = l.at) => encode(composeOutfit(l, site, lookup).outfit);
const textOf = (code: string) => base64Decode(code.slice(5))!;

describe("in game -> site -> in game, byte for byte", () => {
  for (const g of golden) {
    it(g.name, () => {
      expect(exportOf(load(g.code))).toBe(g.code);
    });
    it(`${g.name}: on another body, with a look already on`, () => {
      expect(exportOf(load(g.code, "pandaren-female", { 1: 2 }))).toBe(g.code);
    });
    it(`${g.name}: read a second time, saved and read back`, () => {
      const once = exportOf(load(g.code));
      expect(exportOf(load(once))).toBe(g.code);
    });
  }

  it("a code from a newer build, with keys and looks this one has never seen", () => {
    const text = "slot 0 5\nfuture 1 2\nskin 3 900 9999 0 0 128 128 128 128 128 128 0 0 0 255 128 0 255 255 255\nmount 7\nspells 9 9\n";
    const code = `ECA1:${base64Encode(text)}`;
    expect(exportOf(load(code))).toBe(code);
  });
});

describe("an edit changes what was edited and nothing else", () => {
  const everything = golden.find((g) => g.name === "everything at once")!;

  it("a slot: its line moves, every other field stands", () => {
    const l = load(everything.code);
    const after = textOf(exportOf(l, { ...l.at, worn: { ...l.at.worn, head: "item-head-99" } }));
    expect(after).toBe(everything.text.replace("slot 0 11", "slot 0 99"));
  });
  it("taking a piece off leaves the slot to the wearer's gear", () => {
    const l = load(everything.code);
    const worn = { ...l.at.worn };
    delete worn.head;
    expect(textOf(exportOf(l, { ...l.at, worn }))).toBe(everything.text.replace("slot 0 11\n", ""));
  });
  it("another body: the body line moves, the glows, colours, skins and cosmetics stand", () => {
    const l = load(everything.code);
    const after = textOf(exportOf(l, { ...l.at, body: "pandaren-female", choices: { 7: 70 } }));
    // Pandaren falls back to Human, the code's own human female bytes standing.
    expect(after).toBe(everything.text.replace("look 1 1 1 2 3 4 5\n", "look 1 1 1 2 3 4 5\nrlook pandaren f 7:70\n"));
  });
  it("a mount picked on the Mounts page: that slot moves, the other and every colour line stand", () => {
    const text = "mount 25159\nmountfly 31992\nmcolok 1\nmcol 1 31992 300 255 40 255\n";
    const l = load(`ECA1:${base64Encode(text)}`);
    expect(textOf(exportOf(l, { ...l.at, mount: 500 }))).toBe(text.replace("mount 25159", "mount 500"));
  });
  it("a slot the catalogue can't name, or a hidden one, stays while the rest changes", () => {
    const text = "slot 0 4\nslot 2 0\nslot 4 5\n"; // 4 unknown to this catalogue, 0 hidden, 5 known
    const l = load(`ECA1:${base64Encode(text)}`);
    expect(l.at.worn).toEqual({ chest: "item-chest-5" });
    expect(textOf(exportOf(l, { ...l.at, worn: { chest: "item-chest-7" } }))).toBe("slot 0 4\nslot 2 0\nslot 4 7\n");
  });
  it("the same colour line survives when its piece stays", () => {
    const text = "slot 15 7\nwcolok 1\nwcol 0 7 100 200 128 9\n";
    const l = load(`ECA1:${base64Encode(text)}`);
    expect(textOf(exportOf(l, { ...l.at, worn: { ...l.at.worn, head: "item-head-3" } }))).toBe("slot 0 3\nslot 15 7\nwcolok 1\nwcol 0 7 100 200 128 9\n");
  });
});

describe("a look built on the site", () => {
  const site = (over: Partial<SiteState> = {}): SiteState => ({ body: "nightelf-female", worn: {}, choices: null, mount: 0, mountFly: 0, ...over });

  it("items by entry, in slot order; the body as a retail line with every choice", () => {
    const { outfit, notExportable } = composeOutfit(null, site({ worn: { mainhand: "item-a-49623", head: "item-b-231001" }, choices: { 11: 46, 12: 62 } }), lookup);
    expect(notExportable).toEqual([]);
    expect(writeBack(outfit)).toBe("slot 0 231001\nslot 15 49623\nlook 4 1 0 0 0 0 0\nrlook nightelf f 11:46 12:62\n");
  });
  it("the game's morph slot numbers", () => {
    const worn: SiteState["worn"] = {};
    for (const slot of Object.keys(MORPH_SLOT) as SlotId[]) worn[slot] = `item-${slot}-${MORPH_SLOT[slot] + 100}`;
    const { outfit } = composeOutfit(null, site({ worn }), lookup);
    for (const slot of Object.keys(MORPH_SLOT) as SlotId[]) {
      expect(outfit.managed[MORPH_SLOT[slot]]).toBe(true);
      expect(outfit.item[MORPH_SLOT[slot]]).toBe(MORPH_SLOT[slot] + 100);
    }
    expect(MORPH_SLOT).toEqual({ head: 0, shoulder: 2, shirt: 3, chest: 4, waist: 5, legs: 6, feet: 7, wrist: 8, hands: 9, back: 14, mainhand: 15, offhand: 16, ranged: 17, tabard: 18 });
  });
  it("an item with no entry stays out, and says so", () => {
    const { outfit, notExportable } = composeOutfit(null, site({ worn: { head: "item-x-0", chest: "item-y-9" } }), { entryOf: (id) => (id === "item-y-9" ? 9 : undefined) });
    expect(notExportable).toEqual(["head"]);
    expect(writeBack(outfit)).toBe("slot 4 9\nlook 4 1 0 0 0 0 0\nrlook nightelf f\n");
  });
  it("gated choices are the DLL's own ids: GATED_NONE | option, as races_spec writes them", () => {
    const line = rlookLine("worgen-male", { 4100: 0x7f000000 | 4100, 13: 2500 }, [13, 4100]);
    expect(line).toBe(`rlook worgen m 13:2500 4100:${0x7f000000 | 4100}`);
    expect(parseRlook(line!)).toEqual({ key: "worgen", sex: "m", choices: { 13: 2500, 4100: 0x7f000000 | 4100 } });
  });
  it("the options go in the body's order when it is known, then any others", () => {
    expect(rlookLine("human-male", { 1: 10, 2: 20, 3: 30 }, [3, 1])).toBe("rlook human m 3:30 1:10 2:20");
  });
  it("a posture body has its own key", () => {
    expect(splitBody("orcupright-male")).toEqual({ key: "orcupright", sex: "m" });
    expect(rlookLine("orcupright-male", null)).toBe("rlook orcupright m");
    expect(rlookLine("not a body", null)).toBeNull();
  });
});

describe("reading the body out of a code", () => {
  const withLook = (line: string) => decode(`ECA1:${base64Encode(`${line}\n`)}`)!;

  it("a classic line: the race's retail body, its bytes kept for the way back", () => {
    expect(bodyOf(withLook("look 4 1 3 5 2 7 1"), hasBody)).toEqual({ body: "nightelf-female", choices: null, race: "nightelf", sex: "f" });
  });
  it("a retail line: key, sex and every choice", () => {
    expect(bodyOf(withLook("rlook pandaren f 1:2 3:4"), hasBody)).toEqual({ body: "pandaren-female", choices: { 1: 2, 3: 4 }, race: "pandaren", sex: "f" });
  });
  it("a single-model race's female is its male, as races::Settle has it", () => {
    expect(bodyOf(withLook("rlook dracthyr f 1:2"), hasBody)!.body).toBe("dracthyr-male");
  });
  it("a body the site doesn't have stands aside, and the code keeps it", () => {
    const o = withLook("rlook futurerace m 1:2");
    expect(bodyOf(o, hasBody)!.body).toBeNull();
    expect(keptInCode(o, 0, false, 0).parts).toEqual(["a body not on the site"]);
    const c = encode(o);
    expect(c).toBe(`ECA1:${base64Encode("rlook futurerace m 1:2\n")}`);
  });
  it("no body line: no opinion", () => {
    expect(bodyOf(withLook("slot 0 1"), hasBody)).toBeNull();
  });
});

describe("no race pack: the closest classic body stands under the retail line", () => {
  const both = "slot 0 7\nlook 4 1 0 0 0 0 0\nrlook nightelf f 11:46 12:62\n";
  const code = `ECA1:${base64Encode(both)}`;

  it("a code holding both comes back byte for byte, untouched", () => {
    expect(exportOf(load(code))).toBe(code);
  });
  it("and through an edit, nothing lost", () => {
    const l = load(code);
    expect(textOf(exportOf(l, { ...l.at, worn: { head: "item-head-9" } }))).toBe(both.replace("slot 0 7", "slot 0 9"));
  });
  it("the site shows the retail body, and counts nothing extra", () => {
    const o = decode(code)!;
    expect(bodyOf(o, hasBody)).toEqual({ body: "nightelf-female", choices: { 11: 46, 12: 62 }, race: "nightelf", sex: "f" });
    expect(keptInCode(o, 0, true, 0).count).toBe(0);
  });
  it("a body the site can't draw falls to the classic one it holds", () => {
    const o = decode(`ECA1:${base64Encode("look 4 1 0 0 0 0 0\nrlook futurerace f 1:2\n")}`)!;
    expect(bodyOf(o, hasBody)!.body).toBe("nightelf-female");
  });
  it("a game code with only rlook: untouched stays as it came, an edit adds the fallback", () => {
    const only = `ECA1:${base64Encode("slot 0 7\nrlook pandaren m 1:2\n")}`;
    const l = load(only);
    expect(exportOf(l)).toBe(only);
    expect(textOf(exportOf(l, { ...l.at, worn: { head: "item-head-9" } }))).toBe("slot 0 9\nlook 1 0 0 0 0 0 0\nrlook pandaren m 1:2\n");
    expect(textOf(exportOf(l, { ...l.at, mount: 5 }))).toBe("slot 0 7\nmount 5\nlook 1 0 0 0 0 0 0\nrlook pandaren m 1:2\n");
    expect(textOf(exportOf(l, { ...l.at, choices: { 1: 3 } }))).toBe("slot 0 7\nlook 1 0 0 0 0 0 0\nrlook pandaren m 1:3\n");
  });
  it("a body edit moves both lines; a choice on the same body keeps classic bytes already chosen", () => {
    const l = load(code);
    expect(textOf(exportOf(l, { ...l.at, body: "orcupright-male", choices: null }))).toBe("slot 0 7\nlook 2 0 0 0 0 0 0\nrlook orcupright m\n");
    const old = load(`ECA1:${base64Encode("look 4 1 3 5 2 7 1\n")}`);
    expect(textOf(exportOf(old, { ...old.at, choices: { 1: 2 } }))).toBe("look 4 1 3 5 2 7 1\n");
    const known = { ...old, at: { ...old.at, choices: { 1: 1 } } };
    expect(textOf(exportOf(known, { ...known.at, choices: { 1: 2 } }))).toBe("look 4 1 3 5 2 7 1\nrlook nightelf f 1:2\n");
  });
  it("a code with no body line stays without one through an edit: no race forced on the wearer", () => {
    const l = load(`ECA1:${base64Encode("slot 0 7\n")}`, "pandaren-female", { 1: 2 });
    expect(textOf(exportOf(l, { ...l.at, worn: { head: "item-head-9" } }))).toBe("slot 0 9\n");
  });
  it("a race with no fallback writes the retail line alone, and the old look gives way", () => {
    const l = load(`ECA1:${base64Encode("look 4 1 3 5 2 7 1\n")}`);
    expect(textOf(exportOf(l, { ...l.at, body: "futurerace-male", choices: null }))).toBe("rlook futurerace m\n");
  });
  it("the table, as the owner asked, over every key of races_manifest.py", () => {
    const keys = ["human", "orc", "dwarf", "nightelf", "undead", "tauren", "gnome", "troll", "goblin", "bloodelf", "draenei", "worgen", "gilnean", "pandaren", "nightborne", "highmountain", "voidelf", "lightforged", "zandalari", "kultiran", "darkiron", "vulpera", "maghar", "mechagnome", "dracthyr", "visage", "earthen", "haranir", "orcupright", "magharupright"];
    expect(Object.keys(CLASSIC_FALLBACK).sort()).toEqual([...keys].sort());
    const races: Record<number, string[]> = {};
    for (const [k, r] of Object.entries(CLASSIC_FALLBACK)) (races[r] ??= []).push(k);
    expect(Object.keys(races).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 11]);
    expect(races[1]!.sort()).toEqual(["gilnean", "human", "kultiran", "pandaren", "worgen"]);
    expect(races[2]!.sort()).toEqual(["maghar", "magharupright", "orc", "orcupright"]);
    expect(races[7]!.sort()).toEqual(["gnome", "goblin", "mechagnome", "vulpera"]);
    expect(races[10]!.sort()).toEqual(["bloodelf", "dracthyr", "visage", "voidelf"]);
    expect(classicFallback("voidelf", "f")).toEqual({ managed: true, race: 10, gender: 1, skin: 0, face: 0, hairStyle: 0, hairColour: 0, facialHair: 0 });
    expect(classicFallback("futurerace", "m")).toBeNull();
  });
});

describe("the small count, and the game's summary words", () => {
  it("counts what the site can't draw", () => {
    const everything = decode(golden.find((g) => g.name === "everything at once")!.code)!;
    const k = keptInCode(everything, 1, true, 0);
    expect(k.parts).toEqual([
      "1 item", "a creature morph", "2 mounts", "mount hidden", "2 sheathe positions", "1 weapon glow", "scale", "1 body colour", "2 slot colours", "2 skins", "1 mount colour", "1 cosmetic", "classic face and hair",
    ]);
    expect(k.count).toBe(1 + 1 + 2 + 1 + 2 + 1 + 1 + 1 + 2 + 2 + 1 + 1 + 1);
  });
  it("nothing to keep is nothing", () => {
    expect(keptInCode(decode(golden[0]!.code)!, 0, true, 0).count).toBe(0);
  });
  it("LoadoutSummary's exact words", () => {
    const o = newOutfit();
    expect(loadoutSummary(o)).toBe("Empty loadout");
    o.managed[0] = true;
    expect(loadoutSummary(o)).toBe("1 piece");
    o.managed[2] = true;
    o.mount = 5;
    o.glowKnown = true;
    o.enchant[0].managed = true;
    o.skinOn = true;
    o.rlookKept = "rlook human m";
    expect(loadoutSummary(o)).toBe("2 pieces  /  mount  /  glows  /  skins  /  race");
  });
});

describe("a look URL and a code, both ways", () => {
  it("a look URL gives the code", () => {
    const q = "body=human-male&look=head:item-a-231001,chest:item-b-5&choices=11.46,12.62&tab=loadout";
    const r = urlToOutfit(q, lookup, decode)!;
    expect(writeBack(r.outfit)).toBe("slot 0 231001\nslot 4 5\nlook 1 0 0 0 0 0 0\nrlook human m 11:46 12:62\n");
  });
  it("a code gives a URL that gives the same code back, whatever it holds", () => {
    for (const g of golden) {
      const l = load(g.code);
      const kept = keptInCode(l.outfit, wornFromCode(l.outfit, knownEntry).unknown.length, true, 0);
      const q = urlQueryOfCode(g.code, l.at, kept);
      if (q.includes("code=")) expect(encode(urlToOutfit(q, lookup, decode)!.outfit)).toBe(g.code);
    }
  });
  it("a code holding only what a URL says needs no code in it", () => {
    const code = `ECA1:${base64Encode("slot 0 7\n")}`;
    const l = load(code);
    const q = urlQueryOfCode(code, l.at, keptInCode(l.outfit, 0, true, 0));
    expect(q).toBe("body=human-male&look=head:item-head-7");
    expect(encode(urlToOutfit(q, lookup, decode)!.outfit)).toBe(`ECA1:${base64Encode("slot 0 7\nlook 1 0 0 0 0 0 0\nrlook human m\n")}`);
  });
  it("a raw + in a pasted link still reads", () => {
    const code = `ECA1:${base64Encode("wcol 0 5 ~~~ \n")}`;
    const plus = "ECA1:" + "Pz8/Pz8+Pj4+Pgo=";
    expect(urlToOutfit(`code=${plus}`, lookup, decode)).not.toBeNull();
    expect(code.length).toBeGreaterThan(5);
  });
});

describe("Import's filing", () => {
  it("an identical loadout's own name, else Imported, Imported 2 ...", () => {
    expect(importName([])).toBe("Imported");
    expect(importName([{ name: "Mine", same: true }])).toBe("Mine");
    expect(importName([{ name: "imported", same: false }])).toBe("Imported 2");
    expect(importName([{ name: "Imported", same: false }, { name: "Imported 2", same: false }])).toBe("Imported 3");
  });
});

describe("the library", () => {
  const row = (name: string, code = "c", cover = "") => ({ name, code, cover });
  it("names clean as mo::OutfitKey cleans them", () => {
    expect(cleanName("  my [best] look\n ")).toBe("my best look");
    expect(cleanName(" ] [ ")).toBe("");
  });
  it("save, replace in place, keep a chosen picture, rename, remove", () => {
    let l = saveLook([], row("A", "1", "pic"));
    l = saveLook(l, row("B", "2"));
    l = saveLook(l, row("a", "3"));
    expect(l).toEqual([row("A", "3", "pic"), row("B", "2")]);
    expect(hasLook(l, "b")).toBe(true);
    l = renameLook(l, "B", "C");
    expect(l.map((x) => x.name)).toEqual(["A", "C"]);
    expect(removeLook(l, "a").map((x) => x.name)).toEqual(["C"]);
  });
  it("a code in the library is the code, untouched", () => {
    const g = golden[golden.length - 1]!;
    const l = saveLook([], row("Mine", exportOf(load(g.code))));
    expect(l[0]!.code).toBe(g.code);
    expect(cloneOutfit(decode(l[0]!.code)!).rlookKept).toBe(decode(g.code)!.rlookKept);
  });
});
