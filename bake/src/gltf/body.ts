import type { SubmeshExtras, Vec3 } from "@eclipse/format";
import { MeshoptEncoder } from "meshoptimizer/encoder";
import type { Batch, M2Model, Skin, Submesh } from "../m2/model";
import { unitUvSources } from "../m2/shaders";
import { C_BYTE, C_FLOAT, C_UBYTE, C_UINT, C_USHORT, GlbWriter, T_ARRAY, T_INDEX, asBytes } from "./writer";

/** Precision of each stream. Human male's position stream is 173 KB at 15 bits, 162 KB at 14. */
export const PRECISION = {
  /** Mantissa bits with one exponent per axis: 15 bits over 2.1 m is 0.25 mm. */
  positionBits: 15,
  normalBits: 8,
  /** Over [-0.73, 1.02]: 14 bits is 1/8192 of a texture, a quarter texel at 2048. */
  uvBits: 14,
} as const;

export interface BuiltBody {
  glb: Buffer;
  primitives: number;
  vertices: number;
  triangles: number;
  /** Lookup index (into the skin) of each output vertex. */
  vertexSource: Uint32Array;
  /** First index and count of each submesh in the output index stream. */
  ranges: { submesh: number; first: number; count: number }[];
}

function batchExtras(model: M2Model, sub: Submesh, subIndex: number, batch: Batch | null): SubmeshExtras {
  if (!batch) {
    return { hash: subIndex, geoset: sub.id, units: [], shader: 0, blend: 0, flags: 0, priority: 0, color: -1, opacity: -1 };
  }
  const uvs = unitUvSources(batch.textureCount, batch.shader);
  const units: SubmeshExtras["units"] = [];
  for (let k = 0; k < batch.textureCount; k++) {
    const tex = model.texLookup[batch.textureCombo + k] ?? -1;
    const entry = tex >= 0 ? model.textures[tex] : undefined;
    const transform = model.transformLookup[batch.transformCombo + k] ?? -1;
    units.push({
      tex,
      uvSet: uvs[k] ?? 0,
      wrapS: !!entry && (entry.flags & 1) !== 0,
      wrapT: !!entry && (entry.flags & 2) !== 0,
      uvAnim: transform,
    });
  }
  const material = model.materials[batch.materialIndex];
  return {
    hash: subIndex,
    geoset: sub.id,
    units,
    shader: batch.shader,
    blend: material?.blend ?? 0,
    flags: material?.flags ?? 0,
    priority: batch.priority,
    color: batch.colorIndex,
    opacity: batch.weightCombo < model.weightLookup.length ? (model.weightLookup[batch.weightCombo] ?? -1) : -1,
  };
}

/**
 * The body GLB: skeleton nodes `b<n>` with identity rest transforms and no
 * inverseBindMatrices (identity by glTF's default), one mesh, and one primitive per
 * batch of every submesh of skin 0, each with its own material. All primitives
 * share one vertex stream and one index view, so the number of submeshes costs only
 * JSON and hiding a geoset is a draw call, not a buffer.
 *
 * Almost every submesh has one batch. A submesh with several (layered materials on
 * items and mounts) gets one primitive per batch over the same indices, the same
 * `hash`, and `priority` for their order.
 */
