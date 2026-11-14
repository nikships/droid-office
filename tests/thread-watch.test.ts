import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { CloudWorkers } from '../src/server/cloud-workers.js';
import { FactoryApi } from '../src/server/factory/api.js';
import { mountCloud, type CloudFeature, type CloudFloor } from '../src/server/factory/cloud.js';
import type { FeatureHost } from '../src/server/factory/feature.js';
import type { FactoryRegistry } from '../src/server/factory/registry.js';
import { ThreadWatchHub, type ThreadPushMsg, type WatchedThreadTarget } from '../src/server/thread-watch.js';
import { WorkerThreadReader } from '../src/server/worker-thread.js';
import { computerOf } from '../src/shared/factory-computers.js';
import { DESKS } from '../src/shared/layout.js';
import { ORCHESTRATOR_ID } from '../src/shared/mission-control.js';

const message = (id: string, role: string, text: string) => ({
  type: 'message',
  id,
  timestamp: '2026-11-13T12:00:00.000Z',
  message: { role, content: [{ type: 'text', text }] },
});

const jsonl = (...rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

async function waitUntil(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for thread push');
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function setupHub(t: TestContext, maxWatchesPerClient = 16) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-thread-watch-'));
  const sessionsDir = path.join(root, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const reader = new WorkerThreadReader(sessionsDir);
  const targets = new Map<string, WatchedThreadTarget>();
  const sent: { clientId: string; msg: ThreadPushMsg }[] = [];

  const hub = new ThreadWatchHub({
    workerThreads: reader,
    resolveWorker: (id) => targets.get(id),
    send: (clientId, msg) => sent.push({ clientId, msg }),
    localCoalesceMs: 25,
    cloudCoalesceMs: 20,
    maxWatchesPerClient,
  });

  t.after(async () => {
    hub.close();
    await rm(root, { recursive: true, force: true });
  });

  return { root, sessionsDir, reader, targets, sent, hub };
}

test('local fs.watch pushes coalesced snapshots on JSONL appends, busy transitions and pre-file creation', async (t) => {
  const { root, sessionsDir, reader, targets, sent, hub } = await setupHub(t);
  const cwd = path.join(root, 'project-a');
  await mkdir(cwd, { recursive: true });
  const source = { sessionId: 'sess-alpha-1', cwd };

  // Start watching BEFORE the session slug folder or .jsonl file exists on disk.
  targets.set('w1', { kind: 'local', floorId: 'f1', busy: true, local: source });
  assert.equal(hub.watch('c1', 'w1', true), true);
  assert.equal(sent.length, 0);

  const slugDir = path.join(sessionsDir, cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
  await mkdir(slugDir, { recursive: true });
  const file = path.join(slugDir, `${source.sessionId}.jsonl`);
  await writeFile(
    file,
    jsonl({ type: 'session_start', id: source.sessionId, cwd }, message('m1', 'user', 'Hello Byte'), {
      type: 'message',
      id: 'm2',
      timestamp: '2026-11-13T12:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/tmp/a.ts' } }] },
    }),
  );

  await waitUntil(() => sent.length >= 1);
  assert.equal(sent[0].clientId, 'c1');
  assert.equal(sent[0].msg.push, true);
  assert.equal(sent[0].msg.request, 'push');
  assert.equal(sent[0].msg.entries.length, 2);
  const firstActivity = sent[0].msg.presentation?.rows.find((r) => r.kind === 'activity');
  assert.ok(firstActivity?.kind === 'activity' && firstActivity.live === true);

  // Rapid appends coalesce and push updated entries.
  const countBeforeAppend = sent.length;
  await appendFile(
    file,
    jsonl(
      {
        type: 'message',
        id: 'm3',
        timestamp: '2026-11-13T12:00:02.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'export const a = 1;' }] },
      },
      message('m4', 'assistant', 'Checked the file.'),
    ),
  );

  await waitUntil(() => sent.some((s) => s.msg.entries.some((e) => e.text === 'Checked the file.')));
  assert.ok(sent.length >= countBeforeAppend + 1);

  // Turn ends (`busy: true -> false`) with NO new JSONL line: notifyWorker pushes live -> false transition.
  await appendFile(
    file,
    jsonl({
      type: 'message',
      id: 'm5',
      timestamp: '2026-11-13T12:00:03.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-2', name: 'Read', input: { file_path: '/tmp/b.ts' } }] },
    }),
  );
  await waitUntil(() => sent.some((s) => s.msg.entries.some((e) => e.id === 'tool:call-2')));

  const beforeIdle = sent.length;
  targets.set('w1', { kind: 'local', floorId: 'f1', busy: false, local: source });
  hub.notifyWorker('w1');
  await waitUntil(() => sent.length > beforeIdle);
  const idleSnap = sent.at(-1)!.msg;
  const trailing = idleSnap.presentation?.rows.at(-1);
  assert.ok(trailing?.kind === 'activity');
  assert.equal(trailing.live, false);
  assert.equal(trailing.state, 'incomplete');

  // Calling notifyWorker again when nothing changed does not re-push.
  const countStable = sent.length;
  hub.notifyWorker('w1');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sent.length, countStable);

  // Seeded snapshot suppresses duplicate push on unchanged wake.
  const cwd2 = path.join(root, 'project-b');
  await mkdir(cwd2, { recursive: true });
  const src2 = { sessionId: 'sess-beta-2', cwd: cwd2 };
  const slug2 = path.join(sessionsDir, cwd2.replace(/[^a-zA-Z0-9-]/g, '-'));
  await mkdir(slug2, { recursive: true });
  await writeFile(path.join(slug2, `${src2.sessionId}.jsonl`), jsonl({ type: 'session_start', id: src2.sessionId, cwd: cwd2 }, message('b1', 'user', 'Seeded')));
  targets.set('w2', { kind: 'local', floorId: 'f1', busy: false, local: src2 });
  hub.watch('c1', 'w2', true);
  const hydrated = await reader.read(src2, undefined, false);
  hub.seed('w2', hydrated, false);
  const afterSeed = sent.length;
  hub.notifyWorker('w2');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sent.length, afterSeed);
});

