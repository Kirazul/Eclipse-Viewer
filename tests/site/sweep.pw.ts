/**
 * Every choice on a real body, worn and looked at. What a sweep proves:
 *  - the choice list is what Eclipse's load_tree gives for this ChrModel
 *    (bake/test/fixtures/golden-custom.json);
 *  - the geosets on screen for the first look and for every single change are what the
 *    shared rules compute;
 *  - no choice looks broken: measured on the head, against the first look. A black or
 *    white area where the first look has skin, or a hole, fails.
 * It leaves a contact sheet per body in tests/site/results/shots/.
 *
 * SWEEP_BASE points it at another build, such as the cloud's packs through the live site.
 * A local pack is partial (--tex-budget-mb): a choice whose art wasn't baked is counted
 * and skipped, never rendered with holes.
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { ModelManifest } from "../../packages/format/src/index";
import { lookGeosets, lookPaint, settleLook, type CustomOption, type CustomizationData, type Look } from "../../packages/format/src/look";

const REAL = process.env.SWEEP_BASE ?? "http://localhost:4330/Eclipse-Viewer/";
const OUT = "tests/site/results/shots";
const PACKS = "site/public/packs";
mkdirSync(OUT, { recursive: true });

interface Win {
  eclipse: {
    frames(): number;
    setLook(look: Look): Promise<void>;
    loadCustomization(): Promise<CustomizationData | null>;
    pauseAnimation(): void;
    setAnimationTime(s: number): void;
    internals: { visibleGeosets(): number[]; drawOnce(): void };
  };
  __shots: { label: string; url: string; m: Metric }[];
}
interface Metric {
  coverage: number;
  black: number;
  white: number;
}

const openBody = async (page: Page, body: string) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.location().url.includes("catalog.json")) errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${REAL}wardrobe/?body=${body}&tab=customization`);
  await page.waitForFunction(() => (window as unknown as Win).eclipse?.frames?.() > 2, undefined, { timeout: 40_000 });
  return errors;
};

/**
 * A still head, straight on, filling the canvas: the same frame for every choice. It
 * stands on the helm attachment, the one point every body has at its head.
 */
const frameHead = (page: Page) =>
  page.evaluate(async () => {
    const e = (window as unknown as Win).eclipse as unknown as Win["eclipse"] & {
      figure: { assets: { manifest: ModelManifest }; bones: Map<string, { matrixWorld: { elements: number[] } }> };
      controls: { setLookAt(px: number, py: number, pz: number, tx: number, ty: number, tz: number, t: boolean): Promise<void>; update(d: number): void };
      updateDepthRange(): void;
    };
    e.pauseAnimation();
    e.setAnimationTime(0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const m = e.figure.assets.manifest;
    const a = m.attachments.find((x) => x.id === 11) ?? m.attachments[0]!;
    const w = e.figure.bones.get(`b${a.bone}`)!.matrixWorld.elements;
    const [x, y, z] = a.position as unknown as [number, number, number];
    const p = [w[0]! * x + w[4]! * y + w[8]! * z + w[12]!, w[1]! * x + w[5]! * y + w[9]! * z + w[13]!, w[2]! * x + w[6]! * y + w[10]! * z + w[14]!];
    const half = (m.bounds.max[1] - m.bounds.min[1]) * 0.13;
    const dist = half / Math.tan((5 * Math.PI) / 180);
    await e.controls.setLookAt(p[0]!, p[1]! - half * 0.15, p[2]! + dist, p[0]!, p[1]! - half * 0.15, p[2]!, false);
    e.controls.update(0);
    e.updateDepthRange();
    await new Promise((r) => setTimeout(r, 120));
    (window as unknown as Win).__shots = [];
  });

/** Reads the head out of the canvas after one drawn frame, and keeps it for the sheet. */
const capture = (page: Page, label: string) =>
  page.evaluate(async (name) => {
    const w = window as unknown as Win;
    w.eclipse.internals.drawOnce();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = document.getElementById("canvas") as HTMLCanvasElement;
    const img = new Image();
    img.src = c.toDataURL("image/png");
    await img.decode();
    // The canvas's middle square: the head, framed by frameHead.
    const side = Math.min(c.width, c.height);
    const o = document.createElement("canvas");
    o.width = o.height = 96;
    const x = o.getContext("2d", { willReadFrequently: true })!;
    x.drawImage(img, (c.width - side) / 2, (c.height - side) / 2, side, side, 0, 0, 96, 96);
    const d = x.getImageData(0, 0, 96, 96).data;
    let covered = 0;
    let black = 0;
    let white = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]! < 200) continue;
      covered++;
      const l = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
      if (l < 10) black++;
      if (d[i]! > 248 && d[i + 1]! > 248 && d[i + 2]! > 248) white++;
    }
    const m = { coverage: covered / 9216, black: covered ? black / covered : 0, white: covered ? white / covered : 0 };
    w.__shots.push({ label: name, url: o.toDataURL("image/png"), m });
    return m;
  }, label);

