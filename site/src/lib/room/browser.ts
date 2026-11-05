/**
 * The catalogue column. Items and Sets are the same browser over two catalogues
 * (UiMorph.cpp), and this is plain DOM rather than a React tree on purpose: it is
 * the one part of the page a pointer sweeps across at full speed.
 *
 * The grid is virtual (grid/virtual.ts), of figure cells only: baked posters on retail's
 * cards, and the one the pointer rests on comes alive, on the body on the stage.
 */
import { POSTER, itemOfRow, packUrl, paths, posterFor, sheetFor, sheetRect, type ItemEntry, type ItemManifest, type ItemShard, type ItemShardRef, type LineInfo, type SetEntry, type SlotId } from "@eclipse/format";
import { art, PACK_BASE } from "../base";
import { FillQueue, type DrawPoster } from "../grid/fill";
import { CARD, FRAME, fitPage } from "../grid/fit";
import { LiveCell } from "../grid/live";
import { Fling, VirtualRows, canUseSheets, justTouched, pointerIntent, setImage } from "../grid/virtual";
import { hideTip, showTip } from "../tip";
import { ARMOR_SLOTS, SLOT_LABEL } from "../slots";
import { release, setSlot, wear, wearSet } from "./actions";
import { hover, onStageFree, stageBusy, stageLanded } from "./hover";
import { $loading } from "@eclipse/engine/stores";
import { $body, $catalogState, $engine, $items, $mounts, $sets, $slot, $tab, $worn } from "./state";

type Cell =
  | { kind: "hide"; slot: SlotId }
  | { kind: "item"; item: ItemEntry }
  | { kind: "set"; set: SetEntry };

interface TileEl extends HTMLButtonElement {
  cell?: Cell;
  poster: HTMLImageElement;
  label: HTMLElement;
}
interface RowEl extends HTMLDivElement {
  tiles: TileEl[];
}

const EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m5.6 18.4 12.8-12.8"/></svg>`;
const STAR = `<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-linejoin="round"><path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.5l-5.5 3 1-6.3L3 9.7l6.2-.9z"/></svg>`;

const scroller = document.getElementById("grid-scroll") as HTMLElement;
const space = document.getElementById("grid-space") as HTMLElement;
const emptyBox = document.getElementById("grid-empty") as HTMLElement;
const countEl = document.getElementById("count") as HTMLElement;
const fadeTop = document.getElementById("fade-top") as HTMLElement;
const fadeBot = document.getElementById("fade-bot") as HTMLElement;
const input = document.getElementById("q") as HTMLInputElement;
const clearBtn = document.getElementById("q-x") as HTMLButtonElement;
const linesEl = document.getElementById("lines") as HTMLElement;
const chipsEl = document.getElementById("chips") as HTMLElement;
const facetsEl = document.getElementById("facets") as HTMLElement;

// --- Filters ----------------------------------------------------------------
const STARS_KEY = "starred";
let stars = new Set<string>();
try { stars = new Set(JSON.parse(localStorage.getItem(STARS_KEY) || "[]")); } catch { /* private window */ }
const saveStars = () => { try { localStorage.setItem(STARS_KEY, JSON.stringify([...stars])); } catch { /* private window */ } };

let line = "";
let query = "";
// The catalogue, by shard: a line's rows for a slot load when somebody opens them.
let shardRefs: ItemShardRef[] = [];
let setRefs: { line: string; key: string; count: number }[] = [];
let lineInfo: LineInfo[] = [];
const shardRows = new Map<string, ItemEntry[]>();
const shardsLoading = new Set<string>();
const setRows = new Map<string, SetEntry[]>();
let waitingForShard = false;
const shardMode = () => shardRefs.length > 0 || setRefs.length > 0;
/** The two hands take anything; the ranged slot keeps its own list (UiMorph.cpp IsHandSlot). */
const HANDS: SlotId[] = ["mainhand", "offhand", "ranged"];
const slotsOf = (slot: SlotId): SlotId[] => (slot === "mainhand" || slot === "offhand" ? HANDS : [slot]);
/** Where a row goes when worn: a hand keeps what it is given. */
const wornSlot = (item: ItemEntry): SlotId => {
  const s = $slot.get();
  return s === "mainhand" || s === "offhand" ? s : item.slot;
};

