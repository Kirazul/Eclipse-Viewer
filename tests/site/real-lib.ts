/**
 * What the *.real.ts tests share: the real site's real data, on a real GPU, in the installed Edge.
 * They run after the rest of tests/site, on one worker: a frame time measured beside another
 * worker measures the other worker. REAL_SITE points them at another build, the live site say.
 */
import { inflateSync } from "node:zlib";
import type { BrowserContext, CDPSession, Page } from "@playwright/test";

export const R2 = "https://pub-8475da48fc7347d690ebb4e8e0254fdd.r2.dev";
export const SITE = process.env.REAL_SITE ?? "http://localhost:4331/Eclipse-Viewer/";
export const GPU_ARGS = ["--headless=new", "--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-precise-memory-info"];

/** The packs answer, or there is nothing to prove against. Status first: its 404 page is huge. */
export async function dataIsUp(): Promise<boolean> {
  try {
    const r = await fetch(`${R2}/catalog/mounts.json`, { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

export interface Mount {
  id: string;
  name: string;
  variants: { id: string }[];
}
export const realMounts = async (): Promise<Mount[]> => (await fetch(`${R2}/catalog/mounts.json`)).json() as Promise<Mount[]>;

export const stageUp = (page: Page) =>
  page.waitForFunction(() => {
    const w = window as unknown as { eclipse?: { frames?(): number } };
    return (w.eclipse?.frames?.() ?? 0) > 2 && document.getElementById("canvas")?.style.opacity === "1";
  }, undefined, { timeout: 90_000 });

// --- Pixels ---------------------------------------------------------------------------

export interface Png {
  w: number;
  h: number;
  /** RGB, three bytes a pixel. */
  rgb: Buffer;
}

/** What Chromium writes: 8 bits, RGB or RGBA, no interlace. */
export function decodePng(buf: Buffer): Png {
  let at = 8;
  let w = 0;
  let h = 0;
  let type = 6;
  const idat: Buffer[] = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const name = buf.toString("latin1", at + 4, at + 8);
    if (name === "IHDR") {
      w = buf.readUInt32BE(at + 8);
      h = buf.readUInt32BE(at + 12);
      type = buf[at + 17]!;
    }
    if (name === "IDAT") idat.push(buf.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const rgb = Buffer.alloc(w * h * 3);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]!;
    const cur = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = (cur[x]! + add) & 255;
    }
    for (let x = 0; x < w; x++) {
      rgb[(y * w + x) * 3] = cur[x * bpp]!;
      rgb[(y * w + x) * 3 + 1] = cur[x * bpp + 1]!;
      rgb[(y * w + x) * 3 + 2] = cur[x * bpp + 2]!;
    }
    prev = cur;
  }
  return { w, h, rgb };
}

export interface Drawn {
  /** Pixels that are not the page's known colour. */
  count: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Everything on a frame that isn't the known background, magenta. */
export function drawnOn(img: Png): Drawn {
  const out: Drawn = { count: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 3;
      if (img.rgb[i]! > 240 && img.rgb[i + 1]! < 15 && img.rgb[i + 2]! > 240) continue;
      out.count++;
      if (x < out.x0) out.x0 = x;
      if (y < out.y0) out.y0 = y;
      if (x > out.x1) out.x1 = x;
      if (y > out.y1) out.y1 = y;
    }
  }
  return out;
}

/**
 * Non-background pixels outside a rectangle, in device pixels. A rectangle that falls between
 * device pixels covers the ones it touches, and `slack` is how far past those a card's own edge may round.
 */
export function drawnOutside(img: Png, r: { x: number; y: number; width: number; height: number }, slack: number): number {
  const left = Math.floor(r.x) - slack;
  const top = Math.floor(r.y) - slack;
  const right = Math.ceil(r.x + r.width) + slack;
  const bottom = Math.ceil(r.y + r.height) + slack;
  let n = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      if (x >= left && x < right && y >= top && y < bottom) continue;
      const i = (y * img.w + x) * 3;
      if (img.rgb[i]! > 240 && img.rgb[i + 1]! < 15 && img.rgb[i + 2]! > 240) continue;
      n++;
    }
  }
  return n;
}

/**
 * The page on one known colour, with only what a live cell draws left on it, and the live
 * card's own ground in another: all that can differ from magenta is the cell.
 */
export const KNOWN_BACKGROUND = `
*,*::before,*::after{background:none!important;border-color:transparent!important;color:transparent!important;box-shadow:none!important;outline:0!important;transition:none!important;animation:none!important;-webkit-mask-box-image:none!important}
html,body{background:#ff00ff!important}
.backdrop,#canvas,.stage-scene,.stage-model{display:none!important}
input,img,svg,hr,.rule,.tile-frame,.tile-ring,.tile-name,.tile-badge,.grid-fade,.tile-flash,.tile-poster,.tile-star,.tip,.slot,.strip,.topbar,.rail{visibility:hidden!important}
.tile.live .tile-plate{background:#00ff00!important}`;

