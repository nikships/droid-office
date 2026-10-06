import * as THREE from 'three';
import type { WallId } from '../../shared/decor';
import { FLOOR, WALL_HEIGHT } from '../../shared/layout';
import { eyebrow, GREEN, HAIR, INK, LED_ROWS, LIGHT, MUTED, mergeFaces, mono, ORANGE, ORANGE_BRIGHT, paintedTexture, plateFace, sans, SignAtlas, tickerTexture, tracked, type AtlasRegion } from './factory-paint';
import { glyphFlat, glyphGeometry } from './glyph3d';
import type { NightParts } from './outside';
import type { Collider, Interactable } from './office';
import { mergeByMaterial, toon, toonUnique } from './toon';

/** What buildOffice hands the set dressing: where to add things, and what to keep clear of. */
export interface DressingKit {
  group: THREE.Group;
  colliders: Collider[];
  interactables: Interactable[];
  /** Reserves a wall rectangle so hung pictures keep clear of it (see world/gallery.ts). */
  fixture: (wall: WallId, u: number, y: number, w: number, h: number) => void;
  night: NightParts;
}

export interface Dressing {
  update(t: number, dt: number): void;
}

/**
 * The fan over the open floor between the desks and the lounge: the pinwheel turning in a steel
 * ring, hung from the ceiling clear over everyone's heads (its ring's foot is over 3.2 m up).
 */
const FAN = { x: 4.2, y: 4.95, z: -2, size: 2.9, ring: 1.62, spin: 0.32 } as const;
/** The four work cells, LINE A to D: the desk clusters' pads, in desk order. */
const LINES = [
  { name: 'A', x: -10.5, z: -4 },
  { name: 'B', x: -1.5, z: -4 },
  { name: 'C', x: -10.5, z: 4 },
  { name: 'D', x: -1.5, z: 4 },
] as const;
const PAD = { width: 6.2, top: 0.021 } as const;
/** The walkways painted on the floor: x0..x1 by z0..z1, the long way along their lines. */
const LANES = [
  // The spine between the north and south pairs of cells, split where the aisle between them crosses.
  { x0: -15.2, x1: -7, z0: -1.1, z1: 1.1 },
  { x0: -5, x1: 2.6, z0: -1.1, z1: 1.1 },
  // The aisle between the west and east cells.
  { x0: -7, x1: -5, z0: -7, z1: -1.1 },
  { x0: -7, x1: -5, z0: 1.1, z1: 7 },
  // Along the boards, and along the south side.
  { x0: -15.2, x1: -7, z0: -8.9, z1: -7 },
  { x0: -5, x1: 6.6, z0: -8.9, z1: -7 },
  { x0: -11.6, x1: -7, z0: 7, z1: 8.9 },
  { x0: -5, x1: 2.4, z0: 7, z1: 8.9 },
] as const;
/** The pinwheel set in the floor where you come in, by the foot of the stairs. */
const INLAY = { x: 5.9, z: 8.6, r: 1.32 } as const;
/** High along the west wall, over its windows and the machine's monitor. */
const TICKER = { z0: -12.7, z1: -1.3, y: 5.05, height: 0.34 } as const;
/** How many LED columns the ticker steps along each second. */
const TICKER_SPEED = 14;

const DECAL_Y = 0.014;

/** Paint on the floor: lit like the floor, never outlined, drawn over it. */
function decalMat(color: string, emissive?: string): THREE.MeshToonMaterial {
  const m = toonUnique(color);
  if (emissive) m.emissive.set(emissive);
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  m.userData.outlineParameters = { visible: false };
  return m;
}

/** Where something on `wall` goes, `out` from its face, and the turn that faces it into the room. */
function wallMatrix(wall: WallId, u: number, y: number, out: number): THREE.Matrix4 {
  const at = new THREE.Vector3();
  let rotY = 0;
  if (wall === 'north') at.set(u, y, FLOOR.minZ + out);
  else if (wall === 'south') {
    at.set(u, y, FLOOR.maxZ - out);
    rotY = Math.PI;
  } else if (wall === 'west') {
    at.set(FLOOR.minX + out, y, u);
    rotY = Math.PI / 2;
  } else {
    at.set(FLOOR.maxX - out, y, u);
    rotY = -Math.PI / 2;
  }
  return new THREE.Matrix4().compose(at, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), new THREE.Vector3(1, 1, 1));
}

