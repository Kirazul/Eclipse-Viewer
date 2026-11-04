import { appendFileSync } from "node:fs";
import { BUILD, R2, packUrl, paths } from "@eclipse/format";
import type { BakeRecord } from "../bake/context";
import { BAKER_VERSION, humanBytes, log } from "../lib/env";
import type { Store } from "../store/store";
import { type Usage, BudgetStore, LIMITS } from "../store/budget";
import { type Listing, markBaked, recordsOf } from "./catalog";

/** Milestone 1's budget for a body's first load, on the wire (spec section 10). */
const BODY_FIRST_LOAD_BUDGET = 2 * 1024 * 1024;
const FIRST_LOAD = (r: { sizes?: Record<string, number> }) => r.sizes?.firstLoadWire ?? r.sizes?.firstLoad ?? 0;

export interface Report {
  build: string;
  baker: string;
  generatedAt: string;
  counts: { total: number; ok: number; failed: number; overBudget: number };
  posters?: { ok: number; failed: number };
  bytes: { glb: number; clips: number; firstLoadMax: number };
  failures: { id: string; error: string }[];
  overBudget: { id: string; firstLoad: number }[];
  warnings: { id: string; warnings: string[] }[];
  models: { id: string; kind: string; status: string; seconds: number; sizes: Record<string, number> }[];
  /** What the bucket and the month stand at, against the limits the store enforces. */
  usage?: Usage & { limits: typeof LIMITS };
  /** What each line lists, and what it left out. Nothing here is hidden. */
  listing?: Listing;
}

export async function buildReport(store: Store): Promise<Report> {
  const everything: BakeRecord[] = [...(await recordsOf(store)).values()];
  // A poster is a small image of a model already listed here. Tens of thousands of rows of
  // them would bury the table: they count, they fail out loud, and they get one line.
  const records = everything.filter((r) => r.kind !== "poster");
  const posters = everything.filter((r) => r.kind === "poster");
  const ok = records.filter((r) => r.status === "ok");
  const failures = everything.filter((r) => r.status === "failed").map((r) => ({ id: r.id, error: r.error ?? "unknown" }));
  const over = ok.filter((r) => r.kind === "body" && FIRST_LOAD(r) > BODY_FIRST_LOAD_BUDGET).map((r) => ({ id: r.id, firstLoad: FIRST_LOAD(r) }));
  return {
    build: BUILD.version,
    baker: BAKER_VERSION,
    generatedAt: new Date().toISOString(),
    counts: { total: records.length, ok: ok.length, failed: failures.length, overBudget: over.length },
    posters: { ok: posters.filter((r) => r.status === "ok").length, failed: posters.filter((r) => r.status === "failed").length },
    bytes: {
      glb: ok.reduce((n, r) => n + (r.sizes?.glb ?? 0), 0),
      clips: ok.reduce((n, r) => n + (r.sizes?.clipsTotal ?? 0), 0),
      firstLoadMax: Math.max(0, ...ok.map(FIRST_LOAD)),
    },
    failures,
    overBudget: over,
    warnings: records.filter((r) => r.warnings.length).map((r) => ({ id: r.id, warnings: r.warnings })),
    models: records.map((r) => ({ id: r.id, kind: r.kind, status: r.status, seconds: r.seconds, sizes: r.sizes ?? {} })),
  };
}

