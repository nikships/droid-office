/**
 * The team markings a worker wears (WorkerInfo.team), from `droid-team-kit.glb`: the lead's command
 * crown, a subagent's comms sleeves and headband, and the shoulder panels both wear. Every worker
 * shares the GLB's geometry, and every worker of one team shares its two materials: its accent, and
 * its emblem plate with the glyph painted on, so lighting a team up is two material changes.
 *
 * No DOM or WebGL at import time: the emblem canvas is drawn the first time a team is worn.
 */
import * as THREE from 'three';
import type { TeamBadge, TeamEmblem } from '../../shared/protocol';
import { toonUnique } from './toon';

type Piece = 'crown' | 'comms' | 'shoulders';
const NODES: Record<string, Piece> = { TeamCrown: 'crown', TeamComms: 'comms', TeamShoulders: 'shoulders' };

interface Part {
  geo: THREE.BufferGeometry;
  slot: 'accent' | 'emblem' | THREE.Material;
}

let pieces: Record<Piece, Part[]> | null = null;
const shared = new WeakSet<THREE.BufferGeometry>();
const kits = new Set<TeamKit>();

/** Whether `geo` is the team kit's, worn by many workers at once, so freeing one worker must leave it be. */
export function isTeamKitGeometry(geo: THREE.BufferGeometry): boolean {
  return shared.has(geo);
}

/**
 * Takes `droid-team-kit.glb`'s scene as the kit every team wears. `structural` are the droid's own
 * materials by GLB name (DroidGraphite, DroidSteel, DroidBlack), so the kit's frames match the body.
 */
export function setTeamKitModel(scene: THREE.Object3D, structural: Record<string, THREE.Material>) {
  const next: Record<Piece, Part[]> = { crown: [], comms: [], shoulders: [] };
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const piece = NODES[m.name] ?? NODES[m.parent?.name ?? ''];
    if (!piece) return;
    const name = (m.material as THREE.Material)?.name ?? '';
    const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
    shared.add(geo);
    next[piece].push({ geo, slot: name === 'TeamAccent' ? 'accent' : name === 'TeamEmblem' ? 'emblem' : (structural[name] ?? structural.DroidGraphite) });
  });
  if (!next.crown.length || !next.comms.length || !next.shoulders.length) return;
  pieces = next;
  for (const k of kits) k.refit();
}

export function teamKitReady(): boolean {
  return pieces !== null;
}

interface LookMats {
  accent: THREE.MeshToonMaterial;
  emblem: THREE.MeshToonMaterial;
}
const looks = new Map<string, LookMats>();
let focused: LookMats | null = null;

/** The emblem plate's material: white under its glyph texture, too small for the cartoon outline. */
export function emblemMaterial(map: THREE.Texture | null): THREE.MeshToonMaterial {
  const m = toonUnique('#ffffff');
  if (map) m.map = map;
  m.userData.outlineParameters = { visible: false };
  return m;
}

function lookMats(badge: TeamBadge): LookMats {
  const key = `${badge.accent}|${badge.emblem}`;
  let mats = looks.get(key);
  if (!mats) {
    mats = { accent: toonUnique(badge.accent), emblem: emblemMaterial(emblemTexture(badge.accent, badge.emblem)) };
    looks.set(key, mats);
  }
  return mats;
}

/** Lights up the markings of the team `badge` is on (aimed at), and puts the last one back. */
export function focusTeamKit(badge: TeamBadge | undefined) {
  const next = badge ? lookMats(badge) : null;
  if (next === focused) return;
  if (focused) {
    focused.accent.emissive.set(0x000000);
    focused.emblem.emissive.set(0x000000);
  }
  focused = next;
  if (next && badge) {
    next.accent.emissive.set(badge.accent).multiplyScalar(0.45);
    next.emblem.emissive.set(0xffffff).multiplyScalar(0.22);
  }
}

/** One stand-in of each kit material, for the shader warmup. */
export function teamKitStandIn(map: THREE.Texture): THREE.Group {
  const g = new THREE.Group();
  g.name = 'shader-warmup-team-kit';
  const plate = new THREE.PlaneGeometry(0.1, 0.1);
  g.add(new THREE.Mesh(plate, toonUnique('#2f7dff')), new THREE.Mesh(plate, emblemMaterial(map)));
  return g;
}

/** The markings one worker wears, on its body so they move, sit and fall with it. */
export class TeamKit {
  readonly group = new THREE.Group();
  private badge: TeamBadge | undefined;

  constructor() {
    this.group.name = 'team-kit';
    kits.add(this);
  }

