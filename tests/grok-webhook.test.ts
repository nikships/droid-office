import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Answers } from '../src/server/answers.js';
import { redactWebhookSecret, sendGrokWebhook, type GrokWebhookPayload } from '../src/server/grok-webhook.js';
import { createOfficeMcp } from '../src/server/office-mcp/index.js';
import { RemoteMcp, remoteMcpListener } from '../src/server/remote-mcp-http.js';
import { RemoteOffice, type RemoteFloor } from '../src/server/remote-office.js';
import { GROK_BOTS_FILE, RemoteWorkers } from '../src/server/remote-workers.js';
import { Team, type TeamWorkers } from '../src/server/team.js';
import { Visits } from '../src/server/visits.js';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import { readMenu } from '../src/shared/asks.js';
import { SUBAGENT_DEFAULTS, type WorkerInfo } from '../src/shared/protocol.js';
import { validateGrokWebhookUrl } from '../src/shared/remote-mcp.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };

const DUMMY_TOKEN = 'crsr_test_0123456789abcdef0123456789abcdef';
const DIGITS = ['│ Which file should I create? │', '│ 1. hello.txt │', '│    A greeting │', '│ 2. bye.txt │', '│ 3. Other (type your answer) │', '│ Press a number to answer, Esc to skip │'];

/** Node fetch ignores a caller's Host header; emulate Tailscale Serve with a real HTTP request. */
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

async function listening(t: Cleanup, server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startWebhookReceiver(t: Cleanup) {
  const received: { method?: string; url?: string; headers: IncomingHttpHeaders; body: GrokWebhookPayload }[] = [];
  let responder: (reqBody: GrokWebhookPayload, headers: IncomingHttpHeaders) => { status: number; body: string; location?: string } = () => ({
    status: 200,
    body: JSON.stringify({ accepted: true }),
  });
  let waiter: (() => void) | undefined;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const parsed = JSON.parse(raw) as GrokWebhookPayload;
      received.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
      const out = responder(parsed, req.headers);
      if (out.location) res.setHeader('Location', out.location);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(out.body);
      waiter?.();
    });
  });

  const baseUrl = await listening(t, server);
  return {
    url: `${baseUrl}/automations/webhook/00000000-0000-0000-0000-000000000001`,
    received,
    setResponder(fn: typeof responder) {
      responder = fn;
    },
    async waitForCount(count: number, timeoutMs = 3000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count) {
        const left = deadline - Date.now();
        if (left <= 0) assert.fail(`Timed out waiting for ${count} webhook deliveries (got ${received.length})`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (waiter === wake) waiter = undefined;
            resolve();
          }, left);
          const wake = () => {
            clearTimeout(timer);
            waiter = undefined;
            resolve();
          };
          waiter = wake;
        });
      }
    },
  };
}

test('validateGrokWebhookUrl accepts HTTPS and loopback HTTP, rejects remote HTTP and embedded credentials', () => {
  assert.deepEqual(validateGrokWebhookUrl('  https://api2.cursor.sh/automations/webhook/00000000-0000-0000-0000-000000000001  '), {
    url: 'https://api2.cursor.sh/automations/webhook/00000000-0000-0000-0000-000000000001',
  });
  assert.equal('url' in validateGrokWebhookUrl('http://127.0.0.1:4999/hook'), true);
  assert.equal('url' in validateGrokWebhookUrl('http://localhost:4999/hook'), true);
  assert.equal('url' in validateGrokWebhookUrl('http://[::1]:4999/hook'), true);

  assert.equal('error' in validateGrokWebhookUrl(''), true);
  assert.equal('error' in validateGrokWebhookUrl('not a url'), true);
  assert.equal('error' in validateGrokWebhookUrl('http://example.com/hook'), true);
  assert.equal('error' in validateGrokWebhookUrl('ftp://example.com/hook'), true);
  assert.equal('error' in validateGrokWebhookUrl('https://user:secret@example.com/hook'), true);
});

