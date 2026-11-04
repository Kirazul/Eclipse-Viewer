/**
 * The TACT tables, read from Buffers and never copied into objects: a retail
 * encoding file is about 200 MB and an archive index set about 240 MB, so lookups
 * are binary searches over the bytes.
 */

/** `key = value value...` config files (build config, cdn config). */
export function parseConfig(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    const at = line.indexOf(" = ");
    if (at > 0) out.set(line.slice(0, at), line.slice(at + 3).trim().split(/\s+/));
  }
  return out;
}

// ---------------------------------------------------------------------------
// encoding: content key -> encoded key
// ---------------------------------------------------------------------------

export interface EncodingHeader {
  keyBytes: number;
  ekeyBytes: number;
  pageBytes: number;
  pageCount: number;
  /** Offset of the page table (first key + checksum per page). */
  tableAt: number;
  /** Offset of page 0. */
  pagesAt: number;
}

export function parseEncodingHeader(d: Buffer): EncodingHeader {
  if (d.toString("latin1", 0, 2) !== "EN") throw new Error("encoding: bad magic");
  const keyBytes = d[3]!;
  const ekeyBytes = d[4]!;
  const pageBytes = d.readUInt16BE(5) * 1024;
  const pageCount = d.readUInt32BE(9);
  const espec = d.readUInt32BE(18);
  const tableAt = 22 + espec;
  return { keyBytes, ekeyBytes, pageBytes, pageCount, tableAt, pagesAt: tableAt + pageCount * (keyBytes + 16) };
}

