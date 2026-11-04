import { expect, test } from "@playwright/test";
import { mockPacks, watchErrors } from "./helpers";

const ROUTES: [string, RegExp][] = [
  ["./", /Eclipse/],
  ["races/", /Races/],
  ["races/human/", /Human/],
  ["mounts/", /Mounts/],
  ["settings/", /Settings/],
  ["about/", /About/],
  ["privacy/", /Privacy/],
  ["wardrobe/?body=human-male", /Wardrobe/],
  ["viewer/?id=human-male", /Wardrobe/],
];

test.describe("every route", () => {
  for (const [path, title] of ROUTES) {
    test(`${path} loads with no console errors`, async ({ page }) => {
      const errors = watchErrors(page);
      await mockPacks(page);
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.locator(".page-title")).toHaveText(title);
      await page.waitForTimeout(400);
      expect(errors).toEqual([]);
    });
  }

  test("all internal links and assets stay under the base path", async ({ page }) => {
    const seen: string[] = [];
    page.on("request", (r) => seen.push(new URL(r.url()).pathname));
    await mockPacks(page);
    await page.goto("wardrobe/?body=human-male");
    await page.waitForLoadState("networkidle");
    const outside = seen.filter((p) => !p.startsWith("/Eclipse-Viewer/"));
    expect(outside).toEqual([]);
    const hrefs = await page.locator("a[href^='/']").evaluateAll((els) => els.map((e) => e.getAttribute("href")!));
    expect(hrefs.length).toBeGreaterThan(5);
    expect(hrefs.filter((h) => !h.startsWith("/Eclipse-Viewer/"))).toEqual([]);
  });

  test("entries not baked yet show dimmed, unlinked, and say so", async ({ page }) => {
    await page.goto("races/human/");
    const baked = page.locator("a.body-tile");
    await expect(baked.first()).toHaveAttribute("href", "/Eclipse-Viewer/wardrobe/?body=human-male");
    const dimmed = page.locator(".body-tile.not-baked");
    await expect(dimmed.first()).toHaveAttribute("title", "Not baked yet");
    expect(await dimmed.first().evaluate((e) => e.tagName)).toBe("DIV");
    await page.goto("races/");
    await expect(page.locator(".circle-link.not-baked").first()).toHaveAttribute("title", "Not baked yet");
  });

  test("/items folds into the wardrobe", async ({ page }) => {
    await mockPacks(page);
    await page.goto("items/");
    await expect(page).toHaveURL(/wardrobe\/?/);
    await expect(page.locator(".page-title")).toHaveText("Wardrobe");
  });

  test("reduced motion: no transition runs, and the CSS asks for no page transition", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("races/");
    const d = await page.locator(".nav-item").first().evaluate((e) => parseFloat(getComputedStyle(e).transitionDuration));
    expect(d).toBeLessThan(0.001);
    const css = await page.evaluate(async () => {
      const href = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')!.href;
      return (await fetch(href)).text();
    });
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{\s*@view-transition/);
  });

  test("a real 404", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const res = await page.goto("no/such/page/");
    expect(res?.status()).toBe(404);
    await expect(page.locator(".notice-title")).toHaveText("Nothing here");
    await expect(page.getByRole("link", { name: "Open the wardrobe" })).toHaveAttribute("href", "/Eclipse-Viewer/wardrobe/");
    expect(errors).toEqual([]);
  });

  test("no Khada leftovers, ads or analytics in any page", async ({ page }) => {
    for (const [path] of ROUTES) {
      await mockPacks(page);
      await page.goto(path);
      const html = await page.content();
      expect(html).not.toMatch(/khada|modelviewer\.lol|googletagmanager|adsense|lorem/i);
    }
  });
});

