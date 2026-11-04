/**
 * A grid that is virtual. Rows live at fixed offsets inside a fixed-height space, so a
 * tile's position is arithmetic, nothing ever measures its neighbours, and forty thousand
 * entries cost what the visible rows cost. Rows are recycled, never rebuilt.
 */
export class VirtualRows<R extends HTMLElement> {
  private readonly active = new Map<number, R>();
  private readonly pool: R[] = [];
  /** A row's height and the space under it. */
  pitch = 1;
  rowCount = 0;
  overscan = 0;
  /** Past the top of the space: a card's frame reaches above the first row. */
  offset = 0;

  constructor(
    private readonly make: () => R,
    private readonly bind: (row: R, index: number) => void,
    private readonly unbind: (row: R) => void,
  ) {}

  /** Puts the rows this view shows in place. Rows that stay are not touched at all. */
  paint(top: number, view: number): void {
    const first = Math.max(0, Math.floor((top - this.offset) / this.pitch) - this.overscan);
    const last = Math.min(this.rowCount - 1, Math.floor((top - this.offset + view) / this.pitch) + this.overscan);
    for (const [i, r] of this.active) {
      if (i < first || i > last) {
        this.unbind(r);
        r.hidden = true;
        this.pool.push(r);
        this.active.delete(i);
      }
    }
    for (let i = first; i <= last; i++) {
      if (this.active.has(i)) continue;
      const r = this.pool.pop() ?? this.make();
      this.bind(r, i);
      r.style.transform = `translateY(${this.offset + i * this.pitch}px)`;
      r.hidden = false;
      this.active.set(i, r);
    }
  }

  /** Everything goes back in the pool, for a list or a layout that changed. */
  reset(): void {
    for (const [, r] of this.active) {
      this.unbind(r);
      r.hidden = true;
      this.pool.push(r);
    }
    this.active.clear();
  }

  rows(): IterableIterator<R> {
    return this.active.values();
  }

  /** The height of the whole space. */
  height(gap: number): number {
    return this.rowCount > 0 ? this.rowCount * this.pitch - gap + this.offset * 2 : 0;
  }
}

/**
 * A fling across a long list asks for no posters on the way: on a slow line those are
 * bytes for pictures nobody saw. Faster than a view per frame counts as a fling, and
 * `settled` runs when it stops, for the rows that stayed.
 */
export class Fling {
  private last = 0;
  private timer = 0;
  active = false;

  constructor(private readonly settled: () => void) {}

  moved(top: number, view: number): void {
    const jump = Math.abs(top - this.last);
    this.last = top;
    if (jump > view) this.active = true;
    if (!this.active) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.active = false;
      this.settled();
    }, 120);
  }
}

/** A picture goes in without a flash: it fades over its plate when it has landed. */
export function setImage(img: HTMLImageElement, url: string): void {
  if (!url) {
    if (img.hasAttribute("src")) img.removeAttribute("src");
    delete img.dataset.ok;
    img.hidden = true;
    return;
  }
  img.hidden = false;
  if (img.getAttribute("src") === url) return;
  delete img.dataset.ok;
  img.src = url;
  if (img.complete && img.naturalWidth) img.dataset.ok = "1";
}
