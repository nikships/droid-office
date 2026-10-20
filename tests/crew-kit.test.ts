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
      assert.ok(size.x > 0.65 && size.x < 0.75, `width ${size.x}`);
      assert.ok(size.y > 1.1 && size.y < 1.3, `height ${size.y}`);
      assert.ok(size.z > 0.44 && size.z < 0.56, `depth ${size.z}`);

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
    assert.ok(crown.max.y > 1.05, `the crown rises over the head (${crown.max.y})`);
    assert.ok(crown.max.y < WORKER_PIVOTS.bulb.y - 0.0475, 'and stays under the status beacon');
    const comms = box(follower);
    assert.ok(comms.max.y < 1.02, 'a subagent has no crown');
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
