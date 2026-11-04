import { describe, expect, test } from "vitest";
import { fitPage } from "./fit";

// tools/tests/test_wardrobe_layout.py runs these against the C++, at Eclipse's 1.33 ppu.
const PPU = 1.33;

describe("fitPage, WardrobeLayout.h FitPage", () => {
  test("every size it is ever asked for fits, and keeps the camera's shape", () => {
    for (const w of [240, 320, 390, 480, 640, 800, 1024, 1304, 1600, 2560]) {
      for (const h of [200, 320, 480, 640, 720, 900, 1440]) {
        for (const kind of [1, 1.2]) {
          for (const maxRows of [1, 2, 3, 4, 5, 6]) {
            const p = fitPage(w, h, 78 * PPU * kind, 104 * PPU * kind, 16 * PPU * kind, 48, maxRows);
            expect(p.cellW).toBeGreaterThan(0);
            expect(p.cellH).toBeGreaterThan(0);
            expect(p.cols * p.rows).toBeLessThanOrEqual(48);
            expect(p.width).toBeLessThanOrEqual(w + 0.001);
            expect(p.height).toBeLessThanOrEqual(h + 0.001);
            expect(Math.abs(p.cellW / p.cellH - 0.75)).toBeLessThan(0.00001);
            expect(p.rows).toBeLessThanOrEqual(maxRows);
          }
        }
      }
    }
  });

  test("never past twice the base size", () => {
    const p = fitPage(4000, 4000, 100, 132, 21, 78, 3);
    expect(p.cellW).toBe(200);
    expect(p.cellH).toBe(264);
    expect(p.gap).toBe(42);
  });

  test("the rows are honoured down to half the base, then give way", () => {
    expect(fitPage(1000, 300, 100, 132, 21, 78, 3).rows).toBe(3);
    const short = fitPage(1000, 160, 100, 132, 21, 78, 3);
    expect(short.rows).toBeLessThan(3);
    expect(short.cellW).toBeGreaterThanOrEqual(50);
  });

  test("too narrow for one tile: one column of the widest that fits", () => {
    const p = fitPage(60, 900, 100, 132, 21, 78, 3);
    expect(p.cols).toBe(1);
    expect(p.cellW).toBe(60);
  });

  test("capacity caps the columns", () => {
    const p = fitPage(4000, 400, 100, 132, 21, 6, 3);
    expect(p.cols * p.rows).toBeLessThanOrEqual(6);
  });

  test("nothing to lay out is nothing", () => {
    expect(fitPage(0, 400, 100, 132, 21, 78, 3).cellW).toBe(0);
    expect(fitPage(400, 0, 100, 132, 21, 78, 3).cellW).toBe(0);
  });
});