async function loadShard(ref: ItemShardRef) {
  if (shardRows.has(ref.key) || shardsLoading.has(ref.key)) return;
  shardsLoading.add(ref.key);
  try {
    const res = await fetch(packUrl(PACK_BASE, ref.key));
    if (!res.ok) throw new Error(String(res.status));
    const shard = await res.json() as ItemShard;
    const rows = shard.rows.map((r, i) => itemOfRow(r, shard.line, shard.slot, i, shard.sheets));
    for (const i of rows) if (!itemsById.has(i.id)) itemsById.set(i.id, i);
    shardRows.set(ref.key, rows);
    $items.set(rows);
    refresh(true);
  } catch {
    $catalogState.set("error");
  } finally {
    shardsLoading.delete(ref.key);
  }
}

async function loadSets(ref: { line: string; key: string }) {
  if (setRows.has(ref.line) || shardsLoading.has(ref.key)) return;
  shardsLoading.add(ref.key);
  try {
    const res = await fetch(packUrl(PACK_BASE, ref.key));
    if (!res.ok) throw new Error(String(res.status));
    const list = await res.json() as SetEntry[];
    setRows.set(ref.line, list);
    for (const s of list) {
      for (const [slot, id] of Object.entries(s.pieces)) {
        if (id && !pieceInfo.has(id)) pieceInfo.set(id, { name: s.names?.[slot as SlotId] ?? "", icon: s.icons?.[slot as SlotId] ?? "" });
      }
    }
    refresh(true);
  } catch {
    $catalogState.set("error");
  } finally {
    shardsLoading.delete(ref.key);
  }
}
let favOnly = false;
const materials = new Set<string>();

const folded = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const itemName = new WeakMap<object, string>();
const nameOf = (e: { name: string }) => {
  let n = itemName.get(e);
  if (n === undefined) { n = folded(e.name); itemName.set(e, n); }
  return n;
};
let bySlot = new Map<SlotId, ItemEntry[]>();

function indexItems(items: ItemEntry[]) {
  bySlot = new Map();
  for (const it of items) {
    const list = bySlot.get(it.slot);
    if (list) list.push(it); else bySlot.set(it.slot, [it]);
  }
}

