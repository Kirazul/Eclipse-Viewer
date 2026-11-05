/**
 * The Mounts page: a card per animal, with its poster, on Eclipse's figure grid. The rows
 * come from `catalog/mounts.json` on the client, so a new bake needs no new page. Browsing
 * loads pictures and nothing else: no engine and no model until a pointer rests on a card,
 * or a card has no baked poster yet, and only for that one, in the one context the page makes.
 */
import { POSTER, packUrl, paths, sheetRect, type MountEntry } from "@eclipse/format";
import { art, PACK_BASE, u } from "../base";
import { FillQueue, type DrawPoster } from "../grid/fill";
import { CARD, FRAME, fitPage } from "../grid/fit";
import { LiveCell, type AddCell } from "../grid/live";
import { Fling, VirtualRows, canUseSheets, justTouched, pointerIntent, setImage } from "../grid/virtual";

const scroller = document.getElementById("mount-scroll") as HTMLElement;
const space = document.getElementById("mount-grid") as HTMLElement;
const emptyBox = document.getElementById("mount-empty") as HTMLElement;
const fadeTop = document.getElementById("mount-fade-top") as HTMLElement;
const fadeBot = document.getElementById("mount-fade-bot") as HTMLElement;
const input = document.getElementById("mount-q") as HTMLInputElement;
const countEl = document.getElementById("mount-count") as HTMLElement;
const chips = document.getElementById("mount-chips") as HTMLElement;
/** Two lines of name under every card, whatever the name: nothing below it ever moves. */
const LABEL = 38;
const SCROLL_KEY = "mounts-scroll";

interface Card extends HTMLAnchorElement {
  mount?: MountEntry;
  poster: HTMLImageElement;
  badge: HTMLElement;
  label: HTMLElement;
}
interface Row extends HTMLDivElement {
  cards: Card[];
}

let all: MountEntry[] = [];
let shown: MountEntry[] = [];
let category = "all";
let perRow = 1;
/** Characters of a name that fit under a card, on its two lines. */
let nameRoom = 40;

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const folded = new WeakMap<MountEntry, string>();
function haystack(m: MountEntry): string {
  let h = folded.get(m);
  if (h === undefined) {
    h = fold([m.name, ...m.variants.map((v) => v.name)].join("\n"));
    folded.set(m, h);
  }
  return h;
}

function newCard(): Card {
  const a = document.createElement("a") as Card;
  a.className = "tile";
  a.innerHTML = `<span class="tile-plate"></span><img class="tile-poster" alt="" decoding="async" draggable="false" hidden><span class="tile-ring"></span><span class="tile-frame"></span><span class="tile-badge"></span><span class="tile-name"></span>`;
  a.poster = a.children[1] as HTMLImageElement;
  a.badge = a.children[4] as HTMLElement;
  a.label = a.children[5] as HTMLElement;
  return a;
}

function bindCard(a: Card, m: MountEntry | undefined) {
  live.leaveIf(a);
  fill.drop(a);
  a.mount = m;
  a.classList.remove("no-picture");
  if (!m) {
    a.style.visibility = "hidden";
    a.removeAttribute("href");
    delete a.dataset.mount;
    setImage(a.poster, "");
    return;
  }
  a.style.visibility = "";
  a.href = `${u("mounts/view/")}?id=${encodeURIComponent(m.id)}`;
  a.dataset.mount = m.id;
  a.label.textContent = m.name;
  a.setAttribute("aria-label", m.name);
  // The name stands under the card: a tip only says what the card can't.
  const colours = m.variants.length;
  if (m.name.length > nameRoom || colours > 1) a.dataset.tip = m.name;
  else delete a.dataset.tip;
  if (colours > 1) a.dataset.tipSub = `${colours} colours`;
  else delete a.dataset.tipSub;
  a.badge.hidden = colours < 2;
  a.badge.textContent = colours > 1 ? String(colours) : "";
  paintArt(a, m);
}

