import { paths } from "@eclipse/format";
import { type BakeContext, type BakeRecord } from "../bake/context";
import { bakeBodyUnit } from "../bake/body";
import { type BodySpec, allBodies, allRaces } from "../chr/races";
import { type ItemSpec, bakeItemUnit, itemUnitId, specOfItem } from "../items/bake";
import { LINES, scanLine, writeSets } from "../items/lines";
import { bakeUiUnit } from "../ui/bake";

/** One thing `plan` counts and `run` bakes, with the object that says it is finished. */
export interface Unit {
  id: string;
  kind: string;
  /** Written last, so its presence means the unit finished. */
  output: string;
  bake(ctx: BakeContext): Promise<BakeRecord>;
}

const UI_UNIT: Unit = { id: "ui", kind: "ui", output: paths.sprites(), bake: bakeUiUnit };

function bodyUnit(spec: BodySpec): Unit {
  return { id: spec.id, kind: "body", output: paths.manifest(spec.id), bake: (ctx) => bakeBodyUnit(ctx, spec) };
}

function itemUnit(spec: ItemSpec): Unit {
  const id = itemUnitId(spec.displayId);
  return { id, kind: "item", output: paths.item(id), bake: (ctx) => bakeItemUnit(ctx, spec) };
}

async function lineUnits(ctx: BakeContext, line: string, planning: boolean): Promise<Unit[]> {
  const scope = await scanLine(ctx, line);
  // Once, from `plan`: every shard writing them again would be thousands of writes.
  if (planning) await writeSets(ctx, scope.sets);
  return scope.items.map(itemUnit);
}

/**
 * What a scope covers, in a stable order: `plan` and every `run` shard must agree
 * on it without sharing a disk. A scope is `ui`, a class (bodies, items, mounts), a
 * line (items:midnight, items:warwithin), a model id (human-male), retail items
 * (item:231550), `all`, or several of these with commas.
 */
export async function expandScope(ctx: BakeContext, scope: string, planning = false): Promise<Unit[]> {
  const out: Unit[] = [];
  for (const part of scope.split(",")) out.push(...(await expandOne(ctx, part.trim(), planning)));
  return out;
}

async function expandOne(ctx: BakeContext, scope: string, planning: boolean): Promise<Unit[]> {
  if (scope === "ui") return [UI_UNIT];
  if (scope.startsWith("item:")) return [itemUnit(await specOfItem(ctx, Number(scope.slice(5))))];
  if (scope === "mounts") throw new Error("scope `mounts` is not implemented yet");
  if (scope === "items" || scope.startsWith("items:")) {
    const lines = scope === "items" ? Object.keys(LINES) : [scope.slice(6)];
    const units: Unit[] = [];
    for (const line of lines) units.push(...(await lineUnits(ctx, line, planning)));
    const seen = new Set<string>();
    return units.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));
  }
  const bodies = allBodies(await allRaces(ctx.db));
  if (scope === "bodies") return bodies.map(bodyUnit);
  if (scope === "all") return [UI_UNIT, ...bodies.map(bodyUnit), ...(await expandOne(ctx, "items", planning))];
  const body = bodies.find((b) => b.id === scope);
  if (body) return [bodyUnit(body)];
  throw new Error(`unknown scope ${JSON.stringify(scope)}: expected ui, bodies, items, items:<line>, item:<item id>, mounts, all, or a model id such as human-male`);
}

/** Stable split: a unit's shard depends only on its place in the scope. */
export function shardOf(index: number, shards: number): number {
  return index % shards;
}