test('sendGrokWebhook redacts bearer tokens from upstream error bodies, thrown errors, and refuses redirects', async (t) => {
  const receiver = await startWebhookReceiver(t);
  const samplePayload: GrokWebhookPayload = {
    source: 'droid-office',
    version: 1,
    event: 'test',
    test: true,
    summary: '[TEST] Sample',
    sentAt: new Date(1000).toISOString(),
    lead: { id: 'remote-1', name: 'grokbot' },
    items: [{ id: 'test:1', kind: 'test', at: new Date(1000).toISOString(), text: 'hello', actionHint: 'No action needed.' }],
  };

  receiver.setResponder(() => ({
    status: 401,
    body: JSON.stringify({ error: `Invalid token Bearer ${DUMMY_TOKEN} (${encodeURIComponent(DUMMY_TOKEN)})` }),
  }));
  const unauthorized = await sendGrokWebhook({ webhookUrl: receiver.url, webhookToken: DUMMY_TOKEN }, samplePayload);
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.error?.includes(DUMMY_TOKEN), false, 'raw token must never appear in error');
  assert.match(unauthorized.error ?? '', /\[redacted\]/);

  receiver.setResponder(() => ({ status: 302, body: '{}', location: 'https://evil.example.com/steal' }));
  const redirected = await sendGrokWebhook({ webhookUrl: receiver.url, webhookToken: DUMMY_TOKEN }, samplePayload);
  assert.equal(redirected.ok, false);
  assert.equal(redirected.error?.includes(DUMMY_TOKEN), false);

  const thrown = await sendGrokWebhook({ webhookUrl: receiver.url, webhookToken: DUMMY_TOKEN }, samplePayload, {
    fetchImpl: async () => {
      throw new Error(`Socket failed with header Authorization: Bearer ${DUMMY_TOKEN}`);
    },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error?.includes(DUMMY_TOKEN), false);
  assert.equal(redactWebhookSecret(`key=${DUMMY_TOKEN}`, DUMMY_TOKEN), 'key=[redacted]');
});

test('RemoteWorkers persists Grok Bot credentials in mode-0600 storage while stripping tokens from every client view', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grok-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = new RemoteWorkers(dir);
  const urlA = 'https://api2.cursor.sh/automations/webhook/11111111-1111-1111-1111-111111111111';
  const urlB = 'https://api2.cursor.sh/automations/webhook/22222222-2222-2222-2222-222222222222';
  const added = store.add('grokbot', { webhookUrl: urlA, webhookToken: DUMMY_TOKEN });
  const plain = store.add('claw');

  const file = path.join(dir, 'remote-workers.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(store.isGrokBot(added.worker.id), true);
  assert.equal(store.isGrokBot(plain.worker.id), false);
  assert.deepEqual(store.grokWebhook(added.worker.id), { webhookUrl: urlA, webhookToken: DUMMY_TOKEN });
  assert.equal(store.grokWebhook(plain.worker.id), undefined);

  // Client-facing list() must never leak webhookToken.
  const listedJson = JSON.stringify(store.list());
  assert.equal(listedJson.includes(DUMMY_TOKEN), false);
  const listedGrok = store.list().find((b) => b.id === added.worker.id)!;
  assert.deepEqual(listedGrok.grokBot, { webhookUrl: urlA, hasToken: true });

  // Updating URL without resending token keeps the existing token.
  store.setGrokBot(added.worker.id, { webhookUrl: urlB });
  assert.deepEqual(store.grokWebhook(added.worker.id), { webhookUrl: urlB, webhookToken: DUMMY_TOKEN });

  // Enabling Grok Bot on a bot with no saved token requires a token.
  assert.throws(() => store.setGrokBot(plain.worker.id, { webhookUrl: urlA }), /bearer token/i);

  // Reloading from disk preserves Grok Bot credentials and named-key identity mapping.
  const named = store.addKey(added.worker.id, 'cursor-cloud');
  const reloaded = new RemoteWorkers(dir);
  assert.equal(reloaded.isGrokBot(added.worker.id), true);
  assert.equal(reloaded.resolve(named.token)?.id, added.worker.id);
  assert.deepEqual(reloaded.grokWebhook(added.worker.id), { webhookUrl: urlB, webhookToken: DUMMY_TOKEN });

  // Turning Grok Bot off wipes credentials cleanly from both remote-workers.json and remote-grok-bots.json.
  reloaded.setGrokBot(added.worker.id, null);
  assert.equal(reloaded.isGrokBot(added.worker.id), false);
  assert.equal(reloaded.grokWebhook(added.worker.id), undefined);
  assert.equal(readFileSync(file, 'utf8').includes(DUMMY_TOKEN), false);

  // Sidecar remote-grok-bots.json restores Grok Bot config even if an older binary rewrote remote-workers.json without grokBot.
  reloaded.setGrokBot(added.worker.id, { webhookUrl: urlA, webhookToken: DUMMY_TOKEN });
  const sidecarFile = path.join(dir, GROK_BOTS_FILE);
  assert.equal(statSync(sidecarFile).mode & 0o777, 0o600);
  const stripped = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[]).map(({ grokBot: _g, ...rest }) => rest);
  writeFileSync(file, `${JSON.stringify(stripped)}\n`, { mode: 0o600 });
  const hydrated = new RemoteWorkers(dir);
  assert.equal(hydrated.isGrokBot(added.worker.id), true);
  assert.deepEqual(hydrated.grokWebhook(added.worker.id), { webhookUrl: urlA, webhookToken: DUMMY_TOKEN });
});

