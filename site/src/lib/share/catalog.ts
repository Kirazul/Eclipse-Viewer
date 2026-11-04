/**
 * In-game ids against the catalogue: item entry per slot, mount display. Items come in
 * shards by line and slot, so a code's slots fetch only their own, and only once. A
 * catalogue from before shards lists its items in `$items` and needs no fetch at all.
 */
import { itemOfRow, packUrl, paths, type ItemEntry, type ItemShard, type ItemShardRef, type MountEntry, type MountVariant, type SlotId } from "@eclipse/format";
import { PACK_BASE } from "../base";
import { $items } from "../room/state";

const byId = new Map<string, ItemEntry>();
const byEntry = new Map<string, ItemEntry>();
const bySlotEntry = (slot: SlotId, entry: number) => `${slot}:${entry}`;

function index(items: readonly ItemEntry[]) {
  for (const it of items) {
    byId.set(it.id, it);
    if (it.entry && !byEntry.has(bySlotEntry(it.slot, it.entry))) byEntry.set(bySlotEntry(it.slot, it.entry), it);
  }
}
$items.subscribe(index);

async function json<T>(key: string): Promise<T | null> {
  try {
    const res = await fetch(packUrl(PACK_BASE, key));
    return res.ok ? (await res.json()) as T : null;
  } catch {
    return null;
  }
}

let shardRefs: Promise<ItemShardRef[]> | null = null;
const slotsDone = new Map<SlotId, Promise<void>>();

function loadSlot(slot: SlotId): Promise<void> {
  let done = slotsDone.get(slot);
  if (done) return done;
  shardRefs ??= json<{ itemShards?: ItemShardRef[] }>(paths.catalog()).then((c) => c?.itemShards ?? []);
  done = shardRefs.then(async (refs) => {
    const shards = await Promise.all(refs.filter((r) => r.slot === slot).map((r) => json<ItemShard>(r.key)));
    for (const s of shards) if (s) index(s.rows.map((row) => itemOfRow(row, s.line, s.slot)));
  });
  slotsDone.set(slot, done);
  return done;
}

/** The catalogue row of a game item in this slot, fetching that slot's shards if it has to. */
export async function itemOfEntry(slot: SlotId, entry: number): Promise<ItemEntry | undefined> {
  const hit = byEntry.get(bySlotEntry(slot, entry));
  if (hit) return hit;
  await loadSlot(slot);
  return byEntry.get(bySlotEntry(slot, entry));
}

/** What is known now: a look's slots are loaded by `ensureWorn` before anything asks. */
export const itemNow = (id: string) => byId.get(id);
export const itemOfEntryNow = (slot: SlotId, entry: number) => byEntry.get(bySlotEntry(slot, entry));

/** Everything worn has its row, so its entry and icon can be read at once. */
export async function ensureWorn(worn: Partial<Record<SlotId, string>>): Promise<void> {
  await Promise.all((Object.entries(worn) as [SlotId, string][]).filter(([, id]) => !byId.has(id)).map(([slot]) => loadSlot(slot)));
}

let mounts: Promise<Map<number, MountVariant>> | null = null;

/** The mount a display id is, by the id the game's morph takes. Fetched the first time a code holds a mount. */
export function mountOfEntry(entry: number): Promise<MountVariant | undefined> {
  mounts ??= json<MountEntry[]>(paths.mounts()).then((list) => {
    const out = new Map<number, MountVariant>();
    for (const m of list ?? []) for (const v of m.variants ?? []) if (v.entry && !out.has(v.entry)) out.set(v.entry, v);
    return out;
  });
  return mounts.then((m) => m.get(entry));
}
