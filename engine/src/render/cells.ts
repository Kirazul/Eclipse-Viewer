/**
 * Live 3D grid cells: one page-wide canvas and one WebGL context over the grid, each
 * visible cell drawn into its own rectangle by scissor (three.js's multiple-elements
 * approach). Cells on one body share its geometry, textures, programs, skeleton and
 * pose; what differs per cell is which parts show, the composite, the pieces.
 *
 * The drawing buffer is preserved, so a cell not redrawn this frame keeps its pixels.
 * That is the rate cap: with many visible, only a budget of cells redraws per frame,
 * round robin, and the budget shrinks if the pass takes too long. The main stage has
 * its own context, so the cost it feels here is main-thread time only.
 */
import {
  Box3,
  LinearFilter,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Skeleton,
  type Texture,
  type WebGLRenderTarget,
} from "three";
import { packUrl, paths, type ItemManifest, type SetManifest, type SlotId, type Vec3 } from "@eclipse/format";
import { CAMERA, CELLS } from "../constants";
import { FrameStatsRing } from "../logic/frameStats";
import { WEAPON_SLOTS, slotView } from "../logic/slots";
import { fetchJson, isAbort } from "../net/fetchPack";
import { ModelAssets, type LoadEnv } from "../model/assets";
import { Figure } from "../model/figure";
import { CompositeRenderer } from "../wow/composite";
import { ItemLibrary, planOutfit, type Piece, type ResolvedItem } from "../wow/outfit";

interface SharedBody {
  figure: Figure;
  scene: Scene;
  library: ItemLibrary;
  composites: Map<string, WebGLRenderTarget>;
  base: Texture | null;
  /** Bumped per frame: the shared skeleton uploads once however many cells draw it. */
  stamp: number;
  updatedAt: number;
  matricesAt: number;
  uses: number;
}

interface Cell {
  el: HTMLElement;
  opts: CellOptions;
  camera: PerspectiveCamera;
  body: SharedBody | null;
  visibleGeosets: ReadonlySet<number> | null;
  composite: Texture | null;
  pieces: readonly Piece[];
  /** World box this cell frames. */
  focus: { min: Vec3; max: Vec3 } | null;
  onScreen: boolean;
  ready: boolean;
  needsDraw: boolean;
  width: number;
  height: number;
  rect: DOMRect | null;
  clip: HTMLElement[];
  removed: boolean;
}

export interface CellOptions {
  bodyId?: string;
  itemId?: string;
  setId?: string;
}

const UNIT_KEYS = ["uT0", "uT1", "uT2"] as const;
const POLAR = (75 * Math.PI) / 180;
const _size = new Vector2();
const _center = new Vector3();

export class FigureCells {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGLRenderer;
  private readonly env: LoadEnv;
  private readonly composer: CompositeRenderer;
  private readonly cells = new Set<Cell>();
  private readonly bodies = new Map<string, Promise<SharedBody>>();
  private readonly observer: IntersectionObserver;
  private raf = 0;
  private lastFrame = 0;
  private cursor = 0;
  private budget: number = CELLS.startBudget;
  private scrollX = -1;
  private scrollY = -1;
  private stamp = 0;
  private drawnLast = 0;
  /** Milliseconds of the cell pass, in the same ring the main stage reports. */
  readonly passStats = new FrameStatsRing();
  readonly intervalStats = new FrameStatsRing();
  private readonly passSamples: number[] = [];
  private readonly resizeListener = () => this.fitCanvas();

  constructor(base: string) {
    const canvas = document.createElement("canvas");
    canvas.dataset.eclipseCells = "";
    Object.assign(canvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
      zIndex: "5",
      pointerEvents: "none",
      willChange: "transform",
    });
    document.body.appendChild(canvas);
    this.canvas = canvas;

