/**
 * TEST DOUBLE for the engine's cells, as engine-stub.ts is for the engine: the Mounts page
 * can be proven without WebGL or packs. Its first frame lands on the next animation frame.
 */
const win = window as Window & { __figures?: Set<HTMLElement>; __posterAsks?: number; __postersDrawing?: number; __postersPeak?: number };
win.__figures ??= new Set();

export class FigureCells {
  hold: () => boolean = () => false;
  constructor(_base: string) {}

  async posterUrl(): Promise<string | null> {
    win.__posterAsks = (win.__posterAsks ?? 0) + 1;
    win.__postersDrawing = (win.__postersDrawing ?? 0) + 1;
    win.__postersPeak = Math.max(win.__postersPeak ?? 0, win.__postersDrawing);
    await new Promise((r) => setTimeout(r, 40));
    win.__postersDrawing--;
    return "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
  }

  add(el: HTMLElement, opts: { onDrawn?: () => void }): () => void {
    win.__figures!.add(el);
    const frame = requestAnimationFrame(() => opts.onDrawn?.());
    return () => {
      cancelAnimationFrame(frame);
      win.__figures!.delete(el);
    };
  }
}
