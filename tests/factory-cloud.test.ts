import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudWorkers } from '../src/server/cloud-workers.js';
import { FactoryApi, FactoryError } from '../src/server/factory/api.js';
import { CloudFeature, cloudRefusal, mountCloud, type CloudFloor } from '../src/server/factory/cloud.js';
import { HttpError, type FeatureHost } from '../src/server/factory/feature.js';
import type { FactoryRegistry } from '../src/server/factory/registry.js';
import { toolAction } from '../src/shared/actions.js';
import { computerOf, type FactoryComputersState } from '../src/shared/factory-computers.js';
import { SEND_SETTLE_MS, answeredByAssistant, canHost, cloudBadge, cloudSessionUrl, cloudStatus, computerHome, latestReply, latestTool, officeAutonomy, sessionCwd, toolActivity } from '../src/shared/factory-cloud.js';
import { DESKS } from '../src/shared/layout.js';
import type { ClientMsg, WorkerInfo } from '../src/shared/protocol.js';

const KEY = 'fk-test-cloud-1234';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const DESK = DESKS.filter((d) => !d.station && !d.room && !d.beanbag);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not really a picture')]);
const tick = () => new Promise((r) => setTimeout(r, 15));

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

/** Factory as the feature sees it: an answer per "METHOD /path" (under /api/v0); `calls` is what was asked. */
function factory(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const p = url.pathname.replace(/^\/api\/v0/, '');
    const call: Call = { method: init.method ?? 'GET', path: p, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = routes[`${call.method} ${p}`];
    return r ? r(call) : json(404, { detail: `no ${call.method} ${p}` });
  }) as typeof fetch;
  return { api: new FactoryApi(KEY, fn), calls };
}

const ORB = { id: 'orb-id', name: 'orb', providerType: 'e2b', status: 'active', createdAt: 1, remoteUser: 'factory-user' };
const MAC = { id: 'mac-id', name: 'macbook', providerType: 'byom', status: 'active', createdAt: 2 };
const SLEEPY = { id: 'zz-id', name: 'sleepy', providerType: 'e2b', status: 'provisioning', createdAt: 3 };

function computersState(raw = [ORB, MAC, SLEEPY], fetchedAt = 1): FactoryComputersState {
  return { items: raw.map((c) => computerOf(c)!), metrics: {}, providers: [], fetchedAt };
}

/** A floor's cloud workers in a temp folder, with the feature that drives them, against `f`. */
function rig(t: test.TestContext, f: ReturnType<typeof factory>, opts: { dir?: string; agentArgs?: string[]; taken?: string[]; computers?: () => FactoryComputersState | undefined } = {}) {
  const dir = opts.dir ?? mkdtempSync(path.join(os.tmpdir(), 'office-cloud-'));
  if (!opts.dir) t.after(() => rmSync(dir, { recursive: true, force: true }));
  const updates: WorkerInfo[] = [];
  const removed: string[] = [];
  const toasts: string[] = [];
  const taken = new Set(opts.taken ?? []);
  const cloud = new CloudWorkers(dir, { deskTaken: (id) => taken.has(id), names: () => ['Ada'], pool: { names: ['Ada', 'Bea', 'Cy'], colors: ['#123456'] } }, { update: (w) => updates.push(w), remove: (id) => removed.push(id) });
  const floor: CloudFloor = { id: 'f1', name: 'proj', cloud, unstage: (ids) => cloud.drops.unstage(ids) };
  let polls = 0;
  let now = 1_000_000;
  const host: FeatureHost = { changed: () => {}, pollSoon: () => polls++, api: () => f.api, toast: () => {} };
  const computers = opts.computers ?? (() => computersState());
  const feature = new CloudFeature(host, { floors: () => [floor], agentArgs: opts.agentArgs ?? [], computers, toast: (_, text) => toasts.push(text), now: () => now });
  return {
    dir,
    cloud,
    floor,
    feature,
    updates,
    removed,
    toasts,
    polls: () => polls,
    clock: (ms: number) => {
      now += ms;
    },
  };
}

const hireBody = (extra: Record<string, unknown> = {}) => ({ floor: 'f1', deskId: DESK[0].id, computerId: 'orb-id', cwd: '~/proj', prompt: 'say hi', model: 'claude-opus-4', effort: 'high', ...extra });

