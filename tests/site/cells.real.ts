/**
 * Nothing a cell draws lands outside its card, and every model fits inside one. On real mounts
 * and items, real pixels: the page is painted one known colour, so whatever else is on a frame
 * came from a cell, and that is counted against the card's rectangle.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { KNOWN_BACKGROUND, R2, SITE, dataIsUp, decodePng, drawnOn, drawnOutside, realMounts, screencast, stageUp } from "./real-lib";

test.describe.configure({ mode: "serial" });
let up = false;
test.beforeAll(async () => {
  up = await dataIsUp();
});
test.beforeEach(() => {
  test.skip(!up, "the packs on R2 don't answer");
});

interface Case {
  name: string;
  width: number;
  height: number;
  dpr: number;
}
const CASES: Case[] = [
  { name: "1400x860", width: 1400, height: 860, dpr: 1 },
  { name: "1920x1080", width: 1920, height: 1080, dpr: 1 },
  { name: "1400x860 at 125%", width: 1400, height: 860, dpr: 1.25 },
  { name: "1400x860 at 150%", width: 1400, height: 860, dpr: 1.5 },
  { name: "phone width, with a mouse", width: 390, height: 844, dpr: 2 },
];

/** Rests on a card until its cell is live, and says where the card is, in device pixels. */
async function goLive(page: Page, dpr: number) {
  // A card the pointer can reach: on a phone the room stands over the top of the list. The
  // catalogue follows the figure, so there is a moment with no cards yet: a card, not a moment.
  const inReach = () => page.evaluate(() => {
    const room = document.querySelector(".room");
    const under = room && getComputedStyle(room).position === "sticky" ? room.getBoundingClientRect().bottom : 0;
    for (const t of document.querySelectorAll<HTMLElement>(".grid-row:not([hidden]) .tile:not(.hide):not([hidden])")) {
      const r = t.getBoundingClientRect();
      if (t.style.visibility === "hidden" || r.top < under + 8 || r.bottom > innerHeight - 8) continue;
      if (document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".tile") === t) return { x: r.left, y: r.top, width: r.width, height: r.height };
    }
    return null;
  });
  await expect.poll(inReach, { message: "a card in reach", timeout: 60_000 }).not.toBeNull();
  const box = await inReach();
  await page.mouse.move(box!.x + box!.width / 2 - 3, box!.y + box!.height / 2);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.locator(".tile.live")).toHaveCount(1, { timeout: 60_000 });
  const live = (await page.locator(".tile.live").boundingBox())!;
  return { x: live.x * dpr, y: live.y * dpr, width: live.width * dpr, height: live.height * dpr };
}