/** The sheet: every head, labelled with its choice, on the room's dark. */
async function sheet(page: Page, file: string) {
  const url = await page.evaluate(async () => {
    const shots = (window as unknown as Win).__shots;
    const cols = Math.min(24, Math.ceil(Math.sqrt(shots.length * 2)));
    const cell = 96;
    const rows = Math.ceil(shots.length / cols);
    const c = document.createElement("canvas");
    c.width = cols * cell;
    c.height = rows * (cell + 12);
    const x = c.getContext("2d")!;
    x.fillStyle = "#22242a";
    x.fillRect(0, 0, c.width, c.height);
    x.font = "9px sans-serif";
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i]!;
      const im = new Image();
      im.src = s.url;
      await im.decode();
      const px = (i % cols) * cell;
      const py = Math.floor(i / cols) * (cell + 12);
      x.drawImage(im, px, py);
      x.fillStyle = "#ddd";
      x.fillText(s.label.slice(0, 20), px + 1, py + cell + 9);
    }
    return c.toDataURL("image/png");
  });
  writeFileSync(file, Buffer.from(url.split(",")[1]!, "base64"));
}

/** Everything the look's art needs is in the pack. Only a partial local bake says no. */
function isBaked(data: CustomizationData, look: Look): boolean {
  const p = lookPaint(data, look);
  for (const t of p.mats.values()) if (!data.textures[t]?.key) return false;
  return true;
}

const asSet = (a: Iterable<number>) => [...new Set(a)].sort((x, y) => x - y);

for (const [body, chrModel] of [["human-male", 1], ["orcupright-male", 3], ["dracthyr-male", 89]] as const) {
  test(`every choice of ${body} draws what the rules say, and nothing breaks`, async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 0) < 700, "desktop");
    const manifestPath = `${PACKS}/models/${body}/manifest.json`;
    test.skip(!existsSync(manifestPath), `no ${manifestPath}`);
    const local = JSON.parse(readFileSync(manifestPath, "utf8")) as ModelManifest;
    test.skip(!local.customization, "baked before customization");
    test.setTimeout(420_000);

    const errors = await openBody(page, body);
    const data = (await page.evaluate(() => (window as unknown as Win).eclipse.loadCustomization())) as CustomizationData;
    expect(data).not.toBeNull();

    // ------------------------------------------------------------- the list itself
    const golden = "bake/test/fixtures/golden-custom.json";
    if (existsSync(golden)) {
      const want = (JSON.parse(readFileSync(golden, "utf8")) as Record<string, { id: number; name: string; choices: number[] }[]>)[String(chrModel)];
      if (want) {
        const got = data.options.map((o: CustomOption) => ({ id: o.id, name: o.name, choices: o.choices.map((c) => c.id) }));
        expect(got).toEqual(want);
      }
    }

    // ------------------------------------------------------------- the first look
    const first = settleLook(data.options, local.look ?? {});
    const on = () => page.evaluate(() => (window as unknown as Win).eclipse.internals.visibleGeosets());
    expect(asSet(await on())).toEqual(asSet(lookGeosets(data, first)));

    await frameHead(page);
    const base = await capture(page, "first look");
    console.log(`${body}: first look`, JSON.stringify(base), "geosets", asSet(await on()).join(","));
    expect(base.coverage).toBeGreaterThan(0.1);

    // ------------------------------------------------------------- every choice
    let worn = 0;
    let skipped = 0;
    const broken: string[] = [];
    let worstBlack = 0;
    let worstWhite = 0;
    for (const o of data.options) {
      for (const c of o.choices) {
        // A posture is a body of its own, proven by loading it.
        if (c.body) continue;
        const look = { ...first, [o.id]: c.id };
        if (!isBaked(data, look)) {
          skipped++;
          continue;
        }
        await page.evaluate((l) => (window as unknown as Win).eclipse.setLook(l), look);
        expect(asSet(await on()), `${o.name} ${c.id}`).toEqual(asSet(lookGeosets(data, look)));
        const m = await capture(page, `${o.name} ${c.name || c.id}`);
        worn++;
        worstBlack = Math.max(worstBlack, m.black - base.black);
        worstWhite = Math.max(worstWhite, m.white - base.white);
        const coverageLoss = (base.coverage - m.coverage) / base.coverage;
        if (m.black - base.black > 0.2 || m.white - base.white > 0.15 || coverageLoss > 0.3) {
          broken.push(`${o.name} / ${c.name || c.id} (${c.id}): black ${m.black.toFixed(3)} white ${m.white.toFixed(3)} coverage ${m.coverage.toFixed(3)}`);
        }
      }
    }
    await page.evaluate((l) => (window as unknown as Win).eclipse.setLook(l), first);
    await sheet(page, `${OUT}/sweep-${body}.png`);
    console.log(`${body}: ${worn} choices worn, ${skipped} skipped (art not baked locally); worst black +${worstBlack.toFixed(3)}, white +${worstWhite.toFixed(3)}; contact sheet ${OUT}/sweep-${body}.png`);
    expect(broken).toEqual([]);
    expect(errors).toEqual([]);
  });
}
