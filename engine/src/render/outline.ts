/**
 * The hover outline, loaded the first time a part is hovered. The values are
 * Khada's. His gamma pass is left out because this pipeline's shaders already write
 * gamma-space colour, and so the edge colours go in unconverted.
 */
import { LinearSRGBColorSpace, Vector2, type Mesh, type PerspectiveCamera, type Scene, type WebGLRenderer } from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OUTLINE } from "../constants";
import type { Part } from "../model/figure";

export class OutlineRig {
  active = false;
  private readonly composer: EffectComposer;
  private readonly pass: OutlinePass;
  private hovered: readonly Part[] = [];

  constructor(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, width: number, height: number) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.pass = new OutlinePass(new Vector2(width, height), scene, camera);
    this.pass.visibleEdgeColor.setHex(OUTLINE.edge, LinearSRGBColorSpace);
    this.pass.hiddenEdgeColor.setHex(OUTLINE.hidden, LinearSRGBColorSpace);
    this.pass.edgeStrength = OUTLINE.strength;
    this.pass.edgeGlow = OUTLINE.glow;
    this.pass.edgeThickness = OUTLINE.thickness;
    this.pass.pulsePeriod = OUTLINE.pulse;
    this.composer.addPass(this.pass);
  }

  select(parts: readonly Part[]): void {
    this.hovered = parts;
    this.pass.selectedObjects = parts.map((p) => p.mesh as Mesh);
    this.active = parts.length > 0;
  }

  render(all: readonly Part[], dt: number): void {
    const hovered = this.hovered;
    // A part hidden by the look shows faintly while hovered.
    const wasHidden: Part[] = [];
    for (const part of hovered) {
      if (!part.mesh.visible) {
        wasHidden.push(part);
        part.mesh.visible = true;
        part.material.setUserTransparent(true);
        part.material.uniforms.uUserOpacity.value = OUTLINE.hiddenOpacity;
      }
    }
    for (const part of all) {
      if (!hovered.includes(part) && part.mesh.visible) part.material.uniforms.uTint.value.setScalar(OUTLINE.dimOthers);
    }
    this.composer.render(dt);
    for (const part of all) part.material.uniforms.uTint.value.setScalar(1);
    for (const part of wasHidden) {
      part.mesh.visible = false;
      part.material.setUserTransparent(false);
      part.material.uniforms.uUserOpacity.value = 1;
    }
  }

  resize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.pass.resolution.set(width, height);
  }

  dispose(): void {
    this.pass.dispose();
    this.composer.dispose();
  }
}
