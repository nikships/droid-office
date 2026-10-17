import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LOCK_WARP_MS, PlayerController } from '../src/client/player.js';

type Answer = 'grant' | 'unsupported' | 'unsupported-event-last';

/**
 * A page with pointer lock, the way Chromium answers `requestPointerLock`: the lock lands (pointerlockchange) and the
 * promise resolves, or a raw request on a platform without it rejects with NotSupportedError and also fires
 * pointerlockerror, in either order.
 */
function page(t: TestContext, answer: (opts: PointerLockOptions | undefined) => Answer) {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    pointerLockElement: null as unknown,
    exitPointerLock() {
      doc.pointerLockElement = null;
      queueMicrotask(() => doc.dispatchEvent(new Event('pointerlockchange')));
    },
  });
  const asked: (PointerLockOptions | undefined)[] = [];
  const dom = Object.assign(new EventTarget(), {
    requestPointerLock(opts?: PointerLockOptions) {
      asked.push(opts);
      const a = answer(opts);
      if (a === 'grant') {
        return Promise.resolve().then(() => {
          doc.pointerLockElement = dom;
          doc.dispatchEvent(new Event('pointerlockchange'));
        });
      }
      const refuse = () => Promise.reject(Object.assign(new Error('unadjustedMovement is not supported'), { name: 'NotSupportedError' }));
      if (a === 'unsupported') {
        doc.dispatchEvent(new Event('pointerlockerror'));
        return refuse();
      }
      return refuse().finally(() => setTimeout(() => doc.dispatchEvent(new Event('pointerlockerror')), 0));
    },
  });
  for (const [name, value] of [
    ['window', win],
    ['document', doc],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const player = new PlayerController(new THREE.PerspectiveCamera(), dom as unknown as HTMLElement, []);
  const move = (dx: number, dy = 0) => win.dispatchEvent(Object.assign(new Event('pointermove'), { movementX: dx, movementY: dy }));
  return { player, asked, doc, move };
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const unlocked = async (p: PlayerController) => {
  p.unlock();
  await settle();
};

test('raw input asks for an unadjusted lock and says so; turned off, the next lock is ordinary', async (t) => {
  const { player, asked } = page(t, () => 'grant');
  assert.equal(player.rawMouse, null, 'nothing to say before a lock');
  player.rawInput = true;
  player.lock();
  await settle();
  assert.equal(player.locked, true);
  assert.deepEqual(asked, [{ unadjustedMovement: true }]);
  assert.equal(player.rawMouse, true);

  await unlocked(player);
  player.rawInput = false;
  player.lock();
  await settle();
  assert.equal(player.locked, true);
  assert.deepEqual(asked.at(-1), undefined);
  assert.equal(player.rawMouse, false);

  await unlocked(player);
  player.rawInput = true;
  player.lock();
  await settle();
  assert.equal(player.rawMouse, true, 'and back to raw on the lock after that');
});

for (const order of ['unsupported', 'unsupported-event-last'] as const) {
  test(`where raw input is refused (pointerlockerror ${order === 'unsupported' ? 'first' : 'last'}), the lock is asked for again without it`, async (t) => {
    const { player, asked } = page(t, (opts) => (opts?.unadjustedMovement ? order : 'grant'));
    player.rawInput = true;
    player.lock();
    await settle();
    assert.deepEqual(asked, [{ unadjustedMovement: true }, undefined]);
    assert.equal(player.locked, true);
    assert.equal(player.rawMouse, false);
    assert.equal(player.canLock, true, 'the refusal of raw input is not the browser refusing the lock');

    await unlocked(player);
    player.lock();
    await settle();
    assert.deepEqual(asked.at(-1), undefined, 'later locks no longer ask for raw input');
    assert.equal(player.locked, true);
  });
}

test('look sensitivity scales how far a captured move turns the view', async (t) => {
  const { player, move } = page(t, () => 'grant');
  player.lock();
  await settle();
  await new Promise((r) => setTimeout(r, LOCK_WARP_MS + 20));
  for (const sensitivity of [0.5, 1, 2.5]) {
    player.lookSensitivity = sensitivity;
    const yaw = player.camYaw;
    move(100);
    assert.ok(Math.abs(yaw - player.camYaw - 100 * 0.0022 * sensitivity) < 1e-9, `at ${sensitivity}× turned ${yaw - player.camYaw}`);
  }
});

test('a captured move turns the view by all of it once the lock has settled, but not the warp as it lands', async (t) => {
  const { player, move } = page(t, () => 'grant');
  player.lock();
  await settle();
  const yaw = player.camYaw;
  move(900);
  assert.equal(player.camYaw, yaw, 'a huge move just after the lock is the cursor warping');
  await new Promise((r) => setTimeout(r, LOCK_WARP_MS + 20));
  move(600);
  assert.ok(Math.abs(yaw - player.camYaw - 600 * 0.0022) < 1e-9, `turned ${yaw - player.camYaw}`);
});
