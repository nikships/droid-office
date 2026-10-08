import * as THREE from 'three';
import { BOOKSHELF, FLOOR } from '../../shared/layout';
import { mergeByMaterial, mesh, textPlane, toon } from './toon';
import type { Collider, Interactable } from './office';

// The bookshelf against the south wall: a tall wooden case, five shelves packed with books of every
// size and color (a few leaning over, a stack lying flat, a plant and a globe among them), and a
// Docs sign over the crown. E at it opens the project's Markdown to read (ui/bookshelf.ts). The
// right end of the fourth shelf is the floor's AutoWiki: a matched set of black volumes with orange
// spines once Factory has one for the repository, plain binders until then (setWiki).

/** What the AutoWiki end of the shelf shows: plain binders, the wiki's volumes, or them being written. */
export type ShelfWiki = 'none' | 'wiki' | 'writing';

export interface BookshelfModel {
  group: THREE.Group;
  collider: Collider;
  interactable: Interactable;
  /** Shows the floor's AutoWiki on the shelf. Only swaps what's visible: nothing is built or drawn. */
  setWiki(state: ShelfWiki): void;
}

// Binders and manuals in graphite, steel and light gray, with a Factory orange one now and then.
const SPINES = ['#1c1c1c', '#2a2a2a', '#3a3a3a', '#8c8c8c', '#d8d8d8', '#161616', '#ee6018', '#2a2a2a', '#101010', '#5a5a5a'];
const SHELVES = 5;
/** The case's boards, how far the shelves sit off the floor, and how thick they are. */
const SIDE = 0.05;
const BASE = 0.1;
const BOARD = 0.03;
/** The AutoWiki's place: the shelf it's on (from the bottom) and how much of its right end it takes. */
const WIKI_SHELF = 3;
const WIKI_RUN = 0.5;
const WIKI_ORANGE = '#ee6018';

