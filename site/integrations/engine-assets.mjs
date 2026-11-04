import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The KTX2 transcoder is served from `<base>basis/`, copied out of the engine's
 * own three.js so its version can never drift from the loader that calls it.
 */
export function basisAssets() {
  return {
    name: "eclipse-basis",
    hooks: {
      "astro:config:setup": ({ logger }) => {
        const out = resolve(here, "../public/basis");
        const modules = resolve(here, "../../engine/node_modules");
        try {
          const src = join(modules, "three/examples/jsm/libs/basis");
          mkdirSync(out, { recursive: true });
          for (const f of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
            copyFileSync(join(src, f), join(out, f));
          }
          // detect-gpu's benchmark tables, for the same reason: no third-party CDN.
          const gpuSrc = join(modules, "detect-gpu/dist/benchmarks");
          const gpuOut = resolve(here, "../public/gpu");
          mkdirSync(gpuOut, { recursive: true });
          for (const f of readdirSync(gpuSrc)) {
            if (f.endsWith(".json")) copyFileSync(join(gpuSrc, f), join(gpuOut, f));
          }
        } catch (e) {
          logger.warn(`basis transcoder not copied: ${e.message}`);
        }
      },
    },
  };
}

/**
 * Adds <link rel=modulepreload> for the engine and its static imports to the
 * pages with the full viewer, so the browser starts fetching the engine as soon
 * as it reads <head>, while the page itself still imports it dynamically.
 */
export function enginePreload() {
  let graph = [];
  let base = "/";
  const capture = {
    name: "eclipse-engine-chunks",
    apply: "build",
    generateBundle(_opts, bundle) {
      const chunks = Object.values(bundle).filter((c) => c.type === "chunk");
      const entry = chunks.find((c) =>
        Object.keys(c.modules).some((id) => /engine[\\/]src[\\/]engine\.ts$|engine-stub\.ts$/.test(id)));
      if (!entry) return;
      const seen = new Set();
      const walk = (c) => {
        if (!c || seen.has(c.fileName)) return;
        seen.add(c.fileName);
        for (const i of c.imports) walk(bundle[i]);
      };
      walk(entry);
      graph = [...seen];
    },
  };
  return {
    name: "eclipse-engine-preload",
    hooks: {
      "astro:config:setup": ({ updateConfig, config }) => {
        base = config.base.endsWith("/") ? config.base : `${config.base}/`;
        updateConfig({ vite: { plugins: [capture] } });
      },
      "astro:build:done": ({ dir, logger }) => {
        // Local dev packs live in public/packs; production reads R2, so they never ship.
        if (!process.env.PUBLIC_PACK_BASE) {
          rmSync(join(fileURLToPath(dir), "packs"), { recursive: true, force: true });
        }
        if (!graph.length) {
          logger.warn("engine chunk not found: no modulepreload added");
          return;
        }
        const links = graph.map((f) => `<link rel="modulepreload" href="${base}${f}">`).join("");
        for (const page of ["wardrobe/index.html", "viewer/index.html"]) {
          const path = join(fileURLToPath(dir), page);
          if (!existsSync(path)) continue;
          writeFileSync(path, readFileSync(path, "utf8").replace("</head>", `${links}</head>`));
        }
        logger.info(`modulepreload: ${graph.length} engine chunk(s)`);
      },
    },
  };
}
