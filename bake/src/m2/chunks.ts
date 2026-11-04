/** Retail's chunked containers: `.m2`, `.skel`, `.anim`, `.phys`. Port of tools/lib/retail_m2.py. */

export type Chunks = Map<string, Buffer[]>;

export function parseChunks(data: Buffer): Chunks {
  const out: Chunks = new Map();
  if (data.toString("latin1", 0, 4) === "MD20") {
    out.set("MD20", [data]);
    return out;
  }
  let o = 0;
  while (o + 8 <= data.length) {
    const magic = data.toString("latin1", o, o + 4);
    const size = data.readUInt32LE(o + 4);
    if (o + 8 + size > data.length) throw new Error(`chunk ${JSON.stringify(magic)} at ${o} overruns the file`);
    const list = out.get(magic);
    const body = data.subarray(o + 8, o + 8 + size);
    if (list) list.push(body);
    else out.set(magic, [body]);
    o += 8 + size;
  }
  if (o !== data.length) throw new Error(`${data.length - o} trailing bytes after the last chunk`);
  return out;
}

export function chunk(c: Chunks, magic: string): Buffer | undefined {
  return c.get(magic)?.[0];
}

export function u32s(b: Buffer | undefined): number[] {
  if (!b) return [];
  const out: number[] = [];
  for (let i = 0; i + 4 <= b.length; i += 4) out.push(b.readUInt32LE(i));
  return out;
}

export interface AfidRow {
  animId: number;
  subId: number;
  fdid: number;
}

export function parseAfid(b: Buffer | undefined): AfidRow[] {
  if (!b) return [];
  const out: AfidRow[] = [];
  for (let i = 0; i + 8 <= b.length; i += 8) {
    out.push({ animId: b.readUInt16LE(i), subId: b.readUInt16LE(i + 2), fdid: b.readUInt32LE(i + 4) });
  }
  return out;
}

const ANIM_MAGICS = new Set(["AFM2", "AFSA", "AFSB", "AFCM"]);

export interface AnimFile {
  form: "chunked" | "raw";
  /**
   * The keyframe buffer named `which`. An empty buffer means this file has no such
   * block, so those arrays have no keys. A raw file has one buffer, serving every
   * name.
   */
  payload(which: "AFM2" | "AFSB" | "AFSA"): Buffer;
}

const EMPTY = Buffer.alloc(0);

/**
 * `.anim` has two forms and both exist at retail. Chunked AFM2/AFSB/AFSA is what
 * 12.1.0.69933 ships. The raw form is the whole file as one keyframe buffer,
 * addressed from offset 0, and starts with key times (0, 34, 67...) rather than a
 * magic. wago serves it for builds older than the pin. A raw file must not go
 * through the chunk parser: its timestamps read as absurd chunk sizes.
 */
export function parseAnim(data: Buffer): AnimFile {
  const magic = data.toString("latin1", 0, 4);
  if (ANIM_MAGICS.has(magic)) {
    const c = parseChunks(data);
    return { form: "chunked", payload: (which) => chunk(c, which) ?? EMPTY };
  }
  return { form: "raw", payload: () => data };
}

export interface M2Deps {
  skin: number[];
  texture: number[];
  anim: number[];
  skel: number[];
  bone: number[];
  phys: number[];
  recursive: number[];
  geometryParticle: number[];
}

/** FileDataIDs one `.m2` or `.skel` names. */
export function parseDeps(data: Buffer): M2Deps {
  const c = parseChunks(data);
  const nz = (b: Buffer | undefined) => u32s(b).filter((x) => x !== 0);
  const skel = nz(chunk(c, "SKID"));
  const skpd = chunk(c, "SKPD");
  if (skpd && skpd.length >= 12) {
    const parent = skpd.readUInt32LE(8);
    if (parent) skel.push(parent);
  }
  return {
    skin: nz(chunk(c, "SFID")),
    texture: nz(chunk(c, "TXID")),
    anim: [...new Set(parseAfid(chunk(c, "AFID")).map((r) => r.fdid).filter((f) => f !== 0))].sort((a, b) => a - b),
    skel,
    bone: nz(chunk(c, "BFID")),
    phys: nz(chunk(c, "PFID")),
    recursive: nz(chunk(c, "RPID")),
    geometryParticle: nz(chunk(c, "GPID")),
  };
}
