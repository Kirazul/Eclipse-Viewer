import { untilOk } from "./lib/retry";
import { appendFileSync } from "node:fs";
import { type BakeContext, openContext } from "./bake/context";
import { runCatalog } from "./commands/catalog";
import { runReport } from "./commands/report";
import { expandScope, projectUnits, shardOf, unitDone } from "./commands/scope";
import { humanBytes, log, mapLimit } from "./lib/env";
import { BudgetExceeded, BudgetStore, LIMITS } from "./store/budget";
import { openStore } from "./store/store";

/**
 * The cloud pipeline's commands, as .github/workflows/bake.yml calls them:
 *   pnpm bake catalog [--upload]
 *   pnpm bake plan --scope S --shards N [--force|--redo] --github-output FILE
 *   pnpm bake run --scope S --shard I --shards N [--force|--redo] [--upload]
 *   pnpm bake report [--upload] [--shards N] [--github-summary FILE]
 *   pnpm bake usage [--upload]
 *
 * `--scope` takes ui, bodies, items, items:midnight, items:warwithin, items:client,
 * items:eclipse, mounts, mount:<id>, a model id such as human-male, retail items such as
 * item:231550, display:<id>, sample:<n>, sample-mounts:<n>, all, or a comma list.
 * `posters:mounts`, `posters:items:midnight`, `posters:sets:midnight` and the like draw
 * what those baked, in a headless browser, as posters for the grid: see posters/bake.ts.
 * `--bodies human-male` limits an item's per-body pieces, for a proof on a slow line.
 * `--clips 0.0,804.0` bakes only those clips and `--tex-budget-mb 40` stops fetching
 * customization textures past that many downloaded megabytes, for the same reason. The
 * record says what was left out, and the cloud never passes them.
 *
 * `--source cdn` is the default and what CI uses. Locally, `--source wago` reads
 * from wago.tools through work/raw/. Without `--upload` output goes to
 * site/public/packs/, which the site serves at /packs.
 */

interface Args {
  command: string;
  flags: Map<string, string>;
}

const BOOLEAN = new Set(["upload", "force", "redo", "allow-partial"]);

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (BOOLEAN.has(name)) flags.set(name, "1");
      else {
        const v = argv[++i];
        if (v === undefined) throw new Error(`--${name} needs a value`);
        flags.set(name, v);
      }
    } else {
      rest.push(a);
    }
  }
  return { command: rest[0] ?? "", flags };
}

function need(args: Args, name: string): string {
  const v = args.flags.get(name);
  if (v === undefined) throw new Error(`${args.command} needs --${name}`);
  return v;
}

function shardsOf(args: Args): number {
  const n = Number(need(args, "shards"));
  if (!Number.isInteger(n) || n < 1) throw new Error("--shards must be a positive integer");
  return n;
}

function context(args: Args): BakeContext {
  const source = args.flags.get("source") ?? process.env.BAKE_SOURCE ?? "cdn";
  // A shard keeps its own ledger: R2 has no atomic add, and `report` folds them in.
  const shard = args.command === "run" && Number(args.flags.get("shards") ?? 1) > 1 ? { index: Number(args.flags.get("shard")), count: Number(args.flags.get("shards")) } : undefined;
  const store = new BudgetStore(openStore(args.flags.has("upload")), shard ? { shard } : {});
  const ctx = openContext(source, store, args.flags.has("force"));
  ctx.redo = args.flags.has("redo");
  const only = args.flags.get("bodies");
  if (only) ctx.onlyBodies = new Set(only.split(","));
  const clips = args.flags.get("clips");
  if (clips) ctx.onlyClips = new Set(clips.split(","));
  const budget = args.flags.get("tex-budget-mb");
  if (budget) {
    const limit = Number(budget) * 1024 * 1024;
    ctx.overTextureBudget = () => ((ctx.source as { downloaded?: number }).downloaded ?? 0) > limit;
  }
  return ctx;
}