test('cleanup preserves ORCHESTRATOR_ID on floor change and tears down on disconnect, worker removal and cap', async (t) => {
  const { targets, hub } = await setupHub(t, 2);
  targets.set(ORCHESTRATOR_ID, { kind: 'local', floorId: null, busy: false });
  targets.set('w1', { kind: 'local', floorId: 'f1', busy: false });
  targets.set('w2', { kind: 'local', floorId: 'f1', busy: false });

  assert.equal(hub.watch('c1', ORCHESTRATOR_ID, true), true);
  assert.equal(hub.watch('c1', 'w1', true), true);
  assert.equal(hub.watchedCount('c1'), 2);

  // Exceeding maxWatchesPerClient (2) evicts the oldest watch for c1 (ORCHESTRATOR_ID).
  assert.equal(hub.watch('c1', 'w2', true), true);
  assert.equal(hub.watchedCount('c1'), 2);
  assert.equal(hub.watchedCount(), 2);

  // Re-watch ORCHESTRATOR_ID (evicts w1), then leave floor with keepOrchestrator = true -> keeps ORCHESTRATOR_ID, drops w2.
  hub.watch('c1', ORCHESTRATOR_ID, true);
  hub.unwatchClient('c1', true);
  assert.equal(hub.watchedCount('c1'), 1);
  assert.equal(hub.watchedCount(), 1);

  // Explicit unwatch and unknown worker rejection.
  assert.equal(hub.watch('c1', 'missing-worker', true), false);
  hub.unwatchWorker(ORCHESTRATOR_ID);
  assert.equal(hub.watchedCount('c1'), 0);
  assert.equal(hub.watchedCount(), 0);
});

