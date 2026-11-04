// Builds the site with the real engine against the real packs on R2, then serves it the way
// GitHub Pages does. Wearing has to be proven on what visitors get: R2's sockets, R2's
// latency, the real art. A test run never touches site/dist, the build that deploys.
import { spawnSync } from "node:child_process";

const outDir = process.env.SITE_OUT ?? "dist-wear";
process.env.SITE_DIR = outDir;
process.env.PORT ??= "4341";
process.env.SITE_CACHE ??= "max-age=600";
if (!process.env.SKIP_BUILD) {
  const env = { ...process.env, ECLIPSE_ENGINE: "real", ECLIPSE_OUT_DIR: outDir, PUBLIC_PACK_BASE: process.env.PACK_BASE ?? "https://pub-8475da48fc7347d690ebb4e8e0254fdd.r2.dev" };
  const r = spawnSync("pnpm --filter @eclipse/site exec astro build", { stdio: "inherit", env, shell: true });
  if (r.status) process.exit(r.status);
}
if (!process.env.BUILD_ONLY) await import("../site/server.mjs");
