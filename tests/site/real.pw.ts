import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { cls, fixtureCatalog, shifts, startCls } from "./helpers";

// The real engine and the real local packs (site/public/packs), when both exist. It
// drives WebGL in Edge; the numbers come from the engine's own window.eclipse.
const REAL = process.env.SWEEP_BASE ?? "http://localhost:4330/Eclipse-Viewer/";
const OUT = "tests/site/results/shots";
mkdirSync(OUT, { recursive: true });

interface EclipseDebug {
  frames(): number;
  lastLoadMs(): number;
  lastLoadBytes(): number;
  gpu(): { geometries: number; textures: number };
}
const dbg = <T,>(page: Page, f: (e: EclipseDebug) => T) => page.evaluate(f as never, undefined) as Promise<T>;
void dbg;

async function open(page: Page, query = "?body=human-male") {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !m.location().url.includes("catalog.json")) errors.push(`console: ${m.text()} @ ${m.location().url}`); });
  await page.goto(`${REAL}wardrobe/${query}`);
  await page.waitForFunction(() => (window as unknown as { eclipse?: { frames(): number } }).eclipse?.frames?.() > 2, undefined, { timeout: 30_000 });
  await page.waitForFunction(() => (document.getElementById("canvas") as HTMLCanvasElement).style.opacity === "1");
  return errors;
}

/** How much of the canvas holds an opaque pixel: the figure, not the page behind it. */
async function coverage(page: Page, selector = "#canvas") {
  return page.evaluate(async (sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement;
    const img = new Image();
    img.src = c.toDataURL("image/png");
    await img.decode();
    const o = document.createElement("canvas");
    o.width = 96; o.height = Math.round(96 * c.height / c.width);
    const x = o.getContext("2d")!;
    x.drawImage(img, 0, 0, o.width, o.height);
    const d = x.getImageData(0, 0, o.width, o.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 200) n++;
    return n / (d.length / 4);
  }, selector);
}

