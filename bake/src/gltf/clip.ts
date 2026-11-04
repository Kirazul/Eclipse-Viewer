import { MeshoptEncoder } from "meshoptimizer/encoder";
import type { SampledClip, SampledTrack } from "../m2/sample";
import { C_FLOAT, C_SHORT, GlbWriter, asBytes } from "./writer";

export interface ClipPrecision {
  translationBits: number;
  rotationBits: number;
  scaleBits: number;
}

/**
 * Measured on Human male against Eclipse's poses, worst point 30 cm from a bone:
 *   t14 r12  3.06 mm   27.9 KB a clip on the wire (the first sizing test's flags)
 *   t15 r13  1.23 mm   31.9 KB
 *   t16 r14  0.73 mm   35.9 KB  <- under a pixel at full-body zoom, and steady on the hands
 *   t18 r16  0.15 mm   44.4 KB
 */
export const CLIP_PRECISION: ClipPrecision = {
  translationBits: 16,
  rotationBits: 14,
  scaleBits: 14,
};

/**
 * One clip as one animation over nodes named `b<n>`. Only the bones it moves get
 * a node: the engine binds tracks by name onto the body's skeleton, so hierarchy
 * and everything else here would be dead bytes.
 *
 * Each kind of track goes into one bufferView, one after the other. That gives the
 * vertex codec long runs of similar deltas, and the exponential filter one shared
 * exponent per axis, which is an absolute precision for the whole clip.
 */
export function buildClipGlb(name: string, clip: SampledClip, precision: ClipPrecision = CLIP_PRECISION): Buffer {
  const g = new GlbWriter();
  const frames = clip.times.length;

  const bonesUsed = [...new Set(clip.tracks.map((t) => t.bone))].sort((a, b) => a - b);
  const nodeOf = new Map(bonesUsed.map((b, i) => [b, i]));
  g.json.nodes = bonesUsed.map((b) => ({ name: `b${b}` }));
  g.json.scenes = [{ nodes: bonesUsed.map((_b, i) => i) }];
  g.json.scene = 0;

  const anyConstant = clip.tracks.some((t) => t.constant);
  const timeData = new Float32Array(frames + (anyConstant ? 1 : 0));
  timeData.set(clip.times, 0);
  if (anyConstant) timeData[frames] = 0;
  const timeView = g.view(asBytes(timeData), timeData.length, 4);
  const inputAll = g.accessor({ bufferView: timeView, componentType: C_FLOAT, count: frames, type: "SCALAR", min: [clip.times[0]!], max: [clip.times[frames - 1]!] });
  const inputOne = anyConstant ? g.accessor({ bufferView: timeView, byteOffset: frames * 4, componentType: C_FLOAT, count: 1, type: "SCALAR", min: [0], max: [0] }) : -1;

  const samplers: { input: number; output: number }[] = [];
  const channels: unknown[] = [];

  const emit = (path: SampledTrack["path"]) => {
    const tracks = clip.tracks.filter((t) => t.path === path);
    if (tracks.length === 0) return;
    const stride = path === "rotation" ? 4 : 3;
    const total = tracks.reduce((n, t) => n + t.values.length / stride, 0);
    const all = new Float32Array(total * stride);
    let at = 0;
    const offsets: number[] = [];
    for (const t of tracks) {
      offsets.push(at);
      all.set(t.values, at * stride);
      at += t.values.length / stride;
    }
    let view: number;
    let elementBytes: number;
    if (path === "rotation") {
      view = g.view(MeshoptEncoder.encodeFilterQuat(all, total, 8, precision.rotationBits), total, 8, { filter: "QUATERNION" });
      elementBytes = 8;
    } else {
      const bits = path === "translation" ? precision.translationBits : precision.scaleBits;
      view = g.view(MeshoptEncoder.encodeFilterExp(all, total, 12, bits, "SharedComponent"), total, 12, { filter: "EXPONENTIAL" });
      elementBytes = 12;
    }
    tracks.forEach((t, i) => {
      const count = t.values.length / stride;
      const output = g.accessor({
        bufferView: view,
        byteOffset: offsets[i]! * elementBytes,
        componentType: path === "rotation" ? C_SHORT : C_FLOAT,
        ...(path === "rotation" ? { normalized: true } : {}),
        count,
        type: path === "rotation" ? "VEC4" : "VEC3",
      });
      samplers.push({ input: t.constant ? inputOne : inputAll, output });
      channels.push({ sampler: samplers.length - 1, target: { node: nodeOf.get(t.bone), path } });
    });
  };
  emit("translation");
  emit("rotation");
  emit("scale");

  g.json.animations = [{ name, samplers, channels }];
  return g.toBuffer();
}
