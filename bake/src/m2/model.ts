import { type AnimFile, type Chunks, chunk, parseAfid, parseAnim, parseChunks, u32s } from "./chunks";

/**
 * A retail M2 and its skeleton, in the shape the baker needs: records read from
 * their buffers and keyframe arrays read per sequence on demand, because a body's
 * 400 sequences over 216 bones would be gigabytes as objects.
 *
 * Layouts follow Eclipse's tools/lib/m2model.py.
 */

export const SEQ_INLINE = 0x20;
export const SEQ_ALIAS = 0x40;
/**
 * Bit 0 marks a one-shot. Measured on Human male's 422 sequences: Stand, Walk, Run,
 * Stun, Jump are 0x820 (no bit), Death is 0x8a3, attacks and JumpStart/End are
 * 0x8a1. The contract's `loops` is its inverse.
 */
export const SEQ_ONE_SHOT = 0x01;

export interface RawSeq {
  id: number;
  variation: number;
  durationMs: number;
  flags: number;
  frequency: number;
  variationNext: number;
  aliasNext: number;
}

/** One skeleton's own sequences, bones and keyframe route. */
export interface SkelLevel {
  name: "model" | "child" | "parent";
  seqs: RawSeq[];
  gloops: number[];
  afid: Map<string, number>;
  /** Buffer the bone records and their inline keys live in (MD21 or SKB1). */
  boneBuf: Buffer;
  boneOff: number;
  boneCount: number;
  /** Which `.anim` block holds this level's bone keys. */
  animBlock: "AFM2" | "AFSB";
}

/** One sequence of the merged list. `level` and `concrete` say where its keys are. */
export interface Sequence {
  index: number;
  id: number;
  variation: number;
  durationMs: number;
  flags: number;
  frequency: number;
  alias: boolean;
  level: SkelLevel;
  /** Index in the level after following aliases: the keys actually played. */
  concrete: number;
}

export interface Bone {
  keyBone: number;
  flags: number;
  parent: number;
  crc: number;
  pivot: [number, number, number];
}

export interface Submesh {
  id: number;
  level: number;
  vertexStart: number;
  vertexCount: number;
  indexStart: number;
  indexCount: number;
  boneCount: number;
  boneStart: number;
}

export interface Batch {
  flags: number;
  priority: number;
  shader: number;
  submesh: number;
  colorIndex: number;
  materialIndex: number;
  materialLayer: number;
  textureCount: number;
  textureCombo: number;
  coordCombo: number;
  weightCombo: number;
  transformCombo: number;
}

export interface Skin {
  lookup: Uint16Array;
  indices: Uint16Array;
  submeshes: Submesh[];
  batches: Batch[];
}

export interface M2Texture {
  type: number;
  flags: number;
  fileDataId: number;
}

export interface M2Attachment {
  id: number;
  bone: number;
  position: [number, number, number];
}

const BONE_BYTES = 88;
const VERT_BYTES = 48;
const SEQ_BYTES = 64;

function readSeqs(buf: Buffer, n: number, o: number): RawSeq[] {
  const out: RawSeq[] = [];
  for (let i = 0; i < n; i++) {
    const b = o + i * SEQ_BYTES;
    out.push({
      id: buf.readUInt16LE(b),
      variation: buf.readUInt16LE(b + 2),
      durationMs: buf.readUInt32LE(b + 4),
      flags: buf.readUInt32LE(b + 12),
      frequency: buf.readInt16LE(b + 16),
      variationNext: buf.readInt16LE(b + 60),
      aliasNext: buf.readUInt16LE(b + 62),
    });
  }
  return out;
}

function afidMap(b: Buffer | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of parseAfid(b)) m.set(`${r.animId}.${r.subId}`, r.fdid);
  return m;
}

function resolveAlias(seqs: RawSeq[], i: number): number {
  let j = i;
  let hops = 0;
  while (j < seqs.length && seqs[j]!.flags & SEQ_ALIAS && hops < seqs.length) {
    j = seqs[j]!.aliasNext;
    hops++;
  }
  return j;
}

