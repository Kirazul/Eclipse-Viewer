/**
 * The figure grid's responsive layout, as pure maths: src/eclipse/wardrobe/WardrobeLayout.h
 * FitPage, line for line. Up to `maxRows` rows of the largest tiles the height holds, never
 * more than twice the base size, and as many columns of them as the width holds. Fewer rows
 * only when that many would shrink a tile below half the base; a width too narrow for one
 * tile at that size takes one column of the widest tile that fits.
 */
export interface FitPage {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  gap: number;
  width: number;
  height: number;
}

export function fitPage(width: number, height: number, baseW: number, baseH: number, baseGap: number, capacity: number, maxRows: number): FitPage {
  const best: FitPage = { cols: 1, rows: 1, cellW: 0, cellH: 0, gap: 0, width: 0, height: 0 };
  if (!(width > 0 && height > 0 && baseW > 0 && baseH > 0 && capacity > 0)) return best;
  const top = Math.max(1, Math.min(maxRows, capacity));
  let bestScale = 0;
  for (let rows = top; rows >= 1; --rows) {
    let scale = Math.min(2, height / (rows * baseH + (rows - 1) * baseGap));
    let cols = Math.floor((width + baseGap * scale) / ((baseW + baseGap) * scale));
    if (cols < 1) {
      scale = Math.min(scale, width / baseW);
      cols = 1;
    }
    cols = Math.min(cols, Math.max(1, Math.floor(capacity / rows)));
    if (scale < 0.5 && rows > 1) continue;
    best.cols = cols;
    best.rows = rows;
    bestScale = scale;
    break;
  }
  if (!(bestScale > 0)) return best;
  // Preserve the exact camera aspect ratio; independently rounding height and width
  // changes the projection on every resize.
  best.cellW = Math.floor(baseW * bestScale);
  best.cellH = (best.cellW * baseH) / baseW;
  best.gap = Math.floor(baseGap * bestScale);
  best.width = best.cols * best.cellW + (best.cols - 1) * best.gap;
  best.height = best.rows * best.cellH + (best.rows - 1) * best.gap;
  return best;
}

/** Retail's card: a 100 x 132 model, 16 units of gap at Eclipse's 1.33 pixels a unit. FigureGrid.h, UiMorph.cpp. */
export const CARD = { w: 100, h: 132, gap: 21, setScale: 1.2, maxCells: 78, rows: 3, setRows: 2 } as const;

/** How far retail's frame reaches past the card and how wide its corners are, per pixel of card width. */
export const FRAME = {
  card: { over: 7 / 100, slice: 14 / 100 },
  set: { over: 8 / 178, slice: (14 * 194) / 114 / 178 },
} as const;
