import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blpInfo, blpLevelFor, blpLevelUnder, decodeBlp, hasAlpha } from "../src/tex/blp";
import { pickLevel } from "../src/bake/texture";

const fx = JSON.parse(readFileSync(new URL("./fixtures/synthetic.json", import.meta.url), "utf8"));

/** Worst difference per channel group: colour, then alpha. */
function worstDelta(a: Uint8Array, b: Uint8Array): { rgb: number; alpha: number } {
  let rgb = 0;
  let alpha = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (i % 4 === 3) alpha = Math.max(alpha, d);
    else rgb = Math.max(rgb, d);
  }
  return { rgb, alpha };
}

/**
 * Eclipse's blp.py decodes DXT through Pillow, whose BLP reader expands 565 by
 * shifting alone: white comes out 248. We replicate the high bits as a GPU does,
 * so white is 255, which is what the game shows. So DXT colour may differ from
 * those goldens by up to 7 levels and no further. Everything else is exact.
 */
const DXT_RGB_LIMIT = 7;

describe("BLP decode against Eclipse's blp.py", () => {
  for (const s of fx.blps as { name: string; blp: string; rgba: string; level1?: string; w: number; h: number }[]) {
    const rgbLimit = s.name.startsWith("dxt") ? DXT_RGB_LIMIT : 0;
    it(`${s.name} mip 0`, () => {
      const img = decodeBlp(Buffer.from(s.blp, "base64"));
      expect([img.width, img.height]).toEqual([s.w, s.h]);
      const d = worstDelta(img.data, Buffer.from(s.rgba, "base64"));
      expect(d.rgb).toBeLessThanOrEqual(rgbLimit);
      expect(d.alpha).toBe(0);
    });
    if (s.level1) {
      it(`${s.name} mip 1`, () => {
        const img = decodeBlp(Buffer.from(s.blp, "base64"), 1);
        expect([img.width, img.height]).toEqual([s.w / 2, s.h / 2]);
        const d = worstDelta(img.data, Buffer.from(s.level1!, "base64"));
        expect(d.rgb).toBeLessThanOrEqual(rgbLimit);
        expect(d.alpha).toBe(0);
      });
    }
  }

  it("expands 565 the way a GPU does: white is 255", () => {
    const head = Buffer.alloc(148 + 1024 + 8);
    head.write("BLP2", 0, "latin1");
    head.writeUInt32LE(1, 4);
    head[8] = 2;
    head[9] = 0;
    head[10] = 0;
    head[11] = 0;
    head.writeUInt32LE(4, 12);
    head.writeUInt32LE(4, 16);
    head.writeUInt32LE(148 + 1024, 20);
    head.writeUInt32LE(8, 84);
    head.writeUInt16LE(0xffff, 148 + 1024);
    head.writeUInt16LE(0xffff, 148 + 1024 + 2);
    const img = decodeBlp(head);
    expect(Array.from(img.data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
  });

  it("keeps palettised alpha from the plane, the trap Pillow falls in", () => {
    const s = fx.blps.find((b: { name: string }) => b.name === "palette");
    const img = decodeBlp(Buffer.from(s.blp, "base64"));
    expect(hasAlpha(img)).toBe(true);
    const alphas = new Set<number>();
    for (let i = 3; i < img.data.length; i += 4) alphas.add(img.data[i]!);
    expect(alphas.size).toBeGreaterThan(2);
  });

  it("treats alpha depth 0 as opaque whatever the DXT block says", () => {
    const d = Buffer.from(fx.blps.find((b: { name: string }) => b.name === "dxt5").blp, "base64");
    const opaque = Buffer.from(d);
    opaque[9] = 0;
    expect(hasAlpha(decodeBlp(opaque))).toBe(false);
  });
});

describe("BLP levels", () => {
  const d = Buffer.from(fx.blps[0].blp, "base64");
  const info = blpInfo(d);

  it("lists the stored levels", () => {
    expect(info.levels[0]).toEqual([8, 8]);
    expect(info.levels[1]).toEqual([4, 4]);
    expect(info.levels.length).toBe(4);
  });

  it("finds an exact level, else 0", () => {
    expect(blpLevelFor(info, 4, 4)).toBe(1);
    expect(blpLevelFor(info, 5, 5)).toBe(0);
  });

  it("finds the first level under a cap", () => {
    expect(blpLevelUnder(info, 16)).toBe(0);
    expect(blpLevelUnder(info, 4)).toBe(1);
    expect(blpLevelUnder(info, 1)).toBe(3);
  });

  it("picks the smallest level still big enough for a rect", () => {
    expect(pickLevel(info, { w: 4, h: 4 })).toBe(1);
    expect(pickLevel(info, { w: 3, h: 3 })).toBe(1);
    expect(pickLevel(info, { w: 5, h: 4 })).toBe(0);
    // Asked for more than it has: the largest there is, never an upscale.
    expect(pickLevel(info, { w: 100, h: 100 })).toBe(0);
    expect(pickLevel(info, { cap: 4 })).toBe(1);
  });

  it("refuses what isn't BLP2", () => {
    expect(() => blpInfo(Buffer.from("PNG"))).toThrow(/BLP2/);
  });
});
