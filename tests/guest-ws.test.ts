// Share-link guests on the WebSocket, end to end: a real office, a stubbed Tailscale CLI (first on PATH,
// so nothing reaches the real tailnet), and guest sockets through the real guest backend listener with
// the Host and Origin Funnel would send. Scope, read-only, owner-only, audit and disconnects are checked
// against what actually arrives on the wire.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { GUEST_CLOSE_DISABLED, GUEST_CLOSE_ENDED, GUEST_WS_PROTOCOL, type GuestAuditPage, type GuestLinkCreated, type GuestLinksState, type GuestPreset } from '../src/shared/guest-links.js';
import { GUEST_REFUSED } from '../src/shared/guest-policy.js';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol.js';

const DNS = 'office.guest-test.ts.net';
const GUEST_ORIGIN = `https://${DNS}:10000`;

/** A `tailscale` on PATH that answers like a signed-in machine with nothing served, and logs every call. */
function stubTailscale(dir: string): string {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const log = path.join(dir, 'tailscale.log');
  const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${DNS}.`, TailscaleIPs: ['100.101.102.103'] }, CurrentTailnet: { MagicDNSEnabled: true } });
  writeFileSync(
    path.join(bin, 'tailscale'),
    `#!/bin/sh
echo "$@" >> '${log}'
if [ "$1" = "status" ]; then printf '%s' '${status}'; exit 0; fi
if [ "$1" = "serve" ] && [ "$2" = "status" ]; then printf '{}'; exit 0; fi
exit 0
`,
  );
  chmodSync(path.join(bin, 'tailscale'), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  // The office must reach this stub, never the real CLI.
  assert.equal(execFileSync('/bin/sh', ['-c', 'command -v tailscale']).toString().trim(), path.join(bin, 'tailscale'));
  assert.match(execFileSync('tailscale', ['status', '--json']).toString(), /guest-test/);
  return log;
}

type Sock = ReturnType<typeof watch>;
function watch(t: TestContext, ws: WebSocket) {
  t.after(() => ws.terminate());
  const messages: ServerMsg[] = [];
  const listeners = new Set<() => void>();
  let closed: { code: number; reason: string } | undefined;
  ws.on('message', (data) => {
    messages.push(JSON.parse(String(data)));
    for (const fn of listeners) fn();
  });
  ws.on('close', (code, reason) => {
    closed = { code, reason: String(reason) };
    for (const fn of listeners) fn();
  });
  ws.on('error', () => undefined);
  const until = <T>(find: () => T | undefined, what: string, ms = 10_000): Promise<T> =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = find();
        if (found === undefined) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(found);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`Timed out waiting for ${what}`));
      }, ms);
      listeners.add(check);
      check();
    });
  function wait<T extends ServerMsg['t']>(type: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true) {
    return until(() => messages.find((m): m is Extract<ServerMsg, { t: T }> => m.t === type && pred(m as Extract<ServerMsg, { t: T }>)), type);
  }
  let n = 0;
  // A refused upgrade rejects this; tests that expect a refusal wait on 'error' instead.
  const opened = once(ws, 'open');
  opened.catch(() => undefined);
  const send = (msg: ClientMsg) => ws.send(JSON.stringify(msg));
  /** Sends with a receipt and resolves with its action.result. */
  const act = (msg: ClientMsg) => {
    const requestId = `r${++n}-${Math.random().toString(36).slice(2)}`;
    send({ ...msg, requestId });
    return wait('action.result', (m) => m.requestId === requestId);
  };
  return { ws, messages, wait, until, send, act, closed: () => closed, opened };
}

async function rig(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guest-ws-'));
  const pathBefore = process.env.PATH;
  t.after(() => {
    process.env.PATH = pathBefore;
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const log = stubTailscale(root);
  const home = path.join(root, 'home');
  const projects = path.join(root, 'projects');
  const alpha = path.join(projects, 'alpha');
  const beta = path.join(projects, 'beta');
  for (const dir of [home, alpha, beta]) {
    mkdirSync(dir, { recursive: true });
    if (dir !== home) execFileSync('git', ['init', '-q'], { cwd: dir });
  }
  const cfg = loadConfig([alpha, '--home', home, '--projects', projects, '--weather', 'clear', '--host', '127.0.0.1']);
  cfg.port = 0;
  const office = await startServer(cfg);
  t.after(async () => {
    const closing = once(office.server, 'close');
    await office.shutdown();
    office.server.closeAllConnections();
    await closing;
    await delay(100);
  });
  const base = `http://127.0.0.1:${(office.server.address() as AddressInfo).port}`;
  const api = async <T>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${base}${p}`, { method, headers: { origin: base, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as T };
  };
  const owner = watch(t, new WebSocket(`${base.replace('http:', 'ws:')}/ws?name=Owner`, { origin: base }));
  const welcome = await owner.wait('welcome');
  const alphaId = welcome.floor!;
  const added = await owner.act({ t: 'floor.add', dir: beta });
  assert.equal(added.ok, true, added.error);
  const betaId = (await owner.wait('floor.added', (m) => m.dir === beta)).floor!;
  const hire = async () => {
    const r = await owner.act({ t: 'worker.spawn', deskId: 'auto', kind: 'shell' });
    assert.equal(r.ok, true, r.error);
    return r.workerId!;
  };
  const a1 = await hire();
  const a2 = await hire();
  const a3 = await hire();
  owner.send({ t: 'floor.go', floor: betaId });
  await owner.wait('floor.enter', (m) => m.floor === betaId);
  const b1 = await hire();
  owner.send({ t: 'floor.go', floor: alphaId });
  await owner.wait('floor.enter', (m) => m.floor === alphaId && m.workers.length === 3);

  const on = await api<GuestLinksState>('PUT', '/api/guest-links', { on: true });
  assert.equal(on.status, 200);
  for (let i = 0; i < 100; i++) {
    const s = await api<GuestLinksState>('GET', '/api/guest-links');
    if (s.body.transport.status === 'serving') break;
    await delay(50);
  }
  const backend = (JSON.parse(readFileSync(path.join(cfg.dataDir, 'guest-funnel.json'), 'utf8')) as { backendPort: number }).backendPort;
  assert.match(readFileSync(log, 'utf8'), new RegExp(`funnel --bg --yes --https=10000 http://127.0.0.1:${backend}`));

  const link = async (label: string, preset: GuestPreset, extra: { floorId?: string; workerId?: string } = {}) => {
    const r = await api<GuestLinkCreated>('POST', '/api/guest-links', { label, preset, expiry: 'never', ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id: r.body.link.id, token: new URL(r.body.url).hash.slice('#g='.length) };
  };
  const guest = (token: string, query = 'client=dashboard') => watch(t, new WebSocket(`ws://127.0.0.1:${backend}/ws?${query}`, [GUEST_WS_PROTOCOL, token], { headers: { host: `${DNS}:10000`, origin: GUEST_ORIGIN } }));
  return { office, base, api, owner, alphaId, betaId, a1, a2, a3, b1, link, guest };
}

const OWNER_ONLY_WELCOME = [
  'projectsDir',
  'upgrade',
  'machine',
  'sky',
  'jukebox',
  'leaveOnMerge',
  'freshMain',
  'subagents',
  'bundledSkills',
  'hiddenModels',
  'hideNativeModels',
  'workerLabels',
  'prompts',
  'factory',
  'gemini',
  'benchmarks',
  'setup',
  'subscriptions',
  'vibes',
];

test('share-link guests get only their scope on the WebSocket, and only write presets change anything', { timeout: 120_000 }, async (t) => {
  const r = await rig(t);
  const { owner, alphaId, betaId, a1, a2, a3, b1 } = r;

  // --- View only (single floor) -----------------------------------------------------------------
  const viewFloor = await r.link('Viewer - floor', 'view-floor', { floorId: alphaId });
  const vf = r.guest(viewFloor.token);
  await vf.opened;
  assert.equal(vf.ws.protocol, GUEST_WS_PROTOCOL, 'the office answers with the protocol, never the token');
  const vw = await vf.wait('welcome');
  assert.deepEqual(vw.guest, { preset: 'view-floor', write: false, scope: 'floor', floorId: alphaId, missionControl: false });
  assert.deepEqual(
    vw.floors.map((f) => [f.id, f.dir]),
    [[alphaId, '']],
  );
  assert.equal(vw.floor, alphaId);
  assert.deepEqual(vw.workers.map((w) => w.id).sort(), [a1, a2, a3].sort());
  assert.deepEqual(
    vw.building?.map((b) => b.floor),
    [alphaId],
  );
  assert.equal(vw.missionControl, undefined);
  assert.equal(vw.project?.dir, '');
  assert.equal(vw.project?.agentCmd, '');
  for (const key of OWNER_ONLY_WELCOME) assert.equal(key in vw, false, `welcome carries no ${key}`);

  assert.deepEqual(await vf.act({ t: 'worker.prompt', workerId: a1, prompt: 'echo nope' }), { t: 'action.result', requestId: (vf.messages.at(-1) as { requestId: string }).requestId, ok: false, error: GUEST_REFUSED });
  // Out of scope and nonexistent look the same.
  const outOfScope = await vf.act({ t: 'worker.attach', workerId: b1 });
  const missing = await vf.act({ t: 'worker.attach', workerId: 'no-such-worker' });
  assert.equal(outOfScope.error, GUEST_REFUSED);
  assert.equal(missing.error, GUEST_REFUSED);
  vf.send({ t: 'worker.attach', workerId: a1 });
  await vf.wait('term.snapshot', (m) => m.workerId === a1);
  vf.send({ t: 'term.input', workerId: a1, data: 'echo VIEW_ONLY_TYPED\r' });
  vf.send({ t: 'term.resize', workerId: a1, cols: 33, rows: 11 });
  assert.equal((await vf.act({ t: 'floor.go', floor: betaId })).error, GUEST_REFUSED);

  // --- View only (single worker) ----------------------------------------------------------------
  const viewWorker = await r.link('Viewer - worker', 'view-worker', { floorId: alphaId, workerId: a3 });
  const vwk = r.guest(viewWorker.token);
  const vkw = await vwk.wait('welcome');
  assert.deepEqual(
    vkw.workers.map((w) => w.id),
    [a3],
  );
  assert.deepEqual(
    vkw.floors.map((f) => [f.id, f.dir, f.workers]),
    [[alphaId, '', 0]],
  );
  assert.deepEqual(vkw.building, [{ floor: alphaId, workers: vkw.building?.[0]?.workers ?? [], pulls: [] }]);
  assert.deepEqual(
    vkw.building?.[0]?.workers.map((w) => w.id),
    [a3],
  );
  assert.equal(vkw.pulls.items.length, 0);
  assert.equal((await vwk.act({ t: 'whiteboard.sync', floor: alphaId })).error, GUEST_REFUSED);

  // --- Single floor (read & write) --------------------------------------------------------------
  const editFloor = await r.link('Alex - PR review', 'edit-floor', { floorId: alphaId });
  const ef = r.guest(editFloor.token);
  await ef.wait('welcome');
  ef.send({ t: 'worker.attach', workerId: a1 });
  await ef.wait('term.snapshot', (m) => m.workerId === a1);
  ef.send({ t: 'term.input', workerId: a1, data: 'echo GUEST_$((40+2))\r' });
  await ef.until(() => (ef.messages.some((m) => m.t === 'term.data' && m.workerId === a1 && m.data.includes('GUEST_42')) ? true : undefined), 'the guest’s typing to run');
  assert.equal((await ef.act({ t: 'worker.prompt', workerId: a2, prompt: 'echo PROMPTED' })).ok, true);
  assert.equal((await ef.act({ t: 'worker.prompt', workerId: b1, prompt: 'echo CROSS_FLOOR' })).error, GUEST_REFUSED);
  assert.equal((await ef.act({ t: 'floor.go', floor: betaId })).error, GUEST_REFUSED);
  const hired = await ef.act({ t: 'worker.spawn', deskId: 'auto', kind: 'shell' });
  assert.equal(hired.ok, true, hired.error);
  await owner.wait('toast', (m) => m.text.includes('Alex - PR review (guest)'));
  assert.equal((await ef.act({ t: 'worker.spawn', deskId: 'auto', kind: 'shell', repos: [betaId] })).error, GUEST_REFUSED);
  for (const msg of [{ t: 'shell.attach' }, { t: 'floor.remove', floor: alphaId }, { t: 'setup.check' }, { t: 'machine.limit', limit: 1 }] as ClientMsg[]) assert.equal((await ef.act(msg)).error, GUEST_REFUSED, msg.t);

  // --- Complete access overall ------------------------------------------------------------------
  const editOffice = await r.link('Sam - everything', 'edit-office');
  const eo = r.guest(editOffice.token);
  const eow = await eo.wait('welcome');
  assert.deepEqual(eow.floors.map((f) => f.id).sort(), [alphaId, betaId].sort());
  assert.deepEqual(eow.missionControl?.bots, []);
  assert.ok(eow.missionControl?.orchestrator);
  for (const key of OWNER_ONLY_WELCOME) assert.equal(key in eow, false, `welcome carries no ${key}`);
  const ownerOnly: ClientMsg[] = [
    { t: 'profile', name: 'x', color: '#000000', look: {} as never },
    { t: 'floor.add', dir: '/tmp' },
    { t: 'floor.remove', floor: betaId },
    { t: 'floor.reorder', floor: betaId, before: null },
    { t: 'floor.projectsDir', dir: '/tmp' },
    { t: 'floor.folders', dir: '/' },
    { t: 'orchestrator.set', settings: { on: false } },
    { t: 'shell.attach' },
    { t: 'shell.input', data: 'id\r' },
    { t: 'prompts.set', id: 'office.namer', text: 'x' },
    { t: 'factory.connect', key: 'k' },
    { t: 'linear.connect', key: 'k' },
    { t: 'jira.connect', site: 's', email: 'e', token: 'k' },
    { t: 'subscriptions.refresh' },
    { t: 'setup.droid.install' },
    { t: 'subagents.set', settings: {} as never },
    { t: 'upgrade.start' },
    { t: 'decor.remove', id: 'x' },
    { t: 'jukebox.play', track: 'x' },
    { t: 'gong' },
    { t: 'leaveOnMerge.set', on: true },
    { t: 'automation.result', id: 'x', ok: true },
  ];
  for (const msg of ownerOnly) assert.equal((await eo.act(msg)).error, GUEST_REFUSED, msg.t);
  eo.send({ t: 'floor.go', floor: betaId });
  const entered = await eo.wait('floor.enter', (m) => m.floor === betaId);
  assert.deepEqual(
    entered.workers.map((w) => w.id),
    [b1],
  );
  assert.equal((await eo.act({ t: 'worker.prompt', workerId: b1, prompt: 'echo OFFICE_WIDE' })).ok, true);
  assert.equal((await eo.act({ t: 'orchestrator.reset' })).ok, true);

  // --- View only (entire office) ----------------------------------------------------------------
  const viewOffice = await r.link('Viewer - office', 'view-office');
  const vo = r.guest(viewOffice.token);
  const vow = await vo.wait('welcome');
  assert.deepEqual(vow.floors.map((f) => f.id).sort(), [alphaId, betaId].sort());
  assert.ok(vow.missionControl);
  assert.equal((await vo.act({ t: 'orchestrator.prompt', prompt: 'hi' })).error, GUEST_REFUSED);
  assert.equal((await vo.act({ t: 'worker.interrupt', workerId: b1 })).error, GUEST_REFUSED);

  // Activity elsewhere reaches nobody outside its scope.
  owner.send({ t: 'floor.go', floor: betaId });
  await owner.wait('floor.enter', (m) => m.floor === betaId && m.workers.length === 1);
  owner.send({ t: 'worker.attach', workerId: b1 });
  owner.send({ t: 'term.input', workerId: b1, data: 'echo BETA_ONLY\r' });
  owner.send({ t: 'worker.attach', workerId: a1 });
  await delay(1500);

  // The view-only guest's typing and resize changed nothing.
  assert.equal(
    owner.messages.some((m) => m.t === 'term.data' && m.workerId === a1 && m.data.includes('VIEW_ONLY_TYPED')),
    false,
  );
  const a1Now = owner.messages.filter((m) => m.t === 'worker.update' && m.worker.id === a1).at(-1);
  assert.notEqual(a1Now?.t === 'worker.update' ? a1Now.worker.cols : 0, 33);

  for (const [who, sock] of [
    ['view-floor', vf],
    ['view-worker', vwk],
    ['edit-floor', ef],
  ] as [string, Sock][]) {
    const all = JSON.stringify(sock.messages);
    assert.equal(all.includes(b1), false, `${who} never hears of a worker on another floor`);
    assert.equal(all.includes(betaId), false, `${who} never hears of another floor`);
    assert.equal(
      sock.messages.some((m) => m.t === 'missionControl'),
      false,
      `${who} gets no Mission Control`,
    );
  }
  for (const who of [a1, a2]) assert.equal(JSON.stringify(vwk.messages).includes(who), false, 'a single-worker guest hears only of its worker');
  assert.equal(
    vwk.messages.some((m) => m.t === 'whiteboard' || m.t === 'gh.issues' || m.t === 'visits'),
    false,
  );
  for (const sock of [vf, vwk, ef, eo, vo]) {
    assert.equal(
      sock.messages.some((m) => (m.t as string) === 'guestLinks.changed' || m.t === 'factory' || m.t === 'setup' || m.t === 'automation.run'),
      false,
    );
  }
  assert.ok(
    owner.messages.some((m) => m.t === 'guestLinks.changed'),
    'the owner hears about share links',
  );
  assert.ok(
    owner.messages.some((m) => m.t === 'welcome' && 'factory' in m && 'setup' in m),
    'the owner’s welcome is whole',
  );

  // The single worker going home reaches its guest, and nothing else does.
  owner.send({ t: 'floor.go', floor: alphaId });
  await owner.wait('floor.enter', (m) => m.floor === alphaId && m.workers.some((w) => w.id === a3));
  const killed = await owner.act({ t: 'worker.kill', workerId: a3 });
  assert.equal(killed.ok, true, killed.error);
  await vwk.wait('worker.remove', (m) => m.workerId === a3);

  // --- Audit ------------------------------------------------------------------------------------
  const audit = (await r.api<GuestAuditPage>('GET', '/api/guest-links/audit?limit=100')).body.entries;
  const labels = new Set(audit.map((e) => e.linkLabel));
  assert.equal(labels.has('Viewer - floor') || labels.has('Viewer - worker') || labels.has('Viewer - office'), false, 'refused attempts are not audited');
  const tty = audit.find((e) => e.action === 'tty' && e.linkLabel === 'Alex - PR review');
  assert.equal(tty?.target.kind, 'worker');
  assert.equal(tty?.target.workerId, a1);
  assert.equal(tty?.target.floorId, alphaId);
  assert.equal(tty?.target.floorName, 'alpha');
  assert.match(tty?.detail ?? '', /echo GUEST_/);
  const prompt = audit.find((e) => e.action === 'prompt' && e.linkLabel === 'Alex - PR review');
  assert.equal(prompt?.target.workerId, a2);
  assert.equal(prompt?.detail, 'echo PROMPTED');
  assert.equal(prompt?.preset, 'edit-floor');
  assert.ok(audit.find((e) => e.action === 'hire' && e.linkLabel === 'Alex - PR review' && e.target.kind === 'floor' && e.target.floorId === alphaId));
  assert.ok(audit.find((e) => e.action === 'prompt' && e.linkLabel === 'Sam - everything' && e.target.workerId === b1 && e.target.floorName === 'beta'));
  assert.ok(audit.find((e) => e.action === 'mission' && e.linkLabel === 'Sam - everything' && e.target.kind === 'missionControl'));
  assert.equal(
    audit.some((e) => e.detail?.includes('CROSS_FLOOR')),
    false,
  );

  // --- The main listener never takes a guest token ------------------------------------------------
  const wsBase = r.base.replace('http:', 'ws:');
  for (const opts of [{ protocols: [GUEST_WS_PROTOCOL, editOffice.token] }, { headers: { authorization: `Bearer ${editOffice.token}` } }]) {
    const stray = new WebSocket(`${wsBase}/ws`, opts.protocols ?? [], { origin: r.base, ...(opts.headers ? { headers: opts.headers } : {}) });
    t.after(() => stray.terminate());
    const [err] = await Promise.race([once(stray, 'error'), once(stray, 'open').then(() => assert.fail('a guest token opened the main listener'))]);
    assert.match((err as Error).message, /401/);
  }

  // --- Revoke and the kill switch ------------------------------------------------------------------
  assert.equal((await r.api('DELETE', `/api/guest-links/${viewFloor.id}`)).status, 200);
  const revoked = await vf.until(() => vf.closed(), 'the revoked guest to disconnect');
  assert.deepEqual(revoked, { code: GUEST_CLOSE_ENDED, reason: 'revoked' });
  const again = r.guest(viewFloor.token);
  const [err] = await Promise.race([once(again.ws, 'error'), once(again.ws, 'open').then(() => assert.fail('a revoked link opened a socket'))]);
  assert.match((err as Error).message, /401/);
  assert.equal(owner.ws.readyState, WebSocket.OPEN);

  assert.equal((await r.api('PUT', '/api/guest-links', { on: false })).status, 200);
  for (const sock of [vwk, ef, eo, vo]) assert.deepEqual(await sock.until(() => sock.closed(), 'guests to disconnect'), { code: GUEST_CLOSE_DISABLED, reason: 'disabled' });
  assert.equal(owner.ws.readyState, WebSocket.OPEN, 'the owner stays connected');
  owner.send({ t: 'ping', at: 1 });
  await owner.wait('pong');
});
