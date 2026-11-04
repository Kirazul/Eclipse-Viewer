import { BUILD } from "@eclipse/format";
import { Db2 } from "../db2/db2";
import { BAKER_VERSION } from "../lib/env";
import { CdnSource } from "../sources/cdn";
import type { GameSource, SourceFile } from "../sources/source";
import { WagoSource } from "../sources/wago";
import type { Store } from "../store/store";

export interface BakeContext {
  source: GameSource;
  db: Db2;
  store: Store;
  force: boolean;
  /** Limits per-body work to these bodies. Local proofs on a slow line; the cloud bakes all. */
  onlyBodies?: Set<string>;
}

export function openSource(name: string): GameSource {
  if (name === "wago") return new WagoSource();
  if (name === "cdn") return new CdnSource();
  throw new Error(`unknown --source ${name} (cdn or wago)`);
}

export function openContext(sourceName: string, store: Store, force = false): BakeContext {
  return { source: openSource(sourceName), db: new Db2(BUILD.version, sourceName === "wago" ? "query" : "full"), store, force };
}

/** What every baked unit leaves in the store, so a rerun and the report need nothing else. */
export interface BakeRecord {
  id: string;
  kind: string;
  status: "ok" | "failed";
  error?: string;
  build: string;
  baker: string;
  source: string;
  /** fdid -> identity of every source file used. */
  inputs: Record<string, string>;
  warnings: string[];
  sizes?: Record<string, number>;
  seconds: number;
  bakedAt: string;
}

export function recordKey(id: string): string {
  return `records/${id}.json`;
}

export async function readRecord(store: Store, id: string): Promise<BakeRecord | null> {
  const b = await store.get(recordKey(id));
  return b ? (JSON.parse(b.toString("utf8")) as BakeRecord) : null;
}

export async function writeRecord(store: Store, r: BakeRecord): Promise<void> {
  await store.put(recordKey(r.id), Buffer.from(JSON.stringify(r, null, 1)));
}

/**
 * Done means: a good record from this baker and this build, plus the output it
 * promises. Files at a pinned build can't change, so this needs no root and no raw
 * file, and that is what makes a rerun instant. After the pin moves, a model is
 * still done if every input's identity is unchanged.
 */
export async function isUpToDate(ctx: BakeContext, id: string, outputKey: string): Promise<boolean> {
  if (ctx.force) return false;
  const r = await readRecord(ctx.store, id);
  if (!r || r.status !== "ok" || r.baker !== BAKER_VERSION) return false;
  if ((await ctx.store.stat(outputKey)) === null) return false;
  if (r.build === BUILD.version) return true;
  for (const [fdid, was] of Object.entries(r.inputs)) {
    if ((await ctx.source.identity(Number(fdid))) !== was) return false;
  }
  return true;
}

/** Reads through the source, keeping every file's identity for the record. */
export class Tracked {
  readonly inputs: Record<string, string> = {};

  constructor(private readonly source: GameSource) {}

  async read(fdid: number): Promise<SourceFile> {
    const f = await this.source.read(fdid);
    this.inputs[String(fdid)] = f.id;
    return f;
  }

  /** Identity alone when that is cheap, so an object already baked needs no download. */
  async identity(fdid: number): Promise<string | null> {
    const id = await this.source.identity(fdid);
    if (id) this.inputs[String(fdid)] = id;
    return id;
  }
}