/** Which page can hold `ckey`: the last whose first key is <= ckey. */
export function encodingPageOf(d: Buffer, h: EncodingHeader, ckey: Buffer): number {
  let lo = 0;
  let hi = h.pageCount - 1;
  const stride = h.keyBytes + 16;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const first = d.subarray(h.tableAt + mid * stride, h.tableAt + mid * stride + h.keyBytes);
    if (Buffer.compare(first, ckey) <= 0) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Scan one page. Rows are `count u8, size u40, ckey, ekey x count`. */
export function encodingScanPage(page: Buffer, h: EncodingHeader, ckey: Buffer): string | null {
  let q = 0;
  while (q + 6 + h.keyBytes <= page.length) {
    const n = page[q]!;
    if (n === 0) break;
    if (page.compare(ckey, 0, h.keyBytes, q + 6, q + 6 + h.keyBytes) === 0) {
      return page.toString("hex", q + 6 + h.keyBytes, q + 6 + h.keyBytes + h.ekeyBytes);
    }
    q += 6 + h.keyBytes + h.ekeyBytes * n;
  }
  return null;
}

export function encodingLookup(d: Buffer, h: EncodingHeader, ckeyHex: string): string | null {
  const ckey = Buffer.from(ckeyHex, "hex");
  const p = encodingPageOf(d, h, ckey);
  const at = h.pagesAt + p * h.pageBytes;
  return encodingScanPage(d.subarray(at, at + h.pageBytes), h, ckey);
}

// ---------------------------------------------------------------------------
// root: file data id -> content key
// ---------------------------------------------------------------------------

const NO_NAME_HASH = 0x10000000;
const LOCALE_ENUS = 0x2;

/**
 * MFST root as a Map of fdid to the byte offset of its content key. A file with
 * per-locale copies resolves to the enUS one. The buffer stays alive, the keys
 * are not copied.
 */
export function parseRoot(d: Buffer): Map<number, number> {
  if (d.toString("latin1", 0, 4) !== "TSFM") throw new Error("root is not MFST");
  let headerSize = d.readUInt32LE(4);
  let version = d.readUInt32LE(8);
  if (headerSize > 1000 || (version !== 1 && version !== 2)) {
    headerSize = 12;
    version = 0;
  }
  const out = new Map<number, number>();
  let o = headerSize;
  while (o < d.length) {
    const n = d.readUInt32LE(o);
    let flags: number;
    let locale: number;
    if (version >= 2) {
      locale = d.readUInt32LE(o + 4);
      flags = d.readUInt32LE(o + 8) | d.readUInt32LE(o + 12) | (d[o + 16]! << 17);
      o += 17;
    } else {
      flags = d.readUInt32LE(o + 4);
      locale = d.readUInt32LE(o + 8);
      o += 12;
    }
    const deltasAt = o;
    o += 4 * n;
    const keysAt = o;
    const enUs = (locale & LOCALE_ENUS) !== 0;
    let fd = -1;
    for (let i = 0; i < n; i++) {
      fd += d.readInt32LE(deltasAt + i * 4) + 1;
      if (enUs || !out.has(fd)) out.set(fd, keysAt + i * 16);
    }
    o += 16 * n;
    if (!(flags & NO_NAME_HASH)) o += 8 * n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// archive index: encoded key -> size, offset
// ---------------------------------------------------------------------------

export interface IndexFooter {
  version: number;
  blockBytes: number;
  offsetBytes: number;
  sizeBytes: number;
  keyBytes: number;
  checksumBytes: number;
  elements: number;
  blocks: number;
}

/**
 * Last bytes of a `.index`, measured on 0017a402... at 12.1.0.69933: `toc hash[8],
 * version 1, 0, 0, blockKb 4, offset 4, size 4, key 16, checksum 8, elements u32
 * LE, footer hash[8]`. The file is `blocks`, then a TOC of last-key and hash per
 * block, then this. An offset of 6 is the merged archive-group form: a 2-byte
 * archive number, then the offset. (The CDN does not serve archive-group; clients
 * build it locally. The form is kept for a locally built one.)
 */
export function parseIndexFooter(d: Buffer): IndexFooter {
  if (d.length < 28) throw new Error("index: shorter than a footer");
  const checksumBytes = d[d.length - 13]!;
  const f = d.length - (checksumBytes + 8 + 4 + checksumBytes);
  const version = d[f + checksumBytes]!;
  const blockBytes = d[f + checksumBytes + 3]! * 1024;
  const offsetBytes = d[f + checksumBytes + 4]!;
  const sizeBytes = d[f + checksumBytes + 5]!;
  const keyBytes = d[f + checksumBytes + 6]!;
  const elements = d.readUInt32LE(f + checksumBytes + 8);
  if (version !== 1 || !blockBytes || keyBytes === 0) throw new Error("index: unexpected footer");
  const blocks = Math.floor(f / (blockBytes + keyBytes + checksumBytes));
  return { version, blockBytes, offsetBytes, sizeBytes, keyBytes, checksumBytes, elements, blocks };
}

export interface IndexHit {
  size: number;
  offset: number;
  /** Which archive, for the merged form; -1 otherwise. */
  archive: number;
}

export class ArchiveIndex {
  readonly footer: IndexFooter;
  private readonly tocAt: number;
  private readonly stride: number;

  constructor(private readonly d: Buffer) {
    this.footer = parseIndexFooter(d);
    this.tocAt = this.footer.blocks * this.footer.blockBytes;
    this.stride = this.footer.keyBytes + this.footer.sizeBytes + this.footer.offsetBytes;
  }

  lookup(key: Buffer): IndexHit | null {
    const f = this.footer;
    let lo = 0;
    let hi = f.blocks - 1;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const at = this.tocAt + mid * f.keyBytes;
      if (this.d.compare(key, 0, f.keyBytes, at, at + f.keyBytes) < 0) lo = mid + 1;
      else hi = mid;
    }
    const lastAt = this.tocAt + lo * f.keyBytes;
    if (this.d.compare(key, 0, f.keyBytes, lastAt, lastAt + f.keyBytes) < 0) return null;

    const start = lo * f.blockBytes;
    let a = 0;
    let b = Math.floor(f.blockBytes / this.stride) - 1;
    while (a <= b) {
      const mid = (a + b) >> 1;
      const at = start + mid * this.stride;
      const row = this.d.subarray(at, at + f.keyBytes);
      // A short block ends in zero padding: past the last key, so search left of it.
      const c = row.every((v) => v === 0) ? -1 : Buffer.compare(key.subarray(0, f.keyBytes), row);
      if (c === 0) return this.read(at);
      if (c < 0) b = mid - 1;
      else a = mid + 1;
    }
    return null;
  }

  private read(at: number): IndexHit {
    const f = this.footer;
    const sizeAt = at + f.keyBytes;
    const size = this.d.readUIntBE(sizeAt, f.sizeBytes);
    const offAt = sizeAt + f.sizeBytes;
    if (f.offsetBytes === 6) return { size, archive: this.d.readUInt16BE(offAt), offset: this.d.readUInt32BE(offAt + 2) };
    return { size, archive: -1, offset: f.offsetBytes ? this.d.readUIntBE(offAt, f.offsetBytes) : 0 };
  }

  /** Every entry, in file order. For tests and for building a merged index. */
  *entries(): Generator<{ key: string } & IndexHit> {
    const f = this.footer;
    for (let block = 0; block < f.blocks; block++) {
      const start = block * f.blockBytes;
      for (let i = 0; i + this.stride <= f.blockBytes; i += this.stride) {
        const row = this.d.subarray(start + i, start + i + f.keyBytes);
        if (row.every((v) => v === 0)) break;
        yield { key: row.toString("hex"), ...this.read(start + i) };
      }
    }
  }
}
