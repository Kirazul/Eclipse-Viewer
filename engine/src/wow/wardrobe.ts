/**
 * The dressing room on one body. A slot holds what is worn; a preview shows over it
 * until it ends, and never writes to it. Everything that would change the picture
 * is prepared off stage, then handed over to be applied inside one frame.
 *
 * Coalescing: calls in the same tick become one change, and a newer change abandons
 * an older one that is still loading, so hovering across a grid applies only where
 * the pointer stopped.
 */
import type { Object3D, Texture, WebGLRenderTarget } from "three";
import type { SlotId } from "@eclipse/format";
import { isAbort } from "../net/fetchPack";
import { $equipped, $error, $previewing } from "../stores";
import type { Figure } from "../model/figure";
import type { LoadEnv } from "../model/assets";
import { CompositeRenderer } from "./composite";
import { ItemLibrary, disposeItem, itemKey, placePiece, planOutfit, type Piece, type ResolvedItem } from "./outfit";

/** What the engine does for the wardrobe. */
export interface WardrobeHost {
  /** Compiles programs and uploads textures for a subtree that is not yet on stage. */
  prepare(root: Object3D, textures: Texture[]): Promise<void>;
  /** The same for a piece's particles and ribbons. `ownClip`: it plays its own clip, not the body's. */
  prepareEffects(figure: Figure, ownClip: boolean): Promise<void>;
  /** Uploads a texture the outfit paints on the body, so swapping it in costs nothing. */
  prepareTexture(texture: Texture): Promise<void>;
  /** Applies a change inside the next frame; resolves when that frame has been drawn. */
  applyAtomically(change: OutfitChange): Promise<void>;
  anisotropy(): number;
}

export interface OutfitChange {
  attach: Piece[];
  detach: Piece[];
  visible: Set<number>;
  composite: Texture | null;
  wornTextures: ReadonlyMap<number, Texture>;
}

const COMPOSITE_CACHE = 4;

export class Wardrobe {
  private committed = new Map<SlotId, string>();
  private previews = new Map<SlotId, string>();
  private readonly library: ItemLibrary;
  private onStage: Piece[] = [];
  private worn: ReadonlyMap<SlotId, ResolvedItem> = new Map();
  private appliedKey = "";
  private generation = 0;
  private queued: Promise<void> | null = null;
  private readonly composites = new Map<string, WebGLRenderTarget>();
  /** Plans applied: a burst of hovers should leave this barely moved. */
  applied = 0;
  private disposed = false;

  constructor(
    private readonly body: Figure,
    env: LoadEnv,
    private readonly composer: CompositeRenderer,
    private readonly host: WardrobeHost,
  ) {
    this.library = new ItemLibrary(env, body);
  }

  equip(slot: SlotId, itemId: string | null): Promise<void> {
    if (itemId) this.committed.set(slot, itemId);
    else this.committed.delete(slot);
    this.previews.delete(slot);
    this.publish();
    return this.schedule();
  }

  preview(slot: SlotId, itemId: string | null): Promise<void> {
    if (itemId) this.previews.set(slot, itemId);
    else this.previews.delete(slot);
    $previewing.set(Object.fromEntries(this.previews));
    return this.schedule();
  }

  private publish(): void {
    $equipped.set(Object.fromEntries(this.committed));
    $previewing.set(Object.fromEntries(this.previews));
  }

  private effective(): Map<SlotId, string> {
    const out = new Map(this.committed);
    for (const [slot, id] of this.previews) out.set(slot, id);
    return out;
  }

  private schedule(): Promise<void> {
    this.queued ??= Promise.resolve().then(() => {
      this.queued = null;
      return this.run();
    });
    return this.queued;
  }

