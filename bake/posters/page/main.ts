/**
 * What the baker's headless browser runs: the engine's own cells, so a poster is drawn by
 * the code that draws the live cell over it. One call, one poster, read back as base64.
 */
import { FigureCells, type CellOptions } from "../../../engine/src/render/cells";

const base = new URLSearchParams(location.search).get("base") ?? "/packs";
const cells = new FigureCells(base);

function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(parts.join(""));
}

const w = window as unknown as {
  __poster(spec: CellOptions, width: number, height: number, supersample: number): Promise<{ width: number; height: number; pixels: string; nothing: boolean; renderer: string }>;
  __ready: boolean;
};

w.__poster = async (spec, width, height, supersample) => {
  const cap = await cells.capture(spec, width, height, supersample);
  const gl = cells.renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    width: cap.width,
    height: cap.height,
    nothing: cap.nothing,
    pixels: base64(cap.pixels),
    renderer: String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
  };
};
w.__ready = true;
