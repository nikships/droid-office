import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARDS, DESK_BY_ID, deskSeat, MEETING_SEATS, STATIONS } from '../src/shared/layout.js';
import { ROOF } from '../src/shared/rooftop.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import type { Interactable } from '../src/client/world/office.js';
import { buildSnapshot, cameraPose, createAutomation, facingToward, freeSpotNear, listTargets, pitchToward, resolveTarget, runCommand, standFor, type AutomationHost, type RawState, type TargetContext } from '../src/client/automation.js';

/** The spots a floor has, the way world/office.ts lays them out: desks, a kiosk, a meeting chair, a bean bag and the boards. */
function floorSpots(): Interactable[] {
  const desk = (id: string): Interactable => {
    const s = deskSeat(DESK_BY_ID.get(id)!, 1.25);
    return { kind: 'desk', deskId: id, x: s.x, z: s.z, radius: 1.3 };
  };
  const board = (kind: 'issues' | 'pulls'): Interactable => {
    const b = BOARDS[kind];
    return { kind, x: b.x + Math.sin(b.rotY) * 1.6, z: b.z + Math.cos(b.rotY) * 1.6, radius: 2.4 };
  };
  const kiosk = STATIONS.find((s) => s.station === 'issues')!;
  const chair = MEETING_SEATS[0];
  return [
    desk('desk-1'),
    desk('desk-2'),
    { kind: 'desk', deskId: 'beanbag-1', x: 15, z: -9.8, radius: 1.8, off: true },
    { kind: 'station', deskId: kiosk.id, x: kiosk.x, z: kiosk.z + 1, radius: 1.3 },
    { kind: 'desk', deskId: chair.id, x: chair.x, z: chair.z, radius: 1 },
    board('issues'),
    board('pulls'),
    { kind: 'coffee', x: -15.7, z: 10.9, radius: 1.4 },
    { kind: 'meeting', x: 13.7, z: 10.55, radius: 2.6 },
    { kind: 'meeting', x: 13.7, z: 12, radius: 2.4 },
    { kind: 'seat', seatId: 'couch', x: 10, z: 0, radius: 1.5 },
  ];
}

const worker = (over: Partial<WorkerInfo>): WorkerInfo => ({ id: 'w1', name: 'Ada', kind: 'agent', deskId: 'desk-1', status: 'idle', acked: true, ...over }) as WorkerInfo;

function context(over: Partial<TargetContext> = {}): TargetContext {
  return {
    workers: [worker({}), worker({ id: 'w2', name: 'Grace', deskId: 'meeting-1', status: 'working' })],
    spots: floorSpots(),
    floors: [
      { id: 'f1', name: 'droid-office' },
      { id: 'f2', name: 'website' },
    ],
    floor: 'f1',
    ...over,
  };
}

test('list() names the desks, kiosks, boards, places and floors you can go to from here', () => {
  const list = listTargets(context());
  const ids = list.map((t) => t.id);
  assert.deepEqual(ids, ['desk-1', 'desk-2', 'station-issues', 'meeting-1', 'issues', 'pulls', 'coffee', 'meeting', 'f1', 'f2', ROOF]);
  assert.deepEqual(list[0], { id: 'desk-1', kind: 'desk', label: 'Desk 1', deskId: 'desk-1', worker: { id: 'w1', name: 'Ada', status: 'idle' } });
  assert.equal(list[1].worker, undefined, 'a free desk is listed without a droid');
  assert.equal(list.find((t) => t.id === 'station-issues')?.kind, 'kiosk');
  assert.equal(list.find((t) => t.id === 'issues')?.kind, 'board');
  assert.equal(list.find((t) => t.id === 'coffee')?.kind, 'place');
  assert.ok(!ids.includes('beanbag-1'), 'a bean bag that is put away is nowhere to go');
  assert.ok(!ids.includes('couch'), 'seats are not named targets');
  assert.equal(ids.filter((id) => id === 'meeting').length, 1, 'a place with several spots is listed once');
  assert.deepEqual(
    list.filter((t) => t.kind === 'floor').map((t) => [t.id, !!t.here]),
    [
      ['f1', true],
      ['f2', false],
      [ROOF, false],
    ],
  );
  // An empty meeting chair isn't listed; nor is a roof with no floors under it.
  const empty = listTargets(context({ workers: [], floors: [] })).map((t) => t.id);
  assert.ok(!empty.includes('meeting-1'));
  assert.ok(!empty.includes(ROOF));
});

