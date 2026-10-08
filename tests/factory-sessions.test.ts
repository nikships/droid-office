import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FactoryApi, FactoryError } from '../src/server/factory/api.js';
import { CreditLedger, dayKey } from '../src/server/factory/credits.js';
import type { FactoryRoute, FeatureHost } from '../src/server/factory/feature.js';
import { FactoryRegistry, type FactoryLink } from '../src/server/factory/registry.js';
import { SessionsFeature, type OfficeSessionRef } from '../src/server/factory/sessions.js';
import {
  IMAGE_MAX,
  artifactLabel,
  compactCredits,
  creditsNote,
  emptySessions,
  latestArtifacts,
  mergeMessages,
  messageOf,
  resultsByCall,
  sessionCredits,
  sessionOf,
  sessionWebUrl,
  sessionWhere,
  spanText,
  toolLine,
  type FactoryMessage,
  type FactorySession,
} from '../src/shared/factory-sessions.js';

const KEY = 'fk-test-sessions-5678';
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Factory as the feature sees it: an answer per `METHOD path`, or per path for any method. */
function factory(routes: Record<string, Handler>) {
  const seen: string[] = [];
  const bodies: { at: string; body: unknown }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    seen.push(`${method} ${url.pathname}${url.search}`);
    if (init.body) bodies.push({ at: `${method} ${url.pathname}`, body: JSON.parse(String(init.body)) });
    const r = routes[`${method} ${url.pathname}`] ?? routes[url.pathname] ?? routes['*'];
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return r ? await r(url, init) : json(404, { detail: `no ${url.pathname}` });
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
  return { api: new FactoryApi(KEY, fn), seen, bodies, maxInFlight: () => maxInFlight };
}

function host() {
  const toasts: string[] = [];
  let soon = 0;
  const h: FeatureHost & { toasts: string[]; soon: () => number } = {
    changed: () => {},
    pollSoon: () => soon++,
    api: () => undefined,
    toast: (t) => toasts.push(t),
    toasts,
    soon: () => soon,
  };
  return h;
}

const T0 = new Date(2026, 9, 7, 15, 0, 0).getTime();
const route = (f: SessionsFeature, method: string, p: string) => f.routes.find((r) => r.method === method && r.path === p) as FactoryRoute;
const call = (r: FactoryRoute, req: Record<string, unknown>) => Promise.resolve(r.handle({ params: {}, query: new URLSearchParams(), json: async () => ({}), by: 'Olive', ...req } as never));