async function open(browser: Browser, c: Case, path: string) {
  const context = await browser.newContext({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: c.dpr, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.goto(`${SITE}${path}`);
  return { context, page, cdp: await context.newCDPSession(page) };
}

for (const c of CASES) {
  for (const [where, path] of [
    ["mounts", "mounts/"],
    ["wardrobe items", "wardrobe/?body=human-male&slot=back"],
  ] as const) {
    test(`${where}, ${c.name}: nothing outside the live card, at rest, scrolling, resized, or after`, async ({ browser }) => {
      test.setTimeout(180_000);
      const { context, page, cdp } = await open(browser, c, path);
      if (path.startsWith("wardrobe")) await stageUp(page);
      await page.locator(".grid-row:not([hidden]) .tile:not(.hide):not([hidden])").first().waitFor({ state: "attached", timeout: 60_000 });
      // On a phone the list is under the room, in the column's own scroll.
      if (c.width < 768 && path.startsWith("wardrobe")) {
        await page.evaluate(() => { document.getElementById("split")!.scrollTop = 500; });
        await page.waitForTimeout(400);
      }
      await page.addStyleTag({ content: KNOWN_BACKGROUND });

      // At rest: every pixel on the page that isn't the background is inside the card.
      const rect = await goLive(page, c.dpr);
      await page.waitForTimeout(500);
      const atRest = decodePng(await page.screenshot({ scale: "device" }));
      const inside = drawnOn(atRest);
      console.log(`${where} ${c.name}: at rest`, JSON.stringify({ rect, inside }));
      expect(inside.count, "the card shows").toBeGreaterThan(100);
      expect(drawnOutside(atRest, rect, 1), "pixels outside the card, at rest").toBe(0);
      // It is the card's own child, its own size: the compositor scrolls them as one.
      const placed = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-eclipse-cells]")!;
        const card = document.querySelector<HTMLElement>(".tile.live")!;
        const a = canvas.getBoundingClientRect();
        const b = card.getBoundingClientRect();
        return { inCard: canvas.parentElement === card, dw: Math.abs(a.width - b.width), dh: Math.abs(a.height - b.height), dx: Math.abs(a.left - b.left), dy: Math.abs(a.top - b.top), buffer: [canvas.width, canvas.height], css: [b.width, b.height] };
      });
      expect(placed.inCard, "the canvas stands inside the card").toBe(true);
      expect(Math.max(placed.dw, placed.dh, placed.dx, placed.dy)).toBeLessThan(1);
      expect(Math.abs(placed.buffer[0]! - placed.css[0]! * c.dpr)).toBeLessThanOrEqual(1);
      expect(Math.abs(placed.buffer[1]! - placed.css[1]! * c.dpr)).toBeLessThanOrEqual(1);

      // While it scrolls, under a main thread that is late as a heavy page is: each composited
      // frame holds one card's worth at most, never a model left behind by its card.
      const tall = rect.height;
      const wide = rect.width;
      const cast = await screencast(cdp);
      await page.waitForTimeout(80);
      const busy = page.evaluate(async () => {
        const until = performance.now() + 900;
        while (performance.now() < until) {
          const t = performance.now();
          while (performance.now() - t < 28);
          await new Promise((r) => setTimeout(r, 0));
        }
      });
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, 90);
        await page.waitForTimeout(40);
      }
      await busy;
      await page.waitForTimeout(300);
      await cast.stop();
      let worst = 0;
      for (const f of cast.frames) {
        const d = drawnOn(decodePng(f));
        if (!d.count) continue;
        worst = Math.max(worst, d.x1 - d.x0 + 1 - wide, d.y1 - d.y0 + 1 - tall);
      }
      console.log(`${where} ${c.name}: scrolling, frames`, cast.frames.length, "worst reach past a card, px", worst);
      expect(cast.frames.length, "a scroll was seen").toBeGreaterThan(1);
      expect(worst, "device pixels past one card's size").toBeLessThanOrEqual(2);

      // The list moved under the pointer and nothing came alive for it. Nothing is left behind.
      await expect(page.locator(".tile.live")).toHaveCount(0);
      const after = decodePng(await page.screenshot({ scale: "device" }));
      expect(drawnOn(after).count, "pixels left on the page after a scroll").toBe(0);

      // Live again, and the window changes under it: the new size, still inside its card.
      await page.mouse.move(2, 2);
      await goLive(page, c.dpr);
      await page.waitForTimeout(300);
      await page.setViewportSize({ width: Math.round(c.width * 0.9), height: Math.round(c.height * 0.9) });
      await page.waitForTimeout(600);
      const live = page.locator(".tile.live");
      if (await live.count()) {
        const r = (await live.boundingBox())!;
        const resized = decodePng(await page.screenshot({ scale: "device" }));
        expect(drawnOutside(resized, { x: r.x * c.dpr, y: r.y * c.dpr, width: r.width * c.dpr, height: r.height * c.dpr }, 1), "pixels outside the card, resized").toBe(0);
      }

      // Gone: nothing at all on the page.
      await page.mouse.move(2, 2);
      await expect(page.locator(".tile.live")).toHaveCount(0);
      await page.waitForTimeout(100);
      expect(drawnOn(decodePng(await page.screenshot({ scale: "device" }))).count, "pixels left after the pointer left").toBe(0);
      await context.close();
    });
  }
}

// --- Framing --------------------------------------------------------------------------

interface Poster {
  w: number;
  h: number;
  l: number;
  t: number;
  r: number;
  b: number;
  /** Strongly drawn pixels in the outer 1% ring, as a share of the ring. */
  cut: number;
}

