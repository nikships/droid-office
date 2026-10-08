import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, test } from 'node:test';
import * as THREE from 'three';
import { GUN_MOVES, type GunMoveId, READY, sampleMove } from '../src/client/world/gun-motion.js';
import { magnum, parseMagnum } from '../src/client/world/gun.js';
import { Hands } from '../src/client/world/hands.js';

/** How far a glove may sink into the gun: the field below is good to about a cell. */
const SLACK = 0.0005;
const CELL = 0.001;

/**
 * A signed distance field of closed meshes in `root`'s frame, negative inside, sampled every CELL.
 * Inside is by winding number up +z columns, so overlapping closed parts union correctly.
 */
class Field {
  private min: THREE.Vector3;
  private n: [number, number, number];
  private d: Float32Array;

  constructor(meshes: THREE.Mesh[], root: THREE.Object3D) {
    root.updateMatrixWorld(true);
    const inv = root.matrixWorld.clone().invert();
    const tris: number[] = [];
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const m of meshes) {
      const to = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
      const pos = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry).getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(to);
        tris.push(v.x, v.y, v.z);
        box.expandByPoint(v);
      }
    }
    box.expandByScalar(0.03);
    this.min = box.min;
    const size = box.getSize(v);
    const [nx, ny, nz] = (this.n = [Math.ceil(size.x / CELL) + 1, Math.ceil(size.y / CELL) + 1, Math.ceil(size.z / CELL) + 1]);
    const inside = new Uint8Array(nx * ny * nz);
    const columns = new Map<number, number[]>();
    for (let t = 0; t < tris.length; t += 9) {
      const xs = [tris[t], tris[t + 3], tris[t + 6]];
      const ys = [tris[t + 1], tris[t + 4], tris[t + 7]];
      for (let i = Math.floor((Math.min(...xs) - this.min.x) / CELL); i <= Math.ceil((Math.max(...xs) - this.min.x) / CELL); i++)
        for (let j = Math.floor((Math.min(...ys) - this.min.y) / CELL); j <= Math.ceil((Math.max(...ys) - this.min.y) / CELL); j++) {
          const k = i * ny + j;
          const column = columns.get(k);
          if (column) column.push(t);
          else columns.set(k, [t]);
        }
    }
    for (const [k, list] of columns) {
      // Off the grid lines, so no column runs exactly down an edge.
      const px = this.min.x + Math.floor(k / ny) * CELL + 1.3e-7;
      const py = this.min.y + (k % ny) * CELL + 2.9e-7;
      const crossings: [number, number][] = [];
      for (const t of list) {
        const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.slice(t, t + 9);
        const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(det) < 1e-18) continue;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
        if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
        crossings.push([l1 * az + l2 * bz + (1 - l1 - l2) * cz, det > 0 ? -1 : 1]);
      }
      crossings.sort((a, b) => a[0] - b[0]);
      let winding = 0;
      let h = 0;
      for (let kz = 0; kz < nz; kz++) {
        while (h < crossings.length && crossings[h][0] < this.min.z + kz * CELL) winding += crossings[h++][1];
        if (winding > 0) inside[k * nz + kz] = 1;
      }
    }
    const out = distances(inside, this.n, 0);
    const into = distances(inside, this.n, 1);
    this.d = new Float32Array(inside.length);
    for (let q = 0; q < inside.length; q++) this.d[q] = (inside[q] ? -(Math.sqrt(into[q]) - 0.5) : Math.sqrt(out[q]) - 0.5) * CELL;
  }

  /** Trilinear; anywhere off the grid is far from the gun. */
  at(p: THREE.Vector3): number {
    const [nx, ny, nz] = this.n;
    const fx = (p.x - this.min.x) / CELL;
    const fy = (p.y - this.min.y) / CELL;
    const fz = (p.z - this.min.z) / CELL;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= nx - 1 || fy >= ny - 1 || fz >= nz - 1) return 0.03;
    const [i, j, k] = [Math.floor(fx), Math.floor(fy), Math.floor(fz)];
    const [u, w, s] = [fx - i, fy - j, fz - k];
    const g = (a: number, b: number, c: number) => this.d[((i + a) * ny + j + b) * nz + k + c];
    const l = (a: number, b: number) => g(a, b, 0) * (1 - s) + g(a, b, 1) * s;
    return (l(0, 0) * (1 - w) + l(0, 1) * w) * (1 - u) + (l(1, 0) * (1 - w) + l(1, 1) * w) * u;
  }
}

