import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Answers } from '../src/server/answers.js';
import type { GrokWebhookPayload } from '../src/server/grok-webhook.js';
import { createOfficeMcp, OFFICE_MCP_PATH, OFFICE_MCP_WORKER_HEADER, type OfficeMcpFloor } from '../src/server/office-mcp/index.js';
import type { OwnerFloor, OwnerOffice, OwnerReply } from '../src/server/office-mcp/owner.js';
import { WAIT_HOLD_MAX_SEC } from '../src/server/office-mcp/team-events.js';
import { remoteMcpListener } from '../src/server/remote-mcp-http.js';
import { RemoteOffice, type RemoteFloor } from '../src/server/remote-office.js';
import { RemoteWorkers } from '../src/server/remote-workers.js';
import { Team, type TeamWorkers } from '../src/server/team.js';
import { Visits } from '../src/server/visits.js';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import { DESKS } from '../src/shared/layout.js';
import { type ClientMsg, SUBAGENT_DEFAULTS, type SubagentSettings, type WorkerInfo } from '../src/shared/protocol.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };

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

function makeWorker(id: string, extra: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id,
    name: id,
    kind: 'agent',
    deskId: 'desk-1',
    color: '#55cc88',
    status: 'done',
    acked: true,
    createdBy: 'test',
    createdAt: 1,
    cols: 100,
    rows: 30,
    open: false,
    ...extra,
  };
}

