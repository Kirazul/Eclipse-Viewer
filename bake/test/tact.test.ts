import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { md5Hex } from "../src/lib/env";
import { BlteKeyMissing, decodeBlte, parseTactKeys } from "../src/tact/blte";
import { salsa20 } from "../src/tact/salsa20";
import { ArchiveIndex, encodingLookup, encodingPageOf, parseConfig, parseEncodingHeader, parseIndexFooter, parseRoot } from "../src/tact/tables";

const samples = JSON.parse(readFileSync(new URL("./fixtures/cdn-samples.json", import.meta.url), "utf8"));

function blocked(blocks: Buffer[], plainSizes: number[]): Buffer {
  const headerSize = 12 + blocks.length * 24;
  const head = Buffer.alloc(headerSize);
  head.write("BLTE", 0, "latin1");
  head.writeUInt32BE(headerSize, 4);
  head[8] = 0x0f;
  head.writeUIntBE(blocks.length, 9, 3);
  blocks.forEach((b, i) => {
    head.writeUInt32BE(b.length, 12 + i * 24);
    head.writeUInt32BE(plainSizes[i]!, 16 + i * 24);
    createHash("md5").update(b).digest().copy(head, 20 + i * 24);
  });
  return Buffer.concat([head, ...blocks]);
}

describe("BLTE", () => {
  it("reads a headerless plain block", () => {
    const d = Buffer.concat([Buffer.from("BLTE"), Buffer.alloc(4), Buffer.from("Nhello")]);
    expect(decodeBlte(d).toString()).toBe("hello");
  });

  it("reads a table of plain and zlib blocks", () => {
    const a = Buffer.from("first block ");
    const b = Buffer.from("second block, compressed ".repeat(20));
    const d = blocked([Buffer.concat([Buffer.from("N"), a]), Buffer.concat([Buffer.from("Z"), deflateSync(b)])], [a.length, b.length]);
    expect(decodeBlte(d).equals(Buffer.concat([a, b]))).toBe(true);
  });

  it("refuses a block that fails its checksum", () => {
    const b = Buffer.concat([Buffer.from("N"), Buffer.from("data")]);
    const d = blocked([b], [4]);
    d[d.length - 1] = d[d.length - 1]! ^ 0xff;
    expect(() => decodeBlte(d)).toThrow(/checksum/);
  });

  it("refuses a block whose size disagrees with the table", () => {
    expect(() => decodeBlte(blocked([Buffer.from("Nabcd")], [99]))).toThrow(/table says/);
  });

  it("decodes Salsa20 and xors the block index into the IV", () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const iv = Buffer.from("01020304", "hex");
    const plain = Buffer.concat([Buffer.from("N"), Buffer.from("secret payload")]);
    // Block 1 of a table: the cipher ran with the index in the IV.
    const ivUsed = Buffer.alloc(8);
    iv.copy(ivUsed);
    ivUsed[0] = ivUsed[0]! ^ 1;
    const cipher = Buffer.from(salsa20(key, ivUsed, plain));
    const name = Buffer.from("aabbccddeeff0011", "hex");
    const e = Buffer.concat([Buffer.from("E"), Buffer.from([8]), name, Buffer.from([4]), iv, Buffer.from("S"), cipher]);
    const first = Buffer.from("Nx");
    const d = blocked([first, e], [1, 14]);
    const keyName = Buffer.from(name).reverse().toString("hex").toUpperCase();
    expect(decodeBlte(d, (n) => (n === keyName ? key : undefined)).toString()).toBe("xsecret payload");
    expect(() => decodeBlte(d)).toThrow(BlteKeyMissing);
  });

  it("decodes real CDN objects, with the MD5 equal to the content key", () => {
    // vfs manifests of 12.1.0.69933: a zlib one and a plain one, fetched by encoded key.
    for (const s of [samples.v7, samples.v5]) {
      const plain = decodeBlte(Buffer.from(s.blte, "base64"));
      expect(md5Hex(plain)).toBe(s.ckey);
    }
  });
});

describe("Salsa20", () => {
  it("matches the eSTREAM vector for a 128-bit key", () => {
    // ECRYPT Salsa20/20 set 1, vector 0: key 80 00.., IV 0, first 16 bytes of keystream.
    const key = Buffer.alloc(16);
    key[0] = 0x80;
    const out = salsa20(key, Buffer.alloc(8), Buffer.alloc(16));
    expect(Buffer.from(out).toString("hex")).toBe("4dfa5e481da23ea09a31022050859936");
  });

  it("crosses a 64-byte block with the keystream continuing", () => {
    const key = Buffer.alloc(32, 1);
    const whole = salsa20(key, Buffer.alloc(8), Buffer.alloc(100));
    expect(whole.length).toBe(100);
    expect(Buffer.from(whole.subarray(0, 64)).equals(Buffer.from(whole.subarray(64)))).toBe(false);
  });
});

