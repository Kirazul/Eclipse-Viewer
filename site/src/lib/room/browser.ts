/**
 * The catalogue column. Items and Sets are the same browser over two catalogues
 * (UiMorph.cpp), and this is plain DOM rather than a React tree on purpose: it is
 * the one part of the page a pointer sweeps across at full speed.
 *
 * The grid is virtual. Rows live at fixed offsets inside a fixed-height space, so
 * a tile's position is arithmetic, nothing ever measures its neighbours, and
 * thousands of entries cost what the visible rows cost.
 */
import { packUrl, paths, type ItemEntry, type SetEntry, type SlotId } from "@eclipse/format";
import { art, PACK_BASE } from "../base";
import { hideTip, showTip } from "../tip";
import { ARMOR_SLOTS, SLOT_LABEL, emptySprite } from "../slots";
import { release, setSlot, wear, wearSet } from "./actions";
import { hover } from "./hover";
import { $body, $catalogState, $engine, $gridMode, $items, $mounts, $sets, $slot, $tab, $worn } from "./state";

// UiMorph.cpp: kBoard, kBoardPad. Figures: fig::kCellUnitsW/H at 1.33 px per unit.
const BOARD = 76;
const BOARD_PAD = 10;
const FIG_W = 104;
const FIG_H = 138;
const FIG_SET_SCALE = 1.2;

type Cell =
  | { kind: "hide"; slot: SlotId }
  | { kind: "item"; item: ItemEntry }
  | { kind: "set"; set: SetEntry };

interface TileEl extends HTMLButtonElement {
  cell?: Cell;
  dropFigure?: () => void;
  ico: HTMLElement;
  img: HTMLImageElement;
  label: HTMLElement;
  extra: HTMLElement;
}
interface RowEl extends HTMLDivElement {
  tiles: TileEl[];
  rowIndex: number;
}

const EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m5.6 18.4 12.8-12.8"/></svg>`;
const STAR = `<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-linejoin="round"><path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.5l-5.5 3 1-6.3L3 9.7l6.2-.9z"/></svg>`;
const SET_GLYPH = `<svg viewBox="0 0 26 22" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="24" height="5.5" rx="1.5"/><rect x="1" y="8.25" width="24" height="5.5" rx="1.5"/><rect x="1" y="15.5" width="24" height="5.5" rx="1.5"/></svg>`;

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

function computeCells(): { cells: Cell[]; count: number } {
  const q = folded(query.trim());
  const match = (e: { name: string; line?: string }) => (!line || e.line === line) && (!q || nameOf(e).includes(q));
  if ($tab.get() === "sets") {
    const sets = $sets.get().filter(match);
    return { cells: sets.map((set) => ({ kind: "set", set })), count: sets.length };
  }
  if (!$items.get().length) return { cells: [], count: 0 };
  const slot = $slot.get();
  let list = (bySlot.get(slot) ?? []).filter(match);
  if (materials.size && ARMOR_SLOTS.has(slot)) list = list.filter((i) => materials.has(i.facet ?? ""));
  if (favOnly) list = list.filter((i) => stars.has(i.id));
  // Star a thing and it sorts to the front. Stable, so the catalogue's order holds otherwise.
  const front = list.filter((i) => stars.has(i.id));
  if (front.length && !favOnly) list = [...front, ...list.filter((i) => !stars.has(i.id))];
  return { cells: [{ kind: "hide", slot }, ...list.map((item): Cell => ({ kind: "item", item }))], count: list.length };
}

// --- The virtual grid ---------------------------------------------------------
let cells: Cell[] = [];
let tileW = BOARD;
let tileH = BOARD;
let pad = BOARD_PAD;
let pitch = BOARD + BOARD_PAD;
let perRow = 1;
let rowCount = 0;
const active = new Map<number, RowEl>();
const pool: RowEl[] = [];
let overscan = 3;
const iconSet = () => $tab.get() === "sets";

