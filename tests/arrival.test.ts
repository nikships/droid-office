import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { WebSocket } from 'ws';
import { removedFloorNotice, standSpot } from '../src/client/arrival.js';
import type { Arrival } from '../src/shared/protocol.js';
import { ELEVATOR_CAR } from '../src/shared/layout.js';
import { ROOF } from '../src/shared/rooftop.js';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';

const car = { x: (ELEVATOR_CAR.minX + ELEVATOR_CAR.maxX) / 2, y: 0, z: (ELEVATOR_CAR.minZ + ELEVATOR_CAR.maxZ) / 2, rotY: 0 };
const desk = { x: 5, y: 0, z: 3, rotY: 1.2 };

test('a saved spot with room is where the owner stands', () => {
  assert.deepEqual(
    standSpot({ floor: 'api', at: desk, via: 'saved' }, () => false),
    desk,
  );
});

test('a spot in the elevator car, or blocked, or missing, means the car', () => {
  assert.equal(
    standSpot({ floor: 'api', at: car, via: 'saved' }, () => false),
    null,
  );
  assert.equal(
    standSpot({ floor: 'api', at: desk, via: 'saved' }, () => true),
    null,
  );
  assert.equal(
    standSpot({ floor: null, via: 'lobby' }, () => false),
    null,
  );
});

test('a removed floor is noticed by name on the roof, briefly in the lobby', () => {
  const saved = { floor: 'api', name: 'API', x: 0, y: 0, z: 0, facing: 0 };
  assert.equal(removedFloorNotice({ floor: ROOF, via: 'roof', removed: true }, 'api', saved, ROOF), "🛗 API isn't in the building any more, so the elevator brought you up to the roof");
  assert.equal(removedFloorNotice({ floor: null, via: 'lobby', removed: true }, 'api', saved, null), "🛗 API isn't in the building any more");
  assert.equal(removedFloorNotice({ floor: ROOF, via: 'roof', removed: true }, 'api', { ...saved, floor: 'web' }, ROOF), "🛗 Your floor isn't in the building any more, so the elevator brought you up to the roof");
});

test('no notice when nothing went', () => {
  const saved = { floor: 'api', name: 'API', x: 0, y: 0, z: 0, facing: 0 };
  assert.equal(removedFloorNotice({ floor: 'api', at: desk, via: 'saved' }, 'api', saved, 'api'), null);
  assert.equal(removedFloorNotice({ floor: ROOF, via: 'roof', removed: true }, null, null, ROOF), null);
});

test('welcome and floor.enter carry the connection and the arrival', { timeout: 60_000 }, async (t) => {
  const home = mkdtempSync(path.resolve('tests/.arrival-'));
  const project = path.join(home, 'shop');
  mkdirSync(project, { recursive: true });
  const cfg = loadConfig(['--home', home, '--projects', home, '--host', '127.0.0.1', '--weather', 'clear', project]);
  cfg.port = 0;
  const office = await startServer(cfg);
  const base = `http://127.0.0.1:${(office.server.address() as AddressInfo).port}`;
  t.after(async () => {
    const closed = once(office.server, 'close');
    office.shutdown();
    await closed;
    await delay(100);
    rmSync(home, { recursive: true, force: true });
  });

  const open = async (query: string) => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?${query}`, { headers: { origin: base } });
    t.after(() => ws.terminate());
    const seen: Record<string, unknown>[] = [];
    ws.on('message', (data) => seen.push(JSON.parse(String(data)) as Record<string, unknown>));
    await once(ws, 'open');
    const next = async (kind: string) => {
      for (let i = 0; i < 200; i++) {
        const found = seen.find((m) => m.t === kind);
        if (found) return found;
        await delay(50);
      }
      throw new Error(`never got ${kind}`);
    };
    const welcome = await next('welcome');
    return { ws, seen, next, welcome };
  };

  // A fresh arrival lands on the project's floor, by elevator, with no peers or chat anywhere.
  const fresh = await open('name=Fresh');
  const floorId = (fresh.welcome.floor as string) ?? null;
  assert.ok(floorId && floorId !== ROOF, `expected a project floor, got ${String(floorId)}`);
  assert.match(String(fresh.welcome.connection), /^[0-9a-f]{10}$/);
  assert.deepEqual({ ...(fresh.welcome.arrival as Arrival), at: typeof (fresh.welcome.arrival as Arrival).at === 'object' ? 'spot' : undefined }, { floor: floorId, at: 'spot', via: 'elevator' });
  for (const key of ['you', 'peers', 'chat', 'me', 'invites']) assert.ok(!(key in (fresh.welcome as Record<string, unknown>)), `welcome has no ${key}`);
  const floors = fresh.welcome.floors as Record<string, unknown>[];
  assert.ok(floors.length >= 1);
  for (const f of floors) assert.ok(!('people' in f), 'floors carry no people count');

  // Back to the same floor with a spot: the arrival is the saved one.
  const back = await open(`name=Back&floor=${floorId}&x=5&y=0&z=3&rotY=1.2`);
  assert.deepEqual(back.welcome.arrival, { floor: floorId, at: { x: 5, y: 0, z: 3, rotY: 1.2 }, via: 'saved' });

  // A floor that went sends the arrival up to the roof, marked removed.
  const orphan = await open('name=Orphan&floor=gone-floor');
  assert.deepEqual({ ...(orphan.welcome.arrival as Arrival), at: typeof (orphan.welcome.arrival as Arrival).at === 'object' ? 'spot' : undefined }, { floor: ROOF, at: 'spot', via: 'roof', removed: true });

  // By elevator to the roof, then back down to a requested spot (the ladder, pole and floor-list path).
  back.ws.send(JSON.stringify({ t: 'floor.go', floor: ROOF }));
  const roofed = await back.next('floor.enter');
  assert.equal((roofed.arrival as Arrival).floor, ROOF);
  assert.equal((roofed.arrival as Arrival).via, 'elevator');
  assert.ok(!('peers' in roofed), 'floor.enter carries no peers');
  back.seen.length = 0;
  back.ws.send(JSON.stringify({ t: 'floor.go', floor: floorId, at: { x: 1, y: 0, z: 2, rotY: 0 } }));
  const requested = await back.next('floor.enter');
  assert.deepEqual(requested.arrival, { floor: floorId, at: { x: 1, y: 0, z: 2, rotY: 0 }, via: 'requested' });
  assert.ok(!('peers' in requested), 'floor.enter carries no peers');

  // Search answers terminal hits only, with the more flag and no chat branch.
  const searched = await (await fetch(`${base}/api/search?q=zzz-nothing-here&floor=${floorId}`)).json();
  assert.deepEqual(searched, { q: 'zzz-nothing-here', terminals: [], more: false });
  const short = await (await fetch(`${base}/api/search?q=x&floor=${floorId}`)).json();
  assert.deepEqual(short, { q: 'x', terminals: [], more: false });

  // The last floor off the building leaves the arrival out in the lobby.
  back.seen.length = 0;
  back.ws.send(JSON.stringify({ t: 'floor.remove', floor: floorId }));
  assert.deepEqual((await back.next('floor.enter')).arrival, { floor: null, via: 'lobby' });

  // With connections coming, going and traveling, nobody is announced to anyone.
  await delay(300);
  for (const c of [fresh, back, orphan]) {
    assert.deepEqual(
      c.seen.map((m) => m.t).filter((t) => t === 'peer.join' || t === 'peer.update' || t === 'peer.move' || t === 'peer.leave' || t === 'chat'),
      [],
      'no presence or chat messages',
    );
  }
});
