import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// Uses the Edge already installed: no browser download. The UI suite runs against a
// build with the engine stub, so it needs neither WebGL nor packs. real.pw.ts runs
// against a build of the real engine, on its own port, when engine/ exists. *.real.ts run
// last and on one worker, on the real packs on R2 and a real GPU: a frame time measured beside
// another worker measures the other worker. To run them alone:
//   npx playwright test --config tests/site/playwright.config.ts --project real-data --no-deps
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
  // A server of your own (REAL_BASE, see lines.pw.ts): several runs at once won't share one.
  webServer: process.env.REAL_BASE ? undefined : [
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
    ...(hasEngine
      ? [{
          command: "node tests/site/build-and-serve.mjs",
          cwd: root,
          url: "http://localhost:4331/Eclipse-Viewer/",
          env: { ECLIPSE_ENGINE: "real", PORT: "4331", SITE_OUT: "dist-r2", ECLIPSE_PACKS: "https://pub-8475da48fc7347d690ebb4e8e0254fdd.r2.dev", SITE_CACHE: "max-age=600" },
          reuseExistingServer: true,
          timeout: 300_000,
          stdout: "pipe" as const,
        }]
      : []),
  ],
  projects: [
    { name: "desktop", use: { ...shared, viewport: { width: 1600, height: 900 } } },
    { name: "mobile", use: { ...shared, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    {
      name: "real-data",
      testMatch: "**/*.real.ts",
      workers: 1,
      timeout: 300_000,
      dependencies: ["desktop", "mobile"],
      use: { ...shared, launchOptions: { args: ["--headless=new", "--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-precise-memory-info"] } },
    },
  ],
});