const session = (status: string, messageCount: number, updatedAt = messageCount) => json(200, { id: 's1', status, messageCount, updatedAt, title: 'Say hi', sessionSettings: { model: 'claude-opus-4', reasoningEffort: 'high' } });

test('shared: autonomy, folders, badge and the session link', () => {
  assert.equal(officeAutonomy([]), 'high');
  assert.equal(officeAutonomy(['--auto', 'low']), 'low');
  assert.equal(officeAutonomy(['--auto=medium']), 'medium');
  assert.equal(officeAutonomy(['--auto', 'off']), 'high');
  assert.equal(officeAutonomy(['--skip-permissions-unsafe']), 'high');
  assert.equal(officeAutonomy(['--auto', 'sideways']), 'high');

  const orb = { name: 'orb', providerType: 'e2b', remoteUser: 'factory-user' };
  const mac = { name: 'macbook', providerType: 'byom' };
  assert.equal(computerHome(orb), '/home/factory-user');
  assert.equal(computerHome(mac), undefined);
  assert.equal(computerHome({ providerType: 'e2b', remoteUser: '../root' }), undefined);
  assert.deepEqual(sessionCwd('', orb), {});
  assert.deepEqual(sessionCwd(' ~ ', orb), {});
  assert.deepEqual(sessionCwd('~/proj/', orb), { cwd: '/home/factory-user/proj' });
  assert.deepEqual(sessionCwd('/srv/app', mac), { cwd: '/srv/app' });
  assert.deepEqual(sessionCwd('C:\\code', mac), { cwd: 'C:\\code' });
  assert.match(sessionCwd('~/proj', mac) as string, /full path on macbook/);
  assert.match(sessionCwd('proj', orb) as string, /full path/);
  assert.match(sessionCwd('/a\nb', orb) as string, /control characters/);
  assert.match(sessionCwd(`/${'x'.repeat(5000)}`, orb) as string, /too long/);

  assert.equal(canHost({ status: 'active' }), true);
  assert.equal(canHost({ status: 'provisioning' }), false);
  assert.equal(cloudBadge({ computerName: 'orb' }), '☁ orb');
  assert.equal(cloudSessionUrl('a b'), 'https://app.factory.ai/sessions/a%20b');
});

test('shared: a session’s status, and the turn that tells done from not started yet', () => {
  const now = 100_000;
  assert.deepEqual(cloudStatus({ status: 'running' }, {}, now), { status: 'working', turn: { seenBusy: true } });
  assert.deepEqual(cloudStatus({ status: 'pending' }, { sentAt: 1 }, now).status, 'working');
  // Idle with nothing sent and nothing seen running: it keeps what it has.
  assert.deepEqual(cloudStatus({ status: 'idle', messageCount: 0 }, {}, now), { turn: {} });
  // Just sent: Factory still says idle with the old count, so it's still working.
  const sent = { sentAt: now - 1000, countAtSend: 2 };
  assert.deepEqual(cloudStatus({ status: 'idle', messageCount: 2 }, sent, now), { status: 'working', turn: sent });
  // The count moving is not enough (the sent message itself appends to it): seen running, or long enough, is done.
  assert.deepEqual(cloudStatus({ status: 'idle', messageCount: 4 }, sent, now), { status: 'working', turn: sent });
  assert.deepEqual(cloudStatus({ status: 'idle', messageCount: 2 }, { ...sent, seenBusy: true }, now).status, 'done');
  assert.equal(cloudStatus({ status: 'idle', messageCount: 2 }, sent, now + SEND_SETTLE_MS).status, 'done');
  // Someone typed to it in Factory's web app: seen running, then idle, is done too.
  assert.equal(cloudStatus({ status: 'idle' }, { seenBusy: true }, now).status, 'done');
});