function place(obj: THREE.Object3D, m: THREE.Matrix4): THREE.Object3D {
  m.decompose(obj.position, obj.quaternion, obj.scale);
  return obj;
}

/** A face that shines like a lit sign. */
function faceMat(map: THREE.Texture): THREE.Material {
  return new THREE.MeshBasicMaterial({ map });
}

// ---- What the signs say ------------------------------------------------------------------------

function paintBlade(line: string) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    plateFace(ctx, w, h, 6);
    const pad = h * 0.16;
    eyebrow(ctx, '04', 'BUILD', pad, h * 0.25, h * 0.13);
    // The cell's lamp, lit.
    ctx.fillStyle = ORANGE;
    ctx.fillRect(w - pad - h * 0.07, h * 0.25 - h * 0.035, h * 0.07, h * 0.07);
    ctx.fillStyle = HAIR;
    ctx.fillRect(pad, h * 0.42, w - 2 * pad, 1.5);
    ctx.font = mono(h * 0.36, 600);
    ctx.fillStyle = LIGHT;
    ctx.textBaseline = 'middle';
    tracked(ctx, `LINE ${line}`, pad - 2, h * 0.7, h * 0.05);
  };
}

function paintZone(index: string, label: string, trail?: string, trailColor = MUTED) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    plateFace(ctx, w, h, 5);
    const pad = h * 0.3;
    const px = h * 0.36;
    eyebrow(ctx, index, label, pad, h * 0.53, px, LIGHT, 500);
    if (trail) {
      ctx.font = mono(px * 0.62, 500);
      ctx.textBaseline = 'middle';
      ctx.fillStyle = trailColor;
      tracked(ctx, trail, w - pad, h * 0.53, px * 0.1, 'right');
    }
  };
}

/** A line's floor stencil: big and plain, as if sprayed through a template. */
function paintStencil(line: string) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    ctx.clearRect(-3, -3, w + 6, h + 6);
    ctx.textBaseline = 'middle';
    eyebrow(ctx, '04', 'BUILD', 4, h * 0.17, h * 0.15, '#9a9a9a', 600);
    ctx.font = mono(h * 0.5, 700);
    ctx.fillStyle = '#b4b4b4';
    tracked(ctx, `LINE ${line}`, 0, h * 0.64, h * 0.08);
  };
}

