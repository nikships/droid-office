// Share-link guests on the WebSocket, end to end: a real office pinned to a stubbed Tailscale CLI
// (--tailscale-bin: no PATH lookup, no fallback to an installed one), and guest sockets through the real guest backend listener with
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
import { GUEST_ORCHESTRATOR_BLOCKED, GUEST_REFUSED } from '../src/shared/guest-policy.js';
import { SUBAGENT_DEFAULTS, type ClientMsg, type ServerMsg } from '../src/shared/protocol.js';

const DNS = 'office.guest-test.ts.net';
const GUEST_ORIGIN = `https://${DNS}:10000`;

/** The `tailscale` calls the office makes for guest sharing; the stub answers only these. */
const EXPECTED_TAILSCALE = [/^status --json$/, /^(serve|funnel) status --json$/, /^funnel --bg --yes --https=10000 http:\/\/127\.0\.0\.1:\d+$/, /^funnel --yes --https=10000 off$/];

/**
 * A `tailscale` that answers like a signed-in machine (status trimmed from the real capture in
 * remote-mcp.test.ts) and keeps the one Funnel mapping the office makes, in `serve status --json`'s
 * shape, so turning sharing off finds and removes it. It logs every call; anything else exits non-zero,
 * logged UNEXPECTED.
 */
function stubTailscale(dir: string): { bin: string; log: string } {
  const bin = path.join(dir, 'tailscale');
  const log = path.join(dir, 'tailscale.log');
  const mapping = path.join(dir, 'tailscale-serve.json');
  const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${DNS}.`, TailscaleIPs: ['100.101.102.103'] }, CurrentTailnet: { MagicDNSEnabled: true } });
  const key = `${DNS}:10000`;
  writeFileSync(
    bin,
    `#!/bin/sh
case "$*" in
  "status --json") echo "$*" >> '${log}'; printf '%s' '${status}'; exit 0 ;;
  "serve status --json"|"funnel status --json") echo "$*" >> '${log}'; if [ -f '${mapping}' ]; then cat '${mapping}'; else printf '{}'; fi; exit 0 ;;
  "funnel --bg --yes --https=10000 http://127.0.0.1:"*)
    echo "$*" >> '${log}'
    printf '{"TCP":{"10000":{"HTTPS":true}},"Web":{"${key}":{"Handlers":{"/":{"Proxy":"%s"}}}},"AllowFunnel":{"${key}":true}}' "$5" > '${mapping}'
    exit 0 ;;
  "funnel --yes --https=10000 off") echo "$*" >> '${log}'; rm -f '${mapping}'; exit 0 ;;