test('goTo targets resolve by id, droid, label, agent name and floor, and say why when they do not', () => {
  const ctx = context();
  const id = (q: string) => {
    const r = resolveTarget(q, ctx);
    assert.ok(r.ok, `${q}: ${r.ok ? '' : r.error}`);
    return r.target;
  };
  assert.equal(id('desk-2').id, 'desk-2');
  assert.equal(id('desk-2').spot?.deskId, 'desk-2', 'the desk carries the spot E uses there');
  assert.equal(id('w1').id, 'desk-1', 'a droid id goes to its desk');
  assert.equal(id('ada').id, 'desk-1', 'a droid name, any case');
  assert.equal(id('Grace').id, 'meeting-1', 'a droid at the meeting table');
  assert.equal(id('desk 2').id, 'desk-2', 'a desk label');
  assert.equal(id('Issues agent').id, 'station-issues', "the board agent's name goes to its kiosk");
  assert.equal(id('issues').kind, 'board', 'the board, not its kiosk');
  assert.equal(id('issues').spot?.kind, 'issues');
  assert.equal(id('Coffee machine').id, 'coffee');
  assert.equal(id('website').id, 'f2', 'a floor by name');
  assert.equal(id('f2').kind, 'floor');
  assert.equal(id('roof').id, ROOF);
  assert.equal(id('ROOF').id, ROOF);

  const fail = (q: string, c = ctx) => {
    const r = resolveTarget(q, c);
    assert.ok(!r.ok, q);
    return r.error;
  };
  assert.match(fail(''), /needs a target/);
  assert.match(fail('nobody'), /No such target "nobody"/);
  assert.match(fail('beanbag-1'), /Bean bag 1 isn't somewhere to go/);
  assert.match(fail('desk-1', context({ floor: ROOF, spots: [{ kind: 'bar', x: 0, z: 0, radius: 2 }] })), /up on the roof/);
  assert.match(fail('roof', context({ floors: [] })), /no roof yet/);
  const twins = context({ workers: [worker({}), worker({ id: 'w3', name: 'ada', deskId: 'desk-2' })] });
  assert.match(fail('Ada', twins), /could be Desk 1 \(desk-1\) or Desk 2 \(desk-2\): use the id/);
});

test('standing at a desk puts you behind the droid, looking at its laptop', () => {
  const t = resolveTarget('desk-1', context());
  assert.ok(t.ok);
  const stand = standFor(t.target, () => false)!;
  const desk = DESK_BY_ID.get('desk-1')!;
  const behind = deskSeat(desk, 2.4);
  assert.deepEqual(stand.at, { x: behind.x, y: 0, z: behind.z });
  // The way first person then looks (player.ts: along (-sin camYaw, -cos camYaw), camYaw = facing - PI) points at the desk.
  const facing = facingToward(stand.at, stand.face);
  const camYaw = facing - Math.PI;
  const look = { x: -Math.sin(camYaw), z: -Math.cos(camYaw) };
  const len = Math.hypot(desk.x - stand.at.x, desk.z - stand.at.z);
  assert.ok(Math.abs(look.x - (desk.x - stand.at.x) / len) < 1e-9);
  assert.ok(Math.abs(look.z - (desk.z - stand.at.z) / len) < 1e-9);
  // desk-1 is in the north row of its pod (rotY PI): its droid sits on the −z side, so you stand north of it.
  assert.ok(stand.at.z < desk.z);
  assert.ok(pitchToward({ ...stand.at, y: 1.4 }, stand.face) < 0, 'looking down at the laptop');
});

test('standing at a kiosk puts you in front of it, on the room side', () => {
  const t = resolveTarget('station-issues', context());
  assert.ok(t.ok);
  const stand = standFor(t.target, () => false)!;
  const kiosk = DESK_BY_ID.get('station-issues')!;
  assert.ok(stand.at.z > kiosk.z + 1, 'out from the north wall');
  assert.ok(Math.abs(stand.at.x - kiosk.x) < 1e-9);
});

test('standing at a board or a place uses its spot, stepping out of anything in the way', () => {
  const t = resolveTarget('issues', context());
  assert.ok(t.ok);
  const center = { x: BOARDS.issues.x, y: BOARDS.issues.y, z: BOARDS.issues.z };
  const stand = standFor(t.target, () => false, center)!;
  assert.deepEqual(stand.at, { x: t.target.spot!.x, y: 0, z: t.target.spot!.z });
  assert.deepEqual(stand.face, center);
  // The board hangs on the north wall and higher than your eyes: you face −z and look up at it.
  const facing = facingToward(stand.at, stand.face);
  assert.ok(Math.abs(Math.abs(facing) - Math.PI) < 1e-9);
  assert.ok(pitchToward({ ...stand.at, y: 1.4 }, stand.face) > 0);

  const coffee = resolveTarget('coffee', context());
  assert.ok(coffee.ok);
  const spot = coffee.target.spot!;
  // The machine stands on its own spot: step off it to the nearest free place, still within reach.
  const machine = (x: number, z: number) => Math.hypot(x - spot.x, z - spot.z) < 0.5;
  const out = standFor(coffee.target, machine)!;
  const d = Math.hypot(out.at.x - spot.x, out.at.z - spot.z);
  assert.ok(d >= 0.5 && d < spot.radius, `stepped ${d} m out`);
  assert.deepEqual(out.face, { x: spot.x, y: 1.2, z: spot.z }, 'with no scene object, look at the spot itself');
  assert.equal(
    standFor(coffee.target, () => true),
    null,
    'nowhere free at all',
  );
  // A wall on the west side: the nearest free spot is out to the east, no further than asked.
  const east = freeSpotNear({ x: 0, z: 0 }, 0, 1, (x) => x < 0.85)!;
  assert.ok(east.x >= 0.85 && Math.hypot(east.x, east.z) <= 1 + 1e-9);
  assert.equal(
    freeSpotNear({ x: 0, z: 0 }, 0, 1, (x) => x < 2),
    null,
  );
  const meeting = resolveTarget('Grace', context());
  assert.ok(meeting.ok);
  const chair = standFor(meeting.target, () => false)!;
  assert.deepEqual(chair.face, { x: MEETING_SEATS[0].x, y: 0.9, z: MEETING_SEATS[0].z }, 'at the meeting table, face its chair');
  assert.equal(
    standFor({ id: 'f2', kind: 'floor', label: 'website' }, () => false),
    null,
  );
});

test('camera presets sit behind you in third person and look ahead in first', () => {
  for (const facing of [0, Math.PI / 2, -2]) {
    const third = cameraPose('third', facing);
    assert.equal(third.view, 'third');
    // updateCamera puts the camera at (sin camYaw, cos camYaw) from you: the opposite of where you face.
    assert.ok(Math.abs(Math.sin(third.camYaw) + Math.sin(facing)) < 1e-9);
    assert.ok(Math.abs(Math.cos(third.camYaw) + Math.cos(facing)) < 1e-9);
  }
  assert.deepEqual(cameraPose('first', 0), { view: 'first', camYaw: -Math.PI, lookPitch: -0.08 });
  assert.ok(cameraPose('close', 0).camDist! < cameraPose('third', 0).camDist!);
  assert.ok(cameraPose('wide', 0).camDist! > cameraPose('third', 0).camDist!);
  assert.ok(cameraPose('wide', 0).camPitch! > cameraPose('third', 0).camPitch!);
});

function raw(over: Partial<RawState> = {}): RawState {
  return {
    floor: 'f1',
    floors: [
      { id: 'f1', name: 'droid-office', waiting: 1 },
      { id: 'f2', name: 'website', waiting: 0 },
    ],
    riding: false,
    player: { x: 1.23456, y: 0, z: -2.0049, facing: Math.PI * 3, lookPitch: -0.2049, view: 'first', seat: null, enabled: true, walking: false, climbing: false },
    camera: { x: 1.23456, y: 1.4, z: -2.0049 },
    using: null,
    modals: [],
    terminal: null,
    workers: [worker({ status: 'needs_input', task: { name: 'Fix the jukebox' } }), worker({ id: 'w2', name: 'Grace', deskId: 'station-issues', status: 'done', acked: true })],
    carrying: null,
    hanging: false,
    gun: false,
    gunMove: null,
    ...over,
  };
}

test('state() is a rounded JSON snapshot of where you are, what is open and who is waiting', () => {
  const s = buildSnapshot(raw());
  assert.deepEqual(s.floor, { id: 'f1', name: 'droid-office' });
  assert.equal(s.onRoof, false);
  assert.equal(s.player.x, 1.23);
  assert.equal(s.player.z, -2);
  assert.equal(s.player.lookPitch, -0.2);
  assert.equal(Math.abs(s.player.facing), 3.14, 'the heading wrapped into ±π');
  assert.equal(s.player.controls, true);
  assert.equal(s.camera.x, 1.23);
  assert.equal(s.using, null);
  assert.equal(s.terminal, null);
  assert.deepEqual(s.workers, [
    { id: 'w1', name: 'Ada', kind: 'agent', deskId: 'desk-1', desk: 'Desk 1', status: 'needs_input', waiting: true, task: 'Fix the jukebox' },
    { id: 'w2', name: 'Grace', kind: 'agent', deskId: 'station-issues', desk: 'Issues board', status: 'done', waiting: false },
  ]);
  assert.deepEqual(s.floors, [
    { id: 'f1', name: 'droid-office', waiting: 1, here: true },
    { id: 'f2', name: 'website', waiting: 0, here: false },
  ]);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(s))), JSON.stringify(s), 'plain JSON');

  const open = buildSnapshot(
    raw({
      using: { kind: 'desk', deskId: 'desk-1', x: 0, z: 0, radius: 1 },
      terminal: 'w1',
      modals: [{ label: 'Ada terminal' }, { label: 'Bookshelf', doing: '📚 at the bookshelf' }],
    }),
  );
  assert.deepEqual(open.using, { kind: 'desk', id: 'desk-1', label: 'Desk 1' });
  assert.deepEqual(open.terminal, { workerId: 'w1', name: 'Ada' });
  assert.deepEqual(open.modals, [{ label: 'Ada terminal' }, { label: 'Bookshelf', doing: '📚 at the bookshelf' }]);
  assert.deepEqual(buildSnapshot(raw({ using: { kind: 'issues', x: 0, z: 0, radius: 2 } })).using, { kind: 'issues', id: 'issues', label: 'Issues board' });
  assert.deepEqual(buildSnapshot(raw({ using: { kind: 'seat', seatId: 'couch', x: 0, z: 0, radius: 2 } })).using, { kind: 'seat', id: 'couch', label: 'seat' });
  assert.deepEqual(buildSnapshot(raw({ terminal: 'gone' })).terminal, { workerId: 'gone', name: 'gone' });
  const roof = buildSnapshot(raw({ floor: ROOF }));
  assert.deepEqual(roof.floor, { id: ROOF, name: 'Rooftop bar' });
  assert.equal(roof.onRoof, true);
  assert.equal(buildSnapshot(raw({ floor: null })).floor, null);
});

