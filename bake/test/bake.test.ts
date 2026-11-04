import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Tracked, type BakeContext } from "../src/bake/context";
import { bakeTexture } from "../src/bake/texture";
import { Db2 } from "../src/db2/db2";
import { md5Hex } from "../src/lib/env";
import type { GameSource } from "../src/sources/source";
import { LocalStore } from "../src/store/store";
import { encodeKtx2 } from "../src/tex/ktx2";

/** A real BLP of `size` with a gradient, built here: no game data. */
function blp(size: number, seed: number): Buffer {
  const n = size * size;
  const head = Buffer.alloc(148 + 1024);
  head.write("BLP2", 0, "latin1");
  head.writeUInt32LE(1, 4);
  head[8] = 3; // raw BGRA
  head[9] = 8;
  head.writeUInt32LE(size, 12);
  head.writeUInt32LE(size, 16);
  head.writeUInt32LE(148 + 1024, 20);
  head.writeUInt32LE(n * 4, 84);
  const px = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    px[i * 4] = (i + seed) & 255;
    px[i * 4 + 1] = (i * 2 + seed) & 255;
    px[i * 4 + 2] = (i * 3) & 255;
    px[i * 4 + 3] = 255;
  }
  return Buffer.concat([head, px]);
}

function fakeSource(files: Map<number, Buffer>) {
  const reads: number[] = [];
  const source: GameSource = {
    name: "wago",
    read: async (f) => {
      reads.push(f);
      const b = files.get(f);
      if (!b) throw new Error(`no ${f}`);
      return { bytes: b, id: md5Hex(b) };
    },
    identity: async (f) => {
      const b = files.get(f);
      return b ? md5Hex(b) : null;
    },
  };
  return { source, reads };
}

describe("KTX2", () => {
  it("writes a real ETC1S file: magic, size, a full mip chain, BasisLZ", async () => {
    const data = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : (i * 7) & 255;
    const ktx = Buffer.from(await encodeKtx2({ width: 64, height: 64, data }));
    expect(ktx.subarray(0, 12).toString("hex")).toBe("ab4b5458203230bb0d0a1a0a");
    expect(ktx.readUInt32LE(20)).toBe(64); // pixelWidth
    expect(ktx.readUInt32LE(24)).toBe(64); // pixelHeight
    expect(ktx.readUInt32LE(40)).toBe(7); // levelCount: 64 down to 1
    expect(ktx.readUInt32LE(44)).toBe(1); // supercompressionScheme: BasisLZ
  });
});

describe("texture objects", () => {
  const root = mkdtempSync(join(tmpdir(), "bake-tex-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("two models using one file share one object, and the second reads no game file", async () => {
    const files = new Map([[100, blp(16, 1)]]);
    const { source, reads } = fakeSource(files);
    const ctx: BakeContext = { source, db: new Db2(), store: new LocalStore(root), force: false };
    const first = await bakeTexture(ctx, new Tracked(source), 100, { cap: 1024 });
    expect(reads).toEqual([100]);
    expect(first.key).toMatch(/^objects\/[0-9a-f]{32}\.ktx2$/);
    expect([first.width, first.height, first.alpha]).toEqual([16, 16, false]);

    const again = await bakeTexture(ctx, new Tracked(source), 100, { cap: 1024 });
    expect(again).toEqual(first);
    expect(reads).toEqual([100]);
  });

  it("different bytes are a different object, as is another size", async () => {
    const files = new Map([
      [100, blp(16, 1)],
      [200, blp(16, 9)],
    ]);
    const { source } = fakeSource(files);
    const ctx: BakeContext = { source, db: new Db2(), store: new LocalStore(root), force: false };
    const a = await bakeTexture(ctx, new Tracked(source), 100, { cap: 1024 });
    const b = await bakeTexture(ctx, new Tracked(source), 200, { cap: 1024 });
    const c = await bakeTexture(ctx, new Tracked(source), 100, { cap: 512 });
    expect(a.key).not.toBe(b.key);
    expect(a.key).not.toBe(c.key);
  });

  it("--force bakes again", async () => {
    const files = new Map([[100, blp(16, 1)]]);
    const { source, reads } = fakeSource(files);
    const ctx: BakeContext = { source, db: new Db2(), store: new LocalStore(root), force: true };
    await bakeTexture(ctx, new Tracked(source), 100, { cap: 1024 });
    expect(reads).toEqual([100]);
  });

  it("records each input's identity for the bake record", async () => {
    const b = blp(16, 3);
    const { source } = fakeSource(new Map([[300, b]]));
    const t = new Tracked(source);
    await bakeTexture({ source, db: new Db2(), store: new LocalStore(root), force: false }, t, 300, { cap: 1024 });
    expect(t.inputs).toEqual({ "300": md5Hex(b) });
  });
});
