import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { Store } from '../src/client/state.js';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { HOOK_VERSION } from '../src/server/workers.js';
import { readScreenMenu } from '../src/shared/asks.js';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol.js';

// Real Droid AskUser fixture shared with tests/asks.test.ts and Android's AsksTest.
const ASK_MENU = [
  '  Ask User',
  '  Which greeting should I write into HELLO.md?',
  '  1. hi',
  '     Short and friendly',
  '  2. hello',
  '  3. hey',
  '  Or type your own answer...',
  '',
  '  ↑/↓ Navigate · Space/Enter/1-9 Select · ESC stop agent',
].join('\r\n');

type Launch = { workerId: string; hookToken: string; hookUrl: string; stdin?: string };

const fakeDroid = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.249.0'); process.exit(0); }
if (args[0] === 'doctor') { process.stdout.write('{"ok":true,"results":[{"id":"auth.verify","status":"pass","detail":"authenticated as o***@example.com via stored login session"}]}'); process.exit(0); }
if (args.includes('--output-format')) process.exit(0);
fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ workerId: process.env.DROID_OFFICE_WORKER_ID, hookToken: process.env.DROID_OFFICE_HOOK_TOKEN, hookUrl: process.env.DROID_OFFICE_HOOK_URL }) + '\\n');
if (process.env.FAKE_ASK_MENU_FILE && fs.existsSync(process.env.FAKE_ASK_MENU_FILE)) {
  process.stdout.write(fs.readFileSync(process.env.FAKE_ASK_MENU_FILE, 'utf8') + '\\r\\n');
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ workerId: process.env.DROID_OFFICE_WORKER_ID, stdin: chunk }) + '\\n');
  process.stdout.write('\\x1b[2J\\x1b[HWorking on HELLO.md...\\r\\n');
});
process.stdin.resume();
`;

function initGitRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(path.join(dir, 'README.md'), '# Repo\n');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'README.md'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'], { cwd: dir });
}

function socket(t: TestContext, base: string, query: string) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?${query}`, { origin: base });
  t.after(() => ws.terminate());
  const messages: ServerMsg[] = [];
  const listeners = new Set<() => void>();
  ws.on('message', (data) => {
    messages.push(JSON.parse(String(data)));
    listeners.forEach((fn) => fn());
  });
  function wait<T extends ServerMsg['t']>(type: T, predicate: (msg: Extract<ServerMsg, { t: T }>) => boolean = () => true): Promise<Extract<ServerMsg, { t: T }>> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = messages.find((m): m is Extract<ServerMsg, { t: T }> => m.t === type && predicate(m as Extract<ServerMsg, { t: T }>));
        if (!found) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(found);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(Error(`Timed out waiting for ${type}`));
      }, 8000);
      listeners.add(check);
      check();
    });
  }
  const send = (msg: ClientMsg) => ws.send(JSON.stringify(msg));
  return { ws, messages, wait, send };
}

