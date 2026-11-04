import { expect, test, type Page } from "@playwright/test";
import { OUT, PACKS, REAL, SLOTS, clean, frames, openStage, pct, sampleItems, sampleSets, stage, throttle, wear, wearAll, whitePixels } from "./helpers";

/**
 * What the owner reported, on real packs: wearing "holds old items, shows white textures and
 * takes a lot of time", and preview "takes forever". Numbers decide; the screenshots in
 * tests/wear/results/shots are there to be looked at.
 */

// --- Stale ---------------------------------------------------------------------------------

async function tileAt(page: Page, i: number) {
  const box = await page.evaluate((n) => {
    const list = [...document.querySelectorAll<HTMLElement>(".tile")]
      .filter((t) => !t.classList.contains("hide") && t.style.visibility !== "hidden")
      .map((t) => t.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.top >= 0 && r.bottom <= innerHeight)
      .sort((a, b) => a.top - b.top || a.left - b.left);
    const r = list[Math.min(n, list.length - 1)]!;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, i);
  return box;
}

const settled = (page: Page) =>
  page.waitForFunction(
    () => {
      const wd = (window as never as { eclipse: { wardrobe: { committed: Map<string, string>; previews: Map<string, string>; worn: Map<string, { id: string }>; applying: boolean } } }).eclipse.wardrobe;
      const wish = new Map(wd.committed);
      for (const [s, i] of wd.previews) wish.set(s, i);
      if (wd.applying || wish.size !== wd.worn.size) return false;
      for (const [s, i] of wish) if (wd.worn.get(s)?.id !== i) return false;
      return true;
    },
    undefined,
    { timeout: 60_000, polling: 25 },
  );

test("hover, click, sets, ring, body: after every step the figure holds exactly what is asked for", async ({ page }) => {
  const errors = await openStage(page);
  await page.locator(".tabs [data-tab-btn='items']").click();
  await page.waitForSelector(".tile", { timeout: 30_000 });

  // Several items, fast: the last one stands.
  for (const i of [2, 3, 4, 5, 6, 7]) {
    const at = await tileAt(page, i);
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(35);
  }
  await page.waitForTimeout(150);
  await settled(page);
  let s = await clean(page, "hover burst");
  expect(Object.keys(s.previews)).toHaveLength(1);
  expect(Object.keys(s.committed)).toHaveLength(0);

  // Click, then another in the same slot: one piece's worth on the body.
  const a = await tileAt(page, 7);
  await page.mouse.click(a.x, a.y);
  await settled(page);
  s = await clean(page, "click");
  const first = Object.values(s.committed)[0];
  expect(first).toBeTruthy();
  const b = await tileAt(page, 9);
  await page.mouse.click(b.x, b.y);
  await settled(page);
  s = await clean(page, "second click in the slot");
  expect(Object.keys(s.committed)).toHaveLength(1);
  expect(Object.values(s.committed)[0]).not.toBe(first);

  // Off the grid: the preview comes off.
  await page.mouse.move(700, 300);
  await page.waitForTimeout(1700);
  await settled(page);
  s = await clean(page, "left the grid");
  expect(s.previews).toEqual({});

  // Sets: a hover, a click, another: a set replaces the whole look.
  await page.locator("[data-tab-btn='sets']").click();
  await page.locator("[data-line='midnight']").click();
  await page.waitForTimeout(800);
  await page.waitForSelector(".tile.set", { timeout: 30_000 });
  const t1 = await tileAt(page, 1);
  await page.mouse.move(t1.x, t1.y);
  await page.waitForTimeout(180);
  await settled(page);
  s = await clean(page, "hover a set");
  await page.mouse.click(t1.x, t1.y);
  await settled(page);
  s = await clean(page, "click a set");
  const wornSet = { ...s.committed };
  expect(Object.keys(wornSet).length).toBeGreaterThan(1);
  await page.screenshot({ path: `${OUT}/ui-set.png` });
  const t2 = await tileAt(page, 4);
  await page.mouse.click(t2.x, t2.y);
  await settled(page);
  s = await clean(page, "another set");
  await page.mouse.move(700, 300);
  await page.waitForTimeout(1700);
  await settled(page);
  s = await clean(page, "left the sets");
  // Nothing of the first set that the second doesn't name.
  const ring = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-ring].worn")].map((e) => e.dataset.ring!));
  expect(ring.sort()).toEqual(Object.keys(s.committed).sort());

  // The ring takes one off.
  const off = ring[0]!;
  await page.locator(`[data-ring='${off}']`).click({ button: "right" });
  await settled(page);
  s = await clean(page, "ring release");
  expect(s.committed[off]).toBeUndefined();

  // Another body with all that on.
  await page.evaluate(() => (window as never as { eclipse: { loadModel(id: string): Promise<void> } }).eclipse.loadModel("orc-female"));
  await settled(page);
  const before = s.committed;
  s = await clean(page, "another body");
  expect(s.body).toBe("orc-female");
  expect(s.committed).toEqual(before);
  await page.screenshot({ path: `${OUT}/ui-body.png` });
  expect(errors).toEqual([]);
});