    const renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    renderer.toneMapping = NoToneMapping;
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    this.renderer = renderer;
    this.env = { base, renderer, anisotropy: () => 4 };
    this.composer = new CompositeRenderer(renderer);

    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const cell = this.cellOf(entry.target);
        if (!cell) continue;
        cell.onScreen = entry.isIntersecting;
        cell.needsDraw = cell.onScreen;
      }
      this.ensureLoop();
    });
    window.addEventListener("resize", this.resizeListener);
    this.fitCanvas();
  }

  private cellOf(el: Element): Cell | undefined {
    for (const c of this.cells) if (c.el === el) return c;
    return undefined;
  }

  private fitCanvas(): void {
    const w = document.documentElement.clientWidth;
    const h = document.documentElement.clientHeight;
    const size = this.renderer.getSize(_size);
    if (size.x !== w || size.y !== h) {
      this.renderer.setSize(w, h);
      // The buffer is new and empty: everything visible draws this frame.
      for (const c of this.cells) c.needsDraw = c.onScreen;
    }
  }

  add(el: HTMLElement, opts: CellOptions): () => void {
    const cell: Cell = {
      el,
      opts,
      camera: new PerspectiveCamera(CAMERA.fov, 1, 0.1, 100),
      body: null,
      visibleGeosets: null,
      composite: null,
      pieces: [],
      focus: null,
      onScreen: false,
      ready: false,
      needsDraw: false,
      width: 0,
      height: 0,
      rect: null,
      clip: clippingAncestors(el),
      removed: false,
    };
    this.cells.add(cell);
    this.observer.observe(el);
    void this.prepareCell(cell).catch((err) => {
      if (!isAbort(err)) console.warn("[eclipse] figure cell failed:", err);
    });
    return () => this.remove(cell);
  }

  private remove(cell: Cell): void {
    if (cell.removed) return;
    cell.removed = true;
    this.cells.delete(cell);
    this.observer.unobserve(cell.el);
    this.clearCell(cell);
    if (cell.body) cell.body.uses--;
  }

  private bodyFor(id: string): Promise<SharedBody> {
    let body = this.bodies.get(id);
    if (!body) {
      body = this.loadBody(id);
      this.bodies.set(id, body);
      body.catch(() => this.bodies.delete(id));
    }
    return body;
  }

  private async loadBody(id: string): Promise<SharedBody> {
    if (!id) throw new Error("a figure cell needs a bodyId, or a weapon item");
    const assets = await ModelAssets.load(id, this.env, { signal: new AbortController().signal });
    const figure = new Figure(assets);
    const scene = new Scene();
    scene.matrixWorldAutoUpdate = false;
    scene.add(figure.root);

    const shared: SharedBody = {
      figure,
      scene,
      library: new ItemLibrary(this.env, figure, 64),
      composites: new Map(),
      base: null,
      stamp: 0,
      updatedAt: -1,
      matricesAt: -1,
      uses: 0,
    };

    const c = assets.manifest.composite;
    if (c) {
      const w = Math.max(1, c.width >> (CELLS.compositeDivisor - 1));
      const h = Math.max(1, c.height >> (CELLS.compositeDivisor - 1));
      const k = w / c.width;
      const layers = assets.layers.flatMap(({ layer, texture }) =>
        texture ? [{ rect: scaled(layer.rect, k), blend: layer.blend, texture }] : [],
      );
      figure.baseComposite = this.composer.render(w, h, layers, 2);
      shared.base = figure.baseComposite.texture;
      figure.setComposite(shared.base);
    }

    const clipId = assets.defaultClip;
    const clip = clipId ? assets.clips.cached(clipId) : undefined;
    if (clip) {
      figure.mixer.clipAction(clip).play();
      figure.mixer.update(0);
    }
    figure.poseNow();
    gateSkeleton(figure.skeleton, shared);

    for (const t of figure.allTextures()) this.renderer.initTexture(t);
    await this.renderer.compileAsync(figure.root, new PerspectiveCamera(), scene);
    return shared;
  }

  private async prepareCell(cell: Cell): Promise<void> {
    const { itemId, setId } = cell.opts;
    const worn = new Map<SlotId, string>();
    let bodyId = cell.opts.bodyId;
    let alone: string | null = null;
    let focusSlot: SlotId | null = null;
    const signal = new AbortController().signal;

    if (setId) {
      const set = await fetchJson<SetManifest>(packUrl(this.env.base, paths.set(setId)), { signal });
      for (const [slot, id] of Object.entries(set.pieces)) worn.set(slot as SlotId, id);
    } else if (itemId) {
      const item = await fetchJson<ItemManifest>(packUrl(this.env.base, paths.item(itemId)), { signal });
      focusSlot = item.slot;
      if (WEAPON_SLOTS.includes(item.slot) && item.attached?.[0]) {
        // A weapon stands alone in its cell.
        alone = item.attached[0].manifest;
      } else {
        worn.set(item.slot, itemId);
      }
    }

    const body = await this.bodyFor(alone ?? bodyId ?? "");
    if (cell.removed) return;
    body.uses++;
    cell.body = body;

    const resolved = new Map<SlotId, ResolvedItem>();
    await Promise.all(
      [...worn].map(async ([slot, id]) => {
        resolved.set(slot, await body.library.resolve(id));
      }),
    );
    if (cell.removed) return;

    const plan = planOutfit(body.figure, resolved);
    for (const piece of plan.pieces) {
      if (piece.node.parent !== piece.parent) {
        piece.node.visible = false;
        piece.parent?.add(piece.node);
        body.scene.updateMatrixWorld(true);
        for (const t of piece.figure.allTextures()) this.renderer.initTexture(t);
        await this.renderer.compileAsync(piece.node, cell.camera, body.scene);
      }
    }
    cell.pieces = plan.pieces;
    cell.visibleGeosets = plan.visible;
    cell.composite = this.compositeFor(body, plan);

    const bounds = body.figure.assets.manifest.bounds;
    cell.focus = alone || !focusSlot ? bounds : slotView(focusSlot, bounds);
    cell.ready = true;
    cell.needsDraw = cell.onScreen;
    this.ensureLoop();
  }

  private compositeFor(body: SharedBody, plan: ReturnType<typeof planOutfit>): Texture | null {
    if (!plan.compositeKey) return body.base;
    let target = body.composites.get(plan.compositeKey);
    if (!target) {
      const c = body.figure.assets.manifest.composite!;
      const w = Math.max(1, c.width >> (CELLS.compositeDivisor - 1));
      const h = Math.max(1, c.height >> (CELLS.compositeDivisor - 1));
      const k = w / c.width;
      target = this.composer.render(
        w,
        h,
        plan.layers.map((l) => ({ ...l, rect: scaled(l.rect, k) })),
        2,
      );
      target.texture.minFilter = LinearFilter;
      body.composites.set(plan.compositeKey, target);
    }
    return target.texture;
  }

  // --- The frame ----------------------------------------------------------

  private ensureLoop(): void {
    if (this.raf) return;
    let any = false;
    for (const c of this.cells) if (c.onScreen && c.ready) any = true;
    if (!any) return;
    this.lastFrame = 0;
    this.intervalStats.gap();
    this.raf = requestAnimationFrame(this.frame);
  }

  private readonly frame = (): void => {
    this.raf = 0;
    const started = performance.now();
    const dt = this.lastFrame > 0 ? (started - this.lastFrame) / 1000 : 0;
    this.lastFrame = started;
    this.stamp++;

    const shown: Cell[] = [];
    for (const c of this.cells) if (c.onScreen && c.ready) shown.push(c);
    if (shown.length === 0) return;
    this.raf = requestAnimationFrame(this.frame);
    this.intervalStats.sample(started);

    // The canvas rides with the page: native scrolling keeps old pixels on their
    // cells between frames, and here it comes back to the viewport with fresh ones.
    const sx = window.scrollX;
    const sy = window.scrollY;
    let moved = sx !== this.scrollX || sy !== this.scrollY;
    if (moved) {
      this.scrollX = sx;
      this.scrollY = sy;
      this.canvas.style.transform = `translate(${sx}px, ${sy}px)`;
    }
    this.fitCanvas();

    // One pose per body and per piece, per frame.
    for (const c of shown) {
      const body = c.body!;
      if (body.updatedAt !== this.stamp) {
        body.updatedAt = this.stamp;
        body.stamp = this.stamp;
        body.figure.mixer.update(dt);
      }
      for (const piece of c.pieces) {
        if (piece.figure.poseStamp !== this.stamp) {
          piece.figure.poseStamp = this.stamp;
          piece.figure.mixer.update(dt);
        }
      }
    }
    for (const c of shown) {
      const body = c.body!;
      if (body.matricesAt !== this.stamp) {
        body.matricesAt = this.stamp;
        body.scene.updateMatrixWorld(true);
      }
    }

    for (const c of shown) {
      const rect = c.el.getBoundingClientRect();
      c.rect = rect;
      if (rect.width !== c.width || rect.height !== c.height) {
        c.width = rect.width;
        c.height = rect.height;
        frameCell(c, rect.width, rect.height);
        moved = true;
      }
    }
    if (moved) {
      this.renderer.setScissor(0, 0, this.renderer.getSize(_size).x, _size.y);
      this.renderer.clear(true, true, false);
    }

    let drawn = 0;
    if (moved || shown.length <= CELLS.everyFrameUpTo) {
      for (const c of shown) {
        this.drawCell(c, c.rect!);
        drawn++;
      }
    } else {
      for (const c of shown) {
        if (c.needsDraw) {
          this.drawCell(c, c.rect!);
          drawn++;
        }
      }
      for (let i = 0; i < shown.length && drawn < this.budget; i++) {
        this.cursor = (this.cursor + 1) % shown.length;
        const c = shown[this.cursor]!;
        this.drawCell(c, c.rect!);
        drawn++;
      }
    }
    this.drawnLast = drawn;

    const ms = performance.now() - started;
    this.passSamples.push(ms);
    if (this.passSamples.length > 3600) this.passSamples.shift();
    if (!moved) {
      if (ms > CELLS.frameMs) this.budget = Math.max(CELLS.minBudget, this.budget - 1);
      else if (ms < CELLS.frameMs / 2) this.budget = Math.min(CELLS.maxBudget, this.budget + 1);
    }
  };

  private drawCell(cell: Cell, rect: DOMRect): void {
    const r = this.renderer;
    const body = cell.body!;
    const h = r.getSize(_size).y;
    const x = rect.left;
    const y = h - rect.bottom;
    const clipped = clipRect(rect, cell.clip, h);
    cell.needsDraw = false;
    if (!clipped) return;

    r.setViewport(x, y, rect.width, rect.height);
    r.setScissor(clipped.x, clipped.y, clipped.w, clipped.h);
    r.clear(true, true, false);

    const figure = body.figure;
    for (const part of figure.parts) {
      part.mesh.visible = part.ready && (cell.visibleGeosets?.has(part.extras.geoset) ?? part.shown);
      if (part.usesComposite.length) {
        part.usesComposite.forEach((used, i) => {
          if (used) part.material.uniforms[UNIT_KEYS[i]!].value = cell.composite;
        });
      }
    }
    for (const piece of cell.pieces) piece.node.visible = true;
    r.render(body.scene, cell.camera);
    for (const piece of cell.pieces) piece.node.visible = false;
  }

  private clearCell(cell: Cell): void {
    if (!cell.onScreen) return;
    const rect = cell.el.getBoundingClientRect();
    const h = this.renderer.getSize(_size).y;
    this.renderer.setScissor(rect.left, h - rect.bottom, rect.width, rect.height);
    this.renderer.clear(true, true, false);
  }

  // --- Numbers ------------------------------------------------------------

  numbers(): {
    cells: number;
    visible: number;
    drawnLastFrame: number;
    budget: number;
    passP50Ms: number;
    passP99Ms: number;
    geometries: number;
    textures: number;
    programs: number;
    bodies: number;
    cellFps: number;
  } {
    const sorted = [...this.passSamples].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
    let visible = 0;
    for (const c of this.cells) if (c.onScreen && c.ready) visible++;
    const info = this.renderer.info;
    const interval = this.intervalStats.read();
    return {
      cells: this.cells.size,
      visible,
      drawnLastFrame: this.drawnLast,
      budget: this.budget,
      passP50Ms: at(50),
      passP99Ms: at(99),
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      bodies: this.bodies.size,
      cellFps: interval?.fps ?? 0,
    };
  }

  resetNumbers(): void {
    this.passSamples.length = 0;
    this.intervalStats.reset();
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener("resize", this.resizeListener);
    this.observer.disconnect();
    this.cells.clear();
    for (const body of this.bodies.values()) {
      void body.then((b) => {
        b.library.disposeAll();
        for (const rt of b.composites.values()) rt.dispose();
        b.figure.dispose();
      });
    }
    this.bodies.clear();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}