function newTile(): TileEl {
  const t = document.createElement("button") as TileEl;
  t.type = "button";
  t.className = "tile";
  t.innerHTML = `<span class="tile-plate"></span><span class="tile-ico"><img alt="" width="62" height="62" decoding="async" draggable="false"></span><span class="tile-x"></span><span class="tile-name"></span><span class="tile-frame"></span><span class="tile-flash"></span><span class="tile-star" data-star>${STAR}</span>`;
  t.ico = t.children[1] as HTMLElement;
  t.img = t.ico.firstChild as HTMLImageElement;
  t.extra = t.children[2] as HTMLElement;
  t.label = t.children[3] as HTMLElement;
  return t;
}

function setArt(t: TileEl, url: string) {
  const img = t.img;
  if (!url) {
    t.ico.hidden = true;
    img.removeAttribute("src");
    return;
  }
  t.ico.hidden = false;
  if (img.getAttribute("src") === url) return;
  img.removeAttribute("data-ok");
  img.src = url;
  if (img.complete && img.naturalWidth) img.dataset.ok = "1";
}

function isWorn(cell: Cell): boolean {
  const worn = $worn.get();
  if (cell.kind === "item") return worn[cell.item.slot] === cell.item.id;
  if (cell.kind === "hide") return false;
  const pieces = Object.entries(cell.set.pieces);
  return pieces.length > 0 && pieces.every(([s, id]) => worn[s as SlotId] === id);
}

function bind(t: TileEl, cell: Cell | undefined) {
  t.dropFigure?.();
  t.dropFigure = undefined;
  t.cell = cell;
  if (!cell) {
    t.style.visibility = "hidden";
    return;
  }
  t.style.visibility = "";
  const figures = $gridMode.get() === "figures";
  let cls = "tile";
  t.extra.className = "tile-x";
  t.extra.innerHTML = "";
  t.extra.style.backgroundImage = "";
  t.label.textContent = "";
  if (cell.kind === "hide") {
    cls += " hide";
    setArt(t, "");
    t.extra.className = "tile-hide";
    t.extra.innerHTML = EYE_OFF;
    t.label.textContent = "Hide";
  } else if (cell.kind === "item") {
    if (figures) cls += " figure";
    if (stars.has(cell.item.id)) cls += " fav";
    setArt(t, figures ? "" : cell.item.icon ? art(cell.item.icon) : "");
    if (!figures && !cell.item.icon) {
      t.extra.className = "tile-glyph";
      t.extra.style.backgroundImage = `var(--sp-${emptySprite(cell.item.slot)})`;
      t.label.textContent = cell.item.name;
    }
  } else {
    cls += " set";
    if (figures) cls += " figure";
    setArt(t, "");
    t.label.textContent = cell.set.name;
    if (!figures) paintSetIcons(t, cell.set);
  }
  if (figures && cell.kind !== "hide") {
    t.extra.className = "tile-load spin";
    addFigure(t, cell);
  }
  if (isWorn(cell)) cls += " worn";
  t.className = cls;
}

const itemsById = new Map<string, ItemEntry>();

function paintSetIcons(t: TileEl, set: SetEntry) {
  const icons = Object.values(set.pieces).map((id) => itemsById.get(id ?? "")?.icon).filter(Boolean).slice(0, 9) as string[];
  if (!icons.length) {
    t.extra.className = "tile-setglyph";
    t.extra.innerHTML = SET_GLYPH;
    return;
  }
  t.extra.className = "tile-pieces";
  t.extra.style.setProperty("--cols", icons.length <= 4 ? "2" : "3");
  t.extra.innerHTML = icons.map((k) => `<img src="${art(k)}" alt="" decoding="async" draggable="false">`).join("");
}

function addFigure(t: TileEl, cell: Exclude<Cell, { kind: "hide" }>) {
  const engine = $engine.get();
  if (!engine?.addFigureCell) return;
  const bodyId = $body.get();
  t.dropFigure = engine.addFigureCell(t, cell.kind === "item" ? { bodyId, itemId: cell.item.id } : { bodyId, setId: cell.set.id });
}

function newRow(): RowEl {
  const r = document.createElement("div") as RowEl;
  r.className = "grid-row";
  r.tiles = [];
  space.appendChild(r);
  return r;
}

function bindRow(r: RowEl, index: number) {
  r.rowIndex = index;
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
  r.style.transform = `translateY(${index * pitch}px)`;
  r.hidden = false;
}