async function listen(t: Cleanup, server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('overlapping webhook runs read payload-scoped office_inbox items, see acked status, and cannot cross-ack other runs', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-webhook-inbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings: SubagentSettings = { ...SUBAGENT_DEFAULTS };
  const store = new RemoteWorkers(dir);
  const deliveries: GrokWebhookPayload[] = [];
  const people = new Map<string, WorkerInfo>();
  let now = Date.parse('2026-11-12T10:00:00Z');
  let seq = 0;

  const workers: TeamWorkers & RemoteFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id) ?? store.identity(id),
    authenticate: (id, token) => (token === `tok-${id}` ? people.get(id) : undefined),
    releaseLead: () => {},
    officeDefault: undefined,
    deskOccupied: (desk) => [...people.values()].some((w) => w.deskId === desk),
    hire: (deskId, _by, _prompt, _worktree, _choice, lead) => {
      const id = `sub-${++seq}`;
      const w = makeWorker(id, { name: seq === 1 ? 'Pixel' : 'Byte', deskId, lead, status: 'working', createdAt: now + seq });
      people.set(id, w);
      return w;
    },
    prompt: () => undefined,
    resume: () => undefined,
    kill: async (id) => {
      people.delete(id);
      return {};
    },
    tail: () => '',
    setTask(id, task) {
      const w = people.get(id);
      if (w) w.task = task;
    },
  };

  const team = new Team(workers, { dataDir: dir, dir, git: false, settings: () => settings, toast() {}, now: () => now });
  const visits = new Visits({ ...workers, tell: () => undefined, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => settings.visits, emit() {}, now: () => now });
  const whiteboard = new WhiteboardStore(dir);
  t.after(() => {
    team.stop();
    visits.stop();
    whiteboard.stop();
  });

  const floor: RemoteFloor = { id: 'alpha', def: { name: 'Alpha' }, dir, workers, team, visits, whiteboard };
  const office = new RemoteOffice(store, () => [floor], {
    webhookDelayMs: 10,
    now: () => now,
    fetchImpl: async (_url, init) => {
      deliveries.push(JSON.parse(String(init?.body)) as GrokWebhookPayload);
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  t.after(() => office.stop());

  // Use a short custom webhook token overlapping "whk" to verify PROTOCOL_FIELDS protects deliveryId and ackIds.
  const grok = office.add('grokbot', { webhookUrl: 'https://hooks.example.test/grok', webhookToken: 'whk-secret' });
  const hostname = 'office.example.ts.net';
  const localFloor: OfficeMcpFloor = { ...floor, name: floor.def.name };
  const localMcp = createOfficeMcp({
    answers: new Answers(),
    remote: office,
    floor: (id) => (people.has(id) ? localFloor : undefined),
    settings: () => settings,
  });
  const localOrigin = await listen(
    t,
    createServer((req, res) => void localMcp.handle(req, res)),
  );
  const remoteOrigin = await listen(
    t,
    remoteMcpListener({
      answers: new Answers(),
      remote: office,
      remoteTransport: { hostname: () => hostname, owner: () => undefined },
      floor: (id) => (people.has(id) ? localFloor : undefined),
      settings: () => settings,
    }),
  );

  const botClient = new Client({ name: 'grok-lead', version: '1.0.0' });
  t.after(() => botClient.close());
  await botClient.connect(
    new StreamableHTTPClientTransport(new URL(OFFICE_MCP_PATH, remoteOrigin), {
      fetch: proxyFetch,
      requestInit: { headers: { host: `${hostname}:8443`, Authorization: `Bearer ${grok.token}` } },
    }),
  );

  const callBot = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await botClient.callTool({ name, arguments: args });
    return {
      isError: res.isError === true,
      text: (res.content as { text?: string }[]).map((c) => c.text ?? '').join('\n'),
      body: (res.structuredContent ?? {}) as Record<string, any>,
    };
  };

  await callBot('team_hire', { floor: 'alpha', title: 'Task A', brief: 'Finish A', worktree: false });
  await callBot('team_hire', { floor: 'alpha', title: 'Task B', brief: 'Finish B', worktree: false });

  const connectSub = async (id: string) => {
    const c = new Client({ name: id, version: '1.0.0' });
    t.after(() => c.close());
    await c.connect(
      new StreamableHTTPClientTransport(new URL(OFFICE_MCP_PATH, localOrigin), {
        requestInit: { headers: { [OFFICE_MCP_WORKER_HEADER]: id, Authorization: `Bearer tok-${id}` } },
      }),
    );
    return c;
  };

  const sub1 = await connectSub('sub-1');
  const sub2 = await connectSub('sub-2');

  // Webhook delivery #1: Pixel's final report.
  await sub1.callTool({ name: 'team_report', arguments: { text: 'Task A finished cleanly.' } });
  assert.equal(deliveries.length, 1);
  const post1 = deliveries[0];
  assert.match(String(post1.deliveryId), /^whk-[0-9a-f]{16}$/);
  assert.deepEqual(post1.ackIds, ['team:alpha:1']);

  // Webhook delivery #2: queued direct message + Byte's report in a concurrent batch.
  now += 1000;
  assert.equal(office.tell(grok.worker.id, 'Owner note: hold deploy until Friday.', 'alpha'), undefined);
  await sub2.callTool({ name: 'team_report', arguments: { text: 'Task B finished cleanly.' } });
  assert.equal(deliveries.length, 2);
  const post2 = deliveries[1];
  assert.match(String(post2.deliveryId), /^whk-[0-9a-f]{16}$/);
  assert.notEqual(post2.deliveryId, post1.deliveryId);
  assert.equal(post2.ackIds?.length, 2);
  assert.ok(post2.ackIds?.includes('team:alpha:2'));
  const directMsgId = post2.ackIds!.find((id) => !id.startsWith('team:'))!;
  assert.match(directMsgId, /^[0-9a-f]{24}$/);

  // Run #1 scopes its inbox read to post1.deliveryId and sees ONLY its own item.
  const run1View = await callBot('office_inbox', { deliveryId: post1.deliveryId });
  assert.equal(run1View.isError, false);
  assert.equal(run1View.body.filtered, true);
  assert.equal(run1View.body.remaining, 0);
  assert.deepEqual(
    run1View.body.messages.map((m: { id: string; acked?: boolean }) => ({ id: m.id, acked: m.acked })),
    [{ id: 'team:alpha:1', acked: false }],
  );

  // Run #1 attempts to ack both its own item AND Run #2's items while scoped to post1.deliveryId:
  // Run #2's items are protected and returned in ignoredAck!
  const run1Ack = await callBot('office_inbox', {
    deliveryId: post1.deliveryId,
    ack: ['team:alpha:1', 'team:alpha:2', directMsgId],
  });
  assert.equal(run1Ack.isError, false);
  assert.deepEqual(run1Ack.body.ignoredAck, ['team:alpha:2', directMsgId]);
  assert.deepEqual(
    run1Ack.body.messages.map((m: { id: string; acked?: boolean }) => ({ id: m.id, acked: m.acked })),
    [{ id: 'team:alpha:1', acked: true }],
  );
  assert.equal(run1Ack.body.remaining, 0);

  // If Run #1 retries or another overlapping reader checks post1.ackIds, team:alpha:1 still appears with acked: true.
  const replay1 = await callBot('office_inbox', { ids: post1.ackIds });
  assert.equal(replay1.isError, false);
  assert.deepEqual(
    replay1.body.messages.map((m: { id: string; acked?: boolean }) => ({ id: m.id, acked: m.acked })),
    [{ id: 'team:alpha:1', acked: true }],
  );
  assert.equal(replay1.body.remaining, 0);

  // Run #2 still sees both of its items unacknowledged (and limit: 1 reports remaining: 1)!
  const run2Paged = await callBot('office_inbox', { ids: post2.ackIds, limit: 1 });
  assert.equal(run2Paged.body.remaining, 1);
  const run2View = await callBot('office_inbox', { ids: post2.ackIds });
  assert.equal(run2View.isError, false);
  assert.equal(run2View.body.remaining, 0);
  assert.deepEqual(
    run2View.body.messages.map((m: { id: string; acked?: boolean }) => ({ id: m.id, acked: m.acked })),
    [
      { id: 'team:alpha:2', acked: false },
      { id: directMsgId, acked: false },
    ],
  );

  // Run #2 acknowledges its whole delivery via deliveryId in ack; subsequent scoped read shows acked: true for both.
  const run2Ack = await callBot('office_inbox', { ids: post2.ackIds, ack: [post2.deliveryId] });
  assert.equal(run2Ack.isError, false);
  assert.equal(run2Ack.body.remaining, 0);
  assert.deepEqual(
    run2Ack.body.messages.map((m: { id: string; acked?: boolean }) => ({ id: m.id, acked: m.acked })),
    [
      { id: 'team:alpha:2', acked: true },
      { id: directMsgId, acked: true },
    ],
  );

  // Unfiltered inbox is now completely empty.
  const unfiltered = await callBot('office_inbox', {});
  assert.deepEqual(unfiltered.body.messages, []);
  assert.equal(unfiltered.body.remaining, 0);

  // Missing ids and unknown deliveryIds surface explicit signals/errors.
  const missing = await callBot('office_inbox', { ids: ['msg-does-not-exist', 'team:alpha:999'] });
  assert.equal(missing.isError, false);
  assert.deepEqual(missing.body.missingIds, ['msg-does-not-exist', 'team:alpha:999']);

  const badDelivery = await callBot('office_inbox', { deliveryId: 'whk-0000000000000000' });
  assert.equal(badDelivery.isError, true);
  assert.equal(badDelivery.body.code, 'unknown_delivery');

  const badAckDelivery = await callBot('office_inbox', { ack: ['whk-0000000000000000'] });
  assert.equal(badAckDelivery.isError, true);
  assert.equal(badAckDelivery.body.code, 'unknown_delivery');

  // Test pings carry no deliveryId or ackIds.
  await office.testWebhook(grok.worker.id);
  const testPing = deliveries.at(-1)!;
  assert.equal(testPing.test, true);
  assert.equal(testPing.deliveryId, undefined);
  assert.equal(testPing.ackIds, undefined);
});