function skelLevel(name: "child" | "parent", sk: Chunks): SkelLevel {
  const sks = chunk(sk, "SKS1");
  const skb = chunk(sk, "SKB1");
  if (!sks || !skb) throw new Error(`.skel without SKS1/SKB1`);
  const gn = sks.readUInt32LE(0);
  const go = sks.readUInt32LE(4);
  const gloops: number[] = [];
  for (let i = 0; i < gn; i++) gloops.push(sks.readUInt32LE(go + i * 4));
  return {
    name,
    seqs: readSeqs(sks, sks.readUInt32LE(8), sks.readUInt32LE(12)),
    gloops,
    afid: afidMap(chunk(sk, "AFID")),
    boneBuf: skb,
    boneOff: skb.readUInt32LE(4),
    boneCount: skb.readUInt32LE(0),
    animBlock: "AFSB",
  };
}

/**
 * Keys of a clip can be spread over a `.anim` file. The baker loads it, samples,
 * and lets it go, so a body never holds all of them at once.
 */
export type AnimLoader = (fdid: number) => Promise<Buffer | null>;

export interface ClipBuffers {
  /** Buffer the bone keys of this clip are addressed in. Empty: no keys, the bones hold bind pose. */
  bones: Buffer;
  /** Same for the model's own tracks (colours, texture animations). */
  model: Buffer;
  /** FileDataID of the `.anim`, 0 when the clip is inline. */
  animFdid: number;
  /** "chunked", "raw" or "inline". */
  form: string;
}

export class M2Model {
  readonly chunks: Chunks;
  readonly md: Buffer;
  readonly version: number;
  readonly flags: number;
  readonly vertexCount: number;
  private readonly vertsAt: number;
  readonly levels: SkelLevel[];
  readonly sequences: Sequence[];
  readonly bones: Bone[];
  readonly gloops: number[];
  readonly attachments: M2Attachment[];
  readonly textures: M2Texture[];
  readonly materials: { flags: number; blend: number }[];
  readonly texLookup: number[];
  readonly weightLookup: number[];
  readonly transformLookup: number[];
  readonly coordLookup: number[];
  readonly boneLookup: number[];
  readonly particleCount: number;
  readonly ribbonCount: number;
  readonly lightCount: number;
  /** FileDataIDs of `.bone` files, from the M2 or its skeleton. */
  readonly boneFiles: number[];
  /** Keyframe arrays a `.anim` was too short to hold: no keys, the bone holds. Counted, not hidden. */
  shortArrays = 0;

  constructor(m2: Buffer, skel?: Buffer, parentSkel?: Buffer) {
    this.chunks = parseChunks(m2);
    const md = chunk(this.chunks, "MD21") ?? chunk(this.chunks, "MD20");
    if (!md) throw new Error("no MD20/MD21 payload");
    if (md.toString("latin1", 0, 4) !== "MD20") throw new Error("MD21 payload does not start with MD20");
    this.md = md;
    this.version = md.readUInt32LE(4);
    this.flags = md.readUInt32LE(0x10);
    this.vertexCount = md.readUInt32LE(0x3c);
    this.vertsAt = md.readUInt32LE(0x40);

    const sk = skel ? parseChunks(skel) : null;
    const levels: SkelLevel[] = [];
    if (sk) {
      levels.push(skelLevel("child", sk));
    } else {
      const gn = md.readUInt32LE(0x14);
      const go = md.readUInt32LE(0x18);
      const gloops: number[] = [];
      for (let i = 0; i < gn; i++) gloops.push(md.readUInt32LE(go + i * 4));
      levels.push({
        name: "model",
        seqs: readSeqs(md, md.readUInt32LE(0x1c), md.readUInt32LE(0x20)),
        gloops,
        afid: afidMap(chunk(this.chunks, "AFID")),
        boneBuf: md,
        boneOff: md.readUInt32LE(0x30),
        boneCount: md.readUInt32LE(0x2c),
        animBlock: "AFM2",
      });
    }
    if (parentSkel) {
      const psk = parseChunks(parentSkel);
      if (chunk(psk, "SKPD")) throw new Error("parent skeleton has a parent of its own: no retail body does, refusing to guess");
      levels.push(skelLevel("parent", psk));
    }
    this.levels = levels;
    const main = levels[0]!;
    this.gloops = main.gloops;
    this.bones = this.readBones(main);
    if (levels[1]) this.checkChain(main, levels[1]);
    this.sequences = this.mergeSequences();

    const ska = sk ? chunk(sk, "SKA1") : undefined;
    this.attachments = ska
      ? readAttachments(ska, ska.readUInt32LE(0), ska.readUInt32LE(4))
      : readAttachments(md, md.readUInt32LE(0xf0), md.readUInt32LE(0xf4));

    const txid = u32s(chunk(this.chunks, "TXID"));
    this.textures = [];
    const tn = md.readUInt32LE(0x50);
    const to = md.readUInt32LE(0x54);
    for (let i = 0; i < tn; i++) {
      this.textures.push({ type: md.readUInt32LE(to + i * 16), flags: md.readUInt32LE(to + i * 16 + 4), fileDataId: txid[i] ?? 0 });
    }
    this.materials = [];
    const mn = md.readUInt32LE(0x70);
    const mo = md.readUInt32LE(0x74);
    for (let i = 0; i < mn; i++) this.materials.push({ flags: md.readUInt16LE(mo + i * 4), blend: md.readUInt16LE(mo + i * 4 + 2) });

    const i16s = (at: number): number[] => {
      const n = md.readUInt32LE(at);
      const o = md.readUInt32LE(at + 4);
      const a: number[] = [];
      for (let i = 0; i < n; i++) a.push(md.readInt16LE(o + i * 2));
      return a;
    };
    this.boneLookup = i16s(0x78);
    this.texLookup = i16s(0x80);
    this.coordLookup = i16s(0x88);
    this.weightLookup = i16s(0x90);
    this.transformLookup = i16s(0x98);
    this.lightCount = md.readUInt32LE(0x108);
    this.ribbonCount = md.readUInt32LE(0x120);
    this.particleCount = md.readUInt32LE(0x128);
    this.boneFiles = [...new Set([...u32s(chunk(this.chunks, "BFID")), ...(sk ? u32s(chunk(sk, "BFID")) : [])])].filter((f) => f !== 0);
  }

