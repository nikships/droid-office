import * as THREE from 'three';
import { ELEVATOR, ELEVATOR_CAR, ELEVATOR_FRONT, FLOOR, WALL_HEIGHT } from '../../shared/layout';
import { mesh, plainLabel, roundedBox, textPlane, toon } from './toon';
import type { Collider, Interactable } from './office';

// The elevator: a steel shaft against the north wall, doors facing into the room. Every floor has
// it in the same place; riding it swaps the floor around you while the doors are shut.

// Graphite and steel like the rest of the factory floor, with Factory orange only where something is lit.
const STEEL = '#2a2a2a';
const STEEL_DARK = '#161616';
const TRIM = '#3a3a3a';
const DOOR = '#8c8c8c';
const KEY = '#1c1c1c';
const KEY_HERE = '#ee6018';
/** The floor indicator over the doors: its dark display. */
const INDICATOR = '#020202';
export interface Elevator {
  group: THREE.Group;
  /** What stops you walking out through shut doors. Part of the office's colliders. */
  colliders: Collider[];
  /** Step in, or up to the call button, and press E. */
  interactable: Interactable;
  /** Opens or shuts the doors; they slide there over a moment. */
  setOpen(open: boolean): void;
  readonly open: boolean;
  /** Whether the doors have finished moving. */
  readonly settled: boolean;
  /** The sign over the doors, and the display inside: which floor this is. */
  setSign(text: string): void;
  update(dt: number): void;
}

