import * as THREE from 'three';
import { ELEVATOR, ELEVATOR_FRONT, FLOOR, WALL_HEIGHT, WALL_T } from '../../shared/layout';
import { buildCity, type City } from './city';
import { buildElevator, type Elevator } from './elevator';
import type { Collider, Interactable } from './office';
import { buildRoofPlanters } from './rooftop-planter';
import { bulb, type NightParts } from './outside';
import { Steam } from './smoke';
import { STACK, buildStack, stackBeacon } from './tower';
import { ANISOTROPY, TILE_SCALE, fitScale } from './texture-quality';
import { mergeByMaterial, mesh, toon } from './toon';

// The roof, on top of the building (see shared/rooftop.ts): a planted terrace with a glass railing,
// the elevator's housing where you arrive, the factory's stack, and the city all around.

/** The building, walls included: the roof's edge. */
const B = { minX: FLOOR.minX - WALL_T, maxX: FLOOR.maxX + WALL_T, minZ: FLOOR.minZ - WALL_T, maxZ: FLOOR.maxZ + WALL_T } as const;

export interface RoofEnv {
  /** How dark it is, 0 by day to 1 at night: the city's lights show up more. */
  dark: number;
}

export interface Rooftop {
  group: THREE.Group;
  colliders: Collider[];
  interactables: Interactable[];
  elevator: Elevator;
  city: City;
  /** The building has `floors` floors under the roof: the street is as far down as that is tall (see City). */
  setFloors(floors: number): void;
  /** What looking or clicking can land on: everything but the city far below. */
  pickables: THREE.Object3D[];
  /** The city and the elevator. */
  update(t: number, dt: number, env: RoofEnv): void;
}

function canvasTexture(w: number, h: number, draw?: (g: CanvasRenderingContext2D) => void, scale = TILE_SCALE): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  const k = fitScale(w, h, scale);
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const g = c.getContext('2d')!;
  g.scale(c.width / w, c.height / h);
  draw?.(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISOTROPY;
  return t;
}

/** Charcoal composite decking, the boards running east–west. */
function deckTexture(): THREE.CanvasTexture {
  const w = B.maxX - B.minX;
  const d = B.maxZ - B.minZ;
  const px = 24;
  return canvasTexture(Math.round(w * px), Math.round(d * px), (g) => {
    g.fillStyle = '#0c0c0c';
    g.fillRect(0, 0, w * px, d * px);
    const board = 0.14 * px;
    for (let y = 0, row = 0; y < d * px; y += board, row++) {
      // Each row of boards a slightly different tone, with joints staggered along it.
      const tone = 0.9 + ((row * 37) % 11) / 55;
      const v = Math.round(50 * tone);
      g.fillStyle = `rgb(${v}, ${v}, ${v})`;
      g.fillRect(0, y, w * px, board - 1.5);
      g.fillStyle = 'rgba(0, 0, 0, 0.45)';
      for (let x = ((row * 53) % 7) * px * 0.4; x < w * px; x += 2.4 * px) g.fillRect(x, y, 1.5, board);
    }
  });
}