test('shared: what it is doing, from the newest messages', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'hmm' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
        { type: 'tool_use', name: 'Execute', input: { command: 'npm   test' } },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: 'run the tests' }] },
  ];
  assert.deepEqual(latestTool(messages), { activity: 'Execute: npm test', action: toolAction('Execute', { command: 'npm   test' }) });
  // Writing its answer: no tool call in the newest assistant message.
  assert.equal(latestTool([{ role: 'assistant', content: [{ type: 'text', text: 'Done' }] }, ...messages]), undefined);
  assert.equal(latestTool([null, 'x', { role: 'user', content: [] }]), undefined);
  assert.equal(toolActivity('Grep', {}), 'Grep');
  assert.equal(toolActivity('Execute', { command: 'x'.repeat(200) }).length, 80);
  assert.equal(
    latestReply([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: ' Hi \n there ' },
          { type: 'text', text: '!' },
        ],
      },
    ]),
    'Hi there !',
  );
  assert.equal(latestReply(messages), undefined);
  assert.equal(
    answeredByAssistant([
      { role: 'assistant', content: [] },
      { role: 'user', content: [] },
    ]),
    true,
  );
  assert.equal(answeredByAssistant([{ role: 'user', content: [] }]), false);
  assert.equal(answeredByAssistant([]), false);
});

test('hire: makes the session on the computer, seats the worker and sends its first prompt with its pictures', async (t) => {
  const f = factory({
    'POST /sessions': () => json(201, { sessionId: 's1', status: 'idle', sessionSettings: { model: 'claude-opus-4' } }),
    'POST /sessions/s1/messages': () => json(200, { messageId: 'm1', status: 'running' }),
  });
  const r = rig(t, f, { agentArgs: ['--auto', 'medium'] });
  const pic = r.cloud.drops.stage('shot.png', PNG)!;
  const w = await r.feature.hire(f.api, hireBody({ images: [pic, 'not-an-id'] }), 'Nik');
  assert.equal(w.kind, 'cloud');
  assert.equal(w.name, 'Bea', 'the next free name: Ada is taken by a local worker');
  assert.equal(w.sessionId, 's1');
  assert.equal(w.deskId, DESK[0].id);
  assert.deepEqual(w.cloud, { computerId: 'orb-id', computerName: 'orb', provider: 'e2b', cwd: '/home/factory-user/proj', autonomy: 'medium' });
  assert.equal(w.task?.name !== undefined, true);
  const create = f.calls.find((c) => c.path === '/sessions')!;
  assert.deepEqual(create.body, {
    computerId: 'orb-id',
    cwd: '/home/factory-user/proj',
    sessionSettings: { interactionMode: 'auto', autonomyLevel: 'medium', model: 'claude-opus-4', reasoningEffort: 'high' },
  });
  await tick();
  const sent = f.calls.find((c) => c.path === '/sessions/s1/messages')!;
  assert.deepEqual(sent.body, { text: 'say hi', images: [{ type: 'base64', data: PNG.toString('base64'), mediaType: 'image/png' }] });
  assert.equal(r.cloud.drops.stagedPicture(pic), undefined, 'sent pictures are no longer staged');
  const now = r.cloud.get(w.id)!;
  assert.equal(now.status, 'working');
  assert.equal(r.cloud.turn(w.id)?.seenBusy, true);
  assert.ok(r.polls() > 0, 'it asks to be read right away');
  assert.ok(r.toasts.some((x) => x.includes('hired Bea on ☁ orb')));
  assert.equal(r.feature.busy(), true);
  // Its file is the owner's only.
  assert.equal(statSync(path.join(r.dir, 'cloud-workers.json')).mode & 0o777, 0o600);
});

test('hire: a failed create hires nobody, gives the desk back and says what Factory said', async (t) => {
  let fail = true;
  const f = factory({
    'POST /sessions': () => (fail ? json(422, { detail: 'Computer is not reachable' }) : json(201, { sessionId: 's2' })),
  });
  const r = rig(t, f);
  const pic = r.cloud.drops.stage('shot.png', PNG)!;
  await assert.rejects(r.feature.hire(f.api, hireBody({ images: [pic], prompt: '' }), 'Nik'), (err: Error) => err instanceof FactoryError && /not reachable/.test(err.message));
  assert.equal(r.cloud.list().length, 0);
  assert.ok(r.cloud.drops.stagedPicture(pic), 'the dialog keeps its pictures to try again');
  // The desk is free again, and with no prompt the worker waits for one.
  fail = false;
  const w = await r.feature.hire(f.api, hireBody({ prompt: '' }), 'Nik');
  assert.equal(w.status, 'idle');
  assert.equal(w.activity, 'Ready for a first prompt');
  assert.equal(f.calls.filter((c) => c.path.endsWith('/messages')).length, 0);
  // A session that comes back without an id hires nobody either.
  const g = factory({ 'POST /sessions': () => json(201, {}) });
  const r2 = rig(t, g);
  await assert.rejects(r2.feature.hire(g.api, hireBody(), 'Nik'), (err: Error) => err instanceof HttpError && err.status === 502);
  assert.equal(r2.cloud.deskTaken(DESK[0].id), false);
});

