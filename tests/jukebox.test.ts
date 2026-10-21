import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { Jukebox } from '../src/server/jukebox.js';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { store } from '../src/client/state.js';
import { STREAM, type JukeboxState } from '../src/shared/jukebox.js';
import { NO_PIPELINES } from '../src/shared/pipelines.js';
import type { FloorView, ServerMsg } from '../src/shared/protocol.js';
import { ROOF } from '../src/shared/rooftop.js';

test('the app migrates the newest playing floor selection without restarting it, only once', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'office-jukebox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = ['office', 'first', 'second', 'stopped', 'broken'].map((name) => join(root, name));
  for (const dir of dirs) mkdirSync(dir);
  const [office, first, second, stopped, broken] = dirs;
  const old = { on: true, track: 'coffee-break', startedAt: 1000, by: 'Owner' };
  writeFileSync(join(first, 'jukebox.json'), JSON.stringify(old));
  const newest = { ...old, track: STREAM, url: 'https://soundcloud.com/discover/sets/artist-stations:227866761', startedAt: 2000 };
  writeFileSync(join(second, 'jukebox.json'), JSON.stringify(newest));
  writeFileSync(join(stopped, 'jukebox.json'), JSON.stringify({ ...old, on: false, startedAt: 3000 }));
  writeFileSync(join(broken, 'jukebox.json'), 'broken');

  const box = new Jukebox(office, dirs.slice(1));
  assert.deepEqual({ ...box.state(), elapsed: 0 }, { ...newest, elapsed: 0 });
  assert.ok(box.state().elapsed > 0);
  assert.deepEqual(JSON.parse(readFileSync(join(second, 'jukebox.json'), 'utf8')), newest, 'legacy files stay untouched');
  assert.equal(box.stop('Owner'), true);
  const restarted = new Jukebox(office, dirs.slice(1));
  assert.equal(restarted.state().on, false, 'a restart never reimports an old playing floor');
  assert.equal(restarted.state().startedAt, newest.startedAt);
  assert.equal(restarted.state().url, newest.url);
});

test('migration handles Home sharing the office file, stopped selections, and invalid files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'office-jukebox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home);
  mkdirSync(project);
  const homeFile = join(home, 'jukebox.json');
  const projectFile = join(project, 'jukebox.json');
  writeFileSync(homeFile, JSON.stringify({ on: false, track: 'rainy-window', startedAt: 1000 }));
  writeFileSync(projectFile, JSON.stringify({ on: true, track: 'late-commit', startedAt: 2000 }));
  const box = new Jukebox(home, [home, project]);
  assert.equal(box.state().track, 'late-commit');
  assert.equal(box.state().startedAt, 2000);
  assert.equal(JSON.parse(readFileSync(homeFile, 'utf8')).scope, 'office');
  box.stop('Owner');
  assert.equal(new Jukebox(home, [home, project]).state().on, false);

  const empty = join(root, 'empty');
  mkdirSync(empty);
  writeFileSync(projectFile, JSON.stringify({ on: false, track: 'green-build', startedAt: 3000 }));
  assert.equal(new Jukebox(empty, [home, project]).state().track, 'green-build', 'newest selection is kept when every floor is off');
  writeFileSync(homeFile, 'broken');
  assert.equal(new Jukebox(home, [home, project]).state().on, false, 'a broken app file does not resurrect old music');
  assert.equal(new Jukebox(join(root, 'missing'), [join(root, 'missing-floor')]).state().on, false);
});

