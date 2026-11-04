/**
 * The Viewer tab: Khada's panels (Animations, Model Parts, Options, Export) on
 * Eclipse's cards, chips and switches. Open sections persist in `accordions`.
 */
import { useStore } from "@nanostores/react";
import {
  $autoRotationSpeed, $autoVisibility, $backgroundColor, $hoveredPart, $manifest, $parts, $paused, $shadows, $skeleton, $timeScale, $watermark, $wireframe,
  type PartRow,
} from "@eclipse/engine/stores";
import { ChevronDown, ChevronLeft, ChevronRight, CircleDot, Box, Clapperboard, Cuboid, Film, Image, Info, Layers, Pause, Play, SlidersHorizontal, Square, Upload, Download, Ellipsis } from "lucide-react";
import { Accordion, Popover, RadioGroup } from "radix-ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { art } from "../../lib/base";
import { attachScrub } from "../../lib/room/scrub";
import { $engine, $mounts, $races, $scene, DEFAULT_SCENE, SCENES } from "../../lib/room/state";
import { Modal, Range, Toggle } from "../ui/kit";
import { ClipPicker } from "./ClipPicker";
import { ColorPicker } from "./ColorPicker";

const ACCORDIONS = "accordions";
const DEFAULT_OPEN = ["item-information", "item-animations"];

function readOpen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ACCORDIONS) || "null");
    return Array.isArray(v) ? v : DEFAULT_OPEN;
  } catch { return DEFAULT_OPEN; }
}

function Section(props: { value: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Accordion.Item value={props.value} className="acc-item" data-section={props.value}>
      <Accordion.Header asChild>
        <div className="acc-head">
          <Accordion.Trigger className="acc-trigger">
            {props.icon}
            <span>{props.title}</span>
            <ChevronDown className="chev" aria-hidden="true" />
          </Accordion.Trigger>
        </div>
      </Accordion.Header>
      <Accordion.Content className="acc-body"><div className="acc-in">{props.children}</div></Accordion.Content>
    </Accordion.Item>
  );
}

// --- Information -----------------------------------------------------------------
function useCurrentEntry() {
  const manifest = useStore($manifest);
  const races = useStore($races);
  const mounts = useStore($mounts);
  return useMemo(() => {
    const id = manifest?.id;
    for (const r of races) {
      const b = r.bodies.find((x) => x.id === id);
      if (b) return { name: b.name, circle: b.circle, description: b.description };
    }
    const m = mounts.find((x) => x.id === id);
    if (m) return { name: m.name, circle: m.circle, description: m.description };
    return manifest ? { name: manifest.name, circle: "", description: undefined } : null;
  }, [manifest, races, mounts]);
}

function Information() {
  const e = useCurrentEntry();
  return (
    <>
      <div className="info-row">
        <img src={art(e?.circle)} alt="" width={56} height={56} decoding="async" />
        <div className="info-name">{e?.name ?? "Loading"}</div>
      </div>
      {e?.description && <p className="info-desc">{e.description}</p>}
    </>
  );
}

// --- Animations --------------------------------------------------------------------
function Scrubber() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => attachScrub(ref.current!), []);
  return <input ref={ref} className="range" type="range" min={0} max={1} step={0.001} defaultValue={0} aria-label="Animation timeline" data-ignore-arrows-shortcuts="true" />;
}

function Animations() {
  const engine = useStore($engine);
  const paused = useStore($paused);
  const scale = useStore($timeScale);
  return (
    <>
      <div className="anim-row">
        <button className="btn" type="button" aria-label="Previous animation" title="Previous animation (Left arrow)" onClick={() => void engine?.playPreviousAnimation()} data-testid="clip-prev"><ChevronLeft aria-hidden="true" /></button>
        <ClipPicker />
        <button className="btn" type="button" aria-label="Next animation" title="Next animation (Right arrow)" onClick={() => void engine?.playNextAnimation()} data-testid="clip-next"><ChevronRight aria-hidden="true" /></button>
      </div>
      <div className="anim-row">
        <button className="btn" type="button" aria-label={paused ? "Play" : "Pause"} title={`${paused ? "Play" : "Pause"} (P)`} onClick={() => engine?.togglePauseAnimation()}>
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        </button>
        <Scrubber />
        <button className="btn" type="button" aria-label="Speed" title="Speed (T)" style={{ padding: 0 }} onClick={() => engine?.goToNextTimeScale()}>
          <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12.5 }}>{scale}x</span>
        </button>
      </div>
    </>
  );
}