export function buildElevator(): Elevator {
  const { x, width, depth, wall, doorWidth, doorHeight } = ELEVATOR;
  const group = new THREE.Group();
  const colliders: Collider[] = [];
  const minX = x - width / 2;
  const maxX = x + width / 2;
  const back = FLOOR.minZ;
  const front = ELEVATOR_FRONT;
  const midZ = (back + front) / 2;
  const steel = toon(STEEL);
  const steelDark = toon(STEEL_DARK);
  const trim = toon(TRIM);

  // Side walls, the whole height of the room.
  for (const sx of [minX + wall / 2, maxX - wall / 2]) {
    group.add(mesh(new THREE.BoxGeometry(wall, WALL_HEIGHT, depth), steel, sx, WALL_HEIGHT / 2, midZ));
    colliders.push({ minX: sx - wall / 2, maxX: sx + wall / 2, minZ: back, maxZ: front, top: 99 });
  }
  // The front: a pillar either side of the doorway, and a header over it up to the ceiling line.
  const pillar = (width - doorWidth) / 2;
  for (const [x0, x1] of [
    [minX, x - doorWidth / 2],
    [x + doorWidth / 2, maxX],
  ]) {
    group.add(mesh(new THREE.BoxGeometry(pillar, WALL_HEIGHT, wall), steel, (x0 + x1) / 2, WALL_HEIGHT / 2, front - wall / 2));
    colliders.push({ minX: x0, maxX: x1, minZ: front - wall, maxZ: front, top: 99 });
  }
  const header = WALL_HEIGHT - doorHeight;
  group.add(mesh(new THREE.BoxGeometry(doorWidth, header, wall), steel, x, doorHeight + header / 2, front - wall / 2));
  // A steel frame round the doorway, and a kick plate along the bottom of the shaft.
  const frameT = 0.08;
  group.add(mesh(new THREE.BoxGeometry(doorWidth + frameT * 2, frameT, 0.05), trim, x, doorHeight + frameT / 2, front + 0.02, false));
  for (const sx of [-1, 1]) group.add(mesh(new THREE.BoxGeometry(frameT, doorHeight, 0.05), trim, x + sx * (doorWidth / 2 + frameT / 2), doorHeight / 2, front + 0.02, false));
  group.add(mesh(new THREE.BoxGeometry(width + 0.02, 0.25, wall + 0.04), steelDark, x, 0.125, front - wall / 2, false));

  // Inside: a dark floor, a mirror on the back wall, handrails, a strip light over the doors.
  const inW = ELEVATOR_CAR.maxX - ELEVATOR_CAR.minX;
  const inD = ELEVATOR_CAR.maxZ - ELEVATOR_CAR.minZ;
  const carFloor = mesh(new THREE.BoxGeometry(inW, 0.02, inD), toon('#101010'), x, 0.012, (ELEVATOR_CAR.minZ + ELEVATOR_CAR.maxZ) / 2, false);
  group.add(carFloor);
  for (let i = 1; i < 4; i++) group.add(mesh(new THREE.BoxGeometry(inW, 0.024, 0.03), toon('#2a2a2a'), x, 0.013, ELEVATOR_CAR.minZ + (i * inD) / 4, false));
  const mirror = mesh(new THREE.PlaneGeometry(inW - 0.3, 1.5), new THREE.MeshBasicMaterial({ color: '#5d6266' }), x, 1.55, back + 0.02, false);
  group.add(mirror);
  for (const [gx, gw] of [
    [-0.4, 0.14],
    [-0.15, 0.06],
  ]) {
    const glint = mesh(new THREE.PlaneGeometry(gw, 1.1), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.18 }), x + gx, 1.6, back + 0.03, false);
    glint.rotation.z = -0.45;
    group.add(glint);
  }
  const rail = (len: number, px: number, pz: number, alongX: boolean) => {
    const r = mesh(new THREE.CylinderGeometry(0.025, 0.025, len, 8), toon(DOOR), px, 0.95, pz, false);
    r.rotation.z = alongX ? Math.PI / 2 : 0;
    r.rotation.x = alongX ? 0 : Math.PI / 2;
    group.add(r);
  };
  rail(inW - 0.2, x, back + 0.08, true);
  rail(inD - 0.5, ELEVATOR_CAR.minX + 0.06, midZ - 0.1, false);
  rail(inD - 0.5, ELEVATOR_CAR.maxX - 0.06, midZ - 0.1, false);
  group.add(mesh(new THREE.BoxGeometry(inW - 0.2, 0.06, 0.16), toon('#eeeeee', { emissive: '#d8d4cc' }), x, doorHeight + 0.35, front - wall - 0.1, false));

  // The button panel inside, by the doors on the right as you face out (the west wall).
  const panelIn = new THREE.Group();
  panelIn.add(mesh(roundedBox(0.04, 0.7, 0.32, 0.02), steelDark, 0, 0, 0, false));
  for (let row = 0; row < 4; row++) {
    for (const col of [-1, 1]) {
      const b = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 12), toon(KEY, { emissive: row === 0 && col === 1 ? KEY_HERE : '#2a2a2a' }), -0.03, 0.22 - row * 0.15, col * 0.07, false);
      b.rotation.z = Math.PI / 2;
      panelIn.add(b);
    }
  }
  panelIn.position.set(ELEVATOR_CAR.minX + 0.03, 1.25, front - wall - 0.35);
  panelIn.rotation.y = Math.PI;
  group.add(panelIn);

  // The call button outside, on the right-hand pillar.
  const call = new THREE.Group();
  call.add(mesh(roundedBox(0.2, 0.36, 0.04, 0.01), trim, 0, 0, 0, false));
  const arrow = (up: boolean) => {
    const a = mesh(new THREE.ConeGeometry(0.045, 0.06, 3), toon(up ? KEY_HERE : '#3a3a3a', { emissive: up ? KEY_HERE : '#1c1c1c' }), 0, up ? 0.07 : -0.07, 0.03, false);
    if (!up) a.rotation.z = Math.PI;
    call.add(a);
  };
  arrow(true);
  arrow(false);
  call.position.set(x + doorWidth / 2 + pillar / 2, 1.2, front + 0.02);
  group.add(call);

  // The doors: two steel panels that slide apart behind the pillars.
  const half = doorWidth / 2 + 0.02;
  const doorZ = front - wall - 0.03;
  const doorMat = toon(DOOR);
  const doors = [-1, 1].map((side) => {
    const d = new THREE.Group();
    d.add(mesh(new THREE.BoxGeometry(half, doorHeight - 0.02, 0.05), doorMat, 0, 0, 0));
    // A seam line and a porthole of light, so they read as elevator doors from across the room.
    d.add(mesh(new THREE.BoxGeometry(0.02, doorHeight - 0.1, 0.055), steelDark, (-side * half) / 2 + side * 0.01, 0, 0, false));
    d.add(mesh(new THREE.BoxGeometry(half - 0.2, 0.05, 0.055), steelDark, 0, 0.35, 0, false));
    d.position.set(x + (side * half) / 2, doorHeight / 2, doorZ);
    group.add(d);
    return { group: d, side };
  });
  const doorCollider: Collider = { minX: x - doorWidth / 2, maxX: x + doorWidth / 2, minZ: front - wall - 0.06, maxZ: front, top: 99 };
  colliders.push(doorCollider);

  // The floor's name on a sign over the doors.
  let sign: ReturnType<typeof textPlane> | null = null;
  const setSign = (text: string) => {
    if (sign) {
      group.remove(sign);
      sign.material.map?.dispose();
      sign.material.dispose();
      sign.geometry.dispose();
    }
    // A floor readout: an orange arrow, then the floor's name in tracked mono.
    const name = plainLabel(text);
    // "FLOOR" names a project's floor; the lobby, the roof and "Pick a floor" say what they are.
    const kicker = /floor|lobby|roof/i.test(name) ? undefined : 'FLOOR';
    sign = textPlane(name, { bg: INDICATOR, color: '#eeeeee', size: 64, border: '#2e2e2e', index: '\u25B2', kicker });
    const { width: sw } = sign.geometry.parameters;
    // As big as fits over the doors.
    sign.scale.multiplyScalar(Math.min(1.6, (width + 0.6) / sw));
    sign.position.set(x, doorHeight + 0.75, front + 0.03);
    group.add(sign);
  };

  let open = false;
  let openness = 0; // 0 shut, 1 open
  const setOpen = (v: boolean) => {
    open = v;
    // Shut means shut at once for walking, so nobody slips out while they close.
    if (!v) doorCollider.top = 99;
  };
  const update = (dt: number) => {
    const target = open ? 1 : 0;
    if (openness !== target) {
      openness = target > openness ? Math.min(1, openness + dt / 0.7) : Math.max(0, openness - dt / 0.6);
      // Eased, like a real one: slow to start, slow to stop.
      const e = openness * openness * (3 - 2 * openness);
      // As far as the pillars hide them; a sliver still shows at the edge of the doorway.
      for (const d of doors) d.group.position.x = x + (d.side * half) / 2 + d.side * e * (pillar - 0.03);
    }
    if (open && openness > 0.85) doorCollider.top = -1;
  };

  const interactable: Interactable = { kind: 'elevator', x, z: front - 0.4, radius: 1.9 };
  group.userData.interact = interactable;
  return {
    group,
    colliders,
    interactable,
    setOpen,
    get open() {
      return open;
    },
    get settled() {
      return openness === (open ? 1 : 0);
    },
    setSign,
    update,
  };
}
