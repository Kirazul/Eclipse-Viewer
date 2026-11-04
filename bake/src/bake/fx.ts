import type { FxColor, FxData, FxTrack, FxUvAnim } from "@eclipse/format";
import { readParticles, readRibbons } from "../fx/emitters";
import { EmitterTracks } from "../fx/tracks";
import type { M2Model, Sequence } from "../m2/model";
import { type KeyStats, type Keys, type ValueKind, readKeys, readTrackHeader } from "../m2/sample";

/**
 * FxData: the model's own animated tracks, kept as keys because the engine samples
 * them per frame, and its particle emitters and ribbons (bake/src/fx).
 */

/** Five decimals is far below what a colour or a UV can show, and these digits are this file's size. */
function round(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

type KeyedList = [number[], (number | number[])[]];

function toList(k: Keys): KeyedList {
  const values: (number | number[])[] = [];
  for (let i = 0; i < k.times.length; i++) {
    if (k.stride === 1) values.push(round(k.values[i]!));
    else values.push([...k.values.subarray(i * k.stride, (i + 1) * k.stride)].map(round));
  }
  return [[...k.times], values];
}

async function collect(
  model: M2Model,
  clips: Sequence[],
  loadModelBlock: (seq: Sequence) => Promise<Buffer>,
  at: number,
  kind: ValueKind,
  stats: KeyStats,
): Promise<FxTrack | undefined> {
  const md = model.md;
  const h = readTrackHeader(md, at);
  if (h.gseq >= 0) {
    const k = readKeys(md, h, 0, md, kind, stats);
    return k ? { globalLoop: h.gseq, clips: { "*": toList(k) } } : undefined;
  }
  const perClip: Record<string, KeyedList> = {};
  for (const seq of clips) {
    // A model's own tracks are indexed by its own skeleton's sequences. An inherited
    // parent sequence has none of them.
    if (seq.level.name === "parent") continue;
    const s = seq.concrete;
    if (s >= h.timesCount || md.readUInt32LE(h.timesAt + s * 8) === 0) continue;
    const k = readKeys(md, h, s, await loadModelBlock(seq), kind, stats);
    if (k) perClip[`${seq.id}.${seq.variation}`] = toList(k);
  }
  const lists = Object.values(perClip);
  if (lists.length === 0) return undefined;
  const first = JSON.stringify(lists[0]);
  // The common case is one key per clip, all alike: stored once as "any clip".
  if (lists.length === clips.length && lists.every((l) => JSON.stringify(l) === first)) return { clips: { "*": lists[0]! } };
  return { clips: perClip };
}

/** Leaves out absent fields: the contract reads a missing track as constant. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

export async function buildFx(model: M2Model, clips: Sequence[], loadModelBlock: (seq: Sequence) => Promise<Buffer>, stats: KeyStats): Promise<FxData> {
  const md = model.md;
  const colors: FxColor[] = [];
  const cn = md.readUInt32LE(0x48);
  const co = md.readUInt32LE(0x4c);
  for (let i = 0; i < cn; i++) {
    colors.push(
      compact({
        color: await collect(model, clips, loadModelBlock, co + i * 40, "vec3", stats),
        alpha: await collect(model, clips, loadModelBlock, co + i * 40 + 20, "fixed16", stats),
      }),
    );
  }
  const opacity: (FxTrack | null)[] = [];
  const wn = md.readUInt32LE(0x58);
  const wo = md.readUInt32LE(0x5c);
  for (let i = 0; i < wn; i++) opacity.push((await collect(model, clips, loadModelBlock, wo + i * 20, "fixed16", stats)) ?? null);
  const uvAnims: FxUvAnim[] = [];
  const un = md.readUInt32LE(0x60);
  const uo = md.readUInt32LE(0x64);
  for (let i = 0; i < un; i++) {
    uvAnims.push(
      compact({
        translation: await collect(model, clips, loadModelBlock, uo + i * 60, "vec3", stats),
        rotation: await collect(model, clips, loadModelBlock, uo + i * 60 + 20, "quatf", stats),
        scale: await collect(model, clips, loadModelBlock, uo + i * 60 + 40, "vec3", stats),
      }),
    );
  }
  const emitters = new EmitterTracks(model, clips, loadModelBlock);
  return {
    globalLoops: model.gloops,
    colors,
    opacity,
    uvAnims,
    particles: await readParticles(model, emitters),
    ribbons: await readRibbons(model, emitters),
  };
}
