import * as THREE from 'three';
import { FLOOR, LADDER, SLAB, WALL_HEIGHT, WALL_T, WINDOWS } from '../../shared/layout';
import type { Collider, Interactable } from './office';
import { installCeilingDeck } from './ceiling-deck';
import { ANISOTROPY, TILE_SCALE } from './texture-quality';
import { mesh, textPlane, toon } from './toon';

const ACCENT = '#ee6018';

// The floors above and below this one: the ceiling (and the hatches and holes in it and in the floor),
// the ladder up the west wall. Every floor is built from the same office, so
// what's here depends on which floor of the building you're on (see Stack.set).

/** The top of the windows either side of the ladder, where the sign to the floor above hangs over. */
const LADDER_WINDOW_HEAD = Math.max(...WINDOWS.filter((w) => w.wall === 'west').map((w) => w.y1));

interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** A rectangular hatch in a flat shape. `flip` is the shape's y for world z. */
type Hole = Rect;
function holePath(h: Hole, flip: 1 | -1): THREE.Path {
  const p = new THREE.Path();
  p.moveTo(h.minX, flip * h.minZ);
  p.lineTo(h.minX, flip * h.maxZ);
  p.lineTo(h.maxX, flip * h.maxZ);
  p.lineTo(h.maxX, flip * h.minZ);
  p.closePath();
  return p;
}

/**
 * A flat surface with holes in it, facing up (the floor, flip -1) or down (the ceiling, flip 1).
 * Its uvs span `uv` once, like a PlaneGeometry that size would.
 */
function surface(outline: [number, number][], holes: Hole[], flip: 1 | -1, uv?: Rect): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, flip * z)));
  shape.holes = holes.map((h) => holePath(h, flip));
  const geo = new THREE.ShapeGeometry(shape, 24);
  if (uv) {
    const pos = geo.getAttribute('position');
    const uvs = geo.getAttribute('uv');
    const w = uv.maxX - uv.minX;
    const d = uv.maxZ - uv.minZ;
    for (let i = 0; i < pos.count; i++) uvs.setXY(i, (pos.getX(i) - uv.minX) / w, (uv.maxZ - flip * pos.getY(i)) / d);
  }
  geo.rotateX(flip * (Math.PI / 2));
  return geo;
}

function rectOutline(r: Rect): [number, number][] {
  return [
    [r.minX, r.minZ],
    [r.maxX, r.minZ],
    [r.maxX, r.maxZ],
    [r.minX, r.maxZ],
  ];
}

/**
 * The ceiling: a black corrugated steel deck, its ribs running east–west across the beams under it
 * (world/office.ts), four ribs per repeat.
 */
function tileTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128 * TILE_SCALE;
  const g = c.getContext('2d')!;
  g.scale(TILE_SCALE, TILE_SCALE);
  g.fillStyle = '#1e1e1e';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 4; i++) {
    const y = i * 32;
    g.fillStyle = '#2c2c2c';
    g.fillRect(0, y + 4, 128, 14);
    g.fillStyle = '#3a3a3a';
    g.fillRect(0, y + 4, 128, 2);
    g.fillStyle = '#141414';
    g.fillRect(0, y + 18, 128, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / 1.2, 1 / 1.2);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISOTROPY;
  return t;
}

