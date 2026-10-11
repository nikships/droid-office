import * as THREE from 'three';

/** How far a caster's shadow can fall from it, in metres: the moon is 50° up, so about 0.84 m per metre of height. */
const SHADOW_REACH = 3;
/** Values compared per caster: its world matrix, its position attribute's version, its instance matrices' version and count. */
const SIG = 19;

interface Caster {
  sig: Float64Array;
  /** The last check that saw it visible. */
  check: number;
}

/**
 * Decides when Smart shadows redraw the moon's shadow map. Redrawing the map is most of what shadows cost, and the
 * map only goes stale when something that casts a shadow moves, appears, vanishes or changes shape, or the light moves.
 *
 * Only changes you could see count: a caster whose shadow falls outside the view is noted, and the map is redrawn the
 * moment it comes into view, so a stale shadow never shows. The board agents bob and the factory arm swings in every
 * frame, so while something in view keeps moving the map is redrawn at most `hz` times a second.
 *
 * Each caster's world matrix and the versions of its position attribute and instance matrices (bumped whenever their
 * `needsUpdate` is set) are compared, so vertex animation and instanced motion count too.
 */
export class ShadowWatch {
  private readonly casters = new Map<THREE.Mesh, Caster>();
  /** Casters that changed out of view since the map was last redrawn, with where the map still has them (null: not in it). */
  private readonly unseen = new Map<THREE.Mesh, THREE.Matrix4 | null>();
  private lights: number[] = [];
  private checks = 0;
  private due = true;
  private drawnAt = Number.NEGATIVE_INFINITY;
  private readonly sig = new Float64Array(SIG);
  private readonly sphere = new THREE.Sphere();
  private readonly was = new THREE.Matrix4();

  constructor(private readonly hz = 30) {}

  /**
   * Whether to redraw the shadow map on the next frame. Call once a frame, after a render, so every matrix is current.
   * `view` is the camera's frustum; null counts every change as visible.
   */
  update(scene: THREE.Object3D, lights: readonly THREE.Object3D[], view: THREE.Frustum | null, now: number): boolean {
    const check = ++this.checks;
    const lightSig = lights.flatMap((l) => [l.id, ...l.matrixWorld.elements]);
    if (lightSig.length !== this.lights.length || lightSig.some((v, i) => v !== this.lights[i])) this.due = true;
    this.lights = lightSig;

    scene.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.castShadow) return;
      signature(m, this.sig);
      const known = this.casters.get(m);
      if (known) {
        known.check = check;
        if (known.sig.every((v, i) => v === this.sig[i])) return;
        // Where it was counts as much as where it is: leaving the view leaves its old shadow in it.
        this.was.fromArray(known.sig);
        known.sig.set(this.sig);
        if (this.inView(m, view, this.was)) {
          this.due = true;
          return;
        }
        if (!this.unseen.has(m)) this.unseen.set(m, this.was.clone());
      } else this.casters.set(m, { sig: Float64Array.from(this.sig), check });
      if (this.inView(m, view)) this.due = true;
      else if (!this.unseen.has(m)) this.unseen.set(m, null);
    });
    for (const [m, c] of this.casters) {
      if (c.check === check) continue;
      // Gone or hidden: its shadow is still in the map, wherever it was.
      this.casters.delete(m);
      this.unseen.delete(m);
      this.due = true;
    }
    if (!this.due) for (const [m, drawn] of this.unseen) if (this.inView(m, view) || (drawn && this.inView(m, view, drawn))) this.due = true;

    // A tenth of slack, or frame times a hair short of the interval would halve the rate.
    if (!this.due || now - this.drawnAt < 900 / this.hz) return false;
    this.due = false;
    this.drawnAt = now;
    // The redraw puts every caster in the map as it is, seen or not.
    this.unseen.clear();
    return true;
  }

  /** Forget everything: the next update redraws. */
  reset() {
    this.casters.clear();
    this.unseen.clear();
    this.lights = [];
    this.due = true;
    this.drawnAt = Number.NEGATIVE_INFINITY;
  }

  private inView(m: THREE.Mesh, view: THREE.Frustum | null, at: THREE.Matrix4 = m.matrixWorld): boolean {
    // An instanced mesh's geometry bounds say nothing about where its instances are.
    if (!view || (m as unknown as THREE.InstancedMesh).isInstancedMesh) return true;
    const geo = m.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    if (!geo.boundingSphere) return true;
    this.sphere.copy(geo.boundingSphere).applyMatrix4(at);
    this.sphere.radius += SHADOW_REACH;
    return view.intersectsSphere(this.sphere);
  }
}

function signature(m: THREE.Mesh, out: Float64Array) {
  out.set(m.matrixWorld.elements);
  const pos = m.geometry.attributes.position as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
  out[16] = !pos ? -1 : 'isInterleavedBufferAttribute' in pos ? pos.data.version : pos.version;
  const inst = m as unknown as THREE.InstancedMesh;
  out[17] = inst.isInstancedMesh ? inst.instanceMatrix.version : -1;
  out[18] = inst.isInstancedMesh ? inst.count : -1;
}