function paintHero(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const m = w / 7;
  ctx.fillStyle = '#060606';
  ctx.fillRect(0, 0, w, h);
  // The site's faint grid.
  ctx.fillStyle = '#0f0f0f';
  for (let x = 0.35 * m; x < w; x += 0.35 * m) ctx.fillRect(x, 0, 1, h);
  for (let y = 0.35 * m; y < h; y += 0.35 * m) ctx.fillRect(0, y, w, 1);
  frame(ctx, w, h, m);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = LIGHT;
  ctx.font = sans(0.43 * m, 600);
  tracked(ctx, 'MAKE YOUR SOFTWARE', w / 2, 1.42 * m, -0.008 * m, 'center');
  tracked(ctx, 'IMPROVE ITSELF', w / 2, 1.94 * m, -0.008 * m, 'center');
  ctx.font = mono(0.1 * m, 500);
  ctx.fillStyle = MUTED;
  tracked(ctx, 'BUILD YOUR AUTONOMOUS SOFTWARE FACTORY', w / 2, 2.4 * m, 0.02 * m, 'center');
  // The two calls to action: the light button, and the install line in a terminal box.
  const rowY = 2.82 * m;
  const bh = 0.3 * m;
  const bw = 1.55 * m;
  const tw = 3.35 * m;
  const gap = 0.14 * m;
  const x0 = (w - bw - gap - tw) / 2;
  ctx.fillStyle = LIGHT;
  ctx.fillRect(x0, rowY - bh / 2, bw, bh);
  ctx.fillStyle = INK;
  ctx.font = mono(0.095 * m, 600);
  tracked(ctx, 'START BUILDING →', x0 + bw / 2, rowY + 1, 0.012 * m, 'center');
  const tx = x0 + bw + gap;
  ctx.fillStyle = INK;
  ctx.fillRect(tx, rowY - bh / 2, tw, bh);
  ctx.strokeStyle = HAIR;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(tx + 0.75, rowY - bh / 2 + 0.75, tw - 1.5, bh - 1.5);
  ctx.font = mono(0.095 * m, 500);
  ctx.fillStyle = ORANGE_BRIGHT;
  const pw = tracked(ctx, '>', tx + 0.16 * m, rowY + 1, 0);
  ctx.fillStyle = LIGHT;
  tracked(ctx, 'curl -fsSL https://app.factory.ai/cli | sh', tx + 0.16 * m + pw + 0.07 * m, rowY + 1, 0.004 * m);
  ctx.font = mono(0.075 * m, 500);
  ctx.fillStyle = '#5a5a5a';
  tracked(ctx, 'FACTORY.AI', 0.32 * m, h - 0.3 * m, 0.02 * m);
  tracked(ctx, 'PLAN, BUILD, REVIEW, AND SHIP', w - 0.32 * m, h - 0.3 * m, 0.02 * m, 'right');
}

function paintAllHours(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const m = w / 6.4;
  ctx.fillStyle = '#060606';
  ctx.fillRect(0, 0, w, h);
  frame(ctx, w, h, m);
  const pad = 0.34 * m;
  eyebrow(ctx, '05', 'BREAK ROOM', pad, 0.3 * m, 0.1 * m);
  ctx.font = mono(0.085 * m, 500);
  ctx.fillStyle = MUTED;
  const sw = tracked(ctx, 'RUNNING', w - pad, 0.3 * m, 0.012 * m, 'right');
  ctx.fillStyle = GREEN;
  ctx.beginPath();
  ctx.arc(w - pad - sw - 0.08 * m, 0.295 * m, 0.03 * m, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = HAIR;
  ctx.fillRect(pad, 0.5 * m, w - 2 * pad, 1.5);
  ctx.fillStyle = LIGHT;
  ctx.font = sans(0.4 * m, 600);
  ctx.textBaseline = 'middle';
  tracked(ctx, 'YOUR SOFTWARE FACTORY', pad - 0.02 * m, 0.92 * m, -0.006 * m);
  tracked(ctx, 'CAN RUN 24/7', pad - 0.02 * m, 1.42 * m, -0.006 * m);
  ctx.font = mono(0.075 * m, 500);
  ctx.fillStyle = '#5a5a5a';
  tracked(ctx, 'WHILE YOU TAKE FIVE', w - pad, h - 0.3 * m, 0.02 * m, 'right');
}

/** A mural's edge: the hairline round it and an orange tick in each corner. */
function frame(ctx: CanvasRenderingContext2D, w: number, h: number, m: number) {
  const i = 0.05 * m;
  ctx.strokeStyle = HAIR;
  ctx.lineWidth = 2;
  ctx.strokeRect(i, i, w - 2 * i, h - 2 * i);
  const l = 0.16 * m;
  const t = 0.018 * m;
  ctx.fillStyle = ORANGE;
  for (const [x, y, sx, sy] of [
    [i, i, 1, 1],
    [w - i, i, -1, 1],
    [i, h - i, 1, -1],
    [w - i, h - i, -1, -1],
  ]) {
    ctx.fillRect(sx > 0 ? x : x - l, sy > 0 ? y : y - t, l, t);
    ctx.fillRect(sx > 0 ? x : x - t, sy > 0 ? y : y - l, t, l);
  }
}

// ---- Floor paint ---------------------------------------------------------------------------------

/** A flat quad on the floor, `w` along its turn `rotY` (0 = along +x) and `d` across. */
function flat(group: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, z: number, rotY = 0, y = DECAL_Y) {
  const m = new THREE.Mesh(geo, mat);
  m.rotation.set(-Math.PI / 2, 0, rotY);
  m.position.set(x, y, z);
  group.add(m);
}

/** A dashed line from (x0, z0) to (x1, z1), starting and ending on a dash. */
function dashes(group: THREE.Group, mat: THREE.Material, x0: number, z0: number, x1: number, z1: number, width = 0.05, dash = 0.6, gap = 0.3) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.floor((len + gap) / (dash + gap)));
  const step = n > 1 ? (len - dash) / (n - 1) : 0;
  const angle = Math.atan2(-(z1 - z0), x1 - x0);
  for (let i = 0; i < n; i++) {
    const s = (n > 1 ? i * step + dash / 2 : len / 2) / len;
    flat(group, new THREE.PlaneGeometry(n > 1 ? dash : len, width), mat, x0 + (x1 - x0) * s, z0 + (z1 - z0) * s, angle);
  }
}