/** A shaft going on past the hole into the dark: its walls fade out the further they go. */
function shaft(half: number, from: number, to: number, center: { x: number; z: number }): THREE.Group {
  const g = new THREE.Group();
  const h = Math.abs(to - from);
  const geo = new THREE.CylinderGeometry(half * Math.SQRT2, half * Math.SQRT2, h, 4, 6, true).rotateY(Math.PI / 4);
  const pos = geo.getAttribute('position');
  const colors: number[] = [];
  const near = new THREE.Color('#3a3a3a');
  const far = new THREE.Color('#0a0a0a');
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    // 1 at the hole, 0 at the far end.
    const k = to > from ? 0.5 - pos.getY(i) / h : 0.5 + pos.getY(i) / h;
    c.copy(near).lerp(far, Math.min(1, (1 - k) ** 0.7));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const walls = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }));
  walls.position.set(center.x, (from + to) / 2, center.z);
  g.add(walls);
  const end = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2), new THREE.MeshBasicMaterial({ color: far }));
  end.rotation.x = to < from ? -Math.PI / 2 : Math.PI / 2;
  end.position.set(center.x, from > to ? Math.min(from, to) + 0.01 : Math.max(from, to) - 0.01, center.z);
  g.add(end);
  return g;
}

/** A trapdoor on a hinge at its room-side edge: `open` swings it up out of the floor, or down out of the ceiling. */
interface Trapdoor {
  pivot: THREE.Group;
  /** 0 shut … 1 open. */
  open: number;
  down: boolean;
}

function trapdoor(down: boolean): Trapdoor {
  const { hatch, slot } = LADDER;
  const w = hatch.maxX - hatch.minX - slot;
  const d = hatch.maxZ - hatch.minZ;
  const pivot = new THREE.Group();
  pivot.position.set(hatch.maxX, down ? WALL_HEIGHT : 0, (hatch.minZ + hatch.maxZ) / 2);
  const lid = new THREE.Group();
  const t = 0.06;
  // Flush with the floor (a touch proud of it, so it reads as a hatch), or with the ceiling.
  lid.add(mesh(new THREE.BoxGeometry(w - 0.02, t, d - 0.02), toon(down ? '#6a6a6a' : '#808080'), -w / 2, down ? t / 2 : -t / 2 + 0.012, 0));
  // A frame round it, and a ring to pull it by, on the side you see.
  const rim = toon(down ? '#535353' : '#a6a6a6');
  const y = down ? -0.012 : 0.022;
  for (const s of [-1, 1]) {
    lid.add(mesh(new THREE.BoxGeometry(w - 0.02, 0.025, 0.05), rim, -w / 2, y, (s * (d - 0.07)) / 2));
    lid.add(mesh(new THREE.BoxGeometry(0.05, 0.025, d - 0.02), rim, -w / 2 + (s * (w - 0.07)) / 2, y, 0));
  }
  const ring = mesh(new THREE.TorusGeometry(0.06, 0.012, 6, 16), toon('#eaeaea'), -w + 0.16, down ? -0.02 : 0.03, 0);
  ring.rotation.x = Math.PI / 2;
  lid.add(ring);
  pivot.add(lid);
  return { pivot, open: 0, down };
}

export interface StackState {
  /** Which floor of the building you're on (0 is the bottom one), and how many there are. */
  index: number;
  count: number;
  /** The floors above and below, by name, for the signs. */
  up?: string;
  down?: string;
}

export interface Stack {
  group: THREE.Group;
  interactables: Interactable[];
  setCeilingModel(source: THREE.Object3D): boolean;
  /** The floor you're on: the ladder and the hatches go where there are floors to go to. */
  set(s: StackState): void;
  state: StackState;
  /**
   * Opens the hatches for anyone passing through them (on the ladder, or down in its shaft), and hides
   * the shafts from anyone looking up from the garage or the street.
   */
  update(dt: number, people: Iterable<{ x: number; y: number; z: number; grip?: string | null }>, eye: THREE.Vector3): void;
  /** A hatch just started opening or banged shut. */
  onHatch: ((where: 'floor' | 'ceiling', open: boolean) => void) | null;
}

/**
 * The floor you walk on (planks from `planks`), the slab under it, the ceiling over it and the ladder.
 * Their colliders go in `colliders` and change as floors come and go.
 */
