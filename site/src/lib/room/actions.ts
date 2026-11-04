import type { SetEntry, SlotId } from "@eclipse/format";
import { ALL_SLOTS } from "../slots";
import { endHover, settled } from "./hover";
import { $body, $engine, $geosets, $slot, $tab, $worn, type Tab } from "./state";

/** Clicking is the whole gesture: no confirm step, nothing locked. */
export async function wear(slot: SlotId, id: string) {
  $worn.set({ ...$worn.get(), [slot]: id });
  await $engine.get()?.equip(slot, id);
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
  await Promise.all(ALL_SLOTS.map((s) => engine?.equip(s, set.pieces[s] ?? null)));
  for (const [s, id] of Object.entries(set.pieces)) settled(s as SlotId, id);
}

export async function resetLook() {
  endHover();
  const engine = $engine.get();
  const worn = Object.keys($worn.get()) as SlotId[];
  $worn.set({});
  $geosets.set({});
  await Promise.all(worn.map((s) => engine?.equip(s, null)));
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

/** The old body stays on screen until the new one is ready; the engine promises that. */
export async function setBody(id: string) {
  if (id === $body.get()) return;
  $body.set(id);
  $geosets.set({});
  const engine = $engine.get();
  if (!engine) return;
  await engine.loadModel(id);
  await Promise.all(Object.entries($worn.get()).map(([s, item]) => engine.equip(s as SlotId, item ?? null)));
}
