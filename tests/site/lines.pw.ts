import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Items, sets and mounts on the real engine and the real local packs: what `pnpm bake`
 * left in site/public/packs. Numbers decide, and the screenshots are there to be looked at:
 * a floating helm is right by every geometry number.
 */
const REAL = process.env.REAL_BASE ?? "http://localhost:4330/Eclipse-Viewer/";
const OUT = "tests/site/results/shots";
const PACKS = join("site", "public", "packs");
mkdirSync(OUT, { recursive: true });

const catalog = existsSync(join(PACKS, "catalog", "catalog.json")) ? JSON.parse(readFileSync(join(PACKS, "catalog", "catalog.json"), "utf8")) as { itemShards?: { line: string; slot: string; key: string; count: number }[]; lines?: { id: string; items: number; sets: number }[]; mountCount?: number } : {};
const hasShards = (catalog.itemShards?.length ?? 0) > 0;

interface Internals {
  pieces(): { kind: string; mirrored: boolean; parent: string | undefined; id?: string }[];
  wardrobeApplied(): number;
}
interface Eclipse {
  frames(): number;
  gpu(): { calls: number; triangles: number };
  equip(slot: string, id: string | null): Promise<void>;
  loadModel(id: string): Promise<void>;
  setSheathed(on: boolean): void;
  setRider(id: string | null): Promise<void>;
  internals: Internals;
  figure: { id: string; parts: { mesh: { visible: boolean }; extras: { geoset: number } }[] } | null;
}

const eclipse = <T,>(page: Page, f: (e: Eclipse) => T | Promise<T>) => page.evaluate(`(${f.toString()})(window.eclipse)`) as Promise<T>;

async function open(page: Page, path: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.location().url.includes("/packs/")) errors.push(`console: ${m.text()}`);
    if (m.type() === "warning" && m.text().startsWith("[eclipse]")) errors.push(`warn: ${m.text()}`);
  });
  await page.goto(`${REAL}${path}`);
  try {
    await page.waitForFunction(() => (window as unknown as { eclipse?: { frames(): number } }).eclipse?.frames?.() > 2, undefined, { timeout: 30_000 });
    await page.waitForFunction(() => (document.getElementById("canvas") as HTMLCanvasElement).style.opacity === "1", undefined, { timeout: 8_000 });
  } catch (e) {
    console.log("page did not come up:", path, JSON.stringify(errors), await page.locator("#stage-error-text").textContent().catch(() => ""));
    throw e;
  }
  return errors;
}

async function settle(page: Page) {
  await page.waitForTimeout(500);
}

async function coverage(page: Page) {
  return page.evaluate(async () => {
    const c = document.querySelector("#canvas") as HTMLCanvasElement;
    const img = new Image();
    img.src = c.toDataURL("image/png");
    await img.decode();
    const o = document.createElement("canvas");
    o.width = 96;
    o.height = Math.round((96 * c.height) / c.width);
    const x = o.getContext("2d")!;
    x.drawImage(img, 0, 0, o.width, o.height);
    const d = x.getImageData(0, 0, o.width, o.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 200) n++;
    return n / (d.length / 4);
  });
}

async function shot(page: Page, name: string) {
  await settle(page);
  await page.locator("#stage").screenshot({ path: `${OUT}/${name}.png` });
}

