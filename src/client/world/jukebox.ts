import * as THREE from 'three';
import { ANISOTROPY } from './texture-quality';
import { JUKEBOX } from '../../shared/layout';
import { mesh, roundedBox, textSprite, toon, toonUnique } from './toon';
import { MONO } from '../fonts';
import { track } from './toon';
import type { Collider, Interactable } from './office';

// The lounge jukebox: a graphite cabinet with a rounded top, an LED tube round its face that
// glows Factory orange to the beat while it plays, a little display saying what's on, and notes floating up.

export interface JukeboxView {
  group: THREE.Group;
  collider: Collider;
  interactable: Interactable;
  /** What the display says, and whether the lights are on. */
  show(on: boolean, title: string): void;
  /** `beat` runs 1 → 0 after each beat while music plays (see OfficeSound.beat). */
  update(t: number, dt: number, beat: number): void;
}

const NOTES = ['♪', '♫', '♪', '♬', '♫'];

export function buildJukebox(): JukeboxView {
  const { width: W, depth: D, height: H } = JUKEBOX;
  const r = W / 2;
  const group = new THREE.Group();

  // The cabinet: a tombstone shape, straight sides under a half-round top.
  const shape = new THREE.Shape();
  shape.moveTo(-r, 0);
  shape.lineTo(r, 0);
  shape.lineTo(r, H - r);
  shape.absarc(0, H - r, r, 0, Math.PI, false);
  shape.lineTo(-r, 0);
  const body = new THREE.ExtrudeGeometry(shape, { depth: D, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2, curveSegments: 24 });
  body.translate(0, 0, -D / 2);
  group.add(mesh(body, toon('#1c1c1c')));
  group.add(mesh(new THREE.BoxGeometry(W + 0.12, 0.1, D + 0.12), toon('#0a0a0a'), 0, 0.05, 0));

  const front = D / 2 + 0.035;
  // The LED tube: up one side, over the arch and down the other.
  const neon = toonUnique('#3a3a3a');
  neon.emissive = new THREE.Color('#5a2208');
  const tubeR = r - 0.1;
  const legLen = H - r - 0.3;
  group.add(mesh(new THREE.TorusGeometry(tubeR, 0.045, 8, 36, Math.PI), neon, 0, H - r, front, false));
  for (const sx of [-1, 1]) group.add(mesh(new THREE.CylinderGeometry(0.045, 0.045, legLen, 8), neon, sx * tubeR, 0.3 + legLen / 2, front, false));

  // The display in the arch: what's playing.
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISOTROPY;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.82, 0.41), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.position.set(0, H - r + 0.02, front + 0.005);
  group.add(screen);

  // Selector buttons, and the speaker grille below them.
  ['#3a3a3a', '#3a3a3a', '#ee6018', '#3a3a3a', '#3a3a3a'].forEach((c, i) => group.add(mesh(roundedBox(0.1, 0.05, 0.05, 0.008), toon(c), (i - 2) * 0.14, 0.98, front, false)));
  group.add(mesh(new THREE.BoxGeometry(0.82, 0.52, 0.03), toon('#0a0a0a'), 0, 0.58, front - 0.01, false));
  for (let i = 0; i < 5; i++) group.add(mesh(new THREE.BoxGeometry(0.78, 0.035, 0.03), toon('#2a2a2a'), 0, 0.38 + i * 0.1, front + 0.01, false));

  // Notes drift up out of the top while it plays.
  const notes = NOTES.map((n, i) => {
    const s = textSprite(n, { color: ['#ee6018', '#eeeeee', '#8c8c8c', '#ee6018', '#eeeeee'][i], size: 96 });
    s.scale.multiplyScalar(0.55);
    s.visible = false;
    group.add(s);
    return s;
  });

  // Built facing +z; it stands against the east wall facing into the room (-x).
  group.position.set(JUKEBOX.x, 0, JUKEBOX.z);
  group.rotation.y = -Math.PI / 2;
  const collider: Collider = { minX: JUKEBOX.x - D / 2 - 0.05, maxX: JUKEBOX.x + D / 2, minZ: JUKEBOX.z - r - 0.05, maxZ: JUKEBOX.z + r + 0.05, top: H };
  const interactable: Interactable = { kind: 'jukebox', x: JUKEBOX.x - 1.3, z: JUKEBOX.z, radius: 1.6 };
  group.userData.interact = interactable;

  let on = false;
  let shown = '';
  const paint = (title: string) => {
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#050505';
    g.fillRect(0, 0, 512, 256);
    g.strokeStyle = 'rgba(255, 255, 255, .18)';
    g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, 509, 253);
    // An eyebrow with a status light, a hairline, then what's on.
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = on ? '#ee6018' : '#3a3a3a';
    g.fillRect(36, 60, 18, 18);
    g.fillStyle = on ? '#eeeeee' : '#8c8c8c';
    g.font = `600 32px ${MONO}`;
    track(g, 5);
    g.fillText(on ? 'NOW PLAYING' : 'JUKEBOX', 72, 70);
    track(g, 0);
    g.fillStyle = 'rgba(255, 255, 255, .12)';
    g.fillRect(36, 104, 440, 2);
    g.textAlign = 'center';
    g.fillStyle = on ? '#eeeeee' : '#8c8c8c';
    let size = 58;
    const text = on ? title : 'press E to play';
    do g.font = `500 ${size--}px ${MONO}`;
    while (g.measureText(text).width > 470 && size > 26);
    g.fillText(text, 256, 160);
    tex.needsUpdate = true;
  };

  const show = (playing: boolean, title: string) => {
    const k = `${playing}|${title}`;
    if (k === shown) return;
    shown = k;
    on = playing;
    paint(title);
    // Lit, the glow is the color; dark, it's a dull steel tube.
    neon.color.set(on ? '#2a1206' : '#3a3a3a');
    if (!on) {
      // Idle, a dim ember, so the jukebox still reads against the dark wall at night.
      neon.emissive.set('#5a2208');
      neon.emissiveIntensity = 1;
      for (const n of notes) n.visible = false;
    }
  };
  show(false, '');

  const update = (t: number, _dt: number, beat: number) => {
    if (!on) return;
    // The tube glows orange and flares on every beat.
    neon.emissive.set('#ee6018');
    neon.emissiveIntensity = 0.45 + 0.9 * beat;
    notes.forEach((n, i) => {
      const k = (t * 0.35 + i / notes.length) % 1;
      n.visible = true;
      n.position.set(Math.sin(t * 1.3 + i * 2.1) * 0.35, H + 0.1 + k * 1.3, 0.1);
      n.material.opacity = Math.min(1, k * 5) * (1 - k);
    });
  };

  return { group, collider, interactable, show, update };
}