export function buildStack(colliders: Collider[], planks: THREE.Material): Stack {
  const group = new THREE.Group();
  const B = { minX: FLOOR.minX - WALL_T, maxX: FLOOR.maxX + WALL_T, minZ: FLOOR.minZ - WALL_T, maxZ: FLOOR.maxZ + WALL_T };
  const concrete = toon('#a9a9a9');
  const band = toon('#a6a6a6');
  // Big flat surfaces get no cartoon outline, as the floor never has.
  planks.userData.outlineParameters = { visible: false };
  const tiles = toon('#ffffff').clone();
  tiles.userData.outlineParameters = { visible: false };
  tiles.map = tileTexture();
  // Lit from below by the room's lamps, not left in the shade the sun would give it.
  tiles.emissive = new THREE.Color('#3a3a3a');
  tiles.emissiveMap = tiles.map;
  const ceilingMat = tiles;
  const steel = toon('#c0c0c0');
  const rungMat = toon('#eaeaea');

  /** What set() builds, to take down again next time. */
  let built: THREE.Object3D[] = [];
  let mine: Collider[] = [];
  const state: StackState = { index: 0, count: 1 };

  // The ladder: steel rails and rungs up the wall, from the floor to the ceiling, and on through the
  // hatches into the shafts when there's a floor there.
  const railX = FLOOR.minX + 0.16;
  const ladderPart = (y0: number, y1: number) => {
    const g = new THREE.Group();
    for (const s of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.07, y1 - y0, 0.07), steel, railX, (y0 + y1) / 2, LADDER.z + (s * LADDER.width) / 2));
    for (let y = Math.ceil((y0 + 0.15) / 0.3) * 0.3; y < y1 - 0.05; y += 0.3) {
      const rung = mesh(new THREE.CylinderGeometry(0.03, 0.03, LADDER.width, 8), rungMat, railX, y, LADDER.z);
      rung.rotation.x = Math.PI / 2;
      g.add(rung);
    }
    return g;
  };
  const ladder = new THREE.Group();
  const ladderMain = ladderPart(0, WALL_HEIGHT);
  // Brackets holding it off the wall.
  for (let y = 0.9; y < WALL_HEIGHT - 0.4; y += 1.5) for (const s of [-1, 1]) ladderMain.add(mesh(new THREE.BoxGeometry(0.18, 0.05, 0.05), steel, FLOOR.minX + 0.08, y, LADDER.z + (s * LADDER.width) / 2));
  const ladderBelow = ladderPart(-2.2, 0);
  const ladderAbove = ladderPart(WALL_HEIGHT, WALL_HEIGHT + 2.2);
  ladderMain.name = 'floor-ladder-main';
  ladderBelow.name = 'floor-ladder-below';
  ladderAbove.name = 'floor-ladder-above';
  ladder.add(ladderMain, ladderBelow, ladderAbove);
  // A stripe of hazard paint on the floor in front of it.
  const stripe = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const s = mesh(new THREE.PlaneGeometry(0.1, 0.34), toon(i % 2 ? '#484848' : ACCENT), LADDER.hatch.maxX + 0.08, 0.006, LADDER.z - 0.4 + i * 0.2);
    s.rotation.x = -Math.PI / 2;
    s.rotation.z = 0.6;
    stripe.add(s);
  }
  ladder.add(stripe);
  group.add(ladder);
  // Something to aim at: the gaps between the rungs count as the ladder too.
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  ladder.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, WALL_HEIGHT, LADDER.width + 0.1).translate(FLOOR.minX + 0.2, WALL_HEIGHT / 2, LADDER.z), hitMat));
  const ladderIt: Interactable = { kind: 'ladder', x: LADDER.hatch.maxX + 0.2, z: LADDER.z, radius: 1.3, off: true };
  ladder.userData.interact = ladderIt;
  const ladderCollider: Collider = { minX: FLOOR.minX, maxX: railX + 0.05, minZ: LADDER.z - LADDER.width / 2 - 0.05, maxZ: LADDER.z + LADDER.width / 2 + 0.05, top: 99 };
  // Where the ladder goes: a sign up by the hatch in the ceiling, and one down by the floor.
  let ladderSigns: ReturnType<typeof textPlane>[] = [];

  const floorHatch = trapdoor(false);
  const ceilingHatch = trapdoor(true);
  group.add(floorHatch.pivot, ceilingHatch.pivot);
  const hatchCenter = { x: (LADDER.hatch.minX + LADDER.hatch.maxX) / 2, z: (LADDER.hatch.minZ + LADDER.hatch.maxZ) / 2 };
  const hatchHalf = (LADDER.hatch.maxX - LADDER.hatch.minX) / 2;
  const ladderDownShaft = shaft(hatchHalf, 0, -2.3, hatchCenter);
  const ladderUpShaft = shaft(hatchHalf, WALL_HEIGHT, WALL_HEIGHT + 2.3, hatchCenter);
  group.add(ladderDownShaft, ladderUpShaft);

  const set = (s: StackState) => {
    const { index, count } = s;
    const others = count > 1;
    const below = others && index > 0;
    const above = others && index < count - 1;

    // The new floor, slab and ceiling are built first, off to the side. Only once they exist are the
    // old ones taken down: a build that fails partway (a shape the geometry builder rejects) must
    // never leave this floor with no floor to stand on or to see.
    const nextBuilt: THREE.Object3D[] = [];
    const nextMine: Collider[] = [];
    const takeNext = <T extends THREE.Object3D>(o: T): T => {
      nextBuilt.push(o);
      return o;
    };

    // The floor: planks, with the hatch cut out when it leads somewhere.
    const floorHoles: Hole[] = [];
    if (below) floorHoles.push(LADDER.hatch);
    takeNext(new THREE.Mesh(surface(rectOutline(FLOOR), floorHoles, -1, FLOOR), planks));

    // The slab under it (the garage's ceiling): concrete underneath, a peach band between the floors
    // outside. Where a hole goes through, the garage sees a lid of concrete, not up into the office.
    const slabHoles: Hole[] = below ? [LADDER.hatch] : [];
    const slabShape = new THREE.Shape(rectOutline(B).map(([x, z]) => new THREE.Vector2(x, -z)));
    slabShape.holes = slabHoles.map((h) => holePath(h, -1));
    const slabGeo = new THREE.ExtrudeGeometry(slabShape, { depth: SLAB - 0.01, bevelEnabled: false, curveSegments: 24 }).rotateX(-Math.PI / 2).translate(0, -SLAB, 0);
    // Its top and bottom are concrete (group 0); its edges are the band.
    takeNext(mesh(slabGeo, concrete)).material = [concrete, band];
    for (const h of below ? [LADDER.hatch] : []) {
      const lid = takeNext(mesh(new THREE.PlaneGeometry(h.maxX - h.minX, h.maxZ - h.minZ), concrete, (h.minX + h.maxX) / 2, -SLAB - 0.002, (h.minZ + h.maxZ) / 2));
      lid.rotation.x = Math.PI / 2;
    }
    nextMine.push({ ...B, bottom: -SLAB, top: 0 });

    // The ceiling: tiles, WALL_HEIGHT up, with the hatch when they come from somewhere.
    const ceilingHoles: Hole[] = [];
    if (above) ceilingHoles.push(LADDER.hatch);
    takeNext(mesh(surface(rectOutline(FLOOR), ceilingHoles, 1), ceilingMat, 0, WALL_HEIGHT, 0));
    nextMine.push({ ...FLOOR, bottom: WALL_HEIGHT, top: WALL_HEIGHT + SLAB });

    // The new floor is ready: take the old one down and put this one in its place.
    Object.assign(state, s);
    delete state.up;
    delete state.down;
    if (s.up) state.up = s.up;
    if (s.down) state.down = s.down;
    for (const o of built) {
      o.removeFromParent();
      o.traverse((m) => {
        if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).geometry.dispose();
      });
    }
    built = nextBuilt;
    for (const o of built) group.add(o);
    for (const c of mine) {
      const i = colliders.indexOf(c);
      if (i >= 0) colliders.splice(i, 1);
    }
    mine = nextMine;

    // The ladder, when there's anywhere to climb to.
    ladder.visible = others;
    ladderIt.off = !others;
    ladderBelow.visible = below;
    ladderAbove.visible = above;
    floorHatch.pivot.visible = below;
    ceilingHatch.pivot.visible = above;
    ladderDownShaft.visible = below;
    ladderUpShaft.visible = above;
    if (others) mine.push(ladderCollider);
    for (const sign of ladderSigns) {
      sign.removeFromParent();
      sign.geometry.dispose();
      sign.material.map?.dispose();
      sign.material.dispose();
    }
    ladderSigns = [];
    // Above the window beside it and below its sill, so they cover neither.
    for (const [name, arrow, y] of [
      [s.up, '⬆', LADDER_WINDOW_HEAD + 0.48],
      [s.down, '⬇', 0.62],
    ] as const) {
      if (!others || !name) continue;
      const sign = textPlane(`${arrow} ${name.length > 22 ? `${name.slice(0, 21)}…` : name}`, { bg: '#0a0a0a', color: '#eeeeee', border: '#2f2f2f', size: 44 });
      sign.scale.multiplyScalar(0.7);
      sign.position.set(FLOOR.minX + 0.02, y, LADDER.z + LADDER.width / 2 + 0.15 + (sign.geometry.parameters.width * 0.7) / 2);
      sign.rotation.y = Math.PI / 2;
      group.add(sign);
      ladderSigns.push(sign);
    }

    colliders.push(...mine);
  };

  const stack: Stack = {
    group,
    interactables: [ladderIt],
    setCeilingModel: (source) => installCeilingDeck(source, ceilingMat),
    set,
    state,
    onHatch: null,
    update(dt, people, eye) {
      const inHatch = (p: { x: number; z: number }) => p.x > LADDER.hatch.minX - 0.1 && p.x < LADDER.hatch.maxX && p.z > LADDER.hatch.minZ - 0.1 && p.z < LADDER.hatch.maxZ + 0.1;
      let floorWant = 0;
      let ceilingWant = 0;
      for (const p of people) {
        if (!inHatch(p)) continue;
        const onLadder = p.grip === 'ladder';
        if (p.y < -0.03 || (onLadder && p.y < 0.6)) floorWant = 1;
        if (p.y > WALL_HEIGHT - 1.75 || (onLadder && p.y > WALL_HEIGHT - 2.4)) ceilingWant = 1;
      }
      for (const [h, want, where] of [
        [floorHatch, floorWant, 'floor'],
        [ceilingHatch, ceilingWant, 'ceiling'],
      ] as const) {
        if (!h.pivot.visible || h.open === want) continue;
        if (want && h.open === 0) stack.onHatch?.(where, true);
        h.open = want > h.open ? Math.min(1, h.open + dt * 4) : Math.max(0, h.open - dt * 2.2);
        if (!want && h.open === 0) stack.onHatch?.(where, false);
        h.pivot.rotation.z = (h.down ? 1 : -1) * h.open * (Math.PI / 2 + 0.12);
      }
      // From the garage or the street (or anywhere outside), the shafts, and the ladder in
      // them, would hang in mid-air under the building or stick up out of its roof.
      const inside = eye.x > FLOOR.minX && eye.x < FLOOR.maxX && eye.z > FLOOR.minZ && eye.z < FLOOR.maxZ && eye.y > -SLAB;
      ladderDownShaft.visible = ladderBelow.visible = inside && floorHatch.pivot.visible;
      ladderUpShaft.visible = ladderAbove.visible = inside && ceilingHatch.pivot.visible;
    },
  };
  return stack;
}
