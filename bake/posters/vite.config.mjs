// The poster page, a production bundle of the engine's cells and nothing else. It lands in
// work/, which nothing ships: the baker serves it to its own headless browser.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default {
  root: join(here, "page"),
  base: "/",
  logLevel: "warn",
  server: { fs: { allow: [join(here, "..", "..")] } },
  build: { outDir: join(here, "..", "..", "work", "poster-page"), emptyOutDir: true, target: "es2022", reportCompressedSize: false, sourcemap: false },
};
