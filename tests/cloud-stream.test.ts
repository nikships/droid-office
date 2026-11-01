import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudWorkers } from '../src/server/cloud-workers.js';
import { FactoryApi } from '../src/server/factory/api.js';
import { CloudFeature, type CloudOptions } from '../src/server/factory/cloud.js';
import { CloudStream, type CloudStreamClient, type CloudStreamSource } from '../src/server/factory/cloud-stream.js';
import { CloudStreamMessages } from '../src/server/factory/cloud-stream-messages.js';
import { CloudThreadReader } from '../src/server/factory/cloud-thread.js';
import { cloudEntries } from '../src/shared/cloud-thread.js';
import { messageOf, TEXT_MAX, type FactoryMessage } from '../src/shared/factory-sessions.js';
import { DESKS } from '../src/shared/layout.js';
import { presentThread } from '../src/shared/thread-presentation.js';

const KEY = 'fk-test-stream-1234';
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const jitter = () => new Promise<void>((resolve) => setTimeout(resolve, Math.random() * 4));
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Real Mac Mini relay events from /tmp/stream-spike/bridge-live-events.json (2026-11-01),
// identifiers replaced, metadata omitted, directory output trimmed to its non-private exit line.
const USER = { id: 'user-message', role: 'user', createdAt: 1793516009543, seq: 4, content: [{ type: 'text', text: 'Run `ls` once in the current directory, then reply with: ok. Do not read file contents or do anything else.' }] };
const TOOL = { type: 'tool_use', id: 'tool-use', input: { command: 'ls', summary: 'List files in current directory', riskLevel: 'low' }, name: 'Execute' };
const CALL = { id: 'tool-message', role: 'assistant', createdAt: 1793516010615, seq: 5, content: [TOOL] };
const RESULT = { type: 'tool_result', toolUseId: 'tool-use', content: '[Process exited with code 0]', isError: false, messageId: 'tool-result' };
const DELTA = { type: 'assistant_text_delta', messageId: 'assistant-message', blockIndex: 0, textDelta: 'ok' };
const ASSISTANT = { id: 'assistant-message', role: 'assistant', createdAt: 1793516011816, seq: 9, content: [{ type: 'text', text: 'ok' }] };
const COMPLETE = {
  type: 'agent_turn_completed',
  reason: 'completed',
  turnId: USER.id,
  durationMs: 2333,
  tokenUsage: { inputTokens: 657, outputTokens: 63, cacheCreationTokens: 0, cacheReadTokens: 26176, thinkingTokens: 0, factoryCredits: 549 },
};
const COMPUTER = {
  id: 'computer',
  providerType: 'byom',
  relayClientUrl: 'wss://relay.factory.ai/v0/computer/computer/client',
  computerIdentity: { publicKey: 'GtSzvU7iBsjXE/Hi8VyK52xPMo2Z3DJ0SLzNwIkvDUc=', keyId: 'test-key-id', algorithm: 'X25519' },
};
const parsed = (raw: readonly unknown[]) => raw.map(messageOf).filter((m): m is FactoryMessage => !!m);

class Client implements CloudStreamClient {
  message: (message: unknown) => void = () => {};
  closed: () => void = () => {};
  error: (error: Error) => void = () => {};
  loads: string[] = [];
  urls: string[] = [];
  auth?: unknown;
  disconnected = 0;
  failure = false;
  gate?: Promise<void>;
  duringLoad?: () => void;
  snapshot: Record<string, unknown> = { session: { messages: [USER] }, workingState: 'idle', hasOlderMessages: false };
  async connect(url: string) {
    this.urls.push(url);
    await jitter();
    if (this.failure) throw new Error('Failed to send secure-channel hello');
  }
  async authenticate(params: unknown) {
    this.auth = params;
    await jitter();
  }
  async loadSession(params: { sessionId: string }) {
    this.loads.push(params.sessionId);
    this.duringLoad?.();
    await this.gate;
    await jitter();
    return this.snapshot;
  }
  onTransportMessage(handler: (message: unknown) => void) {
    this.message = handler;
  }
  onConnectionClose(handler: () => void) {
    this.closed = handler;
  }
  onConnectionError(handler: (error: Error) => void) {
    this.error = handler;
  }
  disconnect() {
    this.disconnected++;
  }
  notify(notification: unknown, sessionId = 'session') {
    this.message({ type: 'notification', method: 'daemon.session_notification', params: { sessionId, notification } });
  }
}

