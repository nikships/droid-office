import * as THREE from 'three';

/** A soft round blob, white in the middle and fading out to nothing. */
function puffTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let steamTex: THREE.CanvasTexture | null = null;
const steamMats = new Map<number, THREE.PointsMaterial>();

function steamMaterial(size: number): THREE.PointsMaterial {
  let m = steamMats.get(size);
  if (!m) {
    steamTex ??= puffTexture();
    m = new THREE.PointsMaterial({ size, map: steamTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    m.userData.outlineParameters = { visible: false };
    steamMats.set(size, m);
  }
  return m;
}

const STEAM = 36;
/** How long a puff of steam lasts, from the stack's mouth until it's thinned out to nothing, in seconds. */
const STEAM_LIFE = 11;

/**
 * A slow plume of steam off a stack's mouth at `at`, leaning off on the breeze (+x). It needs no
 * update: each puff is wherever its age (from the clock) puts it, worked out as it's drawn, so it's
 * two point clouds, the young puffs small and the old ones spread wide, and every window sees the same plume.
 */
export class Steam {
  readonly group = new THREE.Group();

  constructor(at: THREE.Vector3, brightness = 0.025) {
    const pos = new THREE.BufferAttribute(new Float32Array(STEAM * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const layers = [1.8, 5.2].map((size) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', pos);
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(STEAM * 3), 3).setUsage(THREE.DynamicDrawUsage));
      const p = new THREE.Points(geo, steamMaterial(size));
      p.frustumCulled = false;
      p.raycast = () => {};
      this.group.add(p);
      return p;
    });
    const seeds = Array.from({ length: STEAM }, (_, i) => {
      const a = Math.sin(i * 12.9898) * 43758.5453;
      const b = Math.sin(i * 78.233) * 12543.1234;
      return [a - Math.floor(a), b - Math.floor(b)];
    });
    let drawn = -1;
    const place = () => {
      const t = performance.now() / 1000;
      if (t === drawn) return;
      drawn = t;
      const a = pos.array as Float32Array;
      const young = layers[0].geometry.getAttribute('color').array as Float32Array;
      const old = layers[1].geometry.getAttribute('color').array as Float32Array;
      for (let i = 0; i < STEAM; i++) {
        const [s0, s1] = seeds[i];
        const age = (t + (i / STEAM) * STEAM_LIFE + s0 * 0.3) % STEAM_LIFE;
        const k = age / STEAM_LIFE;
        const spread = 0.25 + 0.24 * age;
        const turn = s1 * Math.PI * 2 + age * 0.35;
        a[i * 3] = at.x + 0.32 * age + 0.025 * age * age + Math.cos(turn) * spread;
        a[i * 3 + 1] = at.y + 6.5 * (1 - Math.exp(-age / 4.2));
        a[i * 3 + 2] = at.z + Math.sin(turn) * spread;
        const born = Math.min(1, age * 1.5);
        const y = brightness * 0.5 * born * (1 - THREE.MathUtils.smoothstep(k, 0.05, 0.4));
        const o = brightness * 0.45 * THREE.MathUtils.smoothstep(k, 0.08, 0.35) * (1 - k) ** 1.6;
        young.fill(y, i * 3, i * 3 + 3);
        old.fill(o, i * 3, i * 3 + 3);
      }
      pos.needsUpdate = true;
      for (const l of layers) l.geometry.getAttribute('color').needsUpdate = true;
    };
    place();
    layers[0].onBeforeRender = place;
  }

  dispose() {
    for (const c of this.group.children) (c as THREE.Points).geometry.dispose();
  }
}

interface Puff {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  vel: THREE.Vector3;
  age: number;
  life: number;
  size0: number;
  size1: number;
  alpha: number;
  spin: number;
}

const MAX = 160;
const tmp = new THREE.Vector3();

/** Soft grey puffs that drift up, spread out and fade: muzzle smoke, and the dust off a landing. */
export class Smoke {
  readonly group = new THREE.Group();
  private live: Puff[] = [];
  private free: Puff[] = [];
  private geo = new THREE.PlaneGeometry(1, 1);
  private tex = puffTexture();

  /** A thin wisp, blown along `push` if it's given. */
  wisp(at: THREE.Vector3, push?: THREE.Vector3) {
    tmp.set((Math.random() - 0.5) * 0.06, 0.3 + Math.random() * 0.1, (Math.random() - 0.5) * 0.06);
    if (push) tmp.add(push);
    this.emit(at, tmp, 0.06, 0.4, 2.4, 0.5);
  }

  /** A burst of puffs along `dir` (a unit vector). */
  exhale(at: THREE.Vector3, dir: THREE.Vector3) {
    for (let i = 0; i < 8; i++) {
      const speed = 0.95 - i * 0.08;
      tmp.copy(dir).multiplyScalar(speed);
      tmp.x += (Math.random() - 0.5) * 0.15;
      tmp.y += 0.12 + (Math.random() - 0.5) * 0.1;
      tmp.z += (Math.random() - 0.5) * 0.15;
      const start = at.clone().addScaledVector(dir, i * 0.03);
      this.emit(start, tmp, 0.12, 0.75 + Math.random() * 0.35, 2.6 + Math.random() * 0.8, 0.6);
    }
  }

  private emit(at: THREE.Vector3, vel: THREE.Vector3, size0: number, size1: number, life: number, alpha: number) {
    let p = this.free.pop();
    if (!p) {
      if (this.live.length >= MAX) p = this.live.shift()!;
      else {
        const mat = new THREE.MeshBasicMaterial({ map: this.tex, color: '#dde2e8', transparent: true, depthWrite: false, opacity: 0 });
        // Drawn once, soft: no cartoon outline.
        mat.userData.outlineParameters = { visible: false };
        const mesh = new THREE.Mesh(this.geo, mat);
        mesh.renderOrder = 2;
        p = { mesh, vel: new THREE.Vector3(), age: 0, life: 1, size0: 0, size1: 0, alpha: 0, spin: 0 };
      }
    }
    p.mesh.position.copy(at);
    p.spin = Math.random() * Math.PI * 2;
    p.vel.copy(vel);
    p.age = 0;
    p.life = life;
    p.size0 = size0;
    p.size1 = size1;
    p.alpha = alpha;
    p.mesh.scale.setScalar(size0);
    p.mesh.material.opacity = 0;
    this.group.add(p.mesh);
    this.live.push(p);
  }

  /** Drifts, grows and fades every puff, turned to face the camera. */
  update(dt: number, camera: THREE.Camera) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.group.remove(p.mesh);
        this.live.splice(i, 1);
        this.free.push(p);
        continue;
      }
      const k = p.age / p.life;
      p.vel.multiplyScalar(Math.exp(-dt * 1.1));
      // Warm smoke rises; a light breeze carries it off.
      p.vel.y += dt * 0.12;
      p.vel.x += dt * 0.06;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.scale.setScalar(p.size0 + (p.size1 - p.size0) * (1 - (1 - k) ** 2));
      p.mesh.material.opacity = p.alpha * Math.min(1, p.age * 8) * (1 - k) ** 1.5;
      p.mesh.quaternion.copy(camera.quaternion);
      p.mesh.rotateZ(p.spin + p.age * 0.3);
    }
  }
}
