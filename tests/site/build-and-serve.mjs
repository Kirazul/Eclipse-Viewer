// Builds the site into its own folder, then serves it. The default build uses the
// engine stub; ECLIPSE_ENGINE=real builds the real engine into dist-real, and ECLIPSE_PACKS
// points that at packs elsewhere, the real ones on R2. A test run never touches site/dist,
// the build that deploys.
import { spawnSync } from "node:child_process";

const real = process.env.ECLIPSE_ENGINE === "real";
const outDir = process.env.SITE_OUT ?? (real ? "dist-real" : "dist-test");
process.env.SITE_DIR = outDir;
if (!process.env.SKIP_BUILD) {
  const env = { ...process.env, ECLIPSE_ENGINE: real ? "real" : "stub", ECLIPSE_OUT_DIR: outDir, PUBLIC_PACK_BASE: process.env.ECLIPSE_PACKS ?? "/Eclipse-Viewer/packs" };
  const r = spawnSync("pnpm --filter @eclipse/site exec astro build", { stdio: "inherit", env, shell: true });
  if (r.status) process.exit(r.status);
}
if (!process.env.BUILD_ONLY) await import("./server.mjs");