function rig(t: test.TestContext) {
  let key: string | undefined = KEY;
  let connected = true;
  let now = 1_000_000;
  let sources: CloudStreamSource[] = [{ computerId: 'computer', sessionId: 'session' }];
  let computer: unknown = COMPUTER;
  const clients: Client[] = [];
  const warnings: string[] = [];
  const discoveries: string[] = [];
  const snapshots: string[] = [];
  const notifications: string[] = [];
  let reset = 0;
  let prepare: (client: Client) => void = () => {};
  const api = new FactoryApi(KEY, (async (url: string) => {
    discoveries.push(String(url));
    await jitter();
    return json(computer);
  }) as typeof fetch);
  const reader = new CloudThreadReader(() => (connected ? api : undefined), { now: () => now, streaming: (id) => stream.healthy(id) });
  const stream = new CloudStream({
    api: () => (connected ? api : undefined),
    key: () => key,
    sources: () => sources,
    now: () => now,
    client: (c, k, refresh) => {
      assert.equal(c.id, 'computer');
      assert.equal(k, key);
      assert.equal(c.computerIdentity?.keyId, COMPUTER.computerIdentity.keyId);
      assert.equal(typeof refresh, 'function');
      const client = new Client();
      prepare(client);
      clients.push(client);
      return client;
    },
    reset: () => {
      reset++;
      reader.clear();
    },
    warn: (m) => warnings.push(m),
    snapshot: (id, s) => {
      snapshots.push(id);
      reader.streamSnapshot(id, (s.session as { messages: unknown[] }).messages);
    },
    notification: (id, n) => {
      notifications.push(String(n.type));
      reader.streamEvent(id, n);
    },
  });
  t.after(() => stream.stop());
  return {
    stream,
    reader,
    clients,
    warnings,
    discoveries,
    snapshots,
    notifications,
    key: (value?: string) => {
      key = value;
    },
    connected: (value: boolean) => {
      connected = value;
    },
    sources: (value: CloudStreamSource[]) => {
      sources = value;
    },
    clock: (ms: number) => {
      now += ms;
    },
    computer: (value: unknown) => {
      computer = value;
    },
    prepare: (fn: (client: Client) => void) => {
      prepare = fn;
    },
    resets: () => reset,
  };
}

test('live messages: text/thinking deltas, final upsert, seq adoption and late REST protection', () => {
  const messages = new CloudStreamMessages(parsed([USER]));
  messages.event({ ...DELTA, textDelta: 'o' });
  const provisional = cloudEntries(messages.values()).at(-1)!;
  assert.equal(provisional.text, 'o');
  messages.event({ ...DELTA, textDelta: 'k' });
  assert.equal(cloudEntries(messages.values()).at(-1)!.text, 'ok');
  messages.event({ type: 'create_message', message: ASSISTANT });
  messages.event({ type: 'create_message', message: ASSISTANT });
  messages.event({ ...DELTA, textDelta: 'not duplicated' });
  messages.snapshot([{ ...ASSISTANT, content: [{ type: 'text', text: 'o' }] }]);
  assert.deepEqual(
    cloudEntries(messages.values()).map((e) => e.text),
    [USER.content[0].text, 'ok'],
  );
  assert.equal(cloudEntries(messages.values()).at(-1)!.id, provisional.id);
  assert.equal(cloudEntries(messages.values()).at(-1)!.seq, 9 * 256);
  // Mutation of the measured delta shape exercises the equivalent thinking event and block index.
  messages.event({ ...DELTA, type: 'thinking_text_delta', messageId: 'thinking', textDelta: 'Considering' });
  messages.event({ ...DELTA, type: 'thinking_text_delta', messageId: 'thinking', textDelta: ' a plan' });
  assert.equal(cloudEntries(messages.values()).at(-1)!.kind, 'thinking');
  assert.equal(cloudEntries(messages.values()).at(-1)!.text, 'Considering a plan');
  messages.event({ type: 'assistant_message_retracted', messageId: 'thinking' });
  messages.snapshot([{ ...ASSISTANT, id: 'thinking' }]);
  assert.equal(cloudEntries(messages.values()).length, 2);
  const pending = new CloudStreamMessages();
  pending.event({ ...DELTA, textDelta: 'o' });
  pending.snapshot([ASSISTANT]);
  pending.event({ ...DELTA, textDelta: '!' });
  assert.equal(cloudEntries(pending.values()).at(-1)!.text, 'ok!');
});

