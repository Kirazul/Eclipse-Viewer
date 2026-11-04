import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Uncompressed bytes a page needs before it can run: its HTML, stylesheets and the
// module graph of its static imports. Dynamic imports (engine, three, React panels,
// search) don't count: they load only if a page uses them. Budgets: home under 500 KB
// (Khada 1.9 MB), list page under 150 KB (Khada 952 KB).
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const dist = [join(ROOT, "site/dist"), join(ROOT, "site/dist-test")].find((d) => existsSync(join(d, "index.html")))!;

function pageBytes(page: string) {
  const htmlPath = join(dist, page);
  const html = readFileSync(htmlPath, "utf8");
  const local = (url: string) => join(dist, url.replace(/^\/Eclipse-Viewer\//, ""));
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:^|[;\s}])(?:import\s*["']|(?:import|export)[^"';()]*?from\s*["'])(\.\/[^"']+)["']/g)) {
      walk(join(file, "..", m[1]!));
    }
  };
  const css = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => local(m[1]!));
  // modulepreload for the engine is deliberately ignored here: the room is not a budgeted page.
  for (const m of html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)) walk(local(m[1]!));
  const js = [...seen].reduce((n, f) => n + statSync(f).size, 0);
  const cssBytes = css.reduce((n, f) => n + statSync(f).size, 0);
  const htmlBytes = Buffer.byteLength(html);
  return { html: htmlBytes, css: cssBytes, js, total: htmlBytes + cssBytes + js, chunks: seen.size };
}

test.describe("budgets", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 700, "numbers, once");

  test("home under 500 KB, list under 150 KB, and they ship almost no JS", () => {
    const home = pageBytes("index.html");
    const list = pageBytes("mounts/index.html");
    const room = pageBytes("wardrobe/index.html");
    console.log("budget (bytes, uncompressed, static imports)", dist, JSON.stringify({ home, list, room }));
    expect(home.total).toBeLessThan(500 * 1024);
    expect(list.total).toBeLessThan(150 * 1024);
    expect(list.js).toBeLessThan(40 * 1024);
  });

  test("the list page never pulls the engine, three or React", () => {
    const html = readFileSync(join(dist, "mounts/index.html"), "utf8");
    expect(html).not.toMatch(/modulepreload/);
    expect(html).not.toMatch(/astro-island/);
    const list = readFileSync(join(dist, "wardrobe/index.html"), "utf8");
    expect(list).toMatch(/rel="modulepreload"/);
  });

  test("no _headers: GitHub Pages ignores them, the service worker does the job", () => {
    expect(existsSync(join(dist, "_headers"))).toBe(false);
    expect(existsSync(join(dist, "sw.js"))).toBe(true);
    expect(existsSync(join(dist, "404.html"))).toBe(true);
  });
});