test('worker_diff and team_review succeed after worker dismissal across kept worktrees, pruned worktrees with kept branches, restarts, and remote leads', async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-dismissed-review-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', '--local', 'user.name', 'droid-office-tests');
  git(dir, 'config', '--local', 'user.email', 'tests@droid-office.local');
  const commit = (cwd: string, file: string, body: string) => {
    writeFileSync(path.join(cwd, file), body);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-qm', `Update ${file}`);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const base = commit(dir, 'README.md', '# Base\n');
  writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '.droid-office/\n');
  const dataDir = path.join(dir, '.droid-office');
  mkdirSync(dataDir, { recursive: true });

  const settings: SubagentSettings = { ...SUBAGENT_DEFAULTS };
  const store = new RemoteWorkers(dataDir);
  const people = new Map<string, WorkerInfo>([['lead', makeWorker('lead', { name: 'Lead', deskId: DESKS[0].id })]]);
  let hiredCount = 0;

  const workers: TeamWorkers & OfficeMcpFloor['workers'] & RemoteFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id) ?? store.identity(id),
    authenticate: (id, token) => (token === `tok-${id}` ? people.get(id) : undefined),
    releaseLead: () => {},
    officeDefault: undefined,
    deskOccupied: (desk) => [...people.values()].some((w) => w.deskId === desk),
    hire: (deskId, _by, _prompt, worktree, _choice, lead, _from, branchName) => {
      const id = `sub-${++hiredCount}`;
      const name = hiredCount === 1 ? 'Pixel' : hiredCount === 2 ? 'Sprocket' : hiredCount === 3 ? 'Plain' : 'Dupe';
      let wt: WorkerInfo['worktree'];
      if (worktree) {
        const wtPath = path.join(dataDir, 'worktrees', id);
        const branch = branchName ?? `office/${id}`;
        git(dir, 'worktree', 'add', '-q', '-b', branch, wtPath, base);
        wt = { path: wtPath, branch, base };
      }
      const w = makeWorker(id, { name, deskId, lead, status: 'done', createdAt: 10 + hiredCount, ...(wt ? { worktree: wt } : {}) });
      people.set(id, w);
      return w;
    },
    prompt: () => undefined,
    resume: () => undefined,
    kill: async (id) => {
      people.delete(id);
      team.onWorkerGone(id);
      return {};
    },
    dismiss: async (id, pruneWorktree, keepBranch) => {
      const w = people.get(id);
      if (w?.worktree && pruneWorktree) {
        git(dir, 'worktree', 'remove', w.worktree.path);
        if (!keepBranch) git(dir, 'branch', '-d', w.worktree.branch);
      }
      people.delete(id);
      team.onWorkerGone(id);
      return {};
    },
    tail: () => '',
    setTask(id, task) {
      const w = people.get(id);
      if (w) w.task = task;
    },
  };

  let team = new Team(workers, { dataDir, dir, git: true, settings: () => settings, toast() {} });
  const visits = new Visits({ ...workers, tell: () => undefined, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => settings.visits, emit() {} });
  const whiteboard = new WhiteboardStore(dataDir);
  t.after(() => {
    team.stop();
    visits.stop();
    whiteboard.stop();
  });

  const makeFloor = (): OfficeMcpFloor & RemoteFloor => ({ id: 'repo', name: 'Repo', def: { name: 'Repo' }, dir, workers, team, visits, whiteboard });
  const office = new RemoteOffice(store, () => [makeFloor()]);
  t.after(() => office.stop());
  const remoteBot = office.add('Grok');
  const hostname = 'office.example.ts.net';

  const localMcp = createOfficeMcp({
    answers: new Answers(),
    remote: office,
    floor: (id) => (people.has(id) ? makeFloor() : undefined),
    settings: () => settings,
  });
  const localOrigin = await listen(
    t,
    createServer((req, res) => void localMcp.handle(req, res)),
  );
  const remoteOrigin = await listen(
    t,
    remoteMcpListener({
      answers: new Answers(),
      remote: office,
      remoteTransport: { hostname: () => hostname, owner: () => undefined },
      floor: (id) => (people.has(id) ? makeFloor() : undefined),
      settings: () => settings,
    }),
  );

  const connectLocal = async (id: string) => {
    const c = new Client({ name: id, version: '1.0.0' });
    t.after(() => c.close());
    await c.connect(
      new StreamableHTTPClientTransport(new URL(OFFICE_MCP_PATH, localOrigin), {
        requestInit: { headers: { [OFFICE_MCP_WORKER_HEADER]: id, Authorization: `Bearer tok-${id}` } },
      }),
    );
    return c;
  };
  const leadClient = await connectLocal('lead');
  const botClient = new Client({ name: 'grok', version: '1.0.0' });
  t.after(() => botClient.close());
  await botClient.connect(
    new StreamableHTTPClientTransport(new URL(OFFICE_MCP_PATH, remoteOrigin), {
      fetch: proxyFetch,
      requestInit: { headers: { host: `${hostname}:8443`, Authorization: `Bearer ${remoteBot.token}` } },
    }),
  );

  // 1. Floor lead hires Pixel, Pixel commits and reports, then lead dismisses Pixel (worktree kept).
  await leadClient.callTool({ name: 'team_hire', arguments: { title: 'Add auth', brief: 'Implement auth.ts' } });
  const pixel = people.get('sub-1')!;
  commit(pixel.worktree!.path, 'auth.ts', 'export const ok = true;\n');
  const pixelClient = await connectLocal('sub-1');
  await pixelClient.callTool({ name: 'team_report', arguments: { text: 'Added auth.ts and verified tests.' } });
  const dismissed = await leadClient.callTool({ name: 'team_dismiss', arguments: { worker: 'Pixel' } });
  assert.equal(dismissed.isError, undefined);
  assert.equal(people.has('sub-1'), false);

  // Post-dismissal worker_diff and team_review succeed!
  const diffAfter = await leadClient.callTool({ name: 'worker_diff', arguments: { worker: 'Pixel' } });
  assert.equal(diffAfter.isError, undefined);
  assert.match(String((diffAfter.structuredContent as Record<string, unknown>).diff), /\+export const ok = true;/);

  const reviewApprove = await leadClient.callTool({
    name: 'team_review',
    arguments: { worker: 'Pixel', verdict: 'approve', notes: 'Clean diff after dismissal.' },
  });
  assert.equal(reviewApprove.isError, undefined);
  assert.equal((reviewApprove.structuredContent as Record<string, any>).notified, false);

  const reportGet = await leadClient.callTool({ name: 'team_report_get', arguments: { worker: 'sub-1' } });
  assert.equal((reportGet.structuredContent as Record<string, any>).report.review.verdict, 'approve');

  // request_changes on a dismissed worker records the review cleanly with notifyNote rather than failing.
  const reviewChanges = await leadClient.callTool({
    name: 'team_review',
    arguments: { worker: 'Pixel', verdict: 'request_changes', notes: 'Need edge-case check.' },
  });
  assert.equal(reviewChanges.isError, undefined);
  assert.equal((reviewChanges.structuredContent as Record<string, any>).notified, false);
  assert.match(String((reviewChanges.structuredContent as Record<string, any>).notifyNote), /already sent home/);

  // 2. Remote building lead hires Sprocket, Sprocket commits & reports, remote lead dismisses with pruneWorktree: true (branch kept!).
  await botClient.callTool({ name: 'team_hire', arguments: { floor: 'repo', title: 'Add metrics', brief: 'Implement metrics.ts' } });
  const sprocket = people.get('sub-2')!;
  commit(sprocket.worktree!.path, 'metrics.ts', 'export const count = 42;\n');
  const sprocketClient = await connectLocal('sub-2');
  await sprocketClient.callTool({ name: 'team_report', arguments: { text: 'Committed metrics.ts.' } });

  const prunedDismiss = await botClient.callTool({
    name: 'team_dismiss',
    arguments: { worker: 'Sprocket', pruneWorktree: true, keepBranch: true },
  });
  assert.equal(prunedDismiss.isError, undefined);

  // Restart Team from disk: both Pixel (kept worktree) and Sprocket (pruned worktree, kept branch) still diff & review!
  team.stop();
  team = new Team(workers, { dataDir, dir, git: true, settings: () => settings, toast() {} });

  const restartedPixelDiff = await leadClient.callTool({ name: 'worker_diff', arguments: { worker: 'Pixel' } });
  assert.equal(restartedPixelDiff.isError, undefined);
  assert.match(String((restartedPixelDiff.structuredContent as Record<string, unknown>).diff), /\+export const ok = true;/);

  const remotePrunedDiff = await botClient.callTool({ name: 'worker_diff', arguments: { worker: 'Sprocket' } });
  assert.equal(remotePrunedDiff.isError, undefined);
  assert.match(String((remotePrunedDiff.structuredContent as Record<string, unknown>).diff), /\+export const count = 42;/);

  const remoteCommitsDiff = await botClient.callTool({ name: 'worker_diff', arguments: { worker: 'Sprocket', commits: 1 } });
  assert.equal(remoteCommitsDiff.isError, undefined);
  assert.match(String((remoteCommitsDiff.structuredContent as Record<string, unknown>).diff), /\+export const count = 42;/);

  const remoteReview = await botClient.callTool({
    name: 'team_review',
    arguments: { worker: 'Sprocket', verdict: 'approve', notes: 'Approved from kept branch.' },
  });
  assert.equal(remoteReview.isError, undefined);

  // Once the kept branch is also deleted, worker_diff fails with a clear message.
  git(dir, 'branch', '-D', sprocket.worktree!.branch);
  const missingBranchDiff = await botClient.callTool({ name: 'worker_diff', arguments: { worker: 'Sprocket' } });
  assert.equal(missingBranchDiff.isError, true);
  assert.match(JSON.stringify(missingBranchDiff.content), /worktree and branch .* were removed/);

  // 3. A dismissed subagent that ran without an isolated worktree refuses worker_diff instead of diffing the shared checkout.
  await leadClient.callTool({ name: 'team_hire', arguments: { title: 'Read-only check', brief: 'Inspect README', worktree: false } });
  await leadClient.callTool({ name: 'team_dismiss', arguments: { worker: 'Plain' } });
  writeFileSync(path.join(dir, 'README.md'), '# Dirty shared checkout\n');
  const sharedRefused = await leadClient.callTool({ name: 'worker_diff', arguments: { worker: 'Plain' } });
  assert.equal(sharedRefused.isError, true);
  assert.match(JSON.stringify(sharedRefused.content), /no isolated worktree/);

  // 4. Two dismissed subagents with the same name (including one sent home directly via owner kill) require worker id, while each exact id works.
  await leadClient.callTool({ name: 'team_hire', arguments: { title: 'Dupe 1', brief: 'One' } });
  people.get('sub-4')!.name = 'Dupe';
  await workers.kill('sub-4');
  await leadClient.callTool({ name: 'team_hire', arguments: { title: 'Dupe 2', brief: 'Two' } });
  people.get('sub-5')!.name = 'Dupe';
  await leadClient.callTool({ name: 'team_dismiss', arguments: { worker: 'sub-5' } });
  const dupeByName = await leadClient.callTool({ name: 'worker_diff', arguments: { worker: 'Dupe' } });
  assert.equal(dupeByName.isError, true);
  assert.match(JSON.stringify(dupeByName.content), /more than one former subagent/);
  assert.equal((await leadClient.callTool({ name: 'worker_diff', arguments: { worker: 'sub-4' } })).isError, undefined);
});