test('thread cache: sessions the stream fills are never evicted by others', () => {
  const reader = new CloudThreadReader(() => undefined);
  for (let i = 0; i < 9; i++) reader.streamSnapshot(`live-${i}`, [{ ...USER, id: `user-${i}` }]);
  reader.streamEvent('live-0', { ...DELTA, textDelta: 'o' });
  reader.streamEvent('live-0', { ...DELTA, textDelta: 'k' });
  for (let i = 0; i < 9; i++) assert.equal(reader.messages(`live-${i}`).length, i === 0 ? 2 : 1, `live-${i} kept its held messages`);
  assert.equal(cloudEntries(reader.messages('live-0')).at(-1)?.text, 'ok', 'deltas build on the snapshot, not on an empty base');
  reader.forget('live-3');
  assert.equal(reader.messages('live-3').length, 0);
});

test('live messages: tool arguments grow, canonical calls dedupe, results correlate and REST enriches seq', () => {
  const messages = new CloudStreamMessages(parsed([USER]));
  messages.event({ type: 'tool_call', toolUse: { ...TOOL, input: {} } });
  messages.event({ type: 'tool_call', toolUse: TOOL });
  const provisional = cloudEntries(messages.values()).find((e) => e.kind === 'tool')!;
  assert.equal(JSON.parse(provisional.input!).command, 'ls');
  messages.event({ type: 'create_message', message: CALL });
  messages.event(RESULT);
  messages.event(RESULT);
  messages.snapshot([CALL, { id: RESULT.messageId, role: 'tool', createdAt: 1793516011000, seq: 8, content: [RESULT] }]);
  const tools = cloudEntries(messages.values()).filter((e) => e.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].id, provisional.id);
  assert.equal(tools[0].seq, 5 * 256);
  assert.equal(tools[0].resultSeq, tools[0].seq + 1);
  assert.equal(tools[0].output, RESULT.content);
  assert.equal(tools[0].error, false);
  messages.event({ ...RESULT, isError: true });
  assert.equal(cloudEntries(messages.values()).find((e) => e.kind === 'tool')!.error, true);
});

test('live messages: an interrupted streamed tool result presents as cancelled, not failed', () => {
  const messages = new CloudStreamMessages(parsed([USER]));
  messages.event({ type: 'create_message', message: CALL });
  // The cancellation text is the real interrupted Mac Mini Execute result in cloud-thread.test.ts.
  messages.event({ ...RESULT, content: 'Tool execution cancelled by user', isError: true });
  const entries = cloudEntries(messages.values());
  const tool = entries.find((e) => e.kind === 'tool')!;
  assert.equal(tool.resultSeq, tool.seq + 1);
  const activity = presentThread(entries, false).find((row) => row.kind === 'activity');
  assert.ok(activity?.kind === 'activity');
  assert.equal(activity.state, 'cancelled');
});

test('live messages: snapshots without seq, hidden context, invalid deltas and bounded output', () => {
  const messages = new CloudStreamMessages();
  messages.snapshot([
    { ...USER, seq: undefined },
    { ...ASSISTANT, seq: undefined },
  ]);
  const seq = messages.values().at(-1)!.seq;
  messages.event({ ...DELTA, textDelta: ' again' });
  assert.equal(cloudEntries(messages.values()).at(-1)!.text, 'ok again');
  assert.equal(messages.values().at(-1)!.seq, seq);
  messages.event({ type: 'create_message', message: { ...ASSISTANT, visibility: 'llm_only' } });
  assert.equal(messages.values().length, 1);
  for (const n of [null, { ...DELTA, blockIndex: -1 }, { ...DELTA, blockIndex: 256 }, { ...DELTA, textDelta: null }, { type: 'tool_call' }, { type: 'tool_result' }]) messages.event(n);
  messages.event({ ...DELTA, messageId: 'bounded', textDelta: 'x'.repeat(TEXT_MAX + 1000) });
  assert.equal(messages.values().at(-1)!.blocks[0].type, 'text');
  assert.equal((messages.values().at(-1)!.blocks[0] as { text: string }).text.length, TEXT_MAX);
  messages.merge(parsed(Array.from({ length: 1505 }, (_, i) => ({ ...ASSISTANT, id: `bounded-${i}`, seq: i + 20 }))));
  assert.equal(messages.values().length, 1500);
  messages.merge(parsed([USER]), true);
  assert.equal(messages.values().length, 1500);
  assert.equal(messages.values()[0].id, USER.id);
});

