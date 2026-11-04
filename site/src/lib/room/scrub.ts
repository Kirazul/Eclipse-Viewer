/**
 * The scrubbers, written from one requestAnimationFrame with no React render.
 * Each frame is a compare: the value is only touched when it moved.
 */
import { $engine } from "./state";

interface Scrub {
  input: HTMLInputElement;
  held: boolean;
  last: number;
}
const scrubs = new Set<Scrub>();
let running = false;

function tick() {
  if (!scrubs.size || document.hidden) {
    running = false;
    return;
  }
  const engine = $engine.get();
  if (engine) {
    const duration = engine.getAnimationDuration();
    const v = duration > 0 ? engine.getCurrentAnimationTime() / duration : 0;
    for (const s of scrubs) {
      if (s.held || Math.abs(v - s.last) < 0.0005) continue;
      s.last = v;
      s.input.value = String(v);
      s.input.style.setProperty("--p", v.toFixed(4));
    }
  }
  requestAnimationFrame(tick);
}

function start() {
  if (running) return;
  running = true;
  requestAnimationFrame(tick);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) start(); });

/** Returns the detach function. */
export function attachScrub(input: HTMLInputElement): () => void {
  const s: Scrub = { input, held: false, last: -1 };
  scrubs.add(s);
  const onInput = () => {
    const engine = $engine.get();
    if (!engine) return;
    const v = Number(input.value);
    input.style.setProperty("--p", v.toFixed(4));
    engine.setAnimationTime(v * engine.getAnimationDuration());
  };
  const hold = () => { s.held = true; };
  const free = () => { s.held = false; s.last = -1; };
  input.addEventListener("input", onInput);
  input.addEventListener("pointerdown", hold);
  input.addEventListener("pointerup", free);
  input.addEventListener("pointercancel", free);
  start();
  return () => {
    scrubs.delete(s);
    input.removeEventListener("input", onInput);
    input.removeEventListener("pointerdown", hold);
    input.removeEventListener("pointerup", free);
    input.removeEventListener("pointercancel", free);
  };
}