test.describe("navigation", () => {
  test("rail reaches every page and lights the current one", async ({ page, isMobile }) => {
    await mockPacks(page);
    await page.goto("./");
    for (const [name, url] of [["Wardrobe", /wardrobe\/$/], ["Races", /races\/$/], ["Mounts", /mounts\/$/], ["Settings", /settings\/$/], ["Home", /Eclipse-Viewer\/$/]] as const) {
      if (isMobile) await page.locator("#menu-btn").click();
      await page.locator(".rail-nav").getByRole("link", { name }).click();
      await expect(page).toHaveURL(url);
      await expect(page.locator(".nav-item.on")).toHaveText(name);
    }
  });

  test("support and Discord are on the rail", async ({ page }) => {
    await page.goto("./");
    await expect(page.locator(".rail-foot a", { hasText: "Support" })).toHaveAttribute("href", "https://ko-fi.com/eclipsewow");
    await expect(page.locator(".rail-foot a", { hasText: "Discord" })).toHaveAttribute("href", "https://discord.gg/RvY5VjHgTA");
  });

  test("hover and tap prefetch the next page", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover prefetch is a desktop path; tap uses the same code");
    await page.goto("./");
    const asked = page.waitForRequest((r) => r.url().endsWith("/races/"));
    await page.locator(".rail-nav").getByRole("link", { name: "Races" }).hover();
    await asked;
  });

  test("mobile: the rail is a drawer", async ({ page, isMobile }) => {
    test.skip(!isMobile, "phone layout");
    await page.goto("./");
    await expect(page.locator("#rail")).toBeHidden();
    await page.locator("#menu-btn").click();
    await expect(page.locator(".rail-nav")).toBeVisible();
    await page.waitForTimeout(600);
    await page.locator("#drawer-scrim").click({ position: { x: 370, y: 400 } });
    await expect(page.locator("html")).not.toHaveClass(/drawer-open/);
  });
});

test.describe("theme and accent", () => {
  test("switching persists and never reaches the first paint wrong", async ({ page }) => {
    await page.goto("./");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator("#theme-btn").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    expect(bg).not.toBe("rgb(12, 10, 8)");
    await page.goto("races/");
    // Read inside the document before any module script could have run.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("settings: six accents, chosen one persists and retints the surfaces", async ({ page }) => {
    await page.goto("settings/");
    const buttons = page.locator("[data-set-accent]");
    await expect(buttons).toHaveCount(6);
    await expect(buttons.getByText("Azure")).toBeVisible();
    const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--rail").trim());
    await buttons.filter({ hasText: "Azure" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-accent", "azure");
    const after = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--t-rail").trim());
    expect(after).not.toBe(before);
    await page.goto("./");
    await expect(page.locator("html")).toHaveAttribute("data-accent", "azure");
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    expect(accent).toBe("#5ca3f2");
  });
});

test.describe("search", () => {
  test("Ctrl+K opens it, the index loads once, every keystroke filters", async ({ page }) => {
    let fetched = 0;
    await mockPacks(page);
    await page.route("**/packs/catalog/search.json", (r) => {
      fetched++;
      return r.fulfill({ json: [
        { n: "Humanoid Mask of the Deep", i: "head-1", g: "item", c: "" },
        { n: "Human", i: "human", g: "race", c: "" },
        { n: "Human Male", i: "human-male", g: "body", c: "" },
        { n: "Shamanistic Hood", i: "head-2", g: "item", c: "" },
      ] });
    });
    await page.goto("races/");
    await page.keyboard.press("Control+k");
    const dialog = page.getByTestId("search-dialog");
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(512);
    const input = dialog.locator("input");
    await input.pressSequentially("hu", { delay: 5 });
    await expect(dialog.locator(".search-row")).toHaveCount(3);
    await input.pressSequentially("m", { delay: 5 });
    // Word matches first, then by shorter name.
    await expect(dialog.locator(".search-row b")).toHaveText(["Human", "Human Male", "Humanoid Mask of the Deep"]);
    await page.waitForTimeout(250); // past the dialog's zoom
    expect((await dialog.locator(".search-row").first().boundingBox())!.height).toBe(56);
    expect((await dialog.locator(".search-list").boundingBox())!.height).toBe(288);
    await input.fill("sham");
    await expect(dialog.locator(".search-row b")).toHaveText(["Shamanistic Hood"]);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.keyboard.press("Control+k");
    await expect(dialog).toBeVisible();
    expect(fetched).toBe(1);
  });

  test("Enter goes to the selected result", async ({ page }) => {
    await mockPacks(page);
    await page.goto("./");
    await page.locator("[data-search-open]").first().click();
    await page.getByTestId("search-dialog").locator("input").fill("human male");
    await expect(page.locator(".search-row b").first()).toHaveText("Human Male");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/wardrobe\/\?body=human-male/);
  });
});
