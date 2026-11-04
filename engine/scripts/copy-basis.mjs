// Copies what the engine fetches at runtime into the site's public folder: the Basis
// transcoder (/basis/) and detect-gpu's benchmark tables (/gpu/), so neither depends
// on a third-party CDN. Run: pnpm --filter @eclipse/engine copy-public
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const modules = join(here, "..", "node_modules");
const out = resolve(process.argv[2] ?? join(here, "..", "..", "site", "public"));

const basisFrom = join(modules, "three", "examples", "jsm", "libs", "basis");
const basisTo = join(out, "basis");
mkdirSync(basisTo, { recursive: true });
for (const f of ["basis_transcoder.js", "basis_transcoder.wasm"]) cpSync(join(basisFrom, f), join(basisTo, f));

const gpuFrom = join(modules, "detect-gpu", "dist", "benchmarks");
const gpuTo = join(out, "gpu");
mkdirSync(gpuTo, { recursive: true });
for (const f of readdirSync(gpuFrom)) if (f.endsWith(".json")) cpSync(join(gpuFrom, f), join(gpuTo, f));

console.log(`copied Basis to ${basisTo} and GPU tables to ${gpuTo}`);
