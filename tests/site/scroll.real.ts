/**
 * Scrolling the biggest real grids on real data, with real wheel input and a real fling, on a
 * real GPU: long tasks, frame gaps, how late input reaches the page, and that a scroll does
 * nothing but scroll. One worker: see real-lib.ts.
 *
 * A first pass warms the GPU's shader cache, which a fresh browser profile doesn't have and a
 * returning visitor does; the numbers come from the passes after it.
 */
import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { GPU_ARGS, SITE, dataIsUp, installProbe, stageUp, startFrames, stopFrames, type FrameReport } from "./real-lib";

test.use({ launchOptions: { args: GPU_ARGS } });
test.describe.configure({ mode: "serial" });
let up = false;
test.beforeAll(async () => {
  up = await dataIsUp();
});
test.beforeEach(() => {
  test.skip(!up, "the packs on R2 don't answer");
});

interface Grid {
  name: string;
  scroller: string;
  open(page: Page): Promise<void>;
}
const GRIDS: Grid[] = [
  {
    name: "Mounts (638)",
    scroller: "#mount-scroll",
    open: async (page) => {
      await page.goto(`${SITE}mounts/`);
      await page.locator(".tile[data-mount]").first().waitFor({ timeout: 60_000 });
    },
  },
  {
    name: "Items, War Within backs (770)",
    scroller: "#grid-scroll",
    open: async (page) => {
      await page.goto(`${SITE}wardrobe/?body=human-male&slot=back`);
      await stageUp(page);
      await page.locator('#lines [data-line="warwithin"]').click();
      await expect(page.locator("#count")).toHaveText("770", { timeout: 30_000 });
    },
  },
  {
    name: "Sets, War Within (977)",
    scroller: "#grid-scroll",
    open: async (page) => {
      await page.goto(`${SITE}wardrobe/?body=human-male`);
      await stageUp(page);
      await page.locator('[data-tab-btn="sets"]').click();
      await page.locator('#lines [data-line="warwithin"]').click();
      await expect(page.locator("#count")).toHaveText("977", { timeout: 30_000 });
    },
  },
];

async function run(page: Page, cdp: CDPSession, at: { x: number; y: number }) {
  const wheel = async () => {
    await startFrames(page);
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(60);
    return stopFrames(page);
  };
  const fling = async (distance: number) => {
    await startFrames(page);
    await cdp.send("Input.synthesizeScrollGesture", { x: at.x, y: at.y, yDistance: distance, speed: Math.abs(distance), gestureSourceType: "mouse" });
    await page.waitForTimeout(60);
    return stopFrames(page);
  };
  return { wheel: await wheel(), down: await fling(-9000), up: await fling(12000) };
}

for (const grid of GRIDS) {
  test(`${grid.name}: no long task, no hitch, and a scroll wakes nothing and asks for nothing`, async ({ browser }) => {
    test.setTimeout(240_000);
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1400, height: 860 }, serviceWorkers: "block" });
    const page = await context.newPage();
    await installProbe(page);
    const asked: string[] = [];
    page.on("request", (r) => { if (/\/(models|items|sets)\/[^/]+\/manifest\.json/.test(r.url())) asked.push(r.url()); });
    await grid.open(page);
    const cdp = await context.newCDPSession(page);
    const box = (await page.locator(grid.scroller).boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(at.x, at.y);

    // Cold: this browser has never compiled these shaders. Warm from here on.
    await run(page, cdp, at);
    await page.waitForTimeout(600);

    await page.evaluate(() => { for (const k of Object.keys(window.__n)) window.__n[k] = 0; });
    const askedBefore = asked.length;
    const r = await run(page, cdp, at);
    const calls = await page.evaluate(() => ({ ...window.__n }));
    const posters = asked.length - askedBefore;
    const rows = Object.entries(r).map(([k, v]: [string, FrameReport]) => `${k}: p50 ${v.p50} p95 ${v.p95} p99 ${v.p99} max ${v.max} ms, ${v.dropped} of ${v.frames} frames dropped, longest task ${v.longMax} ms, wheel late ${v.wheelP95} ms`);
    console.log(`${grid.name}\n  ${rows.join("\n  ")}\n  during it: ${JSON.stringify(calls)}, ${posters} new models asked for`);

    for (const [k, v] of Object.entries(r)) {
      expect(v.longMax, `${k}: the longest task`).toBeLessThanOrEqual(50);
      expect(v.p95, `${k}: frame gap p95, at 60 Hz or better`).toBeLessThanOrEqual(16.7);
      expect(v.dropped / v.frames, `${k}: frames dropped`).toBeLessThan(0.02);
      expect(v.wheelP95, `${k}: wheel to page`).toBeLessThan(50);
    }
    // A scroll is about the grid. It tries nothing on and wakes nothing.
    expect(calls.previewEquip, "try-ons").toBe(0);
    expect(calls.prefetchEquip, "try-on fetches").toBe(0);
    expect(calls.addFigureCell, "cells woken").toBe(0);
    expect(calls.live ?? 0, "cards gone live").toBe(0);
    await expect(page.locator(".tile.live")).toHaveCount(0);
    await context.close();
  });
}

for (const grid of GRIDS.slice(0, 2)) {
  test(`${grid.name}: a fling asks nothing for what it passes, and what it stops on fills`, async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: { width: 1400, height: 860 }, serviceWorkers: "block" });
    const page = await context.newPage();
    await installProbe(page);
    const asked: string[] = [];
    page.on("request", (r) => { if (/\/(models|items)\/[^/]+\/manifest\.json/.test(r.url())) asked.push(r.url()); });
    await grid.open(page);
    const cdp = await context.newCDPSession(page);
    const box = (await page.locator(grid.scroller).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(2500);
    const before = asked.length;
    await cdp.send("Input.synthesizeScrollGesture", { x: box.x + box.width / 2, y: box.y + box.height / 2, yDistance: -6000, speed: 9000, gestureSourceType: "mouse" });
    const during = asked.length - before;
    console.log(`${grid.name}: over a fling of 6000 px, ${during} models asked for`);
    // What was on its way when it began may land; nothing new starts until it stops.
    expect(during).toBeLessThanOrEqual(3);
    await expect.poll(() => asked.length - before, { timeout: 20_000 }).toBeGreaterThan(during);
    await context.close();
  });
}
