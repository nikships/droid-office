import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { WebSocket } from 'ws';
import { Answers } from '../src/server/answers.js';
import { loadConfig } from '../src/server/config.js';
import { analyzeCheckoutSafety, buildOtherFloorWorkers, formatOtherFloorWorkers, pickUniqueForkName, pickUniqueSeat, pickUniqueWorkerName, readHeadBranch, workerLocation } from '../src/server/floor-watch.js';
import type { GrokWebhookPayload } from '../src/server/grok-webhook.js';
import { createOfficeMcp, type OfficeMcpFloor } from '../src/server/office-mcp/index.js';
import { type OwnerFloor, type OwnerOffice, roster } from '../src/server/office-mcp/owner.js';
import { remoteMcpListener } from '../src/server/remote-mcp-http.js';
import { RemoteOffice, type RemoteFloor } from '../src/server/remote-office.js';
import { RemoteWorkers } from '../src/server/remote-workers.js';
import { startServer } from '../src/server/server.js';
import { Team, type TeamWorkers } from '../src/server/team.js';
import { Visits } from '../src/server/visits.js';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import { NAMES } from '../src/server/workers.js';
import { readMenu } from '../src/shared/asks.js';
import { DESKS, nextFreeSeat } from '../src/shared/layout.js';
import { SUBAGENT_DEFAULTS, type ServerMsg, type SubagentSettings, type WorkerInfo } from '../src/shared/protocol.js';

const WEBHOOK_SECRET = 'whsec_floor_watch_test_secret_token';

const proxyFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
  return new Promise((resolve, reject) => {
    const outgoing = request(req.url, { method: req.method, headers: Object.fromEntries(req.headers), signal: req.signal }, (incoming) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const status = incoming.statusCode ?? 500;
      resolve(new Response([204, 205, 304].includes(status) ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), { status, headers }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
};

async function listening(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function makeWorker(id: string, name: string, extra: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id,
    name,
    kind: 'agent',
    deskId: 'desk-1',
    color: '#ff6600',
    status: 'working',
    acked: true,
    createdAt: 1000,
    createdBy: 'Owner',
    cols: 100,
    rows: 30,
    open: false,
    ...extra,
  };
}

test('readHeadBranch, workerLocation and analyzeCheckoutSafety detect shared trees and main-branch writers', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'floor-watch-unit-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const repo = path.join(root, 'survive');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

  assert.deepEqual(readHeadBranch(repo), { found: true, branch: 'main' });

  const wtRel = path.join('.droid-office', 'worktrees', 'nibble-1234');
  const wtAbs = path.join(repo, wtRel);
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'office/nibble-1234', wtAbs, 'HEAD'], { cwd: repo });
  assert.deepEqual(readHeadBranch(wtAbs), { found: true, branch: 'office/nibble-1234' });

  const plain = path.join(root, 'notes');
  mkdirSync(plain, { recursive: true });
  assert.deepEqual(readHeadBranch(plain), { found: false });

  const w1 = makeWorker('w1', 'Pixel', { deskId: 'desk-1', status: 'working' });
  const w2 = makeWorker('w2', 'Nova', { deskId: 'desk-2', status: 'idle' });
  const w3 = makeWorker('w3', 'Nibble', { deskId: 'desk-3', status: 'working', worktree: { path: wtRel, branch: 'office/nibble-1234', base: 'abc' } });
  const asleep = makeWorker('w4', 'Sprocket', { deskId: 'desk-4', status: 'exited' });
  const shell = makeWorker('w5', 'Sandy 🐚', { deskId: 'desk-5', kind: 'shell', status: 'working' });

  const floorCtx = { id: 'survive', name: 'survive', dir: repo, baseBranch: 'main' };
  assert.deepEqual(workerLocation(w1, floorCtx), { cwd: path.resolve(repo), branch: 'main', sharedCheckout: true });
  assert.deepEqual(workerLocation(w3, floorCtx), { cwd: path.resolve(wtAbs), branch: 'office/nibble-1234' });

  const safety = analyzeCheckoutSafety([
    { ...floorCtx, workers: [w1, w2, w3, asleep, shell] },
    { id: 'home', name: 'Home', dir: plain, plain: true, workers: [makeWorker('h1', 'Byte'), makeWorker('h2', 'Bolt')] },
  ]);

  assert.equal(safety.warnings.length, 2, 'one shared_tree warning and one on_main_branch warning on git floor; none on plain floor');
  assert.equal(safety.warnings[0].kind, 'shared_tree');
  assert.match(safety.warnings[0].message, /Pixel \(w1\), Nova \(w2\) share working tree .* without isolated worktrees on main/);
  assert.equal(safety.warnings[1].kind, 'on_main_branch');
  assert.match(safety.warnings[1].message, /Pixel \(w1\), Nova \(w2\) are on main in shared checkout/);
  assert.equal(safety.perWorker.get('w3'), undefined, 'isolated worktree on feature branch has no warning');
  assert.equal(safety.perWorker.get('w4'), undefined, 'exited worker does not count as live writer');
  assert.equal(safety.perWorker.get('w5'), undefined, 'shell does not count as agent writer');

  const others = buildOtherFloorWorkers({ ...floorCtx, workers: [w1, w2, w3] }, 'grokbot', new Set(['w3']));
  assert.deepEqual(
    others.map((o) => [o.id, o.sharedCheckout, o.branch]),
    [
      ['w1', true, 'main'],
      ['w2', true, 'main'],
    ],
  );
  assert.match(formatOtherFloorWorkers(others, false).join('\n'), /call team_watch to follow[\s\S]*Pixel \(w1\).*\(no worktree\), branch main.*Warning:/);
});

