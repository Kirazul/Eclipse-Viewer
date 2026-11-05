/**
 * Every interaction, end to end, on the real site: interaction to next paint by the browser's
 * own Event Timing, under 100 ms. A fresh profile compiles the GPU's raster shaders the first
 * time a surface shows, which no page can help and a returning visitor doesn't pay, so each
 * surface is shown once before it is timed.
 */
import { expect, test, type Page } from "@playwright/test";
import { GPU_ARGS, SITE, dataIsUp, installProbe, stageUp } from "./real-lib";

test.use({ launchOptions: { args: GPU_ARGS } });
test.describe.configure({ mode: "serial" });
let up = false;
test.beforeAll(async () => {
  up = await dataIsUp();
});
test.beforeEach(() => {
  test.skip(!up, "the packs on R2 don't answer");
});

const TARGET_MS = 100;
const results: { name: string; ms: number; long: number[] }[] = [];

async function timed(page: Page, name: string, act: () => Promise<unknown>, settle = 350) {
  await page.evaluate(() => { window.__probe.interactions.length = 0; window.__probe.long.length = 0; });
  await act();
  await page.waitForTimeout(settle);
  const r = await page.evaluate(() => {
    const by = new Map<number, number>();
    for (const e of window.__probe.interactions) by.set(e.id, Math.max(by.get(e.id) ?? 0, e.ms));
    return { worst: Math.max(0, ...by.values()), long: [...window.__probe.long] };
  });
  results.push({ name, ms: r.worst, long: r.long });
  return r.worst;
}

const click = (page: Page, sel: string) => page.locator(sel).first().click({ timeout: 20_000 });

test("every behaviour answers under 100 ms", async ({ page }) => {
  test.setTimeout(300_000);
  await installProbe(page);
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto(`${SITE}wardrobe/?body=human-male`);
  await stageUp(page);
  await page.waitForTimeout(1500);
  await page.mouse.move(5, 300);

  // Each surface once, unscored.
  for (const t of ["sets", "customization", "loadout", "viewer", "items"]) {
    await click(page, `[data-tab-btn="${t}"]`);
    await page.waitForTimeout(350);
  }
  await page.locator(".opt-row").first().waitFor({ state: "attached", timeout: 30_000 });

  for (const t of ["sets", "customization", "loadout", "viewer", "items"]) await timed(page, `tab ${t}`, () => click(page, `[data-tab-btn="${t}"]`));
  await timed(page, "line War Within", () => click(page, '#lines [data-line="warwithin"]'), 500);
  for (const s of ["shoulder", "back", "chest", "mainhand", "head"]) await timed(page, `slot chip ${s}`, () => click(page, `#chips [data-chip="${s}"]`), 500);
  for (const f of ["cloth", "plate", "cloth", "plate", "starred", "starred"]) await timed(page, `facet ${f}`, () => click(page, `#facets [data-facet="${f}"]`), 200);
  for (const s of ["chest", "legs", "head"]) await timed(page, `ring ${s}`, () => click(page, `[data-ring="${s}"]`), 300);
  await timed(page, "search typing", async () => { await page.locator("#q").click(); await page.keyboard.type("dragon", { delay: 70 }); });
  await timed(page, "search clear", () => click(page, "#q-x"));

  await timed(page, "tab customization", () => click(page, '[data-tab-btn="customization"]'), 800);
  await page.locator(".opt-row").first().waitFor({ timeout: 30_000 });
  const step = page.locator('.opt-row[data-kind="step"] .opt-arrow:not([disabled])');
  await timed(page, "customization step", () => step.last().click(), 500);
  await timed(page, "customization step again", () => step.last().click(), 500);
  await timed(page, "customization swatch", () => page.locator(".swatches .swatch.sm").nth(2).click(), 500);
  await timed(page, "customization randomize", () => page.getByRole("button", { name: "Randomize" }).click(), 600);
  await timed(page, "customization reset", () => page.getByRole("button", { name: "Reset", exact: true }).click(), 600);
  const back = await page.locator(".race-btn.on").first().getAttribute("data-race");
  const other = await page.locator(".race-btn:not(.on)").first().getAttribute("data-race");
  await timed(page, "race switch", () => click(page, `[data-race="${other}"]`), 3000);
  await timed(page, "race back", () => click(page, `[data-race="${back}"]`), 3000);

  await timed(page, "tab viewer", () => click(page, '[data-tab-btn="viewer"]'));
  await timed(page, "open Model parts", () => click(page, '[data-section="item-model-parts"] button.acc-trigger'));
  await timed(page, "auto hide off", () => page.locator("#automatic-visibility").click());
  for (const i of [0, 1, 2]) await timed(page, `part toggle ${i}`, () => page.locator(".part-row .switch").nth(i).click());
  await timed(page, "auto hide on", () => page.locator("#automatic-visibility").click());
  await timed(page, "close Model parts", () => click(page, '[data-section="item-model-parts"] button.acc-trigger'));
  await timed(page, "open Options", () => click(page, '[data-section="item-options"] button.acc-trigger'));
  await timed(page, "shadows off", () => page.locator("#toggle-shadows").click());
  await timed(page, "shadows on", () => page.locator("#toggle-shadows").click());
  await timed(page, "close Options", () => click(page, '[data-section="item-options"] button.acc-trigger'));
  await timed(page, "clip picker", () => page.getByRole("combobox", { name: "Animations" }).click());
  await page.keyboard.press("Escape");

  await click(page, '[data-tab-btn="items"]');
  await page.waitForTimeout(300);
  const handle = (await page.locator("#split-handle").boundingBox())!;
  await timed(page, "panel resize", async () => {
    await page.mouse.move(handle.x, handle.y + 100);
    await page.mouse.down();
    for (let i = 0; i < 20; i++) {
      await page.mouse.move(handle.x - i * 6, handle.y + 100);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  });
  await timed(page, "theme light", () => click(page, "#theme-btn"));
  await timed(page, "theme dark", () => click(page, "#theme-btn"));
  await timed(page, "search dialog", () => click(page, "[data-search-open]"), 400);
  await page.keyboard.press("Escape");

  const tile = page.locator(".grid-row:not([hidden]) .tile:not(.hide):not([hidden])").nth(2);
  const t = (await tile.boundingBox())!;
  await timed(page, "hover a card", () => page.mouse.move(t.x + t.width / 2, t.y + t.height / 2), 700);
  await timed(page, "wear a card", () => page.mouse.click(t.x + t.width / 2, t.y + t.height / 2), 700);
  await page.mouse.move(5, 300);

  const slow = results.filter((r) => r.ms >= TARGET_MS);
  console.log(results.map((r) => `${r.name.padEnd(28)} ${String(r.ms || "<16").padStart(4)} ms${r.long.length ? `  long tasks ${r.long.join(",")}` : ""}`).join("\n"));
  expect(slow.map((r) => `${r.name}: ${r.ms} ms`)).toEqual([]);
});

test("the figure comes first: nothing of the grid is asked for until it stands", async ({ browser }) => {
  test.setTimeout(120_000);
  // A browser of its own: nothing cached, as a first visit is.
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { __firstFrame: number; eclipse?: { frames?(): number } };
    w.__firstFrame = 0;
    performance.setResourceTimingBufferSize(1000);
    const t = setInterval(() => {
      if ((w.eclipse?.frames?.() ?? 0) > 0) {
        w.__firstFrame = performance.now();
        clearInterval(t);
      }
    }, 10);
  });
  await page.goto(`${SITE}wardrobe/?body=human-male`);
  await page.waitForFunction(() => (window as unknown as { __firstFrame: number }).__firstFrame > 0, undefined, { timeout: 60_000 });
  await page.waitForTimeout(300);
  const out = await page.evaluate(() => {
    const entries = performance.getEntriesByType("resource");
    const started = (part: string) => entries.find((e) => e.name.includes(part))?.startTime ?? Infinity;
    return {
      first: (window as unknown as { __firstFrame: number }).__firstFrame,
      atlas: started("/ui/atlas.webp"),
      catalog: started("/catalog/catalog.json"),
      manifest: started("/models/human-male/manifest.json"),
      wasm: started("basis_transcoder.wasm"),
    };
  });
  console.log("first model frame", Math.round(out.first), "ms; manifest asked at", Math.round(out.manifest), "transcoder at", Math.round(out.wasm), "sprites at", Math.round(out.atlas), "catalogue at", Math.round(out.catalog));
  // Asked for from the page's first bytes, not after its code has come and run.
  expect(out.manifest).toBeLessThan(out.first / 2);
  expect(out.wasm).toBeLessThan(out.first / 2);
  // Six sockets and a slow first byte each: all of them are the figure's until it stands.
  expect(out.atlas).toBeGreaterThanOrEqual(out.first - 100);
  expect(out.catalog).toBeGreaterThanOrEqual(out.first - 100);
  await context.close();
});

