import { mkdirSync } from "node:fs";
import type { CDPSession, Page } from "@playwright/test";

export const OUT = "tests/wear/results/shots";
mkdirSync(OUT, { recursive: true });

export const SLOTS = ["head", "shoulder", "back", "chest", "shirt", "tabard", "wrist", "hands", "waist", "legs", "feet", "mainhand", "offhand", "ranged"] as const;
export const PACKS = process.env.PACK_BASE ?? "https://pub-8475da48fc7347d690ebb4e8e0254fdd.r2.dev";

/** Real art, each standing for a class of failure measured on the whole catalogue. */
export const REAL = {
  /** Elite plate: flame cards masked through UV set 2, white wedges on a slot with no file. */
  flameSet: { head: "item-739756", shoulder: "item-739757" },
  flameSetId: "set-5819",
  /** A batch that samples a texture slot the display doesn't fill, one per kind of slot and slot. */
  unbound: [
    ["chest", "item-725634"], ["legs", "item-725183"], ["head", "item-725720"], ["hands", "item-740897"], ["feet", "item-739705"],
    ["chest", "item-727825"], ["head", "item-735388"], ["legs", "item-724492"], ["chest", "item-731941"], ["head", "item-731999"],
  ] as [string, string][],
  /** A cloak with a model of its own whose GeosetGroup still shows the body's cape. */
  capeWithModel: "item-742820",
  /** A set's combined file: gloves whose GLB holds the whole armour. */
  combinedGloves: "item-740942",
};

export interface StageSnapshot {
  body: string;
  committed: Record<string, string>;
  previews: Record<string, string>;
  /** Slot -> the item the stage shows for it. */
  showing: Record<string, string>;
  /** Nodes hanging on the body that no wish names. */
  stale: string[];
  /** Pieces of a shown item that aren't on the body. */
  missing: string[];
  /** Visible batches sampling the white placeholder or a texture with no GPU copy. */
  white: { owner: string; model: string; geoset: number; units: number[] }[];
  gpu: { geometries: number; textures: number; programs: number };
  heapMB: number | null;
}

