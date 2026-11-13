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
import { buildGrokWebhookPayload, buildTeamWebhookItem, redactWebhookSecret, sendGrokWebhook, type GrokWebhookPayload } from '../src/server/grok-webhook.js';
import { createOfficeMcp } from '../src/server/office-mcp/index.js';
import { RemoteMcp, remoteMcpListener } from '../src/server/remote-mcp-http.js';
import { RemoteOffice, type RemoteFloor } from '../src/server/remote-office.js';
import { GROK_BOTS_FILE, RemoteWorkers } from '../src/server/remote-workers.js';
import { Team, type TeamEvent, type TeamSignal, type TeamWorkers } from '../src/server/team.js';
import { Visits } from '../src/server/visits.js';
import type { WakeGate, WakePacket } from '../src/server/wake-filter.js';
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

  receiver.setResponder(() => ({ status: 200, body: '{}' }));
  await sendGrokWebhook(
    { webhookUrl: receiver.url, webhookToken: DUMMY_TOKEN },
    { ...samplePayload, summary: `Token ${DUMMY_TOKEN}`, items: [{ ...samplePayload.items[0], text: `Bearer another-secret ${receiver.url}`, result: { status: 'ok', summary: encodeURIComponent(DUMMY_TOKEN) } }] },
  );
  const safe = JSON.stringify(receiver.received.at(-1)!.body);
  assert.equal(safe.includes(DUMMY_TOKEN), false);
  assert.equal(safe.includes('another-secret'), false);
  assert.equal(safe.includes(receiver.url), false);
  assert.equal(receiver.received.at(-1)!.headers.authorization, `Bearer ${DUMMY_TOKEN}`);
});

test('transport redacts overlapping raw and encoded credentials without exposing URL secrets', async (t) => {
  const receiver = await startWebhookReceiver(t);
  for (const token of ['abc123', 'a+b?c']) {
    const url = `${receiver.url}?token=${encodeURIComponent(token)}&key=other-secret`;
    const payload = buildGrokWebhookPayload({ id: 'remote-1', name: 'grokbot' }, [
      {
        id: 'test-1',
        kind: 'test',
        at: new Date(1000).toISOString(),
        text: `${url} ${encodeURIComponent(url)} ${token}`,
        actionHint: 'No action needed.',
        result: { status: 'ok', summary: 'Connectivity check', artifacts: { commits: [token] } },
      },
    ]);
    const sent = await sendGrokWebhook({ webhookUrl: url, webhookToken: token }, payload);
    assert.equal(sent.ok, true);
    assert.equal(receiver.received.at(-1)!.body.items[0].text, '[redacted] [redacted] [redacted]');
    assert.deepEqual(receiver.received.at(-1)!.body.items[0].result?.artifacts?.commits, ['[redacted]'], 'non-commit prose cannot bypass redaction through the commits field');
    assert.equal(JSON.stringify(receiver.received.at(-1)!.body).includes('other-secret'), false);
  }
});

