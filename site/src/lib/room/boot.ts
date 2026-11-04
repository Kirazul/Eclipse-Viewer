/**
 * The dressing room's plain script. It owns the canvas for the life of the page
 * (it is created once and never moved), and wires the ring, tabs, strip and
 * splitter. None of this needs React, so the room works from its first frame.
 */
import {
  $clipLoading, $clips, $currentClip, $error, $loading, $manifest, $paused, $progress, $timeScale,
} from "@eclipse/engine/stores";
import type { SlotId } from "@eclipse/format";
import { PACK_BASE, art, sprite } from "../base";
import { loadUiAtlas } from "../sprites";
import { startMountStage } from "./mountstage";
import { SLOT_LABEL } from "../slots";
import { release, resetLook, setSlot, setTab, wear, wearSet } from "./actions";
import { itemInfo, loadCatalog, startBrowser, tryLink } from "./browser";
import { attachScrub } from "./scrub";
import { $body, $catalogState, $engine, $gridMode, $items, $lookText, $races, $scene, $slot, $tab, $worn, type RoomRace, type Tab } from "./state";
import { $loaded, $pickedMounts } from "../share/state";
import { readUrl, startUrlSync } from "./url";

const room = document.getElementById("room") as HTMLElement;
const stage = document.getElementById("stage") as HTMLElement;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const split = document.getElementById("split") as HTMLElement;

const data = JSON.parse(document.getElementById("room-data")!.textContent!) as { featured: string; sprites: string[]; races: RoomRace[] };
/** The room as one mount's stage: /mounts/view/. */
const mountMode = room.dataset.mountStage !== undefined;
$races.set(data.races);

const url = readUrl();
let body = url.body || data.featured;
$body.set(body);
$tab.set((room.dataset.tab as Tab) ?? "items");
if (url.slot) $slot.set(url.slot);
$worn.set(url.look);
$lookText.set(url.choices);
if (url.scene) $scene.set(url.scene);
try { if (localStorage.getItem("grid-mode") === "figures") $gridMode.set("figures"); } catch { /* private window */ }

// --- The retail sprites -------------------------------------------------------
// One atlas, one read per visitor. Until it is cut the frames are the CSS-drawn ones.
void loadUiAtlas(data.sprites);

// --- The engine ---------------------------------------------------------------
let firstClip: string | null = null;

async function applyLook() {
  const engine = $engine.get();
  if (!engine) return;
  await Promise.all(Object.entries($worn.get()).map(([slot, id]) => engine.equip(slot as SlotId, id ?? null)));
  if (url.clip && url.clip !== $currentClip.get()) await engine.playAnimationByName(url.clip);
}

/** A body the catalogue lists but hasn't baked has nothing to fetch: say so, ask nothing. */
function notBaked(id: string) {
  if (mountMode) return false;
  return data.races.some((r) => r.bodies.some((b) => b.id === id && !b.model));
}

async function loadBody(id: string) {
  const engine = $engine.get();
  if (!engine || !id) return;
  if (notBaked(id)) {
    showError("not baked", "This body isn't baked yet.");
    return;
  }
  // A link's look is worn before the body joins the stage, so it never shows another first.
  await engine.loadModel(id, $lookText.get() || undefined);
  if (!firstClip) firstClip = $currentClip.get();
  await applyLook();
}

async function bootEngine() {
  try {
    const { createEngine } = await import("@eclipse/engine");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const engine = await createEngine({
      packBase: PACK_BASE,
      interactable: true,
      lite: false,
      animated: !reduced,
      cameraStyle: innerWidth < 768 ? "mobile" : "default",
      shadow: true,
      shortcuts: true,
      lockCamera: false,
    });
    await engine.mount(canvas);
    $engine.set(engine);
    if (mountMode) {
      const first = await startMountStage();
      if (!first) {
        showError("no mount", "This mount isn't baked yet.");
        return;
      }
      body = first;
      $body.set(first);
    }
    await loadBody(body);
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

const errorBox = document.getElementById("stage-error") as HTMLElement;
const errorText = document.getElementById("stage-error-text") as HTMLElement;
function showError(message: string | null, words = "This model couldn't be loaded.") {
  errorBox.hidden = !message;
  // Plain words on screen; the technical reason stays in the console.
  if (message) {
    console.warn("[eclipse]", message);
    errorText.textContent = words;
    delete stage.dataset.loading;
  }
}
document.getElementById("stage-retry")!.addEventListener("click", () => {
  showError(null);
  void loadBody($body.get());
});

$error.subscribe((m) => showError(m));
const paintLoading = () => {
  const on = $loading.get();
  if (on) stage.dataset.loading = "";
  else if ($manifest.get() || $error.get()) delete stage.dataset.loading;
};
$loading.subscribe(paintLoading);
$manifest.subscribe((m) => {
  paintLoading();
  // One frame after the model is up: Khada's fade-in, and it is never re-added.
  if (m) requestAnimationFrame(() => canvas.classList.add("ready"));
  room.dataset.kind = m?.kind ?? "";
  // A mount wears nothing: its page is the Viewer tab, and the ring steps aside.
  if (m?.kind === "mount" && $tab.get() !== "viewer") setTab("viewer");
});
const progressBar = document.getElementById("stage-progress") as HTMLElement;
$progress.subscribe((p) => progressBar.style.setProperty("--progress", String(p)));

// --- Tabs ---------------------------------------------------------------------
const tabButtons = [...room.querySelectorAll<HTMLElement>("[data-tab-btn]")];
room.querySelector(".tabs")!.addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-tab-btn]");
  if (b) setTab(b.dataset.tabBtn as Tab);
});
$tab.listen((tab) => {
  room.dataset.tab = tab;
  for (const b of tabButtons) {
    const on = b.dataset.tabBtn === tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  }
  if (tab === "customization" || tab === "loadout" || tab === "viewer") void loadPanels();
});

