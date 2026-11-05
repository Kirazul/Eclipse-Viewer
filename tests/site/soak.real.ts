/**
 * Five minutes of a person on the real site: scrolling, cells filling, hovering, wearing, tabs,
 * bodies. It never crashes, no context is lost, and memory levels off rather than climbing. It
 * only runs when asked, with SOAK=1: five minutes is too long for a gate that runs every time.
 *   SOAK=1 npx playwright test --config tests/site/playwright.config.ts --project real-data --no-deps soak.real
 */
import { expect, test } from "@playwright/test";
import { GPU_ARGS, SITE, dataIsUp, stageUp } from "./real-lib";

const SECONDS = Number(process.env.SOAK_SECONDS ?? 300);
test.use({ launchOptions: { args: GPU_ARGS } });

interface Sample {
  t: number;
  heap: number;
  cellsGeo: number;
  cellsTex: number;
  stageGeo: number;
  stageTex: number;
  programs: number;
}

test("five minutes of everything: no crash, no lost context, memory levels off", async ({ browser }) => {
  test.skip(!process.env.SOAK, "SOAK=1 to run it");
  test.skip(!(await dataIsUp()), "the packs on R2 don't answer");
  test.setTimeout((SECONDS + 180) * 1000);
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  let crashed = false;
  page.on("crash", () => { crashed = true; });
  await page.addInitScript(() => {
    const w = window as unknown as { __lost: number };
    w.__lost = 0;
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...a: never[]) {
      const c = (get as (...x: unknown[]) => unknown).apply(this, a);
      if (c && String(a[0]).startsWith("webgl")) this.addEventListener("webglcontextlost", () => { w.__lost++; });
      return c;
    } as never;
  });
  await page.goto(`${SITE}wardrobe/?body=human-male`);
  await stageUp(page);

  let seed = 20261104;
  const dice = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const LINES = ["midnight", "warwithin", "eclipse"];
  const SLOTS = ["head", "shoulder", "back", "chest", "hands", "waist", "legs", "feet", "mainhand", "offhand"];
  const cardAt = () =>
    page.evaluate(() => {
      const scroller = document.getElementById("grid-scroll")!.getBoundingClientRect();
      const list = [...document.querySelectorAll<HTMLElement>(".grid-row:not([hidden]) .tile:not(.hide):not([hidden])")].filter((t) => {
        const r = t.getBoundingClientRect();
        return r.top >= scroller.top && r.bottom <= scroller.bottom && t.style.visibility !== "hidden";
      });
      const t = list[Math.floor(Math.random() * list.length)];
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  const samples: Sample[] = [];
  const started = Date.now();
  let nextSample = 0;
  let acts = 0;
  while ((Date.now() - started) / 1000 < SECONDS && !crashed) {
    acts++;
    const r = dice(100);
    const tab = await page.evaluate(() => document.getElementById("room")!.dataset.tab).catch(() => "");
    try {
      if (tab !== "items" && tab !== "sets") await page.locator('[data-tab-btn="items"]').click({ timeout: 3000 });
      else if (r < 8) await page.locator(`#lines [data-line="${LINES[dice(LINES.length)]}"]`).click({ timeout: 3000 });
      else if (r < 22 && tab === "items") await page.locator(`#chips [data-chip="${SLOTS[dice(SLOTS.length)]}"]`).click({ timeout: 3000 });
      else if (r < 50) {
        const box = (await page.locator("#grid-scroll").boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + 60 + dice(200));
        for (let i = 0; i < 6; i++) {
          await page.mouse.wheel(0, 200);
          await page.waitForTimeout(40);
        }
      } else if (r < 72) {
        const at = await cardAt();
        if (at) {
          await page.mouse.move(at.x, at.y);
          await page.waitForTimeout(400 + dice(1500));
        }
      } else if (r < 84) {
        const at = await cardAt();
        if (at) {
          await page.mouse.click(at.x, at.y);
          await page.waitForTimeout(500);
        }
      } else if (r < 90) await page.locator('[data-tab-btn="sets"]').click({ timeout: 3000 });
      else if (r < 94) await page.locator("#reset-look").click({ timeout: 800 });
      else await page.locator(`[data-tab-btn="${["customization", "viewer", "loadout"][dice(3)]}"]`).click({ timeout: 3000 });
    } catch (e) {
      if (crashed) break;
      if (!/Timeout/.test(String(e))) throw e;
    }
    await page.waitForTimeout(100 + dice(400)).catch(() => undefined);
    if (Date.now() - started > nextSample && !crashed) {
      nextSample = Date.now() - started + 15_000;
      const s = await page.evaluate(() => {
        const e = (window as unknown as { eclipse: { internals: { cells(): { numbers(): { geometries: number; textures: number } } | null }; renderer: { info: { memory: { geometries: number; textures: number }; programs?: unknown[] } } } }).eclipse;
        const n = e.internals.cells()?.numbers();
        const m = (performance as unknown as { memory: { usedJSHeapSize: number } }).memory;
        return { heap: Math.round(m.usedJSHeapSize / 1048576), cellsGeo: n?.geometries ?? 0, cellsTex: n?.textures ?? 0, stageGeo: e.renderer.info.memory.geometries, stageTex: e.renderer.info.memory.textures, programs: e.renderer.info.programs?.length ?? 0 };
      });
      samples.push({ t: Math.round((Date.now() - started) / 1000), ...s });
    }
  }
  console.log(`soak: ${acts} acts in ${Math.round((Date.now() - started) / 1000)} s\n${samples.map((s) => JSON.stringify(s)).join("\n")}`);
  expect(crashed, "the page crashed").toBe(false);
  expect(await page.evaluate(() => (window as unknown as { __lost: number }).__lost), "WebGL contexts lost").toBe(0);

  // Warmed up by a third of the way: from there, what is held in the GPU stays bounded, and the
  // heap's top doesn't keep climbing. Garbage comes and goes, so it is the highs that count.
  const third = samples.filter((s) => s.t < SECONDS / 3);
  const rest = samples.filter((s) => s.t >= SECONDS / 3);
  const high = (list: Sample[], k: keyof Sample) => Math.max(...list.map((s) => s[k]));
  for (const k of ["stageGeo", "stageTex", "cellsGeo", "cellsTex"] as const) {
    expect(high(rest, k), `${k} levels off`).toBeLessThanOrEqual(high(third, k) * 1.5 + 30);
  }
  expect(high(rest, "heap"), "the heap levels off").toBeLessThanOrEqual(high(third, "heap") * 1.5 + 40);
});
