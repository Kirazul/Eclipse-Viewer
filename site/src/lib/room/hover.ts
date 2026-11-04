/**
 * Hover tries on, as DrawMorphTab does it: a resting pointer commits after
 * kHoverRestSec, and leaving waits kHoverClearSec, so moving between tiles does
 * not flash the figure back to what it was wearing.
 */
import { $loading } from "@eclipse/engine/stores";
import type { SlotId } from "@eclipse/format";
import { $engine } from "./state";

export const HOVER_REST_MS = 110;
export const HOVER_CLEAR_MS = 1500;

export interface HoverTarget {
  key: string;
  pieces: [SlotId, string][];
  /** The body region to look at; null steps back to the whole figure. */
  focus: SlotId | null;
}

let pending: HoverTarget | null = null;
let shown: HoverTarget | null = null;
let timer = 0;
/** Settles when the stage shows the newest preview. */
let landed: Promise<unknown> = Promise.resolve();
let busy = 0;
/** The last time the pointer reached something new. */
let movedAt = -Infinity;
/** How long a pointer must have stayed put before the grid draws anything of its own. */
const CALM_MS = 1000;

/**
 * The stage comes first. A grid's own drawing (the live cell, a poster not baked yet) would
 * load and decode the same things in a second GL context while the stage waits for them.
 */
export const stageLanded = () => landed;
let free: (() => void) | null = null;
let calmTimer = 0;
/** Called when the stage has nothing left to load for a preview. */
export function onStageFree(fn: () => void) {
  free = fn;
}
function calmLater() {
  movedAt = performance.now();
  clearTimeout(calmTimer);
  calmTimer = window.setTimeout(() => {
    if (!stageBusy()) free?.();
  }, CALM_MS + 10);
}
/** A wear on its way: the grid's own drawing waits for this as it does for a preview. */
export function stageWork<T>(work: Promise<T>): Promise<T> {
  busy++;
  calmLater();
  return work.finally(() => {
    busy--;
    calmLater();
  });
}
export const stageBusy = () => busy > 0 || (pending !== null && pending !== shown) || performance.now() - movedAt < CALM_MS;

function commit() {
  const engine = $engine.get();
  const prev = shown;
  shown = pending;
  if (!engine) return;
  const next = new Set(shown?.pieces.map(([s]) => s));
  const asks: Promise<unknown>[] = [];
  for (const [slot] of prev?.pieces ?? []) {
    if (!next.has(slot)) asks.push(engine.previewEquip(slot, null));
  }
  for (const [slot, id] of shown?.pieces ?? []) asks.push(engine.previewEquip(slot, id));
  engine.focusSlot(shown ? shown.focus : null);
  busy++;
  landed = Promise.all(asks).finally(() => {
    if (--busy === 0 && !stageBusy()) free?.();
  });
}

// The stage finished loading under a resting pointer: what it couldn't try on then, it does now.
$loading.listen((on) => {
  if (!on && shown) commit();
});

export function hover(target: HoverTarget | null) {
  if ((target?.key ?? null) === (pending?.key ?? null)) return;
  pending = target;
  calmLater();
  clearTimeout(timer);
  // Starts now, and the rest only says when it shows: by the click most of it has landed.
  // Leaving a tile for nothing keeps it going: the pointer often comes straight back.
  if (target) $engine.get()?.prefetchEquip(target.pieces);
  timer = window.setTimeout(commit, target ? HOVER_REST_MS : HOVER_CLEAR_MS);
}

/** A tab change or a reset ends the preview at once. */
export function endHover() {
  clearTimeout(timer);
  pending = null;
  // No preview up: nothing to end, and the camera stays where it is.
  if (shown) commit();
}

/** The click landed: the slot is worn now, so the preview must not take it away again. */
export function settled(slot: SlotId, id: string) {
  const engine = $engine.get();
  if (shown?.pieces.some(([s, i]) => s === slot && i === id)) {
    shown = { ...shown, pieces: shown.pieces.filter(([s]) => s !== slot) };
    void engine?.previewEquip(slot, null);
  }
}
