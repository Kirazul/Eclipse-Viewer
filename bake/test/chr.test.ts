import { existsSync, readFileSync } from "node:fs";
import type { Catalog } from "@eclipse/format";
import { describe, expect, it } from "vitest";
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
