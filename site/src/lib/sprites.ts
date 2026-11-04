/**
 * The UI's frames and glyphs, one file for every visitor: `ui/atlas.webp` and its map are
 * two reads where sixty sprite files were sixty. Each sprite a page uses is cut out once
 * and handed to CSS as `--sp-<name>`, because the frames are masks and nine-slices that a
 * background-position could not draw. It runs once per page and costs no layout: sizes
 * come from CSS, and `[data-art]` only turns on when every variable is set.
 */
import { packUrl, paths, type UiAtlas } from "@eclipse/format";
import { PACK_BASE } from "./base";

export async function loadUiAtlas(names: readonly string[]): Promise<boolean> {
  try {
    const [mapRes, imageRes] = await Promise.all([fetch(packUrl(PACK_BASE, paths.atlasMap())), fetch(packUrl(PACK_BASE, paths.atlas()))]);
    if (!mapRes.ok || !imageRes.ok) throw new Error("no atlas");
    const map = (await mapRes.json()) as UiAtlas;
    const sheet = await createImageBitmap(await imageRes.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const root = document.documentElement;
    await Promise.all(
      names.map(async (name) => {
        const r = map.sprites[name];
        if (!r) return;
        const canvas = new OffscreenCanvas(r.w, r.h);
        canvas.getContext("2d")!.drawImage(sheet, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        root.style.setProperty(`--sp-${name}`, `url(${URL.createObjectURL(await canvas.convertToBlob({ type: "image/png" }))})`);
      }),
    );
    sheet.close();
    root.dataset.art = "1";
    try { localStorage.setItem("ui-art", "1"); } catch { /* private window */ }
    return true;
  } catch {
    delete document.documentElement.dataset.art;
    try { localStorage.removeItem("ui-art"); } catch { /* private window */ }
    return false;
  }
}