test('polling: two pages, each session’s credits read a few at a time with running and the office’s own first, then cached by updatedAt', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'factory-sessions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = T0;
  const page1 = Array.from({ length: 50 }, (_, i) => ({ sessionId: `p1-${i}`, title: `One ${i}`, status: i === 7 ? 'running' : 'idle', createdAt: T0 - 9e6, updatedAt: T0 - 1000 * (i + 1), messageCount: i }));
  const page2 = Array.from({ length: 50 }, (_, i) => ({ sessionId: i === 0 ? 'p1-0' : `p2-${i}`, title: `Two ${i}`, status: 'idle', createdAt: T0 - 9e6, updatedAt: T0 - 100_000 - i, messageCount: 1 }));
  const credits = new Map<string, number>();
  const statusOf = new Map<string, string>([['p1-3', 'running']]);
  const f = factory({
    '/api/v0/sessions': (url) => (url.searchParams.get('cursor') ? json(200, { sessions: page2, pagination: { hasMore: true, nextCursor: 'c2' } }) : json(200, { sessions: page1, pagination: { hasMore: true, nextCursor: 'c1' } })),
    // Every single-session read answers with its credits (1000 more each time) and its own status.
    '*': (url) => {
      const id = decodeURIComponent(url.pathname.replace('/api/v0/sessions/', ''));
      if (id === 'gone') return json(404, { detail: 'Session not found' });
      const all = [...page1, ...page2, { sessionId: 'old-worker', title: 'Old', status: 'idle', createdAt: 1, updatedAt: 2, messageCount: 3 }];
      const s = all.find((x) => x.sessionId === id)!;
      const n = (credits.get(id) ?? 0) + 1000;
      credits.set(id, n);
      return json(200, { ...s, status: statusOf.get(id) ?? s.status, factoryCredits: n });
    },
  });
  const detailApi = f.api;
  const office: OfficeSessionRef[] = [
    { sessionId: 'p1-40', workerId: 'w1', name: 'Pixel', floor: 'droid-office', color: '#f00', working: true },
    { sessionId: 'old-worker', workerId: 'w2', name: 'Byte' },
    { sessionId: 'gone', workerId: 'w3', name: 'Ghost' },
  ];
  const h = host();
  const feature = new SessionsFeature(h, { dataDir: dir, officeSessions: () => office, now: () => now });
  await feature.poll(detailApi);
  const s = feature.state();
  assert.equal(s.items.length, 99, 'two pages, each session once');
  assert.equal(s.hasMore, true);
  assert.equal(s.fetchedAt, T0);
  assert.ok(f.maxInFlight() <= 3, 'at most three reads at once');
  // The first reads: the running ones (by the list, p1-7), then the office's own, then the newest.
  const read = [...credits.keys()];
  assert.equal(read.length + 1, 24, 'at most 24 single-session reads a poll (one of them the missing session)');
  assert.equal(read[0], 'p1-7');
  assert.ok(read.slice(0, 5).includes('p1-40') && read.slice(0, 5).includes('old-worker'), 'office workers’ sessions come early, even one past the list');
  const pixel = s.items.find((x) => x.id === 'p1-40')!;
  assert.equal(pixel.credits, 1000);
  assert.equal(s.items.find((x) => x.id === 'p1-3')?.status, 'running', 'a session’s own read says it runs, though the list says idle');
  assert.deepEqual(s.office['p1-40'], { workerId: 'w1', name: 'Pixel', floor: 'droid-office', color: '#f00', credits: 1000 });
  assert.equal(s.office['old-worker'].credits, 1000);
  assert.equal(s.office.gone.credits, undefined);
  assert.equal(sessionCredits(s, 'old-worker'), 1000);
  assert.equal(creditsNote(s, 'p1-40'), '⚡ 1k credits');
  assert.equal(creditsNote(s, undefined), '');
  assert.equal(s.credits.today, 22_000, 'every first sighting lands on the day it was last active (old-worker’s was long ago)');
  assert.ok(existsSync(path.join(dir, 'factory-credits.json')), 'the ledger is saved in the office’s .droid-office');

  // The next poll a minute on: the rest get read; the ones read already stay cached.
  now += 60_000;
  await feature.poll(detailApi);
  assert.equal(credits.get('p1-0'), 1000, 'unchanged updatedAt: no second read');
  assert.equal(credits.get('p1-3'), 2000, 'a running one is read again');
  assert.equal(credits.get('p1-40'), 2000, 'a working office worker’s, after a minute');
  assert.ok(!f.seen.slice(2).some((p) => p.includes('cursor=c1')), 'the second page is kept for 10 minutes');
  assert.equal(feature.state().items.find((x) => x.id === 'p1-3')?.credits, 2000);
  const ledger = feature.ledger.snapshot();
  assert.equal(ledger.days[dayKey(now)]['p1-3'], 2000, 'the increase since the last read goes on the day');

  // A new message: the list's updatedAt moves, so it's read again.
  page1[10].updatedAt = now;
  now += 1000;
  await feature.poll(detailApi);
  assert.equal(credits.get('p1-10'), 2000);
  assert.ok(feature.busy() === false, 'nothing runs on a Factory computer');

  // Reset forgets the slice and the ledger.
  feature.reset();
  assert.deepEqual(feature.state().items, []);
  assert.ok(!existsSync(path.join(dir, 'factory-credits.json')));
});