  private readBones(level: SkelLevel): Bone[] {
    const out: Bone[] = [];
    const b = level.boneBuf;
    for (let i = 0; i < level.boneCount; i++) {
      const o = level.boneOff + i * BONE_BYTES;
      out.push({
        keyBone: b.readInt32LE(o),
        flags: b.readUInt32LE(o + 4),
        parent: b.readInt16LE(o + 8),
        crc: b.readUInt32LE(o + 12),
        pivot: [b.readFloatLE(o + 76), b.readFloatLE(o + 80), b.readFloatLE(o + 84)],
      });
    }
    return out;
  }

  private checkChain(child: SkelLevel, parent: SkelLevel): void {
    if (child.boneCount !== parent.boneCount) throw new Error(`child / parent skeletons have ${child.boneCount} / ${parent.boneCount} bones`);
    const pb = this.readBones(parent);
    this.bones.forEach((a, i) => {
      const b = pb[i]!;
      if (a.keyBone !== b.keyBone || a.parent !== b.parent || a.crc !== b.crc) throw new Error("child and parent skeletons differ in structure");
    });
    parent.gloops.forEach((g, i) => {
      if (child.gloops[i] !== g) throw new Error("the parent's global loops are not a prefix of the child's");
    });
  }

  /**
   * A chained body takes the parent's sequence list, with each child sequence
   * replacing its (id, variation) and child-only ones appended. Every key comes
   * from its own skeleton's buffers and `.anim` files.
   */
  private mergeSequences(): Sequence[] {
    const child = this.levels[0]!;
    const parent = this.levels[1];
    const order: { level: SkelLevel; i: number }[] = [];
    if (parent) {
      const at = new Map<string, number>();
      parent.seqs.forEach((s, i) => {
        order.push({ level: parent, i });
        at.set(`${s.id}.${s.variation}`, i);
      });
      child.seqs.forEach((s, i) => {
        const k = at.get(`${s.id}.${s.variation}`);
        if (k !== undefined) order[k] = { level: child, i };
        else order.push({ level: child, i });
      });
    } else {
      child.seqs.forEach((_s, i) => order.push({ level: child, i }));
    }
    return order.map(({ level, i }, index) => {
      const s = level.seqs[i]!;
      return {
        index,
        id: s.id,
        variation: s.variation,
        durationMs: s.durationMs,
        flags: s.flags,
        frequency: s.frequency,
        alias: (s.flags & SEQ_ALIAS) !== 0,
        level,
        concrete: resolveAlias(level.seqs, i),
      };
    });
  }

  /** The `.anim` behind a sequence, 0 when its keys are inline. */
  animFileOf(seq: Sequence): number {
    const concrete = seq.level.seqs[seq.concrete];
    if (!concrete || concrete.flags & SEQ_INLINE) return 0;
    return seq.level.afid.get(`${concrete.id}.${concrete.variation}`) ?? 0;
  }