test('companions receive the full building roster, off-floor AskUser screens, and cross-floor answer/fork/dismiss/thread actions', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'building-roster-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoA = path.join(root, 'alpha');
  const repoB = path.join(root, 'beta');
  initGitRepo(repoA);
  initGitRepo(repoB);

  const agent = path.join(root, 'droid');
  writeFileSync(agent, fakeDroid, { mode: 0o700 });
  const log = path.join(root, 'launches.jsonl');
  writeFileSync(log, '');
  const menuFile = path.join(root, 'ask-menu.txt');
  writeFileSync(menuFile, ASK_MENU);

  const prevLog = process.env.FAKE_AGENT_LOG;
  const prevMenu = process.env.FAKE_ASK_MENU_FILE;
  process.env.FAKE_AGENT_LOG = log;
  process.env.FAKE_ASK_MENU_FILE = menuFile;
  t.after(() => {
    if (prevLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = prevLog;
    if (prevMenu === undefined) delete process.env.FAKE_ASK_MENU_FILE;
    else process.env.FAKE_ASK_MENU_FILE = prevMenu;
  });

  const cfg = loadConfig(['--home', root, '--projects', root, repoA, '--weather', 'clear', '--host', '127.0.0.1', '--agent', agent]);
  cfg.port = 0;
  const server = await startServer(cfg);
  t.after(async () => {
    const closing = once(server.server, 'close');
    server.shutdown();
    server.server.closeAllConnections();
    await closing;
  });
  const port = (server.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const records = (): Launch[] =>
    readFileSync(log, 'utf8')
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line) as Launch);
  const waitLaunch = async (workerId: string): Promise<Launch> => {
    const end = Date.now() + 8000;
    for (;;) {
      const hit = records().find((l) => l.workerId === workerId && l.stdin === undefined);
      if (hit) return hit;
      if (Date.now() > end) assert.fail(`timed out waiting for launch of ${workerId}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const hook = async (launch: Launch, event: string, extra: Record<string, unknown> = {}) => {
    const res = await fetch(`${launch.hookUrl}/hooks/droid?worker=${launch.workerId}&event=${event}&v=${HOOK_VERSION}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${launch.hookToken}` },
      body: JSON.stringify({ session_id: `session-${launch.workerId}`, hook_event_name: event, ...extra }),
    });
    assert.equal(res.status, 200, event);
  };

  const pair = (await (await fetch(`${base}/api/mobile/pair`, { method: 'POST', body: '{"device":"Pixel"}' })).json()) as { token: string };
  const phoneA = socket(t, base, `d=${pair.token}`);
  const welcomeA = await phoneA.wait('welcome');
  const floorA = welcomeA.floor!;
  assert.ok(Array.isArray(welcomeA.building));
  assert.deepEqual(
    welcomeA.building.map((r) => r.floor),
    [floorA],
  );

  // Open a second floor for repoB; phoneB rides there while phoneA stays on floorA.
  const phoneB = socket(t, base, `d=${pair.token}`);
  await phoneB.wait('welcome');
  phoneB.send({ t: 'floor.add', dir: repoB });
  const addedB = await phoneB.wait('floor.added', (m) => m.dir === repoB);
  const floorB = addedB.floor!;
  assert.notEqual(floorA, floorB);
  phoneB.send({ t: 'floor.go', floor: floorB });
  await phoneB.wait('floor.enter', (m) => m.floor === floorB);

  // Track state on phoneA through Store as messages arrive.
  const clientState = new Store();
  for (const m of phoneA.messages) clientState.apply(m);

  // Spawn a Droid worker on floorB while phoneA remains on floorA.
  phoneA.messages.length = 0;
  phoneB.send({ t: 'worker.spawn', kind: 'agent', deskId: 'auto', requestId: 'spawn-b', requestFloor: floorB });
  const spawned = await phoneB.wait('action.result', (m) => m.requestId === 'spawn-b');
  assert.equal(spawned.ok, true);
  const workerB = spawned.workerId!;

  // phoneA (still on floorA) receives building.worker for floorB!
  const seenOnA = await phoneA.wait('building.worker', (m) => m.floor === floorB && m.worker.id === workerB);
  assert.ok(seenOnA.worker.name.length > 0);
  for (const m of phoneA.messages) clientState.apply(m);
  assert.equal(
    clientState.building.get(floorB)?.workers.some((w) => w.id === workerB),
    true,
  );

  const launch = await waitLaunch(workerB);
  await hook(launch, 'SessionStart', { source: 'startup' });
  await hook(launch, 'Notification', { message: 'Droid needs your permission or answer' });
  await phoneA.wait('building.worker', (m) => m.floor === floorB && m.worker.id === workerB && m.worker.status === 'needs_input');
  const offFloorScreen = await phoneA.wait('screen', (m) => m.workerId === workerB && m.full === true);
  clientState.apply(offFloorScreen);
  const parsedMenu = readScreenMenu(clientState.screens.get(workerB)!.lines);
  assert.equal(parsedMenu?.question, 'Which greeting should I write into HELLO.md?');

  // A brand-new connection landing on floorA immediately receives both floors in welcome.building and the off-floor needs_input screen.
  const freshPhone = socket(t, base, `d=${pair.token}`);
  const freshWelcome = await freshPhone.wait('welcome');
  assert.equal(freshWelcome.floor, floorA);
  assert.equal(freshWelcome.building?.find((r) => r.floor === floorB)?.workers.find((w) => w.id === workerB)?.status, 'needs_input');
  const initialOffFloorScreen = await freshPhone.wait('screen', (m) => m.workerId === workerB && m.full === true);
  const freshState = new Store();
  freshState.apply(freshWelcome);
  freshState.apply(initialOffFloorScreen);
  assert.equal(readScreenMenu(freshState.screens.get(workerB)!.lines)?.question, 'Which greeting should I write into HELLO.md?');

  // Answering from phoneA (on floorA) with a mismatched requestFloor is refused.
  phoneA.send({ t: 'worker.answer', workerId: workerB, menu: parsedMenu!, choice: 2, requestId: 'ans-wrong-floor', requestFloor: floorA });
  const wrongFloorAns = await phoneA.wait('action.result', (m) => m.requestId === 'ans-wrong-floor');
  assert.equal(wrongFloorAns.ok, false);

  // Answering from phoneA (on floorA) with requestFloor: floorB succeeds and delivers keys to floorB's PTY!
  phoneA.send({ t: 'worker.answer', workerId: workerB, menu: parsedMenu!, choice: 2, requestId: 'ans-ok', requestFloor: floorB });
  const okAns = await phoneA.wait('action.result', (m) => m.requestId === 'ans-ok');
  assert.equal(okAns.ok, true, okAns.error);
  const end = Date.now() + 8000;
  for (;;) {
    const inputs = records()
      .filter((l) => l.workerId === workerB && l.stdin !== undefined)
      .map((l) => l.stdin)
      .join('');
    if (inputs.length > 0) break;
    if (Date.now() > end) assert.fail('expected answer keystrokes on floorB worker');
    await new Promise((r) => setTimeout(r, 25));
  }

  // Mark workerB idle/done via Stop hook so we can fork it cross-floor from phoneA.
  await hook(launch, 'Stop');
  await phoneA.wait('building.worker', (m) => m.floor === floorB && m.worker.id === workerB && m.worker.status === 'done');

  // Reading workerB's thread from phoneA (on floorA) addresses floorB rather than failing as off-floor.
  phoneA.send({ t: 'thread.read', workerId: workerB, request: 'cross-thread' });
  const snap = await phoneA.wait('thread.snapshot', (m) => m.request === 'cross-thread');
  assert.equal(snap.workerId, workerB);

  // Forking workerB without requestFloor from floorA is refused; with requestFloor: floorB it forks on floorB!
  phoneA.send({ t: 'worker.fork', workerId: workerB, deskId: 'auto', requestId: 'fork-missing-floor' });
  assert.equal((await phoneA.wait('action.result', (m) => m.requestId === 'fork-missing-floor')).ok, false);

  phoneA.send({ t: 'worker.fork', workerId: workerB, deskId: 'auto', name: 'ScoutFork', requestId: 'fork-ok', requestFloor: floorB });
  const forked = await phoneA.wait('action.result', (m) => m.requestId === 'fork-ok');
  assert.equal(forked.ok, true, forked.error);
  assert.ok(forked.workerId);
  await phoneA.wait('building.worker', (m) => m.floor === floorB && m.worker.id === forked.workerId);

  // Dismissing both workers on floorB from phoneA (on floorA) succeeds and broadcasts building.remove!
  for (const id of [forked.workerId!, workerB]) {
    phoneA.messages.length = 0;
    phoneA.send({ t: 'worker.kill', workerId: id, cleanup: 'keep', requestId: `kill-${id}`, requestFloor: floorB });
    const killed = await phoneA.wait('action.result', (m) => m.requestId === `kill-${id}`);
    assert.equal(killed.ok, true, killed.error);
    const removed = await phoneA.wait('building.remove', (m) => m.floor === floorB && m.workerId === id);
    clientState.apply(removed);
  }
  assert.deepEqual(clientState.building.get(floorB)?.workers ?? [], []);
});
