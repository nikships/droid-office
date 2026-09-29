/**
 * World-space panels as WebXR quad layers. The world renders below the headset's native
 * resolution to hold the frame rate (see XR_FRAMEBUFFER_SCALE in session.ts), which would blur
 * panel text; a quad layer is composited by the runtime straight from the panel's canvas at its
 * own resolution instead. Each layered panel's mesh punches its shape out of the world pass
 * (WorldPanel.setPunch), so the layer behind the projection layer shows through exactly where
 * the panel would have drawn: walls still hide depth-tested panels, and ray dots drawn later
 * still land on top.
 *
 * Needs the session's `layers` feature and a projection layer. Without either, or past the
 * runtime's layer budget, panels simply stay textured meshes. The world must stay on three's
 * XRProjectionLayer: in a session with the `layers` feature, Chrome on Galaxy XR shows an
 * XRWebGLLayer as solid black (measured: the same red clear shows without the feature and is
 * black with it, with or without quad layers), and a black frame looks cheaper than it is.
 */

import * as THREE from 'three';
import type { WorldPanel } from './panel';

interface Entry {
  layer: XRQuadLayer;
  uploaded: number;
  w: number;
  h: number;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();

/** Whether an object and every ancestor up to the scene root is visible. */
function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/**
 * Which panels get a layer: visible ones, frontmost (highest draw order) first, up to the budget.
 * Pure, so the host tests drive it.
 */
export function pickLayered<T extends { order: number }>(visible: readonly T[], budget: number): T[] {
  return [...visible].sort((a, b) => b.order - a.order).slice(0, Math.max(0, budget));
}

export class PanelLayers {
  private entries = new Map<WorldPanel, Entry>();
  private binding: XRWebGLBinding | null = null;
  private applied: XRLayer[] = [];
  private failed = false;

  constructor(private renderer: THREE.WebGLRenderer) {}

  /**
   * Syncs layers to the panels for this frame. Call after the panels move and repaint, before the
   * world renders. A runtime that rejects the layer calls turns layers off for the session rather
   * than taking the frame (and the whole view) down with it.
   */
  update(panels: readonly WorldPanel[], dolly: THREE.Object3D): void {
    if (this.failed) return;
    try {
      this.sync(panels, dolly);
    } catch (err) {
      console.warn('[vr] compositor layers off:', err);
      try {
        this.clear();
      } catch {
        this.reset();
      }
      this.failed = true;
      this.renderer.resetState();
    }
  }

  private sync(panels: readonly WorldPanel[], dolly: THREE.Object3D): void {
    const xr = this.renderer.xr;
    if (typeof XRProjectionLayer === 'undefined' || typeof xr.getSession !== 'function') return;
    const session = xr.getSession();
    const frame = xr.getFrame();
    const base = xr.getBaseLayer();
    const space = xr.getReferenceSpace();
    if (!session || !frame || !space || !session.enabledFeatures?.includes('layers') || !(base instanceof XRProjectionLayer)) {
      this.clear();
      return;
    }
    this.binding ??= xr.getBinding();
    const binding = this.binding;
    if (!binding || typeof binding.createQuadLayer !== 'function') return;

    // One slot is the world's projection layer. Not in the webxr typings yet (Chrome reports 7 on Galaxy XR).
    const budget = ((session as XRSession & { maxRenderLayers?: number }).maxRenderLayers ?? 1) - 1;
    const want = pickLayered(
      panels.filter((p) => shown(p.mesh)),
      budget,
    );
    const keep = new Set(want);
    for (const [panel, e] of this.entries) {
      if (keep.has(panel)) continue;
      panel.setPunch(false);
      e.layer.destroy();
      this.entries.delete(panel);
    }

    dolly.updateWorldMatrix(true, false);
    _inv.copy(dolly.matrixWorld).invert();
    const gl = this.renderer.getContext();
    // updateRenderState applies from the next frame; until a layer is in the active state,
    // getSubImage on it throws.
    const active = new Set(session.renderState.layers ?? []);
    let touchedGl = false;
    for (const panel of want) {
      const canvas = panel.source;
      let e = this.entries.get(panel);
      if (e && (e.w !== canvas.width || e.h !== canvas.height)) {
        e.layer.destroy();
        this.entries.delete(panel);
        e = undefined;
      }
      panel.mesh.updateWorldMatrix(true, false);
      // The layer lives in the session's reference space; the dolly maps that space into the world.
      _m.multiplyMatrices(_inv, panel.mesh.matrixWorld).decompose(_pos, _quat, _scale);
      if (!e) {
        let layer: XRQuadLayer;
        try {
          layer = binding.createQuadLayer({ space, viewPixelWidth: canvas.width, viewPixelHeight: canvas.height, layout: 'mono', width: panel.width * _scale.x, height: panel.height * _scale.y });
        } catch {
          continue;
        }
        e = { layer, uploaded: -1, w: canvas.width, h: canvas.height };
        this.entries.set(panel, e);
      }
      e.layer.transform = new XRRigidTransform({ x: _pos.x, y: _pos.y, z: _pos.z }, { x: _quat.x, y: _quat.y, z: _quat.z, w: _quat.w });
      // Untouched layers keep showing their last image, so only a repaint (or a runtime that lost the image) uploads.
      if (active.has(e.layer) && (e.uploaded !== panel.paintVersion || e.layer.needsRedraw)) {
        const sub = binding.getSubImage(e.layer, frame);
        gl.bindTexture(gl.TEXTURE_2D, sub.colorTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        e.uploaded = panel.paintVersion;
        touchedGl = true;
      }
      // Until its first image lands, the panel keeps drawing on its mesh.
      panel.setPunch(e.uploaded >= 0);
    }
    // Raw GL above moved bindings behind three's back.
    if (touchedGl) this.renderer.resetState();

    // Back to front: the frontmost panel composites last among the quads, the world over all of them.
    const next: XRLayer[] = [...want]
      .reverse()
      .map((p) => this.entries.get(p)?.layer)
      .filter((l): l is XRQuadLayer => !!l);
    next.push(base);
    if (next.length !== this.applied.length || next.some((l, i) => l !== this.applied[i])) {
      session.updateRenderState({ layers: next });
      this.applied = next;
    }
  }

  /** Drops every layer and puts the panels back on their meshes. */
  clear(): void {
    if (!this.entries.size && !this.applied.length) return;
    for (const [panel, e] of this.entries) {
      panel.setPunch(false);
      e.layer.destroy();
    }
    this.entries.clear();
    const session = this.renderer.xr.getSession();
    const base = this.renderer.xr.getBaseLayer();
    if (session && this.applied.length > 1 && typeof XRProjectionLayer !== 'undefined' && base instanceof XRProjectionLayer) session.updateRenderState({ layers: [base] });
    this.applied = [];
  }

  /** Session end: the session owns the layers, so only the bookkeeping and the panels reset. */
  reset(): void {
    for (const panel of this.entries.keys()) panel.setPunch(false);
    this.entries.clear();
    this.applied = [];
    this.binding = null;
    this.failed = false;
  }
}