/** The baked poster, or the same picture drawn here. Until it lands: the empty card, its quiet ring. */
function paintArt(a: Card, m: MountEntry) {
  // The page's sheet where there is one: one read for every card on it.
  const sheet = canUseSheets ? m.sheet : undefined;
  const key = sheet ? `objects/${sheet[0]}.webp` : m.poster;
  const poster = key ? art(key) : "";
  if (fling.active) {
    if (a.poster.getAttribute("src") !== poster) setImage(a.poster, "");
    return;
  }
  if (poster) {
    setImage(a.poster, poster, sheet ? sheetRect(sheet[1], POSTER.cell) : undefined);
    return;
  }
  const v = m.variants[0];
  if (!v) return;
  fill.ask(a, v.id, { bodyId: v.id }, POSTER.cell.width, POSTER.cell.height, (url) => {
    if (a.mount !== m) return;
    if (url) setImage(a.poster, url);
    else a.classList.add("no-picture");
  });
}

const fling = new Fling(
  () => {
    for (const r of rows.rows()) for (const a of r.cards) if (a.mount) paintArt(a, a.mount);
    fill.pump();
    afterScroll();
  },
  () => live.leave(),
);

const rows = new VirtualRows<Row>(
  () => {
    const r = document.createElement("div") as Row;
    r.className = "grid-row";
    r.cards = [];
    space.appendChild(r);
    return r;
  },
  (r, index) => {
    while (r.cards.length < perRow) {
      const a = newCard();
      r.cards.push(a);
      r.appendChild(a);
    }
    r.cards.forEach((a, i) => {
      a.hidden = i >= perRow;
      bindCard(a, i < perRow ? shown[index * perRow + i] : undefined);
    });
  },
  (r) => {
    for (const a of r.cards) bindCard(a, undefined);
  },
);

/** The scroller's height and what it holds, as `layout` found them: a frame of scrolling measures nothing. */
let viewH = 0;
let contentH = 0;

function layout(): boolean {
  const width = scroller.clientWidth;
  const height = scroller.clientHeight;
  viewH = height;
  if (!width || !height) return false;
  // FitPage knows nothing of a name under the card, so the rows' names come off the height
  // first. A tile that only fits fewer rows than asked just leaves the difference spare.
  const scaleGuess = fitPage(width, Math.max(1, height - CARD.rows * LABEL), CARD.w, CARD.h, CARD.gap, CARD.maxCells, CARD.rows);
  const over = Math.ceil(scaleGuess.cellW * FRAME.card.over);
  const page = fitPage(width - over * 2, Math.max(1, height - over * 2 - CARD.rows * LABEL), CARD.w, CARD.h, CARD.gap, CARD.maxCells, CARD.rows);
  const before = perRow;
  perRow = Math.max(1, page.cols);
  rows.pitch = page.cellH + LABEL + page.gap;
  rows.offset = over;
  rows.overscan = 1;
  rows.rowCount = Math.ceil(shown.length / perRow);
  space.style.setProperty("--tile-w", `${page.cellW}px`);
  space.style.setProperty("--tile-h", `${page.cellH}px`);
  space.style.setProperty("--tile-gap", `${page.gap}px`);
  space.style.setProperty("--row-x", `${Math.floor((width - page.width) / 2)}px`);
  space.style.setProperty("--frame-over", `${page.cellW * FRAME.card.over}px`);
  space.style.setProperty("--frame-slice", `${page.cellW * FRAME.card.slice}px`);
  contentH = rows.height(page.gap);
  space.style.height = `${contentH}px`;
  nameRoom = Math.floor((2 * (page.cellW + 16)) / 6.4);
  return perRow !== before;
}

function paint() {
  const top = scroller.scrollTop;
  const view = viewH;
  fling.moved(top, view);
  rows.paint(top, view);
  const max = contentH - view;
  fadeTop.classList.toggle("show", top > 1);
  fadeBot.classList.toggle("show", max > 1 && top < max - 1);
}

