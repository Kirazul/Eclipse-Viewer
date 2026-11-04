import { mkdirSync, readFileSync } from "node:fs";
import { test } from "@playwright/test";
import { fixtureCatalog, mockPacks, openRoom } from "./helpers";

// Renders for looking at, beside work/eclipse-refs. Not an assertion: see room.pw.ts.
const OUT = "tests/site/results/shots";
mkdirSync(OUT, { recursive: true });
// Race portraits stand in for item icons so the tiles can be judged with art in them.
const catalog = JSON.parse(readFileSync("site/src/data/catalog.json", "utf8")) as { races: { circle: string }[] };
const ICONS = catalog.races.map((r) => r.circle).filter(Boolean);

test.describe("reference shots", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 700, "desktop renders only");
  test.use({ viewport: { width: 1400, height: 860 } });

  test("wardrobe", async ({ page }) => {
    await mockPacks(page, { catalog: fixtureCatalog(120, ICONS) });
    await openRoom(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/01_items.png` });
    await page.locator(".tile").nth(14).hover();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/02_items_hover.png` });
    await page.mouse.move(5, 5);
    await page.locator('[data-tab-btn="sets"]').click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/03_sets.png` });
    await page.locator('[data-tab-btn="customization"]').click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/06_customization.png` });
    await page.locator('[data-tab-btn="viewer"]').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/07_viewer.png` });
  });

  test("wardrobe, nothing baked", async ({ page }) => {
    await mockPacks(page, { catalog: null });
    await openRoom(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/01b_empty.png` });
  });

  for (const [name, path] of [["home", ""], ["mounts", "mounts/"], ["settings", "settings/"], ["about", "about/"], ["privacy", "privacy/"], ["404", "nope/"]] as const) {
    test(`page ${name}`, async ({ page }) => {
      await mockPacks(page);
      await page.goto(path || "./");
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/p_${name}.png` });
    });
  }

  test("light theme", async ({ page }) => {
    await mockPacks(page, { catalog: fixtureCatalog(120) });
    await page.addInitScript(() => localStorage.setItem("theme", "light"));
    await openRoom(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/l_items.png` });
  });
});

test.describe("mobile shots", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 700, "mobile renders only");
  test("wardrobe", async ({ page }) => {
    await mockPacks(page, { catalog: fixtureCatalog(120) });
    await openRoom(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/m_items.png` });
    await page.locator("#menu-btn").click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/m_drawer.png` });
  });
  test("home", async ({ page }) => {
    await mockPacks(page);
    await page.goto("./");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/m_home.png` });
  });
});
