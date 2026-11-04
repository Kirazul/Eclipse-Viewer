/**
 * The bridge on the live page: what the room shows now, and dressing it in a code with
 * the same engine calls a set uses. Share.cpp Import's three steps are here: decode,
 * wear, and keep.
 */
import { $customization, $error, $look, $manifest } from "@eclipse/engine/stores";
import { encodeLook, settleLook, type Look, type MountVariant, type SlotId } from "@eclipse/format";
import { atom } from "nanostores";
import { setBody } from "../room/actions";
import { endHover, settled } from "../room/hover";
import { $body, $engine, $lookText, $races, $tab, $worn } from "../room/state";
import { ALL_SLOTS } from "../slots";
import { MORPH_SLOT, bodyOf, composeOutfit, importName, keptInCode, wornFromCode, type Composed, type Kept, type Loaded, type SiteState } from "./bridge";
import { itemNow, itemOfEntry, mountOfEntry } from "./catalog";
import { decode, encode } from "./code";
import { cleanName, hasLook, readLibrary, removeLook, renameLook, saveLook, writeLibrary, type SavedLook } from "./library";
import { cloneOutfit, writeBack, type Outfit } from "./outfit";
import { $loaded, $pickedMounts, $shareQuery, clearPickedMounts } from "./state";

export const $library = atom<SavedLook[]>(readLibrary());
/** The saved look selected in the list. Null: "Current look". */
export const $selected = atom<string | null>(null);

function setLibrary(next: SavedLook[]) {
  $library.set(next);
  writeLibrary(next);
}

const choicesNow = (body: string): Look | null => {
  const m = $manifest.get();
  if (m?.id !== body) return null;
  return $look.get() ?? m.look ?? null;
};

/** What the room is showing. A mount is the loaded code's, until the Mounts page picks another. */
export function siteNow(): SiteState {
  const body = $body.get();
  const at = $loaded.get()?.at;
  const picked = $pickedMounts.get();
  return {
    body,
    worn: { ...$worn.get() },
    choices: choicesNow(body),
    mount: picked?.mount || at?.mount || 0,
    mountFly: picked?.mountFly || at?.mountFly || 0,
  };
}

const lookup = { entryOf: (id: string) => itemNow(id)?.entry };
const optionOrder = () => $customization.get()?.options.map((o) => o.id);

/** The outfit for what the room shows. */
export function composeNow(): Composed {
  return composeOutfit($loaded.get(), siteNow(), lookup, optionOrder());
}

const bodyExists = (id: string) => $races.get().some((r) => r.bodies.some((b) => b.id === id && b.model));

export interface CodePlan {
  outfit: Outfit;
  body: string | null;
  race: string;
  choices: Look | null;
  worn: Partial<Record<SlotId, string>>;
  mounts: [MountVariant | undefined, MountVariant | undefined];
  kept: Kept;
}

/** What a code will do on this site, with its slots and mounts looked up. */
export async function planOf(o: Outfit): Promise<CodePlan> {
  const entries = new Map<string, string | undefined>();
  await Promise.all(ALL_SLOTS.map(async (slot) => {
    const m = MORPH_SLOT[slot];
    if (o.managed[m] && o.item[m]) entries.set(`${slot}:${o.item[m]}`, (await itemOfEntry(slot, o.item[m]!))?.id);
  }));
  const fromCode = wornFromCode(o, (slot, entry) => entries.get(`${slot}:${entry}`));
  const [ground, fly] = await Promise.all([o.mount ? mountOfEntry(o.mount) : undefined, o.mountFly ? mountOfEntry(o.mountFly) : undefined]);
  const b = bodyOf(o, bodyExists);
  const shownMounts = (ground ? 1 : 0) + (fly && o.mountFly !== o.mount ? 1 : 0);
  return {
    outfit: o,
    body: b?.body ?? null,
    race: b?.race ?? "",
    choices: b?.choices ?? null,
    worn: fromCode.worn,
    mounts: [ground, fly],
    kept: keptInCode(o, fromCode.unknown.length, !!b?.body || !b, shownMounts),
  };
}