test('relay: one pinned connection serves multiple sessions; no permission or AskUser responses', async (t) => {
  const r = rig(t);
  r.sources([
    { computerId: 'computer', sessionId: 'session' },
    { computerId: 'computer', sessionId: 'second' },
  ]);
  r.prepare((client) => {
    client.duringLoad = () => client.notify(DELTA);
  });
  await r.stream.sync();
  assert.equal(r.clients.length, 1);
  assert.deepEqual(r.clients[0].urls, [COMPUTER.relayClientUrl]);
  assert.deepEqual(r.clients[0].loads, ['session', 'second']);
  assert.equal(r.stream.healthy('session'), true);
  assert.equal(r.stream.healthy('second'), true);
  assert.equal(r.stream.healthy('other'), false);
  assert.deepEqual(r.snapshots, ['session', 'second']);
  assert.ok(r.notifications.includes('assistant_text_delta'));
  const before = r.notifications.length;
  r.clients[0].message({ type: 'request', method: 'daemon.request_permission', params: { sessionId: 'session' } });
  r.clients[0].message({ type: 'request', method: 'daemon.ask_user', params: { sessionId: 'session' } });
  r.clients[0].notify(DELTA, 'unrelated');
  assert.equal(r.notifications.length, before);
  await r.stream.sync();
  assert.equal(r.clients[0].loads.length, 2);
  r.clients[0].notify({ type: 'session_unsubscribed' });
  assert.equal(r.stream.healthy('session'), false);
  await r.stream.sync();
  assert.equal(r.stream.healthy('session'), true);
  assert.equal(r.clients[0].loads.length, 3);
  r.sources([{ computerId: 'computer', sessionId: 'second' }]);
  await r.stream.sync();
  assert.equal(r.stream.healthy('session'), false);
  assert.equal(r.clients[0].disconnected, 0);
  r.sources([]);
  await r.stream.sync();
  assert.equal(r.clients[0].disconnected, 1);
});

test('relay: failure keeps REST usable, logs once, backs off 30s to 5min and recovers', async (t) => {
  const r = rig(t);
  r.prepare((client) => {
    client.failure = true;
  });
  await r.stream.sync();
  assert.equal(r.stream.healthy('session'), false);
  assert.equal(r.warnings.length, 1);
  assert.ok(!r.warnings[0].includes(KEY));
  await r.stream.sync();
  assert.equal(r.clients.length, 1);
  for (const wait of [30_000, 60_000, 120_000, 240_000, 300_000]) {
    r.clock(wait - 1);
    const count = r.clients.length;
    await r.stream.sync();
    assert.equal(r.clients.length, count);
    r.clock(1);
    await r.stream.sync();
    assert.equal(r.clients.length, count + 1);
  }
  assert.equal(r.warnings.length, 1);
  r.prepare(() => {});
  r.clock(300_000);
  await r.stream.sync();
  assert.equal(r.stream.healthy('session'), true);
  r.clients.at(-1)!.error(new Error(`Untrusted error containing ${KEY}`));
  assert.equal(r.stream.healthy('session'), false);
  assert.equal(r.warnings.length, 2);
  assert.ok(r.warnings.every((m) => !m.includes(KEY)));
  r.clock(30_000);
  await r.stream.sync();
  r.clients.at(-1)!.closed();
  assert.equal(r.stream.healthy('session'), false);
  // A REST reader still works after this connection failure.
  const api = new FactoryApi(KEY, (async () => json({ messages: [ASSISTANT] })) as typeof fetch);
  const reader = new CloudThreadReader(() => api);
  assert.equal((await reader.read({ sessionId: 'session', busy: true, createdAt: 0 })).entries[0].text, 'ok');
});