test('cloud stream events notify ThreadWatchHub and push coalesced snapshots without extra REST calls', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'office-cloud-watch-'));
  const cloudStore = new CloudWorkers(dir, { deskTaken: () => false, names: () => [], pool: { names: ['Cloudy'], colors: ['#fff'] } }, { update: () => {}, remove: () => {} });
  const floor: CloudFloor = { id: 'f1', name: 'proj', cloud: cloudStore, unstage: () => {} };
  const orb = computerOf({ id: 'orb-1', name: 'orb', providerType: 'e2b', status: 'active', createdAt: 1, remoteUser: 'factory-user' })!;

  let restMessagesCalls = 0;
  const api = new FactoryApi('fk-test-123', (async (input: string | URL | Request, init: RequestInit = {}) => {
    const p = `${init.method ?? 'GET'} ${new URL(String(input)).pathname.replace(/^\/api\/v0/, '')}`;
    if (p === 'POST /sessions') return new Response(JSON.stringify({ sessionId: 'cs-1' }), { status: 201, headers: { 'content-type': 'application/json' } });
    if (p === 'GET /sessions/cs-1/messages') {
      restMessagesCalls++;
      return new Response(JSON.stringify({ messages: [], pagination: { hasMore: false, nextCursor: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);

  let hubRef: ThreadWatchHub | undefined;
  const sent: ThreadPushMsg[] = [];
  const registry = {
    register: (make: (host: FeatureHost) => CloudFeature) => make({ changed: () => {}, pollSoon: () => {}, api: () => api, toast: () => {} }),
    feature: (k: string) => (k === 'computers' ? { state: () => ({ items: [orb], instances: [], metrics: {}, providers: [], waking: {}, secrets: [], fetchedAt: 1 }) } : undefined),
  } as unknown as FactoryRegistry;

  let streamHooks: {
    snapshot?: (id: string, snap: Record<string, unknown>, sup: { state: boolean; settings: boolean; title: boolean }) => void;
    notification?: (id: string, n: Record<string, unknown>) => void;
  } = {};

  const mounted = mountCloud(registry, {
    key: () => 'fk-test-123',
    streamClient: (opts) => {
      streamHooks = {
        snapshot: (snap, sup = { state: false, settings: false, title: false }) => opts.onSnapshot(snap, sup),
        notification: (n) => opts.onNotification(n),
      } as never;
      return { close: () => {}, healthy: () => true } as never;
    },
    floors: () => [floor],
    agentArgs: [],
    toast: () => {},
    onThreadChange: (workerId) => hubRef?.notifyWorker(workerId),
  });

  const reader = new WorkerThreadReader(path.join(dir, 'sessions'));
  const hub = new ThreadWatchHub({
    workerThreads: reader,
    resolveWorker: (id) => {
      const found = mounted.find(id);
      if (!found) return undefined;
      return { kind: 'cloud', floorId: found.floor.id, busy: found.info.status === 'working' || found.info.status === 'starting' };
    },
    readCloud: (id) => mounted.thread(id),
    send: (_clientId, msg) => sent.push(msg),
    cloudCoalesceMs: 20,
  });
  hubRef = hub;

  t.after(async () => {
    hub.close();
    mounted.feature.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const desk = DESKS.find((d) => !d.beanbag)!;
  const hired = await mounted.hire({ floor: 'f1', deskId: desk.id, computerId: 'orb-1', prompt: '' }, 'Nik');
  assert.ok(typeof hired !== 'string');

  // Simulate healthy stream on CloudFeature's internal stream via threads + streamEvent.
  Reflect.set(mounted.feature.stream!, 'healthy', () => true);
  hub.watch('c1', hired.id, true);

  mounted.feature.threads.streamSnapshot('cs-1', [{ id: 'u1', role: 'user', createdAt: 10, seq: 1, content: [{ type: 'text', text: 'Ship it' }] }], false);
  Reflect.get(mounted.feature, 'streamState').call(mounted.feature, 'cs-1', 'working');
  Reflect.get(mounted.feature, 'streamEvent').call(mounted.feature, 'cs-1', {
    type: 'assistant_text_delta',
    messageId: 'a1',
    blockIndex: 0,
    textDelta: 'Working on ',
  });
  Reflect.get(mounted.feature, 'streamEvent').call(mounted.feature, 'cs-1', {
    type: 'assistant_text_delta',
    messageId: 'a1',
    blockIndex: 0,
    textDelta: 'the fix.',
  });
  void streamHooks;

  await waitUntil(() => sent.length >= 1);
  assert.equal(restMessagesCalls, 0, 'held CloudStream state serves thread pushes without REST calls');
  assert.equal(sent.at(-1)?.push, true);
  assert.equal(sent.at(-1)?.entries.at(-1)?.text, 'Working on the fix.');
});