/** A pretend office for the commands: the player moves when placed, walks when asked, rides when told. */
function fakeOffice() {
  const log: string[] = [];
  const s = {
    raw: raw(),
    busy: null as string | null,
    near: null as Interactable | null,
    walk: 'arrived' as 'arrived' | 'cancelled' | 'stuck' | 'never',
    rideTo: null as string | null,
    frames: 0,
    commands: [
      { id: 'issues', label: 'Issues', shown: true },
      { id: 'roof', label: 'Rooftop bar', shown: true },
      { id: 'upgrade', label: 'Upgrade', shown: false },
      { id: 'decor', label: 'Hang a picture', shown: true, blocked: 'no walls up here' },
    ],
  };
  const host: AutomationHost = {
    context: () => context({ floor: s.raw.floor }),
    raw: () => s.raw,
    busy: () => s.busy,
    blocked: () => false,
    centerOf: (spot) => ({ x: spot.x, y: 2.1, z: spot.z - 1.6 }),
    place: (at, face) => {
      log.push(`place ${at.x.toFixed(2)},${at.z.toFixed(2)}`);
      s.raw = { ...s.raw, player: { ...s.raw.player, x: at.x, y: at.y, z: at.z, facing: facingToward(at, face) } };
    },
    aim: (face) => log.push(`aim ${face.x.toFixed(2)}`),
    walk: (at, label, done) => {
      log.push(`walk ${label}`);
      if (s.walk === 'never') return;
      if (s.walk === 'arrived') s.raw = { ...s.raw, player: { ...s.raw.player, x: at.x, z: at.z } };
      setTimeout(() => done(s.walk as 'arrived'), 5);
    },
    near: () => s.near,
    use: (spot, key) => {
      log.push(`use ${spot.deskId ?? spot.kind} ${key}`);
      if (spot.deskId === 'desk-1' && key === 'E') s.raw = { ...s.raw, terminal: 'w1', modals: [{ label: 'Ada terminal' }] };
    },
    commands: () => s.commands,
    run: (id) => {
      log.push(`run ${id}`);
      s.raw = { ...s.raw, modals: [{ label: 'Issues board' }] };
    },
    closeAll: () => {
      log.push('closeAll');
      s.raw = { ...s.raw, modals: [], terminal: null };
    },
    ride: (floor) => {
      log.push(`ride ${floor}`);
      s.raw = { ...s.raw, riding: true, player: { ...s.raw.player, enabled: false } };
      // The doors open on the floor asked for, unless the test says the trip goes somewhere else.
      setTimeout(() => (s.raw = { ...s.raw, riding: false, floor: s.rideTo ?? floor }), 20);
      setTimeout(() => (s.raw = { ...s.raw, player: { ...s.raw.player, enabled: true } }), 40);
    },
    setCamera: (pose) => {
      log.push(`camera ${pose.view} ${pose.camDist ?? ''}`);
      s.raw = { ...s.raw, player: { ...s.raw.player, view: pose.view } };
    },
    frames: () => s.frames++,
    wait: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  };
  return { s, log, office: createAutomation(host) };
}

