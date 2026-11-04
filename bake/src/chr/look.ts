import { type Db2, byId, num } from "../db2/db2";

/**
 * A body's texture layout: the canvas, its sections and the layers painted on it, from
 * ChrModel -> CharComponentTextureLayouts -> ChrModelTextureLayer. The customization
 * tree itself is chr/tree.ts.
 */

export const LAYER_TABLES = ["ChrModel", "ChrModelTextureLayer", "CharComponentTextureSections", "CharComponentTextureLayouts"];

export interface LayerRow {
  type: number;
  layer: number;
  blend: number;
  /** Whole-layout rect, in layout pixels. */
  rect: { x: number; y: number; w: number; h: number };
  targets: number[];
  emissiveBlend: number;
  /** TextureSectionTypeBitMask: which sections the rect covers. -1 the whole canvas. */
  mask: number;
}

export interface Layout {
  id: number;
  width: number;
  height: number;
  rows: LayerRow[];
  /** Component section -> rect, in layout pixels. */
  sections: Map<number, { x: number; y: number; w: number; h: number }>;
}

export async function loadLayout(db: Db2, chrModel: number): Promise<Layout> {
  const model = byId(await db.table("ChrModel")).get(String(chrModel));
  if (!model) throw new Error(`ChrModel has no row ${chrModel}`);
  const id = model.CharComponentTextureLayoutID ?? "";
  const row = byId(await db.table("CharComponentTextureLayouts")).get(id);
  if (!row) throw new Error(`no texture layout ${id}`);
  const width = num(row.Width);
  const height = num(row.Height);
  const secs = new Map<number, { x: number; y: number; w: number; h: number }>();
  for (const s of await db.table("CharComponentTextureSections")) {
    if (s.CharComponentTextureLayoutID === id) secs.set(num(s.SectionType), { x: num(s.X), y: num(s.Y), w: num(s.Width), h: num(s.Height) });
  }
  const rows: LayerRow[] = [];
  for (const r of await db.table("ChrModelTextureLayer")) {
    if (r.CharComponentTextureLayoutsID !== id) continue;
    const mask = num(r.TextureSectionTypeBitMask);
    let rect = { x: 0, y: 0, w: width, h: height };
    if (mask !== -1) {
      const parts: { x: number; y: number; w: number; h: number }[] = [];
      for (let b = 0; b < 31; b++) {
        const s = secs.get(b);
        if (mask & (1 << b) && s) parts.push(s);
      }
      if (parts.length === 0) continue;
      const x0 = Math.min(...parts.map((p) => p.x));
      const y0 = Math.min(...parts.map((p) => p.y));
      rect = { x: x0, y: y0, w: Math.max(...parts.map((p) => p.x + p.w)) - x0, h: Math.max(...parts.map((p) => p.y + p.h)) - y0 };
    }
    rows.push({
      type: num(r.TextureType),
      layer: num(r.Layer),
      blend: num(r.BlendMode),
      rect,
      targets: [num(r.ChrModelTextureTargetID_0), num(r.ChrModelTextureTargetID_1)].filter((t) => t !== 0),
      emissiveBlend: num(r.Field_9_0_1_34365_006_2),
      mask,
    });
  }
  rows.sort((a, b) => a.layer - b.layer);
  return { id: num(id), width, height, rows, sections: secs };
}