test.describe("with the real engine and packs", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 700, "desktop, one WebGL context is enough");
  test.use({ viewport: { width: 1400, height: 860 } });

  test("Human Male stands on the stage, drawn, with its clips, and no errors", async ({ page }) => {
    await startCls(page);
    const errors = await open(page);
    const covered = await coverage(page);
    console.log("real: canvas coverage", covered.toFixed(3));
    expect(covered).toBeGreaterThan(0.05);
    await expect(page.locator("#strip-name")).not.toHaveText("T-Pose");
    const name = await page.locator("#strip-name").textContent();
    await page.locator("#strip-next").click();
    await expect(page.locator("#strip-name")).not.toHaveText(name!);
    await page.locator("#strip-prev").click();
    await expect(page.locator("#strip-name")).toHaveText(name!);
    await expect(page).toHaveURL(/body=human-male/);
    const s = await page.evaluate(() => {
      const e = (window as unknown as { eclipse: { lastLoadMs(): number; lastLoadBytes(): number; gpu(): unknown; getFrameStats(): unknown } }).eclipse;
      return { ms: e.lastLoadMs(), bytes: e.lastLoadBytes(), gpu: e.gpu() };
    });
    console.log("real: load", JSON.stringify(s));
    expect(await shifts(page)).toEqual([]);
    expect(await cls(page)).toBe(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `${OUT}/r_items.png` });
  });

  test("first frame at Khada's measured line, 0.9 MB/s", async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: 0.9 * 1024 * 1024, uploadThroughput: 0.5 * 1024 * 1024 });
    const started = Date.now();
    await page.goto(`${REAL}wardrobe/?body=human-male`);
    const shell = await page.evaluate(() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? -1);
    await page.waitForFunction(() => (window as unknown as { eclipse?: { frames(): number } }).eclipse?.frames?.() > 0, undefined, { timeout: 30_000 });
    console.log("real: at 0.9 MB/s, gzip as on Pages: first paint", Math.round(shell), "ms, first model frame", Date.now() - started, "ms");
  });

  test("tabs change nothing about the canvas or the figure", async ({ page }) => {
    await startCls(page);
    const errors = await open(page);
    await page.evaluate(() => { (window as unknown as { __c: Element }).__c = document.getElementById("canvas")!; });
    const box = await page.locator("#stage").boundingBox();
    for (const tab of ["sets", "customization", "viewer", "items"]) {
      await page.locator(`[data-tab-btn="${tab}"]`).click();
      await page.waitForTimeout(150);
      expect(await page.locator("#stage").boundingBox()).toEqual(box);
      expect(await page.evaluate(() => (window as unknown as { __c: Element }).__c === document.getElementById("canvas"))).toBe(true);
      expect(await coverage(page)).toBeGreaterThan(0.05);
    }
    expect(await shifts(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("the Viewer tab drives the real engine", async ({ page }) => {
    const errors = await open(page, "?body=human-male&tab=viewer");
    await expect(page.getByTestId("viewer-panels")).toBeVisible();
    await page.locator('[data-section="item-model-parts"] button.acc-trigger').click();
    await page.locator('[data-section="item-options"] button.acc-trigger').click();
    await expect(page.locator(".part-row").first()).toBeVisible();
    console.log("real: parts", await page.locator(".part-row label").count(), JSON.stringify(await page.locator(".part-row label").evaluateAll((e) => e.slice(0, 8).map((x) => x.textContent))));
    await page.getByRole("combobox", { name: "Animations" }).click();
    const rows = page.locator(".clip-row");
    await expect(rows.first()).toContainText("T-Pose");
    const count = await rows.count();
    expect(count).toBeGreaterThan(3);
    console.log("real: clips", count);
    await rows.nth(2).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/r_viewer.png` });
    await page.locator("#toggle-shadows").click();
    await page.getByRole("button", { name: "Background colour" }).click();
    await page.getByRole("button", { name: "#00b140" }).click();
    await expect(page.locator("#stage")).toHaveAttribute("data-scene", "off");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    await page.screenshot({ path: `${OUT}/r_viewer_bg.png` });
    expect(await coverage(page)).toBeGreaterThan(0.05);
    expect(errors).toEqual([]);
  });

  test("keyboard: Left is previous, Right is next, P pauses", async ({ page }) => {
    await open(page);
    const before = await page.locator("#strip-name").textContent();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#strip-name")).not.toHaveText(before!);
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator("#strip-name")).toHaveText(before!);
    await page.keyboard.press("p");
    await expect(page.locator("#strip-play")).toHaveAttribute("aria-label", "Play");
  });

  test("customization lists retail's options, and a choice changes the body", async ({ page }) => {
    const errors = await open(page, "?body=human-male&tab=customization");
    await expect(page.getByTestId("custom-pane")).toBeVisible();
    await expect(page.locator('[data-option="11"] .opt-track-name')).toHaveText("Peasant");
    const names = await page.locator(".opt-name").allTextContents();
    console.log("real: options", JSON.stringify(names));
    expect(names).toContain("Hair Style");
    expect(names).toContain("Skin Color");
    const before = await page.evaluate(() => (window as unknown as { eclipse: { internals: { visibleGeosets(): number[] } } }).eclipse.internals.visibleGeosets());
    await page.getByRole("button", { name: "Next Hair Style" }).click();
    await expect(page.locator('[data-option="11"] .opt-track-name')).toHaveText("Soldier");
    const after = await page.evaluate(() => (window as unknown as { eclipse: { internals: { visibleGeosets(): number[] } } }).eclipse.internals.visibleGeosets());
    expect(before).toContain(2);
    expect(after).toContain(3);
    expect(after).not.toContain(2);
    await expect(page).toHaveURL(/choices=11\.46/);
    await page.screenshot({ path: `${OUT}/r_custom.png` });
    expect(errors).toEqual([]);
  });

  test("the home page previews the featured model in its lite canvas", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(REAL);
    await page.waitForFunction(() => (window as unknown as { eclipse?: { frames(): number } }).eclipse?.frames?.() > 2, undefined, { timeout: 30_000 });
    await page.waitForTimeout(500);
    expect(await coverage(page, "#homepage-canvas")).toBeGreaterThan(0.02);
    await page.screenshot({ path: `${OUT}/r_home.png` });
    expect(errors).toEqual([]);
  });

  test("figure cells and hover on a real engine: an unbaked item keeps the figure up, no crash", async ({ page }) => {
    await page.route("**/packs/catalog/catalog.json", (r) => r.fulfill({ json: fixtureCatalog(40) }));
    const errors = await open(page);
    await expect(page.locator(".tile").first()).toBeVisible();
    await page.locator(".tile:not(.hide)").first().hover();
    await page.waitForTimeout(300);
    await page.locator(".tile:not(.hide)").first().click();
    await page.waitForTimeout(300);
    expect(await coverage(page)).toBeGreaterThan(0.05);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/r_figures.png` });
    expect(await page.locator(".tile").count()).toBeGreaterThan(3);
    expect(errors.filter((e) => !e.includes("items/"))).toEqual([]);
  });

  test("real items: hover tries on, click wears, ring releases, figures draw them", async ({ page }) => {
    const dir = "site/public/packs/items";
    const ids = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(`${dir}/${d}/manifest.json`)) : [];
    test.skip(ids.length === 0, "no item packs baked locally");
    const items = ids.map((id) => {
      const m = JSON.parse(readFileSync(`${dir}/${id}/manifest.json`, "utf8")) as { slot: string };
      return { id, name: `Item ${id}`, slot: m.slot, line: "midnight", icon: "", circle: "", tile: "" };
    });
    const slot = items[0]!.slot;
    await page.route("**/packs/catalog/catalog.json", (r) => r.fulfill({ json: { formatVersion: 1, build: "t", generatedAt: "t", races: [], mounts: [], items, sets: [] } }));
    const errors = await open(page, `?body=human-male&slot=${slot}`);
    const before = await page.evaluate(() => (window as unknown as { eclipse: { gpu(): { geometries: number } } }).eclipse.gpu().geometries);
    const tile = page.locator(".tile:not(.hide)").first();
    await tile.hover();
    await page.waitForTimeout(1800);
    await expect(page.locator("#stage-error")).toBeHidden();
    await page.screenshot({ path: `${OUT}/r_item_hover.png` });
    await tile.click();
    await expect(page.locator(`[data-ring="${slot}"]`)).toHaveClass(/worn/);
    await expect(page).toHaveURL(new RegExp(`look=${slot}:${items[0]!.id}`));
    await page.waitForTimeout(800);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${OUT}/r_item_worn.png` });
    const worn = await page.evaluate(() => (window as unknown as { eclipse: { gpu(): { geometries: number } } }).eclipse.gpu().geometries);
    console.log("real: geometries before/after wearing", before, worn);
    expect(worn).toBeGreaterThanOrEqual(before);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/r_item_figures.png` });
    await page.locator(`[data-ring="${slot}"]`).click({ button: "right" });
    await expect(page.locator(`[data-ring="${slot}"]`)).not.toHaveClass(/worn/);
    expect(errors).toEqual([]);
  });

  test("the viewer path modulepreloads the engine and three", async ({ page }) => {
    await page.goto(`${REAL}wardrobe/?body=human-male`);
    const hrefs = await page.locator('link[rel="modulepreload"]').evaluateAll((e) => e.map((x) => x.getAttribute("href")));
    console.log("real: modulepreload", JSON.stringify(hrefs));
    expect(hrefs.length).toBeGreaterThan(0);
  });

  test("mounts on the real engine: no poster baked, each card fills, hover goes live, no frame shows neither", async ({ page }) => {
    const local = ["mountd-17694", "mountd-17696", "mountd-17697", "mountd-114211"].filter((id) => existsSync(`site/public/packs/models/${id}/manifest.json`));
    test.skip(local.length === 0, "no mount packs baked locally");
    const rows = local.map((id, i) => ({ id: `m-${i}`, name: `Mount ${id}`, circle: "objects/never.webp", tile: "", mountId: i, flying: false, variants: [{ id, display: Number(id.slice(7)), name: id, icon: "objects/never.webp", mountId: i }] }));
    await page.route("**/packs/catalog/mounts.json", (r) => r.fulfill({ json: rows }));
    const icons: string[] = [];
    page.on("request", (r) => { if (r.url().includes("never.webp")) icons.push(r.url()); });
    await startCls(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${REAL}mounts/`);
    const cards = page.locator("#mount-grid .tile[data-mount]");
    await expect(cards).toHaveCount(local.length);
    // The engine drew each picture, and the page has its one context and nothing running.
    await expect(page.locator("#mount-grid .tile[data-mount] .tile-poster[data-ok]")).toHaveCount(local.length, { timeout: 60_000 });
    expect(icons).toEqual([]);
    const size = await cards.first().locator(".tile-poster").evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight]);
    expect(size).toEqual([400, 528]);
    await page.screenshot({ path: `${OUT}/r_mounts_filled.png` });

    const samples = await page.evaluate(async () => {
      const card = document.querySelectorAll<HTMLElement>("#mount-grid .tile[data-mount]")[1]!;
      const poster = card.querySelector<HTMLElement>(".tile-poster")!;
      const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-eclipse-cells]")!;
      const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
      const r = card.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      const k = canvas.width / canvas.clientWidth;
      const px = new Uint8Array(4 * Math.ceil(w * k) * Math.ceil(h * k));
      const log: { live: boolean; opacity: number; solid: number }[] = [];
      (window as unknown as { __card: HTMLElement }).__card = card;
      let run = true;
      const tick = () => {
        if (!run) return;
        gl.readPixels(Math.round(r.left * k), canvas.height - Math.round(r.bottom * k), Math.ceil(w * k), Math.ceil(h * k), gl.RGBA, gl.UNSIGNED_BYTE, px);
        let n = 0;
        for (let i = 3; i < px.length; i += 16) if (px[i]! > 16) n++;
        log.push({ live: card.classList.contains("live"), opacity: Number(getComputedStyle(poster).opacity), solid: n });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      (window as unknown as { __stop: () => typeof log }).__stop = () => {
        run = false;
        return log;
      };
      return 0;
    });
    void samples;
    await cards.nth(1).hover();
    await expect(cards.nth(1)).toHaveClass(/live/, { timeout: 30_000 });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.querySelectorAll("canvas").length)).toBe(1);
    await page.mouse.move(2, 2);
    await expect(cards.nth(1)).not.toHaveClass(/live/);
    await page.waitForTimeout(120);
    const log = await page.evaluate(() => (window as unknown as { __stop: () => { live: boolean; opacity: number; solid: number }[] }).__stop());
    const firstLive = log.findIndex((f) => f.live);
    console.log("real mounts: frames", log.length, "live from", firstLive, "solid at first live", log[firstLive]?.solid);
    expect(firstLive).toBeGreaterThanOrEqual(0);
    // A frame with the poster gone and the canvas empty would be a flicker.
    const bare = log.filter((f) => f.opacity < 0.05 && f.solid === 0);
    expect(bare).toEqual([]);
    // Back on the poster, and the canvas is clear.
    const end = log.at(-1)!;
    expect(end.opacity).toBe(1);
    expect(end.solid).toBe(0);
    expect(await cls(page)).toBe(0);
    expect(errors).toEqual([]);
  });
});