test('Grok Bot leads receive immediate team_report, lead_notify, floor hook, inbox, and Settings test pushes while non-Grok bots stay polling-only', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grok-e2e-'));
  const cleanups: (() => void | Promise<void>)[] = [];
  const rig: Cleanup = { after: (fn) => cleanups.push(fn) };
  t.after(async () => {
    try {
      for (const fn of cleanups.reverse()) await fn();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  const receiver = await startWebhookReceiver(rig);
  const store = new RemoteWorkers(dir);
  const settings = { ...SUBAGENT_DEFAULTS, visits: true, maxPerLead: 4 };
  let now = 10_000;
  const floors: RemoteFloor[] = [];
  const office = new RemoteOffice(store, () => floors, { webhookDelayMs: 25 });
  rig.after(() => office.stop());

  const people = new Map<string, WorkerInfo>();
  const tokens = new Map<string, string>();
  let seq = 0;
  let screenRows: string[] = ['working'];
  const alphaDir = path.join(dir, 'alpha');
  mkdirSync(alphaDir, { recursive: true });

  const get = (id: string) => people.get(id) ?? store.identity(id);
  const workers: TeamWorkers & RemoteFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    authenticate: (id, token) => (tokens.get(id) === token ? people.get(id) : undefined),
    releaseLead: (id) => {
      for (const w of people.values()) if (w.lead === id) delete w.lead;
    },
    officeDefault: undefined,
    deskOccupied: (id) => [...people.values()].some((w) => w.deskId === id),
    hire: (deskId, _by, _prompt, _worktree, _choice, lead) => {
      const id = `sub-${++seq}`;
      const w: WorkerInfo = {
        id,
        name: `Worker${seq}`,
        kind: 'agent',
        deskId,
        lead,
        color: '#ff6600',
        status: 'working',
        acked: true,
        createdAt: now,
        createdBy: lead ?? 'owner',
        cols: 100,
        rows: 30,
        open: false,
        worktree: { path: path.join(alphaDir, id), branch: `office/worker-${seq}` },
      };
      people.set(id, w);
      tokens.set(id, `tok-${id}`);
      return w;
    },
    prompt: (wid, text) => (store.identity(wid) ? office.tell(wid, text, 'alpha') : undefined),
    resume: (wid, text) => (text && store.identity(wid) ? office.tell(wid, text, 'alpha') : undefined),
    kill: async (wid) => {
      people.delete(wid);
      return {};
    },
    tail: () => screenRows.join('\n'),
    screenLines: () => screenRows,
    screenMenu: () => readMenu(screenRows),
    write: () => true,
    setTask() {},
  };

  const team = new Team({ ...workers, get }, { dataDir: alphaDir, dir: alphaDir, git: false, settings: () => settings, toast() {}, now: () => now });
  rig.after(() => team.stop());
  const visits = new Visits({ ...workers, get, tell: workers.prompt, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => settings.visits, emit() {}, now: () => now });
  rig.after(() => visits.stop());
  const whiteboard = new WhiteboardStore(alphaDir);
  rig.after(() => whiteboard.stop());
  floors.push({ id: 'alpha', dir: alphaDir, def: { name: 'Droid Office' }, workers, team, visits, whiteboard });

  // Add one Grok Bot and one regular polling bot.
  const grok = office.add('grokbot', { webhookUrl: receiver.url, webhookToken: DUMMY_TOKEN });
  const claw = office.add('claw');

  const floorLookup = (wid: string) => {
    const f = floors.find((x) => x.workers.get(wid));
    return f ? { ...f, name: f.def.name } : undefined;
  };

  // Mount both the local worker MCP server and the Tailscale remote MCP listener.
  const mcpDeps = { answers: new Answers(), remote: office, floor: floorLookup, settings: () => settings };
  const localMcp = createOfficeMcp(mcpDeps);
  const localServer = createServer((req, res) => {
    void localMcp.handle(req, res);
  });
  const localUrl = new URL('/office/mcp', await listening(rig, localServer));

  const hostname = 'office.example.ts.net';
  const remoteServer = remoteMcpListener({ ...mcpDeps, remoteTransport: { hostname: () => hostname, owner: () => undefined } });
  const remoteUrl = new URL('/office/mcp', await listening(rig, remoteServer));

  const connectRemote = async (bot: { worker: WorkerInfo; token: string }) => {
    const c = new Client({ name: `test-${bot.worker.name}`, version: '1' });
    rig.after(() => c.close());
    await c.connect(
      new StreamableHTTPClientTransport(remoteUrl, {
        fetch: proxyFetch,
        requestInit: { headers: { host: `${hostname}:8443`, Authorization: `Bearer ${bot.token}` } },
      }),
    );
    return c;
  };

  const connectLocal = async (w: WorkerInfo) => {
    const c = new Client({ name: `test-${w.name}`, version: '1' });
    rig.after(() => c.close());
    await c.connect(
      new StreamableHTTPClientTransport(localUrl, {
        requestInit: { headers: { Authorization: `Bearer ${tokens.get(w.id)!}`, 'x-droid-office-worker-id': w.id } },
      }),
    );
    return c;
  };

  const grokClient = await connectRemote(grok);
  const clawClient = await connectRemote(claw);

  // 1. office_whoami distinguishes Grok Bot leads from polling-only external bots.
  const grokWho = (await grokClient.callTool({ name: 'office_whoami', arguments: {} })).structuredContent as Record<string, unknown>;
  const clawWho = (await clawClient.callTool({ name: 'office_whoami', arguments: {} })).structuredContent as Record<string, unknown>;
  assert.equal(grokWho.grokBot, true);
  assert.equal(grokWho.wakeLead, true);
  assert.equal(clawWho.grokBot, undefined);
  assert.equal(clawWho.wakeLead, false);

  // Hire one subagent under grokbot and one under claw.
  const grokHire = (await grokClient.callTool({ name: 'team_hire', arguments: { title: 'Ship webhook', brief: 'Build webhook push.', floor: 'alpha', worktree: false } })).structuredContent as {
    worker: WorkerInfo;
  };
  const clawHire = (await clawClient.callTool({ name: 'team_hire', arguments: { title: 'Poll task', brief: 'Stay polling-only.', floor: 'alpha', worktree: false } })).structuredContent as {
    worker: WorkerInfo;
  };
  const grokSub = people.get(grokHire.worker.id)!;
  const clawSub = people.get(clawHire.worker.id)!;

  const grokSubClient = await connectLocal(grokSub);
  const clawSubClient = await connectLocal(clawSub);

  // 2. Subagent of Grok Bot sees lead_notify and leadPush: true; subagent of non-Grok bot does not.
  const grokSubTools = (await grokSubClient.listTools()).tools.map((tool) => tool.name);
  const clawSubTools = (await clawSubClient.listTools()).tools.map((tool) => tool.name);
  assert.equal(grokSubTools.includes('lead_notify'), true);
  assert.equal(clawSubTools.includes('lead_notify'), false);

  const grokSubWho = (await grokSubClient.callTool({ name: 'office_whoami', arguments: {} })).structuredContent as Record<string, unknown>;
  assert.equal(grokSubWho.leadPush, true);

  const refusedNotify = await clawSubClient.callTool({ name: 'lead_notify', arguments: { text: 'Should be refused' } });
  assert.equal(refusedNotify.isError, true);

  // 3. lead_notify pushes mid-turn blocker & test events directly; test skips office_inbox.
  const blockerCall = await grokSubClient.callTool({
    name: 'lead_notify',
    arguments: { kind: 'blocker', text: 'Waiting on staging credentials', prUrl: 'https://github.com/nikships/droid-office/pull/999' },
  });
  assert.equal(blockerCall.isError, undefined);
  assert.equal(receiver.received.length, 1);
  assert.equal(receiver.received[0].headers.authorization, `Bearer ${DUMMY_TOKEN}`);
  assert.equal(receiver.received[0].body.event, 'blocker');
  assert.equal(receiver.received[0].body.test, undefined);
  assert.equal(receiver.received[0].body.items[0].prUrl, 'https://github.com/nikships/droid-office/pull/999');
  assert.ok(receiver.received[0].body.items[0].ackId, 'non-test lead_notify is persisted in office_inbox');
  assert.equal(office.inbox(grok.worker.id).messages.length, 1);

  const testPing = await grokSubClient.callTool({ name: 'lead_notify', arguments: { kind: 'test', text: 'Connectivity verification' } });
  assert.equal(testPing.isError, undefined);
  assert.equal(receiver.received.length, 2);
  assert.equal(receiver.received[1].body.event, 'test');
  assert.equal(receiver.received[1].body.test, true);
  assert.equal(office.inbox(grok.worker.id).messages.length, 1, 'test ping does not clutter office_inbox');

  const invalidOpts = await grokSubClient.callTool({ name: 'lead_notify', arguments: { kind: 'update', text: 'Bad options', options: ['A', 'B'] } });
  assert.equal(invalidOpts.isError, true);

  // 4. Progress team_report does NOT wake the Grok Bot prematurely while a background job runs.
  now += 1000;
  const progressReport = await grokSubClient.callTool({
    name: 'team_report',
    arguments: { text: 'CI suite running in background', progress: true },
  });
  assert.equal(progressReport.isError, undefined);
  grokSub.status = 'done';
  team.onWorker(grokSub);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(receiver.received.length, 2, 'progress report and its turn-end done must not wake lead early');

  // 5. Blocking team_report question pushes immediately once and does not duplicate on turn-end done.
  grokSub.status = 'working';
  team.onWorker(grokSub);
  now += 1000;
  const questionReport = await grokSubClient.callTool({
    name: 'team_report',
    arguments: { text: 'Which webhook retry policy should we use?', question: true, options: ['Immediate once + inbox', 'Exponential backoff'] },
  });
  assert.equal(questionReport.isError, undefined);
  assert.equal(receiver.received.length, 3, 'team_report question flushes immediately');
  assert.equal(receiver.received[2].body.event, 'question');
  assert.deepEqual(receiver.received[2].body.items[0].options, ['Immediate once + inbox', 'Exponential backoff']);
  assert.match(receiver.received[2].body.items[0].questionId ?? '', /^team:alpha:/);
  grokSub.status = 'done';
  team.onWorker(grokSub);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(receiver.received.length, 3, 'no duplicate push when turn ends after team_report');

  // 6. Final team_report pushes structured result immediately; non-Grok bot claw stays polling-only.
  grokSub.status = 'working';
  team.onWorker(grokSub);
  now += 1000;
  const finalReport = await grokSubClient.callTool({
    name: 'team_report',
    arguments: {
      text: 'All checks green and PR opened.',
      prUrl: 'https://github.com/nikships/droid-office/pull/1000',
      result: { status: 'ok', summary: 'Shipped per-bot Grok Bot webhook push' },
    },
  });
  assert.equal(finalReport.isError, undefined);
  assert.equal(receiver.received.length, 4);
  assert.equal(receiver.received[3].body.event, 'report');
  assert.equal(receiver.received[3].body.items[0].result?.status, 'ok');
  assert.equal(receiver.received[3].body.items[0].ackId, `team:alpha:${receiver.received[3].body.items[0].id.split(':').at(-1)}`);

  // Subagent of polling-only claw reports -> 0 new webhook calls, inbox still populated.
  const clawReport = await clawSubClient.callTool({ name: 'team_report', arguments: { text: 'Claw subagent finished.' } });
  assert.equal(clawReport.isError, undefined);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(receiver.received.length, 4, 'non-Grok bot never triggers webhook');
  assert.equal(office.inbox(claw.worker.id).messages.length, 1);

  // 7. Server-side floor hooks: terminal needs_input AskUser prompt and stopped push automatically.
  screenRows = DIGITS;
  now += 1000;
  grokSub.status = 'needs_input';
  grokSub.ask = { kind: 'question', questions: [{ question: 'Which file should I create?', options: ['hello.txt', 'bye.txt', 'Other (type your answer)'], multiSelect: false }] };
  team.onWorker(grokSub);
  await receiver.waitForCount(5);
  assert.equal(receiver.received[4].body.event, 'needs_input');
  assert.equal(receiver.received[4].body.items[0].terminalAsk?.kind, 'terminal');
  assert.equal(receiver.received[4].body.items[0].terminalAsk?.options?.length, 3);
  assert.equal(receiver.received[4].body.items[0].terminalAsk?.answerable, true);
  assert.match(receiver.received[4].body.items[0].questionId ?? '', /^ask:alpha:/);

  now += 1000;
  delete grokSub.ask;
  grokSub.status = 'exited';
  grokSub.exitCode = 1;
  team.onWorker(grokSub);
  await receiver.waitForCount(6);
  assert.equal(receiver.received[5].body.event, 'stopped');

  // 8. Inbox tell to Grok Bot pushes message event; Settings RemoteMcp.testWebhook records lastDelivery without exposing token.
  now += 1000;
  assert.equal(office.tell(grok.worker.id, 'Direct inbox note', 'alpha'), undefined);
  await receiver.waitForCount(7);
  assert.equal(receiver.received[6].body.event, 'message');

  const rmcp = new RemoteMcp({ dataDir: dir, office, mcp: mcpDeps, backendPort: 0, log() {} });
  rig.after(() => rmcp.stop());
  const testStartedAt = Date.now();
  const tested = await rmcp.testWebhook(grok.worker.id);
  const testFinishedAt = Date.now();
  assert.equal(tested.result.ok, true);
  assert.equal(receiver.received.length, 8);
  assert.equal(receiver.received[7].body.test, true);
  const settingsPing = receiver.received[7].body;
  assert.equal(settingsPing.event, 'test');
  assert.equal(settingsPing.source, 'droid-office');
  assert.equal(settingsPing.version, 1);
  assert.deepEqual(settingsPing.lead, { id: grok.worker.id, name: 'grokbot' });
  assert.ok(Date.parse(settingsPing.sentAt) >= testStartedAt && Date.parse(settingsPing.sentAt) <= testFinishedAt);
  const pingItem = settingsPing.items[0];
  assert.match(pingItem.id, /^test-[0-9a-f]{16}$/);
  assert.equal(pingItem.kind, 'test');
  assert.equal(pingItem.at, settingsPing.sentAt);
  assert.equal(pingItem.ackId, undefined);
  assert.match(pingItem.text ?? '', /Connectivity test from Droid Office Settings/);
  assert.match(pingItem.text ?? '', /reply to the owner confirming you received this test ping/i);
  assert.match(pingItem.text ?? '', /all non-secret details/);
  assert.match(pingItem.actionHint, /Reply to the owner to acknowledge/);
  for (const field of ['event', 'test flag', 'source', 'version', 'summary', 'lead id and name', 'sentAt', 'every item field', 'id, kind, at, text and actionHint', 'request id']) {
    assert.ok(pingItem.actionHint.includes(field), `test acknowledgment requests ${field}`);
  }
  assert.match(pingItem.actionHint, /absent rather than inventing/);
  assert.match(pingItem.actionHint, /Never include Authorization headers, webhook keys, tokens or other secrets/);
  assert.match(pingItem.actionHint, /do not acknowledge it via office_inbox/);
  assert.doesNotMatch(pingItem.actionHint, /no action|no acknowledgment/i);
  assert.equal(JSON.stringify(settingsPing).includes(DUMMY_TOKEN), false, 'test payload never contains the webhook token');
  const stateJson = JSON.stringify(tested.state);
  assert.equal(stateJson.includes(DUMMY_TOKEN), false, 'RemoteMcp.state() never exposes webhookToken');
  const grokState = tested.state.bots.find((b) => b.id === grok.worker.id)!;
  assert.equal(grokState.grokBot?.hasToken, true);
  assert.equal(grokState.grokBot?.lastDelivery?.ok, true);
  assert.equal(grokState.grokBot?.lastDelivery?.event, 'test');
});