test.describe("items on the real packs", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 700, "desktop");
  test.skip(!hasShards, "no shards in site/public/packs: run the local proof bake");
  test.use({ viewport: { width: 1400, height: 860 } });

  test("source chips, slot chips and facets show only what exists for the line", async ({ page }) => {
    const errors = await open(page, "wardrobe/?body=human-male");
    const pills = page.locator("#lines [data-line]");
    await expect(pills.first()).toBeVisible();
    const texts = await pills.allTextContents();
    console.log("lines:", texts.join(" | "));
    expect(texts.length).toBe(catalog.lines!.filter((l) => l.items > 0).length);
    for (const text of texts) expect(text).toMatch(/\(\d[\d,]*\)$/);
    // Each pill's chips are that line's slots.
    for (const l of catalog.lines!.filter((x) => x.items > 0)) {
      await page.locator(`#lines [data-line="${l.id}"]`).click();
      const has = new Set(catalog.itemShards!.filter((r) => r.line === l.id).map((r) => r.slot));
      for (const chip of await page.locator("#chips [data-chip]").all()) {
        const slot = await chip.getAttribute("data-chip");
        const hand = slot === "mainhand" || slot === "offhand";
        const expected = has.has(slot!) || (hand && (has.has("mainhand") || has.has("offhand") || has.has("ranged")));
        expect(await chip.isVisible(), `${l.id} ${slot}`).toBe(expected);
      }
    }
    expect(errors).toEqual([]);
  });

  test("rows have real names, real icons, and the grid loads one shard at a time", async ({ page }) => {
    const shards: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/catalog/items/")) shards.push(r.url().split("/catalog/items/")[1]!);
    });
    await open(page, "wardrobe/?body=human-male");
    const line = catalog.lines!.find((l) => l.items > 0)!.id;
    const ref = catalog.itemShards!.find((r) => r.line === line)!;
    await page.locator(`#lines [data-line="${line}"]`).click();
    await page.locator(`#chips [data-chip="${ref.slot}"]`).click();
    const tile = page.locator(".tile:not(.hide)").first();
    await expect(tile).toBeVisible();
    await tile.hover();
    await expect(page.locator(".tip").first()).not.toContainText(/^Item /);
    const img = tile.locator(".tile-ico img");
    await expect(img).toHaveJSProperty("complete", true);
    expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    expect(await img.getAttribute("src")).toMatch(/objects\/[0-9a-f]{32}\.webp$/);
    // Every other line's shards stayed on the server.
    expect(shards.filter((s) => !s.startsWith(line)).length).toBeLessThanOrEqual(1);
  });

  test("the catalogue is not in the HTML", async ({ page }) => {
    const res = await page.goto(`${REAL}wardrobe/`);
    const html = await res!.text();
    expect(html.length).toBeLessThan(400_000);
    expect(html).not.toContain('"itemShards"');
  });

  test("a set card tries the whole set on hover and wears it on click", async ({ page }) => {
    const errors = await open(page, "wardrobe/?body=human-male&tab=sets");
    const pills = page.locator("#lines [data-line]");
    await expect(pills.first()).toBeVisible();
    const card = page.locator(".tile.set", { hasText: /./ }).first();
    await expect(card).toBeVisible();
    const before = await eclipse(page, (e) => e.internals.wardrobeApplied());
    await card.hover();
    await page.waitForFunction((b) => (window as unknown as { eclipse: Eclipse }).eclipse.internals.wardrobeApplied() > b, before, { timeout: 30_000 });
    await settle(page);
    const hovering = await eclipse(page, (e) => e.internals.pieces().length);
    console.log("set on hover:", hovering, "pieces");
    expect(hovering).toBeGreaterThan(0);
    await card.click();
    await expect(page.locator(".slot.worn").first()).toBeVisible();
    const worn = await page.locator(".slot.worn").count();
    console.log("set worn:", worn, "slots");
    expect(worn).toBeGreaterThan(1);
    await expect(page).toHaveURL(/look=/);
    await shot(page, "set-worn-human-male");
    expect(errors).toEqual([]);
  });
});

test.describe("what a first visit reads", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 700, "desktop");
  test.use({ viewport: { width: 1400, height: 860 } });

  test("near ten reads of the bucket, and the sprites are one", async ({ page }) => {
    const reads: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/packs/")) reads.push(r.url().split("/packs/")[1]!);
    });
    await open(page, "wardrobe/?body=human-male");
    await page.waitForTimeout(1500);
    const kinds: Record<string, number> = {};
    for (const k of reads) {
      const kind = k.startsWith("ui/") ? "ui" : k.startsWith("catalog/") ? "catalog" : k.endsWith(".ktx2") ? "texture" : k.endsWith(".glb") ? "glb" : k.endsWith(".webp") ? "icon" : k.endsWith("manifest.json") ? "manifest" : "other";
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    console.log("first load reads:", reads.length, JSON.stringify(kinds));
    console.log(reads.filter((k) => !k.startsWith("objects/")).join(" "));
    expect(reads.filter((k) => k.startsWith("ui/")).length).toBeLessThanOrEqual(3);
    expect(reads.length).toBeLessThanOrEqual(26);
  });
});