test('hire: refuses what can’t run on a Factory computer before asking Factory', async (t) => {
  const f = factory({});
  const r = rig(t, f, { taken: [DESK[1].id] });
  const refused = async (body: Record<string, unknown>, why: RegExp) => assert.rejects(r.feature.hire(f.api, hireBody(body), 'Nik'), (err: Error) => err instanceof HttpError && why.test(err.message));
  await refused({ floor: 'gone' }, /no longer in the building/);
  await refused({ computerId: 'nope' }, /isn't on Factory/);
  await refused({ computerId: 'zz-id' }, /provisioning/);
  await refused({ computerId: 'mac-id', cwd: '~/x' }, /full path/);
  await refused({ model: 'custom:my-byok' }, /only run on this machine/);
  await refused({ model: 'bad model' }, /not valid/);
  await refused({ deskId: DESK[1].id }, /taken/);
  await refused({ deskId: 'nowhere' }, /Unknown desk/);
  await refused({ deskId: DESKS.find((d) => d.station)?.id ?? 'station-issues' }, /board agent|Unknown desk/);
  assert.equal(f.calls.length, 0);
});

test('poll: working with its latest tool call acted out, then done with its reply, and the session’s model', async (t) => {
  let s = () => session('running', 3);
  let tail: unknown[] = [{ role: 'assistant', content: [{ type: 'tool_use', name: 'Execute', input: { command: 'pwd' } }] }];
  const f = factory({
    'POST /sessions': () => json(201, { sessionId: 's1' }),
    'POST /sessions/s1/messages': () => json(200, { status: 'pending' }),
    'GET /sessions/s1': () => s(),
    'GET /sessions/s1/messages': () => json(200, { messages: tail }),
  });
  const r = rig(t, f);
  const w = await r.feature.hire(f.api, hireBody(), 'Nik');
  await tick();
  await r.feature.poll(f.api);
  let now = r.cloud.get(w.id)!;
  assert.equal(now.status, 'working');
  assert.equal(now.activity, 'Execute: pwd');
  assert.equal(now.action, toolAction('Execute', { command: 'pwd' }));
  assert.equal(now.activeModel, 'claude-opus-4');
  assert.equal(now.activeEffort, 'high');
  assert.equal(now.title, 'Say hi');
  assert.ok(r.feature.state().fetchedAt > 0);

  // The count needn't move between the last working read and the idle one: the reply is read anyway.
  s = () => session('idle', 3);
  tail = [{ role: 'assistant', content: [{ type: 'text', text: 'Hi there! All done.' }] }];
  r.clock(5000);
  await r.feature.poll(f.api);
  now = r.cloud.get(w.id)!;
  assert.equal(now.status, 'done');
  assert.equal(now.acked, false, 'its flag is up: nobody has its window open');
  assert.equal(now.action, undefined);
  assert.equal(now.activity, 'Hi there! All done.');
  assert.equal(now.task?.summary, 'Hi there! All done.');
  assert.equal(r.feature.busy(), false);

  // At rest it's read again only on the slow clock, unless asked.
  const reads = () => f.calls.filter((c) => c.method === 'GET' && c.path === '/sessions/s1').length;
  const before = reads();
  r.clock(5000);
  await r.feature.poll(f.api);
  assert.equal(reads(), before);
  r.feature.recheck(w.id);
  await r.feature.poll(f.api);
  assert.equal(reads(), before + 1);
  // The transcript is read only when the session moved.
  const tails = () => f.calls.filter((c) => c.path === '/sessions/s1/messages' && c.method === 'GET').length;
  const t0 = tails();
  r.feature.recheck(w.id);
  await r.feature.poll(f.api);
  assert.equal(tails(), t0);
});

test('poll: a deleted session or computer is a clear error at the desk, and a failed read keeps the last status', async (t) => {
  let gone = false;
  let down = false;
  const f = factory({
    'POST /sessions': () => json(201, { sessionId: 's1' }),
    'GET /sessions/s1': () => (down ? json(503, { detail: 'down' }) : gone ? json(404, { detail: 'Session not found' }) : session('idle', 0)),
  });
  let computers = computersState();
  const r = rig(t, f, { computers: () => computers });
  const w = await r.feature.hire(f.api, hireBody({ prompt: '' }), 'Nik');

  // Factory 404s a session for a moment right after it was made: not broken yet, just a failed read.
  gone = true;
  r.feature.recheck(w.id);
  await assert.rejects(r.feature.poll(f.api), /not found/i);
  assert.equal(r.cloud.get(w.id)!.status, 'idle');
  assert.equal(r.cloud.get(w.id)!.cloud?.error, undefined);
  gone = false;

  await r.feature.poll(f.api);
  assert.equal(r.cloud.get(w.id)!.status, 'idle');

  down = true;
  r.feature.recheck(w.id);
  await assert.rejects(r.feature.poll(f.api), /down/);
  assert.equal(r.cloud.get(w.id)!.status, 'idle');

  down = false;
  gone = true;
  r.feature.recheck(w.id);
  await r.feature.poll(f.api);
  let now = r.cloud.get(w.id)!;
  assert.equal(now.status, 'exited');
  assert.equal(now.cloud?.error, 'its session is gone from Factory');
  assert.match(now.activity ?? '', /^☁ Its session is gone/);

  // It comes back when the session does.
  gone = false;
  r.feature.recheck(w.id);
  await r.feature.poll(f.api);
  now = r.cloud.get(w.id)!;
  assert.equal(now.status, 'idle');
  assert.equal(now.cloud?.error, undefined);
  assert.equal(now.activity?.startsWith('☁ '), false, 'the error line on its card goes with the error');

  computers = computersState([MAC]);
  r.feature.recheck(w.id);
  await r.feature.poll(f.api);
  assert.equal(r.cloud.get(w.id)!.cloud?.error, 'its computer orb is no longer on Factory');
  computers = computersState([{ ...ORB, name: 'orb2', status: 'error' }]);
  r.feature.recheck(w.id);
  await r.feature.poll(f.api);
  assert.equal(r.cloud.get(w.id)!.cloud?.error, 'its computer orb2 has a problem on Factory');

  // A rejected key stops the whole poll, so the registry hears it.
  const k = factory({ 'GET /sessions/s1': () => json(401, { detail: 'bad key' }) });
  r.feature.recheck(w.id);
  computers = computersState();
  await assert.rejects(r.feature.poll(k.api), (err: Error) => err instanceof FactoryError && err.status === 401);
});

test('restart: a cloud worker is back at its desk and picks its session up again by id', async (t) => {
  const f = factory({
    'POST /sessions': () => json(201, { sessionId: 's1' }),
    'POST /sessions/s1/messages': () => json(200, { status: 'idle' }),
    'GET /sessions/s1': () => session('idle', 2),
    'GET /sessions/s1/messages': () => json(200, { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] }),
  });
  const r = rig(t, f);
  const w = await r.feature.hire(f.api, hireBody(), 'Nik');
  await tick();
  r.cloud.attach(w.id, 'c1');
  const saved = JSON.parse(readFileSync(path.join(r.dir, 'cloud-workers.json'), 'utf8'));
  assert.equal(saved[0].info.open, undefined, 'whose window is open is not saved');
  assert.equal(saved[0].turn.sentAt !== undefined, true);

  const again = rig(t, f, { dir: r.dir });
  const back = again.cloud.get(w.id)!;
  assert.equal(back.kind, 'cloud');
  assert.equal(back.sessionId, 's1');
  assert.equal(back.open, false);
  assert.equal(back.status, 'working');
  assert.equal(again.cloud.deskTaken(w.deskId), true);
  await again.feature.poll(f.api);
  assert.equal(again.cloud.get(w.id)!.status, 'done', 'the turn it was on when the office stopped ended meanwhile');
  assert.equal(again.cloud.get(w.id)!.activity, 'hi');

  // A worker caught mid-hire comes back at rest, and a broken file is skipped.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-cloud-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = [
    { info: { ...back, id: 'w2', deskId: DESK[2].id, status: 'starting' } },
    { info: { ...back, id: 'w3', deskId: DESK[3].id, kind: 'agent' } },
    { info: { ...back, id: 'w4', deskId: 'nowhere' } },
    { info: { ...back, id: 'w5', deskId: DESK[4].id, cloud: undefined } },
    { info: { ...back, id: 'w6', deskId: DESK[2].id } },
    null,
  ];
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(dir, 'cloud-workers.json'), JSON.stringify(raw));
  const third = rig(t, f, { dir });
  assert.deepEqual(
    third.cloud.list().map((x) => [x.id, x.status]),
    [['w2', 'idle']],
  );
  writeFileSync(path.join(dir, 'cloud-workers.json'), '{not json');
  assert.equal(rig(t, f, { dir }).cloud.list().length, 0);
});

