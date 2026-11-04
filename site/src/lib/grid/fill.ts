/**
 * A card whose poster isn't baked yet still fills. The engine draws the very picture the
 * baker would, a few at a time, top of the page first, and hands it over as an image: the page
 * never sits empty and nothing keeps running once a card has its picture. When the bake
 * reaches an entry, its poster takes over and this asks for nothing.
 */
export interface PosterRequest {
  bodyId?: string;
  itemId?: string;
  setId?: string;
  pieces?: Record<string, string | undefined>;
}

export type DrawPoster = (spec: PosterRequest, width: number, height: number) => Promise<string | null>;

interface Ask {
  el: HTMLElement;
  key: string;
  spec: PosterRequest;
  width: number;
  height: number;
}

const KEPT = 400;

export class FillQueue {
  private readonly done = new Map<string, string | null>();
  private readonly waiting: Ask[] = [];
  private readonly wanted = new Map<HTMLElement, { key: string; give(url: string | null): void }>();
  private readonly running = new Set<string>();

  /** `drawer` answers null until it can draw at all: `pump` starts the queue when it can. */
  constructor(
    private readonly drawer: () => DrawPoster | null | Promise<DrawPoster | null>,
    private readonly limit = 3,
  ) {}

  /** The card wants this picture. `give` hears the image, or null when it can't be drawn. */
  ask(el: HTMLElement, key: string, spec: PosterRequest, width: number, height: number, give: (url: string | null) => void): void {
    this.drop(el);
    const hit = this.done.get(key);
    if (hit !== undefined) {
      // Most recently used goes last.
      this.done.delete(key);
      this.done.set(key, hit);
      give(hit);
      return;
    }
    this.wanted.set(el, { key, give });
    if (!this.running.has(key)) this.waiting.push({ el, key, spec, width, height });
    this.pump();
  }

  /** The card scrolled away, or is something else now. */
  drop(el: HTMLElement): void {
    if (!this.wanted.delete(el)) return;
    const i = this.waiting.findIndex((a) => a.el === el);
    if (i >= 0) this.waiting.splice(i, 1);
  }

  pump(): void {
    while (this.running.size < this.limit && this.waiting.length) {
      const ask = this.waiting.shift()!;
      this.running.add(ask.key);
      void this.draw(ask);
    }
  }

  private async draw(ask: Ask): Promise<void> {
    let drawer: DrawPoster | null = null;
    try {
      drawer = await this.drawer();
    } catch {
      drawer = async () => null;
    }
    if (!drawer) {
      // Not yet: it goes back, and whoever calls `pump` next starts it.
      this.running.delete(ask.key);
      this.waiting.unshift(ask);
      return;
    }
    let url: string | null = null;
    try {
      url = await drawer(ask.spec, ask.width, ask.height);
    } catch (e) {
      console.warn("[eclipse] no picture for", ask.key, e);
    }
    this.running.delete(ask.key);
    this.remember(ask.key, url);
    for (const [el, w] of this.wanted) {
      if (w.key !== ask.key) continue;
      this.wanted.delete(el);
      w.give(url);
    }
    // A breath between pictures: the page gets a frame in.
    setTimeout(() => this.pump(), 0);
  }

  private remember(key: string, url: string | null): void {
    this.done.set(key, url);
    if (this.done.size <= KEPT) return;
    for (const [old, value] of this.done) {
      this.done.delete(old);
      if (value) URL.revokeObjectURL(value);
      break;
    }
  }
}
