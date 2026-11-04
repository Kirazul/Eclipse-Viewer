/**
 * Prints how close each body's skeleton sits to the others, the numbers the donor limits in
 * src/items/bodies.ts were chosen from. Reads the 57 bodies' M2 files.
 *
 *   pnpm --filter @eclipse/bake exec tsx tools/donor_fit.ts
 */
import { Tracked } from "../src/bake/context";
import { openContext } from "../src/bake/context";
import { readModelFiles } from "../src/bake/model";
import { headDistance, skeletonDistance, type Bones } from "../src/items/bodies";
import { allBodies, allRaces } from "../src/chr/races";
import { BudgetStore } from "../src/store/budget";
import { LocalStore } from "../src/store/store";

const ctx = openContext("wago", new BudgetStore(new LocalStore()));
const bodies = allBodies(await allRaces(ctx.db));
const bones = new Map<string, Bones>();
for (const b of bodies) {
  const { model } = await readModelFiles(new Tracked(ctx.source), b.m2);
  const head = model.attachments.find((a) => a.id === 11);
  bones.set(b.id, { crc: model.bones.map((x) => x.crc), pivot: model.bones.flatMap((x) => [...x.pivot]), head: head?.bone ?? -1 });
}
const rows: string[] = [];
for (const b of bodies) {
  const own = bones.get(b.id)!;
  const others = bodies.filter((o) => o !== b && o.sex === b.sex);
  const body = others.map((o) => [o.id, skeletonDistance(own, bones.get(o.id)!)] as const).sort((x, y) => x[1] - y[1]);
  const head = others.map((o) => [o.id, headDistance(own, bones.get(o.id)!)] as const).sort((x, y) => x[1] - y[1]);
  const fmt = (l: readonly (readonly [string, number])[]) => l.slice(0, 3).map(([id, d]) => `${id} ${d.toFixed(3)}`).join(", ");
  rows.push(`${b.id.padEnd(22)} body ${fmt(body).padEnd(70)} head ${fmt(head)}`);
}
process.stdout.write(`${rows.join("\n")}\n`);
