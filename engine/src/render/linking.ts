/**
 * Shaders link in the background, and nothing stalls the page for them.
 *
 * `compileAsync` only gets half of it. The GPU process links in parallel, but the first
 * question anybody asks about a linked program waits for it, 45 to 130 ms each, measured on a
 * real card, and three asks in the first draw that uses it: several programs at once add up to
 * one long stall of the main thread. So they are asked here, one to a task, with the page's
 * input and frames between them.
 *
 * And a program stays once linked. Without that a figure's disposal frees its programs and the
 * next model links them again: 83 links in 21 posters. A model's shaders are a short list of
 * combiners, so what is kept stays small.
 */
import type { WebGLRenderer } from "three";

interface Linked {
  usedTimes: number;
  getUniforms(): unknown;
  getAttributes(): unknown;
}

const keptBy = new WeakMap<WebGLRenderer, WeakSet<object>>();

/** The next task, after whatever input and frames are waiting. */
export const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * `start` calls compileAsync (more than once if it likes, each under its own render target).
 * `turn` runs each question when the page has a moment: by default, the next task.
 */
export async function linkInBackground(
  renderer: WebGLRenderer,
  start: () => Promise<unknown>,
  turn: (work: () => Promise<void>) => Promise<void> = async (work) => {
    await nextTask();
    await work();
  },
): Promise<void> {
  const done = start();
  let kept = keptBy.get(renderer);
  if (!kept) keptBy.set(renderer, (kept = new WeakSet()));
  const fresh: Linked[] = [];
  for (const p of renderer.info.programs ?? []) {
    if (kept.has(p)) continue;
    kept.add(p);
    const linked = p as unknown as Linked;
    linked.usedTimes++;
    fresh.push(linked);
  }
  await done;
  for (const p of fresh) {
    await turn(async () => {
      p.getUniforms();
      p.getAttributes();
    });
  }
}
