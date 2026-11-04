/**
 * TEST DOUBLE, never in a production build unless engine/ is missing. It implements
 * the ViewerEngine contract against the same stores, so the panels and the room can
 * be proven without WebGL or packs. Every call lands in `window.__engineCalls`.
 */
import { $autoRotationSpeed, $autoVisibility, $backgroundColor, $clipLoading, $clips, $currentClip, $customization, $effects, $error, $look, $loading, $manifest, $parts, $paused, $physics, $playlist, $progress, $shadows, $skeleton, $timeScale, $watermark, $wireframe } from "@eclipse/engine/stores";
import type { EngineOptions, ViewerEngine } from "@eclipse/engine/api";
import type { ClipEntry, CustomizationData, Look, ModelManifest } from "@eclipse/format";

interface Win extends Window {
  __engineCalls?: { name: string; args: unknown[]; at: number }[];
  __engineStub?: boolean;
  __figures?: Set<HTMLElement>;
  __engineFail?: boolean;
}
const win = window as Win;
win.__engineCalls ??= [];
win.__engineStub = true;
win.__figures ??= new Set();

const clip = (id: string, name: string, animId: number, variation = 0): ClipEntry => ({ id, name, animId, variation, durationMs: 2000, loops: true, key: "", bytes: 0 });
const CLIPS: ClipEntry[] = [clip("0.0", "Stand", 0), clip("4.0", "Walk", 4), clip("5.0", "Run", 5), clip("13.0", "Walk Backwards", 13), clip("69.0", "Dance", 69), clip("69.1", "Dance", 69, 1)];

function manifestFor(id: string): ModelManifest {
  return {
    formatVersion: 1, id, kind: id.startsWith("mount") ? "mount" : "body", name: id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), build: "stub",
    source: { m2: 0, skin: 0 }, glb: { key: "", bytes: 0 }, bounds: { min: [0, 0, 0], max: [1, 2, 1] }, boneCount: 1, clips: CLIPS, defaultClip: "0.0", textures: [],
    defaultGeosets: [1, 101, 701], attachments: [], warnings: [],
    ...(id.startsWith("mount") ? {} : { customization: { key: "stub", bytes: 1 }, look: STUB_LOOK }),
  };
}

const STUB_LOOK: Look = { 1: 10, 2: 20, 3: 30 };
const stubCustomization = (id: string): CustomizationData => ({
  formatVersion: 1, id, chrModel: 1, width: 1024, height: 512, textures: [], boneSets: [], layers: [], modelTextures: [], baseMats: [], parts: [], owned: [], has: [],
  tabs: [{ id: 2, name: "Face", order: 1, zoom: 100 }, { id: 23, name: "Mirror", order: 2, zoom: 100 }],
  options: [
    { id: 1, name: "Hair Style", tab: 2, choices: [
      { id: 10, name: "Peasant", req: 3, cls: -1, geo: [[0, 2, 0]] },
      { id: 11, name: "Soldier", req: 3, cls: -1, geo: [[0, 3, 0]] },
      { id: 12, name: "Monk", req: 3, cls: -1, geo: [[0, 4, 0]] },
    ] },
    { id: 2, name: "Hair Color", tab: 2, choices: [
      { id: 20, name: "", sw: ["#3a3a3c"], req: 3, cls: -1, geo: [[3, 2, 0]] },
      { id: 21, name: "Blonde", sw: ["#c8a040", "#a08030"], req: 3, cls: -1, geo: [[3, 3, 0]] },
      { id: 22, name: "", sw: ["#301010"], req: 3, cls: 32, geo: [[3, 4, 0]] },
    ] },
    { id: 3, name: "Ears", tab: 23, choices: [
      { id: 30, name: "Round", req: 3, cls: -1, geo: [[7, 2, 0]] },
      { id: 31, name: "Point", req: 3, cls: -1, geo: [[7, 3, 0]] },
    ] },
  ],
});

const PARTS = [
  { hash: 1, name: "Body", geoset: 1 }, { hash: 2, name: "Hair 1", geoset: 2 }, { hash: 3, name: "Hair 2", geoset: 3 }, { hash: 4, name: "Facial hair 1", geoset: 101 },
  { hash: 5, name: "Facial hair 2", geoset: 102 }, { hash: 6, name: "Ears 1", geoset: 701 }, { hash: 7, name: "Ears 2", geoset: 702 }, { hash: 8, name: "Gloves", geoset: 401 }, { hash: 9, name: "Gloves 2", geoset: 402 },
].map((p) => ({ ...p, visible: true, wireframe: false, transparent: false, depthWrite: true, opacity: 1 }));

const SCALES = [0.1, 0.5, 1, 2];