const posterOf = (page: Page, spec: Record<string, unknown>, width: number, height: number) =>
  page.evaluate(
    async ({ spec, width, height }) => {
      const e = (window as unknown as { eclipse: { figurePoster(s: unknown, w: number, h: number): Promise<string | null> } }).eclipse;
      const url = await e.figurePoster(spec, width, height);
      if (!url) return null;
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const x = c.getContext("2d", { willReadFrequently: true })!;
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      const ring = Math.ceil(c.width * 0.01);
      let x0 = c.width;
      let y0 = c.height;
      let x1 = -1;
      let y1 = -1;
      let cut = 0;
      let around = 0;
      for (let v = 0; v < c.height; v++) {
        for (let u = 0; u < c.width; u++) {
          const a = d[(v * c.width + u) * 4 + 3]!;
          const edge = u < ring || v < ring || u >= c.width - ring || v >= c.height - ring;
          if (edge) around++;
          if (a < 24) continue;
          if (u < x0) x0 = u;
          if (v < y0) y0 = v;
          if (u > x1) x1 = u;
          if (v > y1) y1 = v;
          if (edge && a >= 128) cut++;
        }
      }
      return { w: c.width, h: c.height, l: x0, t: y0, r: c.width - 1 - x1, b: c.height - 1 - y1, cut: cut / around } satisfies Poster;
    },
    { spec, width, height },
  );

test("real models, widest and tallest and biggest: each fits its card with a margin", async ({ browser }) => {
  test.setTimeout(420_000);
  const mounts = await realMounts();
  const ids = mounts.map((m) => m.variants[0]?.id).filter(Boolean) as string[];
  // Their real bounds, from their manifests, to pick the hard ones.
  const sized: { id: string; size: number[] }[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next < ids.length) {
        const id = ids[next++]!;
        const r = await fetch(`${R2}/models/${id}/manifest.json`).catch(() => null);
        if (!r?.ok) continue;
        const m = (await r.json()) as { bounds: { min: number[]; max: number[] } };
        sized.push({ id, size: m.bounds.max.map((v, i) => v - m.bounds.min[i]!) });
      }
    }),
  );
  const top = (f: (s: number[]) => number, n: number) => [...sized].sort((a, b) => f(b.size) - f(a.size)).slice(0, n).map((s) => s.id);
  const hard = [
    ...top((s) => s[1]!, 6),
    ...top((s) => Math.max(s[0]!, s[2]!) / Math.max(1e-3, s[1]!), 6),
    ...top((s) => s[1]! / Math.max(1e-3, Math.max(s[0]!, s[2]!)), 6),
    ...top((s) => Math.hypot(s[0]!, s[1]!, s[2]!), 4),
    // The ones the old framing cut, by name.
    "mountd-79479", "mountd-143960", "mountd-100108", "mountd-123400", "mountd-107160", "mountd-125658",
  ];
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 }, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.goto(`${SITE}wardrobe/?body=human-male`);
  await stageUp(page);

  const margins: number[] = [];
  const bad: string[] = [];
  const check = (name: string, p: Poster | null) => {
    if (!p) return;
    const m = Math.min(p.l / p.w, p.r / p.w, p.t / p.h, p.b / p.h);
    margins.push(m);
    if (p.cut > 0.005) bad.push(`${name}: ${(p.cut * 100).toFixed(1)}% of the edge is drawn on, margins ${JSON.stringify([p.l, p.t, p.r, p.b])}`);
  };
  for (const id of [...new Set(hard)]) check(id, await posterOf(page, { bodyId: id }, 200, 264));

  // Weapons stand alone by the same rule. Sets are whole figures: what they wear can reach past the figure's frame.
  const catalog = (await (await fetch(`${R2}/catalog/catalog.json`)).json()) as { itemShards: { line: string; slot: string; key: string }[]; setShards: { line: string; key: string }[] };
  const shard = catalog.itemShards.find((s) => s.line === "warwithin" && s.slot === "mainhand")!;
  const rows = ((await (await fetch(`${R2}/${shard.key}`)).json()) as { rows: [number, ...unknown[]][] }).rows;
  for (let i = 0; i < 6; i++) {
    const id = `item-${rows[Math.floor((i * rows.length) / 6)]![0]}`;
    check(id, await posterOf(page, { itemId: id }, 200, 264));
  }
  const sets = (await (await fetch(`${R2}/${catalog.setShards.find((s) => s.line === "warwithin")!.key}`)).json()) as { id: string; pieces: Record<string, string> }[];
  for (let i = 0; i < 6; i++) {
    const set = sets[Math.floor((i * sets.length) / 6)]!;
    check(set.id, await posterOf(page, { bodyId: "human-male", pieces: set.pieces }, 240, 316));
  }
  margins.sort((a, b) => a - b);
  console.log("margins of", margins.length, "real models: min", margins[0]?.toFixed(3), "median", margins[margins.length >> 1]?.toFixed(3), "none cut:", bad.length === 0);
  expect(bad, "models cut by their card").toEqual([]);
  // Eclipse's 6% a side, kWeaponFill, within what a measure at this size can say.
  expect(margins[margins.length >> 1]!).toBeGreaterThan(0.04);
  await context.close();
});