// --- Model parts --------------------------------------------------------------------
/** Retail's geoset groups in the game's words. The bake's "Submesh N" stays out of sight. */
const PART_GROUP: Record<number, string> = {
  0: "Hair", 1: "Facial hair", 2: "Beard", 3: "Sideburns", 4: "Gloves", 5: "Boots", 7: "Ears", 8: "Sleeves",
  9: "Legs", 10: "Undershirt", 11: "Pants", 12: "Tabard", 13: "Robe", 15: "Cape", 17: "Eyeglow", 18: "Belt", 19: "Tail", 20: "Feet", 32: "Face",
};
function partLabel(p: PartRow): string {
  if (p.name && !/^submesh\b/i.test(p.name)) return p.name;
  if (p.geoset <= 0) return "Body";
  const group = Math.floor(p.geoset / 100);
  const name = PART_GROUP[group] ?? "Detail";
  return `${name} ${(p.geoset % 100) || 1}`;
}

function PartMenu({ part }: { part: PartRow }) {
  const engine = useStore($engine);
  const file = useRef<HTMLInputElement>(null);
  const textureUrl = (engine as unknown as { getPartTextureUrl?: (h: number) => string | null })?.getPartTextureUrl?.(part.hash) ?? null;
  const replace = (f: File | undefined) => {
    if (!f || !engine) return;
    const reader = new FileReader();
    reader.onload = () => void engine.setTextureByHash(part.hash, String(reader.result));
    reader.readAsDataURL(f);
  };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="tool" type="button" aria-label={`${partLabel(part)} settings`}><Ellipsis aria-hidden="true" /></button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="pop pop-stack" side="left" align="start" sideOffset={8} collisionPadding={8}>
          <Toggle id={`${part.hash}-transparency`} label="Transparency" checked={part.transparent} onChange={() => engine?.toggleTransparencyByHash(part.hash)} />
          <Toggle id={`${part.hash}-depth`} label="Depth write" checked={part.depthWrite} onChange={() => engine?.toggleDepthWriteByHash(part.hash)} />
          <div>
            <div className="group-label">Opacity</div>
            <Range label="Opacity" min={0.1} max={1} step={0.01} value={part.opacity} onChange={(v) => engine?.setOpacityByHash(part.hash, v)} />
          </div>
          <div className="opt-divider" />
          {textureUrl && <a className="btn" href={textureUrl} download><Download aria-hidden="true" />Download texture</a>}
          <button className="btn" type="button" onClick={() => file.current?.click()}><Upload aria-hidden="true" />Replace texture</button>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => replace(e.target.files?.[0])} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ModelParts() {
  const parts = useStore($parts);
  const auto = useStore($autoVisibility);
  const engine = useStore($engine);
  return (
    <>
      <Toggle id="automatic-visibility" label="Auto hide and show" hint="Parts follow the animation." checked={auto} onChange={(v) => engine?.setAutomaticMaterialVisibility(v)} />
      <div>
        {parts.map((p) => (
          <div key={p.hash} className="part-row" data-part={p.hash} onMouseEnter={() => $hoveredPart.set(p.hash)} onMouseLeave={() => $hoveredPart.set(null)}>
            <Toggle id={`${p.hash}-visible`} label="" ariaLabel={partLabel(p)} checked={p.visible} disabled={auto} onChange={() => engine?.toggleMaterialByHash(p.hash)} />
            <label htmlFor={`${p.hash}-visible`}>{partLabel(p)}</label>
            <PartMenu part={p} />
          </div>
        ))}
      </div>
      <div className="flex justify-center gap-2">
        <button className="btn" type="button" disabled={auto} style={{ height: 28, fontSize: 13 }} onClick={() => engine?.showAllParts()}>Show all</button>
        <button className="btn" type="button" disabled={auto} style={{ height: 28, fontSize: 13 }} onClick={() => engine?.hideAllParts()}>Hide all</button>
      </div>
    </>
  );
}

// --- Options ------------------------------------------------------------------------
function sceneLabel(s: string) {
  return s === "deathknight" ? "Death Knight" : s.charAt(0).toUpperCase() + s.slice(1);
}

