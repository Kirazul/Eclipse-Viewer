/**
 * BLP2 to RGBA, mip by mip. Port of Eclipse's tools/lib/blp.py, with the DXT block
 * decode following Pillow's BcnDecode.c so results match that reader texel for
 * texel. Two traps that file records, both kept:
 *  - Palettised alpha comes from the plane after the indices, not the palette
 *    (Pillow takes the palette's, always 0, so palettised art came out transparent).
 *  - An alpha depth of 0 means opaque, whatever the payload says.
 */

export interface BlpInfo {
  encoding: number;
  alphaDepth: number;
  alphaType: number;
  hasMips: boolean;
  width: number;
  height: number;
  /** (w, h) of each stored level, level 0 first. */
  levels: [number, number][];
}

export interface Rgba {
  width: number;
  height: number;
  /** Straight (not premultiplied) RGBA8, top row first. */
  data: Uint8Array;
}

const HEADER = 148;
const PALETTE = 1024;

function readOffsets(d: Buffer): { offs: number[]; sizes: number[] } {
  const offs: number[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < 16; i++) {
    offs.push(d.readUInt32LE(20 + i * 4));
    sizes.push(d.readUInt32LE(84 + i * 4));
  }
  return { offs, sizes };
}

export function blpInfo(d: Buffer): BlpInfo {
  if (d.toString("latin1", 0, 4) !== "BLP2") throw new Error("not a BLP2");
  const encoding = d[8]!;
  const alphaDepth = d[9]!;
  const alphaType = d[10]!;
  const hasMips = d[11]! !== 0;
  const width = d.readUInt32LE(12);
  const height = d.readUInt32LE(16);
  const { offs, sizes } = readOffsets(d);
  const levels: [number, number][] = [];
  for (let i = 0; i < 16; i++) {
    if (!offs[i] || !sizes[i] || offs[i]! + sizes[i]! > d.length) break;
    levels.push([Math.max(1, width >> i), Math.max(1, height >> i)]);
    if (!hasMips && i === 0) break;
  }
  return { encoding, alphaDepth, alphaType, hasMips, width, height, levels };
}

/** The level stored at exactly (w, h), the texture's own downscale, else 0. */
export function blpLevelFor(info: BlpInfo, w: number, h: number): number {
  const i = info.levels.findIndex(([a, b]) => a === w && b === h);
  return i < 0 ? 0 : i;
}

/** The first level no larger than `cap` on either side, else the smallest. */
export function blpLevelUnder(info: BlpInfo, cap: number): number {
  const i = info.levels.findIndex(([a, b]) => a <= cap && b <= cap);
  return i < 0 ? info.levels.length - 1 : i;
}

export function decodeBlp(d: Buffer, level = 0): Rgba {
  const info = blpInfo(d);
  const dims = info.levels[level];
  if (!dims) throw new Error(`BLP has no level ${level} (${info.levels.length} stored)`);
  const [w, h] = dims;
  const { offs, sizes } = readOffsets(d);
  const off = offs[level]!;
  const size = sizes[level]!;
  let data: Uint8Array;
  switch (info.encoding) {
    case 1:
      data = decodePalette(d, off, w, h, info.alphaDepth);
      break;
    case 2:
      data = decodeDxt(d, off, size, w, h, info.alphaType);
      if (info.alphaDepth === 0) for (let i = 3; i < data.length; i += 4) data[i] = 255;
      break;
    case 3:
      data = decodeBgra(d, off, w, h, info.alphaDepth);
      break;
    default:
      throw new Error(`BLP2 encoding ${info.encoding} is not supported`);
  }
  return { width: w, height: h, data };
}

function decodeBgra(d: Buffer, off: number, w: number, h: number, depth: number): Uint8Array {
  const n = w * h;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = off + i * 4;
    out[i * 4] = d[p + 2]!;
    out[i * 4 + 1] = d[p + 1]!;
    out[i * 4 + 2] = d[p]!;
    out[i * 4 + 3] = depth === 0 ? 255 : d[p + 3]!;
  }
  return out;
}

function decodePalette(d: Buffer, off: number, w: number, h: number, depth: number): Uint8Array {
  const n = w * h;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const pal = HEADER + d[off + i]! * 4;
    out[i * 4] = d[pal + 2]!;
    out[i * 4 + 1] = d[pal + 1]!;
    out[i * 4 + 2] = d[pal]!;
    let a = 255;
    const plane = off + n;
    if (depth === 8) a = d[plane + i]!;
    else if (depth === 4) a = ((d[plane + (i >> 1)]! >> ((i & 1) * 4)) & 0x0f) * 17;
    else if (depth === 1) a = ((d[plane + (i >> 3)]! >> (i & 7)) & 1) * 255;
    else if (depth !== 0) throw new Error(`palettised BLP with alpha depth ${depth}`);
    out[i * 4 + 3] = a;
  }
  return out;
}

