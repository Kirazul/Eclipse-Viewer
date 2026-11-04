import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD } from "@eclipse/format";
import { WORK, md5Hex } from "../lib/env";
import { type GameSource, MissingFile, type SourceFile, httpGet, isAllZero } from "./source";

/**
 * wago.tools' raw file API. Local development uses it with a disk cache, and the
 * CDN route falls back on it (without the cache) when a file is missing.
 *
 * The version is always in the URL. Without it wago serves another build: for
 * Human male that is a 29.7 MB M2 with its animations inline and raw `.anim`
 * files, where 12.1.0.69933 has an 11 MB M2, a `.skel` and chunked `.anim` files.
 * A model and its `.anim` must share a build, so the cache is per build too.
 */
export class WagoSource implements GameSource {
  readonly name = "wago" as const;
  readonly dir: string | null;
  /** Bytes this run pulled over the network: the local proofs have a budget. */
  downloaded = 0;

  constructor(private readonly build = BUILD.version, cache: boolean | string = true) {
    this.dir = cache === false ? null : typeof cache === "string" ? cache : join(WORK, "raw", build);
  }

  /** Read-only folders of raw files at this build, saving the line a download. Never written to or cleaned. */
  private readonly extra = (process.env.BAKE_RAW_EXTRA ?? "").split(";").filter(Boolean);

  private cached(fdid: number): Buffer | null {
    for (const dir of this.extra) {
      const p = join(dir, String(fdid));
      if (existsSync(p)) {
        const b = readFileSync(p);
        if (!isAllZero(b)) return b;
      }
    }
    if (!this.dir) return null;
    for (const name of [String(fdid), `${fdid}.m2`]) {
      const p = join(this.dir, name);
      if (existsSync(p)) {
        const b = readFileSync(p);
        if (!isAllZero(b)) return b;
        unlinkSync(p); // A zero body is wago saying "miss"; it must not stick.
      }
    }
    return null;
  }

  async read(fdid: number): Promise<SourceFile> {
    const hit = this.cached(fdid);
    if (hit) return { bytes: hit, id: md5Hex(hit) };
    // A local proof on a slow line: past this, a file counts as missing, not as a wait.
    const limit = Number(process.env.BAKE_DOWNLOAD_LIMIT_MB ?? Infinity);
    if (this.downloaded >= limit * 1024 * 1024) throw new MissingFile(fdid, `past this run's download limit of ${limit} MB`);
    const url = `https://wago.tools/api/casc/${fdid}?download&version=${this.build}`;
    const body = await httpGet(url, { timeoutMs: 600_000 });
    if (!body) throw new MissingFile(fdid, `wago has no file at ${this.build}`);
    if (body.length === 0 || isAllZero(body)) throw new MissingFile(fdid, `wago answered with an all-zero body at ${this.build}`);
    this.downloaded += body.length;
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      const p = join(this.dir, String(fdid));
      writeFileSync(`${p}.tmp`, body);
      renameSync(`${p}.tmp`, p);
    }
    return { bytes: body, id: md5Hex(body) };
  }

  async identity(fdid: number): Promise<string | null> {
    const hit = this.cached(fdid);
    return hit ? md5Hex(hit) : null;
  }
}
