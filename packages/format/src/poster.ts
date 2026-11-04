/**
 * A poster: one frame of a grid cell, as a transparent image. The baker makes them in the
 * cloud, and a page makes the same picture for an entry the bake hasn't reached yet.
 */

/** Its size in pixels: twice a grid cell's base size (retail's 100 x 132 model, a set 1.2 times that). */
export const POSTER = {
  cell: { width: 200, height: 264 },
  set: { width: 240, height: 316 },
} as const;

/** The poster for this body: the sex that matches, or the one there is. */
export function posterFor(entry: { poster?: string; posterFemale?: string }, bodyId: string): string | undefined {
  return bodyId.endsWith("-female") ? entry.posterFemale ?? entry.poster : entry.poster ?? entry.posterFemale;
}

export interface PosterStats {
  /** Share of the frame with anything drawn on it. */
  coverage: number;
  /** Share of the outermost pixel ring that is drawn: high means the subject is cut by the frame. */
  edge: number;
}

/**
 * The canvas holds premultiplied colour, and a glow is colour with no alpha of its own: an
 * additive pass adds light and leaves alpha alone. A straight-alpha file would lose it. So
 * its alpha becomes its brightest channel, which composites to the very same pixel over
 * the black plate every cell has.
 */
export function toStraightAlpha(premultiplied: Uint8Array, width: number, height: number): { rgba: Uint8Array; stats: PosterStats } {
  const n = width * height;
  const out = new Uint8Array(n * 4);
  let drawn = 0;
  let edgeDrawn = 0;
  let edgeTotal = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = premultiplied[p]!;
    const g = premultiplied[p + 1]!;
    const b = premultiplied[p + 2]!;
    const a = Math.max(premultiplied[p + 3]!, r, g, b);
    if (a > 0) {
      const k = 255 / a;
      out[p] = Math.min(255, Math.round(r * k));
      out[p + 1] = Math.min(255, Math.round(g * k));
      out[p + 2] = Math.min(255, Math.round(b * k));
      out[p + 3] = a;
    }
    const solid = a >= 24;
    if (solid) drawn++;
    const x = i % width;
    const y = (i / width) | 0;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
      edgeTotal++;
      if (solid) edgeDrawn++;
    }
  }
  return { rgba: out, stats: { coverage: drawn / Math.max(1, n), edge: edgeDrawn / Math.max(1, edgeTotal) } };
}