function shardList(slot: SlotId): ItemEntry[] {
  const out: ItemEntry[] = [];
  const seen = new Set<string>();
  for (const s of slotsOf(slot)) {
    const ref = shardRefs.find((r) => r.line === line && r.slot === s);
    if (!ref) continue;
    const rows = shardRows.get(ref.key);
    if (!rows) {
      waitingForShard = true;
      void loadShard(ref);
      continue;
    }
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

function computeCells(): { cells: Cell[]; count: number } {
  const q = folded(query.trim());
  const match = (e: { name: string; line?: string }) => (!line || e.line === line) && (!q || nameOf(e).includes(q));
  waitingForShard = false;
  if ($tab.get() === "sets") {
    if (setRefs.length) {
      const ref = setRefs.find((r) => r.line === line);
      if (ref && !setRows.has(line)) {
        waitingForShard = true;
        void loadSets(ref);
      }
      const sets = (setRows.get(line) ?? []).filter(match);
      return { cells: sets.map((set) => ({ kind: "set", set })), count: sets.length };
    }
    const sets = $sets.get().filter(match);
    return { cells: sets.map((set) => ({ kind: "set", set })), count: sets.length };
  }
  if (!shardMode() && !$items.get().length) return { cells: [], count: 0 };
  const slot = $slot.get();
  const body = $body.get();
  let list = (shardMode() ? shardList(slot) : bySlot.get(slot) ?? []).filter((i) => match(i) && !i.notOn?.includes(body));
  if (materials.size && ARMOR_SLOTS.has(slot)) list = list.filter((i) => materials.has(i.facet ?? ""));
  if (favOnly) list = list.filter((i) => stars.has(i.id));
  // Star a thing and it sorts to the front. Stable, so the catalogue's order holds otherwise.
  const front = list.filter((i) => stars.has(i.id));
  if (front.length && !favOnly) list = [...front, ...list.filter((i) => !stars.has(i.id))];
  return { cells: [{ kind: "hide", slot }, ...list.map((item): Cell => ({ kind: "item", item }))], count: list.length };
}

// --- The virtual grid ---------------------------------------------------------
let cells: Cell[] = [];
let perRow = 1;
const setsTab = () => $tab.get() === "sets";

const LIVE_AFTER_STAGE_MS = 400;
/** The cell the pointer rests on comes alive on this body, in the engine's one cell context. */
const live = new LiveCell(async () => {
  // The stage has the same things to load, and it comes first. The cell's first frame costs
  // half a second of the main thread (a second GL context, its own body), measured, so it
  // waits until the pointer has plainly stopped: a hover on the way past never pays for it.
  await stageLanded();
  await new Promise((r) => setTimeout(r, LIVE_AFTER_STAGE_MS));
  const engine = $engine.get();
  return engine?.addFigureCell ? engine.addFigureCell.bind(engine) : null;
});
/** A card with no baked poster yet: the engine draws the same picture, a few at a time, after the stage's own load. */
const fill = new FillQueue(
  (): DrawPoster | null => {
    const engine = $engine.get();
    if ($loading.get() || stageBusy()) return null;
    return engine?.figurePoster ? (spec, w, h) => engine.figurePoster(spec as never, w, h) : null;
  },
  3,
  // Nothing is drawn for a grid nobody is looking at, or one on the move.
  () => !fling.moving && gridShown(),
);
const gridShown = () => $tab.get() === "items" || $tab.get() === "sets";
const fling = new Fling(
  () => {
    for (const r of rows.rows()) for (const t of r.tiles) if (t.cell) bindPoster(t, t.cell);
    fill.pump();
    afterScroll();
  },
  () => {
    // The list is moving: nothing under the pointer is what the pointer went to.
    hover(null);
    live.leave();
    // What a settled page asked for on the way to the next hover hasn't got a socket yet: it can go.
    $engine.get()?.warmItems([], false);
  },
);

function newTile(): TileEl {
  const t = document.createElement("button") as TileEl;
  t.type = "button";
  t.className = "tile";
  t.innerHTML = `<span class="tile-plate"></span><img class="tile-poster" alt="" decoding="async" draggable="false" hidden><span class="tile-ring"></span><span class="tile-hide">${EYE_OFF}</span><span class="tile-name"></span><span class="tile-frame"></span><span class="tile-flash"></span><span class="tile-star" data-star>${STAR}</span>`;
  t.poster = t.children[1] as HTMLImageElement;
  t.label = t.children[4] as HTMLElement;
  return t;
}

function isWorn(cell: Cell): boolean {
  const worn = $worn.get();
  if (cell.kind === "item") return worn[wornSlot(cell.item)] === cell.item.id;
  if (cell.kind === "hide") return false;
  const pieces = Object.entries(cell.set.pieces);
  return pieces.length > 0 && pieces.every(([s, id]) => worn[s as SlotId] === id);
}

/** The baked poster for this body, or the same picture drawn here. Until it lands: the empty card, its quiet ring. */
function bindPoster(t: TileEl, cell: Cell) {
  fill.drop(t);
  t.classList.remove("no-picture");
  if (cell.kind === "hide") {
    setImage(t.poster, "");
    return;
  }
  const entry = cell.kind === "item" ? cell.item : cell.set;
  const bodyId = $body.get();
  // The page's sheet where there is one: one read for every card on it.
  const sheet = canUseSheets ? sheetFor(entry, bodyId) : undefined;
  const key = sheet ? `objects/${sheet[0]}.webp` : posterFor(entry, bodyId);
  const poster = key ? art(key) : "";
  // On the way past in a fling, a picture already there stays and a new one waits.
  if (fling.active) {
    if (t.poster.getAttribute("src") !== poster) setImage(t.poster, "");
    return;
  }
  if (poster) setImage(t.poster, poster, sheet ? sheetRect(sheet[1], cell.kind === "set" ? POSTER.set : POSTER.cell) : undefined);
  else drawPoster(t, cell, entry.id, bodyId);
}

function drawPoster(t: TileEl, cell: Exclude<Cell, { kind: "hide" }>, id: string, bodyId: string) {
  setImage(t.poster, "");
  const size = cell.kind === "set" ? POSTER.set : POSTER.cell;
  const spec = cell.kind === "item" ? { bodyId, itemId: cell.item.id } : { bodyId, pieces: cell.set.pieces };
  fill.ask(t, `${id}@${bodyId}`, spec, size.width, size.height, (url) => {
    if (t.cell !== cell) return;
    if (url) setImage(t.poster, url);
    else t.classList.add("no-picture");
  });
}

function bind(t: TileEl, cell: Cell | undefined) {
  live.leaveIf(t);
  fill.drop(t);
  t.cell = cell;
  if (!cell) {
    t.className = "tile";
    t.style.visibility = "hidden";
    setImage(t.poster, "");
    return;
  }
  t.style.visibility = "";
  let cls = "tile";
  t.label.textContent = "";
  if (cell.kind === "hide") {
    cls += " hide";
    t.label.textContent = "Hide";
    t.setAttribute("aria-label", "Hide");
  } else if (cell.kind === "item") {
    if (stars.has(cell.item.id)) cls += " fav";
    t.setAttribute("aria-label", cell.item.name);
  } else {
    cls += " set";
    t.label.textContent = cell.set.name;
    t.setAttribute("aria-label", cell.set.name);
  }
  if (isWorn(cell)) cls += " worn";
  t.className = cls;
  bindPoster(t, cell);
}

const itemsById = new Map<string, ItemEntry>();

const rows = new VirtualRows<RowEl>(
  () => {
    const r = document.createElement("div") as RowEl;
    r.className = "grid-row";
    r.tiles = [];
    space.appendChild(r);
    return r;
  },
  (r, index) => {
    while (r.tiles.length < perRow) {
      const t = newTile();
      r.tiles.push(t);
      r.appendChild(t);
    }
    for (let i = 0; i < r.tiles.length; i++) {
      const t = r.tiles[i]!;
      t.hidden = i >= perRow;
      bind(t, i < perRow ? cells[index * perRow + i] : undefined);
    }
  },
  (r) => {
    for (const t of r.tiles) bind(t, undefined);
  },
);

// On a phone the whole column scrolls under the sticky room, so the grid has no
// scroller of its own: it reads its place in the outer one.
const phone = matchMedia("(max-width: 767.98px)");
const split = document.getElementById("split") as HTMLElement;
function viewport() {
  if (!phone.matches) return { top: scroller.scrollTop, view: viewH };
  const outer = split.getBoundingClientRect();
  return { top: outer.top - space.getBoundingClientRect().top, view: outer.height };
}

/** The scroller's height and what it holds, as `layout` found them: a frame of scrolling measures nothing. */
let viewH = 0;
let contentH = 0;

function paint() {
  clearTimeout(warmTimer);
  warmTimer = window.setTimeout(warmPage, 400);
  const { top, view } = viewport();
  fling.moved(top, view);
  rows.paint(top, view);
  if (phone.matches) return;
  const max = contentH - view;
  fadeTop.classList.toggle("show", top > 1);
  fadeBot.classList.toggle("show", max > 1 && top < max - 1);
}

function layout() {
  const width = scroller.clientWidth;
  viewH = scroller.clientHeight;
  if (!width) return;
  const sets = setsTab();
  const k = sets ? CARD.setScale : 1;
  const frame = sets ? FRAME.set : FRAME.card;
  // A set is a whole figure with its name on it: two rows of them read better than three of slivers.
  const maxRows = sets ? CARD.setRows : CARD.rows;
  // A phone's column scrolls in the page, so what a page of cards fills is the room left under the stage.
  const height = phone.matches ? Math.max(360, innerHeight * 0.6) : scroller.clientHeight;
  const fit = (w: number, h: number) => fitPage(w, Math.max(1, h), CARD.w * k, CARD.h * k, CARD.gap * k, CARD.maxCells, maxRows);
  // A card's frame reaches past the card, and the scroller's edge would cut it off the first row.
  const over = Math.ceil(fit(width, height).cellW * frame.over);
  const page = fit(width - over * 2, height - over * 2);
  perRow = Math.max(1, page.cols);
  rows.pitch = page.cellH + page.gap;
  rows.offset = over;
  rows.overscan = 1;
  rows.rowCount = Math.ceil(cells.length / perRow);
  space.style.setProperty("--tile-w", `${page.cellW}px`);
  space.style.setProperty("--tile-h", `${page.cellH}px`);
  space.style.setProperty("--tile-gap", `${page.gap}px`);
  space.style.setProperty("--row-x", `${Math.floor((width - page.width) / 2)}px`);
  space.style.setProperty("--frame-over", `${page.cellW * frame.over}px`);
  space.style.setProperty("--frame-slice", `${page.cellW * frame.slice}px`);
  contentH = rows.height(page.gap);
  space.style.height = `${contentH}px`;
}

function rebuildAll() {
  rows.reset();
  layout();
  paint();
}

function setEmptyState() {
  const state = $catalogState.get();
  const sets = setsTab();
  const hasCatalogue = shardMode() ? lineInfo.length > 0 : sets ? $sets.get().length > 0 : $items.get().length > 0;
  const onlyHide = sets ? cells.length === 0 : cells.length <= 1;
  let title = "";
  let body = "";
  if (!onlyHide) {
    emptyBox.hidden = true;
    return;
  }
  if (state === "loading" || waitingForShard) {
    emptyBox.hidden = true;
    return;
  }
  if (state === "error") {
    title = "The catalogue didn't load";
    body = "Check your connection and reload the page.";
  } else if (!hasCatalogue) {
    title = sets ? "Sets are on their way" : "Items are on their way";
    body = "They show up here as soon as they are baked.";
  } else if (favOnly) {
    title = "Nothing starred here yet";
    body = "Turn off Starred to browse, then star your favourites.";
  } else if (query) {
    title = `No appearances match "${query}"`;
    body = "Clear the search or choose another slot.";
  } else if (materials.size) {
    title = "No appearances match these filters";
    body = "Turn a filter off to see more.";
  } else {
    title = "No appearances in this slot";
    body = "Try another slot.";
  }
  emptyBox.hidden = false;
  emptyBox.innerHTML = `<div class="notice"><div class="notice-title"></div><p class="notice-body"></p></div>`;
  emptyBox.querySelector(".notice-title")!.textContent = title;
  emptyBox.querySelector(".notice-body")!.textContent = body;
}

/** A new subject: filter, reset the scroll, repaint. */
export function refresh(keepScroll = false) {
  const { cells: next, count } = computeCells();
  cells = next;
  countEl.textContent = String(count);
  if (!keepScroll) scroller.scrollTop = 0;
  rebuildAll();
  setEmptyState();
  scroller.parentElement!.classList.toggle("grid-none", cells.length <= 1);
}

function refreshWorn() {
  for (const r of rows.rows()) {
    for (const t of r.tiles) {
      if (t.cell) t.classList.toggle("worn", isWorn(t.cell));
    }
  }
}

/** Live on a resting pointer, on whatever body is on the stage now: the poster was only a preview. */
function liveFor(t: TileEl, cell: Cell) {
  if (cell.kind === "hide") return live.leave();
  const bodyId = $body.get();
  live.enter(t, cell.kind === "item" ? { bodyId, itemId: cell.item.id } : { bodyId, setId: cell.set.id });
}

// --- Pointer: hover tries on, click wears --------------------------------------
const tileOf = (e: Event) => (e.target as Element).closest?.(".tile") as TileEl | null;

function hoverCell(cell: Cell | undefined) {
  if (!cell) return hover(null);
  if (cell.kind === "item") hover({ key: `i:${cell.item.id}`, pieces: [[wornSlot(cell.item), cell.item.id]], focus: wornSlot(cell.item) });
  else if (cell.kind === "set") {
    const pieces = Object.entries(cell.set.pieces) as [SlotId, string][];
    if (pieces.length) hover({ key: `s:${cell.set.id}`, pieces, focus: null });
    else hover(null);
  } else hover(null);
  warmAround(cell);
}

const piecesOf = (c: Cell | undefined): [SlotId, string][] =>
  !c || c.kind === "hide" ? [] : c.kind === "item" ? [[wornSlot(c.item), c.item.id]] : (Object.entries(c.set.pieces) as [SlotId, string][]);

/**
 * Where the pointer goes next is most likely beside where it is. An item's neighbours come
 * whole, so moving there shows them on the rest; a set is many items, so only the ones either
 * side and only their manifests, which is the first round trip a hover would wait for.
 */
function warmAround(cell: Cell) {
  const engine = $engine.get();
  if (!engine?.warmItems || (navigator as { connection?: { saveData?: boolean } }).connection?.saveData) return;
  const at = cells.indexOf(cell);
  if (at < 0) return;
  const near = cell.kind === "set" ? [at - 1, at + 1] : [at - 1, at + 1, at - perRow, at + perRow];
  const pieces = near.flatMap((i) => piecesOf(cells[i]));
  engine.warmItems(pieces, cell.kind !== "set");
  // The stage has what it wanted and the pointer stays: there is time for the sets beside it, whole.
  afterLanding = cell.kind === "set" ? () => engine.warmItems(pieces, true) : null;
}
let afterLanding: (() => void) | null = null;

let warmedPage = "";
let warmTimer = 0;
/** A page has settled, where there is a pointer: its manifests, so any first hover has one round trip less. */
function warmPage() {
  const engine = $engine.get();
  if (!engine?.warmItems || !matchMedia("(hover: hover)").matches || setsTab() || (navigator as { connection?: { saveData?: boolean } }).connection?.saveData) return;
  const shown = [...rows.rows()].flatMap((r) => r.tiles).filter((t) => t.cell?.kind === "item").map((t) => t.cell!);
  const key = shown.map((c) => (c as { item: ItemEntry }).item.id).join();
  if (key === warmedPage) return;
  warmedPage = key;
  engine.warmItems(shown.flatMap(piecesOf).slice(0, 36), false);
}

function tipFor(cell: Cell) {
  if (cell.kind === "hide") return showTip("Show nothing here", SLOT_LABEL[cell.slot]);
  if (cell.kind === "item") return showTip(cell.item.name, SLOT_LABEL[cell.item.slot], isWorn(cell) ? "Wearing" : undefined);
  const n = Object.keys(cell.set.pieces).length;
  return showTip(cell.set.name, `${n} piece${n === 1 ? "" : "s"}`, isWorn(cell) ? "Wearing" : undefined);
}

const afterScroll = pointerIntent(space, fling, (target) => {
  const t = target.closest<TileEl>(".tile");
  if (!t?.cell) {
    hover(null);
    hideTip();
    live.leave();
    return;
  }
  hoverCell(t.cell);
  liveFor(t, t.cell);
  if (target.closest("[data-star]")) {
    showTip(stars.has((t.cell as { item: ItemEntry }).item?.id ?? "") ? "Starred" : "Star this", "It sorts to the front.");
  } else tipFor(t.cell);
});
scroller.addEventListener("pointerleave", () => {
  hover(null);
  hideTip();
  live.leave();
});
space.addEventListener("click", (e) => {
  const t = tileOf(e);
  const cell = t?.cell;
  if (!t || !cell) return;
  if ((e.target as Element).closest("[data-star]") && cell.kind === "item") {
    if (stars.has(cell.item.id)) stars.delete(cell.item.id);
    else stars.add(cell.item.id);
    saveStars();
    t.classList.toggle("fav", stars.has(cell.item.id));
    return;
  }
  if (cell.kind === "hide") {
    void release(cell.slot);
    return;
  }
  if (cell.kind === "item") void wear(wornSlot(cell.item), cell.item.id);
  else if (Object.keys(cell.set.pieces).length) void wearSet(cell.set);
  t.classList.remove("saved");
  void t.offsetWidth;
  t.classList.add("saved");
});
// A picture arrives when it arrives: it fades in over a plate of fixed size, never pops.
space.addEventListener("load", (e) => {
  const img = e.target as HTMLImageElement;
  if (img.tagName === "IMG") img.dataset.ok = "1";
}, true);
// A poster that won't load: the page draws the same picture.
space.addEventListener("error", (e) => {
  const img = e.target as HTMLImageElement;
  const t = img.closest?.(".tile") as TileEl | null;
  const cell = t?.cell;
  if (!t || !cell || img !== t.poster || cell.kind === "hide") return;
  drawPoster(t, cell, cell.kind === "item" ? cell.item.id : cell.set.id, $body.get());
}, true);

let scrollQueued = false;
const onScroll = () => {
  fling.scrolled();
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    paint();
  });
};
scroller.addEventListener("scroll", onScroll, { passive: true });
split.addEventListener("scroll", onScroll, { passive: true });
new ResizeObserver(() => {
  const before = perRow;
  layout();
  if (perRow !== before) rebuildAll();
  else paint();
}).observe(scroller);