// --- The ring -----------------------------------------------------------------
const ringSlots = [...room.querySelectorAll<HTMLButtonElement>("[data-ring]")];
const selectable = [...room.querySelectorAll<HTMLElement>("[data-sel]")];
$slot.subscribe((slot) => {
  for (const e of selectable) e.classList.toggle("on", e.dataset.sel === slot);
});

function paintRing() {
  const worn = $worn.get();
  for (const b of ringSlots) {
    const slot = b.dataset.ring as SlotId;
    const id = worn[slot];
    const wasWorn = b.classList.contains("worn");
    b.classList.toggle("worn", !!id);
    const ico = b.querySelector<HTMLElement>(".slot-ico")!;
    const info = id ? itemInfo(id) : undefined;
    const icon = info?.icon ?? "";
    ico.hidden = !icon;
    if (icon) ico.querySelector("img")!.src = art(icon);
    // The slot says every gesture it has, in the same words each time.
    b.dataset.tip = id ? info?.name || "Worn" : SLOT_LABEL[slot];
    b.dataset.tipSub = id ? SLOT_LABEL[slot] : "Empty";
    b.dataset.tipHint = id ? "Click to browse. Right-click to take off." : "Click to browse.";
    if (id && !wasWorn) {
      b.classList.remove("saved");
      void b.offsetWidth;
      b.classList.add("saved");
    }
  }
  // A loaded code can hold no piece at all and still have everything else to take off.
  const any = Object.keys(worn).length > 0 || !!$loaded.get() || !!$pickedMounts.get();
  (document.getElementById("reset-look") as HTMLElement).style.visibility = any ? "visible" : "hidden";
}
$worn.subscribe(paintRing);
$items.listen(paintRing);
$loaded.listen(paintRing);
$pickedMounts.listen(paintRing);

room.querySelector(".room")!.addEventListener("click", (e) => {
  const target = e.target as Element;
  const b = target.closest<HTMLElement>("[data-ring]");
  if (!b) return;
  const slot = b.dataset.ring as SlotId;
  if (target.closest("[data-release]")) {
    void release(slot);
    return;
  }
  setSlot(slot);
  setTab("items");
});
room.querySelector(".room")!.addEventListener("contextmenu", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-ring]");
  if (!b) return;
  e.preventDefault();
  void release(b.dataset.ring as SlotId);
});
document.getElementById("reset-look")!.addEventListener("click", () => { void resetLook(); });

// --- The animation strip --------------------------------------------------------
const stripName = document.getElementById("strip-name") as HTMLElement;
const stripPlay = document.getElementById("strip-play") as HTMLButtonElement;
const stripSpeed = document.getElementById("strip-speed") as HTMLButtonElement;
const stripScrub = document.getElementById("strip-scrub") as HTMLInputElement;
const stripControls = [
  document.getElementById("strip-prev") as HTMLButtonElement,
  document.getElementById("strip-next") as HTMLButtonElement,
  stripPlay, stripSpeed, stripScrub,
];
const paintClipName = () => {
  const id = $currentClip.get();
  const clip = $clips.get().find((c) => c.id === id);
  const name = clip ? (clip.variation ? `${clip.name} ${clip.variation + 1}` : clip.name) : "T-Pose";
  if (stripName.textContent !== name) stripName.textContent = name;
};
$currentClip.subscribe(paintClipName);
$clips.subscribe(paintClipName);
$manifest.subscribe((m) => { for (const c of stripControls) c.disabled = !m; });
$clipLoading.subscribe((on) => {
  if (on) stripName.dataset.loading = "";
  else delete stripName.dataset.loading;
});
$paused.subscribe((paused) => {
  (stripPlay.querySelector(".i-pause") as SVGElement).toggleAttribute("hidden", paused);
  (stripPlay.querySelector(".i-play") as SVGElement).toggleAttribute("hidden", !paused);
  stripPlay.dataset.tip = paused ? "Play" : "Pause";
  stripPlay.setAttribute("aria-label", paused ? "Play" : "Pause");
});
$timeScale.subscribe((s) => { stripSpeed.textContent = `${s}x`; });
document.getElementById("strip-prev")!.addEventListener("click", () => { void $engine.get()?.playPreviousAnimation(); });
document.getElementById("strip-next")!.addEventListener("click", () => { void $engine.get()?.playNextAnimation(); });
stripPlay.addEventListener("click", () => $engine.get()?.togglePauseAnimation());
stripSpeed.addEventListener("click", () => $engine.get()?.goToNextTimeScale());
attachScrub(stripScrub);
// Weapons drawn or on their sheath points, as Z does in the game.
{
  const sheathe = document.getElementById("strip-sheathe") as HTMLButtonElement | null;
  if (sheathe) {
    let on = false;
    const toggle = () => {
      if (sheathe.disabled) return;
      on = !on;
      sheathe.setAttribute("aria-pressed", String(on));
      sheathe.classList.toggle("on", on);
      sheathe.dataset.tip = on ? "Draw weapons" : "Put weapons away";
      $engine.get()?.setSheathed(on);
    };
    sheathe.addEventListener("click", toggle);
    const paint = () => {
      const w = $worn.get();
      sheathe.disabled = !w.mainhand && !w.offhand;
    };
    $worn.subscribe(paint);
    addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() === "z" && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target as Element).closest?.("input,textarea")) toggle();
    });
  }
}