/** Page helpers: what is really on the figure, read from the scene graph and not from the state. */
export const PROBE = () => {
  const w = window as never as Record<string, unknown> & { eclipse: never };
  const HAND = new Set(["mainhand", "offhand", "ranged"]);
  w.__stage = async () => {
    const e = w.eclipse as never as Record<string, never> & { wardrobe: never; figure: never; customizer: never };
    const wd = e.wardrobe as never as { committed: Map<string, string>; previews: Map<string, string>; worn: Map<string, { id: string; pieces: { node: { name: string; parent: unknown }; figure: unknown; kind: string; slot?: string }[] }>; onStage: { node: unknown; figure: { id: string; parts: unknown[] }; slot?: string; kind: string }[] };
    const body = e.figure as never as { id: string; root: { children: { name: string }[]; traverse(f: (o: { name?: string }) => void): void }; assets: { gltf: { scene: unknown } }; parts: unknown[] };
    const expected = new Map<unknown, string>();
    for (const [slot, item] of wd.worn) for (const p of item.pieces) expected.set(p.node, `${slot}=${item.id}`);
    const custom = new Set<unknown>();
    for (const f of ((e.customizer as never as { attached?: Map<number, { root: unknown }> })?.attached?.values() ?? [])) custom.add(f.root);
    const actual: { name: string }[] = [];
    for (const c of body.root.children) if (c !== body.assets.gltf.scene && !custom.has(c)) actual.push(c);
    body.root.traverse((o) => {
      if (o.name?.startsWith("attachment-")) actual.push(o as { name: string });
    });
    const stale = actual.filter((n) => !expected.has(n)).map((n) => n.name);
    const missing = [...expected.entries()].filter(([n]) => !actual.includes(n as { name: string })).map(([, v]) => v);
    const props = (e.renderer as never as { properties: { get(t: unknown): { __webglTexture?: unknown } } }).properties;
    const white: unknown[] = [];
    const walk = (f: { id: string; parts: unknown[]; assets: { manifest: { textures: { type: number }[] } } }, owner: string) => {
      for (const raw of f.parts) {
        const part = raw as { mesh: { visible: boolean }; extras: { geoset: number; units: { tex: number }[] }; material: { uniforms: Record<string, { value: { isDataTexture?: boolean; image?: { width: number }; isRenderTargetTexture?: boolean } | null }> } };
        if (!part.mesh.visible) continue;
        const units: number[] = [];
        for (let i = 0; i < Math.min(part.extras.units.length, 3); i++) {
          if (part.extras.units[i]!.tex < 0) continue;
          const t = part.material.uniforms[`uT${i}`]!.value;
          if (!t || (t.isDataTexture && t.image?.width === 1)) units.push(i);
          else if (!t.isRenderTargetTexture && !props.get(t).__webglTexture) units.push(i);
        }
        if (units.length) white.push({ owner, model: f.id, geoset: part.extras.geoset, units });
      }
    };
    walk(body as never, "body");
    for (const p of wd.onStage) walk(p.figure as never, p.slot ?? p.kind);
    const showing: Record<string, string> = {};
    for (const [s, item] of wd.worn) showing[s] = item.id;
    return {
      body: body.id,
      committed: Object.fromEntries(wd.committed),
      previews: Object.fromEntries(wd.previews),
      showing,
      stale,
      missing,
      white,
      gpu: (e.gpu as never as () => unknown)(),
      heapMB: (performance as never as { memory?: { usedJSHeapSize: number } }).memory ? Math.round((performance as never as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576) : null,
    };
  };
  w.__frames = (n: number) =>
    new Promise<void>((resolve) => {
      let left = n;
      const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    });
  /** Saturated or near white pixels against a canvas grabbed earlier: what wearing added. */
  w.__grab = async () => {
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    const img = new Image();
    img.src = c.toDataURL("image/png");
    await img.decode();
    const W = 320;
    const H = Math.round((W * c.height) / c.width);
    const o = document.createElement("canvas");
    o.width = W;
    o.height = H;
    const x = o.getContext("2d", { willReadFrequently: true })!;
    x.drawImage(img, 0, 0, W, H);
    return { W, H, data: x.getImageData(0, 0, W, H).data };
  };
  w.__whitePixels = async () => {
    const g = await (w.__grab as () => Promise<{ W: number; H: number; data: Uint8ClampedArray }>)();
    const white = new Uint8Array(g.W * g.H);
    let covered = 0;
    for (let i = 0; i < g.W * g.H; i++) {
      if (g.data[i * 4 + 3]! > 200) covered++;
      if (g.data[i * 4 + 3]! > 200 && g.data[i * 4]! >= 236 && g.data[i * 4 + 1]! >= 236 && g.data[i * 4 + 2]! >= 236) white[i] = 1;
    }
    let biggest = 0;
    const seen = new Uint8Array(g.W * g.H);
    const stack: number[] = [];
    for (let s = 0; s < g.W * g.H; s++) {
      if (!white[s] || seen[s]) continue;
      let n = 0;
      stack.push(s);
      seen[s] = 1;
      while (stack.length) {
        const q = stack.pop()!;
        n++;
        const px = q % g.W;
        const py = (q / g.W) | 0;
        for (const r of [px > 0 ? q - 1 : -1, px < g.W - 1 ? q + 1 : -1, py > 0 ? q - g.W : -1, py < g.H - 1 ? q + g.W : -1]) {
          if (r >= 0 && white[r] && !seen[r]) {
            seen[r] = 1;
            stack.push(r);
          }
        }
      }
      if (n > biggest) biggest = n;
    }
    return { biggestFraction: covered ? biggest / covered : 0 };
  };
};

export async function openStage(page: Page, body = "human-male", query = ""): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // A build's own catalogue may know fewer bodies than R2 has: any other body is loaded by id.
  await page.goto(`wardrobe/?body=human-male${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as never as { eclipse?: { frames?(): number; wardrobe?: unknown } }).eclipse?.frames?.()! > 2 && (window as never as { eclipse: { wardrobe?: unknown } }).eclipse.wardrobe, undefined, { timeout: 120_000 });
  await page.waitForFunction(() => (document.getElementById("canvas") as HTMLCanvasElement).style.opacity === "1", undefined, { timeout: 30_000 });
  await page.evaluate(PROBE);
  if (body !== "human-male") await page.evaluate((b) => (window as never as { eclipse: { loadModel(id: string): Promise<void> } }).eclipse.loadModel(b), body);
  return errors;
}

export const stage = (page: Page) => page.evaluate(() => (window as never as { __stage(): Promise<StageSnapshot> }).__stage());
export const frames = (page: Page, n: number) => page.evaluate((c) => (window as never as { __frames(n: number): Promise<void> }).__frames(c), n);
export const whitePixels = (page: Page) => page.evaluate(() => (window as never as { __whitePixels(): Promise<{ biggestFraction: number }> }).__whitePixels());

type EngineCalls = { equip(s: string, i: string | null): Promise<void>; previewEquip(s: string, i: string | null): Promise<void> };
export const wear = (page: Page, slot: string, id: string | null) =>
  page.evaluate(([s, i]) => (window as never as { eclipse: EngineCalls }).eclipse.equip(s!, i ?? null), [slot, id] as const);
export const wearAll = (page: Page, pieces: Record<string, string>) =>
  page.evaluate(
    ([slots, p]) => Promise.all((slots as string[]).map((s) => (window as never as { eclipse: EngineCalls }).eclipse.equip(s, (p as Record<string, string>)[s] ?? null))),
    [[...SLOTS], pieces] as const,
  );

/** Every item the stage should show is on the body, nothing else is, no batch draws the placeholder. */
export async function clean(page: Page, label: string): Promise<StageSnapshot> {
  await frames(page, 3);
  const s = await stage(page);
  const wish = { ...s.committed, ...s.previews };
  const problems = {
    label,
    stale: s.stale,
    missing: s.missing,
    white: s.white,
    behind: Object.keys({ ...wish, ...s.showing }).filter((k) => wish[k] !== s.showing[k]),
  };
  if (problems.stale.length || problems.missing.length || problems.white.length || problems.behind.length) {
    throw new Error(`not clean: ${JSON.stringify(problems)}`);
  }
  return s;
}

export async function throttle(cdp: CDPSession, mbps: number) {
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: mbps * 1024 * 1024, uploadThroughput: 0.5 * 1024 * 1024 });
}

export const pct = (list: number[], p: number) => {
  const s = [...list].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0);
};

/** Items with their slots, from the real catalogue shards: every n-th row of each. */
export async function sampleItems(perSlot: number, slots: readonly string[] = SLOTS): Promise<[string, string][]> {
  const catalog = (await (await fetch(`${PACKS}/catalog/catalog.json`)).json()) as { itemShards: { line: string; slot: string; key: string; count: number }[] };
  const out: [string, string][] = [];
  for (const ref of catalog.itemShards.filter((r) => r.line === "midnight" && slots.includes(r.slot))) {
    const shard = (await (await fetch(`${PACKS}/${ref.key}`)).json()) as { rows: [number, ...unknown[]][] };
    for (let i = 0; i < perSlot; i++) out.push([ref.slot, `item-${shard.rows[Math.floor(((i + 0.5) * shard.rows.length) / perSlot)]![0]}`]);
  }
  return out;
}

export async function sampleSets(n: number, minPieces = 7): Promise<{ id: string; name: string; pieces: Record<string, string> }[]> {
  const sets = (await (await fetch(`${PACKS}/catalog/sets/midnight.json`)).json()) as { id: string; name: string; pieces: Record<string, string> }[];
  const big = sets.filter((s) => Object.keys(s.pieces).length >= minPieces);
  return Array.from({ length: n }, (_, i) => big[Math.floor(((i + 0.5) * big.length) / n)]!);
}
