import type { SetEntry, SlotId } from "@eclipse/format";
import { $loaded, clearPickedMounts } from "../share/state";
import { ALL_SLOTS } from "../slots";
import { endHover, settled, stageWork } from "./hover";
import { $body, $engine, $lookText, $slot, $tab, $worn, type Tab } from "./state";

/** Clicking is the whole gesture: no confirm step, nothing locked. */
export async function wear(slot: SlotId, id: string) {
  $worn.set({ ...$worn.get(), [slot]: id });
  await stageWork(Promise.resolve($engine.get()?.equip(slot, id)));
  settled(slot, id);
}

export async function release(slot: SlotId) {
  const next = { ...$worn.get() };
  delete next[slot];
  $worn.set(next);
  await $engine.get()?.equip(slot, null);
}

/** A set replaces the whole look, as retail's does. */
export async function wearSet(set: SetEntry) {
  const engine = $engine.get();
  $worn.set({ ...set.pieces });
  await stageWork(Promise.all(ALL_SLOTS.map((s) => engine?.equip(s, set.pieces[s] ?? null))));
  for (const [s, id] of Object.entries(set.pieces)) settled(s as SlotId, id);
}

export async function resetLook() {
  endHover();
  $loaded.set(null);
  clearPickedMounts();
  const engine = $engine.get();
  $worn.set({});
  await Promise.all(ALL_SLOTS.map((s) => engine?.equip(s, null)));
  engine?.focusSlot(null);
}

export function setTab(tab: Tab) {
  if ($tab.get() === tab) return;
  endHover();
  $tab.set(tab);
}

export function setSlot(slot: SlotId) {
  $slot.set(slot);
}

/** Each body keeps the look it last wore here, as Eclipse's picker does. */
const looks = new Map<string, string>();

/**
 * The old body stays on screen until the new one is ready; the engine promises that.
 * `lookText`: the look moves with it, for a posture, whose two bodies offer one tree.
 */
export async function setBody(id: string, lookText?: string) {
  const from = $body.get();
  if (id === from) return;
  looks.set(from, $lookText.get());
  const text = lookText ?? looks.get(id) ?? "";
  $body.set(id);
  $lookText.set(text);
  const engine = $engine.get();
  if (!engine) return;
  await engine.loadModel(id, text || undefined);
  const worn = $worn.get();
  await Promise.all(ALL_SLOTS.map((s) => engine.equip(s, worn[s] ?? null)));
}