test('goTo a desk, open its terminal, go to the Issues board and open it, all without steering', async () => {
  const { s, log, office } = fakeOffice();
  const atDesk = await office.goTo('Ada');
  const behind = deskSeat(DESK_BY_ID.get('desk-1')!, 2.4);
  assert.equal(atDesk.player.x, Math.round(behind.x * 100) / 100);
  assert.deepEqual(atDesk.using, { kind: 'desk', id: 'desk-1', label: 'Desk 1' }, 'E is about the desk you went to');
  const term = await office.interact();
  assert.deepEqual(term.terminal, { workerId: 'w1', name: 'Ada' });
  const board = await office.goTo('issues');
  assert.equal(board.using?.id, 'issues');
  await office.interact('E');
  assert.deepEqual(log, [`place ${behind.x.toFixed(2)},${behind.z.toFixed(2)}`, 'use desk-1 E', `place ${s.raw.player.x.toFixed(2)},${s.raw.player.z.toFixed(2)}`, 'use issues E']);
  // Moved off the spot (a key of yours), E is about what's nearest instead.
  s.raw = { ...s.raw, player: { ...s.raw.player, x: 100 } };
  assert.equal(office.state().using, null);
  await assert.rejects(office.interact(), /Nothing to use here/);
  s.near = { kind: 'coffee', x: 0, z: 0, radius: 1 };
  await office.interact('E');
  assert.equal(log.at(-1), 'use coffee E');
  await assert.rejects(office.interact('Z' as 'E'), /interact takes one of E P R X B C O/);
  await assert.rejects(office.goTo('nobody'), /No such target/);
  s.busy = 'riding to another floor';
  await assert.rejects(office.goTo('desk-2'), /Can't go to Desk 2 now: riding to another floor/);
  await assert.rejects(office.interact(), /Can't use anything now/);
});

test('goTo with walk: true walks there and resolves on arrival, or rejects stuck, cancelled or slow', async () => {
  const { s, log, office } = fakeOffice();
  const there = await office.goTo('desk-2', { walk: true });
  assert.deepEqual(log, ['walk Desk 2', 'aim -9.40']);
  assert.equal(there.using?.id, 'desk-2');
  s.walk = 'stuck';
  await assert.rejects(office.goTo('issues', { walk: true }), /Stuck on the way to Issues board/);
  s.walk = 'cancelled';
  await assert.rejects(office.goTo('issues', { walk: true }), /walk to Issues board was cancelled/);
  s.walk = 'never';
  await assert.rejects(office.goTo('issues', { walk: true, timeout: 30 }), /Still walking to Issues board after 0s/);
  s.raw = { ...s.raw, floor: ROOF };
  await assert.rejects(office.goTo('coffee', { walk: true }), /Walking needs an office floor/);
});

test('ride and goTo a floor resolve once the doors open there, and reject a trip that ends elsewhere', async () => {
  const { s, log, office } = fakeOffice();
  const up = await office.ride('website');
  assert.deepEqual(up.floor, { id: 'f2', name: 'website' });
  assert.equal(up.player.controls, true);
  assert.equal(up.riding, false);
  assert.equal((await office.ride('f2')).floor?.id, 'f2', 'already there');
  assert.equal((await office.goTo('droid-office')).floor?.id, 'f1');
  s.rideTo = 'f2';
  await assert.rejects(office.ride('roof'), /The ride to @roof didn't get there: you're on f2/);
  await assert.rejects(office.ride('basement'), /No such floor "basement": one of droid-office \(f1\), website \(f2\), roof/);
  s.busy = 'on the ladder or a fire pole';
  s.rideTo = null;
  await assert.rejects(office.ride('f1'), /Can't ride now: on the ladder/);
  assert.deepEqual(log, ['ride f2', 'ride f1', `ride ${ROOF}`]);
});

test('open runs a ☰ command by id, closeAll shuts every window, camera picks a preset', async () => {
  const { s, log, office } = fakeOffice();
  assert.deepEqual(
    office.commands().map((c) => c.id),
    ['issues', 'roof', 'upgrade', 'decor'],
  );
  assert.deepEqual((await office.open('issues')).modals, [{ label: 'Issues board' }]);
  assert.deepEqual((await office.closeAll()).modals, []);
  await assert.rejects(office.open('nope'), /No command "nope": one of issues, roof, upgrade, decor/);
  await assert.rejects(office.open('upgrade'), /isn't offered here/);
  await assert.rejects(office.open('decor'), /can't be used now: no walls up here/);
  assert.equal((await office.open('roof')).floor?.id, ROOF, 'the roof is a ride');
  assert.equal((await office.camera('wide')).player.view, 'third');
  await assert.rejects(office.camera('fisheye' as 'wide'), /camera takes one of first, third, close, wide/);
  assert.deepEqual(log, ['run issues', 'closeAll', `ride ${ROOF}`, 'camera third 14']);
  assert.ok(office.list().some((t) => t.id === 'desk-1'));
  assert.equal(s.raw.floor, ROOF);
});

test('relayed commands run only what window.office answers', async () => {
  const { office } = fakeOffice();
  const listed = (await runCommand(office, 'list', [])) as { id: string }[];
  assert.ok(listed.some((t) => t.id === 'issues'));
  const state = (await runCommand(office, 'goTo', ['desk-2'])) as { using: { id: string } };
  assert.equal(state.using.id, 'desk-2');
  assert.equal(((await runCommand(office, 'state', undefined as unknown as unknown[])) as { floor: { id: string } }).floor.id, 'f1');
  await assert.rejects(runCommand(office, 'constructor', []), /No command "constructor"/);
  await assert.rejects(runCommand(office, 'goTo', ['nobody']), /No such target/);
});
