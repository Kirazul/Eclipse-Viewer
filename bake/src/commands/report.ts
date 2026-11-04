import { appendFileSync } from "node:fs";
import { BUILD, R2, packUrl, paths } from "@eclipse/format";
import type { BakeRecord } from "../bake/context";
import { BAKER_VERSION, humanBytes, log } from "../lib/env";
import type { Store } from "../store/store";
import { markBaked } from "./catalog";

/** Milestone 1's budget for a body's first load, on the wire (spec section 10). */
const BODY_FIRST_LOAD_BUDGET = 2 * 1024 * 1024;
const FIRST_LOAD = (r: { sizes?: Record<string, number> }) => r.sizes?.firstLoadWire ?? r.sizes?.firstLoad ?? 0;

export interface Report {
  build: string;
  baker: string;
  generatedAt: string;
  counts: { total: number; ok: number; failed: number; overBudget: number };
  bytes: { glb: number; clips: number; firstLoadMax: number };
  failures: { id: string; error: string }[];
  overBudget: { id: string; firstLoad: number }[];
  warnings: { id: string; warnings: string[] }[];
  models: { id: string; kind: string; status: string; seconds: number; sizes: Record<string, number> }[];
}

export async function buildReport(store: Store): Promise<Report> {
  const records: BakeRecord[] = [];
  for (const key of await store.list("records/")) {
    const b = await store.get(key);
    if (b) records.push(JSON.parse(b.toString("utf8")) as BakeRecord);
  }
  const ok = records.filter((r) => r.status === "ok");
  const failures = records.filter((r) => r.status === "failed").map((r) => ({ id: r.id, error: r.error ?? "unknown" }));
  const over = ok.filter((r) => r.kind === "body" && FIRST_LOAD(r) > BODY_FIRST_LOAD_BUDGET).map((r) => ({ id: r.id, firstLoad: FIRST_LOAD(r) }));
  return {
    build: BUILD.version,
    baker: BAKER_VERSION,
    generatedAt: new Date().toISOString(),
    counts: { total: records.length, ok: ok.length, failed: failures.length, overBudget: over.length },
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
    "",
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

export async function runReport(store: Store, summaryFile?: string): Promise<void> {
  const report = await buildReport(store);
  // The catalogue ran before this bake: only now can it say what was baked.
  await markBaked(store);
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
  await store.put(paths.report(), Buffer.from(JSON.stringify(report, null, 1)));
  log(`report: ${report.counts.ok}/${report.counts.total} ok, ${report.counts.failed} failed, ${report.counts.overBudget} over budget, largest first load ${humanBytes(report.bytes.firstLoadMax)}`);
  if (summaryFile) appendFileSync(summaryFile, summaryMarkdown(report));
}
