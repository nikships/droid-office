import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { randomLook } from '../src/shared/avatar';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { TeamBadge } from '../src/shared/protocol';
import { isSharedGeometry, parseWorker, Person, setTeamKit, WORKER_PIVOTS, Worker, workerReady } from '../src/client/world/character';
import { focusTeamKit } from '../src/client/world/team-kit';

/** A person needs text canvases for its label; this only looks at its meshes. */
function canvasDocument() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const canvas = { width: 1, height: 1, getContext: () => context };
        const context = new Proxy({ canvas, measureText: (text: string) => ({ width: text.length * 12 }) }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
        return canvas;
      },
    },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  };
}

test('only the crew kit counts as shared geometry, and every person wears the same one', () => {
  const restore = canvasDocument();
  try {
    const kitGeometries = (p: Person) => {
      const kit = p.root.getObjectByName('crew-kit');
      assert.ok(kit, 'a person wears a crew kit');
      return kit.children.map((m) => (m as THREE.Mesh).geometry);
    };
    const a = new Person('A', '#161616', randomLook());
    const b = new Person('B', '#3a3a3a', randomLook());
    const kit = kitGeometries(a);
    assert.equal(kit.length, 2);
    for (const geo of kit) assert.ok(isSharedGeometry(geo));
    assert.deepEqual(kitGeometries(b), kit);

    const own: THREE.BufferGeometry[] = [];
    a.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !kit.includes(m.geometry)) own.push(m.geometry);
    });
    assert.ok(own.length > 0);
    for (const geo of own) assert.equal(isSharedGeometry(geo), false);
  } finally {
    restore();
  }
});