esac
echo "UNEXPECTED $*" >> '${log}'
echo "tailscale stub: unexpected call: $*" >&2
exit 64
`,
  );
  chmodSync(bin, 0o755);
  writeFileSync(log, '');
  return { bin, log };
}
/** Every call the stub saw, each one asserted to be one the office is expected to make. */
function tailscaleCalls(log: string): string[] {
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  for (const call of calls)
    assert.ok(
      EXPECTED_TAILSCALE.some((re) => re.test(call)),
      `unexpected tailscale call: ${call}`,
    );
  return calls;
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

/** `commits`: each project gets a first commit, so a worker can have worktrees of them. */
async function rig(t: TestContext, { commits = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guest-ws-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const { bin, log } = stubTailscale(root);
  const home = path.join(root, 'home');
  const projects = path.join(root, 'projects');
  const alpha = path.join(projects, 'alpha');
  const beta = path.join(projects, 'beta');
  for (const dir of [home, alpha, beta]) {
    mkdirSync(dir, { recursive: true });
    if (dir !== home) execFileSync('git', ['init', '-q'], { cwd: dir });
    if (dir !== home && commits) execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  }
  const cfg = loadConfig([alpha, '--home', home, '--projects', projects, '--weather', 'clear', '--host', '127.0.0.1', '--tailscale-bin', bin]);
  assert.equal(cfg.tailscaleBin, bin);
  cfg.port = 0;
  if (commits) {
    // A stand-in Droid: a session just waits, and the office's checks (--version, doctor) find it not installed.
    const fake = path.join(root, 'fake-droid');
    writeFileSync(fake, "#!/usr/bin/env node\nif (process.argv[2] === '--version' || process.argv[2] === 'doctor') process.exit(1);\nprocess.stdin.resume();\n", { mode: 0o755 });
    cfg.agentCmd = fake;
  }
  // Unset in tests so they never publish; this one publishes to the stub only.
  cfg.guestSharing = true;
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
  assert.ok(tailscaleCalls(log).includes(`funnel --bg --yes --https=10000 http://127.0.0.1:${backend}`));

  const link = async (label: string, preset: GuestPreset, extra: { floorId?: string; workerId?: string } = {}) => {
    const r = await api<GuestLinkCreated>('POST', '/api/guest-links', { label, preset, expiry: 'never', ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { id: r.body.link.id, token: new URL(r.body.url).hash.slice('#g='.length) };
  };
  const guest = (token: string, query = 'client=dashboard') => watch(t, new WebSocket(`ws://127.0.0.1:${backend}/ws?${query}`, [GUEST_WS_PROTOCOL, token], { headers: { host: `${DNS}:10000`, origin: GUEST_ORIGIN } }));
  return { office, base, api, owner, tailscaleLog: log, alphaId, betaId, alphaDir: alpha, a1, a2, a3, b1, link, guest };
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
  vf.send({ t: 'worker.attach', workerId: a2, stream: false });
  await delay(300);
  // A guest looking is not the owner looking: nothing it opens counts as open or seen.
  assert.equal(
    owner.messages.some((m) => m.t === 'worker.update' && (m.worker.id === a1 || m.worker.id === a2) && m.worker.open),
    false,
    'a guest’s open terminal or thread never marks a worker open for the owner',
  );
  // The owner opening it alongside still does, and the guest leaving never closes it under them.
  owner.send({ t: 'worker.attach', workerId: a2, stream: false });
  await owner.wait('worker.update', (m) => m.worker.id === a2 && m.worker.open === true);
  const opened = owner.messages.length;
  vf.send({ t: 'worker.detach', workerId: a2 });
  await delay(300);
  assert.equal(
    owner.messages.slice(opened).some((m) => m.t === 'worker.update' && m.worker.id === a2 && !m.worker.open),
    false,
  );
  owner.send({ t: 'worker.detach', workerId: a2 });
  await owner.wait('worker.update', (m) => m.worker.id === a2 && m.worker.open === false);
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
  // A committed Whiteboard change is audited once; a retry, a malformed or rejected change, an ineligible ping and an empty comment are not.
  const snapshot = ef.messages.find((m) => m.t === 'whiteboard' && m.floor === alphaId && m.update.kind === 'snapshot');
  const epoch = snapshot?.t === 'whiteboard' && snapshot.update.kind === 'snapshot' ? snapshot.update.epoch : '';
  assert.ok(epoch, 'the guest gets its floor’s Whiteboard');
  const show = { t: 'whiteboard.apply', floor: alphaId, envelope: { epoch, seq: 1, ops: [{ op: 'show', selection: { kind: 'grid' } }] } } as unknown as ClientMsg;
  ef.send(show);
  await ef.wait('whiteboard', (m) => m.update.kind === 'ack' && m.update.seq === 1);
  ef.send(show);
  await ef.until(() => (ef.messages.filter((m) => m.t === 'whiteboard' && m.update.kind === 'ack' && m.update.seq === 1).length === 2 ? true : undefined), 'the retry’s ack');
  ef.send({ t: 'whiteboard.apply', floor: alphaId, envelope: { epoch, seq: 2, ops: [{ op: 'card.title', card: 'nope', title: 'x' }] } } as unknown as ClientMsg);
  await ef.wait('whiteboard', (m) => m.update.kind === 'rejected');
  ef.send({ t: 'whiteboard.apply', floor: alphaId, envelope: { epoch, seq: 0, ops: [] } } as unknown as ClientMsg);
  await ef.wait('toast', (m) => /malformed/.test(m.text));
  // Committed, though its button press then reaches nobody (a page nobody made): still audited.
  ef.send({
    t: 'whiteboard.apply',
    floor: alphaId,
    envelope: {
      epoch,
      seq: 3,
      ops: [
        { op: 'card.create', card: 'c-guestpage1', kind: 'canvas', title: 'Guest page' },
        { op: 'state.action', card: 'c-guestpage1', name: 'accept', ping: { text: 'Ship it.', label: 'Accept' } },
      ],
    },
  } as unknown as ClientMsg);
  await ef.wait('whiteboard', (m) => m.update.kind === 'ack' && m.update.seq === 3);
  await ef.wait('toast', (m) => /didn't reach a worker/.test(m.text));
  ef.send({ t: 'whiteboard.ping', worker: a1 });
  const ping = await ef.wait('whiteboard.pinged', (m) => m.worker === a1);
  assert.equal(ping.ok, false, 'a shell can’t be pinged');
  ef.send({ t: 'gh.comment', kind: 'pull', number: 1, body: '  ' } as ClientMsg);
  await ef.wait('gh.commented', (m) => m.number === 1);
  // Refused by the office's own checks: no audit entry, since nothing happened.
  const badAnswer = await ef.act({ t: 'worker.answer', workerId: a1 } as ClientMsg);
  assert.equal(badAnswer.ok, false);
  assert.notEqual(badAnswer.error, GUEST_REFUSED);
  const badQueue = await ef.act({ t: 'worker.queue', workerId: a1, action: 'nope' } as unknown as ClientMsg);
  assert.equal(badQueue.ok, false, 'an invalid queue action is refused');
  for (const msg of [{ t: 'shell.attach' }, { t: 'floor.remove', floor: alphaId }, { t: 'setup.check' }, { t: 'machine.limit', limit: 1 }] as ClientMsg[]) assert.equal((await ef.act(msg)).error, GUEST_REFUSED, msg.t);

  // --- Complete access overall ------------------------------------------------------------------
  const editOffice = await r.link('Sam - everything', 'edit-office');
  const eo = r.guest(editOffice.token);
  const eow = await eo.wait('welcome');
  assert.deepEqual(eow.floors.map((f) => f.id).sort(), [alphaId, betaId].sort());
  assert.deepEqual(eow.missionControl?.bots, []);
  assert.ok(eow.missionControl?.orchestrator);
  // Blocked by the owner's setup: the owner reads why and where to fix it, a guest one fixed line, and its prompt the same.
  owner.send({ t: 'subagents.set', settings: { ...SUBAGENT_DEFAULTS, officeMcp: false } });
  const ownerBlocked = await owner.wait('missionControl', (m) => !!m.state.orchestrator.blocked);
  assert.match(ownerBlocked.state.orchestrator.blocked!, /Office MCP/);
  assert.equal(ownerBlocked.state.orchestrator.blockedPane, 'subagents');
  const guestBlocked = await eo.wait('missionControl', (m) => !!m.state.orchestrator.blocked);
  assert.deepEqual([guestBlocked.state.orchestrator.blocked, 'blockedPane' in guestBlocked.state.orchestrator], [GUEST_ORCHESTRATOR_BLOCKED, false]);
  const refused = await eo.act({ t: 'orchestrator.prompt', prompt: 'hi' });
  assert.deepEqual([refused.ok, refused.error], [false, GUEST_ORCHESTRATOR_BLOCKED]);
  assert.ok(!eo.messages.some((m) => m.t === 'toast' && /Office MCP/.test(m.text)), 'the owner’s reason never reaches the guest');
  owner.send({ t: 'subagents.set', settings: SUBAGENT_DEFAULTS });
  await eo.wait('missionControl', (m) => !m.state.orchestrator.blocked);
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
  const lastVisit = (id: string) =>
    owner.messages
      .flatMap((m) => (m.t === 'floors' ? m.floors : m.t === 'welcome' ? m.floors : []))
      .filter((x) => x.id === id)
      .at(-1)?.lastVisitedAt;
  await delay(400);
  const betaVisit = lastVisit(betaId);
  eo.send({ t: 'floor.go', floor: betaId });
  const entered = await eo.wait('floor.enter', (m) => m.floor === betaId);
  assert.deepEqual(
    entered.workers.map((w) => w.id),
    [b1],
  );
  assert.equal((await eo.act({ t: 'worker.prompt', workerId: b1, prompt: 'echo OFFICE_WIDE' })).ok, true);
  await delay(400);
  assert.equal(lastVisit(betaId), betaVisit, 'a guest arriving is not the owner visiting');
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
  // Gone from every map by now: the floor it left still routes the news to everyone whose scope held it.
  await vwk.wait('worker.remove', (m) => m.workerId === a3);
  await ef.wait('worker.remove', (m) => m.workerId === a3);
  await vo.wait('worker.remove', (m) => m.workerId === a3);
  await eo.wait('building.remove', (m) => m.workerId === a3 && m.floor === alphaId);
  // A write guest sending its own hire home.
  assert.equal((await ef.act({ t: 'worker.kill', workerId: hired.workerId! })).ok, true);
  await owner.wait('worker.remove', (m) => m.workerId === hired.workerId);
  await ef.wait('worker.remove', (m) => m.workerId === hired.workerId);

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
  assert.ok(audit.find((e) => e.action === 'dismiss' && e.linkLabel === 'Alex - PR review' && e.target.workerId === hired.workerId));
  assert.equal(
    audit.some((e) => e.linkLabel === 'Alex - PR review' && (e.action === 'answer' || e.action.startsWith('permission') || e.target.workerId === a1) && e.action !== 'tty'),
    false,
    'an action the office refused leaves no audit entry',
  );
  assert.deepEqual(
    audit.filter((e) => e.linkLabel === 'Alex - PR review' && (e.action === 'whiteboard' || e.action === 'git')).map((e) => [e.action, e.detail]),
    [
      ['whiteboard', '2 Whiteboard change(s)'],
      ['whiteboard', '1 Whiteboard change(s)'],
    ],
    'only committed Whiteboard changes are audited, one with a press that reached nobody included',
  );

  // --- A scoped floor closes and opens again ---------------------------------------------------------
  const viewBeta = await r.link('Viewer - beta', 'view-floor', { floorId: betaId });
  const vb = r.guest(viewBeta.token);
  assert.equal((await vb.wait('welcome')).floor, betaId);
  assert.equal((await vb.act({ t: 'floor.go', floor: alphaId })).error, GUEST_REFUSED);
  const removed = await owner.act({ t: 'floor.remove', floor: betaId });
  assert.equal(removed.ok, true, removed.error);
  await vb.wait('floor.enter', (m) => m.floor === null && m.arrival.via === 'lobby');
  await vb.wait('toast', (m) => m.text === 'This floor is no longer shared.');
  assert.equal((await vb.act({ t: 'floor.go', floor: betaId })).error, GUEST_REFUSED, 'a closed floor is nowhere to go');
  const readded = await owner.act({ t: 'floor.add', dir: path.join(path.dirname(r.alphaDir), 'beta') });
  assert.equal(readded.ok, true, readded.error);
  assert.equal((await owner.wait('floor.added', (m) => !!m.floor && m.floor !== alphaId)).floor, betaId, 'the same checkout opens as the same floor');
  const back = await vb.wait('floor.enter', (m) => m.floor === betaId);
  assert.equal(back.arrival.floor, betaId);
  assert.equal(JSON.stringify(vb.messages).includes(alphaId), false, 'a floor guest in the lobby hears nothing of other floors');

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
  for (const sock of [vwk, ef, eo, vo, vb]) assert.deepEqual(await sock.until(() => sock.closed(), 'guests to disconnect'), { code: GUEST_CLOSE_DISABLED, reason: 'disabled' });
  assert.equal(owner.ws.readyState, WebSocket.OPEN, 'the owner stays connected');
  await owner.until(() => (readFileSync(r.tailscaleLog, 'utf8').includes('funnel --yes --https=10000 off') ? true : undefined), 'Funnel to be taken down');
  const calls = tailscaleCalls(r.tailscaleLog);
  assert.equal(
    calls.some((c) => c.startsWith('UNEXPECTED')),
    false,
  );
  owner.send({ t: 'ping', at: 1 });
  await owner.wait('pong');
});

test('a worker across repositories comes and goes without a frame to a floor link that never saw it', { timeout: 60_000 }, async (t) => {
  const r = await rig(t, { commits: true });
  const { owner, alphaId, betaId } = r;
  const vf = r.guest((await r.link('Viewer - alpha', 'view-floor', { floorId: alphaId })).token);
  const vo = r.guest((await r.link('Viewer - office', 'view-office')).token);
  await vf.wait('welcome');
  await vo.wait('welcome');
  const hired = await owner.act({ t: 'worker.spawn', deskId: 'auto', kind: 'agent', worktree: true, repos: [betaId] });
  assert.equal(hired.ok, true, hired.error);
  const id = hired.workerId!;
  const seen = await owner.wait('worker.update', (m) => m.worker.id === id && !!m.worker.repos?.length);
  assert.deepEqual(
    seen.worker.repos?.map((x) => x.floor),
    [betaId],
  );
  await vo.wait('worker.update', (m) => m.worker.id === id);
  const sent = await owner.act({ t: 'worker.kill', workerId: id, cleanup: 'all' });
  assert.equal(sent.ok, true, sent.error);
  // An office link saw it, so it hears it leave: by then the floor link has had its chance to as well.
  await vo.wait('worker.remove', (m) => m.workerId === id);
  await vo.wait('building.remove', (m) => m.workerId === id && m.floor === alphaId);
  vf.send({ t: 'ping', at: 2 });
  await vf.wait('pong');
  assert.deepEqual(
    vf.messages.filter((m) => JSON.stringify(m).includes(id)),
    [],
    'no frame names it',
  );
});
