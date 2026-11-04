/**
 * The room as a mount's stage: Eclipse's Mounts page, where the animal takes the whole
 * width and its colours sit under it (UiMounts.cpp). Same canvas, strip and Viewer tools
 * as the dressing room; the ring and the catalogue step aside. A colour is a display the
 * game's MountXDisplay gives, and nothing else.
 */
import { packUrl, paths, type MountEntry, type MountVariant } from "@eclipse/format";
import { art, PACK_BASE, u } from "../base";
import { pickMount } from "../share/state";
import { $body, $engine } from "./state";

const strip = document.getElementById("mount-variants") as HTMLElement;
const title = document.getElementById("mount-title") as HTMLElement;
const room = document.getElementById("room") as HTMLElement;
const split = document.getElementById("split") as HTMLElement;
/** The body a rider is, when asked for: the site's first. */
const RIDER = "human-male";

let entry: MountEntry | null = null;
let current: MountVariant | null = null;
let rider = false;

function writeUrl() {
  if (!entry || !current) return;
  const next = `${u("mounts/view/")}?id=${encodeURIComponent(entry.id)}${current !== entry.variants[0] ? `&v=${current.display}` : ""}`;
  if (next !== location.pathname + location.search) history.replaceState(history.state, "", next);
}

function paint() {
  strip.replaceChildren(
    ...(entry?.variants ?? []).map((v) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `mount-swatch${v === current ? " on" : ""}`;
      b.dataset.variant = String(v.display);
      b.dataset.tip = v.name;
      b.setAttribute("aria-label", v.name);
      const img = document.createElement("img");
      img.src = art(v.icon);
      img.alt = "";
      img.width = 40;
      img.height = 40;
      img.decoding = "async";
      b.append(img);
      return b;
    }),
  );
  strip.hidden = (entry?.variants.length ?? 0) < 2;
  title.textContent = current?.name ?? "";
  // The game has no such look: nothing to put in a code.
  const add = document.getElementById("mount-loadout") as HTMLButtonElement | null;
  if (add) add.disabled = !current?.entry;
}

async function show(v: MountVariant) {
  current = v;
  paint();
  writeUrl();
  $body.set(v.id);
  const engine = $engine.get();
  if (!engine) return;
  await engine.loadModel(v.id);
  if (rider) await engine.setRider(RIDER);
}

export async function startMountStage(): Promise<string | null> {
  strip.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-variant]");
    const v = entry?.variants.find((x) => String(x.display) === b?.dataset.variant);
    if (v) void show(v);
  });
  document.getElementById("mount-tools")?.addEventListener("click", (e) => {
    const on = split.classList.toggle("tools-open");
    (e.currentTarget as HTMLElement).classList.toggle("on", on);
  });
  // The look's mount, by the display id the game's morph takes: the Loadout tab reads it.
  document.getElementById("mount-loadout")?.addEventListener("click", () => {
    if (!entry || !current?.entry) return;
    pickMount(current.entry, entry.flying);
    location.href = u("wardrobe/?tab=loadout");
  });
  document.getElementById("mount-rider")?.addEventListener("click", (e) => {
    rider = !rider;
    (e.currentTarget as HTMLElement).classList.toggle("on", rider);
    void $engine.get()?.setRider(rider ? RIDER : null);
  });
  const q = new URLSearchParams(location.search);
  const id = q.get("id");
  const res = await fetch(packUrl(PACK_BASE, paths.mounts())).catch(() => null);
  const list = res?.ok ? ((await res.json()) as MountEntry[]) : [];
  entry = list.find((m) => m.id === id || m.variants.some((v) => v.id === id)) ?? list[0] ?? null;
  if (!entry) return null;
  const wanted = q.get("v");
  current = entry.variants.find((v) => String(v.display) === wanted) ?? entry.variants[0]!;
  room.dataset.kind = "mount";
  paint();
  return current.id;
}