test('relay: credential replacement/rejection and shutdown discard in-flight events and snapshots', async (t) => {
  const r = rig(t);
  const gate = deferred();
  const loading = deferred();
  r.prepare((client) => {
    client.gate = gate.promise;
    client.duringLoad = loading.resolve;
  });
  const pending = r.stream.sync();
  await loading.promise;
  r.key(undefined);
  await r.stream.sync();
  const count = r.notifications.length;
  r.clients[0].notify(DELTA);
  gate.resolve();
  await pending;
  assert.equal(r.snapshots.length, 0);
  assert.equal(r.notifications.length, count);
  assert.equal(r.clients[0].disconnected, 1);
  r.prepare(() => {});
  r.key('fk-test-replacement');
  await r.stream.sync();
  assert.equal(r.stream.healthy('session'), true);
  r.connected(false);
  await r.stream.sync();
  assert.equal(r.stream.healthy('session'), false);
  assert.ok(r.resets() >= 4);
  r.stream.stop();
  r.connected(true);
  r.stream.start();
  await r.stream.sync();
  assert.equal(r.clients.length, 2);
});

test('relay: invalid discovery cannot downgrade a published pin or send credentials to another host', async (t) => {
  for (const computer of [{ ...COMPUTER, relayClientUrl: 'wss://untrusted.example/client' }, { ...COMPUTER, computerIdentity: { keyId: 'broken' } }, {}]) {
    const r = rig(t);
    r.computer(computer);
    await r.stream.sync();
    assert.equal(r.clients.length, 0);
    assert.equal(r.stream.healthy('session'), false);
    assert.equal(r.warnings.length, 1);
  }
});

test('reader: healthy streams slow REST reads and stale pages never clobber deltas or canonical results', async () => {
  let now = 1000;
  let reads = 0;
  let healthy = true;
  const api = new FactoryApi(KEY, (async () => {
    reads++;
    await jitter();
    return json({ messages: [USER, { ...ASSISTANT, content: [{ type: 'text', text: 'o' }] }] });
  }) as typeof fetch);
  const reader = new CloudThreadReader(() => api, { now: () => now, streaming: () => healthy, busyEveryMs: 0 });
  const source = { sessionId: 'session', busy: true, createdAt: 0 };
  reader.streamSnapshot('session', [USER]);
  reader.streamEvent('session', DELTA);
  assert.equal((await reader.read(source)).entries.at(-1)!.text, 'ok');
  assert.equal(reads, 0);
  reader.absorb('session', [USER, { ...ASSISTANT, content: [{ type: 'text', text: 'o' }] }]);
  assert.equal((await reader.read(source)).entries.at(-1)!.text, 'ok');
  now += 60_001;
  assert.equal((await reader.read(source)).entries.at(-1)!.text, 'ok');
  assert.equal(reads, 1);
  healthy = false;
  await reader.read(source);
  assert.equal(reads, 1, 'fallback shares the background reconciliation already in flight');
  await reader.read(source);
  assert.equal(reads, 2);
});

