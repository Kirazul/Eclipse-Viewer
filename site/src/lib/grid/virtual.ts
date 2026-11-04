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

/** How long after its last move a scroll counts as over. */
const SCROLL_END_MS = 120;
/** Over a view in this long is passing things by, at any frame rate. */
const PASSING_MS_PER_VIEW = 500;

/**
 * A scroll is about the grid and nothing else. While one runs nothing is drawn or woken, and
 * until it proves slow, `active`, no poster is asked for: on a slow line those are bytes for
 * pictures nobody saw. `settled` runs when it stops, for the rows that stayed.
 */
export class Fling {
  private lastTop = 0;
  private lastAt = 0;
  private timer = 0;
  /** Passing things by, as far as anyone knows yet. */
  active = false;
  /** Moved a moment ago. */
  moving = false;
  /** False from a scroll until the pointer really moves: until then, what is under it came to it. */
  handMoved = true;

  constructor(
    private readonly settled: () => void,
    private readonly started: () => void = () => undefined,
  ) {}

  /** From the scroll event itself: the first one tells everything else to let go at once. */
  scrolled(): void {
    if (!this.moving) {
      this.moving = true;
      this.active = true;
      this.handMoved = false;
      this.started();
    }
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.moving = false;
      this.active = false;
      this.settled();
    }, SCROLL_END_MS);
  }

  /** From the frame that paints it, with how far it went. */
  moved(top: number, view: number): void {
    const now = performance.now();
    const jump = Math.abs(top - this.lastTop);
    const dt = now - this.lastAt;
    this.lastTop = top;
    this.lastAt = now;
    // A list changing under its own layout moved nothing: only a scroll says how fast.
    if (!this.moving || jump === 0 || dt >= 200) return;
    this.active = jump > view || jump / Math.max(1, dt) > view / PASSING_MS_PER_VIEW;
  }
}

/**
 * A card takes the pointer when the pointer goes to it, never when the list brings it there:
 * the browser sends a pointerover for whatever scrolls under a resting pointer, and a try-on
 * from that is a try-on nobody asked for. Returns what to call when a scroll ends: a pointer
 * that really moved during it has gone to whatever it is over now.
 */
export function pointerIntent(space: HTMLElement, fling: Fling, enter: (target: Element) => void): () => void {
  let x = -1;
  let y = -1;
  space.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "touch" && fling.handMoved) enter(e.target as Element);
  });
  // On the scroller: a moving list takes no pointer itself.
  (space.parentElement ?? space).addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType === "touch") return;
      // The browser's own move after a scroll stays where the pointer was.
      const still = e.clientX === x && e.clientY === y;
      x = e.clientX;
      y = e.clientY;
      if (fling.handMoved || still) return;
      fling.handMoved = true;
      if (!fling.moving) enter(e.target as Element);
    },
    { passive: true },
  );
  return () => {
    if (!fling.handMoved || x < 0) return;
    const el = document.elementFromPoint(x, y);
    if (el && space.contains(el)) enter(el);
  };
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