export async function screencast(cdp: CDPSession): Promise<{ frames: Buffer[]; stop(): Promise<void> }> {
  const frames: Buffer[] = [];
  const on = (e: { data: string; sessionId: number }) => {
    frames.push(Buffer.from(e.data, "base64"));
    void cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }).catch(() => undefined);
  };
  cdp.on("Page.screencastFrame", on);
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  return {
    frames,
    stop: async () => {
      await cdp.send("Page.stopScreencast");
      cdp.off("Page.screencastFrame", on);
    },
  };
}

// --- Time -----------------------------------------------------------------------------

export interface Probe {
  long: number[];
  gaps: number[];
  wheelDelay: number[];
  interactions: { id: number; name: string; ms: number; target: string }[];
  why: string[];
}

declare global {
  interface Window {
    __probe: Probe;
    __framesOn: boolean;
    __n: Record<string, number>;
  }
}

/** Long tasks, frame gaps, how late a wheel reached the page, interaction to next paint. */
export function installProbe(context: BrowserContext | Page) {
  return context.addInitScript(() => {
    const p: Probe = { long: [], gaps: [], wheelDelay: [], interactions: [], why: [] };
    window.__probe = p;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) p.long.push(Math.round(e.duration));
    }).observe({ type: "longtask", buffered: true });
    // What a long frame spent its time in, for when a gate fails.
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as { duration: number; scripts?: { duration: number; invoker?: string; sourceFunctionName?: string }[] }[]) {
        if (e.duration > 50) p.why.push(`${Math.round(e.duration)} ms: ${(e.scripts ?? []).map((s) => `${Math.round(s.duration)} ${s.invoker ?? ""} ${s.sourceFunctionName ?? ""}`).join(" | ")}`);
      }
    }).observe({ type: "long-animation-frame", buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as (PerformanceEventTiming & { interactionId?: number })[]) {
        if (e.interactionId) p.interactions.push({ id: e.interactionId, name: e.name, ms: e.duration, target: (e.target as Element | null)?.id || String((e.target as Element | null)?.className ?? "").slice(0, 24) });
      }
    }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
    addEventListener("wheel", (e) => p.wheelDelay.push(performance.now() - e.timeStamp), { passive: true, capture: true });
    // What a scroll must never call on the engine, counted where the page calls it.
    const n: Record<string, number> = { previewEquip: 0, prefetchEquip: 0, addFigureCell: 0, figurePoster: 0 };
    window.__n = n;
    const wrap = setInterval(() => {
      const e = (window as unknown as { eclipse?: Record<string, unknown> & { __counted?: boolean } }).eclipse;
      if (!e || e.__counted) return;
      e.__counted = true;
      for (const k of Object.keys(n)) {
        const f = e[k] as ((...a: unknown[]) => unknown) | undefined;
        if (typeof f === "function") {
          e[k] = function (this: unknown, ...a: unknown[]) {
            n[k]!++;
            return f.apply(this, a);
          };
        }
      }
      clearInterval(wrap);
    }, 20);
    new MutationObserver((records) => {
      for (const r of records) if ((r.target as Element).classList?.contains("live")) n.live = (n.live ?? 0) + 1;
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["class"] });
  });
}

export const startFrames = (page: Page) =>
  page.evaluate(() => {
    const p = window.__probe;
    p.long.length = 0;
    p.gaps.length = 0;
    p.wheelDelay.length = 0;
    p.why.length = 0;
    window.__framesOn = true;
    let last = performance.now();
    const tick = () => {
      if (!window.__framesOn) return;
      const now = performance.now();
      p.gaps.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

export interface FrameReport {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Frames longer than two at 60 Hz, a hitch anybody sees. */
  dropped: number;
  longMax: number;
  long: number[];
  wheelP95: number;
  why: string[];
}

export const stopFrames = (page: Page): Promise<FrameReport> =>
  page.evaluate(() => {
    window.__framesOn = false;
    const p = window.__probe;
    const g = p.gaps.slice(1).sort((a, b) => a - b);
    const at = (q: number) => +(g[Math.min(g.length - 1, Math.floor(g.length * q))] ?? 0).toFixed(1);
    const w = [...p.wheelDelay].sort((a, b) => a - b);
    return { frames: g.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1), dropped: g.filter((x) => x > 33.4).length, longMax: Math.max(0, ...p.long), long: [...p.long], wheelP95: +(w[Math.floor(w.length * 0.95)] ?? 0).toFixed(1), why: [...p.why] };
  });
