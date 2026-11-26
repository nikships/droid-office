// Share-link guests on the WebSocket, end to end: a real office pinned to a stubbed Tailscale CLI
// (--tailscale-bin: no PATH lookup, no fallback to an installed one), and guest sockets through the real guest backend listener with
// the Host and Origin Funnel would send. Worker visibility is checked against what arrives on the wire.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { GUEST_WS_PROTOCOL, type GuestLinkCreated, type GuestLinksState, type GuestPreset } from '../src/shared/guest-links.js';
import type { ClientMsg, ServerMsg, WorkerInfo } from '../src/shared/protocol.js';

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

test('a floor guest rebuilding every lost worktree rebuilds only the workers its link sees', { timeout: 60_000 }, async (t) => {
  const r = await rig(t, { commits: true });
  const { owner, alphaId, betaId } = r;
  const ef = r.guest((await r.link('Alex - alpha', 'edit-floor', { floorId: alphaId })).token);
  await ef.wait('welcome');
  const hire = async (repos?: string[]) => {
    const res = await owner.act({ t: 'worker.spawn', deskId: 'auto', kind: 'agent', worktree: true, ...(repos ? { repos } : {}) });
    assert.equal(res.ok, true, res.error);
    return (await owner.wait('worker.update', (m) => m.worker.id === res.workerId && !!m.worker.worktree)).worker;
  };
  const mine = await hire();
  const hidden = await hire([betaId]);
  assert.ok(hidden.repos?.length, 'it works in beta too');
  // Both worktrees deleted outside the office: each is marked lost at the next folder check (every 10 s).
  // Across repositories, the worker's folder is the workspace holding a worktree of each.
  const folder = (w: WorkerInfo) => path.join(r.alphaDir, w.repos?.length ? path.dirname(w.worktree!.path) : w.worktree!.path);
  for (const w of [mine, hidden]) rmSync(folder(w), { recursive: true, force: true });
  const update = (sock: Sock, from: number, id: string, lost: boolean) => sock.until(() => sock.messages.slice(from).find((m) => m.t === 'worker.update' && m.worker.id === id && !!m.worker.lost === lost), `${id} lost: ${lost}`, 25_000);
  for (const w of [mine, hidden]) await update(owner, 0, w.id, true);
  await update(ef, 0, mine.id, true);

  const before = owner.messages.length;
  ef.send({ t: 'worker.rebuild', workerId: mine.id, all: true });
  await update(owner, before, mine.id, false);
  const toast = await owner.wait('toast', (m) => m.text.includes('rebuilt'));
  assert.match(toast.text, new RegExp(`rebuilt ${mine.name}'s worktree$`), 'only the worker the guest sees');
  assert.equal(existsSync(folder(hidden)), false, 'the hidden worker’s workspace, its beta worktree included, stays gone');
  assert.equal(existsSync(folder(mine)), true);
  owner.send({ t: 'ping', at: 3 });
  await owner.wait('pong');
  assert.ok(
    owner.messages.slice(before).every((m) => m.t !== 'worker.update' || m.worker.id !== hidden.id || !!m.worker.lost),
    'it is still lost',
  );
  ef.send({ t: 'ping', at: 4 });
  await ef.wait('pong');
  assert.deepEqual(
    ef.messages.filter((m) => JSON.stringify(m).includes(hidden.id) || JSON.stringify(m).includes(hidden.name)),
    [],
    'no frame names it',
  );
});