function render(keepScroll = false) {
  const q = fold(input.value.trim());
  shown = all.filter((m) => {
    if (q && !haystack(m).includes(q)) return false;
    if (category === "ground") return !m.flying;
    if (category === "flying") return m.flying;
    return true;
  });
  countEl.textContent = shown.length.toLocaleString("en-US");
  if (!keepScroll) scroller.scrollTop = 0;
  live.leave();
  rows.reset();
  layout();
  paint();
  emptyBox.hidden = shown.length > 0 || !loaded;
  if (!emptyBox.hidden) {
    emptyBox.innerHTML = `<div class="notice"><div class="notice-title"></div><p class="notice-body"></p></div>`;
    emptyBox.querySelector(".notice-title")!.textContent = all.length ? "No mounts match" : "Mounts are on their way";
    emptyBox.querySelector(".notice-body")!.textContent = all.length ? "Clear the search or choose another filter." : "They show up here as soon as they are baked.";
  }
}

// --- The live cell --------------------------------------------------------------
// The engine's cells are their own chunk: this page only ever asks for them on a rest.
let cells: Promise<{ add: AddCell; draw: DrawPoster } | null> | null = null;
function theCells() {
  cells ??= import("@eclipse/engine/cells")
    .then(({ FigureCells }) => {
      const made = new FigureCells(PACK_BASE);
      made.hold = () => fling.moving || justTouched();
      return { add: made.add.bind(made) as AddCell, draw: made.posterUrl.bind(made) as DrawPoster };
    })
    .catch((e) => {
      // No WebGL or no chunk: the posters are the page, and that is a good page.
      console.warn("[eclipse] no live cells:", e);
      return null;
    });
  return cells;
}
const live = new LiveCell(async () => (await theCells())?.add ?? null);
const fill = new FillQueue(async () => (await theCells())?.draw ?? (async () => null), 3, () => !fling.moving);

const afterScroll = pointerIntent(space, fling, (target) => {
  const a = target.closest<Card>(".tile");
  const v = a?.mount?.variants[0];
  if (!a || !v) {
    live.leave();
    return;
  }
  live.enter(a, { bodyId: v.id });
});
scroller.addEventListener("pointerleave", () => live.leave());
space.addEventListener("load", (e) => {
  const img = e.target as HTMLImageElement;
  if (img.tagName === "IMG") img.dataset.ok = "1";
}, true);
// A poster that won't load: the page draws the same picture.
space.addEventListener("error", (e) => {
  const img = e.target as HTMLImageElement;
  const a = img.closest?.(".tile") as Card | null;
  if (img.tagName !== "IMG" || !a?.mount || img !== a.poster) return;
  const v = a.mount.variants[0];
  setImage(a.poster, "");
  if (!v) return;
  fill.ask(a, v.id, { bodyId: v.id }, POSTER.cell.width, POSTER.cell.height, (url) => {
    if (url) setImage(a.poster, url);
    else a.classList.add("no-picture");
  });
}, true);
// Back from a stage: the list is where it was left.
space.addEventListener("click", () => {
  try { sessionStorage.setItem(SCROLL_KEY, String(scroller.scrollTop)); } catch { /* private window */ }
});

// --- Scrolling and the rest -----------------------------------------------------
let queued = false;
scroller.addEventListener("scroll", () => {
  fling.scrolled();
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    paint();
  });
}, { passive: true });
new ResizeObserver(() => {
  if (layout()) rows.reset();
  paint();
}).observe(scroller);

input.addEventListener("input", () => render());
chips.addEventListener("click", (e) => {
  const c = (e.target as Element).closest<HTMLElement>("[data-cat]");
  if (!c) return;
  category = c.dataset.cat!;
  for (const b of chips.querySelectorAll<HTMLElement>("[data-cat]")) b.classList.toggle("on", b === c);
  render();
});

let loaded = false;
fetch(packUrl(PACK_BASE, paths.mounts()))
  .then((r) => (r.ok ? (r.json() as Promise<MountEntry[]>) : []))
  .catch(() => [] as MountEntry[])
  .then((list) => {
    all = list;
    loaded = true;
    render();
    try {
      const at = Number(sessionStorage.getItem(SCROLL_KEY));
      if (at > 0) {
        sessionStorage.removeItem(SCROLL_KEY);
        scroller.scrollTop = at;
      }
    } catch { /* private window */ }
  });