test('polling: a 401 on a single session stops the poll; anything else waits for later; the list failing keeps the last data', async () => {
  let mode: 'ok' | '401' | '500' = 'ok';
  const f = factory({
    '/api/v0/sessions': () => json(200, { sessions: [{ sessionId: 'a', title: 'A', status: 'running', computerId: 'orb', createdAt: 1, updatedAt: 5, messageCount: 1 }], pagination: { hasMore: false } }),
    '/api/v0/sessions/a': () =>
      mode === '401' ? json(401, { detail: 'bad key' }) : mode === '500' ? json(500, { detail: 'oops' }) : json(200, { sessionId: 'a', title: 'A', status: 'running', computerId: 'orb', createdAt: 1, updatedAt: 5, factoryCredits: 7 }),
  });
  let now = T0;
  const feature = new SessionsFeature(host(), { now: () => now });
  mode = '500';
  await feature.poll(f.api);
  assert.equal(feature.state().items[0].credits, undefined, 'a failed read is just not there yet');
  assert.ok(feature.busy(), 'a session running on a Factory computer polls fast');
  now += 30_000;
  const before = f.seen.length;
  await feature.poll(f.api);
  assert.equal(f.seen.length - before, 1, 'it waits two minutes before asking that session again');
  now += 3 * 60_000;
  mode = '401';
  await assert.rejects(
    () => feature.poll(f.api),
    (e: unknown) => e instanceof FactoryError && e.status === 401,
  );
  mode = 'ok';
  now += 3 * 60_000;
  await feature.poll(f.api);
  assert.equal(feature.state().items[0].credits, 7);
});

test('a cold GET /sessions that hangs times out after 60 s, tries once more, and the poll fails without losing the last data', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let hang = false;
  let calls = 0;
  const fetchImpl = ((_: unknown, init: RequestInit = {}) => {
    calls++;
    if (!hang) return Promise.resolve(json(200, { sessions: [{ sessionId: 'kept', title: 'Kept', status: 'idle', createdAt: 1, updatedAt: 1 }] }));
    return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  }) as typeof fetch;
  const api = new FactoryApi(KEY, fetchImpl);
  const feature = new SessionsFeature(host(), { now: () => T0 });
  // The single-session read of `kept` would hang too: give it a cached answer by reading once without hanging.
  const first = feature.poll(api);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await first.catch(() => {});
  hang = true;
  const before = calls;
  const polling = feature.poll(api);
  let settled = false;
  polling.then(
    () => (settled = true),
    () => (settled = true),
  );
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  await flush();
  t.mock.timers.tick(59_000);
  await flush();
  assert.equal(settled, false, 'still waiting at 59 s');
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(calls - before, 2, 'tried once more after the timeout');
  t.mock.timers.tick(60_000);
  await flush();
  await assert.rejects(polling, (e: unknown) => e instanceof FactoryError && e.timedOut && /within 60s/.test(e.message));
  feature.failed(new Error('timed out'));
  assert.equal(feature.state().items[0]?.id, 'kept', 'the last good list stays');
  assert.equal(feature.state().error, 'timed out');
});

