import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FloorActivity } from '../src/server/floor-activity.js';

function rig(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'floor-activity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 1_000_000;
  const clock = { tick: (ms: number) => (now += ms), now: () => now };
  return { dir, clock, file: path.join(dir, 'floor-activity.json') };
}

test('a floor first seen counts the workers already on it, then only new ones', (t) => {
  const { dir, clock } = rig(t);
  const a = new FloorActivity(dir, clock.now);
  assert.deepEqual(a.info('f'), { hires: 0 });
  assert.equal(a.observe('f', ['w1', 'w2']), true);
  assert.deepEqual(a.info('f'), { hires: 2, lastWorkerAt: 1_000_000 });
  assert.equal(a.observe('f', ['w1', 'w2']), false, 'nothing new, nothing changed');
  clock.tick(5_000);
  a.observe('f', ['w2', 'w3']);
  assert.equal(a.info('f').hires, 3);
  assert.equal(a.info('f').lastWorkerAt, 1_005_000);
  a.flush();
});

test('a floor that loses its last worker remembers when, and an empty floor stays unchanged', (t) => {
  const { dir, clock } = rig(t);
  const a = new FloorActivity(dir, clock.now);
  a.observe('f', ['w1']);
  clock.tick(60_000);
  assert.equal(a.observe('f', []), true);
  assert.equal(a.info('f').lastWorkerAt, 1_060_000);
  clock.tick(60_000);
  assert.equal(a.observe('f', []), false);
  assert.equal(a.info('f').lastWorkerAt, 1_060_000);
  a.observe('empty', []);
  assert.deepEqual(a.info('empty'), { hires: 0 });
  a.flush();
});

test('visits, hires and worker times survive a restart; forgotten floors do not', (t) => {
  const { dir, clock, file } = rig(t);
  const a = new FloorActivity(dir, clock.now);
  a.observe('f', ['w1']);
  clock.tick(1_000);
  a.visited('f');
  a.visited('gone');
  a.forget('gone');
  a.flush();
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, 'utf8').includes('gone'), false);

  const b = new FloorActivity(dir, clock.now);
  assert.deepEqual(b.info('f'), { lastVisitedAt: 1_001_000, lastWorkerAt: 1_000_000, hires: 1 });
  // The worker already counted before the restart isn't hired again.
  assert.equal(b.observe('f', ['w1']), false);
  assert.equal(b.info('f').hires, 1);
});

test('a damaged file is ignored rather than taking the office down', (t) => {
  const { dir, clock, file } = rig(t);
  writeFileSync(file, '{not json');
  assert.deepEqual(new FloorActivity(dir, clock.now).info('f'), { hires: 0 });
  writeFileSync(file, JSON.stringify({ f: { lastVisitedAt: 'yesterday', hires: -4, workers: [1, 'w'] }, g: null }));
  const a = new FloorActivity(dir, clock.now);
  assert.deepEqual(a.info('f'), { hires: 0 });
  assert.equal(a.observe('f', ['w']), false, 'kept the one valid worker id');
});