// --- Controls -----------------------------------------------------------------
input.addEventListener("input", () => {
  query = input.value;
  clearBtn.disabled = !query;
  refresh();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && input.value) {
    e.stopPropagation();
    input.value = "";
    query = "";
    clearBtn.disabled = true;
    refresh();
  }
});
clearBtn.addEventListener("click", () => {
  input.value = "";
  query = "";
  clearBtn.disabled = true;
  refresh();
  input.focus();
});
chipsEl.addEventListener("click", (e) => {
  const chip = (e.target as Element).closest<HTMLElement>("[data-chip]");
  if (chip) setSlot(chip.dataset.chip as SlotId);
});
facetsEl.addEventListener("click", (e) => {
  const chip = (e.target as Element).closest<HTMLElement>("[data-facet]");
  if (!chip) return;
  const f = chip.dataset.facet!;
  if (f === "starred") favOnly = !favOnly;
  else if (materials.has(f)) materials.delete(f);
  else materials.add(f);
  chip.classList.toggle("on", f === "starred" ? favOnly : materials.has(f));
  refresh();
});
linesEl.addEventListener("click", (e) => {
  const pill = (e.target as Element).closest<HTMLElement>("[data-line]");
  if (!pill) return;
  line = pill.dataset.line ?? "";
  for (const b of linesEl.querySelectorAll<HTMLElement>("[data-line]")) b.classList.toggle("on", b === pill);
  paintChips();
  refresh();
});
function paintLines() {
  if (shardMode()) {
    const sets = setsTab();
    const shown = lineInfo.filter((l) => (sets ? l.sets : l.items) > 0);
    if (!shown.some((l) => l.id === line)) line = shown[0]?.id ?? "";
    linesEl.innerHTML = shown.map((l) => `<button class="pill sm${line === l.id ? " on" : ""}" type="button" data-line="${l.id}">${l.title} (${(sets ? l.sets : l.items).toLocaleString("en-US")})</button>`).join("");
    paintChips();
    return;
  }
  const counts = new Map<string, number>();
  const list: { line?: string }[] = setsTab() ? $sets.get() : $items.get();
  for (const e of list) if (e.line) counts.set(e.line, (counts.get(e.line) ?? 0) + 1);
  const label = (id: string) => id.replace(/(^|-|_)(\w)/g, (_, s, c) => (s ? " " : "") + c.toUpperCase()).replace("Warwithin", "War Within");
  const pills = [
    `<button class="pill sm${line === "" ? " on" : ""}" type="button" data-line="">All (${list.length})</button>`,
    ...(counts.size > 1 ? [...counts].map(([id, n]) => `<button class="pill sm${line === id ? " on" : ""}" type="button" data-line="${id}">${label(id)} (${n})</button>`) : []),
  ];
  linesEl.innerHTML = pills.join("");
}