function scaled(rect: { x: number; y: number; w: number; h: number }, k: number) {
  return { x: rect.x * k, y: rect.y * k, w: rect.w * k, h: rect.h * k };
}

/** The skeleton uploads its bone texture once per frame, not once per cell. */
function gateSkeleton(skeleton: Skeleton | null, body: SharedBody): void {
  if (!skeleton) return;
  const update = skeleton.update.bind(skeleton);
  let last = -1;
  skeleton.update = () => {
    if (body.stamp === last) return;
    last = body.stamp;
    update();
  };
}

function frameCell(cell: Cell, width: number, height: number): void {
  const focus = cell.focus;
  if (!focus || height <= 0) return;
  const camera = cell.camera;
  camera.aspect = width / height;
  const box = new Box3(new Vector3(...focus.min), new Vector3(...focus.max));
  const size = box.getSize(new Vector3());
  box.getCenter(_center);
  const tan = Math.tan((CAMERA.fov * Math.PI) / 360);
  const fit = Math.max(size.y / (2 * tan), Math.max(size.x, size.z) / (2 * tan * camera.aspect)) * 1.12;
  const distance = fit + size.z / 2;
  camera.position.set(_center.x, _center.y + distance * Math.cos(POLAR), _center.z + distance * Math.sin(POLAR));
  camera.lookAt(_center);
  camera.near = Math.max(0.1, distance - size.length() * 2);
  camera.far = distance + size.length() * 3;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

/** Scroll containers a cell can be clipped by. */
function clippingAncestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.overflowX !== "visible" || s.overflowY !== "visible") out.push(p);
  }
  return out;
}

function clipRect(rect: DOMRect, clip: readonly HTMLElement[], canvasH: number): { x: number; y: number; w: number; h: number } | null {
  let left = Math.max(rect.left, 0);
  let top = Math.max(rect.top, 0);
  let right = Math.min(rect.right, window.innerWidth);
  let bottom = Math.min(rect.bottom, canvasH);
  for (const el of clip) {
    const r = el.getBoundingClientRect();
    left = Math.max(left, r.left);
    top = Math.max(top, r.top);
    right = Math.min(right, r.right);
    bottom = Math.min(bottom, r.bottom);
  }
  if (right <= left || bottom <= top) return null;
  return { x: left, y: canvasH - bottom, w: right - left, h: bottom - top };
}