test('the credits ledger: first sightings on the day last active, increases on the day spent, estimated before counting started, pruned, saved whole', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'factory-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'factory-credits.json');
  let now = T0;
  const day = 86_400_000;
  const l = new CreditLedger(file, () => now);
  assert.deepEqual(l.summary().days.length, 7);
  assert.equal(l.summary().since, 0);
  assert.ok(
    l.summary().days.every((d) => d.estimated),
    'nothing counted yet',
  );
  assert.equal(l.observe('a', 500, T0 - 2 * day, 'Alpha'), true);
  assert.equal(l.observe('b', 100, T0 - 1000), true);
  assert.equal(l.observe('a', 500, T0 - 2 * day), false, 'the same total adds nothing');
  assert.equal(l.observe('neg', -1, T0), false);
  now = T0 + 3_600_000;
  l.observe('b', 350, T0 + 3_000_000);
  l.observe('a', 400, T0, 'Alpha');
  const s = l.summary((id) => (id === 'b' ? 'Bravo' : undefined));
  assert.equal(s.today, 350, 'b: 100 first seen + 250 since');
  assert.equal(s.week, 850);
  assert.equal(s.days[4].credits, 500, 'a’s credits two days back');
  assert.equal(s.days[4].estimated, true, 'before counting started');
  assert.equal(s.days[4].guessed, 500);
  assert.equal(s.days[6].guessed, 100, 'b’s first total is a guess; what it grew by since is counted');
  assert.equal(s.days[6].estimated, true);
  assert.equal(s.since, T0);
  assert.deepEqual(s.top, [
    { id: 'a', title: 'Alpha', credits: 500 },
    { id: 'b', title: 'Bravo', credits: 350 },
  ]);
  // A drop in a total (never seen in practice) doesn't count the same credits twice later.
  l.observe('a', 600, now);
  assert.equal(l.summary().today, 450, 'only what passed the most it had seen');
  l.save();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.v, 1);
  assert.equal(new CreditLedger(file, () => now).summary().week, 950, 'read back as written');
  // A month on, the old days are gone and a week of nothing reads as zero.
  now = T0 + 40 * day;
  l.observe('c', 10, now);
  l.save();
  const later = l.snapshot();
  assert.ok(!(dayKey(T0) in later.days), 'pruned to a month');
  assert.ok(!(dayKey(T0) in later.guessed));
  assert.equal(l.summary().week, 10);
  l.observe('c', 30, now);
  assert.deepEqual(l.summary().days.at(-1), { day: dayKey(now), credits: 30, guessed: 10, estimated: true }, 'only the first sighting is a guess');
  writeFileSync(file, '{not json');
  assert.equal(new CreditLedger(file, () => now).summary().since, 0, 'an unreadable ledger starts afresh');
  writeFileSync(file, JSON.stringify({ v: 2 }));
  assert.equal(new CreditLedger(file, () => now).summary().since, 0);
  const mem = new CreditLedger(undefined, () => now);
  mem.observe('x', 1, now);
  mem.save();
  mem.reset();
  assert.equal(mem.summary().week, 0);
});

test('after a restart, a session shows the credits the ledger kept until its own read lands, even while the list is slow', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'factory-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const listed = { sessionId: 'cw', title: 'Cloud', status: 'idle', computerId: 'orb', createdAt: T0 - 9e6, updatedAt: T0 - 1000, messageCount: 4 };
  let mode: 'ok' | 'list-down' | 'read-down' = 'ok';
  const f = factory({
    '/api/v0/sessions': () => (mode === 'list-down' ? json(500, { detail: 'slow' }) : json(200, { sessions: [listed], pagination: { hasMore: false } })),
    '/api/v0/sessions/cw': () => (mode === 'ok' ? json(200, { ...listed, factoryCredits: 8400 }) : json(500, { detail: 'oops' })),
  });
  const office: OfficeSessionRef[] = [{ sessionId: 'cw', workerId: 'w1', name: 'Pixel' }];
  const before = new SessionsFeature(host(), { dataDir: dir, officeSessions: () => office, now: () => T0 });
  await before.poll(f.api);
  assert.equal(before.state().office.cw.credits, 8400);

  // The office restarts: the list hasn't come back yet.
  mode = 'list-down';
  const after = new SessionsFeature(host(), { dataDir: dir, officeSessions: () => office, now: () => T0 + 60_000 });
  await assert.rejects(() => after.poll(f.api));
  assert.equal(after.state().office.cw.credits, 8400, 'the cloud window and desk keep their credits through a restart');
  assert.equal(creditsNote(after.state(), 'cw'), '⚡ 8.4k credits');

  // The list is back but the session's own read fails: the ledger's total still shows.
  mode = 'read-down';
  await after.poll(f.api);
  assert.equal(after.state().items[0].credits, 8400);
  assert.equal(after.state().office.cw.credits, 8400);
});

