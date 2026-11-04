import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD } from "@eclipse/format";
import { WORK, log, mapLimit, md5Hex } from "../lib/env";
import { BlteKeyMissing, decodeBlte, parseTactKeys } from "../tact/blte";
import { ArchiveIndex, type EncodingHeader, encodingLookup, parseConfig, parseEncodingHeader, parseRoot } from "../tact/tables";
import { type GameSource, MissingFile, type SourceFile, httpGet } from "./source";
import { WagoSource } from "./wago";

const CHUNK = 4 << 20;
const TACT_KEYS_URL = "https://raw.githubusercontent.com/wowdev/TACTKeys/master/WoW.txt";

/**
 * Blizzard's CDN, the production route: build config -> root (fdid to content key)
 * -> encoding (content key to encoded key) -> archive indexes (encoded key to
 * archive, offset, size) -> byte range -> BLTE decode -> MD5 must equal the
 * content key. Port of Eclipse's tools/lib/tact_cdn.py.
 *
 * The build-wide tables go to work/tact/<build>/, which CI restores with
 * actions/cache: they never change for a pinned build. Game files stay in memory
 * and are gone when the caller drops them. A file the CDN cannot serve falls back
 * to wago, and every fallback is counted in {@link fallbacks}.
 */
export class CdnSource implements GameSource {
  readonly name = "cdn" as const;
  readonly fallbacks: { fdid: number; why: string }[] = [];

  private readonly cache: string;
  private readonly wago: WagoSource;
  private tables?: Promise<Tables>;
  private indexes?: Promise<{ name: string; index: ArchiveIndex }[]>;
  private tactKeys?: Promise<Map<string, Uint8Array>>;

  constructor(
    private readonly build = BUILD.version,
    private readonly hosts: readonly string[] = BUILD.cdnHosts,
    private readonly path = BUILD.cdnPath,
    private readonly buildConfig = BUILD.buildConfig,
    private readonly cdnConfig = BUILD.cdnConfig,
  ) {
    this.cache = join(WORK, "tact", build);
    this.wago = new WagoSource(build, false);
  }

