import type { BoneSetData } from "@eclipse/format";

/**
 * Retail's `.bone` files: the face and body-shape bone sets a customization choice
 * wears (ChrCustomizationBoneSet). Port of Eclipse's tools/races/races_body.py
 * read_bone_file and face_bones.
 *
 * A .bone matrix's ROTATION is in an axis frame of its own (model x = its z, y = y,
 * z = -x) while its TRANSLATION is already in model axes, and the whole is applied
 * about the bone's pivot. Decoded this way all five Zandalari male face files equal
 * retail's own FacePose (808) variants to 0.0005. The client multiplies the result in
 * front of the posed bone, after the hierarchy, so children don't inherit it.
 */
export interface RawBoneEntry {
  bone: number;
  /** 16 floats as stored: row-vector form, translation in the fourth row. */
  m: number[];
}

export function readBoneFile(d: Buffer): RawBoneEntry[] {
  if (d.length < 4 || d.readUInt32LE(0) !== 1) throw new Error(".bone is not version 1");
  let ids: number[] = [];
  const mats: number[][] = [];
  let o = 4;
  while (o + 8 <= d.length) {
    const tag = d.toString("latin1", o, o + 4);
    const n = d.readUInt32LE(o + 4);
    if (tag === "BIDA") {
      ids = [];
      for (let i = 0; i < n >> 1; i++) ids.push(d.readUInt16LE(o + 8 + i * 2));
    } else if (tag === "BOMT") {
      for (let i = 0; i < Math.floor(n / 64); i++) {
        const m: number[] = [];
        for (let k = 0; k < 16; k++) m.push(d.readFloatLE(o + 8 + i * 64 + k * 4));
        mats.push(m);
      }
    }
    o += 8 + n;
  }
  if (ids.length !== mats.length) throw new Error(`.bone: ${ids.length} ids, ${mats.length} matrices`);
  return ids.map((bone, i) => ({ bone, m: mats[i]! }));
}

type M3 = number[][];
const P: M3 = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]];
const mul3 = (a: M3, b: M3): M3 => a.map((r) => [0, 1, 2].map((c) => r[0]! * b[0]![c]! + r[1]! * b[1]![c]! + r[2]! * b[2]![c]!));
const trans3 = (a: M3): M3 => [0, 1, 2].map((c) => a.map((r) => r[c]!));
const round = (v: number) => Math.round(v * 1e5) / 1e5;

/** One entry as a column-major matrix in the baker's axes, about the bone's pivot. */
export function boneMatrix(raw: number[], pivot: readonly number[]): number[] {
  // Column-vector form of the stored row-vector matrix.
  const b = (r: number, c: number) => raw[c * 4 + r]!;
  const B: M3 = [0, 1, 2].map((r) => [b(r, 0), b(r, 1), b(r, 2)]);
  const R = mul3(mul3(P, B), trans3(P));
  const rp = R.map((row) => row[0]! * pivot[0]! + row[1]! * pivot[1]! + row[2]! * pivot[2]!);
  const t = [0, 1, 2].map((r) => b(r, 3) + pivot[r]! - rp[r]!);
  // Retail (x, y, z) -> baker (y, z, x), so retail's axis 0 is the baker's 2, on rows and columns alike.
  const to = [2, 0, 1];
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[to[c]! * 4 + to[r]!] = round(R[r]![c]!);
    out[12 + to[r]!] = round(t[r]!);
  }
  out[15] = 1;
  return out;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A file's matrices for this model. An entry that changes nothing is left out, and bytes with it. */
export function boneSetMatrices(entries: readonly RawBoneEntry[], model: { bones: readonly { pivot: readonly number[] }[] }): BoneSetData {
  const out: BoneSetData = [];
  for (const e of entries) {
    const bone = model.bones[e.bone];
    if (!bone) throw new Error(`.bone names bone ${e.bone} of ${model.bones.length}`);
    const m = boneMatrix(e.m, bone.pivot);
    if (m.some((v, i) => Math.abs(v - IDENTITY[i]!) > 2e-5)) out.push([e.bone, m]);
  }
  return out;
}

function mul4(a: readonly number[], b: readonly number[]): number[] {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return o.map(round);
}

/** Several sets, a later option's on top, as one per-bone list: posed * first * later. */
export function mergeBoneSets(lists: readonly BoneSetData[]): BoneSetData {
  const at = new Map<number, number[]>();
  for (const list of lists) {
    for (const [bone, m] of list) {
      const have = at.get(bone);
      at.set(bone, have ? mul4(have, m) : m);
    }
  }
  return [...at].sort((a, b) => a[0] - b[0]);
}