  private async run(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    const target = this.effective();
    const key = [...target.entries()]
      .map(([slot, id]) => `${slot}=${id}`)
      .sort()
      .join(",");
    const wanted = new Set([...target].map(([slot, id]) => itemKey(id, slot)));
    this.library.cancelUnwanted(wanted);
    if (key === this.appliedKey) return;

    try {
      const worn = new Map<SlotId, ResolvedItem>();
      await Promise.all(
        [...target].map(async ([slot, id]) => {
          worn.set(slot, await this.library.resolve(id, slot));
        }),
      );
      if (generation !== this.generation || this.disposed) return;

      const plan = planOutfit(this.body, worn);
      for (const t of plan.wornTextures.values()) await this.host.prepareTexture(t);
      for (const piece of plan.pieces) {
        if (this.stowed && piece.slot !== "ranged") placePiece(piece, true);
        if (this.onStage.includes(piece)) continue;
        await this.host.prepare(piece.node, piece.figure.allTextures());
        await this.host.prepareEffects(piece.figure, piece.kind === "attached");
        if (generation !== this.generation || this.disposed) return;
      }
      // Drawn off stage into its own target, so this is safe at any moment.
      const composite = this.compositeFor(plan.compositeKey, plan.layers);

      const next = new Set(plan.pieces);
      const change: OutfitChange = {
        attach: plan.pieces.filter((p) => !this.onStage.includes(p)),
        detach: this.onStage.filter((p) => !next.has(p)),
        visible: plan.visible,
        composite,
        wornTextures: plan.wornTextures,
      };
      this.onStage = plan.pieces;
      this.appliedKey = key;
      this.worn = worn;
      this.applied++;
      await this.host.applyAtomically(change);
      await this.library.trim(wanted, disposeItem);
    } catch (err) {
      if (!isAbort(err) && generation === this.generation) {
        $error.set(`Could not load an item: ${(err as Error).message}`);
      }
    }
  }

  /** Once per distinct outfit; a preview ending goes back to a composite already drawn. */
  private compositeFor(key: string, layers: ReturnType<typeof planOutfit>["layers"]): Texture | null {
    const manifest = this.body.assets.manifest.composite;
    if (!manifest) return null;
    if (!key) return this.body.baseComposite?.texture ?? null;
    let target = this.composites.get(key);
    if (!target) {
      target = this.composer.render(manifest.width, manifest.height, layers, this.host.anisotropy());
      this.composites.set(key, target);
      if (this.composites.size > COMPOSITE_CACHE) {
        const current = this.body.composite;
        for (const [k, rt] of this.composites) {
          if (rt.texture !== current && k !== key) {
            rt.dispose();
            this.composites.delete(k);
            break;
          }
        }
      }
    } else {
      // Most recently used goes last.
      this.composites.delete(key);
      this.composites.set(key, target);
    }
    return target.texture;
  }

  get pieces(): readonly Piece[] {
    return this.onStage;
  }

  /** Weapons drawn or put away: each moves to its sheath point, and what has none stays in hand. */
  setStowed(stowed: boolean): void {
    this.stowed = stowed;
    const handsFull = this.worn.has("mainhand") || this.worn.has("offhand");
    for (const piece of this.onStage) {
      if (piece.slot === "ranged") placePiece(piece, handsFull || stowed);
      else if (piece.slot === "mainhand" || piece.slot === "offhand") placePiece(piece, stowed);
    }
  }

  private stowed = false;

  /** Slot -> item worn for real, previews left out: what a new body inherits. */
  committedEntries(): [SlotId, string][] {
    return [...this.committed];
  }

  /** Puts these on before the body joins the stage: a body swap keeps the outfit. */
  async restore(entries: readonly [SlotId, string][]): Promise<void> {
    if (entries.length === 0) return;
    for (const [slot, id] of entries) this.committed.set(slot, id);
    this.publish();
    await this.run();
  }

  /** The look changed under the outfit: what it shows over the new one, worked out now. */
  relook(): { visible: Set<number>; composite: Texture | null } {
    const plan = planOutfit(this.body, this.worn);
    return { visible: plan.visible, composite: this.compositeFor(plan.compositeKey, plan.layers) };
  }

  /** The look changed under the outfit: the geosets it shows, recomputed now. */
  currentGeosets(): Set<number> {
    return planOutfit(this.body, this.worn).visible;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.library.disposeAll();
    for (const rt of this.composites.values()) rt.dispose();
    this.composites.clear();
    this.onStage = [];
  }
}
