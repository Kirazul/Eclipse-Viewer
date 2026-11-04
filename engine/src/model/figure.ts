/**
 * One model in the scene graph: its meshes as retail batches, its bones, its mixer,
 * its look. Nothing here touches the live scene until the engine adds `root`, so a
 * figure can be built, compiled and posed entirely off stage. Owns all its GPU data.
 */
import {
  AnimationMixer,
  Group,
  Vector3,
  type BufferGeometry,
  type Material,
  type Mesh,
  type Object3D,
  type Skeleton,
  type SkinnedMesh,
  type Texture,
  type WebGLRenderTarget,
} from "three";
import type { SubmeshExtras } from "@eclipse/format";
import { GeosetLook } from "../logic/geosets";
import { boneIndex } from "../logic/pivots";
import { BatchMaterial } from "../wow/material";
import { FxRuntime } from "../wow/fx";
import { batchRenderOrder } from "../wow/programs";
import { whiteTexture } from "./loaders";
import type { ModelAssets } from "./assets";

const NO_EXTRAS: SubmeshExtras = {
  hash: 0,
  geoset: 0,
  units: [],
  shader: 0,
  blend: 0,
  flags: 0,
  priority: 0,
  color: -1,
  opacity: -1,
};

export interface Part {
  mesh: Mesh;
  material: BatchMaterial;
  extras: SubmeshExtras;
  /** Wanted by the look. */
  shown: boolean;
  /** The Model Parts toggle: null follows the look. */
  userVisible: boolean | null;
  /** Its textures are in. A part never draws before they are. */
  ready: boolean;
  /** Units waiting on a texture that is still coming. */
  waiting: { unit: number; tex: number; wrapS: boolean; wrapT: boolean }[];
  /** Units that sample the runtime composite. */
  usesComposite: boolean[];
  wireframe: boolean;
}

export interface FigureOptions {
  /** Draw order layer: 0 body, 1 collections, 2 attached models. */
  layer?: number;
  /** Prefix for node names: attached models hang under the body's bones, and names must not collide. */
  namePrefix?: string;
}

const UNIT_KEYS = ["uT0", "uT1", "uT2"] as const;
const _size = new Vector3();

export class Figure {
  readonly root = new Group();
  readonly parts: Part[] = [];
  readonly byHash = new Map<number, Part[]>();
  readonly bones = new Map<string, Object3D>();
  readonly mixer: AnimationMixer;
  readonly fx: FxRuntime;
  readonly look: GeosetLook;
  skeleton: Skeleton | null = null;
  /** A body's skeleton this collection borrows: it is not this figure's to dispose. */
  foreignSkeleton: Skeleton | null = null;
  /** The grid's frame counter: a piece shared by cells advances once per frame. */
  poseStamp = -1;
  /** The default look's composite. The wardrobe can show others; this one stays. */
  baseComposite: WebGLRenderTarget | null = null;
  private currentComposite: Texture | null = null;
  private readonly namePrefix: string;
  private disposed = false;
  /** Set when a late texture makes a part ready, so the engine can redraw. */
  onChange: (() => void) | null = null;

