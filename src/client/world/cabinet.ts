import * as THREE from 'three';
import { ANISOTROPY } from './texture-quality';
import { CABINET, FLOOR } from '../../shared/layout';
import { mesh, roundedBox, toon } from './toon';
import { MONO } from '../fonts';
import { track } from './toon';
import type { Collider, Interactable } from './office';

// The arcade cabinet in the lounge: an upright in graphite side panels, a lit marquee on top, the screen
// leaning back under it (ui/cabinet.ts paints the game on it), a joystick and buttons, and a coin door.

export interface CabinetModel {
  group: THREE.Group;
  collider: Collider;
  interactable: Interactable;
  /** The game goes on this: 4:3, leaning back a little. */
  screen: THREE.Mesh;
}

/** The cabinet from the side, front toward +u: floor to marquee, round the control panel and the screen. */
const BODY: [number, number][] = [
  [-0.4, 0],
  [0.26, 0],
  [0.26, 0.84],
  [0.4, 0.9],
  [0.4, 0.98],
  [0.13, 1.05],
  [0.01, 1.57],
  [0.19, 1.63],
  [0.19, 1.9],
  [-0.4, 1.9],
];
/** The side panels: the same, standing a little proud of it all round. */
const SIDE: [number, number][] = [
  [-0.4, 0],
  [0.29, 0],
  [0.29, 0.83],
  [0.43, 0.89],
  [0.43, 1.0],
  [0.16, 1.07],
  [0.04, 1.58],
  [0.22, 1.64],
  [0.22, 1.93],
  [-0.4, 1.93],
];
const SIDE_T = 0.04;
/** Where the screen is on the slope under the marquee, and how far back it leans. */
const SCREEN_BOTTOM: [number, number] = [0.13, 1.05];
const SCREEN_TOP: [number, number] = [0.01, 1.57];
const LEAN = Math.atan2(SCREEN_BOTTOM[0] - SCREEN_TOP[0], SCREEN_TOP[1] - SCREEN_BOTTOM[1]);
/** The control panel's top, which rises a little toward the screen. */
const PANEL_FRONT: [number, number] = [0.4, 0.98];
const PANEL_BACK: [number, number] = [0.13, 1.05];
/** The side art's falling blocks: steel and light gray, with Factory orange for one of them. */
const PIECES = ['#3a3a3a', '#8c8c8c', '#5a5a5a', '#d8d8d8', '#ee6018', '#3a3a3a', '#8c8c8c'];

/** A side-view outline pulled out `thick` wide across the cabinet, from `x0`. */
function slab(points: [number, number][], thick: number, x0: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([u, v]) => new THREE.Vector2(u, v)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
  // Outline in u (front) and v (up), extruded along w: turn it so u runs along z and w along x.
  geo.rotateY(-Math.PI / 2);
  geo.translate(x0 + thick, 0, 0);
  return geo;
}