test('send home: interrupts it when it works, deletes the session only when asked', async (t) => {
  const f = factory({
    'POST /sessions': () => json(201, { sessionId: 's1' }),
    'POST /sessions/s1/messages': () => json(200, { status: 'running' }),
    'POST /sessions/s1/interrupt': () => json(200, { status: 'idle' }),
    'DELETE /sessions/s1': () => new Response(null, { status: 204 }),
  });
  const r = rig(t, f);
  const busy = await r.feature.hire(f.api, hireBody(), 'Nik');
  await tick();
  assert.deepEqual(await r.feature.sendHome(busy.id, false), { note: `☁ ${busy.name}'s session was stopped; it stays in Factory's sessions` });
  assert.deepEqual(r.removed, [busy.id]);
  assert.deepEqual(
    f.calls.filter((c) => c.path.startsWith('/sessions/s1') && c.method !== 'GET').map((c) => `${c.method} ${c.path}`),
    ['POST /sessions/s1/messages', 'POST /sessions/s1/interrupt'],
  );

  const idle = await r.feature.hire(f.api, hireBody({ prompt: '' }), 'Nik');
  const before = f.calls.length;
  assert.deepEqual(await r.feature.sendHome(idle.id, false), {});
  assert.equal(f.calls.length, before, 'an idle one that keeps its session needs nothing from Factory');

  const doomed = await r.feature.hire(f.api, hireBody({ prompt: '' }), 'Nik');
  assert.deepEqual(await r.feature.sendHome(doomed.id, true), { note: `🗑️ ${doomed.name}'s Factory session was deleted` });
  assert.equal(f.calls.at(-1)?.method, 'DELETE');
  assert.equal(r.cloud.list().length, 0);
  assert.deepEqual(await r.feature.sendHome('nobody', true), {});

  // Already gone on Factory: nothing to say but that it's deleted.
  const g = factory({ 'POST /sessions': () => json(201, { sessionId: 's9' }), 'DELETE /sessions/s9': () => json(404, { detail: 'gone' }) });
  const r2 = rig(t, g);
  const w = await r2.feature.hire(g.api, hireBody({ prompt: '' }), 'Nik');
  assert.match((await r2.feature.sendHome(w.id, true)).note ?? '', /deleted/);
  const h = factory({ 'POST /sessions': () => json(201, { sessionId: 's8' }), 'DELETE /sessions/s8': () => json(500, { detail: 'boom' }) });
  const r3 = rig(t, h);
  const w3 = await r3.feature.hire(h.api, hireBody({ prompt: '' }), 'Nik');
  assert.match((await r3.feature.sendHome(w3.id, true)).error ?? '', /session/);
});