test('droid-worker.glb upgrades waiting workers and mounts articulated droid parts on shared geometry', async () => {
  const restore = canvasDocument();
  try {
    const waiting = new Worker('Waiting', '#ee6018');
    waiting.setStatus('working');
    waiting.update(0.1, 1.0);

    const glb = readFileSync(new URL('../src/client/public/props/droid-worker.glb', import.meta.url));
    await parseWorker(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
    assert.equal(workerReady(), true);

    const fresh = new Worker('Fresh', '#3b82f6');
    waiting.body.scale.setScalar(1);
    for (const w of [waiting, fresh]) {
      w.root.updateMatrixWorld(true);
      const box = new THREE.Box3();
      w.body.traverseVisible((o) => {
        if ((o as THREE.Mesh).isMesh) box.expandByObject(o);
      });
      const size = box.getSize(new THREE.Vector3());
      assert.ok(size.x > 0.54 && size.x < 0.66, `width ${size.x}`);
      assert.ok(size.y > 1.24 && size.y < 1.36, `height ${size.y}`);
      assert.ok(size.z > 0.34 && size.z < 0.72, `depth ${size.z}`);

      const skin = w.body.children[0] as THREE.Mesh;
      assert.ok(skin.isMesh, 'body.children[0] remains the worker-colored armor mesh');
      assert.equal(isSharedGeometry(skin.geometry), false, 'each worker owns a clone of the GLB geometry so casualties can dispose it');
    }

    assert.equal(fresh.armL.position.x, WORKER_PIVOTS.armL.x);
    assert.equal(fresh.armR.position.x, WORKER_PIVOTS.armR.x);
    fresh.setStatus('working');
    fresh.update(0.2, 1.2);
    fresh.leave('Heading out');
    fresh.say('See ya');
    fresh.update(0.1, 1.3);
    waiting.die(false);
    waiting.update(0.1, 1.3);
    waiting.dispose();
    fresh.dispose();
  } finally {
    restore();
  }
});

test('droid-team-kit.glb mounts the crown on a lead and the comms kit on a subagent, shared per team, clear of the beacon and untouched by status', async () => {
  const restore = canvasDocument();
  try {
    const load = (name: string) => {
      const glb = readFileSync(new URL(`../src/client/public/props/${name}.glb`, import.meta.url));
      return glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
    };
    await parseWorker(load('droid-worker'));
    const kitScene = await new Promise<THREE.Object3D>((resolve, reject) => new GLTFLoader().parse(load('droid-team-kit'), '', (g) => resolve(g.scene), reject));
    for (const node of ['TeamCrown', 'TeamComms', 'TeamShoulders']) assert.ok(kitScene.getObjectByName(node), `${node} is in the GLB`);

    const lead = new Worker('Lead', '#ee6018');
    assert.equal(lead.teamRole, undefined, 'nothing to wear before the kit lands');
    const badge: TeamBadge = { id: 'lead', role: 'lead', accent: '#2f7dff', emblem: 'star', leadName: 'Lead' };
    lead.setTeam(badge);
    setTeamKit(kitScene);
    assert.equal(lead.teamRole, 'lead', 'a worker that put its markings on early gets them once the kit lands');
    const follower = new Worker('Follower', '#3b82f6');
    follower.setTeam({ ...badge, role: 'member' });
    const other = new Worker('Other', '#9bc53d');
    other.setTeam({ id: 'other', role: 'member', accent: '#ff3d7f', emblem: 'bolt', leadName: 'Bo' });

    const kitOf = (w: Worker) => w.root.getObjectByName('team-kit')!;
    const meshes = (w: Worker) => kitOf(w).children as THREE.Mesh[];
    const box = (w: Worker) => {
      w.root.updateMatrixWorld(true);
      return new THREE.Box3().setFromObject(kitOf(w));
    };
    assert.equal(kitOf(lead).parent, lead.body, 'worn on the body, so it sits, walks and falls with it');
    // The crown: up over the head, below the beacon's bottom, and only on the lead.
    const crown = box(lead);
    assert.ok(crown.max.y > 1.28, `the crown rises over the head (${crown.max.y})`);
    assert.ok(crown.max.y < WORKER_PIVOTS.bulb.y - 0.0475, 'and stays under the status beacon');
    const comms = box(follower);
    assert.ok(comms.max.y < 1.275 && comms.max.y < crown.max.y - 0.025, `a subagent has no crown (${comms.max.y})`);
    assert.ok(comms.max.x > 0.29 && comms.min.x < -0.29, 'its comms caps sleeve both ear pods');

    // One team shares its geometry and its two materials; another team has its own materials.
    for (const m of meshes(lead)) assert.ok(isSharedGeometry(m.geometry));
    const accent = (w: Worker) => meshes(w).find((m) => m.name === 'team-accent')!.material as THREE.MeshToonMaterial;
    const emblem = (w: Worker) => meshes(w).find((m) => m.name === 'team-emblem')!.material as THREE.MeshToonMaterial;
    assert.equal(accent(lead), accent(follower));
    assert.equal(emblem(lead), emblem(follower));
    assert.notEqual(accent(lead), accent(other));
    assert.equal(`#${accent(lead).color.getHexString()}`, badge.accent);

    // Finishing, sleeping, waiting and resuming change the beacon, never the markings.
    const before = meshes(follower).map((m) => [m.geometry, m.material]);
    for (const s of ['done', 'offline', 'needs_input', 'working'] as const) {
      follower.setStatus(s, false);
      follower.update(0.1, 1);
    }
    assert.deepEqual(
      meshes(follower).map((m) => [m.geometry, m.material]),
      before,
    );

    // Aiming at the team lights its markings, and only its own.
    focusTeamKit(badge);
    assert.ok(accent(lead).emissive.getHex() !== 0);
    assert.equal(accent(other).emissive.getHex(), 0);
    focusTeamKit(undefined);
    assert.equal(accent(lead).emissive.getHex(), 0);

    follower.setTeam(undefined);
    assert.equal(meshes(follower).length, 0);
    for (const w of [lead, follower, other]) w.dispose();
  } finally {
    restore();
  }
});

test('seated workers fit the task chair and clear the over-the-shoulder screen sightline while articulating across acts', async () => {
  const restore = canvasDocument();
  try {
    const load = (name: string) => {
      const glb = readFileSync(new URL(`../src/client/public/props/${name}.glb`, import.meta.url));
      return glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
    };
    await parseWorker(load('droid-worker'));
    const kitScene = await new Promise<THREE.Object3D>((resolve, reject) => new GLTFLoader().parse(load('droid-team-kit'), '', (g) => resolve(g.scene), reject));
    setTeamKit(kitScene);

    // Mount at exact desk seatAnchor (0, 0.4, 0.93), rotY = Math.PI, scale = 0.82.
    const desk = new THREE.Group();
    const seatAnchor = new THREE.Group();
    seatAnchor.position.set(0, 0.4, 0.93);
    seatAnchor.rotation.y = Math.PI;
    seatAnchor.scale.setScalar(0.82);
    desk.add(seatAnchor);

    const w = new Worker('Byte', '#ee6018');
    w.setSeat('chair');
    w.setTeam({ id: 'lead', role: 'lead', accent: '#fbbf24', emblem: 'star', leadName: 'Byte' });
    seatAnchor.add(w.root);
    w.setStatus('working', false);
    for (let i = 0; i < 60; i++) w.update(1 / 60, i / 60);
    desk.updateMatrixWorld(true);

    // Thighs bend horizontally across the seat cushion, shins drop over the front waterfall edge.
    assert.ok(w.thighL.rotation.x < -1.45, `thigh bent onto cushion (${w.thighL.rotation.x})`);
    assert.ok(w.shinL.rotation.x > 1.25, `shin bent over waterfall edge (${w.shinL.rotation.x})`);
    assert.ok(w.forearmL.rotation.x < -0.6, `forearm angled onto keyboard (${w.forearmL.rotation.x})`);

    // Helmet stays below the player's (0, 1.4, 2.4) -> screen bottom (0.8906, -0.4912) sightline,
    // and the beacon dome crests gently near the chair top (< 1.22 m).
    const headBox = new THREE.Box3().setFromObject(w.head);
    assert.ok(headBox.max.y < 1.22, `seated beacon crest ${headBox.max.y}`);

    // Exercise every tool action, beanbag, plinth, visit walk, and head-synced crown.
    for (const action of ['edit', 'read', 'test', 'web', 'failing'] as const) {
      w.setAction(action);
      for (let i = 0; i < 300; i++) w.update(1 / 60, 2 + i / 60);
    }
    const kitMeshes = w.root.getObjectByName('team-kit')!.children as THREE.Mesh[];
    const headPieces = kitMeshes.filter((m) => m.userData.headPiece);
    assert.ok(headPieces.length > 0, 'crown meshes follow the head joint');
    assert.deepEqual(headPieces[0].quaternion.toArray(), w.head.quaternion.toArray());

    // Getting up for a visit unfolds the legs into a full standing stride, then sits back down.
    w.visitPose = 'stand';
    w.walking = true;
    for (let i = 0; i < 60; i++) w.update(1 / 60, 10 + i / 60);
    assert.ok(Math.abs(w.body.position.y) < 0.08, 'upright while walking');
    w.walking = false;
    w.visitPose = null;
    for (let i = 0; i < 60; i++) w.update(1 / 60, 12 + i / 60);
    assert.ok(w.body.position.y < -0.4, 'settled back onto the chair cushion');

    w.setSeat('beanbag');
    w.update(1 / 60, 13);
    assert.ok(w.shinL.rotation.x < 0.9, 'legs stretch lower around the beanbag lap tray');

    w.setSeat('plinth');
    w.setStatus('idle', false);
    for (let i = 0; i < 60; i++) w.update(1 / 60, 14 + i / 60);
    assert.ok(Math.abs(w.body.position.y + 0.085) < 0.02, 'boots flush on the Orchestrator plinth');

    w.dispose();
  } finally {
    restore();
  }
});

test('reading workers pinch the clipboard notepad between both hands below the visor with the printed sheet facing their eyes', async () => {
  const restore = canvasDocument();
  try {
    const glb = readFileSync(new URL('../src/client/public/props/droid-worker.glb', import.meta.url));
    await parseWorker(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));

    const desk = new THREE.Group();
    const seatAnchor = new THREE.Group();
    seatAnchor.position.set(0, 0.4, 0.93);
    seatAnchor.rotation.y = Math.PI;
    seatAnchor.scale.setScalar(0.82);
    desk.add(seatAnchor);

    const seated = new Worker('Reader', '#ee6018');
    seated.setSeat('chair');
    seatAnchor.add(seated.root);

    const standing = new Worker('Orchestrator', '#3b82f6');
    standing.setSeat('plinth');

    for (const w of [seated, standing]) {
      const notepad = w.root.getObjectByName('worker-notepad') as THREE.Group | undefined;
      assert.ok(notepad, 'worker mounts a named notepad prop');
      assert.equal(notepad.visible, false, 'notepad starts hidden');

      const meshes = notepad.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh);
      assert.equal(meshes.length, 4, 'clipboard uses compact board, pad, clip and tab meshes without stacked 3D ink bars');
      const pad = meshes.find((m) => Array.isArray(m.material))!;
      assert.ok(pad, 'paper pad carries edge and printed face materials');
      const padMats = pad.material as THREE.MeshToonMaterial[];
      assert.ok(padMats[5].map, 'printed sheet texture sits on the -z face toward the worker');
      assert.deepEqual(padMats[5].userData.outlineParameters, { visible: false }, 'printed face disables backface outline shell');

      w.setStatus('working', false);
      w.setAction('read');
      for (let i = 0; i < 180; i++) w.update(1 / 60, i / 60);
      w.root.updateMatrixWorld(true);

      assert.equal(notepad.visible, true, 'notepad appears during read action');
      assert.ok(Math.abs(notepad.scale.x - 1) < 0.02, `settled scale ${notepad.scale.x}`);

      const bodyInv = w.body.matrixWorld.clone().invert();
      const boxInBody = (obj: THREE.Object3D) => {
        const box = new THREE.Box3();
        obj.traverse((child) => {
          const m = child as THREE.Mesh;
          if (!m.isMesh) return;
          m.geometry.computeBoundingBox();
          const local = m.geometry.boundingBox!.clone();
          local.applyMatrix4(bodyInv.clone().multiply(m.matrixWorld));
          box.union(local);
        });
        return box;
      };

      const padBox = boxInBody(notepad);
      const handL = boxInBody(w.forearmL);
      const handR = boxInBody(w.forearmR);

      // Both hands pinch the left (-x) and right (+x) edges of the clipboard symmetrically.
      assert.ok(Math.abs(handL.max.x - padBox.min.x) < 0.035, `armL inner palm meets -x board edge (${handL.max.x} vs ${padBox.min.x})`);
      assert.ok(Math.abs(handR.min.x - padBox.max.x) < 0.035, `armR inner palm meets +x board edge (${handR.min.x} vs ${padBox.max.x})`);
      for (const [side, hand] of [
        ['L', handL],
        ['R', handR],
      ] as const) {
        assert.ok(hand.max.y > padBox.min.y + 0.04 && hand.min.y < padBox.max.y - 0.04, `hand ${side} overlaps notepad height`);
        assert.ok(hand.max.z > padBox.min.z && hand.min.z < padBox.max.z, `hand ${side} cradles notepad depth`);
      }

      // Held below the visor sightline with the -z printed sheet angled up toward the eyes.
      const padCenter = padBox.getCenter(new THREE.Vector3());
      assert.ok(padCenter.y < WORKER_PIVOTS.eyeL.y - 0.12, `notepad center (${padCenter.y}) stays below eye level (${WORKER_PIVOTS.eyeL.y})`);
      assert.ok(padBox.max.y < WORKER_PIVOTS.eyeL.y, `notepad top (${padBox.max.y}) does not block the eyes`);

      const sheetNormal = new THREE.Vector3(0, 0, -1).applyQuaternion(notepad.quaternion).normalize();
      const midEye = WORKER_PIVOTS.eyeL.clone().add(WORKER_PIVOTS.eyeR).multiplyScalar(0.5);
      const toEyes = midEye.sub(padCenter).normalize();
      assert.ok(sheetNormal.dot(toEyes) > 0.9, `printed sheet faces the worker's eyes (dot ${sheetNormal.dot(toEyes)})`);

      // Switching back to typing hides the notepad cleanly.
      w.setAction('edit');
      for (let i = 0; i < 180; i++) w.update(1 / 60, 4 + i / 60);
      assert.equal(notepad.visible, false, 'notepad hides once reading ends');
    }

    // Re-enter read at the desk and verify the notepad clears the desk rear edge (z = 0.55).
    seated.setAction('read');
    for (let i = 0; i < 180; i++) seated.update(1 / 60, 8 + i / 60);
    desk.updateMatrixWorld(true);
    const deskPadBox = new THREE.Box3().setFromObject(seated.root.getObjectByName('worker-notepad')!);
    assert.ok(deskPadBox.min.z > 0.55, `seated notepad clears the desk edge (${deskPadBox.min.z})`);

    // Pupils scan from the left margin (+x on the -z face) to the right edge (-x) across a line.
    seated.update(0, (10 + 0.1) / 0.85);
    const startX = seated.head.children.find((c) => c.position.z > 0.16 && c.children.length > 0)!.position.x;
    seated.update(0, (10 + 0.9) / 0.85);
    const endX = seated.head.children.find((c) => c.position.z > 0.16 && c.children.length > 0)!.position.x;
    assert.ok(startX > endX, `pupils scan left-to-right across the sheet (${startX} -> ${endX})`);

    seated.dispose();
    standing.dispose();
  } finally {
    restore();
  }
});
