import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DashboardWorkerLink } from '../src/client/dashboard-worker-link.js';
import type { LinkPlace } from '../src/client/worker-link.js';

const place = (floor: string, workers: string[] = [], floors = ['home', 'target', 'other']): LinkPlace => ({ floor, hasWorker: (id) => workers.includes(id), hasFloor: (id) => floors.includes(id) });
const link = { worker: 'lead', floor: 'target', view: 'thread' as const };

test('arrival and reconnect reset a pending trip so the link can retry or open', () => {
  const navigation = new DashboardWorkerLink(link);
  const sent: string[] = [];
  const send = (floor: string) => {
    sent.push(floor);
    return true;
  };
  assert.deepEqual(navigation.follow(place('home'), send), { step: 'go' });
  assert.deepEqual(navigation.follow(place('home'), send), { step: 'wait' });
  // A welcome after reconnect can put the companion back on its previous floor.
  navigation.arrive();
  assert.deepEqual(navigation.follow(place('home'), send), { step: 'go' });
  assert.deepEqual(sent, ['target', 'target']);
  navigation.arrive();
  assert.deepEqual(navigation.follow(place('target', ['lead']), send), { step: 'open', link });
  assert.equal(navigation.pending, undefined);
  assert.deepEqual(navigation.follow(place('target', ['lead']), send), { step: 'wait' });
});

test('a disconnected floor send is a visible failure result and drops the stale link', () => {
  const navigation = new DashboardWorkerLink(link);
  let calls = 0;
  const send = () => {
    calls++;
    return false;
  };
  assert.deepEqual(navigation.follow(place('home'), send), { step: 'failed' });
  assert.equal(navigation.pending, undefined);
  navigation.arrive();
  assert.deepEqual(navigation.follow(place('home'), send), { step: 'wait' });
  assert.equal(calls, 1);
  navigation.set(link);
  assert.deepEqual(navigation.follow(place('home'), send), { step: 'failed' });
  assert.equal(calls, 2);
});

test('missing floors or workers drop links after arrival instead of sticking or replaying', () => {
  for (const here of [place('home', [], ['home']), place('target')]) {
    const navigation = new DashboardWorkerLink(link);
    assert.deepEqual(
      navigation.follow(here, () => assert.fail('must not send')),
      { step: 'gone', link },
    );
    assert.equal(navigation.pending, undefined);
  }
  const navigation = new DashboardWorkerLink(link);
  navigation.follow(place('home'), () => true);
  navigation.arrive();
  assert.deepEqual(
    navigation.follow(place('other', [], ['home', 'other']), () => assert.fail('removed floor')),
    { step: 'gone', link },
  );
});

test('new links replace in-flight targets, errors clear trips, and Thread remains a visit-only instruction', () => {
  const navigation = new DashboardWorkerLink(link);
  navigation.follow(place('home'), () => true);
  const next = { worker: 'child', floor: 'other', view: 'thread' as const };
  navigation.set(next);
  navigation.arrive();
  assert.deepEqual(
    navigation.follow(place('target'), (floor) => floor === 'other'),
    { step: 'go' },
  );
  navigation.clear();
  navigation.arrive();
  assert.equal(navigation.pending, undefined);
  navigation.set(next);
  assert.deepEqual(
    navigation.follow(place('other', ['child']), () => assert.fail('already here')),
    { step: 'open', link: next },
  );
  assert.equal(navigation.pending, undefined);
  assert.deepEqual(next, { worker: 'child', floor: 'other', view: 'thread' });
});