export function createEngine(_options: EngineOptions): ViewerEngine {
  let time = 0;
  let last = performance.now();
  let raf = 0;
  const track = <T extends object>(o: T): T => new Proxy(o, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (!/^(get|is)[A-Z]/.test(String(prop))) win.__engineCalls!.push({ name: String(prop), args, at: performance.now() });
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const loop = () => {
    const now = performance.now();
    if (!$paused.get()) time = (time + ((now - last) / 1000) * $timeScale.get()) % 2;
    last = now;
    raf = requestAnimationFrame(loop);
  };
  const step = (d: number) => {
    const ids = ["T-Pose", ...CLIPS.map((c) => c.id)];
    const at = Math.max(0, ids.indexOf($currentClip.get() ?? "T-Pose"));
    $currentClip.set(ids[(at + d + ids.length) % ids.length]!);
    time = 0;
  };
  const patch = (hash: number, f: (p: (typeof PARTS)[number]) => Partial<(typeof PARTS)[number]>) => {
    $parts.set($parts.get().map((p) => (p.hash === hash ? { ...p, ...f(p as (typeof PARTS)[number]) } : p)));
  };
  return track<ViewerEngine>({
    async mount(canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "rgba(255,255,255,.05)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      raf = requestAnimationFrame(loop);
    },
    async loadModel(id) {
      $loading.set(true);
      $progress.set(0.5);
      await new Promise((r) => setTimeout(r, 30));
      if (win.__engineFail) {
        $error.set("stub failure");
        $loading.set(false);
        return;
      }
      $error.set(null);
      const m = manifestFor(id);
      $customization.set(null);
      $look.set(m.look ?? null);
      $manifest.set(m);
      $clips.set(m.clips);
      $parts.set(PARTS);
      $currentClip.set(m.defaultClip);
      $progress.set(1);
      $loading.set(false);
    },
    dispose() { cancelAnimationFrame(raf); },
    async playNextAnimation() { step(1); },
    async playPreviousAnimation() { step(-1); },
    async playAnimationByName(id) { $currentClip.set(id); time = 0; },
    async playPlaylist(ids) { $playlist.set(ids); $currentClip.set(ids[0] ?? null); },
    updatePlaylist(ids) { $playlist.set(ids); },
    stopPlaylistChain() { $playlist.set([]); },
    jumpChainTo(i) { const id = $playlist.get()[i - 1]; if (id) $currentClip.set(id); },
    togglePauseAnimation() { $paused.set(!$paused.get()); },
    pauseAnimation() { $paused.set(true); },
    playAnimation() { $paused.set(false); },
    isAnimationPaused() { return $paused.get(); },
    goToNextTimeScale() { const i = SCALES.indexOf($timeScale.get()); $timeScale.set(SCALES[(i + 1) % SCALES.length]!); $paused.set(false); },
    setAnimationTime(s) { $paused.set(true); time = s; },
    setAnimationTimePercent(p) { $paused.set(true); time = p * 2; },
    getAnimationDuration() { return $currentClip.get() && $currentClip.get() !== "T-Pose" ? 2 : 0; },
    getCurrentAnimationTime() { return time; },
    fullscreen() {},
    toggleWatermark() { $watermark.set(!$watermark.get()); },
    mirrorModel() {},
    setBackgroundColor(css) { $backgroundColor.set(css); },
    centerModel() {},
    toggleShadows() { $shadows.set(!$shadows.get()); },
    setEffects(on) { $effects.set(on); },
    setPhysics(on) { $physics.set(on); },
    toggleSkeleton() { $skeleton.set(!$skeleton.get()); },
    toggleAllWireframes() { $wireframe.set(!$wireframe.get()); },
    setAutoRotationSpeed(v) { $autoRotationSpeed.set(v); },
    showAllParts() { $parts.set($parts.get().map((p) => ({ ...p, visible: true }))); },
    hideAllParts() { $parts.set($parts.get().map((p) => ({ ...p, visible: false }))); },
    toggleMaterialByHash(h) { patch(h, (p) => ({ visible: !p.visible })); },
    toggleWireframeByHash(h) { patch(h, (p) => ({ wireframe: !p.wireframe })); },
    toggleTransparencyByHash(h) { patch(h, (p) => ({ transparent: !p.transparent })); },
    toggleDepthWriteByHash(h) { patch(h, (p) => ({ depthWrite: !p.depthWrite })); },
    setOpacityByHash(h, v) { patch(h, () => ({ opacity: v })); },
    async setTextureByHash() {},
    setAutomaticMaterialVisibility(on) { $autoVisibility.set(on); },
    setGeoset() {},
    async loadCustomization() {
      const m = $manifest.get();
      if (!m?.customization) return null;
      const d = stubCustomization(m.id);
      $customization.set(d);
      return d;
    },
    async setLook(look) { $look.set(look); },
    prefetchLook() {},
    async equip() {},
    async previewEquip() {},
    setSheathed() {},
    async setRider() {},
    focusSlot() {},
    addFigureCell(el) { win.__figures!.add(el); return () => win.__figures!.delete(el); },
    async exportPNG() {},
    async exportSTL() {},
    async exportGLB() {},
    recordLive(onTick) { let s = 0; const id = setInterval(() => onTick(++s), 1000); return { async stop() { clearInterval(id); } }; },
    async exportMP4(opts) {
      for (let i = 0; i <= 10; i++) {
        if (opts.signal.aborted) throw new DOMException("cancelled", "AbortError");
        opts.onProgress(i / 10, i < 7 ? "capture" : "encode");
        await new Promise((r) => setTimeout(r, 120));
      }
    },
    isXRAvailable() { return false; },
    async startXR() {},
    getFrameStats() { return null; },
    resetFrameStats() {},
  });
}