function unbindRow(r: RowEl) {
  for (const t of r.tiles) bind(t, undefined);
  r.hidden = true;
}

// On a phone the whole column scrolls under the sticky room, so the grid has no
// scroller of its own: it reads its place in the outer one.
const phone = matchMedia("(max-width: 767.98px)");
const split = document.getElementById("split") as HTMLElement;
function viewport() {
  if (!phone.matches) return { top: scroller.scrollTop, view: scroller.clientHeight };
  const outer = split.getBoundingClientRect();
  return { top: outer.top - space.getBoundingClientRect().top, view: outer.height };
}

function paint() {
  const { top, view } = viewport();
  const first = Math.max(0, Math.floor(top / pitch) - overscan);
  const last = Math.min(rowCount - 1, Math.floor((top + view) / pitch) + overscan);
  for (const [i, r] of active) {
    if (i < first || i > last) {
      unbindRow(r);
      pool.push(r);
      active.delete(i);
    }
  }
  for (let i = first; i <= last; i++) {
    if (active.has(i)) continue;
    const r = pool.pop() ?? newRow();
    bindRow(r, i);
    active.set(i, r);
  }
  if (phone.matches) return;
  const max = scroller.scrollHeight - view;
  fadeTop.classList.toggle("show", top > 1);
  fadeBot.classList.toggle("show", max > 1 && top < max - 1);
}

function layout() {
  const width = scroller.clientWidth;
  if (!width) return;
  const figures = $gridMode.get() === "figures";
  const scale = figures && iconSet() ? FIG_SET_SCALE : 1;
  tileW = figures ? Math.round(FIG_W * scale) : BOARD;
  tileH = figures ? Math.round(FIG_H * scale) : BOARD;
  pad = BOARD_PAD;
  pitch = tileH + pad;
  overscan = figures ? 0 : 3;
  perRow = Math.max(1, Math.floor((width + pad) / (tileW + pad)));
  rowCount = Math.ceil(cells.length / perRow);
  space.style.setProperty("--tile-w", `${tileW}px`);
  space.style.setProperty("--tile-h", `${tileH}px`);
  space.style.setProperty("--tile-gap", `${pad}px`);
  space.style.height = `${Math.max(0, rowCount * pitch - pad)}px`;
}

function rebuildAll() {
  for (const [, r] of active) {
    unbindRow(r);
    pool.push(r);
  }
  active.clear();
  layout();
  paint();
}

function setEmptyState() {
  const state = $catalogState.get();
  const sets = iconSet();
  const hasCatalogue = sets ? $sets.get().length > 0 : $items.get().length > 0;
  const onlyHide = sets ? cells.length === 0 : cells.length <= 1;
  let title = "";
  let body = "";
  if (!onlyHide) {
    emptyBox.hidden = true;
    return;
  }
  if (state === "loading") {
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
  for (const [, r] of active) {
    for (const t of r.tiles) {
      if (t.cell) t.classList.toggle("worn", isWorn(t.cell));
    }
  }
}

// --- Pointer: hover tries on, click wears --------------------------------------
const tileOf = (e: Event) => (e.target as Element).closest?.(".tile") as TileEl | null;

function hoverCell(cell: Cell | undefined) {
  if (!cell) return hover(null);
  if (cell.kind === "item") hover({ key: `i:${cell.item.id}`, pieces: [[cell.item.slot, cell.item.id]], focus: cell.item.slot });
  else if (cell.kind === "set") {
    const pieces = Object.entries(cell.set.pieces) as [SlotId, string][];
    if (pieces.length) hover({ key: `s:${cell.set.id}`, pieces, focus: null });
    else hover(null);
  } else hover(null);
}

function tipFor(cell: Cell) {
  if (cell.kind === "hide") return showTip("Show nothing here", SLOT_LABEL[cell.slot]);
  if (cell.kind === "item") return showTip(cell.item.name, SLOT_LABEL[cell.item.slot], isWorn(cell) ? "Wearing" : undefined);
  const n = Object.keys(cell.set.pieces).length;
  return showTip(cell.set.name, `${n} piece${n === 1 ? "" : "s"}`, isWorn(cell) ? "Wearing" : undefined);
}

space.addEventListener("pointerover", (e) => {
  if (e.pointerType === "touch") return;
  const t = tileOf(e);
  if (!t?.cell) {
    hover(null);
    hideTip();
    return;
  }
  hoverCell(t.cell);
  if ((e.target as Element).closest("[data-star]")) {
    showTip(stars.has((t.cell as { item: ItemEntry }).item?.id ?? "") ? "Starred" : "Star this", "It sorts to the front.");
  } else tipFor(t.cell);
});
scroller.addEventListener("pointerleave", () => {
  hover(null);
  hideTip();
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
  if (cell.kind === "item") void wear(cell.item.slot, cell.item.id);
  else if (Object.keys(cell.set.pieces).length) void wearSet(cell.set);
  t.classList.remove("saved");
  void t.offsetWidth;
  t.classList.add("saved");
});
// The icon arrives when it arrives: it fades in over a plate of fixed size, never pops.
space.addEventListener("load", (e) => {
  const img = e.target as HTMLImageElement;
  if (img.tagName === "IMG") img.dataset.ok = "1";
}, true);

let scrollQueued = false;
const onScroll = () => {
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
  refresh();
});
document.getElementById("room")!.addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-grid-mode]");
  if (!b) return;
  const mode = b.dataset.gridMode as "icons" | "figures";
  $gridMode.set(mode);
  try { localStorage.setItem("grid-mode", mode); } catch { /* private window */ }
  for (const m of document.querySelectorAll<HTMLElement>("[data-grid-mode]")) m.classList.toggle("on", m === b);
  refresh();
});

