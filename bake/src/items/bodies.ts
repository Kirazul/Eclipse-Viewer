import { BUILD } from "@eclipse/format";
import { type BakeContext, Tracked } from "../bake/context";
import { readModelFiles } from "../bake/model";
import { type BodySpec, allBodies, allRaces } from "../chr/races";
import { byId, num, type Row } from "../db2/db2";
import { STAGE, inputKey, log } from "../lib/env";
import { MissingFile } from "../sources/source";
import { type RaceSex, fallbackChain } from "./resolve";

/**
 * A retail body with what an item needs to know about it: retail's fallback chains from
 * ChrRaces, and the bodies closest to it, for a piece retail never cut for this one.
 */
export interface BodyInfo {
  spec: BodySpec;
  raceId: number;
  sex: 0 | 1;
  /** ChrRaces Male/FemaleModelFallback, followed to its end. */
  modelChain: RaceSex[];
  textureChain: RaceSex[];
}

export interface BodyTable {
  bodies: BodyInfo[];
  /** Body id -> the bodies a skinned piece can borrow from, closest skeleton first. Filled in when first needed. */
  fit: Map<string, { body: BodyInfo; distance: number }[]>;
  /** The same for a piece hung on the head: only the heads have to agree. */
  fitHead: Map<string, { body: BodyInfo; distance: number }[]>;
}

/**
 * How far a donor's skeleton may sit from the body, median bone, in metres. Measured over all
 * 57 bodies by tools/donor_fit.ts: sibling bodies share a skeleton at 0.000, and the close ones
 * (Human and Undead female, Goblin and Vulpera) sit under 0.05. A cut is referenced as it is,
 * with no refit, and past this it floats: a Pandaren hat on a Human, at about 0.1, hangs its
 * banner across the face. So past this the item is hidden on that body, and said so on its row.
 */
export const DONOR_MAX_DISTANCE = 0.05;
/** The same for a helm, with the heads laid on each other. */
export const DONOR_HEAD_MAX_DISTANCE = 0.05;

export function modelStep(races: Map<string, Row>, at: RaceSex): RaceSex | null {
  const row = races.get(String(at[0]));
  if (!row) return null;
  const prefix = at[1] === 0 ? "Male" : "Female";
  const race = num(row[`${prefix}ModelFallbackRaceID`]);
  return race ? [race, num(row[`${prefix}ModelFallbackSex`])] : null;
}

export function textureStep(races: Map<string, Row>, at: RaceSex): RaceSex | null {
  const row = races.get(String(at[0]));
  if (!row) return null;
  const prefix = at[1] === 0 ? "Male" : "Female";
  const race = num(row[`${prefix}TextureFallbackRaceID`]);
  return race ? [race, num(row[`${prefix}TextureFallbackSex`])] : null;
}

const tables = new WeakMap<object, Promise<BodyTable>>();

export function bodyTable(ctx: BakeContext): Promise<BodyTable> {
  let hit = tables.get(ctx);
  if (!hit) {
    hit = buildTable(ctx);
    tables.set(ctx, hit);
  }
  return hit;
}

export interface Bones {
  crc: number[];
  pivot: number[];
  /** The bone attachment 11 hangs on, or -1. */
  head: number;
}

/** Bone hashes and pivots of a body: its M2 is large, and read once per bucket. */
async function bonesOf(ctx: BakeContext, body: BodySpec): Promise<Bones | null> {
  const key = `objects/${inputKey("bonepivots", STAGE.item, String(body.m2), BUILD.version)}.json`;
  if ((await ctx.store.stat(key)) !== null) {
    const stored = await ctx.store.get(key);
    if (stored) return JSON.parse(stored.toString("utf8")) as Bones;
  }
  try {
    const { model } = await readModelFiles(new Tracked(ctx.source), body.m2);
    const head = model.attachments.find((a) => a.id === 11);
    const bones: Bones = { crc: model.bones.map((b) => b.crc), pivot: model.bones.flatMap((b) => [...b.pivot]), head: head?.bone ?? -1 };
    await ctx.store.put(key, Buffer.from(JSON.stringify(bones)));
    return bones;
  } catch (e) {
    if (e instanceof MissingFile) return null;
    throw e;
  }
}