  set(badge: TeamBadge | undefined) {
    const same = badge?.role === this.badge?.role && badge?.accent === this.badge?.accent && badge?.emblem === this.badge?.emblem;
    this.badge = badge;
    if (!same) this.refit();
  }

  /** Whether it wears the crown (`lead`), the comms kit (`member`), or nothing. */
  get role(): TeamBadge['role'] | undefined {
    return pieces && this.badge ? this.badge.role : undefined;
  }

  refit() {
    this.group.clear();
    if (!this.badge || !pieces) return;
    const mats = lookMats(this.badge);
    for (const p of [...pieces.shoulders, ...(this.badge.role === 'lead' ? pieces.crown : pieces.comms)]) {
      const m = new THREE.Mesh(p.geo, p.slot === 'accent' ? mats.accent : p.slot === 'emblem' ? mats.emblem : p.slot);
      m.castShadow = true;
      m.name = `team-${p.slot === 'accent' || p.slot === 'emblem' ? p.slot : 'frame'}`;
      this.group.add(m);
    }
  }

  dispose() {
    kits.delete(this);
    this.group.clear();
  }
}

const SIZE = 128;

/** The team's emblem plate: its glyph in white on its accent, inside a graphite rim the plate's edges sample. */
function emblemTexture(accent: string, emblem: TeamEmblem): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#1b1c20';
  g.fillRect(0, 0, SIZE, SIZE);
  g.fillStyle = accent;
  g.beginPath();
  g.roundRect(12, 12, SIZE - 24, SIZE - 24, 14);
  g.fill();
  g.beginPath();
  emblemPath(g, emblem, SIZE / 2, SIZE / 2, 38);
  g.lineJoin = 'round';
  g.lineWidth = 7;
  g.strokeStyle = '#111215';
  g.stroke();
  g.fillStyle = '#f6f7f8';
  g.fill('evenodd');
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Traces `emblem`, `r` across from its middle at (cx, cy), y down as a canvas has it. */
export function emblemPath(g: Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'closePath' | 'arc'>, emblem: TeamEmblem, cx: number, cy: number, r: number) {
  const poly = (pts: readonly (readonly [number, number])[]) => {
    pts.forEach(([x, y], i) => (i ? g.lineTo(cx + x * r, cy + y * r) : g.moveTo(cx + x * r, cy + y * r)));
    g.closePath();
  };
  const around = (n: number, at: (i: number) => number, start = -Math.PI / 2) => poly(Array.from({ length: n }, (_, i) => [Math.cos(start + (i * 2 * Math.PI) / n) * at(i), Math.sin(start + (i * 2 * Math.PI) / n) * at(i)] as const));
  switch (emblem) {
    case 'chevron':
      poly([
        [-0.95, 0.05],
        [0, -0.85],
        [0.95, 0.05],
        [0.95, 0.5],
        [0, -0.38],
        [-0.95, 0.5],
      ]);
      poly([
        [-0.95, 0.55],
        [0, -0.3],
        [0.95, 0.55],
        [0.95, 0.95],
        [0, 0.12],
        [-0.95, 0.95],
      ]);
      break;
    case 'star':
      around(10, (i) => (i % 2 ? 0.42 : 1));
      break;
    case 'diamond':
      poly([
        [0, -1],
        [0.72, 0],
        [0, 1],
        [-0.72, 0],
      ]);
      break;
    case 'bolt':
      poly([
        [0.2, -1],
        [-0.62, 0.12],
        [-0.05, 0.12],
        [-0.25, 1],
        [0.62, -0.18],
        [0.05, -0.18],
      ]);
      break;
    case 'ring':
      g.moveTo(cx + r * 0.95, cy);
      g.arc(cx, cy, r * 0.95, 0, Math.PI * 2);
      g.moveTo(cx + r * 0.5, cy);
      g.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
      break;
    case 'cross':
      poly([
        [-0.3, -0.95],
        [0.3, -0.95],
        [0.3, -0.3],
        [0.95, -0.3],
        [0.95, 0.3],
        [0.3, 0.3],
        [0.3, 0.95],
        [-0.3, 0.95],
        [-0.3, 0.3],
        [-0.95, 0.3],
        [-0.95, -0.3],
        [-0.3, -0.3],
      ]);
      break;
    case 'hex':
      around(6, () => 0.98, 0);
      break;
    case 'triangle':
      poly([
        [0, -0.95],
        [0.95, 0.8],
        [-0.95, 0.8],
      ]);
      break;
  }
}