test('cloud feature: stream events drive busy/tool/completion, stale REST cannot rewind them, and removal disconnects', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cloud-stream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cloud = new CloudWorkers(dir, { deskTaken: () => false, names: () => [], pool: { names: ['Ada'], colors: ['#fff'] } }, { update: () => {}, remove: () => {} });
  const worker = cloud.add({ deskId: DESKS.find((d) => !d.station && !d.beanbag)!.id, by: 'owner', sessionId: 'session', cloud: { computerId: 'computer', computerName: 'mac-mini', providerType: 'byom' } });
  let connected = true;
  const pollStarted = deferred();
  const pollAnswer = deferred();
  const client = new Client();
  const api = new FactoryApi(KEY, (async (url: string) => {
    if (String(url).includes('/computers/')) return json(COMPUTER);
    pollStarted.resolve();
    await pollAnswer.promise;
    return json({ sessionId: 'session', status: 'running', messageCount: 0, updatedAt: 1 });
  }) as typeof fetch);
  const feature = new CloudFeature(
    { api: () => (connected ? api : undefined), changed: () => {}, pollSoon: () => {}, toast: () => {} },
    {
      floors: () => [{ id: 'floor', name: 'project', cloud, unstage: () => {} }],
      computers: () => undefined,
      agentArgs: [],
      toast: () => {},
      key: () => (connected ? KEY : undefined),
      streamClient: () => client,
    },
  );
  t.after(() => feature.stop());
  await feature.stream!.sync();
  client.notify({ type: 'droid_working_state_changed', newState: 'thinking' });
  assert.equal(cloud.get(worker.id)!.status, 'working');
  client.notify({ type: 'droid_working_state_changed', newState: 'waiting_for_tool_confirmation' });
  assert.equal(cloud.get(worker.id)!.status, 'needs_input');
  client.notify({ type: 'droid_working_state_changed', newState: 'executing_tool' });
  client.notify({ type: 'tool_call', toolUse: TOOL });
  assert.match(cloud.get(worker.id)!.activity!, /ls|List files/);
  const poll = feature.poll(api);
  await pollStarted.promise;
  client.notify({ type: 'create_message', message: CALL });
  client.notify(RESULT);
  client.notify(DELTA);
  client.notify({ type: 'create_message', message: ASSISTANT });
  client.notify(COMPLETE);
  assert.equal(cloud.get(worker.id)!.status, 'done');
  assert.deepEqual(cloud.turn(worker.id), {});
  assert.equal(cloud.get(worker.id)!.activity, 'ok');
  pollAnswer.resolve();
  await poll;
  assert.equal(cloud.get(worker.id)!.status, 'done');
  const page = await feature.thread(worker.id);
  assert.ok(page!.entries.some((e) => e.kind === 'tool' && e.output === RESULT.content));
  // A turn that ended badly is over too: done, so the next message can go, with why in its activity.
  client.notify({ ...COMPLETE, reason: 'error' });
  assert.equal(cloud.get(worker.id)!.status, 'done');
  assert.equal(cloud.get(worker.id)!.activity, 'Factory session ended: error');
  connected = false;
  feature.connectionChanged();
  assert.equal(feature.stream!.healthy('session'), false);
  assert.equal(feature.threads.messages('session').length, 0);
  assert.equal(client.disconnected, 1);
  feature.reset();
});

function featureRig(t: test.TestContext, answer: (url: string) => Promise<Response>, credential = true, options: Partial<CloudOptions> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cloud-stream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cloud = new CloudWorkers(dir, { deskTaken: () => false, names: () => [], pool: { names: ['Ada'], colors: ['#fff'] } }, { update: () => {}, remove: () => {} });
  const worker = cloud.add({ deskId: DESKS.find((d) => !d.station && !d.beanbag)!.id, by: 'owner', sessionId: 'session', cloud: { computerId: 'computer', computerName: 'mac-mini', providerType: 'byom' } });
  let now = 1_000_000;
  let connected = credential;
  const toasts: { floor: string; text: string; level?: string }[] = [];
  const client = new Client();
  const api = new FactoryApi(KEY, (async (url: string) => {
    await jitter();
    return String(url).includes('/computers/') ? json(COMPUTER) : answer(String(url));
  }) as typeof fetch);
  const feature = new CloudFeature(
    { api: () => api, changed: () => {}, pollSoon: () => {}, toast: () => {} },
    {
      floors: () => [{ id: 'floor', name: 'project', cloud, unstage: () => {} }],
      computers: () => undefined,
      agentArgs: [],
      toast: (floor, text, level) => toasts.push({ floor, text, level }),
      key: () => (connected ? KEY : undefined),
      streamClient: () => client,
      now: () => now,
      ...options,
    },
  );
  t.after(() => feature.stop());
  return {
    cloud,
    dir,
    toasts,
    worker,
    feature,
    client,
    api,
    clock: () => {
      now++;
    },
    connect: () => {
      connected = true;
    },
  };
}

test('cloud feature: a stream starting during a delayed REST tail cannot rewind live state', async (t) => {
  const started = deferred();
  const answer = deferred();
  const r = featureRig(
    t,
    async (url) => {
      if (!url.endsWith('/messages?limit=20')) return json({ status: 'idle', messageCount: 2, updatedAt: 1 });
      started.resolve();
      await answer.promise;
      return json({ messages: [USER, ASSISTANT] });
    },
    false,
  );
  r.cloud.setStatus(r.worker.id, 'working');
  r.cloud.update(r.worker.id, (_, w) => {
    w.turn = { seenBusy: true };
  });
  const polling = r.feature.poll(r.api);
  await started.promise;
  r.connect();
  await r.feature.stream!.sync();
  r.client.notify({ type: 'droid_working_state_changed', newState: 'executing_tool' });
  r.client.notify({ type: 'tool_call', toolUse: TOOL });
  answer.resolve();
  await polling;
  assert.equal(r.cloud.get(r.worker.id)!.status, 'working');
  assert.match(r.cloud.get(r.worker.id)!.activity!, /ls|List files/);
});