test('floor arrivals preserve the exact music state and never notify the player to restart', () => {
  const view: FloorView = {
    floor: 'project',
    project: null,
    workers: [],
    issues: { items: [], fetchedAt: 0, loading: false },
    pulls: { items: [], fetchedAt: 0, loading: false },
    pipelines: NO_PIPELINES,
    decor: [],
    jira: {},
    jiraBoard: null,
    autoHeal: { on: false },
  };
  let changes = 0;
  const unsubscribe = store.on('jukebox', () => changes++);
  try {
    for (const state of [
      { on: true, track: 'coffee-break', startedAt: 1000, elapsed: 500 },
      { on: true, track: STREAM, url: 'https://soundcloud.com/discover/sets/artist-stations:227866761', startedAt: 2000, elapsed: 1000 },
      { on: false, track: 'late-commit', startedAt: 3000, elapsed: 1000 },
    ]) {
      store.apply({ t: 'jukebox', state });
      const playing = store.jukebox;
      const before = changes;
      for (const floor of ['other-project', ROOF, 'project', null]) {
        store.apply({ t: 'floor.enter', ...view, floor, arrival: { floor, via: floor === ROOF ? 'roof' : floor ? 'elevator' : 'lobby' } });
        assert.equal(store.jukebox, playing);
        assert.equal(changes, before);
      }
    }
  } finally {
    unsubscribe();
  }
});

test('play, skip and stop are shared across floors, the roof and reconnects', { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'office-jukebox-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(project);
  mkdirSync(home);
  const cfg = loadConfig(['--home', root, '--projects', root, '--host', '127.0.0.1', '--weather', 'clear']);
  cfg.project = project;
  cfg.homeFloor = home;
  cfg.port = 0;
  const office = await startServer(cfg);
  const base = `http://127.0.0.1:${(office.server.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    const closed = once(office.server, 'close');
    office.shutdown();
    await closed;
    await delay(100);
    rmSync(root, { recursive: true, force: true });
  });
  const open = async (floor = '') => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?name=Owner&floor=${floor}`, { headers: { origin: base } });
    sockets.push(ws);
    const seen: ServerMsg[] = [];
    ws.on('message', (data) => seen.push(JSON.parse(String(data)) as ServerMsg));
    const next = async <K extends ServerMsg['t']>(kind: K): Promise<Extract<ServerMsg, { t: K }>> => {
      for (let i = 0; i < 200; i++) {
        const at = seen.findIndex((m) => m.t === kind);
        if (at !== -1) return seen.splice(at, 1)[0] as Extract<ServerMsg, { t: K }>;
        await delay(25);
      }
      throw new Error(`never got ${kind}`);
    };
    const welcome = await next('welcome');
    return { ws, next, welcome };
  };
  const a = await open();
  const other = a.welcome.floors.find((f) => f.id !== a.welcome.floor)!;
  const b = await open(other.id);
  const roof = await open(ROOF);
  assert.notEqual(a.welcome.floor, b.welcome.floor);
  const shared = async (expected: Partial<JukeboxState>) => {
    const states = await Promise.all([a.next('jukebox'), b.next('jukebox'), roof.next('jukebox')]);
    for (const msg of states) {
      for (const [key, value] of Object.entries(expected)) assert.equal(msg.state[key as keyof JukeboxState], value);
      assert.deepEqual(msg.state, states[0].state);
    }
    return states[0].state;
  };
  a.ws.send(JSON.stringify({ t: 'jukebox.play', track: 'coffee-break' }));
  const first = await shared({ on: true, track: 'coffee-break' });
  a.ws.send(JSON.stringify({ t: 'floor.go', floor: other.id }));
  assert.ok(!('jukebox' in (await a.next('floor.enter'))), 'floor snapshots cannot replace app-wide playback');
  const reconnect = await open(other.id);
  assert.equal(reconnect.welcome.jukebox.startedAt, first.startedAt);
  assert.equal(reconnect.welcome.jukebox.track, first.track);
  store.apply(reconnect.welcome);
  assert.equal(store.jukebox.startedAt, first.startedAt, 'welcome initializes global music');
  b.ws.send(JSON.stringify({ t: 'jukebox.skip' }));
  await shared({ on: true, track: 'late-commit' });
  roof.ws.send(JSON.stringify({ t: 'jukebox.stop' }));
  await shared({ on: false, track: 'late-commit' });
  assert.equal(new Jukebox(cfg.dataDir).state().on, false);
  assert.equal(new Jukebox(cfg.dataDir).state().track, 'late-commit');
  for (const dir of [project, home]) assert.equal(existsSync(join(dir, '.droid-office', 'jukebox.json')), false, 'floor files are no longer written');
});