export function buildBookshelf(): BookshelfModel {
  const { width: W, depth: D, height: H } = BOOKSHELF;
  // Seeded, so the shelf looks the same in every browser.
  let seed = 20250928;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];

  // Built facing +z, back against z = -D/2.
  const parts = new THREE.Group();
  const wood = toon('#1c1c1c');
  const woodDark = toon('#101010');
  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => parts.add(mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z));
  box(W, H, 0.03, woodDark, 0, H / 2, -D / 2 + 0.015);
  for (const sx of [-1, 1]) box(SIDE, H, D, wood, sx * (W / 2 - SIDE / 2), H / 2, 0);
  // A crown over the top and a kick board at the foot.
  box(W + 0.08, 0.07, D + 0.05, wood, 0, H + 0.035, 0.01);
  box(W - 2 * SIDE, BASE, D - 0.03, woodDark, 0, BASE / 2, -0.015);
  const inner = W - 2 * SIDE;

  const bay = (H - BASE - BOARD) / SHELVES;
  const front = D / 2 - 0.02;
  for (let s = 0; s < SHELVES; s++) {
    const floor = BASE + s * bay + BOARD;
    box(inner, BOARD, D - 0.03, wood, 0, floor - BOARD / 2, -0.015);
    const room = bay - BOARD - 0.04;
    let x = -inner / 2 + 0.02;
    const end = inner / 2 - 0.02 - (s === WIKI_SHELF ? WIKI_RUN : 0);
    // Now and then something that isn't a book: a globe on one shelf, a little plant on another.
    let ornament = s === 1 ? 'globe' : s === 3 ? 'plant' : null;
    const ornamentAt = -inner / 2 + inner * (0.5 + rand() * 0.2);
    while (x < end - 0.03) {
      if (ornament && x >= ornamentAt) {
        if (ornament === 'globe') {
          parts.add(mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.03, 12), woodDark, x + 0.13, floor + 0.015, 0));
          parts.add(mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.07, 6), woodDark, x + 0.13, floor + 0.06, 0));
          parts.add(mesh(new THREE.SphereGeometry(0.11, 14, 10), toon('#8c8c8c'), x + 0.13, floor + 0.18, 0));
          parts.add(mesh(new THREE.SphereGeometry(0.075, 10, 8), toon('#3a3a3a'), x + 0.16, floor + 0.21, 0.05));
        } else {
          parts.add(mesh(new THREE.CylinderGeometry(0.07, 0.055, 0.12, 10), toon('#2a2a2a'), x + 0.11, floor + 0.06, 0.02));
          parts.add(mesh(new THREE.SphereGeometry(0.1, 10, 8), toon('#4f7a5e'), x + 0.11, floor + 0.19, 0.02));
        }
        ornament = null;
        x += 0.28;
        continue;
      }
      // A stack lying flat, once in a while.
      if (rand() < 0.07 && end - x > 0.32) {
        let y = floor;
        const n = 2 + Math.floor(rand() * 3);
        for (let i = 0; i < n; i++) {
          const t = 0.04 + rand() * 0.03;
          const w = 0.22 + rand() * 0.08;
          box(w, t, 0.18 + rand() * 0.06, toon(pick(SPINES)), x + 0.15 + (rand() - 0.5) * 0.03, y + t / 2, front - 0.13);
          y += t;
        }
        x += 0.32;
        continue;
      }
      const t = 0.035 + rand() * 0.04;
      const h = Math.min(room, room * (0.62 + rand() * 0.38));
      const d = 0.19 + rand() * 0.08;
      if (x + t > end) break;
      // The last one or two in a row lean over on their neighbour when there's room.
      const lean = end - x < 0.24 && end - x > 0.14 && rand() < 0.6;
      const mat = toon(pick(SPINES));
      if (lean) {
        const g = new THREE.Group();
        const a = 0.32;
        g.add(mesh(new THREE.BoxGeometry(t, h, d), mat, t / 2, h / 2, 0));
        g.rotation.z = -a;
        g.position.set(x + 0.01, floor, front - d / 2);
        parts.add(g);
        x = end;
        break;
      }
      box(t, h, d, mat, x + t / 2, floor + h / 2, front - d / 2);
      // A band across some spines, near the top.
      if (rand() < 0.35) box(t + 0.004, 0.018, d + 0.004, toon(rand() < 0.25 ? '#ee6018' : '#8c8c8c'), x + t / 2, floor + h * 0.82, front - d / 2);
      x += t + (rand() < 0.1 ? 0.012 : 0.002);
    }
  }
  const group = new THREE.Group();
  group.add(mergeByMaterial(parts));

  // The AutoWiki end: two sets of volumes in the same place, one shown at a time.
  const wikiFloor = BASE + WIKI_SHELF * bay + BOARD;
  const wikiRoom = bay - BOARD - 0.04;
  const startX = inner / 2 - 0.02 - WIKI_RUN + 0.02;
  const plain = new THREE.Group();
  const volumes = new THREE.Group();
  const spine = toon('#141414');
  const band = toon(WIKI_ORANGE);
  // Unlit, so the spines' stripes read as a faint glow in the room's night light.
  const glow = new THREE.MeshBasicMaterial({ color: WIKI_ORANGE });
  for (let i = 0, vx = startX; i < 9; i++) {
    const t = 0.045;
    const d = 0.24;
    const vh = wikiRoom * 0.9;
    volumes.add(mesh(new THREE.BoxGeometry(t, vh, d), spine, vx + t / 2, wikiFloor + vh / 2, front - d / 2));
    volumes.add(mesh(new THREE.BoxGeometry(t + 0.004, 0.03, d + 0.004), band, vx + t / 2, wikiFloor + vh * 0.8, front - d / 2));
    volumes.add(mesh(new THREE.BoxGeometry(t * 0.5, vh * 0.42, 0.004), glow, vx + t / 2, wikiFloor + vh * 0.42, front + 0.001, false));
    const pt = 0.03 + rand() * 0.018;
    const ph = wikiRoom * (0.65 + rand() * 0.3);
    if (vx - startX < WIKI_RUN - 0.06) plain.add(mesh(new THREE.BoxGeometry(pt, ph, 0.2), toon(pick(['#2a2a2a', '#3a3a3a', '#5a5a5a', '#1c1c1c', '#8c8c8c'])), startX + i * 0.052 + pt / 2, wikiFloor + ph / 2, front - 0.1));
    vx += t + 0.006;
  }
  const label = (text: string) => {
    const l = textPlane(text, { size: 18, bg: '#0a0a0a', color: WIKI_ORANGE, border: '#2e2e2e' });
    l.scale.setScalar(0.55);
    l.position.set(startX + WIKI_RUN / 2 - 0.02, wikiFloor - BOARD / 2, D / 2 + 0.004);
    return l;
  };
  const written = label('AUTOWIKI');
  const writing = label('AUTOWIKI · WRITING');
  const plainMerged = mergeByMaterial(plain);
  const volumesMerged = mergeByMaterial(volumes);
  group.add(plainMerged, volumesMerged, written, writing);
  const setWiki = (state: ShelfWiki) => {
    plainMerged.visible = state === 'none';
    volumesMerged.visible = state !== 'none';
    written.visible = state === 'wiki';
    writing.visible = state === 'writing';
  };
  setWiki('none');
  // A label along the crown; the zone's 06 DOCUMENTATION plate hangs on the wall over it (world/factory-floor.ts).
  const sign = textPlane('PROJECT DOCS', { size: 28, bg: '#0a0a0a', color: '#eeeeee', border: '#2e2e2e' });
  sign.position.set(0, H + 0.3, 0.02);
  group.add(sign);

  // Built facing +z; it stands against the south wall facing into the room (-z).
  group.position.set(BOOKSHELF.x, 0, BOOKSHELF.z);
  group.rotation.y = Math.PI;
  const collider: Collider = { minX: BOOKSHELF.x - W / 2 - 0.04, maxX: BOOKSHELF.x + W / 2 + 0.04, minZ: BOOKSHELF.z - D / 2 - 0.03, maxZ: FLOOR.maxZ, top: H + 0.07 };
  const interactable: Interactable = { kind: 'bookshelf', x: BOOKSHELF.x, z: BOOKSHELF.z - 1.2, radius: 1.6 };
  group.userData.interact = interactable;
  return { group, collider, interactable, setWiki };
}
