import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BakeContext, isUpToDate, writeRecord } from "../src/bake/context";
import { Db2 } from "../src/db2/db2";
import { BAKER_VERSION } from "../src/lib/env";
import { LocalStore, R2Store, cacheControlOf, contentTypeOf } from "../src/store/store";
import { BUILD } from "@eclipse/format";
import type { GameSource } from "../src/sources/source";

const ACCESS = "AKIATESTACCESSKEY";
const SECRET = "test-secret-do-not-log-me";

interface Stored {
  body: Buffer;
  headers: IncomingMessage["headers"];
}

/** Just enough of the S3 API, to see what the client really sends. */
function fakeS3() {
  const objects = new Map<string, Stored>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "PUT") {
        objects.set(key, { body: Buffer.concat(chunks), headers: req.headers });
        res.writeHead(200, { ETag: '"x"' }).end();
      } else if (req.method === "HEAD" || req.method === "GET") {
        const o = objects.get(key);
        if (!o) return void res.writeHead(404).end();
        const h: Record<string, string> = { "Content-Length": String(o.body.length) };
        for (const [from, to] of [["content-type", "Content-Type"], ["cache-control", "Cache-Control"], ["content-encoding", "Content-Encoding"], ["x-amz-meta-raw-bytes", "x-amz-meta-raw-bytes"]] as const) {
          const v = o.headers[from];
          if (typeof v === "string") h[to] = v;
        }
        res.writeHead(200, h);
        if (req.method === "GET") res.write(o.body);
        res.end();
      } else {
        res.writeHead(405).end();
      }
    });
  });
  return { server, objects };
}

describe("R2 store, against a fake S3", () => {
  const { server, objects } = fakeS3();
  let store: R2Store;
  let endpoint = "";

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    store = new R2Store({ endpoint, bucket: "eclipse", accessKeyId: ACCESS, secretAccessKey: SECRET });
  });
  afterAll(() => {
    server.close();
  });

  it("marks hashed objects immutable and the rest short-lived", async () => {
    await store.put("objects/abc.ktx2", new Uint8Array(10));
    await store.put("models/human-male/manifest.json", Buffer.from("{}"));
    await store.put("catalog/catalog.json", Buffer.from("{}"));
    expect(objects.get("objects/abc.ktx2")!.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(objects.get("objects/abc.ktx2")!.headers["content-type"]).toBe("image/ktx2");
    expect(objects.get("models/human-male/manifest.json")!.headers["cache-control"]).toBe("public, max-age=3600");
    expect(objects.get("catalog/catalog.json")!.headers["cache-control"]).toBe("public, max-age=300");
  });

  it("stores GLB and JSON as brotli, leaves KTX2 alone, and reports the decoded size", async () => {
    const glb = Buffer.alloc(5000, 7);
    await store.put("objects/x.glb", glb);
    const stored = objects.get("objects/x.glb")!;
    expect(stored.headers["content-encoding"]).toBe("br");
    expect(stored.headers["content-type"]).toBe("model/gltf-binary");
    expect(stored.body.length).toBeLessThan(glb.length);
    expect(brotliDecompressSync(stored.body).equals(glb)).toBe(true);
    expect(await store.stat("objects/x.glb")).toBe(5000);
    expect((await store.get("objects/x.glb"))!.equals(glb)).toBe(true);
    expect(objects.get("objects/abc.ktx2")!.headers["content-encoding"]).toBeUndefined();
    expect(await store.stat("objects/abc.ktx2")).toBe(10);
  });

  it("a browser-style fetch gets the original bytes back", async () => {
    const res = await fetch(`${endpoint}/eclipse/objects/x.glb`);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.alloc(5000, 7))).toBe(true);
  });

  it("answers null for a missing object rather than throwing", async () => {
    expect(await store.stat("objects/none.glb")).toBeNull();
    expect(await store.get("objects/none.glb")).toBeNull();
  });

  it("sends the secret to nothing but the signature", async () => {
    for (const o of objects.values()) {
      expect(JSON.stringify(o.headers)).not.toContain(SECRET);
    }
  });

  it("refuses to start without credentials, naming the variables and no value", () => {
    const a = process.env.R2_ACCESS_KEY_ID;
    const b = process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    expect(() => new R2Store()).toThrow(/R2_ACCESS_KEY_ID/);
    if (a) process.env.R2_ACCESS_KEY_ID = a;
    if (b) process.env.R2_SECRET_ACCESS_KEY = b;
  });
});