test("a body or race switch keeps the current figure until the new one is ready", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.goto(`${SITE}wardrobe/?body=human-male&tab=customization`);
  await stageUp(page);
  await page.locator(".opt-row").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  const other = await page.locator(".race-btn:not(.on)").first().getAttribute("data-race");

  // Every frame of the switch: what is on stage, and whether the canvas has a figure on it.
  await page.evaluate(() => {
    const w = window as unknown as { eclipse: { figure: { id: string } | null }; __log: { id: string | null; solid: number; opacity: string }[]; __run: boolean };
    w.__log = [];
    w.__run = true;
    const canvas = document.getElementById("canvas") as HTMLCanvasElement;
    const small = document.createElement("canvas");
    small.width = 24;
    small.height = 32;
    const x = small.getContext("2d", { willReadFrequently: true })!;
    const tick = () => {
      if (!w.__run) return;
      x.clearRect(0, 0, 24, 32);
      x.drawImage(canvas, 0, 0, 24, 32);
      const d = x.getImageData(0, 0, 24, 32).data;
      let solid = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]! > 128) solid++;
      w.__log.push({ id: w.eclipse.figure?.id ?? null, solid, opacity: canvas.style.opacity });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.locator(`[data-race="${other}"]`).first().click();
  await page.waitForFunction((race) => (window as unknown as { eclipse: { figure: { id: string } | null } }).eclipse.figure?.id.startsWith(race!) ?? false, other, { timeout: 60_000 });
  await page.waitForTimeout(300);
  const log = await page.evaluate(() => {
    const w = window as unknown as { __log: { id: string | null; solid: number; opacity: string }[]; __run: boolean };
    w.__run = false;
    return w.__log;
  });
  const ids = [...new Set(log.map((l) => l.id))];
  console.log("the stage held", ids.join(" then "), "over", log.length, "frames; fewest solid cells", Math.min(...log.map((l) => l.solid)));
  expect(ids.length, "one figure, then the other: nothing between").toBe(2);
  expect(log.every((l) => l.opacity === "1"), "the canvas never fades").toBe(true);
  expect(Math.min(...log.map((l) => l.solid)), "a figure on every frame").toBeGreaterThan(5);
});