test("one object that won't load costs only its own slot: everything after it still lands", async ({ page }) => {
  await openStage(page);
  await wear(page, "head", "item-713613");
  await page.route(/items\/item-743253\/manifest\.json/, (r) => r.fulfill({ status: 503, body: "x" }));
  const old = await stage(page);
  expect(old.showing.head).toBe("item-713613");
  await wear(page, "shoulder", "item-743253");
  await wear(page, "head", "item-747827");
  await wear(page, "mainhand", "item-684655");
  await frames(page, 3);
  const s = await stage(page);
  expect(s.showing.head, "the old helm has gone").toBe("item-747827");
  expect(s.showing.mainhand).toBe("item-684655");
  expect(s.showing.shoulder, "what can't load shows nothing, and no old piece").toBeUndefined();
  expect(s.stale).toEqual([]);
  // It heals on the next ask.
  await page.unroute(/items\/item-743253\/manifest\.json/);
  await wear(page, "shoulder", "item-743253");
  expect((await stage(page)).showing.shoulder).toBe("item-743253");
});

test("a request R2 fails once is asked again: the wear still lands", async ({ page }) => {
  await openStage(page);
  let failed = 0;
  await page.route(/items\/item-747827\/manifest\.json/, (r) => {
    if (failed++ === 0) return r.fulfill({ status: 503, body: "x" });
    return r.continue();
  });
  await wear(page, "head", "item-747827");
  expect(failed).toBe(2);
  expect((await stage(page)).showing.head).toBe("item-747827");
});

test("a late answer never overwrites a newer hover", async ({ page }) => {
  await openStage(page);
  // A's manifest is held back well past B's landing.
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route(/items\/item-731139\/manifest\.json/, async (r) => {
    await held;
    await r.continue().catch(() => undefined);
  });
  const log = await page.evaluate(async () => {
    const e = (window as never as { eclipse: { previewEquip(s: string, i: string | null): Promise<void>; wardrobe: { worn: Map<string, { id: string }> } } }).eclipse;
    void e.previewEquip("head", "item-731139");
    await new Promise((r) => setTimeout(r, 50));
    await e.previewEquip("head", "item-726031");
    return e.wardrobe.worn.get("head")?.id;
  });
  expect(log).toBe("item-726031");
  release();
  await page.waitForTimeout(1500);
  const s = await clean(page, "after the late answer");
  expect(s.showing.head).toBe("item-726031");
});

test("taking something off while a new body loads is not lost", async ({ page }) => {
  await openStage(page);
  await wearAll(page, { head: "item-713613", mainhand: "item-684655" });
  const r = await page.evaluate(async () => {
    const e = (window as never as { eclipse: { loadModel(id: string): Promise<void>; equip(s: string, i: string | null): Promise<void>; wardrobe: { committedEntries(): [string, string][] } } }).eclipse;
    const load = e.loadModel("orc-female");
    await new Promise((r) => setTimeout(r, 60));
    await e.equip("head", null);
    await load;
    return e.wardrobe.committedEntries();
  });
  expect(r).toEqual([["mainhand", "item-684655"]]);
  await page.waitForFunction(() => {
    const wd = (window as never as { eclipse: { wardrobe: { worn: Map<string, unknown> } } }).eclipse.wardrobe;
    return !wd.worn.has("head") && wd.worn.has("mainhand");
  });
  await clean(page, "released during the swap");
});