async function plan(args: Args): Promise<void> {
  const ctx = context(args);
  const scope = need(args, "scope");
  const shards = shardsOf(args);
  const units = await expandScope(ctx, scope, true);
  const pending = new Set<number>();
  const todo: typeof units = [];
  let done = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    // The ledger answers: this loop sends no HEAD and no LIST, whatever the scope.
    if (await unitDone(ctx, u)) done++;
    else {
      pending.add(shardOf(i, shards));
      todo.push(u);
    }
  }
  const list = [...pending].sort((a, b) => a - b);
  log(`plan ${scope}: ${units.length} unit(s), ${done} already baked, ${units.length - done} to do across shards ${JSON.stringify(list)}`);
  // It has to fit before it starts. The store still stops a job that passes the limit.
  const projected = projectUnits(todo);
  const fit = (ctx.store as BudgetStore).wouldFit(projected.bytes, projected.writes);
  log(`plan: this would add about ${(projected.bytes / 1e9).toFixed(2)} GB and ${Math.round(projected.writes)} writes: ${(fit.bytes / 1e9).toFixed(2)} of ${(LIMITS.bytes / 1e9).toFixed(1)} GB, ${Math.round(fit.classA)} of ${LIMITS.classA} Class A this month`);
  const out = args.flags.get("github-output");
  if (!fit.fits && !args.flags.has("allow-partial")) {
    if (out) appendFileSync(out, "shards=[]\n");
    await (ctx.store as BudgetStore).flush();
    throw new Error("plan: refusing to start, this scope does not fit the R2 free tier. Cut the scope, or pass --allow-partial to bake until the limit stops it.");
  }
  if (out) appendFileSync(out, `shards=${JSON.stringify(list)}\n`);
  await (ctx.store as BudgetStore).flush();
}

async function run(args: Args): Promise<void> {
  const ctx = context(args);
  const store = ctx.store as BudgetStore;
  const scope = need(args, "scope");
  const shards = shardsOf(args);
  const shard = Number(need(args, "shard"));
  const units = await expandScope(ctx, scope);
  const concurrency = Number(args.flags.get("concurrency") ?? 3);
  let failed = 0;
  let skipped = 0;
  let baked = 0;
  let stopped: BudgetExceeded | null = null;
  const mine = units.filter((_, i) => shardOf(i, shards) === shard);
  const closePosters = async () => {
    if (scope.includes("posters:")) await (await import("./posters/bake")).closePosterBrowser();
  };
  await mapLimit(mine, concurrency, async (u) => {
    if (stopped) return;
    if (await unitDone(ctx, u)) {
      skipped++;
      return;
    }
    log(`bake ${u.id}`);
    try {
      // A failure here is nearly always a network stall, and each object already uploaded
      // is skipped on the next try, so trying again costs little and saves a whole rerun.
      const rec = await untilOk(() => u.bake(ctx), (r) => r.status === "ok" || r.final === true, 3, 15_000, (r, next) =>
        log(`  retrying ${u.id} (try ${next}): ${r.error}`),
      );
      if (rec.status === "ok") {
        baked++;
        const s = rec.sizes ?? {};
        const load = s.firstLoadWire ? `, first load ${humanBytes(s.firstLoadWire)} on the wire` : "";
        log(`  ok in ${rec.seconds.toFixed(1)} s${load}, ${rec.warnings.length} warning(s)`);
      } else {
        failed++;
        log(`  FAILED: ${rec.error}`);
      }
    } catch (e) {
      if (e instanceof BudgetExceeded) stopped = e;
      else throw e;
    }
  }).finally(closePosters);
  await store.flush();
  const u = store.current();
  const pulled = (ctx.source as { downloaded?: number }).downloaded;
  if (pulled) log(`run: ${humanBytes(pulled)} pulled over the network`);
  log(`run ${scope} shard ${shard}/${shards}: ${baked} baked, ${skipped} skipped, ${failed} failed. Bucket ${(u.bytes / 1e9).toFixed(3)} GB, ${u.objects} objects, ${u.classA} Class A this month`);
  if (stopped) {
    const e = stopped as BudgetExceeded;
    log(`STOPPED: ${e.message}`);
    log(`The units not baked stay out of the catalogue. ${mine.length - baked - skipped - failed} left in this shard.`);
    process.exitCode = 2;
    return;
  }
  if (failed) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "catalog": {
      const ctx = context(args);
      await runCatalog(ctx);
      await (ctx.store as BudgetStore).flush();
      break;
    }
    case "plan":
      await plan(args);
      break;
    case "run":
      await run(args);
      break;
    case "report":
      await runReport(new BudgetStore(openStore(args.flags.has("upload"))), args.flags.get("github-summary"), Number(args.flags.get("shards") ?? 0));
      break;
    case "usage": {
      const store = new BudgetStore(openStore(args.flags.has("upload")));
      await store.open();
      process.stdout.write(`${JSON.stringify(store.current(), null, 1)}\n`);
      break;
    }
    default:
      throw new Error(`unknown command ${JSON.stringify(args.command)}: catalog, plan, run, report or usage`);
  }
}

if (process.argv[1] && /cli\.[tj]s$/.test(process.argv[1])) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}

