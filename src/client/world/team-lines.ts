import * as THREE from 'three';
import { GLASS_ROOM } from '../../shared/layout';

/** One dash and the gap after it, in meters. */
const PERIOD = 0.36;
const WIDTH = 0.07;
/** Over the desk pods' rugs (their top is 14 mm up) and the lounge's, so no floor covering hides a link. */
export const LINK_LIFT = 0.022;
/** How much wider a link draws while you aim at someone on its team. */
const FOCUS_WIDTH = 1.7;
const ANCHOR_RADIUS = 0.1;

/** A lead's seat, one of its subagents' seats, and their team. */
export interface TeamLink {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  color: string;
  team: string;
  /** Its subagent is working: its dashes march. */
  moving: boolean;
}

type Look = 'still' | 'moving' | 'still-focus' | 'moving-focus';
const OPACITY: Record<Look, number> = { still: 0.55, moving: 0.85, 'still-focus': 0.95, 'moving-focus': 1 };

/**
 * Whether a link from `a` to `b` would run through a wall: from one storey to another, or into,
 * out of or across the glass room, whose walls go down to the floor.
 */
export function linkBlocked(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
  if (Math.abs(a.y - b.y) > 0.3) return true;
  const inside = (p: { x: number; z: number }) => p.x > GLASS_ROOM.minX && p.x < GLASS_ROOM.maxX && p.z > GLASS_ROOM.minZ && p.z < GLASS_ROOM.maxZ;
  if (inside(a) && inside(b)) return false;
  if (inside(a) !== inside(b)) return true;
  // Both outside: does the segment pass through the room? (Liang-Barsky clip against its box.)
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const [p, q] of [
    [-dx, a.x - GLASS_ROOM.minX],
    [dx, GLASS_ROOM.maxX - a.x],
    [-dz, a.z - GLASS_ROOM.minZ],
    [dz, GLASS_ROOM.maxZ - a.z],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
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
 * Dashes on the floor from each lead to each of its subagents, in the team's accent, for as long as
 * both are on the floor. A working subagent's dashes march toward it; everyone else's lie still and
 * dimmer, so a finished team still shows. Aiming at anyone on a team brightens and widens its links.
 */
export class TeamLines {
  readonly group = new THREE.Group();
  /** Marching dashes share one texture, whose offset moves; still ones share another. */
  private textures: { moving: THREE.CanvasTexture; still: THREE.CanvasTexture } | null = null;
  private readonly mats = new Map<string, THREE.MeshBasicMaterial>();
  private anchorGeo: THREE.CircleGeometry | null = null;
  private key = '';
  private anyMoving = false;
  private focused: string | null = null;

  constructor() {
    this.group.name = 'team-lines';
  }

  /** Whether any link's dashes are marching, so the frame loop knows it has something to animate. */
  get moving(): boolean {
    return this.anyMoving;
  }

  /** Draws `links` instead of what was there. */
  set(links: TeamLink[]) {
    const drawn = links.filter((l) => !linkBlocked(l.from, l.to) && Math.hypot(l.to.x - l.from.x, l.to.z - l.from.z) >= 0.3);
    this.anyMoving = drawn.some((l) => l.moving);
    const key = drawn.map((l) => `${l.team}:${l.color}:${l.moving ? 1 : 0}:${l.from.x.toFixed(2)},${l.from.z.toFixed(2)}>${l.to.x.toFixed(2)},${l.to.z.toFixed(2)}`).join('|');
    if (key === this.key) return;
    this.key = key;
    for (const child of [...this.group.children]) {
      const m = child as THREE.Mesh;
      if (m.geometry !== this.anchorGeo) m.geometry.dispose();
      this.group.remove(child);
    }
    const anchored = new Set<string>();
    for (const l of drawn) {
      const dx = l.to.x - l.from.x;
      const dz = l.to.z - l.from.z;
      const len = Math.hypot(dx, dz);
      const geo = new THREE.PlaneGeometry(len, WIDTH).rotateX(-Math.PI / 2);
      // Dashes a fixed length apart whatever the line's length: the texture repeats along u.
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * (len / PERIOD));
      const m = new THREE.Mesh(geo, this.material(l.color, l.moving ? 'moving' : 'still'));
      m.position.set((l.from.x + l.to.x) / 2, Math.min(l.from.y, l.to.y) + LINK_LIFT, (l.from.z + l.to.z) / 2);
      m.rotation.y = Math.atan2(-dz, dx);
      m.renderOrder = 1;
      m.userData = { team: l.team, color: l.color, moving: l.moving };
      this.group.add(m);
      // A pad under each end, so a link reads as anchored at the desks rather than a stray stripe.
      for (const p of [l.from, l.to]) {
        const at = `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
        if (anchored.has(at)) continue;
        anchored.add(at);
        this.anchorGeo ??= new THREE.CircleGeometry(ANCHOR_RADIUS, 20).rotateX(-Math.PI / 2);
        const pad = new THREE.Mesh(this.anchorGeo, this.material(l.color, 'still', true));
        pad.position.set(p.x, p.y + LINK_LIFT, p.z);
        pad.renderOrder = 1;
        pad.userData = { team: l.team, color: l.color, moving: false, pad: true };
        this.group.add(pad);
      }
    }
    this.paintFocus();
  }

  /** Brightens the links of team `team` (the one you're aiming at), or none. */
  focus(team: string | null) {
    if (team === this.focused) return;
    this.focused = team;
    this.paintFocus();
  }

  update(dt: number) {
    if (this.anyMoving && this.textures) this.textures.moving.offset.x = (this.textures.moving.offset.x - dt * 1.2) % 1;
  }

  private paintFocus() {
    for (const child of this.group.children) {
      const m = child as THREE.Mesh;
      const { team, color, moving, pad } = m.userData as { team: string; color: string; moving: boolean; pad?: boolean };
      const on = team === this.focused;
      const look = `${moving ? 'moving' : 'still'}${on ? '-focus' : ''}` as Look;
      m.material = this.material(color, look, pad);
      if (!pad) m.scale.z = on ? FOCUS_WIDTH : 1;
      else m.scale.setScalar(on ? 1.25 : 1);
    }
  }

  private material(color: string, look: Look, solid = false): THREE.MeshBasicMaterial {
    const key = `${color}|${look}|${solid ? 'pad' : 'dash'}`;
    let mat = this.mats.get(key);
    if (mat) return mat;
    this.textures ??= { moving: dashTexture(), still: dashTexture() };
    const map = solid ? null : look.startsWith('moving') ? this.textures.moving : this.textures.still;
    mat = new THREE.MeshBasicMaterial({ color, map, transparent: true, opacity: OPACITY[look], depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    mat.userData.outlineParameters = { visible: false };
    this.mats.set(key, mat);
    return mat;
  }
}