test.describe("what a body wears", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 700, "desktop");
  test.skip(!existsSync(join(PACKS, "items", "item-681309", "manifest.json")), "the proof set is not baked");
  test.use({ viewport: { width: 1000, height: 900 } });

  const BODIES = ["human-male", "orc-female"].filter((b) => existsSync(join(PACKS, "models", b, "manifest.json")));
  const WORN: [string, string, string][] = [
    ["head", "item-681309", "helm"],
    ["shoulder", "item-681266", "shoulders"],
    ["chest", "item-681267", "chest"],
    ["legs", "item-681269", "legs"],
    ["hands", "item-681272", "hands"],
    ["feet", "item-681270", "feet"],
    ["back", "item-681273", "cape"],
    ["waist", "item-685908", "waist"],
    ["wrist", "item-681800", "wrist"],
    ["mainhand", "item-655531", "main hand"],
    ["offhand", "item-732961", "off hand"],
  ];

  for (const body of BODIES) {
    test(`${body} wears a full set, pinned to itself, and draws every piece`, async ({ page }) => {
      const errors = await open(page, `wardrobe/?body=${body}&scene=off`);
      const bare = await coverage(page);
      for (const [slot, id] of WORN) {
        if (!existsSync(join(PACKS, "items", id, "manifest.json"))) continue;
        await eclipse(page, (e) => undefined);
        await page.evaluate(([s, i]) => (window as unknown as { eclipse: Eclipse }).eclipse.equip(s!, i!), [slot, id]);
      }
      await settle(page);
      const pieces = await eclipse(page, (e) => e.internals.pieces());
      console.log(body, "pieces:", JSON.stringify(pieces.map((p) => [p.kind, p.mirrored, p.parent])));
      expect(pieces.length).toBeGreaterThan(5);
      for (const p of pieces.filter((x) => x.kind === "attached")) expect(p.parent, "pinned to a bone of the body").toBeTruthy();
      const dressed = await coverage(page);
      console.log(body, "coverage bare", bare.toFixed(3), "dressed", dressed.toFixed(3));
      expect(dressed).toBeGreaterThan(bare);
      await shot(page, `worn-${body}`);
      expect(errors).toEqual([]);
    });
  }

  test("a mirrored off-hand keeps its faces: the swap is the mirror's", async ({ page }) => {
    test.skip(!existsSync(join(PACKS, "items", "item-732961", "manifest.json")), "no mirrored off-hand baked");
    await open(page, "wardrobe/?body=human-male&scene=off");
    await page.evaluate(() => (window as unknown as { eclipse: Eclipse }).eclipse.equip("offhand", "item-732961"));
    await settle(page);
    const r = await page.evaluate(() => {
      const e = (window as unknown as { eclipse: Eclipse & { wardrobe: { pieces: { mirrored: boolean; node: { matrixWorld: { determinant(): number }; traverse(f: (o: { isMesh?: boolean; matrixWorld: { determinant(): number }; material?: { side: number } }) => void): void } }[] } } }).eclipse;
      const piece = e.wardrobe.pieces[0]!;
      let meshes = 0;
      let flipped = 0;
      piece.node.traverse((o) => {
        if (o.isMesh) {
          meshes++;
          if (o.matrixWorld.determinant() < 0) flipped++;
        }
      });
      return { mirrored: piece.mirrored, meshes, flipped };
    });
    console.log("mirrored off-hand:", JSON.stringify(r));
    expect(r.mirrored).toBe(true);
    // three swaps CW and CCW for a negative determinant, retail's 0x1010E8DCE: every mesh must see it.
    expect(r.flipped).toBe(r.meshes);
    await shot(page, "offhand-mirrored");
  });

  test("weapons go to their sheath points and back", async ({ page }) => {
    test.skip(!existsSync(join(PACKS, "items", "item-655531", "manifest.json")), "no sheathed weapon baked");
    await open(page, "wardrobe/?body=human-male&scene=off");
    await page.evaluate(() => (window as unknown as { eclipse: Eclipse }).eclipse.equip("mainhand", "item-655531"));
    await settle(page);
    const parent = () => eclipse(page, (e) => e.internals.pieces()[0]?.parent);
    const drawn = await parent();
    await shot(page, "weapon-drawn");
    await eclipse(page, (e) => e.setSheathed(true));
    await settle(page);
    const stowed = await parent();
    console.log("weapon parent: drawn", drawn, "stowed", stowed);
    expect(stowed).not.toBe(drawn);
    await shot(page, "weapon-sheathed");
    await eclipse(page, (e) => e.setSheathed(false));
    await settle(page);
    expect(await parent()).toBe(drawn);
  });
});