test('routes: list older, create with a first message, detail, settings, delete, messages, send, interrupt and children', async () => {
  let now = T0;
  const created = {
    sessionId: 'new1',
    title: '',
    status: 'idle',
    createdAt: T0,
    updatedAt: T0,
    messageCount: 0,
    computerId: 'orb',
    sessionSettings: { model: 'gpt-x', reasoningEffort: 'high', interactionMode: 'auto', autonomyLevel: 'medium' },
  };
  let failSend = false;
  const raw = [
    { id: 'm3', role: 'assistant', seq: 3, createdAt: 3, content: [{ type: 'text', text: 'Hi!' }] },
    { id: 'm2', role: 'system', seq: 2, createdAt: 2, content: [{ type: 'text', text: 'system prompt' }] },
    { id: 'm1', role: 'user', seq: 1, createdAt: 1, content: [{ type: 'text', text: 'say hi' }] },
  ];
  const f = factory({
    'GET /api/v0/sessions': () => json(200, { sessions: [created], pagination: { hasMore: true, nextCursor: 'next' } }),
    'POST /api/v0/sessions': () => json(201, created),
    'GET /api/v0/sessions/new1': () => json(200, { ...created, factoryCredits: 1234 }),
    'PATCH /api/v0/sessions/new1': () => json(200, { ...created, sessionSettings: { model: 'gpt-y', reasoningEffort: 'low' } }),
    'DELETE /api/v0/sessions/new1': () => json(204, null),
    'GET /api/v0/sessions/new1/messages': () => json(200, { messages: raw, pagination: { hasMore: true, nextCursor: 'older' } }),
    'POST /api/v0/sessions/new1/messages': () => (failSend ? json(409, { detail: 'Computer is asleep' }) : json(200, { messageId: 'mm', status: 'running', recipientDroidStatus: 'running' })),
    'POST /api/v0/sessions/new1/interrupt': () => json(200, { status: 'idle' }),
    'GET /api/v0/sessions/new1/children': () => json(200, { sessions: [{ sessionId: 'kid', title: 'Kid', status: 'running', createdAt: 1, updatedAt: 2 }] }),
  });
  const h = host();
  const feature = new SessionsFeature(h, { now: () => now });

  const list = (await call(route(feature, 'GET', ''), { api: f.api, query: new URLSearchParams('cursor=abc&limit=10') })) as { sessions: FactorySession[]; nextCursor?: string };
  assert.equal(list.sessions[0].id, 'new1');
  assert.equal(list.nextCursor, 'next');
  assert.match(f.seen.at(-1)!, /limit=10&cursor=abc/);

  const create = route(feature, 'POST', '');
  assert.equal(create.bodyMax, 16 * 1024 * 1024, 'room for a few pictures');
  await assert.rejects(() => call(create, { api: f.api, json: async () => ({}) }), /Say which computer/);
  await assert.rejects(() => call(create, { api: f.api, json: async () => ({ computerId: 'orb', reasoningEffort: 'loud' }) }), /reasoningEffort is one of/);
  await assert.rejects(() => call(create, { api: f.api, json: async () => ({ computerId: 'orb', model: 'two words' }) }), /isn’t a model id/);
  await assert.rejects(() => call(create, { api: f.api, json: async () => ({ computerId: 'orb', prompt: 'x', images: [{ data: 'not base64!', mediaType: 'image/png' }] }) }), /A picture is/);
  const made = (await call(create, {
    api: f.api,
    json: async () => ({
      computerId: 'orb',
      computerName: 'orb',
      cwd: ' /home/factory-user ',
      model: 'gpt-x',
      reasoningEffort: 'high',
      interactionMode: 'auto',
      autonomyLevel: 'medium',
      prompt: 'say hi',
      images: [{ data: 'aGk=', mediaType: 'image/png' }],
    }),
  })) as { session: FactorySession; messageId?: string };
  assert.equal(made.session.id, 'new1');
  assert.equal(made.messageId, 'mm');
  assert.deepEqual(f.bodies.find((b) => b.at === 'POST /api/v0/sessions')?.body, {
    computerId: 'orb',
    cwd: '/home/factory-user',
    sessionSettings: { model: 'gpt-x', reasoningEffort: 'high', interactionMode: 'auto', autonomyLevel: 'medium' },
  });
  assert.deepEqual(f.bodies.find((b) => b.at === 'POST /api/v0/sessions/new1/messages')?.body, { text: 'say hi', images: [{ type: 'base64', data: 'aGk=', mediaType: 'image/png' }] });
  assert.deepEqual(h.toasts, ['🛰️ Olive started a Droid session on orb']);
  assert.ok(h.soon() >= 1, 'polls again soon');
  failSend = true;
  const halfway = (await call(create, { api: f.api, json: async () => ({ computerId: 'orb', prompt: 'hello' }) })) as { session: FactorySession; error?: string };
  assert.equal(halfway.session.id, 'new1', 'the session is there even when its first message didn’t go');
  assert.match(halfway.error ?? '', /Computer is asleep/);
  failSend = false;

  const detail = (await call(route(feature, 'GET', '/:id'), { api: f.api, params: { id: 'new1' } })) as { session: FactorySession; credits: number };
  assert.equal(detail.credits, 1234);
  assert.equal(detail.session.credits, 1234);
  assert.equal(detail.session.interactionMode, 'auto');
  assert.equal(feature.state().items[0]?.id, 'new1', 'a session started here shows before the list has it');

  const patch = route(feature, 'PATCH', '/:id');
  await assert.rejects(() => call(patch, { api: f.api, params: { id: 'new1' }, json: async () => ({}) }), /Nothing to change/);
  await assert.rejects(() => call(patch, { api: f.api, params: { id: 'new1' }, json: async () => ({ autonomyLevel: 'total' }) }), /autonomyLevel is one of/);
  const patched = (await call(patch, { api: f.api, params: { id: 'new1' }, json: async () => ({ model: 'gpt-y', reasoningEffort: 'low' }) })) as { session: FactorySession };
  assert.equal(patched.session.model, 'gpt-y');
  assert.equal(patched.session.credits, 1234, 'the credits stay from the last read');
  assert.deepEqual(f.bodies.find((b) => b.at === 'PATCH /api/v0/sessions/new1')?.body, { sessionSettings: { model: 'gpt-y', reasoningEffort: 'low' } });

  const msgs = (await call(route(feature, 'GET', '/:id/messages'), { api: f.api, params: { id: 'new1' }, query: new URLSearchParams('limit=500&role=user&cursor=c') })) as {
    messages: FactoryMessage[];
    hasMore: boolean;
    nextCursor?: string;
  };
  assert.deepEqual(
    msgs.messages.map((m) => m.id),
    ['m1', 'm3'],
    'oldest first, the system prompt left out',
  );
  assert.equal(msgs.nextCursor, 'older');
  assert.match(f.seen.at(-1)!, /limit=100&cursor=c&role=user/);
  await assert.rejects(() => call(route(feature, 'GET', '/:id/messages'), { api: f.api, params: { id: 'new1' }, query: new URLSearchParams('role=system') }), /role is one of/);

  const send = route(feature, 'POST', '/:id/messages');
  await assert.rejects(() => call(send, { api: f.api, params: { id: 'new1' }, json: async () => ({ text: '  ' }) }), /Say something/);
  await assert.rejects(() => call(send, { api: f.api, params: { id: 'new1' }, json: async () => ({ text: 'x', images: Array(7).fill({ data: 'aGk=', mediaType: 'image/png' }) }) }), /At most 6 pictures/);
  const sent = (await call(send, { api: f.api, params: { id: 'new1' }, json: async () => ({ text: '', images: [{ data: 'aGk=', mediaType: 'image/webp' }] }) })) as { messageId: string; queued?: boolean };
  assert.deepEqual(sent, { messageId: 'mm', status: 'running', queued: true });
  assert.equal(feature.state().items.find((x) => x.id === 'new1')?.status, 'running', 'it runs once a message went');

  const stopped = await call(route(feature, 'POST', '/:id/interrupt'), { api: f.api, params: { id: 'new1' } });
  assert.deepEqual(stopped, { status: 'idle' });
  assert.equal(feature.state().items.find((x) => x.id === 'new1')?.status, 'idle');

  const kids = (await call(route(feature, 'GET', '/:id/children'), { api: f.api, params: { id: 'new1' } })) as { sessions: FactorySession[] };
  assert.deepEqual(
    kids.sessions.map((k) => k.id),
    ['kid'],
  );
  assert.match(f.seen.at(-1)!, /includeArtifacts=true/);

  now += 1000;
  assert.deepEqual(await call(route(feature, 'DELETE', '/:id'), { api: f.api, params: { id: 'new1' } }), { ok: true });
  assert.equal(
    feature.state().items.some((x) => x.id === 'new1'),
    false,
    'gone from the slice at once',
  );
  assert.match(h.toasts.at(-1)!, /Olive deleted the Droid session/);
  await feature.poll(f.api);
  assert.equal(
    feature.state().items.some((x) => x.id === 'new1'),
    false,
    'and stays gone while the list catches up',
  );
  await assert.rejects(() => call(route(feature, 'GET', '/:id'), { api: f.api, params: { id: 'missing' } }), /No such session/);
});

