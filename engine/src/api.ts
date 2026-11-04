/**
 * What the site may call. The shape follows Khada's window API (docs/re/khada-re.md)
 * so the panels and shortcuts map one to one; loadModel takes a model id, and
 * clips are streamed, so playing one is async.
 */
export interface EngineOptions {
  /** Pack base URL, no trailing slash. */
  packBase: string;
  /** True on the viewer page: full controls, shortcuts. False for a hero preview. */
  interactable?: boolean;
  /** Preview: default clip only, nothing else fetched. */
  lite?: boolean;
  animated?: boolean;
  cameraStyle?: "default" | "mobile";
  shadow?: boolean;
  shortcuts?: boolean;
  lockCamera?: boolean;
}

export interface ViewerEngine {
  /** Creates the renderer and starts nothing until a model loads. */
  mount(canvas: HTMLCanvasElement): Promise<void>;
  /** Newest call wins: an in-flight load is aborted, the old model stays on screen until the new one is ready. */
  loadModel(modelId: string): Promise<void>;
  dispose(): void;

  // Animation
  playNextAnimation(): Promise<void>;
  playPreviousAnimation(): Promise<void>;
  playAnimationByName(clipIdOrTPose: string): Promise<void>;
  playPlaylist(clipIds: string[]): Promise<void>;
  updatePlaylist(clipIds: string[]): void;
  stopPlaylistChain(): void;
  jumpChainTo(oneBasedIndex: number): void;
  togglePauseAnimation(): void;
  pauseAnimation(): void;
  playAnimation(): void;
  isAnimationPaused(): boolean;
  goToNextTimeScale(): void;
  setAnimationTime(seconds: number): void;
  setAnimationTimePercent(percent: number): void;
  getAnimationDuration(): number;
  getCurrentAnimationTime(): number;

  // View
  fullscreen(): void;
  toggleWatermark(): void;
  mirrorModel(): void;
  setBackgroundColor(css: string | null): void;
  centerModel(transition?: boolean): void;
  toggleShadows(): void;
  toggleSkeleton(): void;
  toggleAllWireframes(): void;
  setAutoRotationSpeed(radiansPerSecond: number): void;
  showAllParts(): void;
  hideAllParts(): void;

  // Parts
  toggleMaterialByHash(hash: number): void;
  toggleWireframeByHash(hash: number): void;
  toggleTransparencyByHash(hash: number): void;
  toggleDepthWriteByHash(hash: number): void;
  setOpacityByHash(hash: number, opacity: number): void;
  setTextureByHash(hash: number, dataUrl: string): Promise<void>;
  setAutomaticMaterialVisibility(on: boolean): void;

  // Customization (bodies). Geosets toggle instantly; textures re-composite once.
  setGeoset(group: number, value: number): void;

  // Export
  exportPNG(scale: number, trim: boolean): Promise<void>;
  exportSTL(): Promise<void>;
  exportGLB(minimal: boolean, removeHidden: boolean): Promise<void>;
  recordLive(onTick: (seconds: number) => void): { stop(): Promise<void> };
  exportMP4(opts: {
    fps: number;
    signal: AbortSignal;
    onProgress: (fraction: number, phase: "capture" | "encode") => void;
  }): Promise<void>;

  // XR
  isXRAvailable(): boolean;
  startXR(): Promise<void>;

  // Numbers
  getFrameStats(): import("./stores").FrameStats | null;
  resetFrameStats(): void;
}

/**
 * Attached to `window` as `eclipse` so tests read the same numbers Khada's
 * `getFrameStats` gives, plus what the proofs need.
 */
export interface EngineDebug {
  /** renderer.info: geometries, textures, programs, calls, triangles. */
  gpu(): { geometries: number; textures: number; programs: number; calls: number; triangles: number };
  /** Frames rendered since load. */
  frames(): number;
  /** ms from loadModel call to first drawn frame of the last load. */
  lastLoadMs(): number;
  /** Bytes fetched for the last load. */
  lastLoadBytes(): number;
}