test('pickUniqueWorkerName, pickUniqueForkName and pickUniqueSeat avoid live names and desks across floors', () => {
  // Floor B avoids Pixel & Byte (live on Floor A) and Nova (asleep on Floor A), picking Nibble (3rd in NAMES).
  assert.equal(pickUniqueWorkerName(NAMES, [], ['Pixel', 'Byte'], ['Pixel', 'Byte', 'Nova']), 'Nibble');
  // If every name is held by an asleep worker elsewhere, an asleep name may be reused, never a live one.
  const allExceptPixelAsleep = NAMES.slice(1);
  assert.equal(pickUniqueWorkerName(NAMES, [], ['Pixel'], NAMES), 'Byte');
  assert.ok(allExceptPixelAsleep.includes('Byte'));
  // If all 28 pool names are live across floors, fallback Worker N skips collisions too.
  assert.equal(pickUniqueWorkerName(NAMES, ['Worker 1'], [...NAMES, 'Worker 2'], []), 'Worker 3');

  assert.equal(pickUniqueForkName('Pixel', [], ['Pixel ⑂'], ['Pixel ⑂ 2']), 'Pixel ⑂ 3');

  const seat = pickUniqueSeat(
    (taken) => nextFreeSeat(taken),
    (id) => id === 'desk-1',
    (id) => id === 'desk-2',
  );
  assert.equal(seat?.id, 'desk-3');
  // With every other seat taken here, an automatic pick falls back to one live elsewhere.
  const fallback = pickUniqueSeat(
    (taken) => nextFreeSeat(taken),
    (id) => id !== 'desk-2',
    (id) => id === 'desk-2',
  );
  assert.equal(fallback?.id, 'desk-2');
});