test("a set's combined model: the gloves show the gloves' parts, not the whole armour", async ({ page }) => {
  await openStage(page);
  await wear(page, "hands", REAL.combinedGloves);
  const shown = await page.evaluate(() => {
    const wd = (window as never as { eclipse: { wardrobe: { pieces: { figure: { parts: { mesh: { visible: boolean }; extras: { geoset: number } }[] } }[] } } }).eclipse.wardrobe;
    return wd.pieces.flatMap((p) => p.figure.parts.filter((q) => q.mesh.visible).map((q) => q.extras.geoset));
  });
  for (const g of shown) expect(g < 100 || [4, 23].includes(Math.floor(g / 100)), `geoset ${g} belongs to another slot`).toBe(true);
});

// --- White ---------------------------------------------------------------------------------

test("no batch draws from a slot nothing fills: the white sheets are gone", async ({ page }) => {
  await openStage(page);
  await page.locator(".tabs [data-tab-btn='viewer']").click().catch(() => undefined);
  const naked = (await whitePixels(page)).biggestFraction;
  for (const [slot, id] of REAL.unbound) {
    await wear(page, slot, id);
    await frames(page, 4);
    const s = await stage(page);
    expect(s.white, `${id}: batches on the placeholder`).toEqual([]);
    const px = await whitePixels(page);
    expect(px.biggestFraction, `${id}: a white blob on the figure`).toBeLessThan(Math.max(naked, 0.01) + 0.01);
    await wear(page, slot, null);
  }
});

test("a cloak with its own model never shows the body's cape in white", async ({ page }) => {
  await openStage(page);
  await wear(page, "back", REAL.capeWithModel);
  await frames(page, 4);
  const s = await stage(page);
  expect(s.white).toEqual([]);
  expect((await whitePixels(page)).biggestFraction).toBeLessThan(0.05);
});

for (const body of ["dracthyr-male", "bloodelf-female", "gilnean-male"]) {
  test(`a look's own texture slots keep their art when something is worn: ${body}`, async ({ page }) => {
    await openStage(page, body);
    await frames(page, 4);
    expect((await stage(page)).white, "before").toEqual([]);
    const shown = () => page.evaluate(() => (window as never as { eclipse: { internals: { visibleGeosets(): number[] } } }).eclipse.internals.visibleGeosets().length);
    const before = await shown();
    await wear(page, "wrist", "item-744258");
    await frames(page, 4);
    expect((await stage(page)).white, "after a wear").toEqual([]);
    expect((await whitePixels(page)).biggestFraction).toBeLessThan(0.06);
    // Wearing a bracer takes nothing of the body's own away.
    expect(await shown()).toBeGreaterThanOrEqual(before - 1);
    await page.locator("#canvas").screenshot({ path: `${OUT}/body-${body}.png` });
  });
}

test("every unit on UV set 2 reads it: the flame cards are masked, not rectangles", async ({ page }) => {
  await openStage(page);
  await page.locator(".tabs [data-tab-btn='viewer']").click().catch(() => undefined);
  const sets = (await (await fetch(`${PACKS}/catalog/sets/midnight.json`)).json()) as { id: string; pieces: Record<string, string> }[];
  await wearAll(page, sets.find((s) => s.id === REAL.flameSetId)!.pieces);
  await frames(page, 20);
  const r = await page.evaluate(() => {
    const e = (window as never as { eclipse: { renderer: { properties: { get(m: unknown): { currentProgram?: { getAttributes(): Record<string, unknown> } } } }; wardrobe: { pieces: { figure: { parts: { mesh: { geometry: { attributes: Record<string, unknown> } }; material: unknown; extras: { units: { uvSet: number }[] } }[] } }[] } } }).eclipse;
    let two = 0;
    let read = 0;
    for (const p of e.wardrobe.pieces) {
      for (const q of p.figure.parts) {
        if (!q.extras.units.some((u) => u.uvSet === 1)) continue;
        two++;
        if (e.renderer.properties.get(q.material).currentProgram?.getAttributes().uv1 !== undefined) read++;
      }
    }
    return { two, read };
  });
  expect(r.two).toBeGreaterThan(0);
  expect(r.read).toBe(r.two);
  // The picture: the cards stood as tall rectangles past the top of the stage, lighting 70 to 86%
  // of its top rows (measured, this set and its Mythic twin). A masked flame ends in a tip: 0.5 to 2%.
  const lit = await page.evaluate(async () => {
    const g = await (window as never as { __grab(): Promise<{ W: number; H: number; data: Uint8ClampedArray }> }).__grab();
    const band = Math.floor(g.H * 0.04);
    let n = 0;
    for (let y = 0; y < band; y++) {
      for (let x = 0; x < g.W; x++) {
        const i = (y * g.W + x) * 4;
        const peak = Math.max(g.data[i]!, g.data[i + 1]!, g.data[i + 2]!);
        const low = Math.min(g.data[i]!, g.data[i + 1]!, g.data[i + 2]!);
        if (peak > 120 && peak - low > 90) n++;
      }
    }
    return n / (band * g.W);
  });
  await page.locator("#canvas").screenshot({ path: `${OUT}/flame-set.png` });
  console.log("flame in the top rows of the stage", lit.toFixed(3));
  expect(lit, "share of the stage's top rows lit by flame").toBeLessThan(0.1);
});

