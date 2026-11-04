import { describe, expect, it } from "vitest";
import { crop, opaqueBounds, overhangOf, rangedFromClassic, toWhite, toneCurve } from "../src/ui/image";
import { CLASSIC, FILE_SCENES, SCENES, SPRITES } from "../src/ui/sprites";
import type { Rgba } from "../src/tex/blp";

function image(width: number, height: number, px: (x: number, y: number) => [number, number, number, number]): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(px(x, y), (y * width + x) * 4);
  return { width, height, data };
}

describe("the sprite list", () => {
  it("has every slot silhouette the ring needs, and the derived one", () => {
    for (const s of ["head", "shoulders", "back", "chest", "shirt", "tabard", "wrist", "hands", "waist", "legs", "feet", "mainhand", "offhand", "ranged", "enchant"]) {
      expect(SPRITES[`empty-${s}`], `empty-${s}`).toBeDefined();
    }
    expect(SPRITES["empty-ranged"]?.keep).toBe("derived");
    expect(CLASSIC.ranged).toBe(136520);
  });
  it("keeps retail's own frame geometry", () => {
    expect(SPRITES.card?.frame).toEqual([100, 132, 114, 146]);
    expect(SPRITES.setcard?.frame).toEqual([178, 218, 194, 234]);
    expect(SPRITES["slot-sel"]?.keep).toBe("white");
    expect(SPRITES["flip-card-left"]?.grid).toEqual([14, 1]);
  });
  it("lists a scene per class and the file scenes", () => {
    expect(Object.keys(SCENES).length).toBe(11);
    expect(SCENES.mage).toBe("dressingroom-background-mage");
    expect(FILE_SCENES.mount).toBe(651761);
  });
});

describe("cutting", () => {
  it("takes the rectangle asked for", () => {
    const img = image(4, 4, (x, y) => [x, y, 0, 255]);
    const c = crop(img, 1, 2, 2, 2);
    expect([c.width, c.height]).toEqual([2, 2]);
    expect(Array.from(c.data.subarray(0, 4))).toEqual([1, 2, 0, 255]);
    expect(Array.from(c.data.subarray(12, 16))).toEqual([2, 3, 0, 255]);
  });
  it("finds the picture inside a mostly empty file", () => {
    const img = image(6, 6, (x, y) => (x >= 2 && x < 5 && y >= 1 && y < 4 ? [9, 9, 9, 255] : [0, 0, 0, 0]));
    expect(opaqueBounds(img)).toEqual({ x: 2, y: 1, w: 3, h: 3 });
  });
});

describe("the white overlay", () => {
  it("turns one colour at varying intensity into white, alpha and a tint", () => {
    // A purple glow: the same hue at half strength on the second pixel.
    const img = image(2, 1, (x) => (x === 0 ? [200, 100, 50, 255] : [100, 50, 25, 255]));
    const w = toWhite(img);
    expect(w.tint).toEqual([200, 100, 50]);
    expect(Array.from(w.img.data.subarray(0, 3))).toEqual([255, 255, 255]);
    expect(w.img.data[3]).toBe(255);
    expect(w.img.data[7]).toBe(128);
    // white * tint puts retail's pixels back.
    expect(w.err).toBeLessThan(1);
  });
  it("carries source alpha into the intensity", () => {
    const img = image(2, 1, (x) => (x === 0 ? [255, 255, 255, 255] : [255, 255, 255, 51]));
    const w = toWhite(img);
    expect(w.img.data[7]).toBe(51);
  });
  it("survives an all-black sprite", () => {
    const w = toWhite(image(1, 1, () => [0, 0, 0, 255]));
    expect(w.tint).toEqual([0, 0, 0]);
  });
});

describe("overhang", () => {
  it("is half the difference between drawn and framed, in sprite pixels", () => {
    expect(overhangOf(114, 146, [100, 132, 114, 146])).toEqual([7, 7]);
    expect(overhangOf(194, 234, [178, 218, 194, 234])).toEqual([8, 8]);
    // A sprite with no drawn size takes its own (retail's useAtlasSize).
    expect(overhangOf(65, 65, [59, 59, null, null])).toEqual([3, 3]);
    expect(overhangOf(10, 10, null)).toEqual([0, 0]);
  });
});

describe("empty-ranged", () => {
  it("histogram-matches: a curve from an image to itself is the identity", () => {
    const img = image(16, 16, (x, y) => [(x * 16) & 255, (y * 16) & 255, 40, 255]);
    const lut = toneCurve(img, img);
    for (let v = 0; v < 256; v += 16) expect(lut[0]![v]).toBe(v);
  });
  it("is opaque, fades its darks to black and keeps its brights", () => {
    const main = image(4, 4, (x) => [x * 60, x * 60, x * 60, 255]);
    const ref = image(4, 4, (x) => [x * 80, x * 80, x * 80, 255]);
    const ranged = image(4, 4, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 255] : [180, 180, 180, 255]));
    const out = rangedFromClassic(main, ranged, ref);
    expect(out.data[3]).toBe(255);
    expect(out.data[0]).toBe(0);
    expect(out.data[(4 * 3 + 3) * 4]).toBeGreaterThan(100);
  });
});