  constructor(
    readonly assets: ModelAssets,
    opts: FigureOptions = {},
  ) {
    this.namePrefix = opts.namePrefix ?? "";
    const layer = opts.layer ?? 0;
    const scene = assets.gltf.scene;
    this.root.name = assets.manifest.id;
    this.root.add(scene);

    const meshes: Mesh[] = [];
    scene.traverse((o) => {
      if ((o as Mesh).isMesh) meshes.push(o as Mesh);
      else if (o.name) {
        if (this.namePrefix) o.name = this.namePrefix + o.name;
        this.bones.set(o.name, o);
      }
    });

    const pivots = assets.manifest.pivots;
    if (pivots) {
      for (const [name, node] of this.bones) {
        const bone = boneIndex(name);
        if (bone >= 0) applyPivot(node, pivots[bone * 3] ?? 0, pivots[bone * 3 + 1] ?? 0, pivots[bone * 3 + 2] ?? 0);
      }
    }

    const ids = new Set<number>();
    meshes.forEach((mesh, order) => {
      const raw = (mesh.material as Material).userData as Partial<SubmeshExtras> | undefined;
      const extras: SubmeshExtras = { ...NO_EXTRAS, ...raw, hash: raw?.hash ?? order };
      (mesh.material as Material).dispose();
      const material = new BatchMaterial(extras);
      mesh.material = material;
      mesh.frustumCulled = false;
      mesh.renderOrder = batchRenderOrder(extras.priority, order, layer);
      mesh.castShadow = !material.state.blended;
      ids.add(extras.geoset);

      if (!(mesh.geometry as BufferGeometry).getAttribute("normal")) {
        (mesh.geometry as BufferGeometry).computeVertexNormals();
      }

      const part: Part = {
        mesh,
        material,
        extras,
        shown: false,
        userVisible: null,
        ready: true,
        waiting: [],
        usesComposite: [],
        wireframe: false,
      };
      this.bindUnits(part);
      this.parts.push(part);
      const same = this.byHash.get(extras.hash);
      if (same) same.push(part);
      else this.byHash.set(extras.hash, [part]);

      const skinned = mesh as SkinnedMesh;
      if (skinned.isSkinnedMesh) {
        // Primitives of one skin share one bone texture.
        if (!this.skeleton) this.skeleton = skinned.skeleton;
        else if (sameBones(this.skeleton, skinned.skeleton)) {
          skinned.skeleton.dispose();
          skinned.skeleton = this.skeleton;
        }
      }
    });

    this.look = new GeosetLook(assets.manifest.defaultGeosets, ids);
    this.applyGeosets(this.look.visible);

    assets.onTexture = (index) => this.textureArrived(index);
    this.mixer = new AnimationMixer(this.root);
    const targets = this.parts.map((p) => ({ extras: p.extras, uniforms: p.material.uniforms as never }));
    this.fx = new FxRuntime(assets.fx, targets);
    this.fx.setClip(assets.defaultClip);
    this.fx.update(0, 0);
  }

  get id(): string {
    return this.assets.manifest.id;
  }

  /** A clip's tracks name nodes; an attached model's nodes carry a prefix. */
  adaptClip<T extends { tracks: { name: string }[] }>(clip: T): T {
    if (this.namePrefix) {
      for (const track of clip.tracks) {
        if (!track.name.startsWith(this.namePrefix)) track.name = this.namePrefix + track.name;
      }
    }
    return clip;
  }

  private bindUnits(part: Part): void {
    const { assets } = this;
    const { units } = part.extras;
    const u = part.material.uniforms;
    for (let i = 0; i < 3; i++) u[UNIT_KEYS[i]!].value = whiteTexture();
    units.forEach((unit, i) => {
      if (i >= 3 || unit.tex < 0) return;
      const entry = assets.manifest.textures[unit.tex];
      if (!entry) return;
      if (!entry.key) {
        // Produced at runtime. Only a type 1 has a composite to read.
        if (entry.type === 1) part.usesComposite[i] = true;
        return;
      }
      const texture = assets.textureFor(unit.tex, unit.wrapS, unit.wrapT);
      if (texture) {
        u[UNIT_KEYS[i]!].value = texture;
        if (i === 0) part.material.setShadowCut(texture);
      } else {
        part.ready = false;
        part.waiting.push({ unit: i, tex: unit.tex, wrapS: unit.wrapS, wrapT: unit.wrapT });
      }
    });
    if (part.usesComposite.some(Boolean)) part.ready = false;
  }

  private textureArrived(index: number): void {
    if (this.disposed) return;
    let changed = false;
    for (const part of this.parts) {
      const still = part.waiting.filter((w) => {
        if (w.tex !== index) return true;
        const texture = this.assets.textureFor(index, w.wrapS, w.wrapT);
        if (texture) {
          // Uploaded now, so showing this part later costs nothing.
          this.assets.env.renderer.initTexture(texture);
          part.material.uniforms[UNIT_KEYS[w.unit]!].value = texture;
          if (w.unit === 0) part.material.setShadowCut(texture);
        }
        return false;
      });
      if (still.length !== part.waiting.length) {
        part.waiting = still;
        changed = true;
        this.refreshReady(part);
      }
    }
    if (changed) {
      this.refreshVisibility();
      this.onChange?.();
    }
  }

