import type { Frame } from "./sprites";
import type { Rgba } from "../tex/blp";

/** The pixel work of Eclipse's tools/art/ui_art.py, on straight RGBA. */

export function crop(img: Rgba, x: number, y: number, w: number, h: number): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) {
    const from = ((y + r) * img.width + x) * 4;
    data.set(img.data.subarray(from, from + w * 4), r * w * 4);
  }
  return { width: w, height: h, data };
}

export interface WhiteResult {
  img: Rgba;
  tint: [number, number, number];
  /** How far white * tint lands from retail's pixels: mean abs over drawn pixels, on black, 0-255. */
  err: number;
}

/**
 * A one-colour overlay as white with its intensity in the alpha, plus the colour
 * that puts it back. intensity = max(r, g, b); alpha' = alpha * intensity / peak. The
 * tint is the alpha-and-intensity weighted mean of each pixel's unit-max colour,
 * scaled back to the peak. The site can then draw the same shape in any colour.
 */
export function toWhite(src: Rgba): WhiteResult {
  const n = src.width * src.height;
  let peak = 1e-6;
  for (let i = 0; i < n; i++) {
    const m = Math.max(src.data[i * 4]!, src.data[i * 4 + 1]!, src.data[i * 4 + 2]!) / 255;
    if (m > peak) peak = m;
  }
  let wSum = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const r = src.data[i * 4]!;
    const g = src.data[i * 4 + 1]!;
    const b = src.data[i * 4 + 2]!;
    const a = src.data[i * 4 + 3]! / 255;
    const inten = Math.max(r, g, b) / 255;
    const w = a * inten;
    const denom = Math.max(inten * 255, 1e-6);
    sum[0]! += (r / denom) * w;
    sum[1]! += (g / denom) * w;
    sum[2]! += (b / denom) * w;
    wSum += w;
  }
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const tint: [number, number, number] = [clamp((sum[0]! / Math.max(wSum, 1e-9)) * peak * 255), clamp((sum[1]! / Math.max(wSum, 1e-9)) * peak * 255), clamp((sum[2]! / Math.max(wSum, 1e-9)) * peak * 255)];

  const out = new Uint8Array(n * 4);
  let err = 0;
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const r = src.data[i * 4]!;
    const g = src.data[i * 4 + 1]!;
    const b = src.data[i * 4 + 2]!;
    const a = src.data[i * 4 + 3]! / 255;
    const inten = Math.max(r, g, b) / 255;
    const alpha = Math.min(255, Math.max(0, Math.floor(((a * inten) / peak) * 255 + 0.5)));
    out[i * 4] = 255;
    out[i * 4 + 1] = 255;
    out[i * 4 + 2] = 255;
    out[i * 4 + 3] = alpha;
    if (a > 0.02) {
      const k = alpha / 255;
      err += Math.abs(r * a - tint[0] * k) + Math.abs(g * a - tint[1] * k) + Math.abs(b * a - tint[2] * k);
      drawn += 3;
    }
  }
  return { img: { width: src.width, height: src.height, data: out }, tint, err: drawn ? err / drawn : 0 };
}

/** How far, in sprite pixels, the sprite reaches past the frame it is drawn over. */
export function overhangOf(width: number, height: number, frame: Frame | null): [number, number] {
  if (!frame) return [0, 0];
  const [fw, fh, dwIn, dhIn] = frame;
  const dw = dwIn ?? width;
  const dh = dhIn ?? height;
  return [((dw - fw) * 0.5 * width) / dw, ((dh - fh) * 0.5 * height) / dh];
}

/** Per-channel lookup tables taking src's distribution onto ref's (histogram matching). */
export function toneCurve(src: Rgba, ref: Rgba): Uint8Array[] {
  const out: Uint8Array[] = [];
  const cdf = (img: Rgba, c: number): Float64Array => {
    const hist = new Float64Array(256);
    const n = img.width * img.height;
    for (let i = 0; i < n; i++) hist[img.data[i * 4 + c]!]! += 1;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v]!;
      hist[v] = acc / n;
    }
    return hist;
  };
  for (let c = 0; c < 3; c++) {
    const s = cdf(src, c);
    const r = cdf(ref, c);
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      // numpy searchsorted, side left: first index where r[i] >= s[v].
      let lo = 0;
      let hi = 256;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (r[mid]! < s[v]!) lo = mid + 1;
        else hi = mid;
      }
      lut[v] = Math.min(255, lo);
    }
    out.push(lut);
  }
  return out;
}

/**
 * The classic bow in retail's style. Classic and retail's main-hand silhouettes are
 * the same object, so the curve between them carries retail's tone; the bow's own
 * match to retail's main hand carries its weight (it is thin and dark, and the
 * pair's curve alone leaves it faint); the two are averaged. The darkest tones then
 * fade to black on a smooth ramp, as retail's silhouettes stand on clean black.
 */
export function rangedFromClassic(classicMain: Rgba, classicRanged: Rgba, ref: Rgba): Rgba {
  const lut = toneCurve(classicMain, ref);
  const own = toneCurve(classicRanged, ref);
  const n = classicRanged.width * classicRanged.height;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const px = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const v = classicRanged.data[i * 4 + c]!;
      px[c] = (lut[c]![v]! + own[c]![v]! + 1) >> 1;
    }
    const lum = px[0]! * 0.3 + px[1]! * 0.59 + px[2]! * 0.11;
    let k = Math.max(0, Math.min(1, (lum - 28) / (60 - 28)));
    k = k * k * (3 - 2 * k);
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.max(0, Math.min(255, Math.floor(px[c]! * k + 0.5)));
    out[i * 4 + 3] = 255;
  }
  return { width: classicRanged.width, height: classicRanged.height, data: out };
}

/** The picture inside a file, by alpha over 8: the mount journal's is 404 x 512 of a 512 canvas. */
export function opaqueBounds(img: Rgba): { x: number; y: number; w: number; h: number } {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? { x: 0, y: 0, w: img.width, h: img.height } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