/** Median distance over the bones both have, in metres. */
export function skeletonDistance(a: Bones, b: Bones): number {
  const atB = new Map<number, number>();
  b.crc.forEach((c, i) => {
    if (c && !atB.has(c)) atB.set(c, i);
  });
  const out: number[] = [];
  a.crc.forEach((c, i) => {
    const j = atB.get(c);
    if (!c || j === undefined) return;
    const dx = a.pivot[i * 3]! - b.pivot[j * 3]!;
    const dy = a.pivot[i * 3 + 1]! - b.pivot[j * 3 + 1]!;
    const dz = a.pivot[i * 3 + 2]! - b.pivot[j * 3 + 2]!;
    out.push(Math.hypot(dx, dy, dz));
  });
  if (out.length < 8) return Infinity;
  out.sort((x, y) => x - y);
  return out[out.length >> 1]!;
}

/** The same, with both heads laid on each other, over the bones near the head: the face. */
export function headDistance(a: Bones, b: Bones): number {
  if (a.head < 0 || b.head < 0) return Infinity;
  const atB = new Map<number, number>();
  b.crc.forEach((c, i) => {
    if (c && !atB.has(c)) atB.set(c, i);
  });
  const [ax, ay, az] = [a.pivot[a.head * 3]!, a.pivot[a.head * 3 + 1]!, a.pivot[a.head * 3 + 2]!];
  const [bx, by, bz] = [b.pivot[b.head * 3]!, b.pivot[b.head * 3 + 1]!, b.pivot[b.head * 3 + 2]!];
  const out: number[] = [];
  a.crc.forEach((c, i) => {
    const j = atB.get(c);
    if (!c || j === undefined) return;
    const [dax, day, daz] = [a.pivot[i * 3]! - ax, a.pivot[i * 3 + 1]! - ay, a.pivot[i * 3 + 2]! - az];
    if (Math.hypot(dax, day, daz) > 0.4) return;
    const [dbx, dby, dbz] = [b.pivot[j * 3]! - bx, b.pivot[j * 3 + 1]! - by, b.pivot[j * 3 + 2]! - bz];
    out.push(Math.hypot(dax - dbx, day - dby, daz - dbz));
  });
  if (out.length < 4) return Infinity;
  out.sort((x, y) => x - y);
  return out[out.length >> 1]!;
}

async function buildTable(ctx: BakeContext): Promise<BodyTable> {
  const races = byId(await ctx.db.table("ChrRaces"));
  const specs = await allRaces(ctx.db);
  const raceOf = new Map(specs.map((r) => [r.key, r.raceId]));
  const bodies: BodyInfo[] = allBodies(specs).map((spec) => {
    const raceId = raceOf.get(spec.raceKey) ?? 0;
    const sex: 0 | 1 = spec.sex === "male" ? 0 : 1;
    return {
      spec,
      raceId,
      sex,
      modelChain: fallbackChain([raceId, sex], (at) => modelStep(races, at)),
      textureChain: fallbackChain([raceId, sex], (at) => textureStep(races, at)),
    };
  });
  const table: BodyTable = { bodies, fit: new Map(), fitHead: new Map() };
  return table;
}

const fitDone = new WeakMap<BodyTable, Promise<void>>();

/** Reads every body's bones once, the first time a piece needs a donor. */
export function measureFit(ctx: BakeContext, table: BodyTable): Promise<void> {
  let hit = fitDone.get(table);
  if (!hit) {
    hit = (async () => {
      const bones = new Map<string, Bones>();
      for (const b of table.bodies) {
        const got = await bonesOf(ctx, b.spec);
        if (got) bones.set(b.spec.id, got);
      }
      for (const b of table.bodies) {
        const own = bones.get(b.spec.id);
        if (!own) continue;
        const same = table.bodies.filter((o) => o !== b && o.sex === b.sex && bones.has(o.spec.id));
        const rank = (of: (x: Bones, y: Bones) => number, limit: number) =>
          same
            .map((o) => ({ body: o, distance: of(own, bones.get(o.spec.id)!) }))
            .filter((x) => x.distance <= limit)
            .sort((x, y) => x.distance - y.distance);
        table.fit.set(b.spec.id, rank(skeletonDistance, DONOR_MAX_DISTANCE));
        table.fitHead.set(b.spec.id, rank(headDistance, DONOR_HEAD_MAX_DISTANCE));
      }
      log(`  donors: measured ${bones.size} of ${table.bodies.length} skeletons`);
    })();
    fitDone.set(table, hit);
  }
  return hit;
}

/** The bodies a piece may borrow a cut from, closest first. A helm only needs the heads to agree. */
export function donorsOf(table: BodyTable, body: BodyInfo, kind: "skinned" | "head" = "skinned"): BodyInfo[] {
  return ((kind === "head" ? table.fitHead : table.fit).get(body.spec.id) ?? []).map((x) => x.body);
}