test('team_wait caps single-call hold under MCP client timeouts instead of failing with -32001 and continues cleanly via cursor', async (t) => {
  assert.equal(WAIT_HOLD_MAX_SEC, 90, 'default hold cap stays well below ~120-240s HTTP and MCP client timeouts');
  const dir = mkdtempSync(path.join(tmpdir(), 'office-wait-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings: SubagentSettings = { ...SUBAGENT_DEFAULTS, wakeLead: false };
  const people = new Map<string, WorkerInfo>([
    ['lead', makeWorker('lead', { name: 'Lead' })],
    ['sub-1', makeWorker('sub-1', { name: 'Pixel', lead: 'lead', status: 'working', deskId: 'desk-2' })],
  ]);
  const workers: TeamWorkers & OfficeMcpFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    authenticate: (id, token) => (token === `tok-${id}` ? people.get(id) : undefined),
    officeDefault: undefined,
    deskOccupied: () => false,
    hire: () => 'unused',
    prompt: () => undefined,
    resume: () => undefined,
    kill: async () => ({}),
    tail: () => '',
    setTask() {},
  };
  const team = new Team(workers, { dataDir: dir, dir, git: false, settings: () => settings, toast() {} });
  const visits = new Visits({ ...workers, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => false, emit() {} });
  const whiteboard = new WhiteboardStore(dir);
  t.after(() => {
    team.stop();
    visits.stop();
    whiteboard.stop();
  });

  const floor: OfficeMcpFloor = { id: 'floor', name: 'Floor', dir, workers, team, visits, whiteboard };
  // Configure a 60ms server hold cap while the client sets a 400ms request timeout and passes timeoutSec: 240!
  const mcp = createOfficeMcp({
    answers: new Answers(),
    settings: () => settings,
    floor: (id) => (people.has(id) ? floor : undefined),
    waitHoldMaxMs: 60,
  });
  const origin = await listen(
    t,
    createServer((req, res) => void mcp.handle(req, res)),
  );

  const lead = new Client({ name: 'lead', version: '1.0.0' });
  const sub = new Client({ name: 'sub', version: '1.0.0' });
  t.after(async () => {
    await Promise.all([lead.close(), sub.close()]);
  });
  await lead.connect(
    new StreamableHTTPClientTransport(new URL(OFFICE_MCP_PATH, origin), {
      requestInit: { headers: { [OFFICE_MCP_WORKER_HEADER]: 'lead', Authorization: 'Bearer tok-lead' } },
    }),
  );
  await sub.connect(
    new StreamableHTTPClientTransport(new URL(OFFICE_MCP_PATH, origin), {
      requestInit: { headers: { [OFFICE_MCP_WORKER_HEADER]: 'sub-1', Authorization: 'Bearer tok-sub-1' } },
    }),
  );

  const first = await lead.callTool({ name: 'team_wait', arguments: { timeoutSec: 240 } }, { timeout: 400 });
  assert.equal(first.isError, undefined);
  const firstBody = first.structuredContent as Record<string, any>;
  assert.equal(firstBody.matched, false);
  assert.equal(firstBody.reason, 'timeout');
  assert.equal(firstBody.capped, true);
  assert.equal(firstBody.cursor, 'team:floor:0');
  assert.match(JSON.stringify(first.content), /capped from 240 s/);

  // Continuing with `since: cursor` catches the subagent's report without missing anything.
  await sub.callTool({ name: 'team_report', arguments: { text: 'Done!' } });
  const second = await lead.callTool({ name: 'team_wait', arguments: { since: firstBody.cursor, timeoutSec: 240 } }, { timeout: 400 });
  assert.equal(second.isError, undefined);
  const secondBody = second.structuredContent as Record<string, any>;
  assert.equal(secondBody.matched, true);
  assert.equal(secondBody.reason, 'report');
  assert.equal(secondBody.capped, undefined);
  assert.equal(secondBody.events[0].id, 'team:floor:1');
  assert.equal(secondBody.cursor, 'team:floor:1');
});

test('worker-targeting MCP tools consistently accept worker, workerId, and name (plus prompt or text on office_worker_prompt)', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-param-aliases-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings: SubagentSettings = { ...SUBAGENT_DEFAULTS, visits: true };
  const store = new RemoteWorkers(dir);
  const pixel = makeWorker('w-pixel', { name: 'Pixel', deskId: DESKS[0].id, status: 'idle' });
  const nibble = makeWorker('w-nibble', { name: 'Nibble', deskId: DESKS[1].id, status: 'idle' });
  const people = new Map<string, WorkerInfo>([
    [pixel.id, pixel],
    [nibble.id, nibble],
  ]);
  const prompted: [string, string][] = [];
  const ownerCalls: ClientMsg[] = [];

  const workers: TeamWorkers & OfficeMcpFloor['workers'] & RemoteFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id) ?? store.identity(id),
    authenticate: (id, token) => (token === `tok-${id}` ? people.get(id) : undefined),
    releaseLead: () => {},
    officeDefault: undefined,
    deskOccupied: () => false,
    hire: () => 'unused',
    prompt: (id, msg) => {
      prompted.push([id, msg]);
      return undefined;
    },
    resume: () => undefined,
    kill: async () => ({}),
    tail: (id) => `screen of ${id}`,
    setTask() {},
  };

  const team = new Team(workers, { dataDir: dir, dir, git: false, settings: () => settings, toast() {} });
  const visits = new Visits({ ...workers, tell: workers.prompt, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => settings.visits, emit() {} });
  const whiteboard = new WhiteboardStore(dir);
  t.after(() => {
    team.stop();
    visits.stop();
    whiteboard.stop();
  });

  const floor: OfficeMcpFloor & RemoteFloor = { id: 'api', name: 'API', def: { name: 'API' }, dir, workers, team, visits, whiteboard };
  const office = new RemoteOffice(store, () => [floor]);
  t.after(() => office.stop());
  const grok = office.add('Grok');
  const hostname = 'office.example.ts.net';

  const ownerFloors: OwnerFloor[] = [{ id: 'api', name: 'API', workers: [...people.values()] }];
  const owner: OwnerOffice = {
    floors: () => ownerFloors,
    mission: () => [],
    tail: (id) => `tail:${id}`,
    act: async (_by, msg): Promise<OwnerReply> => {
      ownerCalls.push(msg);
      if (msg.t === 'thread.read') {
        return { notes: [], reply: { t: 'thread.snapshot', workerId: msg.workerId, entries: [], hasOlder: false } };
      }
      return { notes: [] };
    },
  };

  const remoteOrigin = await listen(
    t,
    remoteMcpListener({
      answers: new Answers(),
      owner,
      remote: office,
      remoteTransport: { hostname: () => hostname, owner: () => undefined },
      floor: (id) => (people.has(id) ? floor : undefined),
      settings: () => settings,
    }),
  );
  const localMcp = createOfficeMcp({
    answers: new Answers(),
    floor: (id) => (people.has(id) ? floor : undefined),
    settings: () => settings,
  });
  const localOrigin = await listen(
    t,
    createServer((req, res) => void localMcp.handle(req, res)),
  );

  const bot = new Client({ name: 'bot', version: '1.0.0' });
  const local = new Client({ name: 'pixel', version: '1.0.0' });
  t.after(async () => {
    await Promise.all([bot.close(), local.close()]);
  });
  await bot.connect(
    new StreamableHTTPClientTransport(new URL(OFFICE_MCP_PATH, remoteOrigin), {
      fetch: proxyFetch,
      requestInit: { headers: { host: `${hostname}:8443`, Authorization: `Bearer ${grok.token}` } },
    }),
  );
  await local.connect(
    new StreamableHTTPClientTransport(new URL(OFFICE_MCP_PATH, localOrigin), {
      requestInit: { headers: { [OFFICE_MCP_WORKER_HEADER]: pixel.id, Authorization: `Bearer tok-${pixel.id}` } },
    }),
  );

  // office_worker_prompt: accepts worker/workerId/name and text/prompt, emitting exact canonical ClientMsg.
  for (const args of [
    { worker: 'Pixel', text: 'Check CI' },
    { worker: 'w-pixel', prompt: 'Check CI' },
    { workerId: 'Pixel', text: 'Check CI' },
    { name: 'Pixel', text: 'Check CI' },
  ]) {
    const res = await bot.callTool({ name: 'office_worker_prompt', arguments: args });
    assert.equal(res.isError, undefined, JSON.stringify(res.content));
    assert.deepEqual(ownerCalls.at(-1), { t: 'worker.prompt', workerId: 'w-pixel', prompt: 'Check CI', queue: false });
  }

  // office_look and office_send_home: accept worker, workerId, and name.
  for (const target of [{ worker: 'Pixel' }, { workerId: 'w-pixel' }, { name: 'Pixel' }]) {
    const look = await bot.callTool({ name: 'office_look', arguments: target });
    assert.equal(look.isError, undefined);
    assert.match(JSON.stringify(look.content), /tail:w-pixel/);

    const sendHome = await bot.callTool({ name: 'office_send_home', arguments: target });
    assert.equal(sendHome.isError, undefined);
    assert.equal(ownerCalls.at(-1)?.t, 'worker.kill');
  }

  // office_worker_interrupt, office_worker_thread, and office_worker_answer (preserving typed answer text!).
  assert.equal((await bot.callTool({ name: 'office_worker_interrupt', arguments: { worker: 'Pixel' } })).isError, undefined);
  assert.deepEqual(ownerCalls.at(-1), { t: 'worker.interrupt', workerId: 'w-pixel' });

  assert.equal((await bot.callTool({ name: 'office_worker_thread', arguments: { name: 'Pixel' } })).isError, undefined);
  assert.equal(ownerCalls.at(-1)?.t, 'thread.read');

  const menu = { choices: [{ number: 1, label: 'Other' }], freeText: true };
  assert.equal((await bot.callTool({ name: 'office_worker_answer', arguments: { worker: 'Pixel', menu, text: 'Custom reply' } })).isError, undefined);
  assert.deepEqual(ownerCalls.at(-1), { t: 'worker.answer', workerId: 'w-pixel', menu, text: 'Custom reply' });

  // visit_look and visit_message: accept worker or name.
  assert.equal((await local.callTool({ name: 'visit_look', arguments: { worker: 'Nibble' } })).isError, undefined);
  assert.equal((await local.callTool({ name: 'visit_message', arguments: { worker: 'Nibble', kind: 'tell', text: 'Heads up' } })).isError, undefined);

  // Missing or conflicting aliases are rejected with bad_argument before reaching handlers.
  const countBefore = ownerCalls.length;
  for (const [tool, badArgs] of [
    ['office_worker_prompt', { worker: 'Pixel' }],
    ['office_worker_prompt', { text: 'Missing target' }],
    ['office_worker_prompt', { worker: 'Pixel', workerId: 'Nibble', text: 'Conflict' }],
    ['office_worker_prompt', { worker: 'Pixel', prompt: 'One', text: 'Two' }],
    ['office_look', {}],
    ['office_look', { worker: 'Pixel', name: 'Nibble' }],
    ['office_send_home', { workerId: 'w-pixel', name: 'Nibble' }],
    ['office_worker_interrupt', {}],
  ] as const) {
    const failed = await bot.callTool({ name: tool, arguments: badArgs });
    assert.equal(failed.isError, true, `${tool} ${JSON.stringify(badArgs)}`);
    assert.equal((failed.structuredContent as Record<string, unknown>)?.code, 'bad_argument');
  }
  assert.equal(ownerCalls.length, countBefore);

  assert.equal((await local.callTool({ name: 'visit_look', arguments: {} })).isError, true);
  assert.equal((await local.callTool({ name: 'visit_look', arguments: { worker: 'Nibble', name: 'Pixel' } })).isError, true);
});

