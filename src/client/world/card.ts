import * as THREE from 'three';
import { ANISOTROPY } from './texture-quality';
import type { CarriedIssue } from '../../shared/protocol';
import { NOTE_COLORS, PINS, wrap } from './boards';
import { toon, toonUnique } from './toon';
import { SANS, MONO } from '../fonts';

const W = 320;
const H = 240;

/**
 * An issue's card, taken off the issues board: a thin dark card like the board's own, with its pin,
 * the orange number over a hairline and the title on its front (+z). `width` is in meters.
 */
function issueCard(card: CarriedIssue, width: number): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  const color = NOTE_COLORS[card.issue % NOTE_COLORS.length];
  g.fillStyle = color;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255, 255, 255, .18)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, W - 3, H - 3);
  g.fillStyle = '#ee6018';
  g.font = `700 40px ${MONO}`;
  g.fillText(`#${card.issue}`, 22, 74);
  g.fillStyle = 'rgba(255, 255, 255, .1)';
  g.fillRect(0, 94, W, 2);
  g.fillStyle = '#eeeeee';
  g.font = `600 26px ${SANS}`;
  wrap(g, card.title, W - 44, 4).forEach((line, i) => g.fillText(line, 22, 134 + i * 30));
  // The pin it hung by, still through its head (plain rects: the tests' canvas stubs draw nothing else).
  g.fillStyle = '#2a2a2a';
  g.fillRect(W / 2 - 9, 9, 18, 18);
  g.fillStyle = PINS[card.issue % PINS.length];
  g.fillRect(W / 2 - 5, 13, 10, 10);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISOTROPY;
  const face = toonUnique('#ffffff');
  face.map = tex;
  const back = toon('#0a0a0a');
  // Box faces go +x, -x, +y, -y, +z, -z: the note is on the front.
  const m = new THREE.Mesh(new THREE.BoxGeometry(width, (width * H) / W, width * 0.02), [back, back, back, back, face, back]);
  m.castShadow = true;
  return m;
}

/** The issue card someone holds, under `parent`: swapped for another card, or dropped (null). */
export class HeldCard {
  private mesh: THREE.Mesh | null = null;
  private issue = 0;

  constructor(
    private parent: THREE.Object3D,
    private width: number,
  ) {}

  get held(): boolean {
    return this.mesh !== null;
  }

  set(card: CarriedIssue | null | undefined) {
    if ((card?.issue ?? 0) === this.issue) return;
    if (this.mesh) {
      this.parent.remove(this.mesh);
      this.mesh.geometry.dispose();
      const face = (this.mesh.material as THREE.MeshToonMaterial[])[4];
      face.map?.dispose();
      face.dispose();
      this.mesh = null;
    }
    this.issue = card?.issue ?? 0;
    if (!card) return;
    this.mesh = issueCard(card, this.width);
    this.parent.add(this.mesh);
  }
}