let dressing = 0;

/**
 * Wears a look: the ring, then the body and every slot, then the choices. Newest call
 * wins. `body` null: the code says nothing about the body, so body and look stand. A
 * body with no `choices` wears its first look, which is what a classic code can say.
 */
async function dress(body: string | null, worn: Partial<Record<SlotId, string>>, choices: Look | null): Promise<boolean> {
  const mine = ++dressing;
  endHover();
  const engine = $engine.get();
  $worn.set(worn);
  if (body && body !== $body.get()) await setBody(body, choices ? encodeLook(choices, {}) : "");
  else {
    await Promise.all(ALL_SLOTS.map((s) => engine?.equip(s, worn[s] ?? null)));
    if (mine === dressing && body && engine) {
      const data = await engine.loadCustomization();
      if (mine !== dressing) return false;
      if (data) await engine.setLook(settleLook(data.options, { ...($manifest.get()?.look ?? {}), ...choices }));
    }
  }
  if (mine !== dressing) return false;
  for (const [s, id] of Object.entries(worn)) settled(s as SlotId, id);
  // The link's own form of what is now worn: only what differs from the first look.
  const look = $look.get();
  const first = $manifest.get()?.look;
  if (body && look && first) $lookText.set(encodeLook(look, first));
  return true;
}

// --- Selecting a saved look previews it, as the Loadout stage does ---------------
interface Stash {
  site: SiteState;
  look: Look | null;
  loaded: Loaded | null;
}
let stash: Stash | null = null;

/** The outfit you are wearing, whatever a preview is showing on the figure. */
export function composeWorn(): Composed {
  return stash ? composeOutfit(stash.loaded, stash.site, lookup, optionOrder()) : composeNow();
}

/** The picture of a look: DefaultLoadoutIcon's order, then the race's portrait. */
const COVER_ORDER: SlotId[] = ["chest", "head", "shoulder", "mainhand", "offhand", "back", "legs", "hands", "feet"];
export function coverOf(worn: Partial<Record<SlotId, string>>, body: string): string {
  for (const slot of COVER_ORDER) {
    const icon = worn[slot] && itemNow(worn[slot]!)?.icon;
    if (icon) return icon;
  }
  for (const r of $races.get()) for (const b of r.bodies) if (b.id === body) return b.circle || r.circle;
  return "";
}

/** The picture of what you are wearing, whatever a preview is showing. */
export const coverWorn = () => {
  const site = stash?.site ?? siteNow();
  return coverOf(site.worn, site.body);
};

/** Figure back to what you are wearing. */
async function endPreview() {
  const s = stash;
  if (!s) return;
  stash = null;
  $loaded.set(s.loaded);
  await dress(s.site.body, s.site.worn, s.look);
  // Undressing a preview changes nothing: what was loaded is what is on again.
  if (s.loaded) $loaded.set({ outfit: s.loaded.outfit, at: { ...s.loaded.at, choices: choicesNow(s.site.body) ?? s.loaded.at.choices } });
}

/** Puts the look on the figure and holds it for the code; `wear` keeps it, a preview doesn't. */
async function wearPlan(plan: CodePlan, keep: boolean) {
  if (!keep && !stash) stash = { site: siteNow(), look: $look.get(), loaded: $loaded.get() };
  if (keep) {
    stash = null;
    clearPickedMounts();
  }
  const done = await dress(plan.body, plan.worn, plan.choices);
  // The code's mounts are what `at` holds: nothing was picked over them yet, even in a preview.
  if (done) $loaded.set({ outfit: plan.outfit, at: { ...siteNow(), mount: plan.outfit.mount, mountFly: plan.outfit.mountFly } });
}

