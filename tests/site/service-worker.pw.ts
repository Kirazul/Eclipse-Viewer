import { expect, test } from "@playwright/test";
import { mockPacks } from "./helpers";

// The test server sends max-age=0, so a hit on it means the service worker let the
// request through: the browser's HTTP cache can't explain a clean second visit.
const AGENT = "eclipse-sw-test";
const hits = async (page: import("@playwright/test").Page) => (await (await page.request.get(`http://localhost:4329/__hits?ua=${AGENT}`)).json()) as string[];
const resetHits = (page: import("@playwright/test").Page) => page.request.get("http://localhost:4329/__reset");

test.describe("service worker", () => {
  test.use({ serviceWorkers: "allow", userAgent: `Mozilla/5.0 Edg/156 ${AGENT}` });
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 700, "one viewport is enough");

  async function seeded(page: import("@playwright/test").Page) {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => page.evaluate(async () => {
      const want = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes("/_astro/"));
      const cache = await caches.open("eclipse-assets-v1");
      const have = await Promise.all(want.map((u) => cache.match(u)));
      return want.length > 0 && have.every(Boolean);
    }), { timeout: 15_000 }).toBe(true);
  }

  test("a repeat visit makes zero network requests for hashed assets", async ({ page }) => {
    await mockPacks(page);
    await page.goto("races/");
    await seeded(page);
    await resetHits(page);
    await page.reload();
    await page.waitForLoadState("load");
    await page.waitForTimeout(400);
    const after = await hits(page);
    console.log("second visit hit the network for:", JSON.stringify(after));
    expect(after.filter((p) => p.includes("/_astro/"))).toEqual([]);
    // And HTML still goes to the network: a deploy is seen on the next load.
    expect(after).toContain("/Eclipse-Viewer/races/");
    const fromSw = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes("/_astro/")).every((e) => (e as PerformanceResourceTiming).transferSize === 0));
    expect(fromSw).toBe(true);
  });

  test("the first load is not held up: registration happens after load", async ({ page }) => {
    let controlledAtLoad: boolean | null = null;
    await page.goto("./");
    controlledAtLoad = await page.evaluate(() => !!navigator.serviceWorker.controller);
    expect(controlledAtLoad).toBe(false);
    await page.evaluate(() => navigator.serviceWorker.ready);
  });

  test("a deploy never mixes: new HTML is used at once, its files load, nothing breaks", async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await mockPacks(page);
    await page.goto("about/");
    await seeded(page);
    await request.get("http://localhost:4329/__deploy?v=two");
    await page.reload();
    await request.get("http://localhost:4329/__deploy?v=");
    await expect(page.locator('meta[name="deploy"]')).toHaveAttribute("content", "two");
    await expect(page.locator(".page-title")).toHaveText("About");
    expect(errors).toEqual([]);
  });

  test("offline, the last page and its hashed files still open", async ({ page, context }) => {
    await mockPacks(page);
    await page.goto("about/");
    await seeded(page);
    await page.reload();
    await seeded(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator(".page-title")).toHaveText("About");
    await context.setOffline(false);
  });

  test("manifests and the catalogue are network first", async ({ page }) => {
    await page.goto("about/");
    await seeded(page);
    const result = await page.evaluate(async () => {
      const u = `${location.origin}/Eclipse-Viewer/packs/ui/does-not-exist.webp`;
      await fetch(u).catch(() => null);
      const cache = await caches.open("eclipse-packs-v1");
      return { cached404: !!(await cache.match(u)) };
    });
    expect(result.cached404).toBe(false);
  });
});