test('cloud feature: prior completion cannot finish a newer prompt awaiting acceptance', async (t) => {
  const r = featureRig(t, async () => json({ status: 'running' }));
  await r.feature.stream!.sync();
  r.client.notify({ type: 'create_message', message: USER });
  r.clock();
  await r.feature.send(r.worker.id, 'Another harmless prompt', []);
  r.client.notify(COMPLETE);
  r.client.notify({ type: 'droid_working_state_changed', newState: 'idle' });
  assert.equal(r.cloud.get(r.worker.id)!.status, 'working');
  r.clock();
  r.client.notify({ type: 'create_message', message: { ...USER, id: 'next-user' } });
  r.client.notify({ type: 'droid_working_state_changed', newState: 'thinking' });
  r.client.notify({ ...COMPLETE, turnId: 'next-user' });
  assert.equal(r.cloud.get(r.worker.id)!.status, 'done');
});

test('cloud feature: idle snapshots finish restored turns but cannot rewind notifications during load', async (t) => {
  const restored = featureRig(t, async () => json({}));
  restored.cloud.setStatus(restored.worker.id, 'working');
  restored.cloud.update(restored.worker.id, (_, w) => {
    w.turn = { seenBusy: true };
  });
  await restored.feature.stream!.sync();
  assert.equal(restored.cloud.get(restored.worker.id)!.status, 'done');
  const active = featureRig(t, async () => json({}));
  active.client.duringLoad = () => active.client.notify({ type: 'droid_working_state_changed', newState: 'thinking' });
  await active.feature.stream!.sync();
  assert.equal(active.cloud.get(active.worker.id)!.status, 'working');
});

test('cloud feature: model substitutions warn once with catalogue names and keep the reported model', async (t) => {
  const names: Record<string, string> = { 'gpt-6-sol': 'GPT 6 Sol', 'deepseek-v4.1-flash-1017': 'DeepSeek V4.1 Flash 1017' };
  const r = featureRig(t, async () => json({}), true, { modelName: (id) => names[id] });
  r.cloud.update(r.worker.id, (i) => {
    i.model = 'deepseek-v4.1-flash-1017';
  });
  r.client.snapshot = { ...r.client.snapshot, settings: { modelId: 'gpt-6-sol', reasoningEffort: 'high' } };
  await r.feature.stream!.sync();
  assert.equal(r.cloud.get(r.worker.id)!.model, 'deepseek-v4.1-flash-1017');
  assert.equal(r.cloud.get(r.worker.id)!.activeModel, 'gpt-6-sol');
  assert.equal(r.cloud.get(r.worker.id)!.activeEffort, 'high');
  assert.deepEqual(r.toasts, [{ floor: 'floor', text: '☁ Factory runs Ada on GPT 6 Sol, not DeepSeek V4.1 Flash 1017', level: 'warn' }]);
  r.client.notify({ type: 'settings_updated', settings: { modelId: 'gpt-6-sol' } });
  r.client.notify({ type: 'settings_updated', settings: { modelId: 'glm-5.3-flash' } });
  assert.equal(r.cloud.get(r.worker.id)!.activeModel, 'glm-5.3-flash');
  r.feature.stream!.reset();
  await r.feature.stream!.sync();
  assert.equal(r.toasts.length, 1, 'reconnecting does not repeat the warning');
  const restored = new CloudWorkers(r.dir, { deskTaken: () => false, names: () => [], pool: { names: ['Ada'], colors: ['#fff'] } }, { update: () => {}, remove: () => {} });
  assert.equal(restored.get(r.worker.id)!.cloud?.modelMismatchWarned, true, 'the warning survives an office restart');
});

