// Serves a built site the way GitHub Pages does: under a subpath, a redirect to the
// trailing slash, 404.html from the root. It also counts hits, which is how the
// repeat-visit test proves a second visit stays off the network.
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(here, "../../site", process.env.SITE_DIR || "dist-test");
const BASE = "/Eclipse-Viewer";
const PORT = Number(process.env.PORT || 4329);
// Pages sends max-age=600. Zero here, so a request that reaches this server can't be
// explained away by the browser's HTTP cache: only the service worker can avoid it.
const CACHE = process.env.SITE_CACHE || "max-age=0";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".ktx2": "image/ktx2",
};
let hits = [];
let stamp = "";

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  // Tests running side by side tell their hits apart by user agent.
  const agent = req.headers["user-agent"] ?? "";
  if (url.pathname === "/__hits") {
    const ua = url.searchParams.get("ua") ?? "";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(hits.filter((h) => h.agent.includes(ua)).map((h) => h.path)));
    return;
  }
  if (url.pathname === "/__reset") {
    hits = [];
    res.end("ok");
    return;
  }
  if (url.pathname === "/__deploy") {
    stamp = url.searchParams.get("v") ?? "";
    res.end("ok");
    return;
  }
  hits.push({ path: url.pathname, agent });
  res.setHeader("Cache-Control", CACHE);
  res.setHeader("Access-Control-Allow-Origin", "*");
  const send = (file, status = 200) => {
    res.statusCode = status;
    res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
    // A stamp in the HTML stands in for a new deploy.
    if (stamp && file.endsWith(".html")) {
      res.end(readFileSync(file, "utf8").replace("</head>", `<meta name="deploy" content="${stamp}"></head>`));
      return;
    }
    // Pages gzips text and wasm; packs are already compact and go as they are.
    if (/\.(js|mjs|css|html|json|svg|wasm)$/.test(file) && (req.headers["accept-encoding"] ?? "").includes("gzip")) {
      res.setHeader("Content-Encoding", "gzip");
      res.end(gzipSync(readFileSync(file), { level: 6 }));
      return;
    }
    createReadStream(file).pipe(res);
  };
  const notFound = () => send(join(ROOT, "404.html"), 404);
  if (!url.pathname.startsWith(`${BASE}/`)) return notFound();
  const rel = decodeURIComponent(url.pathname.slice(BASE.length));
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) return notFound();
  if (existsSync(file) && statSync(file).isFile()) return send(file);
  if (!rel.endsWith("/") && existsSync(join(file, "index.html"))) {
    res.statusCode = 301;
    res.setHeader("Location", `${url.pathname}/${url.search}`);
    res.end();
    return;
  }
  if (rel.endsWith("/") && existsSync(join(file, "index.html"))) return send(join(file, "index.html"));
  notFound();
}).listen(PORT, () => console.log(`site on http://localhost:${PORT}${BASE}/`));