test("the live cell takes over where the poster stands: nothing jumps at the hand-off", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 }, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.goto(`${SITE}wardrobe/?body=human-male`);
  await stageUp(page);
  for (const id of ["mountd-123400", "mountd-143960", "mountd-100108"]) {
    const out = await page.evaluate(async (id) => {
      const W = 200;
      const H = 264;
      const e = (window as unknown as { eclipse: { figurePoster(s: unknown, w: number, h: number): Promise<string | null>; addFigureCell(el: HTMLElement, o: unknown): () => void } }).eclipse;
      // One quantity on both sides. The canvas is premultiplied, with additive light at alpha 0: the
      // most of its four is how much shows. A poster is straight, its faintest glow is bright in
      // colour, and its alpha already is that most (toStraightAlpha).
      const mask = (d: Uint8ClampedArray | Uint8Array, canvas: boolean) => {
        const m = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const v = canvas ? H - 1 - y : y;
          const i = (v * W + x) * 4;
          if ((canvas ? Math.max(d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!) : d[i + 3]!) >= 48) m[y * W + x] = 1;
        }
        return m;
      };
      const url = (await e.figurePoster({ bodyId: id }, W, H))!;
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const x = c.getContext("2d", { willReadFrequently: true })!;
      x.drawImage(img, 0, 0, W, H);
      const poster = mask(x.getImageData(0, 0, W, H).data, false);

      const el = document.createElement("div");
      el.style.cssText = `position:fixed;left:40px;top:40px;width:${W}px;height:${H}px;z-index:99`;
      document.body.appendChild(el);
      // The one live cell, as on the page: the next mount's stands in its place.
      let stop = () => {};
      const live = await new Promise<Uint8Array>((resolve) => {
        stop = e.addFigureCell(el, {
          bodyId: id,
          effects: true,
          inCell: true,
          onDrawn: () => {
            const canvas = el.querySelector("canvas")!;
            const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
            const px = new Uint8Array(canvas.width * canvas.height * 4);
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
            resolve(mask(px, true));
          },
        });
      });
      stop();
      el.remove();
      let both = 0;
      let either = 0;
      const box = (m: Uint8Array) => {
        let x0 = W;
        let y0 = H;
        let x1 = -1;
        let y1 = -1;
        for (let y = 0; y < H; y++) for (let u = 0; u < W; u++) if (m[y * W + u]) {
          if (u < x0) x0 = u;
          if (y < y0) y0 = y;
          if (u > x1) x1 = u;
          if (y > y1) y1 = y;
        }
        return [x0, y0, x1, y1];
      };
      for (let i = 0; i < W * H; i++) {
        if (poster[i] && live[i]) both++;
        if (poster[i] || live[i]) either++;
      }
      return { overlap: both / Math.max(1, either), poster: box(poster), live: box(live) };
    }, id);
    console.log("hand-off", id, JSON.stringify(out));
    expect(out.overlap, `${id}: poster and first live frame are one picture`).toBeGreaterThan(0.85);
    for (let i = 0; i < 4; i++) expect(Math.abs(out.poster[i]! - out.live[i]!), `${id}: its edges stay`).toBeLessThanOrEqual(8);
  }
  await context.close();
});
