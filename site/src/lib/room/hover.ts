/**
 * Hover tries on, as DrawMorphTab does it: a resting pointer commits after
 * kHoverRestSec, and leaving waits kHoverClearSec, so moving between tiles does
 * not flash the figure back to what it was wearing.
 */
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

function commit() {
  const engine = $engine.get();
  const prev = shown;
  shown = pending;
  if (!engine) return;
  const next = new Set(shown?.pieces.map(([s]) => s));
  for (const [slot] of prev?.pieces ?? []) {
    if (!next.has(slot)) void engine.previewEquip(slot, null);
  }
  for (const [slot, id] of shown?.pieces ?? []) void engine.previewEquip(slot, id);
  engine.focusSlot(shown ? shown.focus : null);
}

export function hover(target: HoverTarget | null) {
  if ((target?.key ?? null) === (pending?.key ?? null)) return;
  pending = target;
  clearTimeout(timer);
  timer = window.setTimeout(commit, target ? HOVER_REST_MS : HOVER_CLEAR_MS);
}

/** A tab change or a reset ends the preview at once. */
export function endHover() {
  clearTimeout(timer);
  pending = null;
  commit();
}

/** The click landed: the slot is worn now, so the preview must not take it away again. */
export function settled(slot: SlotId, id: string) {
  const engine = $engine.get();
  if (shown?.pieces.some(([s, i]) => s === slot && i === id)) {
    shown = { ...shown, pieces: shown.pieces.filter(([s]) => s !== slot) };
    void engine?.previewEquip(slot, null);
  }
}