export function summaryMarkdown(r: Report): string {
  const lines = [
    `## Bake report, build ${r.build}`,
    "",
    `${r.counts.ok} of ${r.counts.total} baked, ${r.counts.failed} failed, ${r.counts.overBudget} over budget.`,
    ...(r.posters && r.posters.ok + r.posters.failed > 0 ? ["", `Posters: ${r.posters.ok} drawn, ${r.posters.failed} failed.`] : []),
    "",
    ...(r.usage ? [`R2: ${(r.usage.bytes / 1e9).toFixed(3)} of ${(r.usage.limits.bytes / 1e9).toFixed(1)} GB, ${r.usage.objects} objects, ${r.usage.classA} of ${r.usage.limits.classA} Class A this month.`, ""] : []),
    ...(r.listing
      ? [
          "| Line | Rows | Listed | Not baked | Left out | With entry |",
          "|---|---|---|---|---|---|",
          ...Object.entries(r.listing.lines).map(([id, l]) => `| ${id} | ${l.coverage.total} | ${l.listed} | ${l.notBaked} | ${l.failed + l.coverage.unresolved + l.coverage.unnamed + l.coverage.noSlot} | ${l.entries} |`),
          "",
          `Mounts: ${r.listing.mounts.listed} of ${r.listing.mounts.families} animals, ${r.listing.mounts.variantsListed} of ${r.listing.mounts.variants} colours, ${r.listing.mounts.failed} left out, ${r.listing.mounts.entries} with a display id.`,
          "",
          `Posters listed: ${r.listing.posters?.mounts ?? 0} of ${r.listing.mounts.variantsListed} colours, ${r.listing.posters?.items ?? 0} items, ${r.listing.posters?.sets ?? 0} sets.`,
          "",
        ]
      : []),
    "| Model | First load | GLB | Clips | Seconds |",
    "|---|---|---|---|---|",
  ];
  for (const m of r.models) {
    const s = m.sizes;
    lines.push(`| ${m.id} | ${humanBytes(FIRST_LOAD(m))} | ${humanBytes(s.glb ?? 0)} | ${s.clipCount ?? 0}, ${humanBytes(s.clipsTotal ?? 0)} | ${m.seconds.toFixed(0)} |`);
  }
  if (r.failures.length) {
    lines.push("", "### Failures", "");
    for (const f of r.failures) lines.push(`- **${f.id}**: ${f.error}`);
  }
  if (r.warnings.length) {
    lines.push("", "### Warnings", "");
    for (const w of r.warnings) lines.push(`- **${w.id}**: ${w.warnings.join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * R2 serves what was stored, with its Content-Encoding. That can only be proven from
 * outside: fetch the catalogue the way a browser does and parse it.
 */
export async function publicReadCheck(base: string): Promise<string> {
  try {
    const res = await fetch(packUrl(base, paths.catalog()), { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return `public read of the catalogue answered ${res.status}`;
    const catalog = JSON.parse(await res.text()) as { formatVersion?: number };
    if (catalog.formatVersion === undefined) return "public read of the catalogue parsed, but it has no formatVersion";
    return "";
  } catch (e) {
    return `public read of the catalogue failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function runReport(store: Store, summaryFile?: string, shards = 0): Promise<void> {
  // A matrix of shards each left its delta: fold them in before anything reads the ledger.
  if (store instanceof BudgetStore && shards > 0) {
    const n = await store.foldShards(shards);
    log(`report: folded ${n} shard ledger(s)`);
  }
  const report = await buildReport(store);
  // The catalogue ran before this bake: only now can it say what was baked.
  await markBaked(store);
  const listing = await store.get("reports/listing.json");
  if (listing) report.listing = JSON.parse(listing.toString("utf8")) as Listing;
  if (store.name === "r2") {
    const problem = await publicReadCheck(R2.publicBase);
    if (problem) {
      report.failures.push({ id: "public-read", error: problem });
      report.counts.failed++;
      process.exitCode = 1;
    } else {
      log(`report: ${R2.publicBase} serves the catalogue, decoded, to a plain fetch`);
    }
  }
  if (store instanceof BudgetStore) report.usage = { ...store.current(), limits: LIMITS };
  await store.put(paths.report(), Buffer.from(JSON.stringify(report, null, 1)));
  if (store instanceof BudgetStore) await store.flush();
  log(`report: ${report.counts.ok}/${report.counts.total} ok, ${report.counts.failed} failed, ${report.counts.overBudget} over budget, largest first load ${humanBytes(report.bytes.firstLoadMax)}`);
  if (summaryFile) appendFileSync(summaryFile, summaryMarkdown(report));
}