export function buildBodyGlb(model: M2Model, skin: Skin, jointName: (bone: number) => string = (b) => `b${b}`): BuiltBody {
  const batchesOf = new Map<number, Batch[]>();
  for (const b of skin.batches) {
    const list = batchesOf.get(b.submesh);
    if (list) list.push(b);
    else batchesOf.set(b.submesh, [b]);
  }
  for (const list of batchesOf.values()) list.sort((a, b) => a.priority - b.priority || a.materialLayer - b.materialLayer);

  // Per submesh: vertex-cache order, then vertices numbered by first use. That is
  // what meshopt's index and vertex codecs reward, across the shared stream too.
  const remap = new Map<number, number>();
  const vertexSource: number[] = [];
  const outIndices: number[] = [];
  const ranges: BuiltBody["ranges"] = [];
  skin.submeshes.forEach((sub, subIndex) => {
    const first = outIndices.length;
    const compact = new Map<number, number>();
    const inverse: number[] = [];
    const tris = new Uint32Array(sub.indexCount);
    for (let k = 0; k < sub.indexCount; k++) {
      const li = skin.indices[sub.indexStart + k]!;
      let c = compact.get(li);
      if (c === undefined) {
        c = inverse.length;
        compact.set(li, c);
        inverse.push(li);
      }
      tris[k] = c;
    }
    if (sub.indexCount > 0) {
      const [order] = MeshoptEncoder.reorderMesh(tris, true, false);
      const back = new Array<number>(inverse.length);
      order.forEach((to, from) => {
        if (to !== 0xffffffff) back[to] = inverse[from]!;
      });
      for (const v of tris) {
        const li = back[v]!;
        let out = remap.get(li);
        if (out === undefined) {
          out = vertexSource.length;
          remap.set(li, out);
          vertexSource.push(li);
        }
        outIndices.push(out);
      }
    }
    ranges.push({ submesh: subIndex, first, count: sub.indexCount });
  });

  const count = vertexSource.length;
  const md = model.md;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 4);
  const uv0 = new Float32Array(count * 2);
  const uv1 = new Float32Array(count * 2);
  const joints = new Uint8Array(count * 4);
  const weights = new Uint8Array(count * 4);

  // The second UV set only where a batch reads it: the other vertices stay zero
  // and all but vanish in the codec.
  const needsUv1 = new Uint8Array(skin.lookup.length);
  let anyUv1 = false;
  for (const b of skin.batches) {
    if (!unitUvSources(b.textureCount, b.shader).includes(1)) continue;
    const s = skin.submeshes[b.submesh];
    if (!s) continue;
    anyUv1 = true;
    for (let k = 0; k < s.indexCount; k++) needsUv1[skin.indices[s.indexStart + k]!] = 1;
  }

  for (let i = 0; i < count; i++) {
    const li = vertexSource[i]!;
    const o = model.vertexOffset(skin.lookup[li]!);
    const px = md.readFloatLE(o);
    const py = md.readFloatLE(o + 4);
    const pz = md.readFloatLE(o + 8);
    positions[i * 3] = py;
    positions[i * 3 + 1] = pz;
    positions[i * 3 + 2] = px;

    let sum = 0;
    for (let c = 0; c < 4; c++) sum += md[o + 12 + c]!;
    for (let c = 0; c < 4; c++) {
      const w = md[o + 12 + c]!;
      weights[i * 4 + c] = sum === 0 ? (c === 0 ? 255 : 0) : w;
      joints[i * 4 + c] = w === 0 && sum !== 0 ? 0 : md[o + 16 + c]!;
    }
    if (sum !== 0 && sum !== 255) {
      // Retail sums to 255; keep any outlier valid without changing the others.
      let acc = 0;
      for (let c = 0; c < 4; c++) {
        const w = Math.round((md[o + 12 + c]! * 255) / sum);
        weights[i * 4 + c] = w;
        acc += w;
      }
      weights[i * 4] = weights[i * 4]! + 255 - acc;
    }

    const nx = md.readFloatLE(o + 20);
    const ny = md.readFloatLE(o + 24);
    const nz = md.readFloatLE(o + 28);
    const nl = Math.hypot(nx, ny, nz) || 1;
    normals[i * 4] = ny / nl;
    normals[i * 4 + 1] = nz / nl;
    normals[i * 4 + 2] = nx / nl;
    normals[i * 4 + 3] = 1;

    uv0[i * 2] = md.readFloatLE(o + 32);
    uv0[i * 2 + 1] = md.readFloatLE(o + 36);
    if (needsUv1[li]) {
      uv1[i * 2] = md.readFloatLE(o + 40);
      uv1[i * 2 + 1] = md.readFloatLE(o + 44);
    }
  }

  const g = new GlbWriter("eclipse-bake", true);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      const v = positions[i * 3 + c]!;
      if (v < min[c]!) min[c] = v;
      if (v > max[c]!) max[c] = v;
    }
  }

  const posView = g.view(MeshoptEncoder.encodeFilterExp(positions, count, 12, PRECISION.positionBits, "SharedComponent"), count, 12, {
    filter: "EXPONENTIAL",
    target: T_ARRAY,
    vertexStride: true,
  });
  const norView = g.view(MeshoptEncoder.encodeFilterOct(normals, count, 4, PRECISION.normalBits), count, 4, { filter: "OCTAHEDRAL", target: T_ARRAY, vertexStride: true });
  const uv0View = g.view(MeshoptEncoder.encodeFilterExp(uv0, count, 8, PRECISION.uvBits, "SharedComponent"), count, 8, { filter: "EXPONENTIAL", target: T_ARRAY, vertexStride: true });
  const jointView = g.view(joints, count, 4, { target: T_ARRAY, vertexStride: true });
  const weightView = g.view(weights, count, 4, { target: T_ARRAY, vertexStride: true });

  const attributes: Record<string, number> = {
    POSITION: g.accessor({ bufferView: posView, componentType: C_FLOAT, count, type: "VEC3", min: [...min], max: [...max] }),
    NORMAL: g.accessor({ bufferView: norView, componentType: C_BYTE, normalized: true, count, type: "VEC3" }),
    TEXCOORD_0: g.accessor({ bufferView: uv0View, componentType: C_FLOAT, count, type: "VEC2" }),
    JOINTS_0: g.accessor({ bufferView: jointView, componentType: C_UBYTE, count, type: "VEC4" }),
    WEIGHTS_0: g.accessor({ bufferView: weightView, componentType: C_UBYTE, normalized: true, count, type: "VEC4" }),
  };
  if (anyUv1) {
    const uv1View = g.view(MeshoptEncoder.encodeFilterExp(uv1, count, 8, PRECISION.uvBits, "SharedComponent"), count, 8, { filter: "EXPONENTIAL", target: T_ARRAY, vertexStride: true });
    attributes.TEXCOORD_1 = g.accessor({ bufferView: uv1View, componentType: C_FLOAT, count, type: "VEC2" });
  }

  const wide = count > 0xffff;
  const indexBytes = wide ? 4 : 2;
  const indexData = wide ? Uint32Array.from(outIndices) : Uint16Array.from(outIndices);
  const indexView = g.view(asBytes(indexData), outIndices.length, indexBytes, { mode: "TRIANGLES", target: T_INDEX });

  const materials: { extras: SubmeshExtras }[] = [];
  const primitives: unknown[] = [];
  skin.submeshes.forEach((sub, subIndex) => {
    const range = ranges[subIndex]!;
    if (range.count === 0) return;
    const indices = g.accessor({
      bufferView: indexView,
      byteOffset: range.first * indexBytes,
      componentType: wide ? C_UINT : C_USHORT,
      count: range.count,
      type: "SCALAR",
    });
    const batches = batchesOf.get(subIndex);
    for (const batch of batches ?? [null]) {
      materials.push({ extras: batchExtras(model, sub, subIndex, batch) });
      primitives.push({ attributes, indices, material: materials.length - 1 });
    }
  });

  const boneCount = model.bones.length;
  const nodes: Record<string, unknown>[] = model.bones.map((_b, i) => ({ name: jointName(i) }));
  const roots: number[] = [];
  model.bones.forEach((b, i) => {
    if (b.parent >= 0) {
      const p = nodes[b.parent]!;
      ((p.children ??= []) as number[]).push(i);
    } else {
      roots.push(i);
    }
  });
  nodes.push({ name: "mesh", mesh: 0, skin: 0 });
  g.json.nodes = nodes;
  g.json.scenes = [{ nodes: [...roots, boneCount] }];
  g.json.scene = 0;
  g.json.skins = [{ joints: model.bones.map((_b, i) => i) }];
  g.json.meshes = [{ primitives }];
  g.json.materials = materials;

  return { glb: g.toBuffer(), primitives: primitives.length, vertices: count, triangles: outIndices.length / 3, vertexSource: Uint32Array.from(vertexSource), ranges };
}

/** Bounds of the default look's vertices, in target space. Retail's header bounds can't be trusted. */
export function geosetBounds(model: M2Model, skin: Skin, geosets: Set<number>): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const sub of skin.submeshes) {
    if (!geosets.has(sub.id)) continue;
    for (let k = 0; k < sub.indexCount; k++) {
      const o = model.vertexOffset(skin.lookup[skin.indices[sub.indexStart + k]!]!);
      const p: Vec3 = [model.md.readFloatLE(o + 4), model.md.readFloatLE(o + 8), model.md.readFloatLE(o)];
      for (let c = 0; c < 3; c++) {
        if (p[c]! < min[c]!) min[c] = p[c]!;
        if (p[c]! > max[c]!) max[c] = p[c]!;
      }
    }
  }
  return { min, max };
}