export async function selectSaved(name: string | null) {
  $selected.set(name);
  if (!name) return endPreview();
  const row = $library.get().find((l) => l.name === name);
  const o = row && decode(row.code);
  if (o) await wearPlan(await planOf(o), false);
}

/** Apply loadout: the preview becomes what is worn. It stays selected: the figure has nothing to rebuild. */
export async function applySelected() {
  const name = $selected.get();
  const row = $library.get().find((l) => l.name === name);
  const o = row && decode(row.code);
  if (!o) return;
  clearPickedMounts();
  if (stash) stash = null;
  else await wearPlan(await planOf(o), true);
}

// A preview belongs to the Loadout page: anywhere else, the figure is what you wear.
$tab.listen((tab) => {
  if (tab !== "loadout" && stash) {
    $selected.set(null);
    void endPreview();
  }
});

// --- The list -------------------------------------------------------------------
export function saveCurrent(rawName: string): { ok: boolean; name: string } {
  const name = cleanName(rawName);
  if (!name) return { ok: false, name };
  const { outfit } = composeWorn();
  const site = stash?.site ?? siteNow();
  setLibrary(saveLook($library.get(), { name, code: encode(outfit), cover: coverOf(site.worn, site.body) }));
  return { ok: true, name };
}
export function deleteSaved(name: string) {
  setLibrary(removeLook($library.get(), name));
  if ($selected.get() === name) void selectSaved(null);
}
export function renameSaved(from: string, rawTo: string): boolean {
  const to = cleanName(rawTo);
  if (!to || (hasLook($library.get(), to) && to.toLowerCase() !== from.toLowerCase())) return false;
  setLibrary(renameLook($library.get(), from, to));
  if ($selected.get() === from) $selected.set(to);
  return true;
}
export const nameTaken = (name: string) => hasLook($library.get(), cleanName(name));

/** A link's code can arrive before the first body: it waits, so it doesn't race that load. */
function stageUp(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (!$manifest.get() && !$error.get()) return;
      stopManifest();
      stopError();
      resolve();
    };
    const stopManifest = $manifest.listen(check);
    const stopError = $error.listen(check);
    check();
  });
}

const plainText = (o: Outfit) => {
  const p = cloneOutfit(o);
  p.display = 0;
  p.displayNative = false;
  return writeBack(p);
};

/** Share.cpp Import: wear it and file it, under an identical loadout's name if there is one. */
export async function importCode(text: string, file = true): Promise<{ ok: boolean; note: string }> {
  const o = decode(text);
  if (!o) return { ok: false, note: "That is not an Eclipse loadout code." };
  const plan = await planOf(o);
  await stageUp();
  await wearPlan(plan, true);
  if (!file) return { ok: true, note: "Imported loadout applied." };
  const body = plainText(o);
  const list = $library.get();
  const name = importName(list.map((l) => {
    const d = decode(l.code);
    return { name: l.name, same: !!d && plainText(d) === body };
  }));
  if (!name) return { ok: true, note: "Imported loadout applied." };
  setLibrary(saveLook(list, { name, code: encode(o), cover: coverOf(plan.worn, plan.body ?? $body.get()) }));
  $selected.set(name);
  return { ok: true, note: `Imported and saved as "${name}".` };
}

/**
 * The address bar holds a code whenever `body` and `look` can't say it all: a loaded code
 * or a picked mount. Debounced, and on whatever tab: an edit on Items moves it too, so a
 * reload never brings back an older look.
 */
function syncShareQuery() {
  const q = !stash && ($loaded.get() || $pickedMounts.get()) ? `code=${encodeURIComponent(encode(composeNow().outfit))}` : "";
  if (q !== $shareQuery.get()) $shareQuery.set(q);
}
let shareTimer = 0;
for (const store of [$worn, $body, $look, $loaded, $pickedMounts] as const) {
  (store as { listen(f: () => void): unknown }).listen(() => {
    clearTimeout(shareTimer);
    shareTimer = window.setTimeout(syncShareQuery, 60);
  });
}
syncShareQuery();