test('cloud feature: matching or missing models do not warn; REST substitutions warn with ids', async (t) => {
  const r = featureRig(t, async () => json({ status: 'idle', messageCount: 0, sessionSettings: { model: 'gpt-6-sol', reasoningEffort: 'high' } }), false);
  r.cloud.update(r.worker.id, (i) => {
    i.model = 'gpt-6-sol';
  });
  await r.feature.poll(r.api);
  assert.equal(r.toasts.length, 0);
  r.cloud.update(r.worker.id, (i) => {
    i.model = 'deepseek-v4.1-flash-1017';
  });
  r.feature.recheck(r.worker.id);
  await r.feature.poll(r.api);
  assert.equal(r.toasts[0].text, '☁ Factory runs Ada on gpt-6-sol, not deepseek-v4.1-flash-1017');
  assert.equal(r.cloud.get(r.worker.id)!.activeModel, 'gpt-6-sol');
  r.connect();
  await r.feature.stream!.sync();
  r.client.notify({ type: 'settings_updated', settings: {} });
  r.client.notify({ type: 'settings_updated', settings: { modelId: ' ' } });
  assert.equal(r.cloud.get(r.worker.id)!.activeModel, 'gpt-6-sol');
  assert.equal(r.toasts.length, 1);
});

test('reader: healthy text keeps growing while the minute REST reconciliation is delayed', async (t) => {
  let now = 1000;
  const started = deferred();
  const answer = deferred();
  t.after(answer.resolve);
  const api = new FactoryApi(KEY, (async () => {
    await jitter();
    started.resolve();
    await answer.promise;
    return json({ messages: [USER, ASSISTANT] });
  }) as typeof fetch);
  const reader = new CloudThreadReader(() => api, { now: () => now, streaming: () => true });
  const source = { sessionId: 'session', createdAt: 0, busy: true };
  reader.streamSnapshot('session', [USER]);
  // Same block-1 delta shape as the real 2,442-delta Mac Mini reply (thinking occupied block 0).
  reader.streamEvent('session', { ...DELTA, blockIndex: 1 });
  now += 60_001;
  let answered = false;
  const first = reader.read(source).then((page) => {
    answered = true;
    return page;
  });
  await started.promise;
  assert.equal(answered, true, 'a healthy stream must not wait for REST while live text arrives');
  assert.equal((await first).entries.at(-1)!.text, 'ok');
  reader.streamEvent('session', { ...DELTA, blockIndex: 1, textDelta: ' growing' });
  assert.equal((await reader.read(source)).entries.at(-1)!.text, 'ok growing');
});

test('reader: a long block-1 reply grows with every delta and has no completion jump', async () => {
  const api = new FactoryApi(KEY, (async () => {
    assert.fail('a healthy hydrated stream does not need REST before its reconciliation deadline');
  }) as typeof fetch);
  const reader = new CloudThreadReader(() => api, { now: () => 1000, streaming: () => true });
  const source = { sessionId: 'session', createdAt: 0, busy: true };
  reader.streamSnapshot('session', [USER]);
  let text = '';
  // Reproduce the long live run's event count and text block index, using scrubbed fixture text.
  for (let i = 0; i < 2442; i++) {
    text += DELTA.textDelta;
    reader.streamEvent('session', { ...DELTA, blockIndex: 1 });
    assert.equal((await reader.read(source)).entries.at(-1)!.text, text);
  }
  reader.streamEvent('session', {
    type: 'create_message',
    message: {
      ...ASSISTANT,
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text },
      ],
    },
  });
  reader.streamEvent('session', COMPLETE);
  assert.equal((await reader.read({ ...source, busy: false })).entries.at(-1)!.text, text);
  reader.absorb('session', [USER, ASSISTANT]);
  assert.equal((await reader.read(source)).entries.at(-1)!.text, text, 'a delayed short REST page cannot shrink the completed reply');
});

test('reader: a streamed snapshot with older history obtains a REST cursor and pages back', async () => {
  const requests: string[] = [];
  const api = new FactoryApi(KEY, (async (url: string) => {
    await jitter();
    requests.push(String(url));
    return json(String(url).includes('cursor=older') ? { messages: [{ ...USER, id: 'older-user', seq: 1 }], pagination: { hasMore: false } } : { messages: [USER, ASSISTANT], pagination: { hasMore: true, nextCursor: 'older' } });
  }) as typeof fetch);
  const reader = new CloudThreadReader(() => api, { streaming: () => true });
  reader.streamSnapshot('session', [USER, ASSISTANT], true);
  const page = await reader.read({ sessionId: 'session', createdAt: 0, busy: true }, 4 * 256);
  assert.equal(page.entries[0].id, 'older-user:0');
  assert.equal(page.hasMore, false);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].includes('cursor=older'));
});