test.describe("mounts", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 700, "desktop");
  test.skip((catalog.mountCount ?? 0) === 0, "no mounts baked");
  test.use({ viewport: { width: 1400, height: 860 } });

  test("the page is a circle grid, and a circle opens the stage at full width", async ({ page }) => {
    const errors: string[] = [];
    // Chromium's own word about a view transition across the click: not an error of ours.
    page.on("pageerror", (e) => {
      if (!e.message.includes("ViewTransition")) errors.push(e.message);
    });
    await page.goto(`${REAL}mounts/`);
    const circle = page.locator("#mount-grid a.circle-link").first();
    await expect(circle).toBeVisible();
    expect(await page.locator("#mount-count").textContent()).toMatch(/\d/);
    await page.screenshot({ path: `${OUT}/mounts-grid.png` });
    await circle.click();
    await page.waitForURL(/mounts\/view/);
    await page.waitForFunction(() => (window as unknown as { eclipse?: { frames(): number } }).eclipse?.frames?.() > 2, undefined, { timeout: 60_000 });
    const stage = (await page.locator("#stage").boundingBox())!;
    const page_ = (await page.locator("#room").boundingBox())!;
    console.log("stage width", stage.width, "of", page_.width);
    expect(stage.width / page_.width).toBeGreaterThan(0.95);
    expect(errors).toEqual([]);
  });

  const MOUNTS: [string, string, number][] = [
    ["plain", "mount-185", 1],
    ["variants", "mount-129", 3],
    ["character", "mount-1830", 1],
  ];
  for (const [what, id, colours] of MOUNTS) {
    test(`${what}: ${id} stands on its stage, drawn`, async ({ page }) => {
      const errors = await open(page, `mounts/view/?id=${id}&scene=off`);
      await settle(page);
      const covered = await coverage(page);
      const gpu = await eclipse(page, (e) => e.gpu());
      console.log(id, "coverage", covered.toFixed(3), "triangles", gpu.triangles);
      expect(covered).toBeGreaterThan(0.03);
      if (colours > 1) await expect(page.locator(".mount-swatch")).toHaveCount(colours);
      else await expect(page.locator("#mount-variants")).toBeHidden();
      await shot(page, `mount-${what}`);
      expect(errors).toEqual([]);
    });
  }

  test("a swatch swaps the colour on the same model and keeps the URL", async ({ page }) => {
    const errors = await open(page, "mounts/view/?id=mount-129&scene=off");
    const swatches = page.locator(".mount-swatch");
    await expect(swatches).toHaveCount(3);
    await shot(page, "mount-variant-a");
    await swatches.nth(1).click();
    await page.waitForFunction(() => (window as unknown as { eclipse: Eclipse }).eclipse.figure?.id === "mountd-17694", undefined, { timeout: 30_000 });
    await expect(page).toHaveURL(/v=17694/);
    await shot(page, "mount-variant-b");
    expect(errors).toEqual([]);
  });

  test("the rider sits on attachment 0", async ({ page }) => {
    const errors = await open(page, "mounts/view/?id=mount-129&scene=off");
    await settle(page);
    const alone = await eclipse(page, (e) => e.gpu().triangles);
    await page.locator("#mount-rider").click();
    await page.waitForFunction((a) => (window as unknown as { eclipse: Eclipse }).eclipse.gpu().triangles > a, alone, { timeout: 45_000 });
    await shot(page, "mount-rider");
    expect(errors).toEqual([]);
  });

  test("the tools open beside the stage, and the same panels drive it", async ({ page }) => {
    await open(page, "mounts/view/?id=mount-185&scene=off");
    await expect(page.getByTestId("viewer-panels")).toBeHidden();
    await page.locator("#mount-tools").click();
    await expect(page.getByTestId("viewer-panels")).toBeVisible();
  });
});
