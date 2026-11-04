/**
 * The look lives in the URL, so a link is the outfit:
 *   /wardrobe/?body=human-male&look=head:123,chest:456&choices=11.46,12.62&clip=4.0&tab=viewer
 * Everything is read on the client: GitHub Pages has no server to read it.
 */
import { $currentClip } from "@eclipse/engine/stores";
import type { SlotId } from "@eclipse/format";
import { u } from "../base";
import { $shareQuery } from "../share/state";
import { isSlot } from "../slots";
import { $body, $lookText, $scene, $slot, $tab, $worn, DEFAULT_SCENE, TABS, type Tab } from "./state";

export interface RoomUrl {
  body: string | null;
  tab: Tab | null;
  slot: SlotId | null;
  look: Partial<Record<SlotId, string>>;
  clip: string | null;
  /** Customization choices, `<option>.<choice>,...`. A value the body doesn't offer is dropped when it loads. */
  choices: string;
  scene: string | null;
  tryItem: string | null;
  /** An `ECA1:` loadout code, whole: it holds what `body` and `look` can't. */
  code: string | null;
}

export function readUrl(): RoomUrl {
  const q = new URLSearchParams(location.search);
  const look: RoomUrl["look"] = {};
  for (const part of (q.get("look") ?? "").split(",")) {
    const [slot, id] = part.split(":");
    if (isSlot(slot) && id) look[slot] = id;
  }
  const tab = q.get("tab");
  const slot = q.get("slot");
  return {
    body: q.get("body") || q.get("id"),
    tab: TABS.includes(tab as Tab) ? (tab as Tab) : null,
    slot: isSlot(slot) ? slot : null,
    look,
    clip: q.get("clip"),
    choices: q.get("choices") ?? "",
    scene: q.get("scene"),
    tryItem: q.get("try"),
    // A raw + in a pasted link reads as a space; base64 has no spaces to confuse it with.
    code: q.get("code")?.replace(/ /g, "+") || null,
  };
}

function write() {
  const parts: string[] = [];
  const body = $body.get();
  if (body) parts.push(`body=${encodeURIComponent(body)}`);
  const worn = Object.entries($worn.get());
  if (worn.length) parts.push(`look=${worn.map(([s, id]) => `${s}:${encodeURIComponent(id ?? "")}`).join(",")}`);
  const choices = $lookText.get();
  if (choices) parts.push(`choices=${choices}`);
  const clip = $currentClip.get();
  if (clip && !defaultClip(clip)) parts.push(`clip=${encodeURIComponent(clip)}`);
  if ($tab.get() !== "items") parts.push(`tab=${$tab.get()}`);
  if ($slot.get() !== "head") parts.push(`slot=${$slot.get()}`);
  if ($scene.get() !== DEFAULT_SCENE) parts.push(`scene=${encodeURIComponent($scene.get())}`);
  if ($shareQuery.get()) parts.push($shareQuery.get());
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
  for (const store of [$body, $worn, $lookText, $currentClip, $tab, $slot, $scene, $shareQuery]) {
    store.listen(schedule);
  }
}