function Options() {
  const engine = useStore($engine);
  const shadows = useStore($shadows);
  const watermark = useStore($watermark);
  const skeleton = useStore($skeleton);
  const wireframe = useStore($wireframe);
  const speed = useStore($autoRotationSpeed);
  const background = useStore($backgroundColor);
  const scene = useStore($scene);
  const [xr, setXr] = useState(false);
  useEffect(() => {
    if (!engine) return;
    setXr(engine.isXRAvailable());
    const again = setTimeout(() => setXr(engine.isXRAvailable()), 1500);
    return () => clearTimeout(again);
  }, [engine]);
  const stage = document.getElementById("stage");
  const setBackground = (css: string | null) => {
    engine?.setBackgroundColor(css);
    $backgroundColor.set(css);
    // A flat colour replaces the scene; clearing it brings the scene back.
    if (css) $scene.set("off");
    else if ($scene.get() === "off") $scene.set(DEFAULT_SCENE);
    if (css) stage?.style.setProperty("--temporary-model-background-color", css);
    else stage?.style.removeProperty("--temporary-model-background-color");
  };
  useEffect(() => {
    stage?.style.setProperty("--model-background-image", watermark ? "" : "none");
  }, [watermark, stage]);
  return (
    <>
      <div className="opt-grid">
        <Toggle id="toggle-shadows" label="Shadows" checked={shadows} onChange={() => engine?.toggleShadows()} />
        <Toggle id="toggle-scene" label="Scene" checked={scene !== "off"} onChange={(v) => { if (v) setBackground(null); $scene.set(v ? DEFAULT_SCENE : "off"); }} />
      </div>
      <div>
        <div className="group-label">Auto rotation</div>
        <Range label="Auto rotation" min={0} max={3} step={0.1} value={speed} onChange={(v) => { engine?.setAutoRotationSpeed(v); $autoRotationSpeed.set(v); }} />
      </div>
      <div className="btn-grid">
        <button className="btn" type="button" onClick={() => engine?.fullscreen()} title="Full screen (F)">Full screen</button>
        <button className="btn" type="button" onClick={() => engine?.mirrorModel()}>Mirror</button>
        <button className="btn" type="button" onClick={() => engine?.centerModel(true)}>Recenter</button>
        {xr && <button className="btn" type="button" onClick={() => void engine?.startXR()}>Start XR</button>}
      </div>
      <ColorPicker value={background} onChange={setBackground} />
      <details className="adv">
        <summary className="group-label" style={{ margin: 0 }}>Advanced</summary>
        <div style={{ display: "grid", gap: 10, paddingTop: 10 }}>
          <div className="opt-grid">
            <Toggle id="toggle-watermark" label="Watermark" hint="Shows on a flat colour." checked={watermark} onChange={() => engine?.toggleWatermark()} />
            <Toggle id="toggle-skeleton" label="Skeleton" checked={skeleton} onChange={() => engine?.toggleSkeleton()} />
            <Toggle id="toggle-wireframe" label="Wireframe" checked={wireframe} onChange={() => engine?.toggleAllWireframes()} />
          </div>
          <div>
            <div className="group-label">Scene</div>
            <div className="flex flex-wrap gap-1.5">
              {SCENES.map((s) => (
                <button key={s} type="button" className={`chip${scene === s ? " on" : ""}`} onClick={() => { setBackground(null); $scene.set(s); }}>{sceneLabel(s)}</button>
              ))}
            </div>
          </div>
        </div>
      </details>
    </>
  );
}

// --- Export -------------------------------------------------------------------------
function Radio(props: { id: string; value: string; label: string; note?: string }) {
  return (
    <label className="radio-row" htmlFor={props.id}>
      <RadioGroup.Item id={props.id} value={props.value} className="radio">
        <RadioGroup.Indicator asChild><span /></RadioGroup.Indicator>
      </RadioGroup.Item>
      {props.label}
      {props.note && <span style={{ fontSize: 12.5, opacity: .7 }}>({props.note})</span>}
    </label>
  );
}

