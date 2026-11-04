import { existsSync, readFileSync } from "node:fs";
import type { Catalog } from "@eclipse/format";
import { describe, expect, it } from "vitest";
import { type LookOption, defaultLook } from "../src/chr/look";
import { byId, groupBy, parseCsv } from "../src/db2/db2";
import { SITE_CATALOG } from "../src/lib/env";
import { parseArgs } from "../src/cli";
import { shardOf } from "../src/commands/scope";

describe("CSV", () => {
  it("handles quotes, commas, doubled quotes and newlines in a field", () => {
    const rows = parseCsv('ID,Name_lang,Note\n1,"Human, male","says ""hi""\nand more"\n2,Orc,\n');
    expect(rows).toEqual([
      { ID: "1", Name_lang: "Human, male", Note: 'says "hi"\nand more' },
      { ID: "2", Name_lang: "Orc", Note: "" },
    ]);
  });
  it("strips a BOM and tolerates CRLF", () => {
    expect(parseCsv("﻿A,B\r\n1,2\r\n")).toEqual([{ A: "1", B: "2" }]);
  });
  it("groups and indexes", () => {
    const rows = parseCsv("ID,R\n1,a\n2,a\n3,b\n");
    expect(groupBy(rows, "R").get("a")!.length).toBe(2);
    expect(byId(rows).get("3")!.R).toBe("b");
  });
});

const choice = (id: number, elems: LookOption["choices"][number]["elems"], extra: Partial<LookOption["choices"][number]> = {}) => ({
  id,
  name: "",
  order: id,
  flags: 0,
  reqType: 3,
  classMask: -1,
  elems,
  ...extra,
});
const option = (id: number, choices: LookOption["choices"], gated = false): LookOption => ({ id, name: "", order: id, gated, choices });
const geo = (group: number, value: number, cond = 0) => ({ kind: "geo" as const, group, value, cond });
const mat = (target: number, fdid: number, cond = 0) => ({ kind: "mat" as const, target, fdid, emissive: 0, cond });

describe("default look", () => {
  const have = new Set([0, 3, 401, 402, 501, 702, 703, 1301, 2001, 2201, 3202, 3203, 3301, 3401, 5101]);

  it("takes the first choice, or the one flagged default", () => {
    const look = defaultLook([option(1, [choice(1, [geo(7, 2)]), choice(2, [geo(7, 3)])]), option(2, [choice(3, [geo(32, 2)]), choice(4, [geo(32, 3)], { flags: 0x10 })])], have);
    expect(look.geosets.has(702)).toBe(true);
    expect(look.geosets.has(3203)).toBe(true);
    expect(look.geosets.has(3202)).toBe(false);
  });

  it("gives groups nobody decides retail's equipped default", () => {
    const look = defaultLook([], have);
    // Hands 401, feet 501, trousers 1301, feet 2001, 2201, eyes 3301, glint 5101, all retail's -2 value.
    for (const id of [0, 401, 501, 702, 1301, 2001, 2201, 3202, 3301, 3401, 5101]) expect(look.geosets.has(id), `geoset ${id}`).toBe(true);
    expect(look.geosets.has(402)).toBe(false);
  });

  it("a value of 0 hides the group, and hair ids are bare", () => {
    const look = defaultLook([option(1, [choice(1, [geo(34, 0)])]), option(2, [choice(2, [geo(0, 3)])])], have);
    expect(look.geosets.has(3401)).toBe(false);
    expect(look.geosets.has(0)).toBe(true);
    expect(look.geosets.has(3)).toBe(true);
  });

  it("drops what the model doesn't have", () => {
    expect(defaultLook([option(1, [choice(1, [geo(7, 9)])])], have).geosets.has(709)).toBe(false);
  });

  it("leaves a gated option unset", () => {
    const look = defaultLook([option(1, [choice(1, [mat(25, 111)])], true)], have);
    expect(look.mats.size).toBe(0);
    expect(look.chosen.size).toBe(0);
  });

  it("gives a choice whose art needs a gated option that option's first art as a base", () => {
    const gate = option(1, [choice(10, []), choice(11, [])], true);
    const colour = option(2, [choice(20, [mat(25, 500, 11), mat(25, 501, 10)])]);
    const look = defaultLook([gate, colour], have);
    expect(look.mats.get(25)?.fdid).toBe(501);
  });

  it("applies elements only when their related choice is worn", () => {
    const look = defaultLook([option(1, [choice(1, [])]), option(2, [choice(2, [mat(5, 900, 99), mat(5, 901, 1)])])], have);
    expect(look.mats.get(5)?.fdid).toBe(901);
  });

  it("a later option's material replaces an earlier one's", () => {
    const look = defaultLook([option(1, [choice(1, [mat(5, 1)])]), option(2, [choice(2, [mat(5, 2)])])], have);
    expect(look.mats.get(5)?.fdid).toBe(2);
  });

  it("passes over a choice locked to other classes", () => {
    const look = defaultLook([option(1, [choice(1, [mat(5, 1)], { classMask: 32 }), choice(2, [mat(5, 2)])])], have);
    expect(look.mats.get(5)?.fdid).toBe(2);
  });

  it("says what it could not apply", () => {
    const look = defaultLook([option(1, [choice(1, [{ kind: "bone", cond: 0, raw: 5 }])])], have);
    expect(look.warnings.join()).toMatch(/bone/);
  });
});

