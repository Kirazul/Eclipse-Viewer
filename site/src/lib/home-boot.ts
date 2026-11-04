/**
 * The home page's live preview. The engine is imported only after the page has
 * painted and gone idle, so the hero never holds back the first paint, and it is
 * lite: one model, its default clip, nothing else fetched.
 */
import { PACK_BASE } from "./base";

const canvas = document.getElementById("homepage-canvas") as HTMLCanvasElement | null;
const model = canvas?.dataset.model;

async function boot() {
  if (!canvas || !model) return;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return;
  const { createEngine } = await import("@eclipse/engine");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const engine = await createEngine({
    packBase: PACK_BASE,
    interactable: false,
    lite: true,
    animated: !reduced,
    shadow: true,
    shortcuts: false,
    lockCamera: true,
  });
  await engine.mount(canvas);
  await engine.loadModel(model);
  requestAnimationFrame(() => canvas.classList.add("ready"));
}

const idle = (window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
const start = () => { boot().catch(() => { /* The hero is decoration: no model, no canvas, no error. */ }); };
if (idle) idle(start, { timeout: 1200 });
else setTimeout(start, 200);