function Export() {
  const engine = useStore($engine);
  const [recording, setRecording] = useState<{ stop(): Promise<void> } | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [pngOpen, setPngOpen] = useState(false);
  const [quality, setQuality] = useState("2");
  const [trim, setTrim] = useState(false);
  const [glbOpen, setGlbOpen] = useState(false);
  const [glbMode, setGlbMode] = useState("minimal");
  const [removeHidden, setRemoveHidden] = useState(true);
  const [video, setVideo] = useState<{ fraction: number; phase: "capture" | "encode" } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    try { await job(); } finally { setBusy(false); }
  };
  const startRecord = () => {
    if (!engine) return;
    setSeconds(0);
    setRecording(engine.recordLive(setSeconds));
  };
  const stopRecord = async () => {
    const r = recording;
    setRecording(null);
    await r?.stop();
  };
  const exportVideo = async () => {
    if (!engine) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setVideo({ fraction: 0, phase: "capture" });
    try {
      await engine.exportMP4({ fps: 60, signal: ctrl.signal, onProgress: (fraction, phase) => setVideo({ fraction, phase }) });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) console.warn("[eclipse] video export failed", e);
    } finally {
      setVideo(null);
      abort.current = null;
    }
  };
  const stage = document.getElementById("stage");
  return (
    <>
      <button className="btn start block" type="button" disabled={!!recording || !engine} onClick={startRecord} data-testid="record">
        <CircleDot style={{ color: "#ef4444" }} aria-hidden="true" />Record
      </button>
      <div className="btn-grid">
        <button className="btn start" type="button" disabled={!engine} onClick={() => setPngOpen(true)}><Image aria-hidden="true" />.png</button>
        <button className="btn start" type="button" disabled={!engine || !!video || !!recording} onClick={() => void exportVideo()}><Film aria-hidden="true" />.mp4</button>
        <button className="btn start" type="button" disabled={!engine || busy} onClick={() => void run(() => engine!.exportSTL())}><Cuboid aria-hidden="true" />.stl</button>
        <button className="btn start" type="button" disabled={!engine} onClick={() => setGlbOpen(true)}><Box aria-hidden="true" />.glb</button>
      </div>

      {recording && stage && createPortal(
        <div className="rec-badge" data-testid="rec-badge">
          <span className="rec-dot" />
          <span>{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(Math.floor(seconds % 60)).padStart(2, "0")}</span>
          <button className="btn" type="button" style={{ height: 24, padding: "0 8px", fontSize: 12.5 }} onClick={() => void stopRecord()}><Square aria-hidden="true" />Stop</button>
        </div>,
        stage,
      )}

      <Modal
        open={pngOpen}
        onOpenChange={setPngOpen}
        title=".png"
        foot={<>
          <button className="btn" type="button" onClick={() => setPngOpen(false)}>Cancel</button>
          <button className="btn fill" type="button" onClick={() => { setPngOpen(false); void run(() => engine!.exportPNG(Number(quality), trim)); }}>Save</button>
        </>}
      >
        <RadioGroup.Root value={quality} onValueChange={setQuality} style={{ display: "grid", gap: 8 }} aria-label="Quality">
          <Radio id="q1" value="1" label="Low" />
          <Radio id="q2" value="2" label="Medium" />
          <Radio id="q3" value="3" label="High" />
        </RadioGroup.Root>
        <Toggle id="trim-empty-space" label="Trim empty space" checked={trim} onChange={setTrim} />
      </Modal>

      <Modal
        open={!!video}
        title=".mp4"
        foot={<button className="btn" type="button" onClick={() => abort.current?.abort()}>Cancel</button>}
      >
        <div style={{ fontSize: 13.5, opacity: .85 }}>{video?.phase === "encode" ? "Finishing the video" : "Capturing frames"}</div>
        <div className="bar" role="progressbar" aria-valuenow={Math.round((video?.fraction ?? 0) * 100)}><i style={{ transform: `scaleX(${video?.fraction ?? 0})` }} /></div>
      </Modal>

      <Modal
        open={glbOpen}
        onOpenChange={setGlbOpen}
        title=".glb"
        foot={<>
          <button className="btn" type="button" onClick={() => setGlbOpen(false)}>Cancel</button>
          <button className="btn fill" type="button" onClick={() => { setGlbOpen(false); void run(() => engine!.exportGLB(glbMode === "minimal", removeHidden)); }}>Save</button>
        </>}
      >
        <RadioGroup.Root value={glbMode} onValueChange={setGlbMode} style={{ display: "grid", gap: 8 }} aria-label="Size">
          <Radio id="glb-min" value="minimal" label="Minimal" note="current animation" />
          <Radio id="glb-all" value="entire" label="Entire" note="all animations" />
        </RadioGroup.Root>
        <Toggle id="remove-hidden" label="Remove hidden parts" checked={removeHidden} onChange={setRemoveHidden} />
      </Modal>
    </>
  );
}

export function ViewerPanels() {
  const [open] = useState(readOpen);
  return (
    <Accordion.Root
      type="multiple"
      defaultValue={open}
      onValueChange={(v) => { try { localStorage.setItem(ACCORDIONS, JSON.stringify(v)); } catch { /* private window */ } }}
      className="viewer-pane scroll-none"
      data-testid="viewer-panels"
    >
      <Section value="item-information" icon={<Info aria-hidden="true" />} title="Information"><Information /></Section>
      <Section value="item-animations" icon={<Clapperboard aria-hidden="true" />} title="Animations"><Animations /></Section>
      <Section value="item-model-parts" icon={<Layers aria-hidden="true" />} title="Model parts"><ModelParts /></Section>
      <Section value="item-options" icon={<SlidersHorizontal aria-hidden="true" />} title="Options"><Options /></Section>
      <Section value="item-export" icon={<Download aria-hidden="true" />} title="Export"><Export /></Section>
    </Accordion.Root>
  );
}