describe("CLI", () => {
  it("reads the workflow's command lines", () => {
    const a = parseArgs(["plan", "--scope", "human-male", "--shards", "4", "--force", "--github-output", "/tmp/o"]);
    expect(a.command).toBe("plan");
    expect(a.flags.get("scope")).toBe("human-male");
    expect(a.flags.get("shards")).toBe("4");
    expect(a.flags.has("force")).toBe(true);
    expect(a.flags.get("github-output")).toBe("/tmp/o");
    expect(parseArgs(["report", "--upload", "--github-summary", "f"]).flags.has("upload")).toBe(true);
  });
  it("complains about a flag with no value", () => {
    expect(() => parseArgs(["run", "--scope"])).toThrow(/needs a value/);
  });
  it("splits a scope into stable shards", () => {
    const n = 4;
    const seen = Array.from({ length: 57 }, (_v, i) => shardOf(i, n));
    expect(new Set(seen).size).toBe(4);
    expect(seen.filter((s) => s === 0).length).toBe(15);
  });
});

describe.skipIf(!existsSync(SITE_CATALOG))("the committed catalogue snapshot", () => {
  const catalog = (existsSync(SITE_CATALOG) ? JSON.parse(readFileSync(SITE_CATALOG, "utf8")) : { races: [] }) as Catalog;

  it("lists all 28 races and 57 bodies", () => {
    expect(catalog.races.length).toBe(28);
    expect(catalog.races.flatMap((r) => r.bodies).length).toBe(57);
    const ids = catalog.races.flatMap((r) => r.bodies.map((b) => b.id));
    expect(new Set(ids).size).toBe(57);
    expect(ids).toContain("human-male");
    expect(ids).toContain("human-female");
    expect(ids).toContain("orcupright-male");
    expect(ids).toContain("dracthyr-male");
    expect(ids).not.toContain("dracthyr-female");
  });

  it("gives every race an icon and marks only what is baked", () => {
    for (const r of catalog.races) {
      expect(r.circle).toMatch(/^objects\/[0-9a-f]{32}\.webp$/);
      for (const b of r.bodies) expect(b.circle).toMatch(/\.webp$/);
    }
    const human = catalog.races.find((r) => r.id === "human")!;
    expect(human.faction).toBe("Alliance");
    expect(catalog.races.find((r) => r.id === "orc")!.faction).toBe("Horde");
    expect(catalog.races.find((r) => r.id === "pandaren")!.faction).toBe("Neutral");
    expect(catalog.races.find((r) => r.id === "voidelf")!.group).toBe("Allied");
  });
});
