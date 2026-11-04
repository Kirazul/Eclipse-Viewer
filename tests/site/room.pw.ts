import { expect, test } from "@playwright/test";
import { calls, clearCalls, cls, fixtureCatalog, mockPacks, openRoom, shifts, startCls, watchErrors } from "./helpers";

test.describe("the dressing room", () => {
  test("layout: the ring around the stage, Eclipse's own constants", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop constants");
    await mockPacks(page);
    await openRoom(page);
    const left = await page.locator('[data-ring-col="left"] [data-ring]').evaluateAll((e) => e.map((x) => x.getAttribute("data-ring")));
    const right = await page.locator('[data-ring-col="right"] [data-ring]').evaluateAll((e) => e.map((x) => x.getAttribute("data-ring")));
    const bottom = await page.locator(".ring-bottom [data-ring]").evaluateAll((e) => e.map((x) => x.getAttribute("data-ring")));
    expect(left).toEqual(["head", "shoulder", "back", "chest", "shirt", "tabard", "wrist"]);
    expect(right).toEqual(["hands", "waist", "legs", "feet"]);
    expect(bottom).toEqual(["mainhand", "offhand", "ranged"]);
    const a = (await page.locator('[data-ring="head"]').boundingBox())!;
    const b = (await page.locator('[data-ring="shoulder"]').boundingBox())!;
    expect(a.width).toBe(40);
    expect(b.y - a.y).toBe(47); // kSlotSz + kSlotGap
    const stage = (await page.locator("#stage").boundingBox())!;
    const room = (await page.locator(".room").boundingBox())!;
    expect(stage.x - a.x).toBe(47);
    expect(room.width - stage.width).toBe(94); // kRingW
    expect(room.width).toBeLessThanOrEqual(460); // kRoomMaxW
    expect(stage.height).toBeGreaterThan(stage.width); // portrait
    const tiles = page.locator(".tile");
    await expect(tiles.first()).toBeVisible();
    const t0 = (await tiles.nth(0).boundingBox())!;
    const t1 = (await tiles.nth(1).boundingBox())!;
    expect(t0.width).toBe(76); // kBoard
    expect(t1.x - t0.x).toBe(86); // kBoard + kBoardPad
  });

  test("hover tries on after the rest, click wears, ring releases", async ({ page, isMobile }) => {
    test.skip(isMobile, "pointer hover");
    await mockPacks(page);
    await openRoom(page);
    await clearCalls(page);
    const tile = page.locator(".tile:not(.hide)").nth(3);
    await tile.hover();
    await page.waitForTimeout(40);
    expect(await calls(page, "previewEquip")).toHaveLength(0); // inside kHoverRestSec
    await page.waitForTimeout(150);
    const preview = await calls(page, "previewEquip");
    expect(preview.at(-1)!.args[0]).toBe("head");
    expect((await calls(page, "focusSlot")).at(-1)!.args[0]).toBe("head");
    await expect(page.locator("#tip")).toContainText("head");

    // Leaving waits kHoverClearSec, so sweeping between tiles doesn't flash the figure.
    await clearCalls(page);
    await page.mouse.move(600, 840);
    await page.waitForTimeout(700);
    expect(await calls(page, "previewEquip")).toHaveLength(0);
    await page.waitForTimeout(1000);
    expect((await calls(page, "previewEquip")).at(-1)!.args).toEqual(["head", null]);

    const id = String(preview.at(-1)!.args[1]);
    await tile.click();
    await expect.poll(() => calls(page, "equip").then((c) => c.at(-1)?.args)).toEqual(["head", id]);
    await expect(page.locator('[data-ring="head"]')).toHaveClass(/worn/);
    await expect(page.locator("#reset-look")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`look=head:${id}`));

    await page.locator('[data-ring="head"]').click({ button: "right" });
    await expect.poll(() => calls(page, "equip").then((c) => c.at(-1)?.args)).toEqual(["head", null]);
    await expect(page.locator('[data-ring="head"]')).not.toHaveClass(/worn/);
  });

  test("a set shows whole and steps back; wearing it replaces the look", async ({ page, isMobile }) => {
    test.skip(isMobile, "pointer hover");
    await mockPacks(page);
    await openRoom(page, "?body=human-male&tab=sets");
    const tile = page.locator(".tile.set").first();
    await expect(tile).toBeVisible();
    await clearCalls(page);
    await tile.hover();
    await page.waitForTimeout(200);
    const slots = (await calls(page, "previewEquip")).map((c) => c.args[0]);
    expect(slots).toEqual(expect.arrayContaining(["head", "chest", "legs"]));
    expect((await calls(page, "focusSlot")).at(-1)!.args[0]).toBe(null);
    await tile.click();
    await expect(page.locator('[data-ring="legs"]')).toHaveClass(/worn/);
    await expect(page.locator(".tile.set.worn").first()).toBeVisible();
    await page.locator("#reset-look").click();
    await expect(page.locator(".slot.worn")).toHaveCount(0);
  });

  test("chips and ring are one selection; chips, search, facets filter the count", async ({ page }) => {
    await mockPacks(page);
    await openRoom(page);
    await expect(page.locator("#count")).toHaveText("400");
    await page.locator('[data-chip="chest"]').click();
    await expect(page.locator('[data-ring="chest"]')).toHaveClass(/on/);
    await expect(page.locator('[data-chip="head"]')).not.toHaveClass(/\bon\b/);
    await page.locator('[data-facet="plate"]').click();
    await expect(page.locator("#count")).toHaveText("100");
    await page.locator("#q").fill("bronze");
    await expect(page.locator("#count")).not.toHaveText("100");
    await page.locator("#q-x").click();
    await expect(page.locator("#count")).toHaveText("100");
    await page.locator('[data-ring="legs"]').click();
    await expect(page.locator('[data-chip="legs"]')).toHaveClass(/on/);
    await expect(page.locator('[data-facet="plate"]')).not.toHaveClass(/\bon\b/); // a new subject clears facets
    await expect(page.locator("#count")).toHaveText("400");
  });

  test("the grid is virtual: thousands of rows, few elements, scroll paints the right tiles", async ({ page, isMobile }) => {
    test.skip(isMobile, "same code, inner scroller differs");
    await mockPacks(page, { catalog: fixtureCatalog(5000) });
    await openRoom(page);
    await expect(page.locator("#count")).toHaveText("5000");
    expect(await page.locator(".tile").count()).toBeLessThan(120);
    await page.locator("#grid-scroll").evaluate((e) => { e.scrollTop = 40000; });
    await page.waitForTimeout(120);
    const firstOnScreen = page.locator(".grid-row:not([hidden]) .tile").first();
    await expect(firstOnScreen).toBeVisible();
    await firstOnScreen.hover();
    await expect(page.locator("#tip")).toContainText("head");
    expect(await page.locator(".tile").count()).toBeLessThan(160);
  });

  test("starring sorts to the front and survives a reload", async ({ page, isMobile }) => {
    test.skip(isMobile, "star shows on hover");
    await mockPacks(page);
    await openRoom(page);
    const third = page.locator(".tile:not(.hide)").nth(2);
    await third.hover();
    await third.locator("[data-star]").click();
    await expect(third).toHaveClass(/fav/);
    await page.locator('[data-facet="starred"]').click();
    await expect(page.locator("#count")).toHaveText("1");
    await page.reload();
    await page.locator('[data-facet="starred"]').click();
    await expect(page.locator("#count")).toHaveText("1");
  });

  test("clean empty state while nothing is baked", async ({ page }) => {
    await mockPacks(page, { catalog: null });
    const errors = watchErrors(page);
    await openRoom(page);
    await expect(page.locator("#grid-empty")).toContainText("Items are on their way");
    await expect(page.locator(".tile")).toHaveCount(0);
    await expect(page.locator("#count")).toHaveText("0");
    expect(errors).toEqual([]);
  });

  test("figures mode asks the engine for live cells, and gives them back", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop");
    await mockPacks(page);
    await openRoom(page);
    await page.waitForTimeout(100);
    await page.locator('[data-grid-mode="figures"]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __figures: Set<unknown> }).__figures.size)).toBeGreaterThan(4);
    const inMode = await page.evaluate(() => (window as unknown as { __figures: Set<unknown> }).__figures.size);
    expect(inMode).toBeLessThan(60); // only visible cells
    await page.locator('[data-grid-mode="icons"]').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __figures: Set<unknown> }).__figures.size)).toBe(0);
  });

  test("the look lives in the URL: a shared link rebuilds it", async ({ page }) => {
    await mockPacks(page);
    await openRoom(page, "?body=human-male&look=head:head-3,legs:legs-9&slot=legs&clip=69.0&tab=sets");
    await expect(page.locator("#room")).toHaveAttribute("data-tab", "sets");
    await expect(page.locator('[data-ring="legs"]')).toHaveClass(/worn/);
    await expect(page.locator('[data-ring="head"]')).toHaveClass(/worn/);
    await expect.poll(async () => (await calls(page, "equip")).map((c) => c.args.join(":"))).toEqual(expect.arrayContaining(["head:head-3", "legs:legs-9"]));
    await expect.poll(async () => (await calls(page, "playAnimationByName")).map((c) => c.args[0])).toContain("69.0");
    await expect(page).toHaveURL(/clip=69\.0/);
    await expect(page.locator("#strip-name")).toHaveText("Dance");
  });

  test("/viewer?id= is the same room, on its Viewer tab", async ({ page }) => {
    await mockPacks(page);
    await page.goto("viewer/?id=human-male");
    await expect(page.locator("#room")).toHaveAttribute("data-tab", "viewer");
    await expect.poll(async () => (await calls(page, "loadModel")).map((c) => c.args[0])).toContain("human-male");
    await expect(page).toHaveURL(/wardrobe\/\?body=human-male/);
    await expect(page.getByTestId("viewer-panels")).toBeVisible();
  });

  test("a failed load keeps the room up and offers a retry", async ({ page }) => {
    await page.addInitScript(() => { (window as unknown as { __engineFail: boolean }).__engineFail = true; });
    await mockPacks(page);
    await openRoom(page);
    await expect(page.locator("#stage-error")).toBeVisible();
    await page.evaluate(() => { (window as unknown as { __engineFail: boolean }).__engineFail = false; });
    await page.locator("#stage-retry").click();
    await expect(page.locator("#stage-error")).toBeHidden();
  });
});

