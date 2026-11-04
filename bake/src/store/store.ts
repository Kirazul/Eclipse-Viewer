import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants } from "node:zlib";
import { R2 } from "@eclipse/format";
import { LOCAL_PACKS } from "../lib/env";

/** Where baked objects land: R2 with `--upload`, `site/public/packs/` otherwise. */
export interface Store {
  readonly name: string;
  /** Object size, or null when it isn't there. */
  stat(key: string): Promise<number | null>;
  get(key: string): Promise<Buffer | null>;
  /** Atomic: a reader sees the old object or the whole new one. */
  put(key: string, body: Uint8Array): Promise<void>;
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  glb: "model/gltf-binary",
  ktx2: "image/ktx2",
  json: "application/json",
  webp: "image/webp",
  phys: "application/octet-stream",
  bin: "application/octet-stream",
};

export function contentTypeOf(key: string): string {
  return CONTENT_TYPES[key.slice(key.lastIndexOf(".") + 1)] ?? "application/octet-stream";
}

/** Hashed objects never change. Everything else has a stable name and a new body per bake. */
export function cacheControlOf(key: string): string {
  if (key.startsWith("objects/")) return "public, max-age=31536000, immutable";
  // Every read is counted: only what a bake changes for everybody stays short. A manifest
  // an hour late still names objects that exist, and the sprites change once in a long while.
  if (key.startsWith("catalog/") || key.startsWith("reports/")) return "public, max-age=300";
  return "public, max-age=3600";
}

const brotli = promisify(brotliCompress);
const unbrotli = promisify(brotliDecompress);

/** GLB and JSON are worth compressing on the wire; KTX2 and WebP already are. */
export function isCompressible(key: string): boolean {
  return key.endsWith(".glb") || key.endsWith(".json");
}

/**
 * The bytes a visitor actually downloads. Meshopt output keeps some redundancy on
 * purpose and a clip is mostly glTF JSON, so this takes Human male's Stand from 93
 * KB to 24 KB and its body from 631 KB to 425 KB.
 */
export async function toWire(key: string, body: Uint8Array): Promise<Uint8Array> {
  if (!isCompressible(key)) return body;
  return brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } });
}

export class LocalStore implements Store {
  readonly name = "local";

  constructor(readonly root = LOCAL_PACKS) {}

  private path(key: string): string {
    return join(this.root, ...key.split("/"));
  }

  async stat(key: string): Promise<number | null> {
    const p = this.path(key);
    return existsSync(p) ? statSync(p).size : null;
  }

  async get(key: string): Promise<Buffer | null> {
    const p = this.path(key);
    return existsSync(p) ? readFileSync(p) : null;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(`${p}.tmp`, body);
    // Windows refuses to replace a file a local server has open. A moment later it is free.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(`${p}.tmp`, p);
        return;
      } catch (e) {
        if (attempt >= 8 || (e as { code?: string }).code !== "EPERM") throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(relative(this.root, p).split(sep).join("/"));
      }
    };
    walk(this.root);
    return out.filter((k) => k.startsWith(prefix) && !k.endsWith(".tmp")).sort();
  }

  async remove(key: string): Promise<void> {
    const p = this.path(key);
    if (existsSync(p)) unlinkSync(p);
  }
}

export interface R2Options {
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** R2 over the S3 API. A single PutObject is atomic, which is what makes each object its own checkpoint. */
export class R2Store implements Store {
  readonly name = "r2";
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: R2Options = {}) {
    const accessKeyId = opts.accessKeyId ?? process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = opts.secretAccessKey ?? process.env.R2_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) throw new Error("--upload needs R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in the environment");
    this.bucket = opts.bucket ?? R2.bucket;
    this.client = new S3Client({
      region: "auto",
      maxAttempts: 6,
      endpoint: opts.endpoint ?? R2.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      // R2 does not take the checksum headers newer SDKs send by default.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  /** The size the manifests talk about: decoded, the same as `LocalStore`. */
  async stat(key: string): Promise<number | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      const raw = Number(r.Metadata?.["raw-bytes"]);
      return Number.isFinite(raw) && raw > 0 ? raw : (r.ContentLength ?? 0);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await r.Body?.transformToByteArray();
      if (!bytes) return Buffer.alloc(0);
      // The S3 API hands back what was stored; only a browser decodes for us.
      return r.ContentEncoding === "br" ? await unbrotli(bytes) : Buffer.from(bytes);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.putWire(key, await toWire(key, body), body.length);
  }

  /** `wire` is already what R2 should store: compressing twice would waste a whole bake's CPU. */
  async putWire(key: string, wire: Uint8Array, rawBytes: number): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: wire,
        ContentType: contentTypeOf(key),
        CacheControl: cacheControlOf(key),
        ...(isCompressible(key) ? { ContentEncoding: "br" } : {}),
        Metadata: { "raw-bytes": String(rawBytes) },
      }),
    );
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /** Key -> stored size. One LIST per 1,000 keys. */
  async listSizes(prefix: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.set(o.Key, o.Size ?? 0);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404;
}

export function openStore(upload: boolean): Store {
  return upload ? new R2Store() : new LocalStore();
}