/** The chips can show now, with their room kept: only the chips that exist move, unseen. */
function revealChips() {
  const room = document.getElementById("room")!;
  if (!("chipsWait" in room.dataset)) return;
  chipsEl.style.minHeight = `${chipsEl.offsetHeight}px`;
  facetsEl.style.minHeight = `${facetsEl.offsetHeight}px`;
  paintChips();
  delete room.dataset.chipsWait;
}

/** A chip shows only what exists for this line. */
function paintChips() {
  if (!shardMode()) return;
  const has = new Set(shardRefs.filter((r) => r.line === line).map((r) => r.slot));
  for (const chip of chipsEl.querySelectorAll<HTMLElement>("[data-chip]")) {
    chip.hidden = !slotsOf(chip.dataset.chip as SlotId).some((s) => has.has(s));
  }
  paintFacets();
}

function paintFacets() {
  const slot = $slot.get();
  const armor = ARMOR_SLOTS.has(slot);
  const facets = shardMode() ? new Set(shardRefs.filter((r) => r.line === line && r.slot === slot).flatMap((r) => r.facets)) : null;
  for (const c of facetsEl.querySelectorAll<HTMLButtonElement>("[data-armor]")) {
    c.hidden = !armor || (facets !== null && !facets.has(c.dataset.facet ?? ""));
  }
}