  private url(host: string, kind: string, hash: string): string {
    return `http://${host}/${this.path}/${kind}/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
  }

  /** Tries each CDN host in turn: a host that fails or lacks the object is not the last word. */
  private async get(kind: string, hash: string, range?: [number, number]): Promise<Buffer | null> {
    let last: unknown = null;
    for (const host of this.hosts) {
      try {
        const body = await httpGet(this.url(host, kind, hash), { range, tries: 2 });
        if (body) return body;
      } catch (e) {
        last = e;
      }
    }
    if (last) throw last instanceof Error ? last : new Error(String(last));
    return null;
  }

  /** A whole object in ranged chunks over several connections. These tables run to 200 MB. */
  private async getLarge(hash: string, size: number): Promise<Buffer> {
    const spans: [number, number][] = [];
    for (let a = 0; a < size; a += CHUNK) spans.push([a, Math.min(a + CHUNK - 1, size - 1)]);
    const parts = await mapLimit(spans, 8, async (s) => {
      const b = await this.get("data", hash, s);
      if (!b) throw new Error(`CDN lost ${hash} mid-download`);
      return b;
    });
    return Buffer.concat(parts);
  }

  /** Read through the disk cache, atomically, so a dead job never leaves half a table. */
  private async cached(name: string, make: () => Promise<Buffer>): Promise<Buffer> {
    const p = join(this.cache, name);
    if (existsSync(p)) return readFileSync(p);
    const body = await make();
    mkdirSync(this.cache, { recursive: true });
    writeFileSync(`${p}.tmp`, body);
    renameSync(`${p}.tmp`, p);
    return body;
  }

  private loadTables(): Promise<Tables> {
    this.tables ??= this.initTables();
    return this.tables;
  }

  private async initTables(): Promise<Tables> {
    const need = async (hash: string) => {
      const b = await this.get("config", hash);
      if (!b) throw new Error(`CDN has no config ${hash}: build ${this.build} may have left the CDN`);
      return b.toString("utf8");
    };
    const bc = parseConfig((await this.cached(`config-${this.buildConfig}`, async () => Buffer.from(await need(this.buildConfig)))).toString("utf8"));
    const cc = parseConfig((await this.cached(`config-${this.cdnConfig}`, async () => Buffer.from(await need(this.cdnConfig)))).toString("utf8"));

    const [encCk, encEk] = bc.get("encoding") ?? [];
    const encSize = Number(bc.get("encoding-size")?.[1] ?? 0);
    if (!encEk || !encCk) throw new Error("build config has no encoding");
    log(`cdn: encoding (${(encSize / 1e6).toFixed(0)} MB encoded)`);
    const encoding = await this.cached("encoding.bin", async () => {
      const plain = decodeBlte(await this.getLarge(encEk, encSize));
      if (md5Hex(plain) !== encCk) throw new Error("encoding fails its content key");
      return plain;
    });
    const encHeader = parseEncodingHeader(encoding);

    const rootCk = bc.get("root")?.[0];
    if (!rootCk) throw new Error("build config has no root");
    log("cdn: root");
    const rootBytes = await this.cached("root.bin", async () => {
      const ek = encodingLookup(encoding, encHeader, rootCk);
      if (!ek) throw new Error("encoding has no row for root");
      const raw = await this.fetchEncoded(ek, cc);
      const plain = decodeBlte(raw);
      if (md5Hex(plain) !== rootCk) throw new Error("root fails its content key");
      return plain;
    });
    const root = parseRoot(rootBytes);
    log(`cdn: ${root.size} files in root`);

    return { encoding, encHeader, root, rootBytes, cdnConfig: cc };
  }

  /** Every archive's index, downloaded once and searched by binary search. */
  private async archiveIndexes(cc: Map<string, string[]>): Promise<{ name: string; index: ArchiveIndex }[]> {
    const archives = cc.get("archives") ?? [];
    log(`cdn: ${archives.length} archive indexes`);
    return mapLimit(archives, 16, async (name) => {
      const body = await this.cached(`${name}.index`, async () => {
        const b = await this.get("data", `${name}.index`);
        if (!b) throw new Error(`CDN has no index for archive ${name}`);
        return b;
      });
      return { name, index: new ArchiveIndex(body) };
    });
  }

  /** The stored (BLTE) form of an encoded key: an archive slice, else a loose file. */
  private async fetchEncoded(ek: string, cc: Map<string, string[]>): Promise<Buffer> {
    this.indexes ??= this.archiveIndexes(cc);
    const key = Buffer.from(ek, "hex");
    for (const { name, index } of await this.indexes) {
      const hit = index.lookup(key);
      if (hit) {
        const body = await this.get("data", name, [hit.offset, hit.offset + hit.size - 1]);
        if (!body) throw new Error(`archive ${name} refused a range for ${ek}`);
        return body;
      }
    }
    const loose = await this.get("data", ek);
    if (!loose) throw new Error(`no archive holds ${ek} and it is not loose on the CDN`);
    return loose;
  }

  private keys(): Promise<Map<string, Uint8Array>> {
    this.tactKeys ??= (async () => {
      const b = await this.cached("TACTKeys.txt", async () => {
        const body = await httpGet(TACT_KEYS_URL);
        if (!body) throw new Error("wowdev/TACTKeys is not reachable");
        return body;
      });
      return parseTactKeys(b.toString("utf8"));
    })();
    return this.tactKeys;
  }

  async identity(fdid: number): Promise<string | null> {
    const t = await this.loadTables();
    const at = t.root.get(fdid);
    return at === undefined ? null : t.rootBytes.toString("hex", at, at + 16);
  }

  async read(fdid: number): Promise<SourceFile> {
    const t = await this.loadTables();
    const at = t.root.get(fdid);
    if (at === undefined) throw new MissingFile(fdid, `not in the root of ${this.build}`);
    const ckey = t.rootBytes.toString("hex", at, at + 16);
    try {
      const ek = encodingLookup(t.encoding, t.encHeader, ckey);
      if (!ek) throw new Error("encoding has no row for its content key");
      const raw = await this.fetchEncoded(ek, t.cdnConfig);
      let bytes: Buffer;
      try {
        bytes = decodeBlte(raw);
      } catch (e) {
        if (!(e instanceof BlteKeyMissing)) throw e;
        const keys = await this.keys();
        bytes = decodeBlte(raw, (n) => keys.get(n));
      }
      if (md5Hex(bytes) !== ckey) throw new Error("decoded bytes do not match the content key");
      return { bytes, id: ckey };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.fallbacks.push({ fdid, why });
      const viaWago = await this.wago.read(fdid).catch(() => null);
      if (viaWago && viaWago.id === ckey) return viaWago;
      throw new MissingFile(fdid, viaWago ? `${why}; wago's copy does not match the content key` : why);
    }
  }
}

interface Tables {
  encoding: Buffer;
  encHeader: EncodingHeader;
  root: Map<number, number>;
  rootBytes: Buffer;
  cdnConfig: Map<string, string[]>;
}