describe("TACT keys and config", () => {
  it("parses wowdev's key file", () => {
    const keys = parseTactKeys("FA505078126ACB3E BDC51862ABED79B2DE48C8E7E66C6200 WoW 8.0\nnot a key line\n");
    expect(Buffer.from(keys.get("FA505078126ACB3E")!).toString("hex")).toBe("bdc51862abed79b2de48c8e7e66c6200");
    expect(keys.size).toBe(1);
  });

  it("parses config files", () => {
    const c = parseConfig("# Build Configuration\n\nroot = abc\nencoding = 11 22\nencoding-size = 5 6\n");
    expect(c.get("root")).toEqual(["abc"]);
    expect(c.get("encoding")).toEqual(["11", "22"]);
  });
});

function encodingFile(rows: { ckey: string; ekeys: string[] }[], pageKb = 1): Buffer {
  const pageBytes = pageKb * 1024;
  const sorted = [...rows].sort((a, b) => a.ckey.localeCompare(b.ckey));
  const pages: Buffer[] = [];
  const firsts: Buffer[] = [];
  let page = Buffer.alloc(pageBytes);
  let at = 0;
  const flush = () => {
    pages.push(page);
    page = Buffer.alloc(pageBytes);
    at = 0;
  };
  for (const r of sorted) {
    const need = 6 + 16 + 16 * r.ekeys.length;
    if (at + need > pageBytes) flush();
    if (at === 0) firsts.push(Buffer.from(r.ckey, "hex"));
    page[at] = r.ekeys.length;
    Buffer.from(r.ckey, "hex").copy(page, at + 6);
    r.ekeys.forEach((e, i) => Buffer.from(e, "hex").copy(page, at + 22 + i * 16));
    at += need;
  }
  flush();
  const espec = Buffer.from("n\0");
  const head = Buffer.alloc(22);
  head.write("EN", 0, "latin1");
  head[2] = 1;
  head[3] = 16;
  head[4] = 16;
  head.writeUInt16BE(pageKb, 5);
  head.writeUInt16BE(pageKb, 7);
  head.writeUInt32BE(pages.length, 9);
  head.writeUInt32BE(0, 13);
  head.writeUInt32BE(espec.length, 18);
  const table = Buffer.concat(pages.map((_p, i) => Buffer.concat([firsts[i]!, Buffer.alloc(16)])));
  return Buffer.concat([head, espec, table, ...pages]);
}

const hexKey = (n: number) => createHash("md5").update(`key${n}`).digest("hex");

describe("encoding", () => {
  it("finds a content key across pages", () => {
    const rows = Array.from({ length: 200 }, (_v, i) => ({ ckey: hexKey(i), ekeys: [hexKey(i + 1000)] }));
    const file = encodingFile(rows);
    const h = parseEncodingHeader(file);
    expect(h.pageCount).toBeGreaterThan(2);
    for (const r of rows) expect(encodingLookup(file, h, r.ckey)).toBe(r.ekeys[0]);
    expect(encodingLookup(file, h, hexKey(99999))).toBeNull();
    expect(encodingPageOf(file, h, Buffer.alloc(16))).toBe(0);
  });

  it("takes the first of several encoded keys", () => {
    const file = encodingFile([{ ckey: hexKey(1), ekeys: [hexKey(2), hexKey(3)] }]);
    expect(encodingLookup(file, parseEncodingHeader(file), hexKey(1))).toBe(hexKey(2));
  });
});

function rootV2(blocks: { locale: number; flags: number; fdids: number[]; keys: string[] }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(20);
  head.write("TSFM", 0, "latin1");
  head.writeUInt32LE(20, 4);
  head.writeUInt32LE(2, 8);
  parts.push(head);
  for (const b of blocks) {
    const n = b.fdids.length;
    const h = Buffer.alloc(17);
    h.writeUInt32LE(n, 0);
    h.writeUInt32LE(b.locale, 4);
    h.writeUInt32LE(b.flags, 8);
    parts.push(h);
    const deltas = Buffer.alloc(n * 4);
    let prev = -1;
    b.fdids.forEach((f, i) => {
      deltas.writeInt32LE(f - prev - 1, i * 4);
      prev = f;
    });
    parts.push(deltas, ...b.keys.map((k) => Buffer.from(k, "hex")));
    if (!(b.flags & 0x10000000)) parts.push(Buffer.alloc(8 * n));
  }
  return Buffer.concat(parts);
}