test.describe("the room's other states", () => {
  test("a mount opens on the Viewer tab with the ring out of the way", async ({ page }) => {
    await mockPacks(page);
    await openRoom(page, "?body=mount-1");
    await expect(page.locator("#room")).toHaveAttribute("data-tab", "viewer");
    await expect(page.locator('[data-ring="head"]')).toBeHidden();
    await expect(page.locator('[data-tab-btn="items"]')).toBeHidden();
  });

  test("with no sprites at all it stays whole: CSS frames, CSS ring, no errors", async ({ page }) => {
    await page.route("**/packs/ui/**", (r) => r.fulfill({ status: 404, body: "" }));
    await mockPacks(page);
    const errors = watchErrors(page);
    await openRoom(page);
    await page.waitForTimeout(300);
    await expect(page.locator("html")).not.toHaveAttribute("data-art", "1");
    const frame = page.locator('[data-ring="head"] .slot-frame');
    expect(await frame.evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe("1px");
    await expect(page.locator(".tile").first()).toBeVisible();
    expect(errors).toEqual([]);
    await page.screenshot({ path: "tests/site/results/shots/no_art.png" });
  });

  test("a body that isn't baked says so and asks the engine for nothing", async ({ page }) => {
    await mockPacks(page);
    await page.goto("wardrobe/?body=human-female");
    await expect(page.locator("#stage-error")).toContainText("isn't baked yet");
    expect(await calls(page, "loadModel")).toHaveLength(0);
  });
});

test.describe("the animation strip", () => {
  test("prev, next, play, speed, scrubber; tooltips say Left is previous", async ({ page }) => {
    await mockPacks(page);
    await openRoom(page);
    await expect(page.locator("#strip-play")).toBeEnabled();
    await expect(page.locator("#strip-name")).toHaveText("Stand");
    await page.locator("#strip-next").click();
    await expect(page.locator("#strip-name")).toHaveText("Walk");
    await page.locator("#strip-prev").click();
    await expect(page.locator("#strip-name")).toHaveText("Stand");
    await expect(page.locator("#strip-prev")).toHaveAttribute("data-tip-sub", "Left arrow");
    await expect(page.locator("#strip-next")).toHaveAttribute("data-tip-sub", "Right arrow");
    await page.locator("#strip-play").click();
    await expect(page.locator("#strip-play")).toHaveAttribute("aria-label", "Play");
    await page.locator("#strip-speed").click();
    await expect(page.locator("#strip-speed")).toHaveText("2x");
    // The scrubber moves with no React in the page's path.
    const a = await page.locator("#strip-scrub").inputValue();
    await page.waitForTimeout(200);
    const b = await page.locator("#strip-scrub").inputValue();
    expect(a).not.toBe(b);
    await page.locator("#strip-scrub").fill("0.5");
    await expect.poll(async () => (await calls(page, "setAnimationTime")).at(-1)?.args[0]).toBe(1);
  });
});

test.describe("the Viewer tab", () => {
  test.beforeEach(async ({ page }) => {
    await mockPacks(page);
    await openRoom(page, "?body=human-male&tab=viewer");
    await expect(page.getByTestId("viewer-panels")).toBeVisible();
  });

  test("sections open by default and persist in `accordions`", async ({ page }) => {
    const section = (v: string) => page.locator(`[data-section="${v}"] button.acc-trigger`);
    await expect(section("item-information")).toHaveAttribute("data-state", "open");
    await expect(section("item-animations")).toHaveAttribute("data-state", "open");
    await expect(section("item-options")).toHaveAttribute("data-state", "closed");
    await section("item-options").click();
    await section("item-information").click();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("accordions")!));
    expect(stored).toEqual(expect.arrayContaining(["item-animations", "item-options"]));
    expect(stored).not.toContain("item-information");
    await page.reload();
    await expect(page.getByTestId("viewer-panels")).toBeVisible();
    await expect(section("item-options")).toHaveAttribute("data-state", "open");
    await expect(section("item-information")).toHaveAttribute("data-state", "closed");
  });

  test("clip combobox: T-Pose pinned first, playlist side panel", async ({ page, isMobile }) => {
    await page.getByRole("combobox", { name: "Animations" }).click();
    const rows = page.locator(".clip-row");
    await expect(rows.first()).toContainText("T-Pose");
    await expect(rows).toHaveCount(7);
    await page.locator(".clip-head input").fill("wal");
    await expect(rows).toHaveCount(2);
    await page.locator(".clip-head input").fill("");
    await page.getByRole("button", { name: "Playlist" }).click();
    const list = page.getByTestId("playlist");
    await expect(list).toBeVisible();
    if (!isMobile) expect((await list.boundingBox())!.width).toBe(256);
    await rows.filter({ hasText: "Dance 2" }).click();
    await rows.filter({ hasText: "Run" }).click();
    await expect.poll(async () => (await calls(page, "playPlaylist")).length).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
  });

  test("model parts: visibility, hover, popover with its controls", async ({ page }) => {
    await page.locator('[data-section="item-model-parts"] button.acc-trigger').click();
    await page.locator("#automatic-visibility").click();
    await expect.poll(async () => (await calls(page, "setAutomaticMaterialVisibility")).at(-1)?.args[0]).toBe(false);
    const row = page.locator('[data-part="2"]');
    await row.locator('[role="switch"]').click();
    await expect.poll(async () => (await calls(page, "toggleMaterialByHash")).at(-1)?.args[0]).toBe(2);
    await row.getByRole("button", { name: /settings/ }).click();
    await expect(page.getByLabel("Opacity")).toHaveAttribute("min", "0.1");
    await expect(page.getByLabel("Opacity")).toHaveAttribute("step", "0.01");
    await page.getByLabel("Transparency").click();
    await expect.poll(async () => (await calls(page, "toggleTransparencyByHash")).length).toBe(1);
    await expect(page.getByRole("button", { name: "Replace texture" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Hide all" }).click();
    await expect.poll(async () => (await calls(page, "hideAllParts")).length).toBe(1);
  });

  test("options: switches, background presets and recents, rotation, advanced", async ({ page }) => {
    await page.locator('[data-section="item-options"] button.acc-trigger').click();
    await page.locator("#toggle-shadows").click();
    await expect.poll(async () => (await calls(page, "toggleShadows")).length).toBe(1);
    await page.getByLabel("Auto rotation").fill("1.5");
    await expect.poll(async () => (await calls(page, "setAutoRotationSpeed")).at(-1)?.args[0]).toBe(1.5);
    await page.getByRole("button", { name: "Background colour" }).click();
    await page.getByRole("button", { name: "#00b140" }).click();
    await expect.poll(async () => (await calls(page, "setBackgroundColor")).at(-1)?.args[0]).toBe("#00b140");
    await expect(page.locator("#stage")).toHaveAttribute("data-scene", "off");
    await page.keyboard.press("Escape");
    await page.getByTestId("viewer-panels").getByText("Advanced").click();
    await page.locator("#toggle-skeleton").click();
    await expect.poll(async () => (await calls(page, "toggleSkeleton")).length).toBe(1);
    await expect(page.getByRole("button", { name: "Start XR" })).toHaveCount(0); // stub says no XR
    await page.getByRole("button", { name: "Recenter" }).click();
    await expect.poll(async () => (await calls(page, "centerModel")).length).toBe(1);
  });

  test("export: record badge, png dialog, mp4 progress and cancel, glb dialog", async ({ page }) => {
    await page.locator('[data-section="item-export"] button.acc-trigger').click();
    await page.getByTestId("record").click();
    await expect(page.getByTestId("rec-badge")).toBeVisible();
    await page.getByTestId("rec-badge").getByRole("button", { name: "Stop" }).click();
    await expect(page.getByTestId("rec-badge")).toHaveCount(0);
    await page.getByRole("button", { name: ".png" }).click();
    await expect(page.getByRole("radio", { name: "Medium" })).toBeChecked();
    await page.getByRole("radio", { name: "High" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(async () => (await calls(page, "exportPNG")).at(-1)?.args[0]).toBe(3);
    await page.getByRole("button", { name: ".mp4" }).click();
    await expect(page.getByRole("progressbar")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await page.getByRole("button", { name: ".stl" }).click();
    await expect.poll(async () => (await calls(page, "exportSTL")).length).toBe(1);
    await page.getByRole("button", { name: ".glb" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(async () => (await calls(page, "exportGLB")).at(-1)?.args).toEqual([true, true]);
  });
});

test.describe("customization", () => {
  test("steppers drive geosets and land in the URL", async ({ page }) => {
    await mockPacks(page);
    await openRoom(page, "?body=human-male&tab=customization");
    await expect(page.getByTestId("custom-pane")).toBeVisible();
    await page.getByRole("button", { name: "Next Hair" }).click();
    await expect.poll(async () => (await calls(page, "setGeoset")).at(-1)?.args).toEqual([0, 2]);
    await expect(page).toHaveURL(/geo=0\.2/);
    await expect(page.locator('[data-axis="Hair"] .axis-track')).toHaveText("2 of 3");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.locator('[data-axis="Hair"] .axis-track')).toHaveText("1 of 3");
  });
});

test.describe("panel resize", () => {
  test("drag resizes, past the limit collapses, double-click restores, it persists", async ({ page, isMobile }) => {
    test.skip(isMobile, "phone has no split");
    await mockPacks(page);
    await openRoom(page);
    const room = page.locator(".room");
    const handle = page.locator("#split-handle");
    const start = (await room.boundingBox())!.width;
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x, h.y + 200);
    await page.mouse.down();
    await page.mouse.move(h.x + 120, h.y + 200, { steps: 4 });
    await page.mouse.up();
    const after = (await room.boundingBox())!.width;
    expect(Math.round(after - start)).toBe(120);
    await page.reload();
    await expect.poll(async () => Math.round((await room.boundingBox())!.width)).toBe(Math.round(after));
    // Past half the side panel's minimum, it collapses.
    const h2 = (await handle.boundingBox())!;
    await page.mouse.move(h2.x, h2.y + 200);
    await page.mouse.down();
    await page.mouse.move(1595, h2.y + 200, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator("#split")).toHaveClass(/collapsed/);
    await expect(page.locator("#column")).toBeHidden();
    await handle.dblclick();
    await expect(page.locator("#split")).not.toHaveClass(/collapsed/);
    expect((await room.boundingBox())!.width).toBeLessThanOrEqual(460);
  });
});

test.describe("zero flicker", () => {
  test("CLS is 0 on load, across tabs, on theme switch and during a hover sweep", async ({ page, isMobile }) => {
    await startCls(page);
    await mockPacks(page);
    await openRoom(page);
    await page.waitForTimeout(600);
    expect(await shifts(page)).toEqual([]);
    expect(await cls(page)).toBe(0);

    if (!isMobile) {
      const tiles = page.locator(".tile");
      const n = Math.min(await tiles.count(), 40);
      for (let i = 0; i < n; i += 2) {
        const b = await tiles.nth(i).boundingBox();
        if (b) await page.mouse.move(b.x + 30, Math.min(b.y + 30, 880));
        await page.waitForTimeout(16);
      }
      await page.waitForTimeout(200);
      await page.mouse.move(600, 890);
    }
    expect(await shifts(page)).toEqual([]);

    for (const tab of ["sets", "customization", "viewer", "items"]) {
      await page.locator(`[data-tab-btn="${tab}"]`).click();
      await page.waitForTimeout(120);
    }
    await page.locator("#theme-btn").click();
    await page.waitForTimeout(150);
    expect(await shifts(page)).toEqual([]);
    expect(await cls(page)).toBe(0);
  });

  test("the canvas is one element for the life of the page", async ({ page }) => {
    await mockPacks(page);
    await openRoom(page);
    await page.evaluate(() => { (window as unknown as { __c: Element }).__c = document.getElementById("canvas")!; });
    for (const tab of ["sets", "customization", "viewer", "items", "viewer"]) {
      await page.locator(`[data-tab-btn="${tab}"]`).click();
      const same = await page.evaluate(() => (window as unknown as { __c: Element }).__c === document.getElementById("canvas") && (window as unknown as { __c: Element }).__c.isConnected);
      expect(same).toBe(true);
    }
    expect(await calls(page, "mount")).toHaveLength(1);
  });

  test("the stage does not move or resize when the tab changes", async ({ page, isMobile }) => {
    await mockPacks(page);
    await openRoom(page);
    const box = await page.locator("#stage").boundingBox();
    for (const tab of ["sets", "customization", "viewer"]) {
      await page.locator(`[data-tab-btn="${tab}"]`).click();
      expect(await page.locator("#stage").boundingBox()).toEqual(box);
    }
    expect(isMobile !== undefined).toBe(true);
  });

  test("the first paint already has the right tab, from the URL", async ({ page }) => {
    await mockPacks(page);
    await page.addInitScript(() => {
      // Sample the tab the moment the body has parsed, before any module script runs.
      const w = window as unknown as { __firstTab?: string };
      document.addEventListener("readystatechange", () => {
        if (document.readyState === "interactive") w.__firstTab = document.getElementById("room")?.dataset.tab;
      }, { once: true });
    });
    await page.goto("wardrobe/?body=human-male&tab=viewer");
    expect(await page.evaluate(() => (window as unknown as { __firstTab?: string }).__firstTab)).toBe("viewer");
  });
});

test.describe("keyboard", () => {
  test("Ctrl+K works from the room; Escape clears the catalogue search", async ({ page }) => {
    await mockPacks(page);
    await openRoom(page);
    await page.locator("#q").fill("bronze");
    await page.keyboard.press("Escape");
    await expect(page.locator("#q")).toHaveValue("");
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("search-dialog")).toBeVisible();
  });

  test("the splitter takes arrow keys without moving the clip", async ({ page, isMobile }) => {
    test.skip(isMobile, "phone has no split");
    await mockPacks(page);
    await openRoom(page);
    const before = (await page.locator(".room").boundingBox())!.width;
    await page.locator("#split-handle").focus();
    await page.keyboard.press("ArrowRight");
    expect((await page.locator(".room").boundingBox())!.width).toBeGreaterThan(before);
    await expect(page.locator("#split-handle")).toHaveAttribute("data-ignore-arrows-shortcuts", "true");
  });
});