// --- The split --------------------------------------------------------------------
// Khada's panel rules (min(50%, 360px) for the side panel, collapsible past half of
// that), by hand: react-resizable-panels needs hydrating before it knows its width,
// and that hydration moved the stage on load. This reads no width until a drag starts.
{
  const handle = document.getElementById("split-handle") as HTMLElement;
  const ROOM_MIN = 244;
  const sideMin = (w: number) => Math.min(w * 0.5, 360);
  const save = (v: string) => { try { localStorage.setItem("room-width", v); } catch { /* private window */ } };
  const setWidth = (px: number) => {
    split.classList.remove("collapsed");
    split.style.setProperty("--room-w", `${Math.round(px)}px`);
    save(String(Math.round(px)));
  };
  const collapse = () => {
    split.classList.add("collapsed");
    save("collapsed");
  };
  const reset = () => {
    split.classList.remove("collapsed");
    split.style.removeProperty("--room-w");
    try { localStorage.removeItem("room-width"); } catch { /* private window */ }
  };
  let grabX = 0;
  let startW = 0;
  handle.addEventListener("pointerdown", (e) => {
    handle.setPointerCapture(e.pointerId);
    grabX = e.clientX;
    startW = split.classList.contains("collapsed") ? split.clientWidth : room.querySelector<HTMLElement>(".room")!.offsetWidth;
    split.classList.add("dragging");
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!split.classList.contains("dragging")) return;
    const total = split.clientWidth;
    const want = startW + e.clientX - grabX;
    const min = sideMin(total);
    const side = total - want;
    if (side < min / 2) collapse();
    else setWidth(Math.min(Math.max(ROOM_MIN, want), total - min));
  });
  const end = () => split.classList.remove("dragging");
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("dblclick", reset);
  handle.addEventListener("keydown", (e) => {
    const total = split.clientWidth;
    const now = room.querySelector<HTMLElement>(".room")!.offsetWidth;
    if (e.key === "ArrowLeft") setWidth(Math.max(ROOM_MIN, now - 16));
    else if (e.key === "ArrowRight") setWidth(Math.min(total - sideMin(total), now + 16));
    else if (e.key === "Enter") {
      if (split.classList.contains("collapsed")) reset();
      else collapse();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
}

// --- Scene ---------------------------------------------------------------------------
$scene.subscribe((scene) => {
  stage.dataset.scene = scene === "off" ? "off" : "on";
  const img = document.getElementById("scene") as HTMLImageElement | null;
  if (img && scene !== "off") {
    const next = sprite(`scene-${scene}`);
    if (img.src !== new URL(next, location.href).href) img.src = next;
  }
});

// --- Panels, in React, loaded when wanted or when the page has nothing better to do ----
let panels: Promise<void> | null = null;
function loadPanels() {
  panels ??= import("../../components/panels/mount").then((m) => m.mountPanels());
  return panels;
}
if ($tab.get() === "customization" || $tab.get() === "loadout" || $tab.get() === "viewer") void loadPanels();
else {
  const idle = (window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(() => { void loadPanels(); }, { timeout: 2500 });
  else setTimeout(() => { void loadPanels(); }, 1500);
}

// --- Start ------------------------------------------------------------------------------
startBrowser();
if (!mountMode) startUrlSync(() => firstClip);
void loadCatalog().then(() => {
  // A link with a loadout code wears the code, and keeps everything in it.
  if (url.code) void import("../share/live").then((m) => m.importCode(url.code!, false));
  if (url.tryItem) void tryLink(url.tryItem);
});
$catalogState.listen(paintRing);
void bootEngine();
// A bare /viewer/?id= folds into the one address the room has.
if (location.pathname.endsWith("/viewer/")) {
  $tab.notify?.();
}