describe("root", () => {
  const ckeyAt = (root: Buffer, m: Map<number, number>, f: number) => root.toString("hex", m.get(f)!, m.get(f)! + 16);

  it("walks fdid deltas with and without name hashes", () => {
    const root = rootV2([
      { locale: 2, flags: 0x10000000, fdids: [5, 6, 100], keys: [hexKey(5), hexKey(6), hexKey(100)] },
      { locale: 2, flags: 0, fdids: [1011653], keys: [hexKey(7)] },
    ]);
    const m = parseRoot(root);
    expect(m.size).toBe(4);
    expect(ckeyAt(root, m, 100)).toBe(hexKey(100));
    expect(ckeyAt(root, m, 1011653)).toBe(hexKey(7));
    expect(m.has(7)).toBe(false);
  });

  it("prefers the enUS copy of a file, wherever it comes", () => {
    const root = rootV2([
      { locale: 0x10, flags: 0x10000000, fdids: [9], keys: [hexKey(1)] },
      { locale: 2, flags: 0x10000000, fdids: [9], keys: [hexKey(2)] },
      { locale: 0x20, flags: 0x10000000, fdids: [9], keys: [hexKey(3)] },
    ]);
    expect(ckeyAt(root, parseRoot(root), 9)).toBe(hexKey(2));
  });

  it("refuses something else", () => {
    expect(() => parseRoot(Buffer.from("not a root at all, nope"))).toThrow(/MFST/);
  });
});

function indexFile(entries: { key: string; size: number; offset: number }[], blockKb = 1, offsetBytes = 4): Buffer {
  const blockBytes = blockKb * 1024;
  const stride = 16 + 4 + offsetBytes;
  const perBlock = Math.floor(blockBytes / stride);
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  const blocks: Buffer[] = [];
  const last: Buffer[] = [];
  for (let i = 0; i < sorted.length; i += perBlock) {
    const b = Buffer.alloc(blockBytes);
    const part = sorted.slice(i, i + perBlock);
    part.forEach((e, k) => {
      Buffer.from(e.key, "hex").copy(b, k * stride);
      b.writeUInt32BE(e.size, k * stride + 16);
      if (offsetBytes === 6) {
        b.writeUInt16BE(e.offset >>> 24, k * stride + 20);
        b.writeUInt32BE(e.offset & 0xffffff, k * stride + 22);
      } else {
        b.writeUInt32BE(e.offset, k * stride + 20);
      }
    });
    blocks.push(b);
    last.push(Buffer.from(part[part.length - 1]!.key, "hex"));
  }
  const toc = Buffer.concat([...last, ...blocks.map(() => Buffer.alloc(8))]);
  const footer = Buffer.alloc(28);
  footer[8] = 1;
  footer[11] = blockKb;
  footer[12] = offsetBytes;
  footer[13] = 4;
  footer[14] = 16;
  footer[15] = 8;
  footer.writeUInt32LE(sorted.length, 16);
  return Buffer.concat([...blocks, toc, footer]);
}

describe("archive index", () => {
  it("reads the footer of a real index", () => {
    // Last 28 bytes of archive 0017a402... at 12.1.0.69933, by byte range.
    const f = parseIndexFooter(Buffer.from(samples.indexFooter, "hex"));
    expect(f).toMatchObject({ version: 1, blockBytes: 4096, offsetBytes: 4, sizeBytes: 4, keyBytes: 16, checksumBytes: 8, elements: 7060 });
  });

  it("finds every key by binary search, across blocks", () => {
    const entries = Array.from({ length: 500 }, (_v, i) => ({ key: hexKey(i), size: i + 1, offset: i * 7 }));
    const idx = new ArchiveIndex(indexFile(entries));
    expect(idx.footer.blocks).toBeGreaterThan(5);
    for (const e of entries) {
      expect(idx.lookup(Buffer.from(e.key, "hex"))).toEqual({ size: e.size, offset: e.offset, archive: -1 });
    }
    expect(idx.lookup(Buffer.from(hexKey(9999), "hex"))).toBeNull();
    expect(idx.lookup(Buffer.alloc(16))).toBeNull();
    expect(idx.lookup(Buffer.alloc(16, 0xff))).toBeNull();
    expect([...idx.entries()].length).toBe(500);
  });

  it("reads the merged form's archive number", () => {
    const key = hexKey(1);
    const idx = new ArchiveIndex(indexFile([{ key, size: 10, offset: (3 << 24) | 77 }], 1, 6));
    expect(idx.lookup(Buffer.from(key, "hex"))).toEqual({ size: 10, offset: 77, archive: 3 });
  });
});
