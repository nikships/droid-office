import * as THREE from 'three';

/** One dash and the gap after it, in meters. */
const PERIOD = 0.36;
const WIDTH = 0.07;
/** Just over the floor planks, under every rug's top. */
const LIFT = 0.006;

/** A lead's seat, one of its subagents' seats, and the lead's color. */
export interface TeamLink {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  color: string;
}

function dashTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 4;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 38, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Dashes on the floor from each lead to its subagents, in the lead's color, marching toward the
 * subagents while any of them works: a team shows from across the room.
 */
export class TeamLines {
  readonly group = new THREE.Group();
  private texture: THREE.CanvasTexture | null = null;
  private readonly mats = new Map<string, THREE.MeshBasicMaterial>();
  private key = '';
  private moving = false;

  constructor() {
    this.group.name = 'team-lines';
  }

  /** Draws `links` instead of what was there; `moving` marches the dashes. */
  set(links: TeamLink[], moving: boolean) {
    this.moving = moving;
    const key = links.map((l) => `${l.color}:${l.from.x.toFixed(2)},${l.from.z.toFixed(2)}>${l.to.x.toFixed(2)},${l.to.z.toFixed(2)}`).join('|');
    if (key === this.key) return;
    this.key = key;
    for (const child of [...this.group.children]) {
      (child as THREE.Mesh).geometry.dispose();
      this.group.remove(child);
    }
    for (const l of links) {
      const dx = l.to.x - l.from.x;
      const dz = l.to.z - l.from.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.3) continue;
      const geo = new THREE.PlaneGeometry(len, WIDTH).rotateX(-Math.PI / 2);
      // Dashes a fixed length apart whatever the line's length: the texture repeats along u.
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (len / PERIOD));
      const m = new THREE.Mesh(geo, this.material(l.color));
      m.position.set((l.from.x + l.to.x) / 2, Math.min(l.from.y, l.to.y) + LIFT, (l.from.z + l.to.z) / 2);
      m.rotation.y = Math.atan2(-dz, dx);
      m.renderOrder = 1;
      this.group.add(m);
    }
  }

  update(dt: number) {
    if (this.moving && this.texture) this.texture.offset.x = (this.texture.offset.x - dt * 1.2) % 1;
  }

  private material(color: string): THREE.MeshBasicMaterial {
    let mat = this.mats.get(color);
    if (mat) return mat;
    this.texture ??= dashTexture();
    mat = new THREE.MeshBasicMaterial({ color, map: this.texture, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    mat.userData.outlineParameters = { visible: false };
    this.mats.set(color, mat);
    return mat;
  }
}
