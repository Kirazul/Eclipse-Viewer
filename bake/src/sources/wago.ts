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

  constructor(private readonly build = BUILD.version, cache: boolean | string = true) {
    this.dir = cache === false ? null : typeof cache === "string" ? cache : join(WORK, "raw", build);
  }

  private cached(fdid: number): Buffer | null {
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
    const url = `https://wago.tools/api/casc/${fdid}?download&version=${this.build}`;
    const body = await httpGet(url, { timeoutMs: 600_000 });
    if (!body) throw new MissingFile(fdid, `wago has no file at ${this.build}`);
    if (body.length === 0 || isAllZero(body)) throw new MissingFile(fdid, `wago answered with an all-zero body at ${this.build}`);
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