test('the registry reads a bigger body for a route that says so', async () => {
  const api = new FactoryApi(KEY, (async () => json(200, { messageId: 'm', status: 'idle' })) as typeof fetch);
  const link: FactoryLink = { connection: () => ({ connected: true, capabilities: [] }), client: () => api, rejected: () => {} };
  const reg = new FactoryRegistry({ link, broadcast: () => {}, toast: () => {} });
  reg.register((h) => new SessionsFeature(h));
  let limit = 0;
  const r = await reg.http(
    'POST',
    '/sessions/s1/messages',
    new URLSearchParams(),
    async (n) => {
      limit = n;
      return JSON.stringify({ text: 'hi' });
    },
    { trusted: true, by: 'Olive' },
  );
  assert.equal(r.status, 200);
  assert.equal(limit, 16 * 1024 * 1024);
  await reg.http(
    'POST',
    '/sessions/s1/interrupt',
    new URLSearchParams(),
    async (n) => {
      limit = n;
      return '';
    },
    { trusted: true },
  );
  reg.stop();
});

test('shared: sessions, credits, where a session runs, and the transcript’s pieces', () => {
  const s = sessionOf({
    sessionId: 'x',
    title: 'T',
    status: 'running',
    factoryCredits: 841059,
    sessionSettings: { interactionMode: 'spec', autonomyLevel: 'high' },
    artifacts: [{ id: 'a', url: 'https://github.com/o/r/pull/9', kind: 'pull_request', action: 'merge', provider: 'github', title: 'Fix', createdAt: '2026-10-07T17:37:10.584Z' }],
  })!;
  assert.equal(s.credits, 841059);
  assert.equal(s.interactionMode, 'spec');
  assert.equal(s.autonomyLevel, 'high');
  assert.equal(s.artifacts[0].createdAt, Date.parse('2026-10-07T17:37:10.584Z'));
  assert.equal(sessionOf([]), undefined);
  assert.equal(compactCredits(950), '950');
  assert.equal(compactCredits(841059), '841k');
  assert.equal(compactCredits(4519251), '4.5M');
  assert.equal(compactCredits(12_300), '12.3k');
  assert.equal(compactCredits(2.5e9), '2.5B');
  assert.equal(sessionWebUrl('a b'), 'https://app.factory.ai/sessions/a%20b');
  assert.equal(artifactLabel({ id: 'i', kind: 'pull_request', url: 'https://github.com/o/r/pull/9' }), 'o/r#9');
  assert.equal(artifactLabel({ id: 'i', kind: 'document', title: 'Doc' }), 'Doc');
  assert.equal(artifactLabel({ id: 'i', kind: 'pull_request', externalId: 'o/r#1' }), 'o/r#1');
  const older: FactorySession = {
    ...s,
    id: 'y',
    updatedAt: 1,
    artifacts: [
      { id: 'b', kind: 'pull_request', url: 'https://github.com/o/r/pull/9', action: 'create', createdAt: 5 },
      { id: 'c', kind: 'issue', url: 'https://github.com/o/r/issues/2', action: 'view' },
    ],
  };
  const prs = latestArtifacts([older, s], 5);
  assert.equal(prs.length, 1, 'each link once, viewed issues left out');
  assert.equal(prs[0].artifact.action, 'merge', 'the newest thing done with it');

  const state = { ...emptySessions(), office: { w: { workerId: '1', name: 'Pixel', floor: 'main', color: '#0f0', credits: 5 } } };
  assert.deepEqual(sessionWhere(state, [], { ...s, id: 'w' }), { kind: 'office', label: 'Pixel · main', color: '#0f0' });
  assert.deepEqual(sessionWhere(state, [{ id: 'c1', name: 'orb' }], { ...s, computerId: 'c1' }), { kind: 'cloud', label: 'orb' });
  assert.deepEqual(sessionWhere(state, [], { ...s, computerId: 'c2' }), { kind: 'cloud', label: 'a Factory computer' });
  assert.equal(sessionWhere(state, [], s).kind, 'elsewhere');
  assert.equal(spanText(40_000), '40s');
  assert.equal(spanText(12 * 60_000), '12m');
  assert.equal(spanText(125 * 60_000), '2h 05m');
  assert.equal(spanText(76 * 3_600_000), '3d 4h');

  const big = 'A'.repeat(IMAGE_MAX + 1);
  const m = messageOf({
    id: 'm',
    role: 'assistant',
    createdAt: 5,
    seq: 2,
    modelId: 'opus',
    content: [
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'redacted_thinking', data: 'x' },
      { type: 'text', text: '**hi**' },
      { type: 'text', text: '   ' },
      { type: 'tool_use', id: 't1', name: 'Execute', input: { command: 'npm   test', riskLevel: 'low', nested: { a: 1 } } },
      { type: 'image', source: { type: 'base64', data: 'aGk=', mediaType: 'image/png' } },
      { type: 'image', source: { type: 'base64', data: big, mediaType: 'image/png' } },
      { type: 'document', source: { name: 'spec.pdf' } },
    ],
  })!;
  assert.deepEqual(
    m.blocks.map((b) => b.type),
    ['thinking', 'text', 'tool_use', 'image', 'image', 'document'],
  );
  assert.equal(m.model, 'opus');
  assert.equal((m.blocks[4] as { data?: string }).data, undefined, 'a huge picture is left out');
  const r = messageOf({ id: 'r', role: 'tool', createdAt: 6, seq: 3, content: [{ type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'ok' }, { type: 'image' }], isError: true }] })!;
  assert.deepEqual(r.blocks[0], { type: 'tool_result', toolUseId: 't1', text: 'ok', isError: true, images: 1 });
  assert.equal(messageOf({ id: 'h', role: 'user', hiddenFromUserViews: true, content: [{ type: 'text', text: 'x' }] }), undefined);
  assert.equal(messageOf({ id: 'e', role: 'user', content: [] }), undefined);
  assert.equal(messageOf({ role: 'user' }), undefined);
  assert.equal(resultsByCall([m, r]).get('t1')?.isError, true);
  const u = messageOf({ id: 'u', role: 'user', createdAt: 1, seq: 1, content: [{ type: 'text', text: 'go' }] })!;
  assert.deepEqual(
    mergeMessages([m, r], [u, { ...m, blocks: [] }]).map((x) => [x.id, x.blocks.length]),
    [
      ['u', 1],
      ['m', 0],
      ['r', 1],
    ],
    'oldest first, the later copy wins',
  );
  assert.equal(toolLine('Execute', { command: 'npm   test\n --x' }), 'Execute: npm test --x');
  assert.equal(toolLine('Read', { file_path: '/a/b.ts' }), 'Read: /a/b.ts');
  assert.equal(toolLine('Glob', { patterns: ['*.ts', '*.js'] }), 'Glob: *.ts *.js');
  assert.equal(toolLine('TodoWrite', { todos: '1. x' }), 'TodoWrite');
  assert.equal(toolLine('mcp_thing', { a: 1, q: 'find it' }), 'mcp_thing: find it');
  assert.equal(toolLine('Execute', { command: 'x'.repeat(300) }).length, 140);
  assert.equal(toolLine('Other', {}), 'Other');
});