/** Squared distance, in cells, from each cell to the nearest one whose `inside` isn't `of` (Felzenszwalb's transform, one axis at a time). */
function distances(inside: Uint8Array, [nx, ny, nz]: [number, number, number], of: 0 | 1): Float64Array {
  const f = new Float64Array(inside.length);
  for (let q = 0; q < f.length; q++) f[q] = inside[q] === of ? 1e20 : 0;
  const pass = (count: number, stride: number, starts: number[]) => {
    const line = new Float64Array(count);
    const v = new Int32Array(count);
    const z = new Float64Array(count + 1);
    for (const start of starts) {
      for (let t = 0; t < count; t++) line[t] = f[start + t * stride];
      let k = 0;
      v[0] = 0;
      z[0] = -1e20;
      z[1] = 1e20;
      for (let q = 1; q < count; q++) {
        let s: number;
        while ((s = (line[q] + q * q - line[v[k]] - v[k] * v[k]) / (2 * q - 2 * v[k])) <= z[k]) k--;
        v[++k] = q;
        z[k] = s;
        z[k + 1] = 1e20;
      }
      k = 0;
      for (let q = 0; q < count; q++) {
        while (z[k + 1] < q) k++;
        f[start + q * stride] = (q - v[k]) ** 2 + line[v[k]];
      }
    }
  };
  const range = (n: number, f: (i: number) => number[]) => Array.from({ length: n }, (_, i) => f(i)).flat();
  pass(
    nz,
    1,
    range(nx, (i) => range(ny, (j) => [(i * ny + j) * nz])),
  );
  pass(
    ny,
    nz,
    range(nx, (i) => range(nz, (k) => [i * ny * nz + k])),
  );
  pass(
    nx,
    ny * nz,
    range(ny, (j) => range(nz, (k) => [j * nz + k])),
  );
  return f;
}

let body: Field;
let cylinder: Field;

before(async () => {
  const glb = readFileSync(new URL('../src/client/public/props/magnum.glb', import.meta.url));
  await parseMagnum(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
  // The body in the gun's frame, and the crane with its cylinder in the crane's, so one field holds however far it's out.
  const gun = magnum();
  const crane = gun.getObjectByName('gun-crane')!;
  const still: THREE.Mesh[] = [];
  const swung: THREE.Mesh[] = [];
  gun.traverse((o) => {
    if (o instanceof THREE.Mesh) (crane.getObjectById(o.id) ? swung : still).push(o);
  });
  body = new Field(still, gun);
  cylinder = new Field(swung, crane);
});

/** Each glove bone as a capsule (two ends and a radius) or, for a palm, its surface points. */
function boneSamples(o: THREE.Mesh, out: THREE.Vector3[]): number {
  const geo = o.geometry;
  if (geo instanceof THREE.CapsuleGeometry) {
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    const r = geo.parameters.radius;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const axis = size.x > size.y && size.x > size.z ? 'x' : size.y > size.z ? 'y' : 'z';
    const half = size[axis] / 2 - r;
    for (let i = 0; i <= 12; i++) {
      const p = c.clone();
      p[axis] += half * (i / 6 - 1);
      out.push(o.localToWorld(p));
    }
    return r;
  }
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) out.push(o.localToWorld(new THREE.Vector3().fromBufferAttribute(pos, i)));
  return 0;
}

/** Plays a move (or holds the ready pose) on first-person hands at 120 Hz: the deepest any glove part goes into the gun, and when. */
function deepest(id: GunMoveId | 'ready'): { gap: number; part: string; t: number } {
  const hands = new Hands('#333333', '#c08a60');
  const input = { yaw: 0, pitch: 0, walkPhase: 0, walking: false, airborne: false, jitter: 0 };
  const move = id === 'ready' ? null : GUN_MOVES[id];
  const pose = (t: number) => (move ? sampleMove(move, t) : { ...READY });
  const dt = 1 / 120;
  hands.setGunPose(pose(0));
  for (let i = 0; i < 30; i++) hands.update(dt, 0, input);
  const worst = { gap: Infinity, part: '', t: 0 };
  const local = new THREE.Vector3();
  for (let t = 0; t <= (move?.seconds ?? 0.2) + 1e-9; t += dt) {
    hands.setGunPose(pose(t));
    hands.update(dt, t, input);
    hands.scene.updateMatrixWorld(true);
    const gun = hands.scene.getObjectByName('magnum')!;
    const crane = gun.getObjectByName('gun-crane')!;
    const gap = (p: THREE.Vector3) => Math.min(body.at(gun.worldToLocal(local.copy(p))), cylinder.at(crane.worldToLocal(local.copy(p))));
    hands.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const glove = o.name.startsWith('glove-') && o.geometry instanceof THREE.CapsuleGeometry;
      const palm = o.geometry instanceof THREE.SphereGeometry && o.parent?.getObjectByName('glove-pinwheel');
      if (!glove && !palm) return;
      const points: THREE.Vector3[] = [];
      const r = boneSamples(o, points);
      let arm: THREE.Object3D = o;
      while (arm.parent && arm.parent !== hands.scene) arm = arm.parent;
      const hand = arm.getObjectByName('magnum') ? 'right' : 'left';
      for (const p of points) {
        const g = gap(p) - r;
        if (g < worst.gap) Object.assign(worst, { gap: g, part: `${hand} ${o.name || 'palm'}`, t });
      }
    });
  }
  return worst;
}

for (const id of ['ready', ...Object.keys(GUN_MOVES)] as (GunMoveId | 'ready')[])
  test(`${id === 'ready' ? 'at the ready' : `through ${id}`}, no part of either glove goes into the gun`, () => {
    const { gap, part, t } = deepest(id);
    assert.ok(gap > -SLACK, `${part} is ${(-gap * 1000).toFixed(1)} mm into the gun at ${t.toFixed(2)} s`);
  });