test("no frame during a swap draws a placeholder or a half piece", async ({ page }) => {
  await openStage(page);
  const sets = await sampleSets(3);
  await page.evaluate(() => {
    const w = window as never as Record<string, unknown> & { __violations: unknown[]; __stop: boolean; eclipse: { wardrobe: { onStage: { node: { parent: unknown }; figure: { parts: { mesh: { visible: boolean }; extras: { units: { tex: number }[] }; material: { uniforms: Record<string, { value: { isDataTexture?: boolean; image?: { width: number } } }> } }[] } }[] }; figure: { parts: unknown[] } } };
    w.__violations = [];
    w.__stop = false;
    const tick = () => {
      if (w.__stop) return;
      for (const p of w.eclipse.wardrobe.onStage) {
        for (const q of p.figure.parts) {
          if (!q.mesh.visible) continue;
          q.extras.units.forEach((u, i) => {
            const t = q.material.uniforms[`uT${i}`]?.value;
            if (i < 3 && u.tex >= 0 && t?.isDataTexture && t.image?.width === 1) w.__violations.push("placeholder");
          });
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (const set of sets) await wearAll(page, set.pieces);
  await wear(page, "chest", null);
  const v = await page.evaluate(() => {
    const w = window as never as { __violations: unknown[]; __stop: boolean };
    w.__stop = true;
    return w.__violations.length;
  });
  expect(v).toBe(0);
  await clean(page, "after the swaps");
});

// --- Sweep ---------------------------------------------------------------------------------

test("a sweep of 56 items in every slot, on two bodies: clean, and nothing on the placeholder", async ({ page }) => {
  test.setTimeout(420_000);
  const items = await sampleItems(4);
  for (const body of ["human-male", "orc-female"]) {
    await openStage(page, body);
    for (const [slot, id] of items) {
      await wear(page, slot, id);
      await clean(page, `${body} ${slot} ${id}`).catch((e) => {
        throw new Error(`${body} ${slot} ${id}: ${(e as Error).message}`);
      });
      await wear(page, slot, null);
    }
    const s = await clean(page, `${body}, all off`);
    expect(s.committed).toEqual({});
  }
});

// --- Time ----------------------------------------------------------------------------------

/**
 * The targets are what the owner asked for: a cached item in the frame after the rest, a new one
 * under 300 ms, a set's pieces as they arrive. What these budgets hold firmly is everything that is
 * ours: warm paths in full. The cold ones sit far above the targets by what r2.dev itself costs
 * (HTTP/1.1, six sockets, measured first bytes p50 240 ms, p90 700 to 1100, max 3.9 s), and only
 * catch a wear that has gone wrong: the numbers are printed, read them.
 */
test("something warm lands in the next frame, whether worn or hovered", async ({ page }) => {
  await openStage(page);
  const items = await sampleItems(1, ["head", "chest", "legs", "shoulder", "mainhand"]);
  for (const [slot, id] of items) {
    await wear(page, slot, id);
    await wear(page, slot, null);
  }
  const results: { ms: number; frames: number }[] = [];
  for (const [slot, id] of items) {
    results.push(
      await page.evaluate(
        async ([s, i]) => {
          const e = (window as never as { eclipse: { frames(): number; equip(s: string, i: string | null): Promise<void> } }).eclipse;
          const f0 = e.frames();
          const t0 = performance.now();
          await e.equip(s!, i!);
          return { ms: performance.now() - t0, frames: e.frames() - f0 };
        },
        [slot, id] as const,
      ),
    );
    await wear(page, slot, null);
  }
  console.log("warm wears", JSON.stringify(results.map((r) => [Math.round(r.ms), r.frames])));
  for (const r of results) expect(r.frames, "drawn frames before it was on").toBeLessThanOrEqual(1);
  expect(pct(results.map((r) => r.ms), 0.9)).toBeLessThanOrEqual(34);
});

test("going back to a set worn a moment ago is instant, nothing fetched", async ({ page }) => {
  await openStage(page);
  const [a, b] = await sampleSets(2);
  await wearAll(page, a!.pieces);
  await wearAll(page, b!.pieces);
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith(PACKS)) requests.push(r.url());
  });
  const ms = await page.evaluate(
    async ([slots, p]) => {
      const e = (window as never as { eclipse: { equip(s: string, i: string | null): Promise<void> } }).eclipse;
      const t0 = performance.now();
      await Promise.all((slots as string[]).map((s) => e.equip(s, (p as Record<string, string>)[s] ?? null)));
      return performance.now() - t0;
    },
    [[...SLOTS], a!.pieces] as const,
  );
  console.log("set back", Math.round(ms), "ms; requests", requests.length);
  expect(requests).toEqual([]);
  expect(ms).toBeLessThanOrEqual(50);
  await clean(page, "back to the first set");
});

test("hover to figure on the real grid: budgets, split, and no long stall", async ({ page }) => {
  test.setTimeout(300_000);
  await openStage(page);
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const w = window as never as Record<string, unknown> & { eclipse: { wardrobe: { preview(s: string, i: string | null): unknown; previews: Map<string, string>; worn: Map<string, { id: string }>; applying: boolean } } };
    (w as { long?: number[] }).long = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) (w.long as number[]).push(Math.round(e.duration));
    }).observe({ entryTypes: ["longtask"] });
    const wd = w.eclipse.wardrobe;
    const prev = wd.preview.bind(wd);
    wd.preview = (s: string, i: string | null) => {
      if (i && w.hov && !(w.hov as { rest: number }).rest) (w.hov as { rest: number }).rest = performance.now();
      return prev(s, i);
    };
    const tick = () => {
      const h = w.hov as { rest: number; first: number; all: number } | null;
      if (h?.rest && !h.all) {
        const want = [...wd.previews];
        if (want.length && !wd.applying) {
          const shown = want.filter(([s, i]) => wd.worn.get(s)?.id === i).length;
          if (shown && !h.first) h.first = performance.now();
          if (shown === want.length) h.all = performance.now();
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const measure = async (i: number) => {
    await page.evaluate(() => {
      (window as never as { hov: unknown; long: number[] }).hov = { rest: 0, first: 0, all: 0 };
      (window as never as { long: number[] }).long.length = 0;
    });
    const at = await tileAt(page, i);
    await page.mouse.move(at.x, at.y);
    await page.waitForFunction(() => (window as never as { hov: { all: number } }).hov.all > 0, undefined, { timeout: 30_000, polling: 25 });
    return page.evaluate(() => {
      const w = window as never as { hov: { rest: number; first: number; all: number }; long: number[] };
      return { first: Math.round(w.hov.first - w.hov.rest), all: Math.round(w.hov.all - w.hov.rest), long: [...w.long] };
    });
  };

  await page.locator(".tabs [data-tab-btn='items']").click();
  await page.waitForSelector(".tile", { timeout: 30_000 });
  const fresh: number[] = [];
  const again: number[] = [];
  const long: number[] = [];
  for (const slot of ["head", "chest", "legs", "shoulder", "mainhand"]) {
    await page.locator(`[data-ring='${slot}']`).click();
    await page.waitForTimeout(1200);
    const r = await measure(3);
    fresh.push(r.all);
    long.push(...r.long);
    await page.waitForTimeout(200);
    await measure(4);
    await page.waitForTimeout(100);
    again.push((await measure(3)).all);
  }
  await page.mouse.move(700, 300);
  await page.waitForTimeout(1700);
  await page.locator("[data-tab-btn='sets']").click();
  await page.locator("[data-line='midnight']").click();
  await page.waitForTimeout(1500);
  const firstPiece: number[] = [];
  const allPieces: number[] = [];
  for (const i of [1, 4, 7]) {
    const r = await measure(i);
    firstPiece.push(r.first);
    allPieces.push(r.all);
    await page.waitForTimeout(300);
  }
  const back = await measure(1);
  console.log("hover, from the rest:", JSON.stringify({ itemFirst: fresh, itemCached: again, setFirstPiece: firstPiece, setAll: allPieces, setCached: back.all, long }));
  expect(pct(again, 0.9), "a hover already warm").toBeLessThanOrEqual(34);
  expect(pct(fresh, 0.5), "first hover: r2.dev's two round trips at most").toBeLessThanOrEqual(3000);
  expect(pct(firstPiece, 0.5), "a set's first piece").toBeLessThanOrEqual(3000);
  expect(pct(allPieces, 0.5), "a whole set").toBeLessThanOrEqual(10000);
  expect(back.all, "a set hovered a moment ago").toBeLessThanOrEqual(50);
});

test("at Khada's 0.9 MB/s line a wear still lands, in budget", async ({ page, context }) => {
  test.setTimeout(240_000);
  const cdp = await context.newCDPSession(page);
  await openStage(page);
  await throttle(cdp, 0.9);
  const items = await sampleItems(1, ["head", "chest", "shoulder", "mainhand"]);
  const ms: number[] = [];
  for (const [slot, id] of items) {
    ms.push(
      await page.evaluate(
        async ([s, i]) => {
          const t0 = performance.now();
          await (window as never as { eclipse: { equip(s: string, i: string | null): Promise<void> } }).eclipse.equip(s!, i!);
          return Math.round(performance.now() - t0);
        },
        [slot, id] as const,
      ),
    );
    await wear(page, slot, null);
  }
  const [set] = await sampleSets(1);
  const t0 = Date.now();
  await wearAll(page, set!.pieces);
  const setMs = Date.now() - t0;
  console.log("0.9 MB/s", JSON.stringify({ items: ms, set: setMs }));
  expect(pct(ms, 0.5)).toBeLessThanOrEqual(4000);
  expect(setMs).toBeLessThanOrEqual(15000);
});

// --- Memory --------------------------------------------------------------------------------

test("100 wears: GPU and heap stay flat, and a burst of hovers leaves nothing behind", async ({ page }) => {
  test.setTimeout(420_000);
  await openStage(page);
  const items = await sampleItems(5, ["head", "chest", "legs", "hands", "feet", "shoulder", "wrist", "waist", "back", "mainhand"]);
  const samples: { i: number; textures: number; geometries: number; programs: number; heap: number | null; lib: number; store: number }[] = [];
  const read = async (i: number) => {
    const s = await page.evaluate(() => {
      const w = window as never as { gc?: () => void; eclipse: { gpu(): { textures: number; geometries: number; programs: number }; wardrobe: { library: { items: Map<string, unknown> } } } };
      w.gc?.();
      return { ...w.eclipse.gpu(), lib: w.eclipse.wardrobe.library.items.size, heap: (performance as never as { memory?: { usedJSHeapSize: number } }).memory ? Math.round((performance as never as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576) : null, store: 0 };
    });
    samples.push({ i, ...s });
  };
  for (let i = 0; i < 100; i++) {
    const [slot, id] = items[i % items.length]!;
    await wear(page, slot, id);
    if (i % 25 === 24) await read(i);
  }
  // A burst of previews racing each other, over items not yet seen too.
  await page.evaluate(async (list) => {
    const e = (window as never as { eclipse: { previewEquip(s: string, i: string | null): Promise<void> } }).eclipse;
    for (const [s, i] of list) {
      void e.previewEquip(s, i);
      await new Promise((r) => setTimeout(r, 20));
    }
  }, items.slice(0, 40));
  await page.waitForTimeout(6000);
  await page.evaluate(() => {
    const e = (window as never as { eclipse: { wardrobe: { previews: Map<string, string>; preview(s: string, i: null): Promise<void> } } }).eclipse;
    return Promise.all([...e.wardrobe.previews.keys()].map((s) => e.wardrobe.preview(s, null)));
  });
  await read(140);
  for (let i = 0; i < 20; i++) {
    const [slot, id] = items[i % items.length]!;
    await wear(page, slot, id);
  }
  await read(160);
  console.log("memory", JSON.stringify(samples));
  const [, second, , , burst, last] = samples;
  // Warm by the second sample: the caches are full and stay at their size.
  expect(last!.lib).toBeLessThanOrEqual(42 + 10);
  expect(last!.textures).toBeLessThanOrEqual(second!.textures * 1.35 + 20);
  expect(last!.geometries).toBeLessThanOrEqual(second!.geometries * 1.35 + 20);
  expect(burst!.programs).toBeLessThanOrEqual(second!.programs + 6);
  if (second!.heap && last!.heap) expect(last!.heap).toBeLessThanOrEqual(second!.heap * 1.5 + 40);
  await clean(page, "after it all");
});
