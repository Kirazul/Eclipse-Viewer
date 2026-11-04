import type { Page } from "@playwright/test";

export const SLOTS = ["head", "shoulder", "back", "chest", "shirt", "tabard", "wrist", "hands", "waist", "legs", "feet", "mainhand", "offhand", "ranged"] as const;

/** A catalogue big enough to make the grid earn its name. */
export function fixtureCatalog(perSlot = 400, icons: string[] = []) {
  const items: unknown[] = [];
  const lines = ["midnight", "warwithin"];
  const mats = ["cloth", "leather", "mail", "plate"];
  for (const slot of SLOTS) {
    for (let i = 0; i < perSlot; i++) {
      items.push({
        id: `${slot}-${i}`, name: `${i % 7 === 0 ? "Bronze" : "Sinister"} ${slot} ${i}`, slot, line: lines[i % 2], icon: icons.length ? icons[i % icons.length] : "", circle: "", tile: "", facet: mats[i % 4],
      });
    }
  }
  const sets = Array.from({ length: 300 }, (_, i) => ({
    id: `set-${i}`, name: `Set of Fate ${i}`, line: lines[i % 2], circle: "", tile: "",
    pieces: { head: `head-${i}`, chest: `chest-${i}`, legs: `legs-${i}` },
  }));
  return { formatVersion: 1, build: "t", generatedAt: "t", races: [], mounts: [], items, sets };
}

export const FIXTURE_SEARCH = [
  { n: "Human", i: "human", g: "race", c: "" },
  { n: "Human Male", i: "human-male", g: "body", c: "" },
  { n: "Human Female", i: "human-female", g: "body", c: "" },
  { n: "Night Elf", i: "nightelf", g: "race", c: "" },
  { n: "Swift Spectral Tiger", i: "mount-1", g: "mount", c: "" },
  { n: "Humanoid Mask of the Deep", i: "head-1", g: "item", c: "" },
  { n: "Shamanistic Hood", i: "head-2", g: "item", c: "" },
];

/** Packs that don't exist yet are the bake's business: the UI test answers for them. */
export async function mockPacks(page: Page, opts: { catalog?: unknown | null } = {}) {
  const catalog = opts.catalog === undefined ? fixtureCatalog() : opts.catalog;
  await page.route("**/packs/catalog/catalog.json", (r) =>
    catalog === null ? r.fulfill({ status: 404, body: "" }) : r.fulfill({ json: catalog }));
  await page.route("**/packs/catalog/search.json", (r) => r.fulfill({ json: FIXTURE_SEARCH }));
  await page.route("**/packs/catalog/search-items.json", (r) => r.fulfill({ json: [] }));
}

/** Everything the console says that is an actual error, minus packs that aren't baked. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (m.location().url.includes("/packs/")) return;
    errors.push(`console: ${m.text()} @ ${m.location().url}`);
  });
  return errors;
}

export async function startCls(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number; __shifts: unknown[] };
    w.__cls = 0;
    w.__shifts = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; sources?: { node?: Element }[] }[]) {
        w.__cls += e.value;
        w.__shifts.push({ value: e.value, nodes: (e.sources ?? []).map((s) => (s.node as Element | undefined)?.className || (s.node as Element | undefined)?.nodeName) });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

export const cls = (page: Page) => page.evaluate(() => (window as unknown as { __cls: number }).__cls);
export const shifts = (page: Page) => page.evaluate(() => (window as unknown as { __shifts: unknown[] }).__shifts);
export const calls = (page: Page, name?: string) =>
  page.evaluate((n) => ((window as unknown as { __engineCalls: { name: string; args: unknown[]; at: number }[] }).__engineCalls ?? []).filter((c) => !n || c.name === n), name);
export const clearCalls = (page: Page) => page.evaluate(() => { (window as unknown as { __engineCalls: unknown[] }).__engineCalls.length = 0; });

export async function openRoom(page: Page, query = "?body=human-male") {
  await page.goto(`wardrobe/${query}`);
  await page.waitForFunction(() => (window as unknown as { __engineCalls?: { name: string }[] }).__engineCalls?.some((c) => c.name === "loadModel"));
}