function paintLines() {
  const counts = new Map<string, number>();
  const list: { line?: string }[] = iconSet() ? $sets.get() : $items.get();
  for (const e of list) if (e.line) counts.set(e.line, (counts.get(e.line) ?? 0) + 1);
  const label = (id: string) => id.replace(/(^|-|_)(\w)/g, (_, s, c) => (s ? " " : "") + c.toUpperCase()).replace("Warwithin", "War Within");
  const pills = [
    `<button class="pill sm${line === "" ? " on" : ""}" type="button" data-line="">All (${list.length})</button>`,
    ...(counts.size > 1 ? [...counts].map(([id, n]) => `<button class="pill sm${line === id ? " on" : ""}" type="button" data-line="${id}">${label(id)} (${n})</button>`) : []),
  ];
  linesEl.innerHTML = pills.join("");
}

function paintFacets() {
  const armor = ARMOR_SLOTS.has($slot.get());
  for (const c of facetsEl.querySelectorAll<HTMLButtonElement>("[data-armor]")) c.hidden = !armor;
}

/** Fetched once per page. Its absence is a clean empty state, not an error on screen. */
export async function loadCatalog() {
  try {
    const res = await fetch(packUrl(PACK_BASE, paths.catalog()));
    if (res.status === 404) {
      $catalogState.set("ready");
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json() as { items?: ItemEntry[]; sets?: SetEntry[]; mounts?: unknown[] };
    const items = (data.items ?? []).filter((i) => i.slot);
    for (const i of items) itemsById.set(i.id, i);
    indexItems(items);
    $items.set(items);
    $sets.set(data.sets ?? []);
    $mounts.set((data.mounts ?? []) as never);
    $catalogState.set("ready");
  } catch {
    $catalogState.set("error");
  }
}

export function findItem(id: string): ItemEntry | undefined {
  return itemsById.get(id);
}

export function findSet(id: string): SetEntry | undefined {
  return $sets.get().find((s) => s.id === id);
}

export function startBrowser() {
  paintFacets();
  $slot.subscribe(() => {
    materials.clear();
    for (const c of facetsEl.querySelectorAll<HTMLElement>("[data-armor]")) c.classList.remove("on");
    paintFacets();
    refresh();
  });
  $tab.listen(() => {
    paintLines();
    requestAnimationFrame(() => refresh());
  });
  $worn.listen(refreshWorn);
  $catalogState.listen(() => {
    paintLines();
    refresh();
  });
  // A figure cell asks the engine, which may arrive after the first paint of the grid.
  $engine.listen(() => { if ($gridMode.get() === "figures") refresh(true); });
}