describe("content types and cache rules", () => {
  it("covers what the baker writes", () => {
    expect(contentTypeOf("objects/a.webp")).toBe("image/webp");
    expect(contentTypeOf("objects/a.phys")).toBe("application/octet-stream");
    expect(cacheControlOf("ui/atlas.webp")).toBe("public, max-age=3600");
    expect(cacheControlOf("items/item-1/manifest.json")).toBe("public, max-age=3600");
    expect(cacheControlOf("catalog/catalog.json")).toBe("public, max-age=300");
    expect(cacheControlOf("objects/a.webp")).toContain("immutable");
  });
});

describe("local store", () => {
  const root = mkdtempSync(join(tmpdir(), "bake-store-"));
  const store = new LocalStore(root);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("writes atomically and leaves no temporary behind", async () => {
    await store.put("objects/a.glb", Buffer.from("hello"));
    expect(existsSync(join(root, "objects", "a.glb.tmp"))).toBe(false);
    expect(readFileSync(join(root, "objects", "a.glb"), "utf8")).toBe("hello");
    expect(await store.stat("objects/a.glb")).toBe(5);
    expect(await store.stat("objects/b.glb")).toBeNull();
    expect(await store.list("objects/")).toEqual(["objects/a.glb"]);
  });
});

describe("skip logic", () => {
  const root = mkdtempSync(join(tmpdir(), "bake-skip-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const source = (over: Record<string, string> = {}): GameSource => ({
    name: "wago",
    read: async () => {
      throw new Error("a skipped unit must not read game files");
    },
    identity: async (f) => over[String(f)] ?? "same",
  });
  const ctx = (s: GameSource, force = false): BakeContext => ({ source: s, db: new Db2(), store: new LocalStore(root), force });
  const record = (build: string, baker = BAKER_VERSION) => ({
    id: "m",
    kind: "body",
    status: "ok" as const,
    build,
    baker,
    source: "wago",
    inputs: { "100": "same" },
    warnings: [],
    seconds: 0,
    bakedAt: "",
  });

  it("needs both the record and the output", async () => {
    const c = ctx(source());
    expect(await isUpToDate(c, "m", "models/m/manifest.json")).toBe(false);
    await writeRecord(c.store, record(BUILD.version));
    expect(await isUpToDate(c, "m", "models/m/manifest.json")).toBe(false);
    await c.store.put("models/m/manifest.json", Buffer.from("{}"));
    expect(await isUpToDate(c, "m", "models/m/manifest.json")).toBe(true);
  });

  it("re-bakes when forced, or when the baker changed", async () => {
    expect(await isUpToDate(ctx(source(), true), "m", "models/m/manifest.json")).toBe(false);
    const c = ctx(source());
    await writeRecord(c.store, record(BUILD.version, "older"));
    expect(await isUpToDate(c, "m", "models/m/manifest.json")).toBe(false);
  });

  it("after a pin bump, skips only if every input is unchanged", async () => {
    const c = ctx(source());
    await writeRecord(c.store, record("older-build"));
    expect(await isUpToDate(c, "m", "models/m/manifest.json")).toBe(true);
    expect(await isUpToDate(ctx(source({ "100": "changed" })), "m", "models/m/manifest.json")).toBe(false);
  });

  it("treats a failed record as not done", async () => {
    const c = ctx(source());
    await writeRecord(c.store, { ...record(BUILD.version), status: "failed" });
    expect(await isUpToDate(c, "m", "models/m/manifest.json")).toBe(false);
  });
});