test('messages: a cloud worker takes prompts, opens and closes its window, and skips every terminal and worktree path', async (t) => {
  const f = factory({
    'POST /sessions': () => json(201, { sessionId: 's1' }),
    'POST /sessions/s1/messages': () => json(200, { status: 'running' }),
    'POST /sessions/s1/interrupt': () => json(200, { status: 'idle' }),
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-cloud-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cloud = new CloudWorkers(dir, { deskTaken: () => false, names: () => [], pool: { names: ['Ada'], colors: ['#fff'] } }, { update: () => {}, remove: () => {} });
  const floor: CloudFloor = { id: 'f1', name: 'proj', cloud, unstage: (ids) => cloud.drops.unstage(ids) };
  const toasts: string[] = [];
  let feature: CloudFeature | undefined;
  const registry = {
    register: (make: (host: FeatureHost) => CloudFeature) => {
      feature = make({ changed: () => {}, pollSoon: () => {}, api: () => f.api, toast: () => {} });
      return feature;
    },
    feature: () => ({ state: () => computersState() }),
  } as unknown as FactoryRegistry;
  const mounted = mountCloud(registry, { floors: () => [floor], agentArgs: [], toast: (_, text) => toasts.push(text) });
  assert.equal(mounted.feature, feature);
  const w = await mounted.feature.hire(f.api, hireBody({ prompt: '' }), 'Nik');
  const warned: string[] = [];
  const issues: number[] = [];
  const ctx = { who: 'Nik', client: 'c1', warn: (x: string) => warned.push(x), takeIssue: (n: number) => issues.push(n) };
  const send = (msg: Record<string, unknown>) => mounted.message({ workerId: w.id, ...msg } as Extract<ClientMsg, { workerId: string }>, ctx);

  assert.equal(mounted.message({ t: 'worker.attach', workerId: 'local-1' }, ctx), false, 'a local worker is not the cloud’s');
  assert.equal(send({ t: 'worker.attach' }), true);
  assert.equal(cloud.get(w.id)!.open, true);
  send({ t: 'worker.detach' });
  assert.equal(cloud.get(w.id)!.open, false);
  send({ t: 'term.input', data: 'rm -rf /\r' });
  send({ t: 'term.resize', cols: 10, rows: 10 });
  send({ t: 'changes.unwatch' });
  assert.deepEqual(warned, []);

  for (const t of ['worker.shoot', 'worker.revive', 'worker.pr', 'worker.worktree', 'worker.rebuild', 'changes.watch', 'changes.commit', 'guest.bringIn']) send({ t });
  assert.equal(warned.length, 8);
  assert.match(warned[0], /nobody really at this desk to shoot/);
  assert.match(warned[2], /open the pull request itself/);
  assert.match(warned[3], /only works for a worker on this machine/);
  assert.equal(cloudRefusal({ ...w, cloud: undefined }, 'worker.pr').includes('a Factory computer'), true);

  send({ t: 'worker.prompt', prompt: 'look at issue 7', issue: 7 });
  await tick();
  assert.equal(f.calls.filter((c) => c.path === '/sessions/s1/messages').length, 1);
  assert.deepEqual(issues, [7]);
  assert.equal(cloud.get(w.id)!.status, 'working');
  warned.length = 0;
  send({ t: 'worker.prompt', prompt: '   ' });
  await tick();
  assert.deepEqual(warned, ['Type something to send']);
  send({ t: 'worker.resume' });
  assert.match(warned[1], /Checking/);

  // The routes: a message, and Interrupt.
  const route = (p: string) => mounted.feature.routes.find((x) => x.path === p)!;
  const req = (params: Record<string, string>, body: unknown) => ({ method: 'POST', path: '', params, query: new URLSearchParams(), json: async () => body, api: f.api, by: 'Nik' }) as never;
  assert.deepEqual(await route('/:id/interrupt').handle(req({ id: w.id }, {})), { ok: true });
  assert.deepEqual(await route('/:id/message').handle(req({ id: w.id }, { text: 'again' })), { ok: true });
  await assert.rejects(Promise.resolve(route('/:id/message').handle(req({ id: 'nobody' }, { text: 'x' }))), /gone home/);
  await assert.rejects(Promise.resolve(route('/:id/interrupt').handle(req({ id: 'nobody' }, {}))), /No such cloud worker/);
  const hired = (await route('/hire').handle(req({}, hireBody({ prompt: '', deskId: DESK[5].id })))) as { worker: WorkerInfo };
  assert.equal(hired.worker.kind, 'cloud');

  send({ t: 'worker.kill', deleteSession: false });
  await tick();
  assert.equal(cloud.get(w.id), undefined);
  assert.ok(toasts.some((x) => x === `Nik sent ${w.name} home`));
});