  private refreshReady(part: Part): void {
    const compositeMissing = part.usesComposite.some(Boolean) && !this.currentComposite;
    part.ready = part.waiting.length === 0 && !compositeMissing;
  }

  /** Points every composite unit at this texture, in one step. */
  setComposite(texture: Texture | null): void {
    this.currentComposite = texture;
    for (const part of this.parts) {
      part.usesComposite.forEach((used, i) => {
        if (!used) return;
        part.material.uniforms[UNIT_KEYS[i]!].value = texture ?? whiteTexture();
        if (i === 0) part.material.setShadowCut(texture);
      });
      this.refreshReady(part);
    }
    this.refreshVisibility();
  }

  get composite(): Texture | null {
    return this.currentComposite;
  }

  /** The look's geosets decide what shows, in one step. */
  applyGeosets(visible: ReadonlySet<number>): void {
    for (const part of this.parts) part.shown = visible.has(part.extras.geoset);
    this.refreshVisibility();
  }

  refreshVisibility(): void {
    for (const part of this.parts) {
      part.mesh.visible = part.ready && (part.userVisible ?? part.shown);
    }
  }

  /** Bones and skin in their current pose, for anything that reads them off stage. */
  poseNow(): void {
    this.root.updateMatrixWorld(true);
    this.skeleton?.update();
  }

  /** Every texture this figure draws with, for upload before it joins the scene. */
  allTextures(): Texture[] {
    const out = new Set<Texture>();
    for (const part of this.parts) {
      const u = part.material.uniforms;
      for (const key of UNIT_KEYS) {
        const t = u[key].value;
        if (t) out.add(t);
      }
    }
    return [...out];
  }

  sizeHint(): number {
    const { min, max } = this.assets.manifest.bounds;
    _size.set(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    return _size.length() / 2;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.root.removeFromParent();
    const skeletons = new Set<Skeleton>();
    for (const part of this.parts) {
      part.mesh.geometry.dispose();
      part.material.dispose();
      const sk = (part.mesh as SkinnedMesh).skeleton;
      if (sk) skeletons.add(sk);
    }
    if (this.skeleton) skeletons.add(this.skeleton);
    for (const sk of skeletons) if (sk !== this.foreignSkeleton) sk.dispose();
    this.baseComposite?.dispose();
    this.baseComposite = null;
    this.assets.onTexture = null;
    this.assets.dispose();
  }
}

/**
 * The bone composes T(pivot + t) R S T(-pivot), as retail's does. No allocation: this
 * runs for every animated bone every frame.
 */
function pivotUpdateMatrix(this: Object3D): void {
  this.matrix.compose(this.position, this.quaternion, this.scale);
  const p = this.userData.pivot as [number, number, number];
  const e = this.matrix.elements;
  e[12]! += p[0] - (e[0]! * p[0] + e[4]! * p[1] + e[8]! * p[2]);
  e[13]! += p[1] - (e[1]! * p[0] + e[5]! * p[1] + e[9]! * p[2]);
  e[14]! += p[2] - (e[2]! * p[0] + e[6]! * p[1] + e[10]! * p[2]);
  this.matrixWorldNeedsUpdate = true;
}

export function applyPivot(node: Object3D, x: number, y: number, z: number): void {
  if (x === 0 && y === 0 && z === 0) return;
  node.userData.pivot = [x, y, z];
  node.updateMatrix = pivotUpdateMatrix;
}

/** A clone loses the method but keeps userData: this puts the behaviour back. */
export function restorePivots(root: Object3D): void {
  root.traverse((o) => {
    const p = o.userData.pivot as [number, number, number] | undefined;
    if (p) o.updateMatrix = pivotUpdateMatrix;
  });
}

function sameBones(a: Skeleton, b: Skeleton): boolean {
  if (a === b || a.bones.length !== b.bones.length) return a === b;
  for (let i = 0; i < a.bones.length; i++) {
    if (a.bones[i] !== b.bones[i] || !a.boneInverses[i]!.equals(b.boneInverses[i]!)) return false;
  }
  return true;
}
