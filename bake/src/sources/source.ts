/** A retail file by FileDataID, from wherever this run reads them. */
export interface SourceFile {
  bytes: Buffer;
  /** Content identity: MD5 of the file. On the CDN route that is the TACT content key. */
  id: string;
}

export interface GameSource {
  readonly name: "cdn" | "wago";
  /** The file's bytes, or a {@link MissingFile} error. Nothing is kept once the caller drops it. */
  read(fdid: number): Promise<SourceFile>;
  /** Identity without the body, when it is cheap. Null when only a read could tell. */
  identity(fdid: number): Promise<string | null>;
}

/** The source has no such file at this build, or can only answer with zeros. */
export class MissingFile extends Error {
  constructor(public readonly fdid: number, reason: string) {
    super(`file ${fdid}: ${reason}`);
    this.name = "MissingFile";
  }
}

export function isAllZero(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

export interface FetchOptions {
  range?: [number, number];
  timeoutMs?: number;
  tries?: number;
}

/** GET with retries. Resolves to null on 404. Network errors and 5xx retry, then throw. */
export async function httpGet(url: string, opts: FetchOptions = {}): Promise<Buffer | null> {
  const tries = opts.tries ?? 4;
  let last: unknown;
  for (let t = 0; t < tries; t++) {
    try {
      const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0" };
      if (opts.range) headers.Range = `bytes=${opts.range[0]}-${opts.range[1]}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
      if (t < tries - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** t));
    }
  }
  throw new Error(`GET ${url} failed after ${tries} tries: ${String(last)}`);
}
