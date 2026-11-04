import { appendFileSync } from "node:fs";
import { type BakeContext, isUpToDate, openContext } from "./bake/context";
import { runCatalog } from "./commands/catalog";
import { runReport } from "./commands/report";
import { expandScope, shardOf } from "./commands/scope";
import { humanBytes, log } from "./lib/env";
import { openStore } from "./store/store";

/**
 * The cloud pipeline's commands, as .github/workflows/bake.yml calls them:
 *   pnpm bake catalog [--upload]
 *   pnpm bake plan --scope S --shards N [--force] --github-output FILE
 *   pnpm bake run --scope S --shard I --shards N [--force] [--upload]
 *   pnpm bake report [--upload] [--github-summary FILE]
 *
 * `--scope` takes ui, bodies, items, items:midnight, items:warwithin, a model id
 * such as human-male, retail items such as item:231550, all, or a comma list.
 * `--bodies human-male` limits an item's per-body pieces, for a proof on a slow line.
 *
 * `--source cdn` is the default and what CI uses. Locally, `--source wago` reads
 * from wago.tools through work/raw/. Without `--upload` output goes to
 * site/public/packs/, which the site serves at /packs.
 */

interface Args {
  command: string;
  flags: Map<string, string>;
}

const BOOLEAN = new Set(["upload", "force"]);

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
  const ctx = openContext(source, openStore(args.flags.has("upload")), args.flags.has("force"));
  const only = args.flags.get("bodies");
  if (only) ctx.onlyBodies = new Set(only.split(","));
  return ctx;
}

async function plan(args: Args): Promise<void> {
  const ctx = context(args);
  const scope = need(args, "scope");
  const shards = shardsOf(args);
  const units = await expandScope(ctx, scope, true);
  const pending = new Set<number>();
  let done = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (await isUpToDate(ctx, u.id, u.output)) done++;
    else pending.add(shardOf(i, shards));
  }
  const list = [...pending].sort((a, b) => a - b);
  log(`plan ${scope}: ${units.length} unit(s), ${done} already baked, ${units.length - done} to do across shards ${JSON.stringify(list)}`);
  const out = args.flags.get("github-output");
  if (out) appendFileSync(out, `shards=${JSON.stringify(list)}\n`);
}

async function run(args: Args): Promise<void> {
  const ctx = context(args);
  const scope = need(args, "scope");
  const shards = shardsOf(args);
  const shard = Number(need(args, "shard"));
  const units = await expandScope(ctx, scope);
  let failed = 0;
  let skipped = 0;
  let baked = 0;
  for (let i = 0; i < units.length; i++) {
    if (shardOf(i, shards) !== shard) continue;
    const u = units[i]!;
    if (await isUpToDate(ctx, u.id, u.output)) {
      skipped++;
      continue;
    }
    log(`bake ${u.id}`);
    const rec = await u.bake(ctx);
    if (rec.status === "ok") {
      baked++;
      const s = rec.sizes ?? {};
      const load = s.firstLoadWire ? `, first load ${humanBytes(s.firstLoadWire)} on the wire` : "";
      log(`  ok in ${rec.seconds.toFixed(1)} s${load}, ${rec.warnings.length} warning(s)`);
    } else {
      failed++;
      log(`  FAILED: ${rec.error}`);
    }
  }
  log(`run ${scope} shard ${shard}/${shards}: ${baked} baked, ${skipped} skipped, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "catalog":
      await runCatalog(context(args));
      break;
    case "plan":
      await plan(args);
      break;
    case "run":
      await run(args);
      break;
    case "report":
      await runReport(openStore(args.flags.has("upload")), args.flags.get("github-summary"));
      break;
    default:
      throw new Error(`unknown command ${JSON.stringify(args.command)}: catalog, plan, run or report`);
  }
}

if (process.argv[1] && /cli\.[tj]s$/.test(process.argv[1])) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}

