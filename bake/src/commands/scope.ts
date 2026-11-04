import { paths } from "@eclipse/format";
import { type BakeContext, type BakeRecord } from "../bake/context";
import { bakeBodyUnit } from "../bake/body";
import { type BodySpec, allBodies, allRaces } from "../chr/races";
import { type ItemSpec, bakeItemUnit, itemUnitId, specOfItem, specsOfRows } from "../items/bake";
import { LINE_ORDER, LINES, type LineScope, scanLine } from "../items/lines";
import { bakeMountUnit } from "../mounts/bake";
import { type MountFamily, type MountScan, scanMounts } from "../mounts/scan";
import { bakeUiUnit } from "../ui/bake";

/** One thing `plan` counts and `run` bakes, with the object that says it is finished. */
export interface Unit {
  id: string;
  kind: string;
  /** Written last, so its presence means the unit finished. */
  output: string;
  bake(ctx: BakeContext): Promise<BakeRecord>;
}

const UI_UNIT: Unit = { id: "ui", kind: "ui", output: paths.atlasMap(), bake: bakeUiUnit };

function bodyUnit(spec: BodySpec): Unit {
  return { id: spec.id, kind: "body", output: paths.manifest(spec.id), bake: (ctx) => bakeBodyUnit(ctx, spec) };
}

function itemUnit(spec: ItemSpec): Unit {
  const id = itemUnitId(spec.displayId);
  return { id, kind: "item", output: paths.item(id), bake: (ctx) => bakeItemUnit(ctx, spec) };
}

function mountUnit(family: MountFamily): Unit {
  return { id: family.id, kind: "mount", output: paths.manifest(`mountd-${family.variants[0]!.display}`), bake: (ctx) => bakeMountUnit(ctx, family) };
}

const scanned = new WeakMap<object, Map<string, Promise<LineScope>>>();

/** A line is scanned once per run: the tables are the slow part. */
export function lineScope(ctx: BakeContext, line: string): Promise<LineScope> {
  let forCtx = scanned.get(ctx);
  if (!forCtx) scanned.set(ctx, (forCtx = new Map()));
  let hit = forCtx.get(line);
  if (!hit) {
    hit = scanLine(ctx, line);
    forCtx.set(line, hit);
  }
  return hit;
}

const scannedMounts = new WeakMap<object, Promise<MountScan>>();

export function mountScope(ctx: BakeContext): Promise<MountScan> {
  let hit = scannedMounts.get(ctx);
  if (!hit) {
    hit = scanMounts(ctx);
    scannedMounts.set(ctx, hit);
  }
  return hit;
}

export async function allRows(ctx: BakeContext, lines = LINE_ORDER) {
  const out = [];
  for (const line of lines) out.push(...(await lineScope(ctx, line)).rows);
  return out;
}

/**
 * Every n-th display and animal, in order, so a sample measures the whole catalogue's mix
 * rather than one corner of it.
 */
export function everyNth<T>(list: readonly T[], count: number): T[] {
  if (count >= list.length) return [...list];
  const step = list.length / count;
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(list[Math.floor(i * step)]!);
  return out;
}

/**
 * What a scope covers, in a stable order: `plan` and every `run` shard must agree on it
 * without sharing a disk. A scope is `ui`, a class (bodies, items, mounts), a line
 * (items:midnight, items:warwithin, items:client, items:eclipse), a model id (human-male),
 * retail items (item:231550), a display (display:12345), a mount (mount:1234), a sample
 * (sample:300, sample-mounts:40), `all`, or several of these with commas.
 */
export async function expandScope(ctx: BakeContext, scope: string, _planning = false): Promise<Unit[]> {
  const out: Unit[] = [];
  const seen = new Set<string>();
  for (const part of scope.split(",")) {
    for (const u of await expandOne(ctx, part.trim())) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      out.push(u);
    }
  }
  return out;
}

async function expandOne(ctx: BakeContext, scope: string): Promise<Unit[]> {
  if (scope === "ui") return [UI_UNIT];
  if (scope.startsWith("item:")) return [itemUnit(await specOfItem(ctx, Number(scope.slice(5))))];
  if (scope.startsWith("display:")) {
    const display = Number(scope.slice(8));
    const specs = specsOfRows((await allRows(ctx)).filter((r) => r.display === display));
    if (!specs.length) throw new Error(`no line holds display ${display}`);
    return specs.map(itemUnit);
  }
  if (scope === "mounts") return (await mountScope(ctx)).families.map(mountUnit);
  if (scope.startsWith("mount:")) {
    const id = Number(scope.slice(6));
    const family = (await mountScope(ctx)).families.find((f) => f.mountId === id || f.variants.some((v) => v.mountId === id));
    if (!family) throw new Error(`no mount ${id} in the scan`);
    return [mountUnit(family)];
  }
  if (scope.startsWith("sample:")) return everyNth(specsOfRows(await allRows(ctx)), Number(scope.slice(7))).map(itemUnit);
  if (scope.startsWith("sample-mounts:")) return everyNth((await mountScope(ctx)).families, Number(scope.slice(14))).map(mountUnit);
  if (scope === "items" || scope.startsWith("items:")) {
    const lines = scope === "items" ? LINE_ORDER : [scope.slice(6)];
    for (const l of lines) if (!LINES[l]) throw new Error(`unknown item line ${l}: ${LINE_ORDER.join(", ")}`);
    return specsOfRows(await allRows(ctx, lines)).map(itemUnit);
  }
  const bodies = allBodies(await allRaces(ctx.db));
  if (scope === "bodies") return bodies.map(bodyUnit);
  if (scope === "all") return [UI_UNIT, ...bodies.map(bodyUnit), ...(await expandOne(ctx, "mounts")), ...(await expandOne(ctx, "items"))];
  const body = bodies.find((b) => b.id === scope);
  if (body) return [bodyUnit(body)];
  throw new Error(`unknown scope ${JSON.stringify(scope)}: expected ui, bodies, items, items:<line>, item:<item id>, display:<id>, mounts, mount:<id>, sample:<n>, sample-mounts:<n>, all, or a model id such as human-male`);
}

/** Stable split: a unit's shard depends only on its place in the scope. */
export function shardOf(index: number, shards: number): number {
  return index % shards;
}

/**
 * Bytes in R2 and writes per unit, measured on 133 item displays, 6 mount families and
 * human-male. They only decide whether to start: the budget store still stops a job that
 * passes the limit.
 */
export const MEASURED = {
  item: { bytes: 36_000, writes: 6.1 },
  mount: { bytes: 540_000, writes: 33 },
  // Clips and geometry at 7 MB on the wire, plus each body's share of 18,479 customization textures.
  body: { bytes: 16_000_000, writes: 585 },
  ui: { bytes: 1_200_000, writes: 14 },
} as const;

export function projectUnits(units: readonly Pick<Unit, "kind">[]): { bytes: number; writes: number } {
  let bytes = 0;
  let writes = 0;
  for (const u of units) {
    const m = MEASURED[u.kind as keyof typeof MEASURED];
    if (!m) continue;
    bytes += m.bytes;
    writes += m.writes;
  }
  return { bytes, writes };
}