export function buildCabinet(): CabinetModel {
  const { width: W } = CABINET;
  const group = new THREE.Group();
  const inner = W - 2 * SIDE_T;
  group.add(mesh(slab(BODY, inner, -inner / 2), toon('#101010')));
  const sideMat = toon('#2a2a2a');
  for (const x0 of [-W / 2, W / 2 - SIDE_T]) group.add(mesh(slab(SIDE, SIDE_T, x0), sideMat));

  // Falling blocks down each side, as side art: a Z, an L and a T.
  const cube = new THREE.BoxGeometry(0.02, 0.1, 0.1);
  [
    [0.02, 1.62, 4],
    [-0.09, 1.62, 4],
    [-0.09, 1.51, 4],
    [-0.2, 1.51, 4],
    [0.02, 1.39, 6],
    [0.02, 1.28, 6],
    [0.02, 1.17, 6],
    [-0.09, 1.17, 6],
    [-0.12, 0.62, 2],
    [-0.01, 0.62, 2],
    [0.1, 0.62, 2],
    [-0.01, 0.51, 2],
  ].forEach(([u, v, c]) => {
    for (const sx of [-1, 1]) group.add(mesh(cube, toon(PIECES[c]), sx * (W / 2 + 0.01), v, u, false));
  });

  // The marquee: the game's name, lit from behind.
  const marquee = document.createElement('canvas');
  marquee.width = 512;
  marquee.height = 160;
  paintMarquee(marquee);
  const marqueeTex = new THREE.CanvasTexture(marquee);
  marqueeTex.colorSpace = THREE.SRGBColorSpace;
  marqueeTex.anisotropy = ANISOTROPY;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(inner, 0.25), new THREE.MeshBasicMaterial({ map: marqueeTex, toneMapped: false }));
  sign.position.set(0, 1.765, 0.192);
  group.add(sign);
  // Canvas text only picks up the office's font once it has loaded.
  void document.fonts.ready.then(() => {
    paintMarquee(marquee);
    marqueeTex.needsUpdate = true;
  });

  // The screen, in a black bezel on the slope.
  const [bu, bv] = SCREEN_BOTTOM;
  const [tu, tv] = SCREEN_TOP;
  const out = new THREE.Vector2(Math.cos(LEAN), Math.sin(LEAN));
  const bezel = mesh(new THREE.PlaneGeometry(inner - 0.04, 0.5), toon('#050505'), 0, (bv + tv) / 2 + out.y * 0.002, (bu + tu) / 2 + out.x * 0.002, false);
  bezel.rotation.x = -LEAN;
  group.add(bezel);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.42), new THREE.MeshBasicMaterial({ color: '#070b14', toneMapped: false }));
  screen.position.set(0, (bv + tv) / 2 + out.y * 0.005, (bu + tu) / 2 + out.x * 0.005);
  screen.rotation.x = -LEAN;
  group.add(screen);

  // The control panel: a joystick and three buttons.
  const panel = new THREE.Group();
  const [fu, fv] = PANEL_FRONT;
  const [pu, pv] = PANEL_BACK;
  panel.position.set(0, (fv + pv) / 2, (fu + pu) / 2);
  panel.rotation.x = Math.atan2(pv - fv, fu - pu);
  panel.add(mesh(new THREE.BoxGeometry(inner, 0.012, Math.hypot(fu - pu, fv - pv)), toon('#1c1c1c'), 0, 0.006, 0, false));
  panel.add(mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.02, 16), toon('#0a0a0a'), -0.16, 0.02, 0.01, false));
  panel.add(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.11, 8), toon('#8c8c8c'), -0.16, 0.075, 0.01, false));
  panel.add(mesh(new THREE.SphereGeometry(0.035, 14, 10), toon('#ee6018'), -0.16, 0.135, 0.01));
  ['#ee6018', '#d8d8d8', '#8c8c8c'].forEach((c, i) => panel.add(mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.025, 14), toon(c, { emissive: c }), 0.02 + i * 0.1, 0.02, i === 1 ? -0.03 : 0.02, false)));
  group.add(panel);

  // The coin door, with its two slots lit, and a kick plate.
  group.add(mesh(roundedBox(0.34, 0.32, 0.02, 0.008), toon('#1c1c1c'), 0, 0.5, 0.265, false));
  for (const sx of [-1, 1]) group.add(mesh(new THREE.BoxGeometry(0.035, 0.075, 0.012), toon('#ee6018', { emissive: '#ee6018' }), sx * 0.07, 0.56, 0.278, false));
  group.add(mesh(new THREE.BoxGeometry(0.1, 0.02, 0.012), toon('#8c8c8c'), 0, 0.43, 0.278, false));
  group.add(mesh(new THREE.BoxGeometry(inner, 0.1, 0.01), toon('#050505'), 0, 0.05, 0.266, false));

  // Built facing +z; it stands against the east wall facing into the room (-x).
  group.position.set(CABINET.x, 0, CABINET.z);
  group.rotation.y = -Math.PI / 2;
  const collider: Collider = { minX: CABINET.x - 0.45, maxX: FLOOR.maxX, minZ: CABINET.z - W / 2 - 0.02, maxZ: CABINET.z + W / 2 + 0.02, top: CABINET.height };
  const interactable: Interactable = { kind: 'cabinet', x: CABINET.x - 1.2, z: CABINET.z, radius: 1.3 };
  group.userData.interact = interactable;
  return { group, collider, interactable, screen };
}

/** The marquee: the game's name in tracked mono on a dark lit panel, BLOCK in Factory orange, under a hairline. */
function paintMarquee(c: HTMLCanvasElement) {
  const g = c.getContext('2d')!;
  g.fillStyle = '#050505';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(255, 255, 255, .18)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, c.width - 3, c.height - 3);
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.font = `700 64px ${MONO}`;
  track(g, 8);
  const block = 'BLOCK';
  const fall = 'FALL';
  const bw = g.measureText(block).width;
  const x = (c.width - bw - g.measureText(fall).width + 8) / 2;
  g.fillStyle = '#ee6018';
  g.fillText(block, x, c.height / 2 + 4);
  g.fillStyle = '#eeeeee';
  g.fillText(fall, x + bw, c.height / 2 + 4);
  track(g, 0);
  g.fillStyle = '#ee6018';
  g.fillRect(c.width / 2 - 24, c.height - 22, 48, 4);
}
