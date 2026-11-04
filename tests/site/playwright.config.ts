import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// Uses the Edge already installed: no browser download. The UI suite runs against a
// build with the engine stub, so it needs neither WebGL nor packs. real.pw.ts runs
// against a build of the real engine, on its own port, when engine/ exists.
const shared = { channel: "msedge" as const, colorScheme: "dark" as const, serviceWorkers: "block" as const };
const root = fileURLToPath(new URL("../..", import.meta.url));
const hasEngine = existsSync(`${root}engine/src/index.ts`);

export default defineConfig({
  testDir: ".",
  // Not *.spec.ts: the repo's `vitest run` would pick those up.
  testMatch: "**/*.pw.ts",
  outputDir: "./results/output",
  reporter: [["list"]],
  timeout: 40_000,
  workers: 2,
  fullyParallel: false,
  use: { baseURL: "http://localhost:4329/Eclipse-Viewer/", trace: "off" },
  testIgnore: hasEngine ? [] : ["**/real.pw.ts"],
  webServer: [
    {
      command: "node tests/site/build-and-serve.mjs",
      cwd: root,
      url: "http://localhost:4329/Eclipse-Viewer/",
      reuseExistingServer: true,
      timeout: 240_000,
      stdout: "pipe",
    },
    ...(hasEngine
      ? [{
          command: "node tests/site/build-and-serve.mjs",
          cwd: root,
          url: "http://localhost:4330/Eclipse-Viewer/",
          env: { ECLIPSE_ENGINE: "real", PORT: "4330" },
          reuseExistingServer: true,
          timeout: 240_000,
          stdout: "pipe" as const,
        }]
      : []),
  ],
  projects: [
    { name: "desktop", use: { ...shared, viewport: { width: 1600, height: 900 } } },
    { name: "mobile", use: { ...shared, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