export function buildRooftop(night: NightParts, floors: number): Rooftop {
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const interactables: Interactable[] = [];
  const statics = new THREE.Group();
  const w = B.maxX - B.minX;
  const d = B.maxZ - B.minZ;
  const cx = (B.minX + B.maxX) / 2;
  const cz = (B.minZ + B.maxZ) / 2;

  const city = buildCity(night);
  city.setFloors(floors);
  group.add(city.group);

  // The deck, and the slab it's laid on (the top of the building).
  const deckMat = new THREE.MeshToonMaterial({ map: deckTexture(), gradientMap: (toon('#fff') as THREE.MeshToonMaterial).gradientMap });
  deckMat.userData.outlineParameters = { visible: false };
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), deckMat);
  deck.position.set(cx, 0.002, cz);
  group.add(deck);
  statics.add(mesh(new THREE.BoxGeometry(w, 0.3, d), toon('#1c1c1c'), cx, -0.15, cz));
  colliders.push({ minX: B.minX, maxX: B.maxX, minZ: B.minZ, maxZ: B.maxZ, bottom: -0.3, top: 0 });

  // Round the edge: a concrete curb with glass panels on it and a steel rail on top. Nobody goes over it.
  const curb = toon('#161616');
  const steel = toon('#8c8c8c');
  const glassMat = new THREE.MeshBasicMaterial({ color: '#c9d2da', transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  const edges: [number, number, number, number][] = [
    [B.minX, B.maxX, B.minZ, FLOOR.minZ],
    [B.minX, B.maxX, FLOOR.maxZ, B.maxZ],
    [B.minX, FLOOR.minX, B.minZ, B.maxZ],
    [FLOOR.maxX, B.maxX, B.minZ, B.maxZ],
  ];
  for (const [x0, x1, z0, z1] of edges) {
    const ex = (x0 + x1) / 2;
    const ez = (z0 + z1) / 2;
    const alongX = x1 - x0 > z1 - z0;
    statics.add(mesh(new THREE.BoxGeometry(x1 - x0, 0.45, z1 - z0), curb, ex, 0.225, ez));
    const len = alongX ? x1 - x0 : z1 - z0;
    const pane = mesh(new THREE.PlaneGeometry(len, 0.72), glassMat, ex, 0.81, ez);
    if (!alongX) pane.rotation.y = Math.PI / 2;
    group.add(pane);
    const rail = mesh(new THREE.CylinderGeometry(0.035, 0.035, len, 8), steel, ex, 1.19, ez);
    rail.rotation.set(alongX ? 0 : Math.PI / 2, 0, alongX ? Math.PI / 2 : 0);
    statics.add(rail);
    for (let a = 0; a <= len + 0.01; a += 2.4) {
      const px = alongX ? x0 + a : ex;
      const pz = alongX ? ez : z0 + a;
      statics.add(mesh(new THREE.BoxGeometry(0.06, 0.75, 0.06), steel, px, 0.8, pz));
    }
    colliders.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, top: 99 });
  }

  // The elevator, in its housing: a back wall and a roof over the shaft (as tall as a floor), with a light on top.
  const elevator = buildElevator();
  elevator.setSign('Rooftop');
  group.add(elevator.group);
  colliders.push(...elevator.colliders);
  interactables.push(elevator.interactable);
  const hw = ELEVATOR.width / 2;
  const housing = toon('#2a2a2a');
  statics.add(mesh(new THREE.BoxGeometry(ELEVATOR.width, WALL_HEIGHT + 0.3, WALL_T), housing, ELEVATOR.x, (WALL_HEIGHT + 0.3) / 2, FLOOR.minZ - WALL_T / 2));
  statics.add(mesh(new THREE.BoxGeometry(ELEVATOR.width + 0.3, 0.3, ELEVATOR_FRONT - B.minZ + 0.2), toon('#0e0e0e'), ELEVATOR.x, WALL_HEIGHT + 0.15, (B.minZ + ELEVATOR_FRONT) / 2 + 0.05));
  const beacon = bulb(night, '#ee6018', 0.6);
  statics.add(mesh(new THREE.BoxGeometry(0.2, 0.16, 0.2), beacon, ELEVATOR.x, WALL_HEIGHT + 0.38, (B.minZ + ELEVATOR_FRONT) / 2));
  colliders.push({ minX: ELEVATOR.x - hw, maxX: ELEVATOR.x + hw, minZ: B.minZ, maxZ: FLOOR.minZ, top: 99 });

  // The factory's stack in the north-west corner, steaming, with its beacon blinking on top.
  const stack = buildStack(night);
  statics.add(stack.parts);
  group.add(new Steam(stack.mouth).group, stackBeacon(stack.mouth));
  const half = STACK.plinth / 2;
  colliders.push({ minX: STACK.x - half, maxX: STACK.x + half, minZ: STACK.z - half, maxZ: STACK.z + half, top: 99 });

  group.add(mergeByMaterial(statics));
  group.add(buildRoofPlanters(colliders));

  return {
    group,
    colliders,
    interactables,
    elevator,
    city,
    setFloors: (n) => city.setFloors(n),
    pickables: group.children.filter((c) => c !== city.group),
    update(t, dt, env) {
      city.update(t, dt, env.dark);
      elevator.update(dt);
    },
  };
}
