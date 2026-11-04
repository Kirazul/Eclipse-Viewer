import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { LOCAL_PACKS, REPO, log } from "../lib/env";
import type { PosterSpec } from "./spec";

/**
 * A poster is drawn by real three.js through the engine, in a headless browser. In the
 * cloud that is Playwright's Chromium on the runner's software GL; here, Edge. This file
 * owns everything about that: the bundle, the little server that hands it to the
 * browser, and a pool of pages drawing one poster each at a time.
 */

const PAGE_DIR = join(REPO, "work", "poster-page");
/** A page's GPU data and heap only ever grow a little: it starts over before that matters. */
const RECYCLE_AFTER = 400;
const RENDER_TIMEOUT_MS = 240_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".ktx2": "image/ktx2",
};

function buildPage(): void {
  // Vite comes with vitest at the root, and with Astro under the site.
  const bin = [join(REPO, "node_modules", ".bin", "vite"), join(REPO, "site", "node_modules", ".bin", "vite"), join(REPO, "node_modules", ".pnpm", "node_modules", ".bin", "vite")].find(existsSync);
  if (!bin) throw new Error("no vite to build the poster page with: posters need the whole workspace installed");
  const r = spawnSync(`"${bin}" build --config bake/posters/vite.config.mjs`, { cwd: REPO, stdio: "pipe", shell: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`the poster page did not build:\n${r.stdout}\n${r.stderr}`);
}

function inside(root: string, rel: string): string | null {
  const p = normalize(join(root, rel));
  return p.startsWith(normalize(root)) && existsSync(p) && statSync(p).isFile() ? p : null;
}

function serve(): Promise<{ server: Server; port: number }> {
  const basis = resolve(REPO, "engine/node_modules/three/examples/jsm/libs/basis");
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    let file: string | null;
    if (path.startsWith("/basis/")) file = inside(basis, path.slice(7));
    else if (path.startsWith("/packs/")) file = inside(LOCAL_PACKS, path.slice(7));
    else file = inside(PAGE_DIR, path === "/" ? "index.html" : path.slice(1));
    if (!file) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Access-Control-Allow-Origin": "*" });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => ok({ server, port: (server.address() as { port: number }).port }));
  });
}

export interface Drawn {
  width: number;
  height: number;
  /** RGBA, premultiplied, top row first. */
  pixels: Buffer;
  nothing: boolean;
  renderer: string;
}

interface PageLike {
  goto(url: string): Promise<unknown>;
  waitForFunction(fn: string, arg?: unknown, opts?: { timeout: number }): Promise<unknown>;
  evaluate<T>(fn: (a: never) => Promise<T> | T, arg: never): Promise<T>;
  on(event: string, handler: (arg: never) => void): unknown;
}

interface Slot {
  page: PageLike;
  url: string;
  drawn: number;
  busy: boolean;
}

export class PosterBrowser {
  private readonly waiting: ((s: Slot) => void)[] = [];

  private constructor(
    private readonly browser: { close(): Promise<void> },
    private readonly server: Server,
    private readonly slots: Slot[],
    private readonly wire: { bytes: number },
  ) {}

  static async open(base: string, pages: number): Promise<PosterBrowser> {
    buildPage();
    const { server, port } = await serve();
    // Only this scope asks for a browser, so a plain bake never needs Playwright installed.
    const { chromium } = await import("@playwright/test");
    const channel = process.env.POSTER_CHANNEL || undefined;
    const browser = await chromium.launch({
      ...(channel ? { channel } : {}),
      headless: true,
      args: ["--use-gl=angle", `--use-angle=${process.env.POSTER_ANGLE || "swiftshader"}`, "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
    });
    const context = await browser.newContext({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1, reducedMotion: "no-preference" });
    const url = `http://127.0.0.1:${port}/?base=${encodeURIComponent(base)}`;
    const wire = { bytes: 0 };
    const slots: Slot[] = [];
    for (let i = 0; i < pages; i++) {
      const page = (await context.newPage()) as unknown as PageLike;
      page.on("pageerror", ((e: Error) => log(`  poster page error: ${e.message}`)) as never);
      page.on("response", ((r: { headers(): Record<string, string>; url(): string }) => {
        if (!r.url().startsWith(`http://127.0.0.1:${port}`)) wire.bytes += Number(r.headers()["content-length"] ?? 0);
      }) as never);
      await page.goto(url);
      await page.waitForFunction("window.__ready === true", undefined, { timeout: 60_000 });
      slots.push({ page, url, drawn: 0, busy: false });
    }
    log(`posters: ${pages} page(s) of ${channel ?? "chromium"} on ${process.env.POSTER_ANGLE || "swiftshader"}, reading ${base}`);
    return new PosterBrowser(browser, server, slots, wire);
  }

  private acquire(): Promise<Slot> {
    const free = this.slots.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise((ok) => this.waiting.push(ok));
  }

  private release(slot: Slot): void {
    const next = this.waiting.shift();
    if (next) next(slot);
    else slot.busy = false;
  }

  async draw(spec: PosterSpec, width: number, height: number, supersample = 2): Promise<Drawn> {
    const slot = await this.acquire();
    try {
      if (++slot.drawn > RECYCLE_AFTER) await this.fresh(slot);
      const run = slot.page.evaluate(
        (([s, w, h, k]: [PosterSpec, number, number, number]) => (window as never as { __poster(o: unknown, w: number, h: number, k: number): Promise<unknown> }).__poster(s, w, h, k)) as never,
        [spec, width, height, supersample] as never,
      ) as Promise<{ width: number; height: number; pixels: string; nothing: boolean; renderer: string }>;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Error(`no poster in ${RENDER_TIMEOUT_MS / 1000} s`)), RENDER_TIMEOUT_MS);
      });
      try {
        const out = await Promise.race([run, timeout]);
        return { width: out.width, height: out.height, nothing: out.nothing, renderer: out.renderer, pixels: Buffer.from(out.pixels, "base64") };
      } catch (e) {
        // Whatever it was doing, that page has nothing more to give this run.
        await this.fresh(slot).catch(() => undefined);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.release(slot);
    }
  }

  private async fresh(slot: Slot): Promise<void> {
    slot.drawn = 0;
    await slot.page.goto(slot.url);
    await slot.page.waitForFunction("window.__ready === true", undefined, { timeout: 60_000 });
  }

  async close(): Promise<void> {
    log(`posters: ${(this.wire.bytes / 1e6).toFixed(1)} MB of packs read over the wire`);
    await this.browser.close().catch(() => undefined);
    await new Promise((ok) => this.server.close(ok));
  }
}