test('custom short tokens leave event discriminators and report identifiers usable', async (t) => {
  const receiver = await startWebhookReceiver(t);
  for (const token of ['test', 'team', 'a', 'ok', 'progress', 'droid-office']) {
    const report = buildTeamWebhookItem({
      event: { seq: 1, lead: 'remote-1', worker: 'worker-1', name: 'Byte', kind: 'report', at: 1000, pushedSha: 'a'.repeat(40), result: { status: 'ok', summary: `Do not echo ${token}`, artifacts: { commits: ['a'.repeat(40)] } } },
      floor: { id: 'alpha', name: 'Droid Office', cwd: '/project' },
    });
    const payload = buildGrokWebhookPayload({ id: 'remote-1', name: 'grokbot' }, [report, { id: 'test-1', kind: 'test', at: report.at, actionHint: `Do not echo ${token}` }], 1000);
    assert.equal((await sendGrokWebhook({ webhookUrl: receiver.url, webhookToken: token }, payload)).ok, true);
    const delivered = receiver.received.at(-1)!.body;
    assert.equal(delivered.source, 'droid-office');
    assert.equal(delivered.event, 'report');
    assert.equal(delivered.items[1].kind, 'test');
    for (const field of ['id', 'ackId', 'reportId', 'reportPhase', 'pushedSha', 'at'] as const) assert.equal(delivered.items[0][field], report[field]);
    assert.deepEqual(delivered.items[0].floor, report.floor);
    assert.equal(delivered.items[0].worker?.id, 'worker-1');
    assert.equal(delivered.items[0].result?.status, 'ok');
    assert.deepEqual(delivered.items[0].result?.artifacts?.commits, ['a'.repeat(40)]);
    assert.equal(delivered.items[0].result?.summary, 'Do not echo [redacted]');
    const ping = buildGrokWebhookPayload(payload.lead, [payload.items[1]], 1000);
    assert.equal((await sendGrokWebhook({ webhookUrl: receiver.url, webhookToken: token }, ping)).ok, true);
    assert.equal(receiver.received.at(-1)!.body.event, 'test', 'Settings test discriminator stays usable with a token of test');
  }
});

test('error response URL redaction happens before clipping even across the old 2048-character boundary', async (t) => {
  const receiver = await startWebhookReceiver(t);
  const url = `${receiver.url}/private-hook-key/`.padEnd(1990, 'x');
  assert.equal('url' in validateGrokWebhookUrl(url), true);
  receiver.setResponder(() => ({ status: 401, body: `${'x'.repeat(100)}${url}` }));
  const payload = buildGrokWebhookPayload({ id: 'remote-1', name: 'grokbot' }, [{ id: 'test-1', kind: 'test', at: new Date(1000).toISOString(), actionHint: 'No action needed.' }]);
  const sent = await sendGrokWebhook({ webhookUrl: url, webhookToken: DUMMY_TOKEN }, payload);
  assert.equal(sent.ok, false);
  assert.equal(sent.error?.includes('private-hook-key'), false);
  assert.match(sent.error ?? '', /\[redacted\]/);
  assert.ok((sent.error?.length ?? 0) <= 250);
});

test('outcome headlines redact raw and encoded credentials before whitespace normalization and clipping', async (t) => {
  const receiver = await startWebhookReceiver(t);
  const token = 'custom+private?credential-0123456789';
  for (const secret of [token, encodeURIComponent(token), receiver.url, encodeURIComponent(receiver.url)]) {
    const result = { status: 'ok' as const, summary: `${'x'.repeat(154)}${secret} result` };
    const item = buildTeamWebhookItem({ event: { seq: 1, lead: 'remote-1', worker: 'byte', name: 'Byte', kind: 'report', at: 1000, result }, floor: { id: 'alpha', name: 'Office', cwd: '/project' } });
    const payload = buildGrokWebhookPayload({ id: 'remote-1', name: 'grokbot' }, [item]);
    assert.equal((await sendGrokWebhook({ webhookUrl: receiver.url, webhookToken: token }, payload)).ok, true);
    const summary = receiver.received.at(-1)!.body.summary;
    assert.match(summary, /\[redacted\]/);
    assert.equal(summary.includes(secret.slice(0, 8)), false);
  }
});

