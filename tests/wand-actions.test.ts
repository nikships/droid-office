import assert from 'node:assert/strict';
import test from 'node:test';
import { wandShipRequest, wandWorker, WAND_SHIP_REACH } from '../src/client/wand-actions.js';
import { LEVITATE_HEIGHT, LEVITATE_TIME, Worker } from '../src/client/world/character.js';
import { WAND_MOVES, WandMotion } from '../src/client/world/wand-motion.js';
import { PROMPTS } from '../src/shared/prompts.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

function worker(patch: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id: 'worker', name: 'Sky', kind: 'agent', deskId: 'desk-1', color: '#ffbd69', status: 'idle', acked: true, createdBy: 'test', createdAt: 0, ...patch };
}

const guest: NonNullable<WorkerInfo['guest']> = { pid: 1, tty: 'test', provider: 'droid', cwd: '/test', startedAt: 0, seen: 'process' };
const cloud: NonNullable<WorkerInfo['cloud']> = { computerId: 'computer', computerName: 'Remote', autonomy: 'high' };

test('Ship it requires one directly aimed body in close range, never a nearest-worker fallback', () => {
  assert.equal(wandWorker(null, WAND_SHIP_REACH), null);
  assert.equal(wandWorker({ workerId: null, distance: 1 }, WAND_SHIP_REACH), null);
  assert.equal(wandWorker({ workerId: 'one', distance: WAND_SHIP_REACH }, WAND_SHIP_REACH), 'one');
  assert.equal(wandWorker({ workerId: 'one', distance: WAND_SHIP_REACH + 0.01 }, WAND_SHIP_REACH), null);
  assert.equal(wandWorker({ workerId: 'one', distance: 1000 }), 'one', 'levitation can target a distant visible worker');
});

test('Ship it sends only an intent prompt to the selected worker, leaving Git decisions to the agent', () => {
  const prompt = PROMPTS['wand.ship'].text;
  const request = wandShipRequest(worker(), prompt);
  assert.deepEqual(request, { t: 'worker.prompt', workerId: 'worker', prompt });
  assert.match(prompt, /intended target branch/);
  assert.match(prompt, /floor branch policy/);
  assert.match(prompt, /merge its pull request/);
  assert.match(prompt, /Use your judgment/);
  assert.doesNotMatch(prompt, /git |gh |glab |1\.|--force/);
  assert.deepEqual(wandShipRequest(worker({ status: 'working' }), 'Ship my work'), { t: 'worker.prompt', workerId: 'worker', prompt: 'Ship my work', queue: true });
  assert.deepEqual(wandShipRequest(worker({ kind: 'cloud', cloud, status: 'working' }), 'Ship my work'), { t: 'worker.prompt', workerId: 'worker', prompt: 'Ship my work' });
});

test('Ship it cannot type a shipping request into a shell or target a missing or unavailable worker', () => {
  for (const w of [
    undefined,
    worker({ kind: 'shell' }),
    worker({ guest }),
    worker({ cloud: { ...cloud, error: 'Gone' } }),
    worker({ lost: true }),
    worker({ status: 'offline' }),
    worker({ status: 'exited' }),
    worker({ status: 'starting' }),
  ])
    assert.equal(typeof wandShipRequest(w, 'Ship my work'), 'string');
  assert.equal(typeof wandShipRequest(worker(), '  '), 'string');
});

test('the sparkler starts the party once per spell, not once for each spark', () => {
  const motion = new WandMotion();
  motion.draw();
  motion.update(1);
  motion.spell('sparkler');
  const cues: string[] = [];
  for (let i = 0; i < 120; i++) cues.push(...motion.update(1 / 60));
  assert.equal(cues.filter((cue) => cue === 'party').length, 1);
  assert.equal(cues.filter((cue) => cue === 'spark').length, 16);
  motion.spell('ship');
  motion.update(0.2);
  motion.cast();
  assert.ok(!motion.update(1).includes('confetti'), 'a canceled ship gesture cannot send a shipping request');
  assert.ok(!WAND_MOVES.build.cues.some(([, cue]) => cue === 'party' || cue === 'confetti'));
});

function model(t: { after(fn: () => void): void }) {
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
  const m = new Worker('Sky', '#ffbd69');
  m.setStatus('working', false);
  m.setAction('read');
  m.root.scale.setScalar(0.85);
  t.after(() => {
    m.dispose();
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  return m;
}

test('levitation smoothly lifts a real worker and restores its seat, size, and working status', (t) => {
  const m = model(t);
  m.update(1, 1);
  assert.equal(m.levitate(), true);
  assert.equal(m.levitate(), false, 'repeated casts do not stack or restart the lift');
  let height = 0;
  for (let i = 0; i <= Math.ceil(LEVITATE_TIME * 60); i++) {
    const before = m.root.position.y;
    m.update(1 / 60, i / 60);
    assert.ok(Math.abs(m.root.position.y - before) < 0.04, 'no jumps at the start or end');
    assert.equal(m.root.position.x, 0);
    assert.equal(m.root.position.z, 0);
    assert.equal(m.root.scale.x, 0.85);
    assert.equal(m.status, 'working', 'its real task continues');
    height = Math.max(height, m.root.position.y);
  }
  assert.ok(Math.abs(height - LEVITATE_HEIGHT) < 1e-6);
  assert.equal(m.root.position.y, 0);
});

test('dismissing a levitating worker cancels the lift', (t) => {
  const m = model(t);
  assert.equal(m.levitate(), true);
  m.update(0.5, 0.5);
  assert.ok(m.root.position.y > 0);
  m.die(true);
  assert.equal(m.root.position.y, 0);
  assert.equal(m.levitate(), false);
});