  /** Is the sequence external (no 0x20) but with no file? Retail has these; such a clip has no keys. */
  isExternalWithoutFile(seq: Sequence): boolean {
    const concrete = seq.level.seqs[seq.concrete];
    return !!concrete && !(concrete.flags & SEQ_INLINE) && this.animFileOf(seq) === 0;
  }

  async clipBuffers(seq: Sequence, load: AnimLoader): Promise<ClipBuffers> {
    const fdid = this.animFileOf(seq);
    const concrete = seq.level.seqs[seq.concrete];
    if (concrete && concrete.flags & SEQ_INLINE) return { bones: seq.level.boneBuf, model: this.md, animFdid: 0, form: "inline" };
    const data = fdid ? await load(fdid) : null;
    if (!data) return { bones: Buffer.alloc(0), model: Buffer.alloc(0), animFdid: fdid, form: "missing" };
    const file: AnimFile = parseAnim(data);
    return { bones: file.payload(seq.level.animBlock), model: file.payload("AFM2"), animFdid: fdid, form: file.form };
  }

  /** Vertex fields for lookup index `v` of the MD21 vertex array. */
  vertexOffset(v: number): number {
    return this.vertsAt + v * VERT_BYTES;
  }
}

function readAttachments(buf: Buffer, n: number, o: number): M2Attachment[] {
  const out: M2Attachment[] = [];
  for (let i = 0; i < n; i++) {
    const b = o + i * 40;
    out.push({
      id: buf.readUInt32LE(b),
      bone: buf.readUInt16LE(b + 4),
      position: [buf.readFloatLE(b + 8), buf.readFloatLE(b + 12), buf.readFloatLE(b + 16)],
    });
  }
  return out;
}

export function parseSkin(data: Buffer): Skin {
  if (data.toString("latin1", 0, 4) !== "SKIN") throw new Error("not a skin");
  const nLookup = data.readUInt32LE(4);
  const oLookup = data.readUInt32LE(8);
  const nTris = data.readUInt32LE(12);
  const oTris = data.readUInt32LE(16);
  const nSubs = data.readUInt32LE(28);
  const oSubs = data.readUInt32LE(32);
  const nBatches = data.readUInt32LE(36);
  const oBatches = data.readUInt32LE(40);
  const lookup = new Uint16Array(nLookup);
  for (let i = 0; i < nLookup; i++) lookup[i] = data.readUInt16LE(oLookup + i * 2);
  const indices = new Uint16Array(nTris);
  for (let i = 0; i < nTris; i++) indices[i] = data.readUInt16LE(oTris + i * 2);
  const submeshes: Submesh[] = [];
  for (let i = 0; i < nSubs; i++) {
    const b = oSubs + i * 48;
    const level = data.readUInt16LE(b + 2);
    submeshes.push({
      id: data.readUInt16LE(b),
      level,
      vertexStart: data.readUInt16LE(b + 4),
      vertexCount: data.readUInt16LE(b + 6),
      // A skin over 64k indices keeps the high bits of the start in `level`.
      indexStart: data.readUInt16LE(b + 8) | (level << 16),
      indexCount: data.readUInt16LE(b + 10),
      boneCount: data.readUInt16LE(b + 12),
      boneStart: data.readUInt16LE(b + 14),
    });
  }
  const batches: Batch[] = [];
  for (let i = 0; i < nBatches; i++) {
    const b = oBatches + i * 24;
    batches.push({
      flags: data[b]!,
      priority: data.readInt8(b + 1),
      shader: data.readUInt16LE(b + 2),
      submesh: data.readUInt16LE(b + 4),
      colorIndex: data.readInt16LE(b + 8),
      materialIndex: data.readUInt16LE(b + 10),
      materialLayer: data.readUInt16LE(b + 12),
      textureCount: data.readUInt16LE(b + 14),
      textureCombo: data.readUInt16LE(b + 16),
      coordCombo: data.readUInt16LE(b + 18),
      weightCombo: data.readUInt16LE(b + 20),
      transformCombo: data.readUInt16LE(b + 22),
    });
  }
  return { lookup, indices, submeshes, batches };
}

/**
 * The parent `.skel` a child names in SKPD, or 0. Read from the bytes because the
 * parent must be fetched before the model is built.
 */
export function parentSkeletonOf(skel: Buffer): number {
  const skpd = chunk(parseChunks(skel), "SKPD");
  return skpd && skpd.length >= 12 ? skpd.readUInt32LE(8) : 0;
}