/** Fetched once per page. Its absence is a clean empty state, not an error on screen. */
export async function loadCatalog() {
  try {
    const res = await fetch(packUrl(PACK_BASE, paths.catalog()));
    if (res.status === 404) {
      revealChips();
      $catalogState.set("ready");
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json() as { items?: ItemEntry[]; sets?: SetEntry[]; mounts?: unknown[]; itemShards?: ItemShardRef[]; setShards?: { line: string; key: string; count: number }[]; lines?: LineInfo[] };
    shardRefs = data.itemShards ?? [];
    setRefs = data.setShards ?? [];
    lineInfo = data.lines ?? [];
    if (shardMode()) line = lineInfo[0]?.id ?? "";
    const items = (data.items ?? []).filter((i) => i.slot);
    for (const i of items) itemsById.set(i.id, i);
    indexItems(items);
    $items.set(items);
    $sets.set(data.sets ?? []);
    $mounts.set((data.mounts ?? []) as never);
    revealChips();
    $catalogState.set("ready");
  } catch {
    revealChips();
    $catalogState.set("error");
  }
}

export function findItem(id: string): ItemEntry | undefined {
  return itemsById.get(id);
}

const pieceInfo = new Map<string, { name: string; icon: string }>();
const asked = new Set<string>();

/**
 * What the ring needs of a worn item: its name and icon, from a loaded shard or set, else
 * from the item's own manifest, which the engine is fetching anyway.
 */
export function itemInfo(id: string): { name: string; icon: string } | undefined {
  const known = itemsById.get(id) ?? pieceInfo.get(id);
  if (known) return known;
  if (shardMode() && !asked.has(id)) {
    asked.add(id);
    void fetch(packUrl(PACK_BASE, paths.item(id)))
      .then((r) => (r.ok ? (r.json() as Promise<ItemManifest>) : null))
      .then((m) => {
        if (!m) return;
        pieceInfo.set(id, { name: m.name ?? "", icon: m.icon ?? "" });
        $items.set([...$items.get()]);
      })
      .catch(() => undefined);
  }
  return undefined;
}

/** A `?try=` link: an item is worn in its own slot, a set whole. */
export async function tryLink(id: string): Promise<void> {
  if (!shardMode()) {
    const it = findItem(id);
    if (it) {
      setSlot(it.slot);
      void wear(it.slot, it.id);
      return;
    }
    const set = findSet(id);
    if (set) void wearSet(set);
    return;
  }
  if (id.startsWith("item-")) {
    const res = await fetch(packUrl(PACK_BASE, paths.item(id)));
    if (!res.ok) return;
    const m = await res.json() as ItemManifest;
    setSlot(m.slot);
    void wear(m.slot, id);
    return;
  }
  for (const ref of setRefs) {
    if (!setRows.has(ref.line)) {
      const res = await fetch(packUrl(PACK_BASE, ref.key));
      if (res.ok) setRows.set(ref.line, await res.json() as SetEntry[]);
    }
    const set = setRows.get(ref.line)?.find((s) => s.id === id);
    if (set) {
      void wearSet(set);
      return;
    }
  }
}

export function findSet(id: string): SetEntry | undefined {
  for (const list of setRows.values()) {
    const hit = list.find((s) => s.id === id);
    if (hit) return hit;
  }
  return $sets.get().find((s) => s.id === id);
}

export function startBrowser() {
  paintFacets();
  $slot.subscribe(() => {
    materials.clear();
    for (const c of facetsEl.querySelectorAll<HTMLElement>("[data-armor]")) c.classList.remove("on");
    paintFacets();
    if (!setsTab() || !shardMode()) refresh();
  });
  $tab.listen(() => {
    paintLines();
    requestAnimationFrame(() => refresh());
  });
  $worn.listen(refreshWorn);
  // What a body cannot wear is hidden on that body, and its posters are that body's sex.
  $body.listen(() => refresh(true));
  // The engine draws what isn't baked, once it is here and the stage has what it came for.
  $engine.listen((engine) => {
    engine?.holdCells(() => fling.moving || !gridShown() || justTouched());
    setTimeout(() => fill.pump(), 0);
  });
  $loading.listen((on) => { if (!on) fill.pump(); });
  onStageFree(() => {
    fill.pump();
    afterLanding?.();
    afterLanding = null;
  });
  $catalogState.listen(() => {
    paintLines();
    refresh();
  });
}
