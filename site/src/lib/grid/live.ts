/**
 * The poster comes alive under a resting pointer. One live cell at a time, in one shared
 * WebGL context whose canvas stands inside the card: it scrolls with the card and cannot draw
 * outside it. It takes over after a rest, the poster stays until its first frame has drawn,
 * and leaving hands back in one step. Nothing runs when no pointer rests.
 */
export const LIVE_REST_MS = 150;

export interface LiveOptions {
  bodyId?: string;
  itemId?: string;
  setId?: string;
  effects?: boolean;
  inCell?: boolean;
  onDrawn?: () => void;
  onFailed?: (err: unknown) => void;
}
export type AddCell = (el: HTMLElement, opts: LiveOptions) => () => void;

const calm = () => !matchMedia("(prefers-reduced-motion: reduce)").matches;

export class LiveCell {
  private el: HTMLElement | null = null;
  private timer = 0;
  private drop: (() => void) | null = null;

  constructor(private readonly adder: () => AddCell | null | Promise<AddCell | null>) {}

  enter(el: HTMLElement, opts: LiveOptions): void {
    if (this.el === el) return;
    this.leave();
    if (!calm()) return;
    this.el = el;
    this.timer = window.setTimeout(async () => {
      const add = await this.adder();
      if (this.el !== el || !add) return;
      this.drop = add(el, {
        ...opts,
        effects: true,
        inCell: true,
        // In the frame the canvas has its first picture: no frame shows neither.
        onDrawn: () => {
          if (this.el === el) el.classList.add("live");
        },
      });
    }, LIVE_REST_MS);
  }

  /** The poster is back first, and the canvas clears after it, in one task: both land on the same frame. */
  leave(): void {
    clearTimeout(this.timer);
    this.el?.classList.remove("live");
    this.el = null;
    this.drop?.();
    this.drop = null;
  }

  /** A recycled row must not carry the live cell away with it. */
  leaveIf(el: HTMLElement): void {
    if (this.el === el) this.leave();
  }
}
