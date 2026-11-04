import { expect, test, type Page } from "@playwright/test";
import { calls, cls, fixtureCatalog, mockPacks, openRoom, startCls, watchErrors } from "./helpers";

/**
 * The grid's cards: figure cells only. A baked poster on retail's frame, one live canvas
 * under a resting pointer, and no game icon in any of them. Against the stub engine: every
 * number here is about the page, and the real engine's first frame against its poster is
 * proven in tests/parity/cells.pw.ts.
 */
const WEBP = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

interface MountRow {
  id: string;
  name: string;
  circle: string;
  tile: string;
  poster?: string;
  mountId: number;
  flying: boolean;
  variants: { id: string; display: number; name: string; icon: string; mountId: number; poster?: string }[];
}

const LONG_NAME = "Reins of the Extremely Long Named Thunderous Armored Proto-Drake of the Northern Wind";

function mounts(n: number, posters: (i: number) => boolean = () => true): MountRow[] {
  return Array.from({ length: n }, (_, i) => {
    const colours = i % 5 === 0 ? 11 : i % 3 === 0 ? 3 : 1;
    const poster = posters(i) ? `objects/${(i + 1).toString(16).padStart(16, "0")}.webp` : undefined;
    const name = i === 1 ? LONG_NAME : `Mount ${i}`;
    return {
      id: `mount-${i}`, name, circle: "objects/icon.webp", tile: "", mountId: i, flying: i % 2 === 0,
      ...(poster ? { poster } : {}),
      variants: Array.from({ length: colours }, (_, v) => ({ id: `mountd-${i * 100 + v}`, display: i * 100 + v, name: v ? `${name} tint ${v}` : name, icon: "objects/icon.webp", mountId: i, ...(poster ? { poster } : {}) })),
    };
  });
}

async function serveMounts(page: Page, rows: MountRow[]) {
  await page.route("**/packs/catalog/mounts.json", (r) => r.fulfill({ json: rows }));
  await page.route("**/packs/objects/**", (r) => r.fulfill({ body: WEBP, contentType: "image/webp" }));
}

const figures = (page: Page) => page.evaluate(() => (window as unknown as { __figures?: Set<unknown> }).__figures?.size ?? 0);
const peak = (page: Page) => page.evaluate(() => (window as unknown as { __postersPeak?: number }).__postersPeak ?? 0);
const asks = (page: Page) => page.evaluate(() => (window as unknown as { __posterAsks?: number }).__posterAsks ?? 0);

