// Moving the site to a custom domain means changing only `site` and `base` here.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { enginePreload, basisAssets } from "./integrations/engine-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const engineEntry = resolve(here, "../engine/src/index.ts");
const stubEntry = resolve(here, "src/lib/dev/engine-stub.ts");
const stubCells = resolve(here, "src/lib/dev/cells-stub.ts");

// ECLIPSE_ENGINE=stub is the test double. A missing engine also falls back to it
// so the site still builds while engine/ is being written; say so out loud.
const useStub = process.env.ECLIPSE_ENGINE === "stub" || !existsSync(engineEntry);
if (useStub && process.env.ECLIPSE_ENGINE !== "stub") {
  console.warn("[site] engine/src/index.ts is missing: this build uses the engine stub");
}

// The engine asks for its runtime files at "/basis/" and "/gpu", which miss under a
// subpath. It reads no base of its own yet, so its bundle gets the site's here; once
// engine/ uses import.meta.env.BASE_URL this finds nothing to replace and does nothing.
const baseUrl = 'import.meta.env.BASE_URL.replace(/\\/?$/, "/")';
const engineBasePaths = {
  name: "eclipse-engine-base-paths",
  enforce: "pre",
  transform(code, id) {
    if (!/engine[\\/]src[\\/]/.test(id)) return null;
    if (!code.includes('"/basis/"') && !code.includes('"/gpu"')) return null;
    return code.replaceAll('"/basis/"', `(${baseUrl} + "basis/")`).replaceAll('"/gpu"', `(${baseUrl} + "gpu")`);
  },
};

export default defineConfig({
  site: "https://kirazul.github.io",
  base: "/Eclipse-Viewer",
  output: "static",
  trailingSlash: "always",
  outDir: process.env.ECLIPSE_OUT_DIR || "dist",
  build: { format: "directory" },
  devToolbar: { enabled: false },
  prefetch: { prefetchAll: false, defaultStrategy: "hover" },
  integrations: [react(), basisAssets(), enginePreload()],
  vite: {
    plugins: [tailwindcss(), engineBasePaths],
    resolve: {
      alias: useStub ? [{ find: /^@eclipse\/engine$/, replacement: stubEntry }, { find: /^@eclipse\/engine\/cells$/, replacement: stubCells }] : [],
    },
    build: { assetsInlineLimit: 0, cssMinify: true, target: "es2022" },
  },
});