/** A band of hazard stripes, `w` by `d`, centered on (x, z) and turned `rotY`. */
function hazard(group: THREE.Group, dark: THREE.Material, stripe: THREE.Material, x: number, z: number, w: number, d: number, rotY = 0) {
  const band = new THREE.Group();
  const base = new THREE.Mesh(new THREE.PlaneGeometry(w, d), dark);
  band.add(base);
  // Stripes at 45°, each cut to the band's ends.
  const pitch = 0.26;
  const thick = 0.11;
  for (let s = -w / 2 - d; s < w / 2; s += pitch) {
    const poly = clipX(
      [
        [s, -d / 2],
        [s + thick, -d / 2],
        [s + thick + d, d / 2],
        [s + d, d / 2],
      ],
      -w / 2,
      w / 2,
    );
    if (poly.length < 3) continue;
    const shape = new THREE.Shape(poly.map(([px, py]) => new THREE.Vector2(px, py)));
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), stripe);
    m.position.z = 0.002;
    band.add(m);
  }
  band.rotation.set(-Math.PI / 2, 0, rotY);
  band.position.set(x, DECAL_Y, z);
  group.add(band);
}

/** A convex polygon cut to lo <= x <= hi. */
function clipX(poly: [number, number][], lo: number, hi: number): [number, number][] {
  const cut = (pts: [number, number][], keep: (x: number) => boolean, edge: number) => {
    const out: [number, number][] = [];
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      const pin = keep(p[0]);
      const qin = keep(q[0]);
      if (pin) out.push(p);
      if (pin !== qin) {
        const t = (edge - p[0]) / (q[0] - p[0]);
        out.push([edge, p[1] + (q[1] - p[1]) * t]);
      }
    });
    return out;
  };
  return cut(
    cut(poly, (x) => x >= lo, lo),
    (x) => x <= hi,
    hi,
  );
}

// ---- The set dressing ----------------------------------------------------------------------------

