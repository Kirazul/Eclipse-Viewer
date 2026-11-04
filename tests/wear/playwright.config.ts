import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

/**
 * Wearing, proven on the real engine against the real packs on R2: the art that really broke
 * and the network visitors really have. It needs the internet and a GPU, so it stands apart
 * from tests/site. Uses the installed Edge; no browser is downloaded.
 *   WEAR_BASE=<url> runs it against a site already up, the live one for instance.
 */
const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.pw.ts",
  outputDir: "./results/output",
  reporter: [["list"]],
  timeout: 240_000,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: process.env.WEAR_BASE ?? "http://localhost:4341/Eclipse-Viewer/",
    channel: "msedge",
    headless: true,
    viewport: { width: 1400, height: 860 },
    serviceWorkers: "block",
    launchOptions: {
      args: ["--headless=new", "--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-precise-memory-info", "--js-flags=--expose-gc"],
    },
  },
  webServer: process.env.WEAR_BASE
    ? undefined
    : {
        command: "node tests/wear/serve.mjs",
        cwd: root,
        url: "http://localhost:4341/Eclipse-Viewer/",
        reuseExistingServer: true,
        timeout: 300_000,
        stdout: "pipe",
      },
});