test.describe("the Mounts page", () => {
  test("a card per animal: poster on the frame, the name under it, the count in its corner", async ({ page }) => {
    const errors = watchErrors(page);
    await serveMounts(page, mounts(60));
    await page.goto("mounts/");
    const card = page.locator(".tile").first();
    await expect(card).toBeVisible();
    await expect(page.locator(".letter, .circle-link")).toHaveCount(0);
    await expect(card.locator(".tile-poster")).toHaveAttribute("src", /objects\/0+1\.webp/);

    const art = (await card.boundingBox())!;
    expect(Math.abs(art.width / art.height - 100 / 132)).toBeLessThan(0.002);
    const name = (await card.locator(".tile-name").boundingBox())!;
    expect(name.y).toBeGreaterThanOrEqual(art.y + art.height);
    const badge = (await card.locator(".tile-badge").boundingBox())!;
    await expect(card.locator(".tile-badge")).toHaveText("11");
    expect(badge.x + badge.width).toBeLessThanOrEqual(art.x + art.width);
    expect(badge.y).toBeGreaterThanOrEqual(art.y);
    expect(badge.y + badge.height).toBeLessThanOrEqual(name.y);
    // Retail's frame reaches past the card, and the live canvas draws inside it.
    const frame = (await card.locator(".tile-frame").boundingBox())!;
    expect(frame.width).toBeGreaterThan(art.width);
    expect(frame.height).toBeGreaterThan(art.height);

    // A mount with one colour has no badge, not an empty one.
    await expect(page.locator(".tile").nth(2).locator(".tile-badge")).toBeHidden();
    // The long name stops at two lines, inside its box, and never reaches the next row.
    const long = page.locator(".tile").nth(1).locator(".tile-name");
    const clamp = await long.evaluate((e) => ({ scroll: e.scrollHeight, client: e.clientHeight, line: parseFloat(getComputedStyle(e).lineHeight) }));
    expect(clamp.client).toBeLessThanOrEqual(clamp.line * 2 + 1);
    expect(clamp.scroll).toBeGreaterThan(clamp.client);
    const rowBelow = (await page.locator(".grid-row:not([hidden])").nth(1).boundingBox())!;
    expect(name.y + name.height).toBeLessThan(rowBelow.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // No game icon anywhere in a cell.
    await expect(page.locator(".tile img:not(.tile-poster)")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("forty thousand rows: the same few elements, 60 fps, no layout shift, no posters thrown away", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop numbers");
    await startCls(page);
    // What the page itself spends per frame. A frame's interval also holds whatever the other
    // test worker is doing to this machine, so that one is logged and the work is the gate.
    await page.addInitScript(() => {
      const w = window as unknown as { __work: number[] };
      w.__work = [];
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (f) =>
        raf((t) => {
          const at = performance.now();
          f(t);
          w.__work.push(performance.now() - at);
        });
    });
    const asked: string[] = [];
    page.on("request", (r) => { if (/objects\/[0-9a-f]{16}\.webp/.test(r.url())) asked.push(r.url()); });
    await serveMounts(page, mounts(40_000));
    await page.goto("mounts/");
    await expect(page.locator(".tile").first()).toBeVisible();
    await page.waitForTimeout(400);
    expect(await page.locator("#mount-count").textContent()).toBe("40,000");
    expect(await page.locator(".tile").count()).toBeLessThan(60);
    // A page of cards is about forty posters, and at the baker's 8 KB under 500 KB.
    const firstPage = asked.length;
    console.log("posters on the first page", firstPage);
    expect(firstPage).toBeLessThanOrEqual(48);
    expect(firstPage * 8 * 1024).toBeLessThan(500 * 1024);

    const scroll = await page.evaluate(async () => {
      const s = document.getElementById("mount-scroll")!;
      const gaps: number[] = [];
      let most = 0;
      let last = performance.now();
      for (let i = 0; i < 240; i++) {
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        s.scrollTop += 180;
        most = Math.max(most, document.querySelectorAll(".tile").length);
      }
      gaps.sort((a, b) => a - b);
      const work = [...(window as unknown as { __work: number[] }).__work].sort((a, b) => a - b);
      return { p50: gaps[120]!, p95: gaps[228]!, most, workP50: work[work.length >> 1]!, workP95: work[Math.floor(work.length * 0.95)]!, workMax: work.at(-1)! };
    });
    console.log("mounts scroll over 40,000 rows, ms", scroll);
    expect(scroll.p50).toBeLessThan(18);
    // Well inside a 60 fps frame's 16.7 ms, on the slowest frames too.
    expect(scroll.workP95).toBeLessThan(8);
    expect(scroll.most).toBeLessThan(90);

    // A fling: views per frame, and only where it lands asks for anything.
    const before = asked.length;
    await page.evaluate(async () => {
      const s = document.getElementById("mount-scroll")!;
      for (let i = 0; i < 120; i++) {
        await new Promise(requestAnimationFrame);
        s.scrollTop += 4000;
      }
    });
    await page.waitForTimeout(200);
    const flung = asked.length - before;
    console.log("posters asked for over a fling across 480,000 px, 16,000 of them passed", flung);
    expect(flung).toBeLessThan(200);
    expect(await cls(page)).toBeLessThan(0.001);
  });

  test("while a poster is on its way: the empty card, a quiet ring, and nothing moves when it lands", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop");
    await startCls(page);
    await page.route("**/packs/catalog/mounts.json", (r) => r.fulfill({ json: mounts(30) }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => { release = res; });
    await page.route("**/packs/objects/**", async (r) => {
      await gate;
      await r.fulfill({ body: WEBP, contentType: "image/webp" });
    });
    await page.goto("mounts/");
    const card = page.locator(".tile").nth(1);
    await expect(card).toBeVisible();
    const ring = card.locator(".tile-ring");
    await expect(ring).toBeVisible();
    const boxRing = (await ring.boundingBox())!;
    const waiting = (await card.boundingBox())!;
    expect(Math.abs(boxRing.x + boxRing.width / 2 - (waiting.x + waiting.width / 2))).toBeLessThan(1);
    expect(Math.abs(boxRing.y + boxRing.height / 2 - (waiting.y + waiting.height / 2))).toBeLessThan(1);
    await expect(page.locator(".tile img:not(.tile-poster), .tile-ico")).toHaveCount(0);
    release();
    await expect(card.locator(".tile-poster[data-ok]")).toBeVisible();
    await expect(ring).toBeHidden();
    expect(await card.boundingBox()).toEqual(waiting);
    expect(await cls(page)).toBe(0);
  });

  test("not baked yet: each card still fills with the picture, a few at a time, and it scrolls no wider", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop");
    await startCls(page);
    const asked: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/objects/")) asked.push(r.url()); });
    await serveMounts(page, mounts(200, () => false));
    await page.goto("mounts/");
    const cards = page.locator(".grid-row:not([hidden]) .tile");
    await expect(cards.first()).toBeVisible();
    const n = await cards.count();
    expect(n).toBeGreaterThan(10);
    await expect(page.locator(".grid-row:not([hidden]) .tile-poster[data-ok]")).toHaveCount(n, { timeout: 20_000 });
    console.log("cells drawn at once, at most", await peak(page), "of", n);
    expect(await peak(page)).toBeLessThanOrEqual(3);
    // Not one icon was asked for, and every card stayed its size.
    expect(asked).toEqual([]);
    expect(await cls(page)).toBe(0);
    // And it is done: nothing runs when they have landed.
    expect(await page.evaluate(() => (window as unknown as { __postersDrawing?: number }).__postersDrawing ?? 0)).toBe(0);
    // Asked once each: back to the same card, the picture is already here.
    const before = await asks(page);
    await page.evaluate(() => { document.getElementById("mount-scroll")!.scrollTop = 900; });
    await page.waitForTimeout(600);
    await page.evaluate(() => { document.getElementById("mount-scroll")!.scrollTop = 0; });
    await page.waitForTimeout(600);
    const drawnOnScrollBack = (await asks(page)) - before;
    console.log("drawn over a scroll down and back", drawnOnScrollBack);
    expect(drawnOnScrollBack).toBeLessThanOrEqual(n);
  });

  test("the engine isn't asked for until a pointer rests, and first load stays under budget", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop");
    const sizes = new Map<string, number>();
    page.on("response", (r) => {
      const u = r.url();
      if (/\.(js|css)(\?|$)/.test(u) || u.endsWith("/mounts/")) sizes.set(u, Number(r.headers()["content-length"] ?? 0));
    });
    let bytes = 0;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    const kinds = new Map<string, string>();
    cdp.on("Network.responseReceived", (e) => kinds.set(e.requestId, e.type));
    cdp.on("Network.loadingFinished", (e) => {
      const t = kinds.get(e.requestId);
      if (t === "Document" || t === "Script" || t === "Stylesheet") bytes += e.encodedDataLength;
    });
    await serveMounts(page, mounts(200));
    await page.goto("mounts/");
    await expect(page.locator(".tile").first()).toBeVisible();
    await page.waitForTimeout(300);
    console.log("mounts first load, JS, CSS and HTML on the wire", bytes);
    expect(bytes).toBeLessThan(150 * 1024);
    expect(await page.locator("canvas").count()).toBe(0);
    expect(await figures(page)).toBe(0);
    expect(await asks(page)).toBe(0);
    expect([...sizes.keys()].some((u) => /three|engine|cells/i.test(u))).toBe(false);
  });

  test("the page does nothing at rest: no animation frame is asked for", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop");
    await page.addInitScript(() => {
      const w = window as unknown as { __raf: number };
      w.__raf = 0;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (f) => {
        w.__raf++;
        return raf(f);
      };
    });
    await serveMounts(page, mounts(200));
    await page.goto("mounts/");
    await expect(page.locator(".tile").first()).toBeVisible();
    await page.waitForTimeout(600);
    const at = await page.evaluate(() => (window as unknown as { __raf: number }).__raf);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __raf: number }).__raf)).toBe(at);
  });

  test("hover: nothing before the rest, a sweep wakes nothing, the poster stays to the first frame, and leaving hands back", async ({ page, isMobile }) => {
    test.skip(isMobile, "a phone has no hover");
    const errors = watchErrors(page);
    await serveMounts(page, mounts(100));
    await page.goto("mounts/");
    const cards = page.locator(".tile");
    await expect(cards.first()).toBeVisible();
    await expect(cards.nth(3).locator(".tile-poster[data-ok]")).toBeVisible();

    // A sweep across the row, faster than the rest: no chunk, no cell, no canvas.
    for (let i = 0; i < 6; i++) {
      await cards.nth(i).hover();
      await page.waitForTimeout(40);
    }
    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
    expect(await figures(page)).toBe(0);
    await expect(page.locator(".tile.live")).toHaveCount(0);

    // A log of every frame from before the rest to after it has gone live and come back.
    await page.evaluate(() => {
      const w = window as unknown as { __log: { live: boolean; opacity: number; figures: number }[]; __stop: boolean; __figures?: Set<unknown> };
      w.__log = [];
      w.__stop = false;
      const el = document.querySelectorAll<HTMLElement>(".tile")[3]!;
      const poster = el.querySelector<HTMLElement>(".tile-poster")!;
      const tick = () => {
        if (w.__stop) return;
        w.__log.push({ live: el.classList.contains("live"), opacity: Number(getComputedStyle(poster).opacity), figures: w.__figures?.size ?? 0 });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const card = cards.nth(3);
    const t0 = Date.now();
    await card.hover();
    await expect(card).toHaveClass(/live/);
    const tookMs = Date.now() - t0;
    console.log("live after", tookMs, "ms");
    expect(tookMs).toBeGreaterThanOrEqual(140);
    expect(await figures(page)).toBe(1);
    await page.waitForTimeout(200);
    await page.mouse.move(2, 2);
    await expect(card).not.toHaveClass(/live/);
    await page.waitForTimeout(100);
    const log = await page.evaluate(() => {
      const w = window as unknown as { __log: { live: boolean; opacity: number; figures: number }[]; __stop: boolean };
      w.__stop = true;
      return w.__log;
    });
    expect(await figures(page)).toBe(0);
    // Until the first live frame, the poster is whole: every frame, no exception.
    const firstLive = log.findIndex((f) => f.live);
    expect(firstLive).toBeGreaterThan(0);
    for (const f of log.slice(0, firstLive)) expect(f.opacity).toBe(1);
    // A live class never stands without a cell behind it.
    for (const f of log) if (f.live) expect(f.figures).toBe(1);
    // The frame after it leaves, the poster is back in full.
    const lastLive = log.length - 1 - [...log].reverse().findIndex((f) => f.live);
    expect(log[lastLive + 1]!.opacity).toBe(1);
    expect(errors).toEqual([]);
  });

  test("a click opens the stage; search and the chips cut the list, by colour names too", async ({ page }) => {
    await serveMounts(page, mounts(50));
    await page.goto("mounts/");
    await expect(page.locator(".tile").first()).toBeVisible();
    await expect(page.locator(".tile").nth(4)).toHaveAttribute("href", /mounts\/view\/\?id=mount-4$/);
    await page.locator('[data-cat="flying"]').click();
    await expect(page.locator("#mount-count")).toHaveText("25");
    await expect(page.locator(".tile-name", { hasText: /^Mount 0$/ })).toBeVisible();
    await expect(page.locator(".tile-name:visible", { hasText: /^Mount 1$/ })).toHaveCount(0);
    await page.locator('[data-cat="ground"]').click();
    await expect(page.locator("#mount-count")).toHaveText("25");
    await page.locator('[data-cat="all"]').click();
    await page.locator("#mount-q").fill("Mount 5 tint 3");
    await expect(page.locator("#mount-count")).toHaveText("1");
    await page.locator("#mount-q").fill("no such thing");
    await expect(page.locator("#mount-empty")).toContainText("No mounts match");
    await expect(page.locator(".tile:visible")).toHaveCount(0);
    await page.locator("#mount-q").fill("");
    await page.locator('.tile[data-mount="mount-0"]').click();
    await expect(page).toHaveURL(/mounts\/view\/\?id=mount-0/);
  });
});

test.describe("the wardrobe's cells", () => {
  function withPosters() {
    const c = fixtureCatalog(120) as { items: { id: string; poster?: string; posterFemale?: string; icon: string }[]; sets: { id: string; poster?: string; posterFemale?: string }[] };
    c.items.forEach((it, i) => {
      // Every fortieth isn't baked yet, and has an icon it must never show.
      it.icon = "objects/icon.webp";
      if (i % 40 === 39) return;
      it.poster = `objects/${(i + 1).toString(16).padStart(16, "a")}.webp`;
      it.posterFemale = `objects/${(i + 1).toString(16).padStart(16, "b")}.webp`;
    });
    c.sets.forEach((s, i) => {
      s.poster = `objects/${(i + 1).toString(16).padStart(16, "c")}.webp`;
      s.posterFemale = `objects/${(i + 1).toString(16).padStart(16, "d")}.webp`;
    });
    return c;
  }

  // The site's own catalogue has only some bodies baked: this waits for the engine, not for a model.
  const openBody = async (page: Page, body: string) => {
    await page.goto(`wardrobe/?body=${body}`);
    await page.waitForFunction(() => (window as unknown as { __engineCalls?: { name: string }[] }).__engineCalls?.some((c) => c.name === "mount"));
  };

  const serve = async (page: Page, catalog: unknown) => {
    await mockPacks(page, { catalog });
    await page.route("**/packs/objects/**", (r) => r.fulfill({ body: WEBP, contentType: "image/webp" }));
  };

  test("there is no Icons mode and no icon in a cell: a cell is a poster on a card", async ({ page }) => {
    await serve(page, withPosters());
    await openRoom(page);
    await expect(page.locator("[data-grid-mode]")).toHaveCount(0);
    await expect(page.locator(".tile:not(.hide) .tile-poster").first()).toHaveAttribute("src", /objects\/a+1\.webp/);
    await expect(page.locator(".tile-ico, .tile-pieces, .tile-glyph")).toHaveCount(0);
    await expect(page.locator(".tile img:not(.tile-poster)")).toHaveCount(0);
  });

  test("a female body gets the female poster", async ({ page }) => {
    await serve(page, withPosters());
    await openBody(page, "human-female");
    await expect(page.locator(".tile:not(.hide) .tile-poster").first()).toHaveAttribute("src", /objects\/b+1\.webp/);
  });

  test("an item with no poster fills from the engine, on this body, a few at a time, and its icon is never asked for", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop");
    await startCls(page);
    const icons: string[] = [];
    page.on("request", (r) => { if (r.url().includes("icon.webp")) icons.push(r.url()); });
    const catalog = fixtureCatalog(120, ["objects/icon.webp"]);
    await serve(page, catalog);
    await openBody(page, "orc-female");
    const tiles = page.locator(".grid-row:not([hidden]) .tile:not(.hide)");
    await expect(tiles.first()).toBeVisible();
    const n = await tiles.count();
    await expect(page.locator(".grid-row:not([hidden]) .tile:not(.hide) .tile-poster[data-ok]")).toHaveCount(n, { timeout: 20_000 });
    console.log("wardrobe, cells drawn at once, at most", await peak(page), "of", n);
    expect(await peak(page)).toBeLessThanOrEqual(3);
    const specs = await page.evaluate(() => (window as unknown as { __posterSpecs: { bodyId: string; itemId?: string }[] }).__posterSpecs);
    expect(specs.every((s) => s.bodyId === "orc-female" && !!s.itemId)).toBe(true);
    expect(icons).toEqual([]);
    expect(await cls(page)).toBe(0);
  });

  test("sets are whole figures, their names under them, big enough to read", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop");
    await serve(page, withPosters());
    await openRoom(page);
    await page.locator('[data-tab-btn="sets"]').click();
    const set = page.locator(".tile.set").first();
    await expect(set).toBeVisible();
    await expect(set.locator(".tile-poster")).toHaveAttribute("src", /objects\/c+[0-9a-f]+\.webp/);
    const art = (await set.boundingBox())!;
    const name = (await set.locator(".tile-name").boundingBox())!;
    expect(name.y).toBeGreaterThanOrEqual(art.y + art.height);
    expect(art.width).toBeGreaterThan(90);
  });

  test("hover tries it on the stage and wakes one live cell on the current body; leaving lets go of both", async ({ page, isMobile }) => {
    test.skip(isMobile, "a phone has no hover");
    const errors = watchErrors(page);
    await serve(page, withPosters());
    await openBody(page, "orc-male");
    const tile = page.locator(".tile:not(.hide)").nth(1);
    await expect(tile.locator(".tile-poster")).toBeVisible();
    await tile.hover();
    await expect(tile).toHaveClass(/live/);
    await expect.poll(async () => (await calls(page, "previewEquip")).length).toBeGreaterThan(0);
    expect(await figures(page)).toBe(1);
    const asked = (await calls(page, "addFigureCell")).at(-1)!.args[1] as { bodyId: string; itemId: string; effects: boolean };
    expect(asked.bodyId).toBe("orc-male");
    expect(asked.itemId).toBe("head-1");
    expect(asked.effects).toBe(true);
    // The next card takes over: one live cell, never two.
    const next = page.locator(".tile:not(.hide)").nth(2);
    await next.hover();
    await expect(next).toHaveClass(/live/);
    await expect(tile).not.toHaveClass(/live/);
    expect(await figures(page)).toBe(1);
    await page.mouse.move(2, 2);
    await expect(next).not.toHaveClass(/live/);
    expect(await figures(page)).toBe(0);
    expect(errors).toEqual([]);
  });
});