/** The Factory wayfinding and brand graphics on the walls, ceiling and floor. */
export function dressFactoryFloor(kit: DressingKit): Dressing {
  const root = new THREE.Group();
  root.name = 'factory-floor';
  const statics = new THREE.Group();
  const steel = toon('#3a3a3a');
  const graphite = toon('#1c1c1c');
  const brushed = toon('#8c8c8c');
  const plate = toon(INK);
  const led = new THREE.MeshBasicMaterial({ color: ORANGE });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4, cast = false) => {
    const mesh = new THREE.Mesh(geo, mat);
    place(mesh, m);
    mesh.castShadow = cast;
    statics.add(mesh);
    return mesh;
  };
  const at = (x: number, y: number, z: number, rotY = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), new THREE.Vector3(1, 1, 1));

  // ---- The signs, all on one texture.
  const atlas = new SignAtlas(200, 2);
  const blades = LINES.map((l) => ({ line: l, region: atlas.add(1.8, 0.5, paintBlade(l.name)) }));
  const stencils = LINES.map((l) => ({ line: l, region: atlas.add(2.2, 0.7, paintStencil(l.name)) }));
  const walls: { wall: WallId; u: number; y: number; region: AtlasRegion }[] = [
    { wall: 'south', u: -6.5, y: 3.2, region: atlas.add(1.6, 0.34, paintZone('06', 'DOCUMENTATION')) },
    { wall: 'south', u: -14, y: 3.75, region: atlas.add(1.6, 0.36, paintZone('', 'FUEL', 'COFFEE')) },
  ];
  const tex = atlas.finish();
  const faces: { geo: THREE.BufferGeometry; at: THREE.Matrix4 }[] = [];

  // LINE A to D: a blade over the spine at a corner of each cell, read from either side. They hang
  // past the ends of the cells' LED bars, so the bars never cross them, and high over the boards'
  // line of sight from across the room. The north cells' hang at their west corners and the south
  // cells' at their east ones, so from either end of the room no sign stands behind another.
  const bladeY = 5;
  for (const { line, region } of blades) {
    const x = line.x + (line.z < 0 ? -2.85 : 2.85);
    const z = line.z < 0 ? -1.95 : 1.95;
    add(new THREE.BoxGeometry(region.width, region.height, 0.04), plate, at(x, bladeY, z), true);
    faces.push({ geo: atlas.plane(region), at: at(x, bladeY, z + 0.0205) });
    faces.push({ geo: atlas.plane(region), at: at(x, bladeY, z - 0.0205, Math.PI) });
    const top = bladeY + region.height / 2;
    for (const dx of [-0.7, 0.7]) {
      add(new THREE.CylinderGeometry(0.008, 0.008, WALL_HEIGHT - top, 4), brushed, at(x + dx, (top + WALL_HEIGHT) / 2, z));
      add(new THREE.BoxGeometry(0.08, 0.02, 0.08), brushed, at(x + dx, WALL_HEIGHT - 0.01, z));
    }
  }

  for (const w of walls) {
    add(new THREE.BoxGeometry(w.region.width, w.region.height, 0.03), plate, wallMatrix(w.wall, w.u, w.y, 0.015));
    faces.push({ geo: atlas.plane(w.region), at: wallMatrix(w.wall, w.u, w.y, 0.031) });
    kit.fixture(w.wall, w.u, w.y, w.region.width + 0.1, w.region.height + 0.1);
  }

  const signFaces = new THREE.Mesh(mergeFaces(faces), faceMat(tex));
  signFaces.name = 'factory-signs';
  root.add(signFaces);

  // ---- The murals.
  // North wall, past the gong: the site's hero, its pinwheel standing out from the wall.
  const hero = { u: 14.05, y: 4.8, width: 7, height: 3.3 };
  const heroTex = paintedTexture(hero.width * 150, hero.height * 150, 2, (ctx) => paintHero(ctx, hero.width * 150, hero.height * 150));
  add(new THREE.BoxGeometry(hero.width + 0.04, hero.height + 0.04, 0.04), plate, wallMatrix('north', hero.u, hero.y, 0.02));
  const heroFace = new THREE.Mesh(new THREE.PlaneGeometry(hero.width, hero.height), faceMat(heroTex));
  place(heroFace, wallMatrix('north', hero.u, hero.y, 0.041));
  root.add(heroFace);
  const glyphMat = new THREE.MeshBasicMaterial({ color: LIGHT });
  add(glyphGeometry(0.66, 0.03, 6), glyphMat, wallMatrix('north', hero.u, hero.y + hero.height / 2 - 0.62, 0.06));
  kit.fixture('north', hero.u, hero.y, hero.width + 0.1, hero.height + 0.1);

  // East wall, over the TV and as wide as it: the break room's.
  const rest = { u: 0, y: 5.35, width: 6.4, height: 1.9 };
  const restTex = paintedTexture(rest.width * 150, rest.height * 150, 2, (ctx) => paintAllHours(ctx, rest.width * 150, rest.height * 150));
  add(new THREE.BoxGeometry(rest.width + 0.04, rest.height + 0.04, 0.04), plate, wallMatrix('east', rest.u, rest.y, 0.02));
  const restFace = new THREE.Mesh(new THREE.PlaneGeometry(rest.width, rest.height), faceMat(restTex));
  place(restFace, wallMatrix('east', rest.u, rest.y, 0.041));
  root.add(restFace);
  kit.fixture('east', rest.u, rest.y, rest.width + 0.1, rest.height + 0.1);

  // ---- The ticker, high along the west wall over the windows and the machine's monitor.
  const ticker = tickerTexture(
    ['MAKE YOUR SOFTWARE IMPROVE ITSELF', 'YOUR SOFTWARE FACTORY CAN RUN 24/7', 'PLAN, BUILD, REVIEW, AND SHIP'].flatMap((text) => [
      { text, color: ORANGE_BRIGHT },
      { text: '  ■  ', color: LIGHT },
    ]),
  );
  const tickerLen = TICKER.z1 - TICKER.z0;
  const tickerU = (TICKER.z0 + TICKER.z1) / 2;
  const visible = (tickerLen / TICKER.height) * LED_ROWS;
  ticker.tex.repeat.x = visible / ticker.columns;
  add(new THREE.BoxGeometry(tickerLen + 0.1, TICKER.height + 0.1, 0.06), plate, wallMatrix('west', tickerU, TICKER.y, 0.03));
  const tickerFace = new THREE.Mesh(new THREE.PlaneGeometry(tickerLen, TICKER.height), new THREE.MeshBasicMaterial({ map: ticker.tex, color: '#ffffff' }));
  tickerFace.name = 'factory-ticker';
  place(tickerFace, wallMatrix('west', tickerU, TICKER.y, 0.062));
  root.add(tickerFace);
  for (const dz of [-1, 1]) add(new THREE.BoxGeometry(0.02, TICKER.height + 0.1, 0.02), led, wallMatrix('west', tickerU + (dz * (tickerLen + 0.1)) / 2, TICKER.y, 0.05));
  kit.fixture('west', tickerU, TICKER.y, tickerLen + 0.2, TICKER.height + 0.2);

  // ---- The fan.
  const fan = new THREE.Group();
  fan.position.set(FAN.x, FAN.y, FAN.z);
  const rotor = new THREE.Mesh(glyphGeometry(FAN.size, 0.09, 8), [toon('#eeeeee', { emissive: '#6a6a6a' }), steel]);
  rotor.name = 'factory-fan';
  fan.add(rotor);
  const fanParts = new THREE.Group();
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    fanParts.add(m);
  };
  const up = WALL_HEIGHT - FAN.y;
  part(new THREE.TorusGeometry(FAN.ring, 0.05, 8, 72), steel, 0, 0, 0);
  part(new THREE.TorusGeometry(FAN.ring - 0.065, 0.014, 6, 72), led, 0, 0, 0);
  // The frame behind the blades: a cross through the ring, its upright on up to the ceiling.
  part(new THREE.BoxGeometry(FAN.ring * 2, 0.05, 0.05), graphite, 0, 0, -0.13);
  part(new THREE.BoxGeometry(0.05, up + FAN.ring, 0.05), graphite, 0, (up - FAN.ring) / 2, -0.13);
  part(new THREE.BoxGeometry(0.42, 0.03, 0.42), steel, 0, up - 0.015, -0.13);
  part(new THREE.CylinderGeometry(0.2, 0.2, 0.26, 20), graphite, 0, 0, -0.27, Math.PI / 2);
  part(new THREE.CylinderGeometry(0.12, 0.12, 0.12, 20), graphite, 0, 0, 0.11, Math.PI / 2);
  part(new THREE.CircleGeometry(0.04, 16), led, 0, 0, 0.171);
  const back = new THREE.Mesh(new THREE.CircleGeometry(0.04, 16), led);
  back.position.z = -0.401;
  back.rotation.y = Math.PI;
  fanParts.add(back);
  fan.add(mergeByMaterial(fanParts));
  root.add(fan);

  // ---- Floor paint.
  const paint = new THREE.Group();
  const line = decalMat('#8c8c8c', '#1a1a1a');
  const signal = decalMat(ORANGE, '#3a1403');
  const dark = decalMat(INK);
  for (const l of LANES) {
    const alongX = l.x1 - l.x0 >= l.z1 - l.z0;
    if (alongX) {
      for (const z of [l.z0, l.z1]) dashes(paint, line, l.x0 + 0.5, z, l.x1 - 0.5, z);
    } else {
      for (const x of [l.x0, l.x1]) dashes(paint, line, x, l.z0 + 0.5, x, l.z1 - 0.5);
    }
    // An orange bracket in each corner.
    for (const [cx, sx] of [
      [l.x0, 1],
      [l.x1, -1],
    ])
      for (const [cz, sz] of [
        [l.z0, 1],
        [l.z1, -1],
      ]) {
        const legX = alongX ? 0.4 : 0.3;
        const legZ = alongX ? 0.3 : 0.4;
        flat(paint, new THREE.PlaneGeometry(legX, 0.06), signal, cx + (sx * legX) / 2, cz + (sz * 0.06) / 2);
        flat(paint, new THREE.PlaneGeometry(0.06, legZ), signal, cx + (sx * 0.06) / 2, cz + (sz * legZ) / 2);
      }
  }
  // Hazard stripes where the floor ends in a door or a step: the elevator's, and the stairs' foot.
  hazard(paint, dark, signal, 8.5, -10.28, 2.2, 0.44);
  hazard(paint, dark, signal, 2.62, 12.1, 1.6, 0.48, Math.PI / 2);
  // The pinwheel set in the floor by the stairs, in a ring with an orange mark at each quarter.
  flat(paint, glyphFlat(INLAY.r * 1.55, 8), line, INLAY.x, INLAY.z);
  flat(paint, new THREE.RingGeometry(INLAY.r - 0.035, INLAY.r, 72), line, INLAY.x, INLAY.z);
  flat(paint, new THREE.RingGeometry(INLAY.r + 0.14, INLAY.r + 0.16, 72), line, INLAY.x, INLAY.z);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    flat(paint, new THREE.PlaneGeometry(0.3, 0.06), signal, INLAY.x + Math.cos(a) * (INLAY.r + 0.07), INLAY.z - Math.sin(a) * (INLAY.r + 0.07), a);
  }
  const floorPaint = mergeByMaterial(paint);
  for (const m of floorPaint.children) {
    m.castShadow = false;
    m.renderOrder = 1;
  }
  root.add(floorPaint);

  // LINE A to D on each pad's east end, read from the aisle or the open floor beyond it.
  const stencilMat = toonUnique('#ffffff');
  stencilMat.map = tex;
  stencilMat.emissive.set('#ffffff');
  stencilMat.emissiveMap = tex;
  stencilMat.emissiveIntensity = 0.22;
  stencilMat.alphaTest = 0.5;
  stencilMat.polygonOffset = true;
  stencilMat.polygonOffsetFactor = -3;
  stencilMat.polygonOffsetUnits = -3;
  stencilMat.userData.outlineParameters = { visible: false };
  const lay = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, Math.PI / 2));
  const stencilFaces = stencils.map(({ line: l, region }) => ({
    geo: atlas.plane(region),
    at: new THREE.Matrix4().compose(new THREE.Vector3(l.x + PAD.width / 2 - 0.47, PAD.top + 0.004, l.z), lay, new THREE.Vector3(1, 1, 1)),
  }));
  const stencilMesh = new THREE.Mesh(mergeFaces(stencilFaces), stencilMat);
  stencilMesh.receiveShadow = true;
  stencilMesh.renderOrder = 1;
  root.add(stencilMesh);

  root.add(mergeByMaterial(statics));
  kit.group.add(root);

  let step = -1;
  return {
    update(t) {
      rotor.rotation.z = -t * FAN.spin;
      // The ticker moves a whole LED column at a time, as a real one does.
      const s = Math.floor(t * TICKER_SPEED) % ticker.columns;
      if (s !== step) {
        step = s;
        ticker.tex.offset.x = s / ticker.columns;
      }
    },
  };
}
