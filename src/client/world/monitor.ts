import * as THREE from 'three';
import { fontRevision } from '../fonts';
import type { ScreenState } from './laptop';
import { paintScreen } from './laptop';
import { ANISOTROPY } from './texture-quality';

/**
 * A monitor that shows a live terminal (the boss's shell) on a screen mesh already in the room.
 * The mesh keeps its OLED material; this only puts the terminal on it.
 */
export class MonitorScreen {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private drawnVersion = -1;
  private drawnFonts = -1;
  private paintedAt = 0;

  constructor(private readonly screen: THREE.Mesh) {
    this.canvas.width = 1600;
    this.canvas.height = 900;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = ANISOTROPY;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    const mat = screen.material as THREE.MeshBasicMaterial;
    mat.map = this.texture;
    // The mesh starts black, which would multiply the terminal down to nothing.
    mat.color.set('#ffffff');
    this.paint(undefined);
  }

  /** Repaints when the shell's screen changes, and again once the terminal font has loaded. */
  update(state: ScreenState | undefined) {
    const version = state ? state.version : -1;
    const fonts = fontRevision();
    const now = performance.now();
    if ((version !== this.drawnVersion || fonts !== this.drawnFonts) && (now - this.paintedAt > 150 || this.drawnVersion < 0)) {
      this.paintedAt = now;
      this.drawnVersion = version;
      this.drawnFonts = fonts;
      this.paint(state);
    }
  }

  /** Where the screen is and which way it faces, for the light it throws. */
  glow(pos: THREE.Vector3, dir: THREE.Vector3): number {
    this.screen.getWorldPosition(pos);
    dir.set(0, 0, 1).transformDirection(this.screen.matrixWorld);
    return 0.85;
  }

  private paint(state: ScreenState | undefined) {
    paintScreen(this.ctx, this.canvas.width, this.canvas.height, state, 'booting…', 22);
    this.texture.needsUpdate = true;
  }
}
