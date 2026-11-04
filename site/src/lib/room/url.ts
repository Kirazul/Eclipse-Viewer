/**
 * The look lives in the URL, so a link is the outfit:
 *   /wardrobe/?body=human-male&look=head:123,chest:456&clip=4.0&tab=viewer
 * Everything is read on the client: GitHub Pages has no server to read it.
 */
import { $currentClip } from "@eclipse/engine/stores";
import type { SlotId } from "@eclipse/format";
import { u } from "../base";
import { isSlot } from "../slots";
import { $body, $geosets, $scene, $slot, $tab, $worn, DEFAULT_SCENE, TABS, type Tab } from "./state";

export interface RoomUrl {
  body: string | null;
  tab: Tab | null;
  slot: SlotId | null;
  look: Partial<Record<SlotId, string>>;
  clip: string | null;
  geo: Record<number, number>;
  scene: string | null;
  tryItem: string | null;
}

export function readUrl(): RoomUrl {
  const q = new URLSearchParams(location.search);
  const look: RoomUrl["look"] = {};
  for (const part of (q.get("look") ?? "").split(",")) {
    const [slot, id] = part.split(":");
    if (isSlot(slot) && id) look[slot] = id;
  }
  const geo: RoomUrl["geo"] = {};
  for (const part of (q.get("geo") ?? "").split(",")) {
    const [g, v] = part.split(".").map(Number);
    if (Number.isInteger(g) && Number.isInteger(v)) geo[g!] = v!;
  }
  const tab = q.get("tab");
  const slot = q.get("slot");
  return {
    body: q.get("body") || q.get("id"),
    tab: TABS.includes(tab as Tab) ? (tab as Tab) : null,
    slot: isSlot(slot) ? slot : null,
    look,
    clip: q.get("clip"),
    geo,
    scene: q.get("scene"),
    tryItem: q.get("try"),
  };
}

function write() {
  const parts: string[] = [];
  const body = $body.get();
  if (body) parts.push(`body=${encodeURIComponent(body)}`);
  const worn = Object.entries($worn.get());
  if (worn.length) parts.push(`look=${worn.map(([s, id]) => `${s}:${encodeURIComponent(id ?? "")}`).join(",")}`);
  const geo = Object.entries($geosets.get());
  if (geo.length) parts.push(`geo=${geo.map(([g, v]) => `${g}.${v}`).join(",")}`);
  const clip = $currentClip.get();
  if (clip && !defaultClip(clip)) parts.push(`clip=${encodeURIComponent(clip)}`);
  if ($tab.get() !== "items") parts.push(`tab=${$tab.get()}`);
  if ($slot.get() !== "head") parts.push(`slot=${$slot.get()}`);
  if ($scene.get() !== DEFAULT_SCENE) parts.push(`scene=${encodeURIComponent($scene.get())}`);
  const next = `${u("wardrobe/")}${parts.length ? `?${parts.join("&")}` : ""}`;
  if (next !== location.pathname + location.search) history.replaceState(history.state, "", next);
}

let initialClip: string | null = null;
const defaultClip = (clip: string) => clip === initialClip;

/** Mirrors the look into the address bar, debounced: browsers rate-limit replaceState. */
export function startUrlSync(firstClip: () => string | null) {
  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      initialClip = firstClip();
      write();
    }, 120);
  };
  for (const store of [$body, $worn, $geosets, $currentClip, $tab, $slot, $scene]) {
    store.listen(schedule);
  }
}