test('team_watch wakes Grok Bot on independent floor worker turns, terminal asks, stops, departures and PR transitions', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'floor-watch-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const surviveDir = path.join(dir, 'survive');
  const orcaDir = path.join(dir, 'orca');
  for (const repoDir of [surviveDir, orcaDir]) {
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    writeFileSync(path.join(repoDir, 'file.txt'), 'v1\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: repoDir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repoDir });
  }

  const received: GrokWebhookPayload[] = [];
  const webhookWaiters: Array<() => void> = [];
  const waitForWebhookCount = async (count: number) => {
    while (received.length < count) {
      await new Promise<void>((resolve) => webhookWaiters.push(resolve));
    }
  };
  const webhookServer = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${WEBHOOK_SECRET}`);
    received.push((await readJsonBody(req)) as GrokWebhookPayload);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    for (const notify of webhookWaiters.splice(0)) notify();
  });
  const webhookUrl = `${await listening(t, webhookServer)}/hooks/droid-office`;

  let now = 1_710_000_000_000;
  const settings: SubagentSettings = { ...SUBAGENT_DEFAULTS, wakeLead: true, on: true, officeMcp: true };
  const store = new RemoteWorkers(dir);
  const floors: RemoteFloor[] = [];
  const office = new RemoteOffice(store, () => floors, { fetchImpl: proxyFetch, webhookDelayMs: 20, now: () => now });
  t.after(() => office.stop());

  const makeFloor = (id: string, name: string, repoDir: string) => {
    const people = new Map<string, WorkerInfo>();
    const tokens = new Map<string, string>();
    let screenRows: string[] = [];
    let answeredInput = '';
    const get = (wid: string) => people.get(wid) ?? store.identity(wid);
    let teamRef: Team | undefined;
    const removeWorker = async (wid: string) => {
      people.delete(wid);
      teamRef?.onWorkerGone(wid);
      return {};
    };
    const workers: RemoteFloor['workers'] & TeamWorkers = {
      list: () => [...people.values()],
      get: (wid) => people.get(wid),
      authenticate: (wid, tok) => (tokens.get(wid) === tok ? people.get(wid) : undefined),
      releaseLead: (leadId) => {
        for (const w of people.values()) if (w.lead === leadId) delete w.lead;
      },
      buildingAgent: (wid) => Boolean(store.identity(wid)),
      officeDefault: undefined,
      deskOccupied: (deskId) => [...people.values()].some((w) => w.deskId === deskId),
      hire: (deskId, by, prompt, _wt, _choice, lead) => {
        const wid = `${id}-sub-${people.size + 1}`;
        const w = makeWorker(wid, `Sub${people.size + 1}`, { deskId, createdBy: by, prompt, lead, createdAt: ++now });
        people.set(wid, w);
        tokens.set(wid, `tok-${wid}`);
        return w;
      },
      prompt: () => undefined,
      resume: () => undefined,
      kill: removeWorker,
      dismiss: removeWorker,
      tail: () => screenRows.join('\n'),
      screenLines: () => screenRows,
      screenMenu: () => readMenu(screenRows),
      write: (_wid, data) => {
        answeredInput += data;
        return true;
      },
      setTask: (wid, task) => {
        const w = people.get(wid);
        if (w) w.task = task;
      },
    };
    const team = new Team(
      { ...workers, get },
      {
        dataDir: repoDir,
        dir: repoDir,
        floorId: id,
        floorName: name,
        git: true,
        baseBranch: () => 'main',
        checkoutBranch: () => readHeadBranch(repoDir).branch ?? 'main',
        settings: () => settings,
        toast() {},
        now: () => now,
      },
    );
    teamRef = team;
    t.after(() => team.stop());
    const visits = new Visits({ ...workers, get, tell: workers.prompt, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => settings.visits, emit() {}, now: () => now });
    t.after(() => visits.stop());
    const whiteboard = new WhiteboardStore(repoDir);
    t.after(() => whiteboard.stop());
    const floor: RemoteFloor = { id, dir: repoDir, def: { name }, workers, team, visits, whiteboard };
    floors.push(floor);
    return {
      floor,
      people,
      tokens,
      setScreen: (rows: string[]) => {
        screenRows = rows;
      },
      getAnswered: () => answeredInput,
    };
  };

  const survive = makeFloor('survive', 'Survive', surviveDir);
  const orca = makeFloor('orca', 'Orca', orcaDir);

  // Two owner-started independent workers sharing Survive's main checkout with no worktree!
  const soloA = makeWorker('solo-a', 'Pixel', { deskId: 'desk-1', status: 'working', activity: 'Editing combat loop', task: { name: 'Combat loop', summary: 'Refactored tick timing' } });
  const soloB = makeWorker('solo-b', 'Nova', { deskId: 'desk-2', status: 'idle', activity: 'Updated HUD' });
  survive.people.set(soloA.id, soloA);
  survive.people.set(soloB.id, soloB);
  survive.floor.team.onWorker(soloA);
  survive.floor.team.onWorker(soloB);

  // Two active independent workers on Orca as well.
  const orcaA = makeWorker('orca-a', 'Sprocket', { deskId: 'desk-3', status: 'working', activity: 'Fixing PTY resize' });
  const orcaB = makeWorker('orca-b', 'Widget', { deskId: 'desk-4', status: 'working', activity: 'Running cargo test' });
  orca.people.set(orcaA.id, orcaA);
  orca.people.set(orcaB.id, orcaB);
  orca.floor.team.onWorker(orcaA);
  orca.floor.team.onWorker(orcaB);

  const grok = office.add('grokbot', { webhookUrl, webhookToken: WEBHOOK_SECRET });
  office.syncWatches();

  const owner: OwnerOffice = {
    floors: (): OwnerFloor[] =>
      floors.map((f) => ({
        id: f.id,
        name: f.def.name,
        dir: f.dir,
        branch: readHeadBranch(f.dir).branch ?? 'main',
        baseBranch: 'main',
        watchedBy: (leadId, workerId) => f.team.isWatching?.(leadId, workerId) ?? false,
        workers: f.workers.list(),
      })),
    mission: () => [{ worker: grok.worker, team: [] }],
    tail: () => undefined,
    act: async () => ({ notes: [] }),
  };

  const floorLookup = (wid: string): OfficeMcpFloor | undefined => {
    const f = floors.find((x) => x.workers.get(wid));
    return f ? { ...f, name: f.def.name } : undefined;
  };
  const hostname = 'office.example.ts.net';
  const mcpDeps = { answers: new Answers(), owner, remote: office, floor: floorLookup, settings: () => settings };
  const localMcp = createOfficeMcp(mcpDeps);
  const localUrl = new URL(
    '/office/mcp',
    await listening(
      t,
      createServer((req, res) => void localMcp.handle(req, res)),
    ),
  );
  const remoteUrl = new URL('/office/mcp', await listening(t, remoteMcpListener({ ...mcpDeps, remoteTransport: { hostname: () => hostname, owner: () => undefined } })));

  const grokClient = new Client({ name: 'grok-watch-test', version: '1' });
  t.after(() => grokClient.close());
  await grokClient.connect(
    new StreamableHTTPClientTransport(remoteUrl, {
      fetch: proxyFetch,
      requestInit: { headers: { host: `${hostname}:8443`, Authorization: `Bearer ${grok.token}` } },
    }),
  );
  const callGrok = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await grokClient.callTool({ name, arguments: args });
    return {
      isError: res.isError === true,
      text: (res.content as { text?: string }[]).map((c) => c.text ?? '').join('\n'),
      body: (res.structuredContent ?? {}) as Record<string, unknown>,
    };
  };

  // 1. office_roster flags two writers sharing Survive's checkout on main without worktrees.
  const rosterRes = await callGrok('office_roster', { floor: 'survive' });
  assert.equal(rosterRes.isError, false, rosterRes.text);
  assert.match(rosterRes.text, /Directory: .*survive \(shared checkout, no worktree\)/);
  assert.match(rosterRes.text, /Branch: main/);
  assert.match(rosterRes.text, /Checkout warnings[\s\S]*Pixel \(solo-a\), Nova \(solo-b\) share working tree .* without isolated worktrees on main/);
  const rosterWarnings = rosterRes.body.warnings as Array<{ kind: string }>;
  assert.deepEqual(
    rosterWarnings.map((w) => w.kind),
    ['shared_tree', 'on_main_branch'],
  );

  // 2. Seed an old event on Orca, establish baseline cursor at 0, then acknowledge the event via office_inbox.
  await callGrok('team_status', { floor: 'orca', verbose: false });
  const subHire = await callGrok('team_hire', { title: 'Quick check', brief: 'Inspect logs', floor: 'orca', worktree: false });
  assert.equal(subHire.isError, false, subHire.text);
  const tempSubId = (subHire.body.worker as { id: string }).id;
  const tempSubClient = new Client({ name: 'temp-sub', version: '1' });
  t.after(() => tempSubClient.close());
  await tempSubClient.connect(
    new StreamableHTTPClientTransport(localUrl, {
      requestInit: { headers: { Authorization: `Bearer ${orca.tokens.get(tempSubId)!}`, 'x-droid-office-worker-id': tempSubId } },
    }),
  );
  await tempSubClient.callTool({ name: 'team_report', arguments: { text: 'Old report from yesterday.' } });
  await callGrok('team_dismiss', { worker: tempSubId, floor: 'orca' });
  const inboxBefore = await callGrok('office_inbox');
  const oldIds = (inboxBefore.body.messages as Array<{ id: string }>).map((m) => m.id);
  assert.ok(oldIds.length >= 1);
  await callGrok('office_inbox', { ack: oldIds });
  received.length = 0;

  // Calling team_status with floor: "orca" must NOT replay already-acked news, AND must surface Sprocket & Widget!
  const orcaStatus = await callGrok('team_status', { floor: 'orca' });
  assert.equal(orcaStatus.isError, false, orcaStatus.text);
  assert.doesNotMatch(orcaStatus.text, /Old report from yesterday/, 'acked inbox events are not replayed as unread news');
  assert.match(orcaStatus.text, /No unread team news\./);
  assert.match(orcaStatus.text, /Other workers on floor \(not in your team; call team_watch to follow\):[\s\S]*Sprocket \(orca-a\)[\s\S]*Widget \(orca-b\)/);
  assert.equal((orcaStatus.body.floorWorkers as unknown[]).length, 2);

  // Passing a single-floor `since` event id for Survive must NOT dump Orca's historical seq-0 log!
  const crossSince = await callGrok('team_status', { since: 'team:survive:0', verbose: false });
  assert.equal(crossSince.isError, false, crossSince.text);
  assert.deepEqual(crossSince.body.news, []);

  // 3. Before team_watch, independent worker changes do NOT wake Grok Bot.
  now += 1000;
  soloA.status = 'done';
  survive.floor.team.onWorker(soloA);
  await delay(60);
  assert.equal(received.length, 0, 'unwatched independent worker does not push to Grok Bot');

  // 4. Call team_watch to adopt/follow soloA without re-hiring or mutating WorkerInfo.lead.
  const watchRes = await callGrok('team_watch', { floor: 'survive', worker: 'Pixel' });
  assert.equal(watchRes.isError, false, watchRes.text);
  assert.match(watchRes.text, /Pixel \(survive\): watching/);
  assert.equal(soloA.lead, undefined, 'WorkerInfo.lead stays unset so worker remains independent');
  assert.equal(survive.floor.team.cannotHire(soloA), undefined, 'watched independent worker can still hire subagents');
  assert.equal(survive.floor.team.beforeStop(soloA), undefined, 'Stop hook never blocks demanding team_report');

  // team_dismiss refuses watched independent workers so owner sessions stay safe.
  const dismissRefused = await callGrok('team_dismiss', { floor: 'survive', worker: 'Pixel' });
  assert.equal(dismissRefused.isError, true);
  assert.match(dismissRefused.text, /watched floor worker, not your hired subagent/);

  // office_roster marks Pixel as [watching].
  const watchedRoster = await callGrok('office_roster', { floor: 'survive' });
  assert.match(watchedRoster.text, /Pixel \(solo-a\) \[watching\]/);

  // 5. Independent watched worker asks an AskUser terminal question -> wakes Grok Bot with questionId, answerable via question_answer!
  survive.setScreen(['Which combat tick rate should we target?', '❯ 1. 60 Hz', '  2. 120 Hz', 'Enter to select · ↑/↓ to navigate · Esc to cancel']);
  now += 1000;
  soloA.status = 'working';
  survive.floor.team.onWorker(soloA);
  now += 1000;
  soloA.status = 'needs_input';
  soloA.waitingSince = now;
  soloA.activity = 'Which combat tick rate should we target?';
  soloA.ask = {
    kind: 'question',
    questions: [{ question: 'Which combat tick rate should we target?', options: ['60 Hz', '120 Hz'] }],
  };
  survive.floor.team.onWorker(soloA);
  await waitForWebhookCount(1);

  assert.equal(received.length, 1, 'terminal question from watched worker wakes Grok Bot');
  assert.equal(received[0].event, 'needs_input');
  assert.equal(received[0].items[0].worker?.watched, true);
  assert.equal(received[0].items[0].worker?.branch, 'main');
  const qId = received[0].items[0].questionId;
  assert.ok(qId?.startsWith('ask:survive:solo-a:'));

  const qList = await callGrok('questions_list', { floor: 'survive' });
  assert.equal((qList.body.questions as unknown[]).length, 1);

  const ansRes = await callGrok('question_answer', { questionId: qId, optionId: '2' });
  assert.equal(ansRes.isError, false, ansRes.text);
  assert.ok(survive.getAnswered().length > 0, 'question_answer writes selection to watched worker terminal');

  // 6. Watched worker finishes turn -> wakes Grok Bot with done + summary!
  received.length = 0;
  delete soloA.ask;
  now += 1000;
  soloA.status = 'done';
  soloA.task = { name: 'Combat loop', summary: '60 Hz fixed timestep shipped with tests' };
  survive.floor.team.onWorker(soloA);
  await waitForWebhookCount(1);

  assert.equal(received.length, 1);
  assert.equal(received[0].event, 'done');
  assert.match(received[0].summary, /60 Hz fixed timestep shipped with tests/);
  assert.match(received[0].items[0].actionHint, /Watched floor worker finished its turn/);

  // 7. Watched worker opens a PR and then merges it -> wakes Grok Bot with `pr` events!
  received.length = 0;
  now += 1000;
  const prUrl = 'https://github.com/nikships/survive/pull/77';
  soloA.pr = { number: 77, url: prUrl };
  survive.floor.team.onPullState(soloA, { number: 77, url: prUrl, title: 'feat: 60 Hz combat loop', state: 'open' });
  await waitForWebhookCount(1);
  assert.equal(received.length, 1);
  assert.equal(received[0].event, 'pr');
  assert.match(received[0].summary, /PR: Opened PR #77: feat: 60 Hz combat loop/);
  assert.equal(received[0].items[0].prUrl, prUrl);

  received.length = 0;
  now += 1000;
  const beforeMergeCursor = `team:survive:${survive.floor.team.latest()}`;
  const waitSubscribed = new Promise<void>((resolve) => {
    const origSubscribe = survive.floor.team.subscribe.bind(survive.floor.team);
    survive.floor.team.subscribe = (fn) => {
      survive.floor.team.subscribe = origSubscribe;
      const unsub = origSubscribe(fn);
      resolve();
      return unsub;
    };
  });
  const waitPr = callGrok('team_wait', { floor: 'survive', until: ['pr'], since: beforeMergeCursor, timeoutSec: 5 });
  await waitSubscribed;
  survive.floor.team.onPullState(soloA, { number: 77, url: prUrl, title: 'feat: 60 Hz combat loop', state: 'merged' });
  const waitedPr = await waitPr;
  assert.equal(waitedPr.isError, false, waitedPr.text);
  assert.match(waitedPr.text, /Merged PR #77/);
  await waitForWebhookCount(1);
  assert.equal(received.length, 1);
  assert.equal(received[0].event, 'pr');
  assert.match(received[0].summary, /PR: Merged PR #77: feat: 60 Hz combat loop/);

  // team_watch with all: true adopts all remaining independent workers on Orca.
  const watchAllOrca = await callGrok('team_watch', { floor: 'orca', all: true });
  assert.equal(watchAllOrca.isError, false, watchAllOrca.text);
  assert.equal((watchAllOrca.body.watching as unknown[]).length, 2);

  // Edge cases: initialScan silently seeds historical PRs; fast-merged PR created after worker creation still fires; watched departure wakes lead with `left`.
  received.length = 0;
  orca.floor.team.onPullState(orcaA, { number: 12, url: 'https://github.com/nikships/orca/pull/12', title: 'old pr', state: 'merged', createdAt: 500 }, { initialScan: true });
  orca.floor.team.onPullState(orcaA, { number: 99, url: 'https://github.com/nikships/orca/pull/99', title: 'fast merge', state: 'merged', createdAt: orcaA.createdAt + 10 });
  await waitForWebhookCount(1);
  assert.equal(received.length, 1, 'initialScan PR is silent, live worker-created fast-merged PR fires');
  assert.match(received[0].summary, /Merged PR #99: fast merge/);

  received.length = 0;
  orca.people.delete(orcaB.id);
  orca.floor.team.onWorkerGone(orcaB.id);
  await waitForWebhookCount(1);
  assert.equal(received.length, 1, 'watched worker departure wakes Grok Bot');
  assert.equal(received[0].event, 'left');
  assert.equal(orca.floor.team.isWatching(grok.worker.id, orcaB.id), false, 'gone worker removed from watched set');

  const notFoundWatch = await callGrok('team_watch', { floor: 'orca', workers: ['Sprocket', 'GhostWorker'] });
  assert.equal(notFoundWatch.isError, false);
  assert.match(notFoundWatch.text, /Sprocket \(orca\): watching[\s\S]*No worker called GhostWorker on Orca/);
  assert.deepEqual(
    (notFoundWatch.body.results as Array<{ watching?: boolean; error?: string }>).map((r) => [r.watching, Boolean(r.error)]),
    [
      [true, false],
      [undefined, true],
    ],
  );

  // Floor peers can watch and inspect independent workers read-only, while direct messaging stays gated to building agents / visit_request.
  survive.tokens.set(soloB.id, 'tok-solo-b');
  const peerClient = new Client({ name: 'peer-watch-test', version: '1' });
  t.after(() => peerClient.close());
  await peerClient.connect(
    new StreamableHTTPClientTransport(localUrl, {
      requestInit: { headers: { Authorization: 'Bearer tok-solo-b', 'x-droid-office-worker-id': soloB.id } },
    }),
  );
  const peerWatch = await peerClient.callTool({ name: 'team_watch', arguments: { worker: 'Pixel' } });
  assert.equal(peerWatch.isError !== true, true);
  const peerMsg = await peerClient.callTool({ name: 'team_message', arguments: { worker: 'Pixel', text: 'hey' } });
  assert.equal(peerMsg.isError, true, 'floor peer cannot directly inject prompts into watched independent worker');
  assert.match((peerMsg.content as { text?: string }[])[0]?.text ?? '', /independent floor worker: floor peers can watch and inspect it/);
  await peerClient.callTool({ name: 'team_watch', arguments: { worker: 'Pixel', watch: false } });

  // 8. Persist & restore preserves watched workers and pullStates across office restart.
  const restarted = new Team({ ...survive.floor.workers, get: (wid) => survive.people.get(wid) ?? store.identity(wid), buildingAgent: (wid) => Boolean(store.identity(wid)) } as TeamWorkers, {
    dataDir: surviveDir,
    dir: surviveDir,
    floorId: 'survive',
    floorName: 'Survive',
    git: true,
    baseBranch: () => 'main',
    checkoutBranch: () => 'main',
    settings: () => settings,
    toast() {},
    now: () => now,
  });
  t.after(() => restarted.stop());
  assert.equal(restarted.isWatching(grok.worker.id, soloA.id), true);

  // 9. Unwatching stops future events.
  received.length = 0;
  const unwatchRes = await callGrok('team_watch', { floor: 'survive', worker: 'Pixel', watch: false });
  assert.equal(unwatchRes.isError, false, unwatchRes.text);
  assert.match(unwatchRes.text, /stopped watching/);
  now += 1000;
  soloA.status = 'exited';
  survive.floor.team.onWorker(soloA);
  await delay(60);
  assert.equal(received.length, 0, 'unwatched worker no longer wakes Grok Bot');
});

test('real multi-floor office assigns globally unique names and desks across live workers', { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'unique-live-workers-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'glab'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prevPath ?? ''}`;
  let office: Awaited<ReturnType<typeof startServer>> | undefined;
  let ws: WebSocket | undefined;
  t.after(async () => {
    process.env.PATH = prevPath;
    try {
      ws?.terminate();
      if (office) {
        const closed = once(office.server, 'close');
        await office.shutdown();
        office.server.closeAllConnections();
        await closed;
        await delay(100);
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  // Stub agent script: answers setup/label probes immediately and stays alive for interactive PTY workers.
  const fakeAgent = path.join(root, 'fake-droid.js');
  writeFileSync(
    fakeAgent,
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      "if (args[0] === '--version') { console.log('0.249.0'); process.exit(0); }",
      'if (args[0] === \'doctor\') { console.log(\'{"ok":true,"results":[{"id":"auth.verify","status":"pass","detail":"ok"}]}\'); process.exit(0); }',
      "if (args.includes('--output-format')) process.exit(0);",
      'setInterval(() => {}, 10_000);',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const alphaDir = path.join(root, 'alpha');
  const betaDir = path.join(root, 'beta');
  const homeDir = path.join(root, 'home');
  mkdirSync(homeDir, { recursive: true });
  for (const repoDir of [alphaDir, betaDir]) {
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    writeFileSync(path.join(repoDir, 'index.txt'), 'hello\n');
    execFileSync('git', ['add', 'index.txt'], { cwd: repoDir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repoDir });
  }

  const cfg = loadConfig([alphaDir, '--home', homeDir, '--projects', root, '--agent', fakeAgent, '--weather', 'clear', '--host', '127.0.0.1']);
  cfg.port = 0;
  cfg.remoteMcp = false;
  office = await startServer(cfg);

  const firstFloor = office.owner.floors()[0];
  const wsUrl = `ws://127.0.0.1:${(office.server.address() as AddressInfo).port}/ws?name=Owner&floor=${firstFloor.id}`;
  ws = new WebSocket(wsUrl, { origin: wsUrl.replace('ws:', 'http:').split('/ws')[0] });
  await once(ws, 'open');

  const betaAdded = new Promise<void>((resolve) =>
    ws!.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMsg;
      if (msg.t === 'floor.added' && msg.dir === betaDir) resolve();
    }),
  );
  ws.send(JSON.stringify({ t: 'floor.add', dir: betaDir }));
  await betaAdded;

  const alphaFloor = office.owner.floors().find((f) => f.name === 'alpha')!;
  const betaFloor = office.owner.floors().find((f) => f.name === 'beta')!;
  assert.ok(alphaFloor && betaFloor);

  const grok = makeWorker('remote-grok', 'GrokBot', { remote: true, deskId: '' });
  // Spawn live agents on alpha and beta with AUTO_DESK: alpha gets Pixel on desk-1, so beta skips both and gets Byte on desk-2!
  const spawnAlpha = await office.owner.act(grok, { t: 'worker.spawn', deskId: 'auto', kind: 'agent' }, { floor: alphaFloor.id, owner: true });
  assert.equal(spawnAlpha.error, undefined, JSON.stringify(spawnAlpha));
  const spawnBeta = await office.owner.act(grok, { t: 'worker.spawn', deskId: 'auto', kind: 'agent' }, { floor: betaFloor.id, owner: true });
  assert.equal(spawnBeta.error, undefined, JSON.stringify(spawnBeta));
  await delay(150);

  const wAlpha = office.owner
    .floors()
    .find((f) => f.id === alphaFloor.id)!
    .workers.find((w) => w.id === spawnAlpha.workerId)!;
  const wBeta = office.owner
    .floors()
    .find((f) => f.id === betaFloor.id)!
    .workers.find((w) => w.id === spawnBeta.workerId)!;
  assert.equal(wAlpha.name, 'Pixel');
  assert.equal(wBeta.name, 'Byte');
  assert.notEqual(wAlpha.deskId, wBeta.deskId, 'live workers on different floors get distinct desks');
  assert.ok(DESKS.some((d) => d.id === wAlpha.deskId));
  assert.ok(DESKS.some((d) => d.id === wBeta.deskId));

  // Explicit office_roster call across both floors sees both workers on shared checkouts on main (each sole writer on its own floor -> on_main_branch warning only, no false cross-floor shared_tree).
  const fullRoster = roster(office.owner.floors(), grok.id);
  assert.equal(fullRoster.length, 2);
  assert.equal(fullRoster[0].branch, 'main');
  assert.equal(fullRoster[1].branch, 'main');
  assert.notEqual(fullRoster[0].cwd, fullRoster[1].cwd);
  assert.ok(fullRoster[0].warnings?.some((msg) => msg.includes('On main')));
  assert.ok(!fullRoster[0].warnings?.some((msg) => msg.includes('Shares working tree')));

  // A desk picked by hand on beta is beta's, even while alpha's live worker sits at the same desk id.
  const picked = await office.owner.act(grok, { t: 'worker.spawn', deskId: wAlpha.deskId, kind: 'agent' }, { floor: betaFloor.id, owner: true });
  assert.equal(picked.error, undefined, JSON.stringify(picked));
  const betaWorkers = () => office!.owner.floors().find((f) => f.id === betaFloor.id)!.workers;
  const wPicked = betaWorkers().find((w) => w.id === picked.workerId)!;
  assert.equal(wPicked.deskId, wAlpha.deskId, 'the hand-picked desk is honored');
  assert.ok(!['Pixel', 'Byte'].includes(wPicked.name), 'names stay unique across floors');

  // Picking it again on the same floor is still refused: it is taken there now.
  const again = await office.owner.act(grok, { t: 'worker.spawn', deskId: wAlpha.deskId, kind: 'shell' }, { floor: betaFloor.id, owner: true });
  assert.equal(again.error, 'That desk is taken');

  // An automatic seat on alpha still skips desks live on beta (desk-1 Pixel here, desk-2 Byte there) and takes desk-3.
  const auto = await office.owner.act(grok, { t: 'worker.spawn', deskId: 'auto', kind: 'agent' }, { floor: alphaFloor.id, owner: true });
  assert.equal(auto.error, undefined, JSON.stringify(auto));
  const wAuto = office.owner
    .floors()
    .find((f) => f.id === alphaFloor.id)!
    .workers.find((w) => w.id === auto.workerId)!;
  assert.equal(wAuto.deskId, DESKS.find((d) => ![wAlpha.deskId, wBeta.deskId].includes(d.id))!.id);
  assert.equal(new Set([wAlpha.name, wBeta.name, wPicked.name, wAuto.name]).size, 4, 'every live name is unique across floors');
});

test('roster helper preserves backwards-compatible worktree shape while adding cwd, branch and warnings', () => {
  const floors: OwnerFloor[] = [
    {
      id: 'f1',
      name: 'survive',
      dir: '/tmp/fake-survive',
      branch: 'main',
      baseBranch: 'main',
      watchedBy: (lead, wid) => lead === 'grok' && wid === 'w1',
      workers: [makeWorker('w1', 'Pixel', { deskId: 'desk-1', status: 'working' }), makeWorker('w2', 'Nova', { deskId: 'desk-2', status: 'working' })],
    },
  ];
  const out = roster(floors, 'grok');
  assert.equal(out[0].watching, true);
  assert.equal(out[0].cwd, path.resolve('/tmp/fake-survive'));
  assert.equal(out[0].branch, 'main');
  assert.equal(out[0].sharedCheckout, true);
  assert.equal(out[0].warnings?.length, 2);
});