test('worker webhook payloads distinguish reported completion from live runtime status without repeating report prose', () => {
  const event: TeamEvent = {
    seq: 1,
    lead: 'remote-1',
    worker: 'byte',
    name: 'Byte',
    kind: 'report',
    at: 1000,
    text: 'All checks green. PR: https://github.com/nikships/droid-office/pull/1000 Commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    prUrl: 'https://github.com/nikships/droid-office/pull/1000',
    pushedSha: 'a'.repeat(40),
    result: { status: 'ok', summary: 'All checks green.', artifacts: { prUrl: 'https://github.com/nikships/droid-office/pull/1000', commits: ['a'.repeat(40)] } },
  };
  const floor = { id: 'alpha', name: 'Droid Office', cwd: '/project' };
  const item = buildTeamWebhookItem({ event, floor });
  const payload = buildGrokWebhookPayload({ id: event.lead, name: 'grokbot' }, [item], 1000);
  assert.equal(payload.summary, 'Completed: All checks green. (Byte)');
  assert.equal(item.text, undefined, 'result holds summary, CI status and artifact aliases, not repeated raw report prose');
  assert.equal(item.result?.summary, 'All checks green.');
  assert.equal(item.prUrl, event.prUrl, 'keep v1 artifact aliases');
  assert.equal(item.pushedSha, event.pushedSha);
  assert.equal(item.reportId, 'team:alpha:1');
  assert.equal(item.reportPhase, undefined);
  assert.equal(item.taskComplete, true);
  assert.doesNotMatch(item.actionHint, /\w+\(\{/);
  for (const status of ['partial', 'blocked', 'failed'] as const) {
    const next = buildTeamWebhookItem({ event: { ...event, result: { status, summary: 'Still needs work.' } }, floor });
    assert.equal(next.kind, status === 'partial' ? 'progress' : 'blocker');
    assert.equal(next.reportPhase, undefined);
    assert.equal(next.taskComplete, false);
    assert.doesNotMatch(next.actionHint, /\w+\(\{/);
  }
  const question = buildTeamWebhookItem({ event: { ...event, kind: 'question', text: 'Which policy?' }, floor });
  assert.equal(question.text, 'Which policy?');
  assert.equal(question.reportPhase, undefined);
  assert.equal(question.taskComplete, false);
  assert.equal(question.questionId, question.ackId);
  const legacy = buildTeamWebhookItem({ event: { ...event, result: undefined }, floor });
  assert.equal(legacy.text, event.text, 'legacy reports retain text');
  const long = buildTeamWebhookItem({ event: { ...event, result: { status: 'ok', summary: 'A complete sentence. '.repeat(100) } }, floor });
  assert.match(buildGrokWebhookPayload(payload.lead, [long]).summary, /^Completed: A complete sentence\./);
  assert.ok(buildGrokWebhookPayload(payload.lead, [long]).summary.length <= 200);
  const batch = buildGrokWebhookPayload(payload.lead, [item, question]);
  assert.equal(batch.event, 'question');
  assert.match(batch.summary, /^Question: Which policy\?/);
  assert.equal(batch.items.length, 2);
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

test('no-artifact reports avoid merge advice even when a worker has a branch; distinct question results survive', () => {
  const event: TeamEvent = { seq: 1, lead: 'remote-1', worker: 'byte', name: 'Byte', kind: 'report', at: 1000, result: { status: 'ok', summary: 'Read-only audit complete; no changes needed.' } };
  const floor = { id: 'alpha', name: 'Droid Office', cwd: '/project' };
  const member = { id: 'byte', name: 'Byte', status: 'working' as const, state: 'working' as const, settled: false, desk: 'Desk 1', worktree: { path: '/project/byte', branch: 'office/byte' } };
  const item = buildTeamWebhookItem({ event, floor, member });
  assert.equal(item.worker?.branch, 'office/byte');
  assert.equal(item.worker?.state, undefined);
  assert.equal(member.status, 'working');
  assert.equal(item.worker?.status, 'done');
  assert.equal(item.worker?.settled, true);
  assert.doesNotMatch(item.actionHint, /review|merg/i);
  assert.match(buildGrokWebhookPayload({ id: event.lead, name: 'grokbot' }, [item]).summary, /^Completed: Read-only audit complete/);
  for (const artifacts of [{ files: ['src/example.ts'] }, { commits: ['a'.repeat(40)] }, { prNumber: 423 }]) {
    const changed = buildTeamWebhookItem({ event: { ...event, result: { ...event.result!, artifacts } }, floor });
    assert.match(changed.actionHint, /record a review before merging/);
  }
  const question = buildTeamWebhookItem({ event: { ...event, kind: 'question', text: 'Which policy?', result: { status: 'blocked', summary: 'Which policy?', remaining: ['Owner decision needed.'] } }, floor });
  assert.deepEqual(question.result?.remaining, ['Owner decision needed.']);
  for (const status of ['failed', 'partial', 'ok'] as const) {
    const explicit = buildTeamWebhookItem({ event: { ...event, kind: 'question', text: 'Which policy?', result: { status, summary: 'Which policy?' } }, floor });
    assert.equal(explicit.result?.status, status);
  }
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

  // 4. Progress team_report pushes immediately, but is not a completed task or a duplicate done event.
  now += 1000;
  const progressReport = await grokSubClient.callTool({
    name: 'team_report',
    arguments: { text: 'CI suite running in background', progress: true },
  });
  assert.equal(progressReport.isError, undefined);
  assert.equal(receiver.received.length, 3, 'progress pushes before the MCP call returns');
  assert.equal(receiver.received[2].body.event, 'progress');
  assert.equal(receiver.received[2].body.items[0].reportPhase, undefined);
  assert.equal(receiver.received[2].body.summary, 'Progress: CI suite running in background (Worker1)');
  assert.equal(receiver.received[2].body.items[0].taskComplete, false);
  assert.equal(receiver.received[2].body.items[0].result?.status, 'partial');
  assert.equal(receiver.received[2].body.items[0].worker?.settled, false);
  assert.equal((progressReport.structuredContent as { webhook: { pushed: boolean } }).webhook.pushed, true);
  grokSub.status = 'done';
  team.onWorker(grokSub);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(receiver.received.length, 3, 'turn-end after progress must not duplicate the report');

  // 5. Blocking team_report question pushes immediately once and does not duplicate on turn-end done.
  grokSub.status = 'working';
  team.onWorker(grokSub);
  now += 1000;
  const questionReport = await grokSubClient.callTool({
    name: 'team_report',
    arguments: { text: 'Which webhook retry policy should we use?', question: true, options: ['Immediate once + inbox', 'Exponential backoff'] },
  });
  assert.equal(questionReport.isError, undefined);
  assert.equal(receiver.received.length, 4, 'team_report question flushes immediately');
  assert.equal(receiver.received[3].body.event, 'question');
  assert.equal(receiver.received[3].body.summary, 'Question: Which webhook retry policy should we use? (Worker1)');
  assert.equal(receiver.received[3].body.items[0].result, undefined);
  assert.deepEqual(receiver.received[3].body.items[0].options, ['Immediate once + inbox', 'Exponential backoff']);
  assert.match(receiver.received[3].body.items[0].questionId ?? '', /^team:alpha:/);
  grokSub.status = 'done';
  team.onWorker(grokSub);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(receiver.received.length, 4, 'no duplicate push when turn ends after team_report');

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
  assert.equal(receiver.received.length, 5);
  assert.equal(receiver.received[4].body.event, 'report');
  assert.equal(receiver.received[4].body.items[0].result?.status, 'ok');
  assert.equal(receiver.received[4].body.items[0].reportPhase, undefined);
  assert.equal(receiver.received[4].body.items[0].taskComplete, true);
  assert.equal(receiver.received[4].body.items[0].worker?.status, 'done', 'completed task snapshot does not show the returning MCP call as working');
  assert.equal(receiver.received[4].body.items[0].worker?.state, undefined);
  assert.equal(receiver.received[4].body.items[0].worker?.settled, true);
  assert.equal(grokSub.status, 'working', 'webhook snapshot must not mutate the real worker');
  assert.match(receiver.received[4].body.items[0].actionHint, /record a review before merging/);
  assert.equal(receiver.received[4].body.items[0].ackId, `team:alpha:${receiver.received[4].body.items[0].id.split(':').at(-1)}`);
  const full = await grokClient.callTool({ name: 'team_report_get', arguments: { id: receiver.received[4].body.items[0].reportId } });
  assert.equal(full.isError, undefined);
  assert.equal((full.structuredContent as { report: { text: string } }).report.text, 'All checks green and PR opened.', 'original prose remains readable through the payload reportId');

  // Subagent of polling-only claw reports -> 0 new webhook calls, inbox still populated.
  const clawReport = await clawSubClient.callTool({ name: 'team_report', arguments: { text: 'Claw subagent finished.' } });
  assert.equal(clawReport.isError, undefined);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(receiver.received.length, 5, 'non-Grok bot never triggers webhook');
  assert.equal(office.inbox(claw.worker.id).messages.length, 1);

  // 7. Server-side floor hooks: terminal needs_input AskUser prompt and stopped push automatically.
  screenRows = DIGITS;
  now += 1000;
  grokSub.status = 'needs_input';
  grokSub.ask = { kind: 'question', questions: [{ question: 'Which file should I create?', options: ['hello.txt', 'bye.txt', 'Other (type your answer)'], multiSelect: false }] };
  team.onWorker(grokSub);
  await receiver.waitForCount(6);
  assert.equal(receiver.received[5].body.event, 'needs_input');
  assert.equal(receiver.received[5].body.items[0].terminalAsk?.kind, 'terminal');
  assert.equal(receiver.received[5].body.items[0].terminalAsk?.options?.length, 3);
  assert.equal(receiver.received[5].body.items[0].terminalAsk?.answerable, true);
  assert.match(receiver.received[5].body.items[0].questionId ?? '', /^ask:alpha:/);

  now += 1000;
  delete grokSub.ask;
  grokSub.status = 'exited';
  grokSub.exitCode = 1;
  team.onWorker(grokSub);
  await receiver.waitForCount(7);
  assert.equal(receiver.received[6].body.event, 'stopped');

  // 8. Inbox tell to Grok Bot pushes message event; Settings RemoteMcp.testWebhook records lastDelivery without exposing token.
  now += 1000;
  assert.equal(office.tell(grok.worker.id, 'Direct inbox note', 'alpha'), undefined);
  await receiver.waitForCount(8);
  assert.equal(receiver.received[7].body.event, 'message');

  const rmcp = new RemoteMcp({ dataDir: dir, office, mcp: mcpDeps, backendPort: 0, log() {} });
  rig.after(() => rmcp.stop());
  const testStartedAt = Date.now();
  const tested = await rmcp.testWebhook(grok.worker.id);
  const testFinishedAt = Date.now();
  assert.equal(tested.result.ok, true);
  assert.equal(receiver.received.length, 9);
  assert.equal(receiver.received[8].body.test, true);
  const settingsPing = receiver.received[8].body;
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

  // Reports emitted without the MCP convenience flush still push via floor subscriptions.
  grokSub.status = 'working';
  team.onWorker(grokSub);
  await team.handle(grokSub, { action: 'report', progress: true, text: 'Another background check is running.' });
  await receiver.waitForCount(10);
  assert.equal(receiver.received[9].body.event, 'progress');

  for (const status of ['blocked', 'failed'] as const) {
    const reported = await grokSubClient.callTool({ name: 'team_report', arguments: { text: 'Checks need attention.', result: { status, summary: 'Cannot finish until checks pass.' } } });
    assert.equal(reported.isError, undefined);
    const item = receiver.received.at(-1)!.body.items[0];
    assert.equal(item.kind, 'blocker');
    assert.equal(item.reportPhase, undefined);
    assert.equal(item.taskComplete, false);
    assert.equal(item.result?.status, status);
  }

  const before = receiver.received.length;
  await clawSubClient.callTool({ name: 'team_report', arguments: { text: 'Polling-only progress.', progress: true } });
  await office.flushLeadPush(claw.worker.id);
  assert.equal(receiver.received.length, before, 'non-Grok progress reports remain polling-only');
  assert.ok(office.inbox(claw.worker.id).messages.some((m) => m.text.includes('Polling-only progress.')));

  // A read-only final on this non-git floor has no merge/review prerequisites.
  delete grokSub.worktree;
  const readOnly = await grokSubClient.callTool({ name: 'team_report', arguments: { text: 'Read-only audit complete; no changes needed.' } });
  assert.equal(readOnly.isError, undefined);
  const readOnlyPayload = receiver.received.at(-1)!.body;
  assert.match(readOnlyPayload.summary, /^Completed: Read-only audit complete; no changes needed\./);
  assert.equal(readOnlyPayload.items[0].worker?.status, 'done');
  assert.equal(readOnlyPayload.items[0].worker?.settled, true);
  assert.equal(readOnlyPayload.items[0].worker?.branch, undefined);
  assert.doesNotMatch(readOnlyPayload.items[0].actionHint, /review|merg/i);
  for (const received of receiver.received) {
    assert.equal(JSON.stringify(received.body).includes(DUMMY_TOKEN), false);
    for (const item of received.body.items) assert.doesNotMatch(item.actionHint, /\w+\(\{/);
  }
});

test('the noise gate defers routine lead_notify updates, holds batch reports from Grok Bot webhooks, and blocks only chatter tells', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grok-gate-'));
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
  const floors: RemoteFloor[] = [];
  const office = new RemoteOffice(store, () => floors, { webhookDelayMs: 15 });
  rig.after(() => office.stop());
  const calls: WakePacket[] = [];
  const gate: WakeGate = {
    active: () => true,
    async decide(p) {
      calls.push(p);
      if (/chatter/.test(p.message.text)) return { traffic: 'block_and_coach', source: 'model', reason: 'chatter', coach: 'Noise gate: heads-down' };
      if (/routine/.test(p.message.text) || p.message.progress) return { traffic: 'record_silently', source: 'model', reason: 'routine' };
      if (p.channel === 'team_report' && p.teammates.some((m) => m.status === 'working')) return { traffic: 'hold_for_batch', source: 'model', reason: 'batch' };
      return { traffic: 'wake_immediately', source: 'model', reason: 'final' };
    },
  };

  const people = new Map<string, WorkerInfo>();
  const tokens = new Map<string, string>();
  let seq = 0;
  const alphaDir = path.join(dir, 'alpha');
  mkdirSync(alphaDir, { recursive: true });
  const person = (id: string, name: string, extra: Partial<WorkerInfo> = {}): WorkerInfo => {
    const w: WorkerInfo = { id, name, kind: 'agent', deskId: `desk-${id}`, color: '#ff6600', status: 'working', acked: true, createdAt: 1, createdBy: 'owner', cols: 100, rows: 30, open: false, ...extra };
    people.set(id, w);
    tokens.set(id, `tok-${id}`);
    return w;
  };
  const get = (id: string) => people.get(id) ?? store.identity(id);
  const workers: TeamWorkers & RemoteFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    authenticate: (id, token) => (tokens.get(id) === token ? people.get(id) : undefined),
    releaseLead: () => {},
    officeDefault: undefined,
    deskOccupied: (id) => [...people.values()].some((w) => w.deskId === id),
    hire: (_deskId, _by, _prompt, _worktree, _choice, lead) => person(`sub-${++seq}`, `Worker${seq}`, { lead }),
    prompt: (wid, text) => (store.identity(wid) ? office.tell(wid, text, 'alpha') : undefined),
    resume: (wid, text) => (text && store.identity(wid) ? office.tell(wid, text, 'alpha') : undefined),
    kill: async (wid) => {
      people.delete(wid);
      return {};
    },
    tail: () => 'working',
    screenLines: () => ['working'],
    screenMenu: () => undefined,
    write: () => true,
    setTask() {},
  };
  const team = new Team({ ...workers, get }, { dataDir: alphaDir, dir: alphaDir, git: false, settings: () => settings, toast() {}, wakeFilter: gate });
  rig.after(() => team.stop());
  const visits = new Visits({ ...workers, get, tell: workers.prompt, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => settings.visits, emit() {} });
  rig.after(() => visits.stop());
  const whiteboard = new WhiteboardStore(alphaDir);
  rig.after(() => whiteboard.stop());
  floors.push({ id: 'alpha', dir: alphaDir, def: { name: 'Droid Office' }, workers, team, visits, whiteboard });
  const grok = office.add('grokbot', { webhookUrl: receiver.url, webhookToken: DUMMY_TOKEN });

  const floorLookup = (wid: string) => {
    const f = floors.find((x) => x.workers.get(wid));
    return f ? { ...f, name: f.def.name } : undefined;
  };
  const mcpDeps = { answers: new Answers(), remote: office, floor: floorLookup, settings: () => settings, wakeFilter: gate };
  const localMcp = createOfficeMcp(mcpDeps);
  const localUrl = new URL(
    '/office/mcp',
    await listening(
      rig,
      createServer((req, res) => void localMcp.handle(req, res)),
    ),
  );
  const hostname = 'office.example.ts.net';
  const remoteUrl = new URL('/office/mcp', await listening(rig, remoteMcpListener({ ...mcpDeps, remoteTransport: { hostname: () => hostname, owner: () => undefined } })));
  const connect = async (url: URL, headers: Record<string, string>, fetchImpl?: typeof fetch) => {
    const c = new Client({ name: 'gate-test', version: '1' });
    rig.after(() => c.close());
    await c.connect(new StreamableHTTPClientTransport(url, { ...(fetchImpl ? { fetch: fetchImpl } : {}), requestInit: { headers } }));
    return c;
  };
  const local = (w: WorkerInfo) => connect(localUrl, { Authorization: `Bearer ${tokens.get(w.id)!}`, 'x-droid-office-worker-id': w.id });
  const grokClient = await connect(remoteUrl, { host: `${hostname}:8443`, Authorization: `Bearer ${grok.token}` }, proxyFetch);
  const hire = async (title: string) => people.get(((await grokClient.callTool({ name: 'team_hire', arguments: { title, brief: title, floor: 'alpha', worktree: false } })).structuredContent as { worker: WorkerInfo }).worker.id)!;
  const one = await hire('One');
  const two = await hire('Two');
  const oneClient = await local(one);
  const twoClient = await local(two);
  const settle = () => new Promise((r) => setTimeout(r, 60));

  // A routine mid-turn update is saved in office_inbox and rides along with the next push.
  const routine = await oneClient.callTool({ name: 'lead_notify', arguments: { kind: 'update', text: 'routine: phase one green, starting phase two' } });
  assert.equal(routine.isError, undefined);
  assert.equal((routine.structuredContent as Record<string, unknown>).deferred, true);
  assert.equal(calls[0]!.channel, 'lead_notify');
  assert.equal(calls[0]!.lead.name, 'grokbot');
  assert.deepEqual(
    calls[0]!.teammates.map((m) => m.id),
    [two.id],
  );
  const chatter = await oneClient.callTool({ name: 'lead_notify', arguments: { kind: 'update', text: 'chatter chatter' } });
  assert.equal((chatter.structuredContent as Record<string, unknown>).blocked, true);
  assert.match(JSON.stringify(chatter.content), /Noise gate: heads-down/);
  // Blockers never reach the gate.
  const gated = calls.length;
  await oneClient.callTool({ name: 'lead_notify', arguments: { kind: 'blocker', text: 'chatter but blocked on staging creds' } });
  assert.equal(calls.length, gated);
  await receiver.waitForCount(1);
  assert.equal(receiver.received[0]!.body.event, 'blocker');
  assert.equal(receiver.received[0]!.body.items.length, 2, 'the deferred update rides along');
  assert.equal(office.inbox(grok.worker.id).messages.length, 2);

  // A progress report is recorded silently; a completion is held while its sibling works.
  await oneClient.callTool({ name: 'team_report', arguments: { text: 'CI suite running in background', progress: true } });
  await oneClient.callTool({ name: 'team_report', arguments: { text: 'Worker1 finished One.' } });
  await settle();
  assert.equal(receiver.received.length, 1);
  people.get(one.id)!.status = 'done';
  team.onWorker({ ...people.get(one.id)! });
  await twoClient.callTool({ name: 'team_report', arguments: { text: 'Worker2 finished Two.' } });
  await receiver.waitForCount(2);
  await settle();
  assert.equal(receiver.received.length, 2, 'the batch arrives as one push');
  const batch = JSON.stringify(receiver.received[1]!.body.items);
  assert.match(batch, /Worker1 finished One/);
  assert.match(batch, /Worker2 finished Two/);
  assert.match(batch, /CI suite running in background/);

  // Visit tells: only chatter is coached back; everything else is delivered as before.
  const alice = person('alice', 'Alice');
  person('bob', 'Bob');
  const aliceClient = await local(alice);
  const coached = await aliceClient.callTool({ name: 'visit_message', arguments: { worker: 'Bob', kind: 'tell', text: 'chatter, just saying hi' } });
  assert.equal((coached.structuredContent as Record<string, unknown>).blocked, true);
  assert.equal(calls.at(-1)!.channel, 'visit_tell');
  const told = await aliceClient.callTool({ name: 'visit_message', arguments: { worker: 'Bob', kind: 'tell', text: 'routine heads-up: the API moved' } });
  assert.equal(told.isError, undefined);
  assert.equal((told.structuredContent as Record<string, unknown>).blocked, undefined);
  const urgent = calls.length;
  await aliceClient.callTool({ name: 'visit_message', arguments: { worker: 'Bob', kind: 'tell', text: 'chatter', urgent: true } });
  assert.equal(calls.length, urgent, 'urgent tells skip the gate');
});

test('a held team event flushes with its live log state, not the copy queued when it was held', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grok-live-event-'));
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
  const listeners = new Set<(signal: TeamSignal) => void>();
  const log = new Map<number, TeamEvent>();
  const team = {
    subscribe: (fn: (signal: TeamSignal) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    roster: () => [],
    eventBySeq: undefined as ((seq: number) => TeamEvent | undefined) | undefined,
  };
  const floor = { id: 'alpha', dir, def: { name: 'Droid Office' }, workers: { get: () => undefined, list: () => [] }, team } as unknown as RemoteFloor;
  const office = new RemoteOffice(store, () => [floor], { webhookDelayMs: 10 });
  rig.after(() => office.stop());
  const grok = office.add('grokbot', { webhookUrl: receiver.url, webhookToken: DUMMY_TOKEN });
  const emit = (signal: TeamSignal) => {
    for (const fn of listeners) fn(signal);
  };
  const event = (seq: number, text: string, gate?: 'held'): TeamEvent => ({ seq, lead: grok.worker.id, worker: 'sub-1', name: 'Worker1', kind: 'report', text, at: 1, ...(gate ? { gate } : {}) });
  const textOf = (n: number) => (receiver.received[n]!.body.items as { text?: string }[]).map((i) => i.text);

  // Without a live log, the release signal's newer copy replaces the queued one in place.
  emit({ type: 'gate', event: event(1, 'queued while held', 'held'), traffic: 'hold_for_batch' });
  emit({ type: 'gate', event: event(1, 'released copy'), traffic: 'wake_immediately' });
  await receiver.waitForCount(1);
  assert.deepEqual(textOf(0), ['released copy']);

  // With the team's log, the flushed item reads the event as it stands at delivery time.
  team.eventBySeq = (seq) => (log.has(seq) ? { ...log.get(seq)! } : undefined);
  log.set(2, event(2, 'reviewed in the log since'));
  emit({ type: 'gate', event: event(2, 'queued while held', 'held'), traffic: 'hold_for_batch' });
  emit({ type: 'gate', event: event(2, 'released copy'), traffic: 'wake_immediately' });
  await receiver.waitForCount(2);
  assert.deepEqual(textOf(1), ['reviewed in the log since']);
  assert.equal(receiver.received.length, 2);
});