test('team_hire structured task makes repo optional and works seamlessly on both non-git and git floors', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-hire-repo-optional-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plainDir = path.join(dir, 'plain');
  const gitDir = path.join(dir, 'git');
  mkdirSync(plainDir, { recursive: true });
  mkdirSync(gitDir, { recursive: true });

  const settings: SubagentSettings = { ...SUBAGENT_DEFAULTS };
  const store = new RemoteWorkers(dir);
  const plainPeople = new Map<string, WorkerInfo>([['plain-lead', makeWorker('plain-lead', { name: 'LeadPlain', deskId: DESKS[0].id })]]);
  const gitPeople = new Map<string, WorkerInfo>([['git-lead', makeWorker('git-lead', { name: 'LeadGit', deskId: DESKS[0].id })]]);
  const hires: Array<{ floor: string; prompt: string; worktree: boolean; branch?: string }> = [];
  let seq = 0;

  const makeFloor = (id: string, floorDir: string, isGit: boolean, people: Map<string, WorkerInfo>) => {
    const workers: TeamWorkers & OfficeMcpFloor['workers'] & RemoteFloor['workers'] = {
      list: () => [...people.values()],
      get: (wid) => people.get(wid) ?? store.identity(wid),
      authenticate: (wid, token) => (token === `tok-${wid}` ? people.get(wid) : undefined),
      releaseLead: () => {},
      officeDefault: undefined,
      deskOccupied: (desk) => [...people.values()].some((w) => w.deskId === desk),
      hire: (deskId, _by, prompt, worktree, _choice, lead, _from, branch) => {
        hires.push({ floor: id, prompt, worktree, branch });
        const wid = `hired-${++seq}`;
        const w = makeWorker(wid, {
          name: `Sub${seq}`,
          deskId,
          lead,
          status: 'working',
          ...(worktree ? { worktree: { path: `.droid-office/worktrees/${wid}`, branch: branch ?? `office/${wid}`, base: 'abc' } } : {}),
        });
        people.set(wid, w);
        return w;
      },
      prompt: () => undefined,
      resume: () => undefined,
      kill: async () => ({}),
      tail: () => '',
      setTask() {},
    };
    const team = new Team(workers, { dataDir: floorDir, dir: floorDir, git: isGit, settings: () => settings, toast() {} });
    const visits = new Visits({ ...workers, tell: () => undefined, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => false, emit() {} });
    const whiteboard = new WhiteboardStore(floorDir);
    t.after(() => {
      team.stop();
      visits.stop();
      whiteboard.stop();
    });
    return { id, name: id, def: { name: id }, dir: floorDir, workers, team, visits, whiteboard };
  };

  const plainFloor = makeFloor('plain', plainDir, false, plainPeople);
  const gitFloor = makeFloor('git', gitDir, true, gitPeople);
  const office = new RemoteOffice(store, () => [plainFloor, gitFloor]);
  t.after(() => office.stop());
  const botInfo = office.add('Grok');
  const hostname = 'office.example.ts.net';

  const localMcp = createOfficeMcp({
    answers: new Answers(),
    remote: office,
    floor: (id) => (plainPeople.has(id) ? plainFloor : gitPeople.has(id) ? gitFloor : undefined),
    settings: () => settings,
  });
  const localOrigin = await listen(
    t,
    createServer((req, res) => void localMcp.handle(req, res)),
  );
  const remoteOrigin = await listen(
    t,
    remoteMcpListener({
      answers: new Answers(),
      remote: office,
      remoteTransport: { hostname: () => hostname, owner: () => undefined },
      floor: (id) => (plainPeople.has(id) ? plainFloor : gitPeople.has(id) ? gitFloor : undefined),
      settings: () => settings,
    }),
  );

  const connectLocal = async (id: string) => {
    const c = new Client({ name: id, version: '1.0.0' });
    t.after(() => c.close());
    await c.connect(
      new StreamableHTTPClientTransport(new URL(OFFICE_MCP_PATH, localOrigin), {
        requestInit: { headers: { [OFFICE_MCP_WORKER_HEADER]: id, Authorization: `Bearer tok-${id}` } },
      }),
    );
    return c;
  };
  const plainLead = await connectLocal('plain-lead');
  const gitLead = await connectLocal('git-lead');
  const bot = new Client({ name: 'bot', version: '1.0.0' });
  t.after(() => bot.close());
  await bot.connect(
    new StreamableHTTPClientTransport(new URL(OFFICE_MCP_PATH, remoteOrigin), {
      fetch: proxyFetch,
      requestInit: { headers: { host: `${hostname}:8443`, Authorization: `Bearer ${botInfo.token}` } },
    }),
  );

  // 1. Floor worker on non-Git floor passes structured task WITHOUT repo or worktree -> runs cleanly in plain folder!
  const nonGitLocal = await plainLead.callTool({
    name: 'team_hire',
    arguments: { task: { title: 'Audit notes', brief: 'Summarize markdown files', acceptanceCriteria: ['Report summary'] } },
  });
  assert.equal(nonGitLocal.isError, undefined, JSON.stringify(nonGitLocal.content));
  assert.equal(hires.at(-1)?.worktree, false);
  assert.match(hires.at(-1)!.prompt, /Repository: .*plain/);
  assert.match(hires.at(-1)!.prompt, /- Report summary/);

  // 2. Building agent on non-Git floor passes top-level floor + structured task WITHOUT task.repo or worktree -> succeeds!
  const nonGitRemote = await bot.callTool({
    name: 'team_hire',
    arguments: { floor: 'plain', task: { title: 'Check notes', brief: 'Count notes' } },
  });
  assert.equal(nonGitRemote.isError, undefined, JSON.stringify(nonGitRemote.content));
  assert.equal(hires.at(-1)?.floor, 'plain');
  assert.equal(hires.at(-1)?.worktree, false);

  // 3. Floor worker on Git floor passes structured task WITHOUT repo -> defaults to worktree: true and floor dir!
  const gitLocal = await gitLead.callTool({
    name: 'team_hire',
    arguments: { task: { title: 'Add helper', brief: 'Write helper.ts', branch: 'feat/helper' } },
  });
  assert.equal(gitLocal.isError, undefined, JSON.stringify(gitLocal.content));
  assert.equal(hires.at(-1)?.worktree, true);
  assert.equal(hires.at(-1)?.branch, 'feat/helper');
  assert.match(hires.at(-1)!.prompt, /Repository: .*git/);

  // 4. Guardrails still hold: building agent omitting both floor and task.repo, explicit worktree:true on non-git floor, wrong repo path.
  const missingFloor = await bot.callTool({ name: 'team_hire', arguments: { task: { title: 'No floor', brief: 'Where?' } } });
  assert.equal(missingFloor.isError, true);
  assert.match(JSON.stringify(missingFloor.content), /names the floor/);

  const explicitWtOnPlain = await plainLead.callTool({
    name: 'team_hire',
    arguments: { worktree: true, task: { title: 'Bad wt', brief: 'No git here' } },
  });
  assert.equal(explicitWtOnPlain.isError, true);

  const branchOnPlain = await plainLead.callTool({
    name: 'team_hire',
    arguments: { task: { title: 'Bad branch', brief: 'No git here', branch: 'feat/nope' } },
  });
  assert.equal(branchOnPlain.isError, true);

  const wrongRepo = await gitLead.callTool({
    name: 'team_hire',
    arguments: { task: { title: 'Wrong repo', brief: 'Mismatch', repo: plainDir } },
  });
  assert.equal(wrongRepo.isError, true);
});