/** alphaType: 0 DXT1, 1 DXT3, 7 DXT5 (Pillow's reading of the BLP2 header). */
function decodeDxt(d: Buffer, off: number, size: number, w: number, h: number, alphaType: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const blockBytes = alphaType === 0 ? 8 : 16;
  const bw = Math.ceil(w / 4);
  const bh = Math.ceil(h / 4);
  if (bw * bh * blockBytes > size) throw new Error(`DXT level is ${size} bytes, needs ${bw * bh * blockBytes}`);
  const px = new Uint8Array(16 * 4);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const b = off + (by * bw + bx) * blockBytes;
      if (alphaType === 0) {
        bc1(d, b, false, px);
      } else if (alphaType === 1) {
        bc1(d, b + 8, true, px);
        for (let i = 0; i < 16; i++) {
          const v = (d[b + (i >> 1)]! >> ((i & 1) * 4)) & 0x0f;
          px[i * 4 + 3] = (v << 4) | v;
        }
      } else if (alphaType === 7) {
        bc1(d, b + 8, true, px);
        bc3Alpha(d, b, px);
      } else {
        throw new Error(`BLP2 DXT alpha type ${alphaType} is not supported`);
      }
      const rows = Math.min(4, h - by * 4);
      const cols = Math.min(4, w - bx * 4);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const to = ((by * 4 + y) * w + bx * 4 + x) * 4;
          const from = (y * 4 + x) * 4;
          out[to] = px[from]!;
          out[to + 1] = px[from + 1]!;
          out[to + 2] = px[from + 2]!;
          out[to + 3] = px[from + 3]!;
        }
      }
    }
  }
  return out;
}

function bc1(d: Buffer, b: number, separateAlpha: boolean, px: Uint8Array): void {
  const c0 = d.readUInt16LE(b);
  const c1 = d.readUInt16LE(b + 2);
  const cw = d.readUInt32LE(b + 4);
  const unpack = (v: number): [number, number, number] => {
    let r = (v & 0xf800) >> 8;
    r |= r >> 5;
    let g = (v & 0x07e0) >> 3;
    g |= g >> 6;
    let bl = (v & 0x001f) << 3;
    bl |= bl >> 5;
    return [r, g, bl];
  };
  const [r0, g0, b0] = unpack(c0);
  const [r1, g1, b1] = unpack(c1);
  const pal = new Uint8Array(16);
  pal.set([r0, g0, b0, 255, r1, g1, b1, 255]);
  if (c0 > c1 || separateAlpha) {
    pal.set([((2 * r0 + r1) / 3) | 0, ((2 * g0 + g1) / 3) | 0, ((2 * b0 + b1) / 3) | 0, 255], 8);
    pal.set([((r0 + 2 * r1) / 3) | 0, ((g0 + 2 * g1) / 3) | 0, ((b0 + 2 * b1) / 3) | 0, 255], 12);
  } else {
    pal.set([((r0 + r1) / 2) | 0, ((g0 + g1) / 2) | 0, ((b0 + b1) / 2) | 0, 255], 8);
    pal.set([0, 0, 0, 0], 12);
  }
  for (let i = 0; i < 16; i++) {
    const s = ((cw >>> (i * 2)) & 3) * 4;
    px[i * 4] = pal[s]!;
    px[i * 4 + 1] = pal[s + 1]!;
    px[i * 4 + 2] = pal[s + 2]!;
    px[i * 4 + 3] = pal[s + 3]!;
  }
}

function bc3Alpha(d: Buffer, b: number, px: Uint8Array): void {
  const a0 = d[b]!;
  const a1 = d[b + 1]!;
  const a = new Uint8Array(8);
  a[0] = a0;
  a[1] = a1;
  if (a0 > a1) {
    for (let i = 1; i <= 6; i++) a[i + 1] = (((7 - i) * a0 + i * a1) / 7) | 0;
  } else {
    for (let i = 1; i <= 4; i++) a[i + 1] = (((5 - i) * a0 + i * a1) / 5) | 0;
    a[6] = 0;
    a[7] = 255;
  }
  // 48 bits of 3-bit selectors. Past 32 bits, so built without bit shifts.
  let lo = d[b + 2]! | (d[b + 3]! << 8) | (d[b + 4]! << 16);
  let hi = d[b + 5]! | (d[b + 6]! << 8) | (d[b + 7]! << 16);
  for (let i = 0; i < 8; i++) {
    px[i * 4 + 3] = a[lo & 7]!;
    lo >>>= 3;
  }
  for (let i = 8; i < 16; i++) {
    px[i * 4 + 3] = a[hi & 7]!;
    hi >>>= 3;
  }
}

export function hasAlpha(img: Rgba): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return true;
  return false;
}
