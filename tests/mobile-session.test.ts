import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClientMsg, FloorInfo, ServerMsg, WorkerInfo } from '../src/shared/protocol.js';
import type { HostBootstrap, HostImage, HostLink, HostMessageMeta, HostOffices, MobileHost } from '../src/mobile/host.js';
import { FLOOR_TIMEOUT_MS, OFFLINE, restoreLayout, STALE, Session } from '../src/mobile/session.js';

function worker(id: string, over: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id, kind: 'agent', deskId: `d-${id}`, name: id, color: '#fff', status: 'idle', acked: true, createdBy: 'owner', createdAt: 1, cols: 80, rows: 24, open: false, sessionId: `s-${id}`, ...over };
}
function floor(id: string): FloorInfo {
  return { id, name: id, dir: `/x/${id}`, branch: 'main', palette: 0, addedBy: 'o', addedAt: 0, workers: 0, busy: 0, waiting: 0 };
}
const view = (floorId: string, workers: WorkerInfo[]) => ({
  floor: floorId,
  project: null,
  workers,
  issues: { items: [], fetchedAt: 0, loading: false },
  pulls: { items: [], fetchedAt: 0, loading: false },
  pipelines: {} as never,
  decor: [],
  jira: {} as never,
  jiraBoard: null,
  autoHeal: { on: false },
});
function welcome(floorId: string, workers: WorkerInfo[], floors = ['a', 'b']): ServerMsg {
  return { t: 'welcome', connection: 'c', arrival: { floor: floorId, via: 'saved' }, floors: floors.map(floor), ...view(floorId, workers) } as unknown as ServerMsg;
}
const enter = (floorId: string, workers: WorkerInfo[]): ServerMsg => ({ t: 'floor.enter', arrival: { floor: floorId, via: 'requested' }, ...view(floorId, workers) }) as unknown as ServerMsg;

/** A native host with nothing behind it: what was sent, held and stored, and hooks to speak as the office. */
class FakeHost implements MobileHost {
  sent: ClientMsg[] = [];
  requests: { msg: ClientMsg; resolve: (r: { ok: boolean; error?: string; workerId?: string }) => void }[] = [];
  holds = new Map<string, number>();
  forgotten: string[] = [];
  saved = new Map<string, unknown>();
  stored = new Map<string, unknown>();
  picks: ((images: HostImage[]) => void)[] = [];
  seq = 0;
  link: HostLink = { phase: 'connected', epoch: 1, seq: 0, office: 'o1' };
  boot?: HostBootstrap;
  bootGate?: Promise<void>;
  private msgs = new Set<(m: ServerMsg, meta: HostMessageMeta) => void>();
  private links = new Set<(l: HostLink) => void>();
  private offices = new Set<(o: HostOffices) => void>();
  private incomings = new Set<(i: never) => void>();
  bootstrap = async () => {
    await this.bootGate;
    return this.boot ?? { offices: [{ id: 'o1', name: 'Office' }], active: 'o1', link: this.link, replay: [], seq: this.seq };
  };
  onMessage = (h: (m: ServerMsg, meta: HostMessageMeta) => void) => (this.msgs.add(h), () => this.msgs.delete(h));
  onLink = (h: (l: HostLink) => void) => (this.links.add(h), () => this.links.delete(h));
  onOffices = (h: (o: HostOffices) => void) => (this.offices.add(h), () => this.offices.delete(h));
  onIncoming = (h: (i: never) => void) => (this.incomings.add(h), () => this.incomings.delete(h));
  onScreen = () => () => {};
  screen = () => undefined;
  send = (msg: ClientMsg) => {
    if (this.link.phase !== 'connected') return false;
    this.sent.push(msg);
    return true;
  };
  request = (msg: ClientMsg) => new Promise<{ ok: boolean; error?: string; workerId?: string }>((resolve) => this.requests.push({ msg, resolve }));
  holdWorker = (id: string) => {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.holds.get(id) ?? 1) - 1;
      if (n) this.holds.set(id, n);
      else this.holds.delete(id);
    };
  };
  http = async () => ({ status: 404, body: {} });
  pickImages = () => new Promise<HostImage[]>((resolve) => this.picks.push(resolve));
  forgetImage = (_floor: string, id: string) => void this.forgotten.push(id);
  layout = { load: async (office: string) => this.stored.get(office), save: (office: string, value: unknown) => void this.saved.set(office, value) };
  openPairing() {}
  openOffices() {}
  openSettings() {}
  selectOffice() {}
  haptic() {}
  views = { Terminal: () => null, Management: () => null };
  say(msg: ServerMsg, epoch = this.link.epoch) {
    const meta = { seq: ++this.seq, epoch };
    for (const h of this.msgs) h(msg, meta);
  }
  setLink(link: Omit<HostLink, 'seq'>) {
    this.link = { ...link, seq: ++this.seq };
    for (const h of this.links) h(this.link);
  }
  incoming(i: unknown) {
    for (const h of this.incomings) h(i as never);
  }
}

async function started(host = new FakeHost(), workers = [worker('w1'), worker('w2')]) {
  host.boot = { offices: [{ id: 'o1', name: 'Office' }], active: 'o1', link: host.link, replay: [welcome('a', workers)], seq: host.seq };
  const session = new Session(host);
  await session.start();
  return { host, session };
}
const settle = () => new Promise((r) => setImmediate(r));

test('a warm bootstrap applies its replay and only messages after its seq, in order', async (t) => {
  const host = new FakeHost();
  let open!: () => void;
  host.bootGate = new Promise((r) => (open = r));
  host.seq = 10;
  host.boot = { offices: [{ id: 'o1', name: 'Office' }], active: 'o1', link: { ...host.link, seq: 3 }, replay: [welcome('a', [worker('w1')])], seq: 11 };
  const session = new Session(host);
  t.after(() => session.dispose());
  const starting = session.start();
  host.say({ t: 'worker.update', worker: worker('w1', { status: 'working' }) }); // seq 11: already in the replay
  host.say({ t: 'worker.update', worker: worker('w2') }); // seq 12: after it
  open();
  await starting;
  assert.equal(session.ready(), true);
  assert.equal(session.worker('w1')?.status, 'idle', 'a message the replay reflects is not applied again');
  assert.ok(session.worker('w2'), 'a message after the replay is applied');
});

test('a dispose before the bootstrap answers stops that run; starting again works', async (t) => {
  const host = new FakeHost();
  let open!: () => void;
  host.bootGate = new Promise((r) => (open = r));
  host.boot = { offices: [{ id: 'o1', name: 'Office' }], active: 'o1', link: host.link, replay: [welcome('a', [worker('w1')])], seq: 0 };
  const session = new Session(host);
  t.after(() => session.dispose());
  const first = session.start();
  session.dispose();
  const second = session.start();
  open();
  await Promise.all([first, second]);
  assert.equal(session.ready(), true);
  host.say({ t: 'worker.update', worker: worker('w2') });
  assert.ok(session.worker('w2'), 'one listener per message after a restart');
});

test('connected without a welcome for this socket keeps every action off', async (t) => {
  const host = new FakeHost();
  const session = new Session(host);
  t.after(() => session.dispose());
  await session.start();
  assert.equal(session.snapshot().link.phase, 'connected');
  assert.equal(session.ready(), false);
  assert.equal((await session.request({ t: 'worker.resume', workerId: 'w1' })).error, OFFLINE);
  assert.equal(session.send({ t: 'gong' }), false);
  host.say(welcome('a', [worker('w1')]));
  assert.equal(session.ready(), true);
  host.say(welcome('a', [worker('w1')]), 0);
  assert.equal(session.ready(), true, 'a message from an older socket is ignored');
});

test('an actual disconnect clears drafts and pictures on every floor, keeps panes, and a reconnect needs a new welcome', async (t) => {
  const { host, session } = await started();
  t.after(() => session.dispose());
  session.open('w1');
  session.draft('w1', 'on floor a');
  host.say(enter('b', [worker('w3')]));
  session.open('w3');
  session.draft('w3', 'on floor b');
  assert.equal(session.snapshot().workspace.floors.a.drafts.w1.text, 'on floor a', 'a floor switch keeps drafts');
  const epoch = session.snapshot().workspace.epoch;
  host.setLink({ phase: 'offline', epoch: 1 });
  const ws = session.snapshot().workspace;
  assert.deepEqual(ws.floors.a.drafts, {});
  assert.deepEqual(ws.floors.b.drafts, {});
  assert.equal(ws.floors.a.panes[0].workerId, 'w1');
  assert.equal(ws.epoch, epoch + 1);
  host.setLink({ phase: 'connected', epoch: 2 });
  assert.equal(session.ready(), false);
  host.say(welcome('b', [worker('w3')]));
  assert.equal(session.ready(), true);
  assert.equal(session.floorWorkspace().panes[0].workerId, 'w3', 'panes come back after the reconnect');
  assert.equal(host.requests.length, 0, 'nothing was replayed');
});

test('a send started before a reconnect never clears a draft typed after it, and a stale token is refused', async (t) => {
  const { host, session } = await started();
  t.after(() => session.dispose());
  session.open('w1');
  session.draft('w1', 'hello');
  const sending = session.submit('w1');
  assert.equal(host.requests.length, 1);
  assert.equal(host.requests[0].msg.t, 'worker.prompt');
  assert.equal((host.requests[0].msg as { requestFloor?: string }).requestFloor, 'a');
  host.setLink({ phase: 'offline', epoch: 1 });
  host.setLink({ phase: 'connected', epoch: 2 });
  host.say(welcome('a', [worker('w1'), worker('w2')]));
  session.draft('w1', 'hello');
  host.requests[0].resolve({ ok: true });
  assert.equal(await sending, undefined);
  assert.equal(session.floorWorkspace().drafts.w1.text, 'hello', 'a draft typed on the new socket stays');
  const token = session.token();
  host.say(enter('b', []));
  assert.equal((await session.request({ t: 'worker.resume', workerId: 'w1' }, token)).error, STALE);
});

test('a confirmed send clears its draft; a refused one keeps it', async (t) => {
  const { host, session } = await started();
  t.after(() => session.dispose());
  session.open('w1');
  session.draft('w1', 'one');
  const first = session.submit('w1');
  host.requests[0].resolve({ ok: false, error: 'Nope' });
  assert.equal(await first, 'Nope');
  assert.equal(session.floorWorkspace().drafts.w1.text, 'one');
  const second = session.submit('w1');
  host.requests[1].resolve({ ok: true });
  assert.equal(await second, undefined);
  assert.equal(session.floorWorkspace().drafts.w1.text, '');
});

test('queue sends only while a turn runs, and slash commands are refused while busy', async (t) => {
  const { host, session } = await started(new FakeHost(), [worker('w1', { status: 'working' })]);
  t.after(() => session.dispose());
  session.open('w1');
  session.draft('w1', '/model');
  assert.match((await session.submit('w1')) ?? '', /finishes this turn/);
  session.draft('w1', '/quit');
  assert.match((await session.submit('w1')) ?? '', /Send it home/);
  session.draft('w1', 'later');
  const queued = session.submit('w1', true);
  assert.equal((host.requests[0].msg as { queue?: boolean }).queue, true);
  host.requests[0].resolve({ ok: true });
  await queued;
  assert.equal(session.feeds.queue('a', 'w1').pending.length, 1, 'the receipt is kept until the thread shows it');
});

test('a floor change releases the old floor’s holds before floor.go and refuses actions until floor.enter', async (t) => {
  const { host, session } = await started();
  t.after(() => session.dispose());
  session.setPhone(false);
  session.open('w1', true);
  session.open('w2', true);
  assert.deepEqual([...host.holds.keys()].sort(), ['w1', 'w2']);
  session.view('w2', 'terminal');
  assert.deepEqual([...host.holds.keys()], ['w1'], 'a Raw TTY pane is held by the native terminal itself');
  assert.equal(session.goFloor('b'), true);
  assert.deepEqual([...host.holds.keys()], [], 'holds go before floor.go');
  assert.equal(host.sent.at(-1)?.t, 'floor.go');
  assert.equal(session.ready(), false);
  host.say(enter('b', [worker('w3')]));
  assert.equal(session.ready(), true);
  host.say(enter('a', [worker('w1'), worker('w2')]));
  assert.deepEqual(
    session.floorWorkspace().panes.map((p) => p.workerId),
    ['w1', 'w2'],
    'floor a’s panes come back',
  );
  assert.deepEqual([...host.holds.keys()], ['w1']);
});

test('a phone holds and reads only its one conversation; four distinct panes at most on a tablet', async (t) => {
  const workers = ['w1', 'w2', 'w3', 'w4', 'w5'].map((id) => worker(id));
  const { host, session } = await started(new FakeHost(), workers);
  t.after(() => session.dispose());
  session.setPhone(false);
  for (const w of workers) session.open(w.id, true);
  assert.equal(session.floorWorkspace().panes.length, 4);
  assert.match(session.snapshot().office.toasts.at(-1)?.text ?? '', /At most 4/);
  session.open('w1', true);
  assert.equal(session.floorWorkspace().panes.length, 4, 'a worker is pinned once');
  assert.equal(session.feeds.teamLimit, 3, 'four panes leave the team rollup three children');
  session.setPhone(true);
  assert.deepEqual([...host.holds.keys()], [session.floorWorkspace().active]);
  assert.equal(session.feeds.feeds.size, 1);
});

test('thread reads correlate by request, time out and page back', async (t) => {
  const { host, session } = await started();
  t.after(() => session.dispose());
  session.open('w1');
  session.tick();
  const read = host.sent.find((m) => m.t === 'thread.read') as Extract<ClientMsg, { t: 'thread.read' }>;
  assert.ok(read);
  const feed = session.feeds.feed('w1')!;
  host.say({ t: 'thread.snapshot', workerId: 'w1', request: 'other', sessionId: 's-w1', entries: [], hasMore: false });
  assert.equal(feed.received, false, 'another reader’s answer is not this pane’s');
  const entries = [{ id: 'e2', seq: 2, role: 'user' as const, kind: 'text' as const, text: 'hi' }];
  host.say({ t: 'thread.snapshot', workerId: 'w1', request: read.request, sessionId: 's-w1', entries, hasMore: true });
  assert.equal(feed.received, true);
  session.readEarlier('w1');
  const earlier = host.sent.at(-1) as Extract<ClientMsg, { t: 'thread.read' }>;
  assert.equal(earlier.before, 2);
  feed.pending!.at -= 9000;
  session.tick();
  assert.match(feed.error, /did not return/);
  host.setLink({ phase: 'offline', epoch: 1 });
  assert.equal(feed.error, '', 'a disconnect drops the unanswered read');
});

test('pictures picked under another floor are forgotten, not attached', async (t) => {
  const { host, session } = await started();
  t.after(() => session.dispose());
  session.open('w1');
  const picking = session.attach('w1');
  assert.equal(session.isPicking('w1'), true);
  host.say(enter('b', []));
  host.picks[0]([{ id: 'aaaaaaaaaaaaaaaa', name: 'x.png', preview: 'content://x' }]);
  await picking;
  assert.deepEqual(host.forgotten, ['aaaaaaaaaaaaaaaa']);
  host.say(enter('a', [worker('w1')]));
  assert.equal(session.floorWorkspace().drafts.w1, undefined);
  const again = session.attach('w1');
  host.picks[1]([{ id: 'bbbbbbbbbbbbbbbb', name: 'y.png', preview: 'content://y' }]);
  await again;
  assert.deepEqual(session.floorWorkspace().drafts.w1.attachments, ['bbbbbbbbbbbbbbbb']);
  assert.equal(session.snapshot().previews.bbbbbbbbbbbbbbbb, 'content://y');
  host.setLink({ phase: 'offline', epoch: 1 });
  assert.deepEqual(session.snapshot().previews, {}, 'a disconnect drops the pictures with the drafts');
});

test('a worker link goes to its floor first, then opens it once', async (t) => {
  const { host, session } = await started();
  t.after(() => session.dispose());
  host.incoming({ kind: 'worker', office: 'o1', worker: 'w9', floor: 'b' });
  assert.equal(host.sent.at(-1)?.t, 'floor.go');
  host.say(enter('b', [worker('w9')]));
  assert.equal(session.floorWorkspace().active, 'w9');
  host.incoming({ kind: 'worker', office: 'o1', worker: 'gone' });
  assert.match(session.snapshot().office.toasts.at(-1)?.text ?? '', /gone home/);
});

test('a hire opens its worker once the office lists it, not on another floor', async (t) => {
  const { host, session } = await started();
  t.after(() => session.dispose());
  session.openSoon('w7');
  host.say({ t: 'worker.update', worker: worker('w7') });
  assert.equal(session.floorWorkspace().active, 'w7');
  session.openSoon('w8');
  host.say(enter('b', []));
  host.say({ t: 'worker.update', worker: worker('w8') });
  assert.notEqual(session.floorWorkspace().active, 'w8');
});

test('layouts persist without drafts and restore only valid, distinct panes', async (t) => {
  const { host, session } = await started();
  t.after(() => session.dispose());
  session.open('w1');
  session.draft('w1', 'secret draft');
  await new Promise((r) => setTimeout(r, 450));
  const saved = JSON.stringify(host.saved.get('o1'));
  assert.ok(saved.includes('w1'));
  assert.ok(!saved.includes('secret draft'));
  const restored = restoreLayout(
    JSON.parse(
      '{"floors":{"__proto__":{"panes":[{"workerId":"p"}]},"a":{"panes":[{"workerId":"x","view":"terminal","size":99},{"workerId":"x"},{"workerId":"y"},{"workerId":"z"},{"workerId":"q"},{"workerId":"r"}],"active":"nope","drafts":{"x":{"text":"t","attachments":["i"]}},"collapsed":[1,"lead"]}}}',
    ),
  );
  assert.equal(Object.getPrototypeOf(restored.floors), Object.prototype);
  assert.deepEqual(
    restored.floors.a.panes.map((p) => p.workerId),
    ['x', 'y', 'z', 'q'],
  );
  assert.equal(restored.floors.a.panes[0].view, 'terminal');
  assert.equal(restored.floors.a.panes[0].size, 4);
  assert.equal(restored.floors.a.active, 'x');
  assert.deepEqual(restored.floors.a.drafts, {});
  assert.deepEqual(restored.floors.a.collapsed, ['lead']);
  assert.deepEqual(restoreLayout('nonsense').floors, {});
  assert.equal(restoreLayout({ floors: { a: { panes: [{ workerId: 'x' }], active: '' } } }).floors.a.active, '', 'the roster, left on purpose, stays');
  await settle();
});

test('switching office forgets the last office’s state and drafts', async (t) => {
  const { host, session } = await started();
  t.after(() => session.dispose());
  session.open('w1');
  session.draft('w1', 'unsent');
  host.stored.set('o2', { floors: { z: { panes: [{ workerId: 'k' }], active: 'k' } } });
  const listeners = (host as unknown as { offices: Set<(o: HostOffices) => void> }).offices;
  for (const h of listeners)
    h({
      offices: [
        { id: 'o1', name: 'One' },
        { id: 'o2', name: 'Two' },
      ],
      active: 'o2',
    });
  assert.equal(session.ready(), false);
  assert.deepEqual(session.snapshot().office.workers, {});
  await settle();
  assert.equal(session.snapshot().workspace.floors.z.panes[0].workerId, 'k');
  assert.equal(session.snapshot().workspace.floors.a, undefined);
});

test('a floor change stays refused after the timeout and ends only when the office answers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, session } = await started();
  t.after(() => session.dispose());
  session.open('w1');
  session.goFloor('b');
  t.mock.timers.tick(FLOOR_TIMEOUT_MS + 1);
  assert.equal(session.ready(), false, 'time passing is not an answer');
  assert.equal(session.snapshot().floorSlow, true);
  assert.equal(session.snapshot().switching, 'b');
  assert.equal((await session.request({ t: 'worker.resume', workerId: 'w1' })).error, OFFLINE);
  assert.deepEqual(session.held(), [], 'the old floor stays let go');
  host.say({ t: 'toast', text: 'Someone hired a worker', level: 'info' });
  assert.equal(session.snapshot().switching, 'b', 'an unrelated toast is not a refusal');
  assert.equal(session.askFloorAgain(), true);
  assert.deepEqual(
    host.sent.filter((m) => m.t === 'floor.go'),
    [
      { t: 'floor.go', floor: 'b' },
      { t: 'floor.go', floor: 'b' },
    ],
  );
  assert.equal(session.snapshot().floorSlow, undefined);
  host.say(enter('b', [worker('w3')]));
  assert.equal(session.ready(), true, 'a late arrival is still the answer');
  assert.equal(session.snapshot().office.floor, 'b');
  assert.equal(session.snapshot().floorSlow, undefined);
});

test('the office’s exact floor.go refusal leaves the old floor ready again', async (t) => {
  const { host, session } = await started();
  t.after(() => session.dispose());
  session.open('w1');
  session.goFloor('gone');
  assert.deepEqual(session.held(), []);
  host.say({ t: 'toast', text: 'No such floor', level: 'warn' });
  assert.equal(session.ready(), true);
  assert.equal(session.snapshot().office.floor, 'a');
  assert.deepEqual(session.held(), ['w1'], 'its pane holds again');
});

test('every way of opening a worker is one navigation the app shows, including the same worker again', async (t) => {
  const { host, session } = await started();
  t.after(() => session.dispose());
  const nav = () => session.snapshot().navigation;
  const n0 = nav();
  session.open('w1');
  assert.equal(nav(), n0 + 1);
  session.focus('');
  assert.equal(session.floorWorkspace().active, '', 'back to the roster');
  assert.equal(session.floorWorkspace().panes[0].workerId, 'w1', 'the pane stays');
  assert.deepEqual(session.held(), []);
  session.open('w1');
  assert.equal(session.floorWorkspace().active, 'w1');
  assert.equal(nav(), n0 + 2, 'the same worker again');
  session.managementEvent({ kind: 'open-worker', workerId: 'w2', view: 'tty' });
  assert.equal(nav(), n0 + 3);
  assert.equal(session.floorWorkspace().panes.find((p) => p.workerId === 'w2')?.view, 'terminal');
  host.incoming({ kind: 'worker', office: 'o1', worker: 'w1' });
  assert.equal(nav(), n0 + 4);
  session.openSoon('w5');
  host.say({ t: 'worker.update', worker: worker('w5') });
  assert.equal(nav(), n0 + 5);
  assert.equal(session.floorWorkspace().active, 'w5');
  session.focus('');
  host.say({ t: 'worker.remove', workerId: 'w2' } as ServerMsg);
  assert.equal(session.floorWorkspace().active, '', 'the roster stays the roster when someone leaves');
});

test('panes stop reading and holding while Tools or Device covers them, and come back', async (t) => {
  const { host, session } = await started();
  t.after(() => session.dispose());
  session.open('w1');
  session.draft('w1', 'keep me');
  session.setWorkspaceShown(false);
  assert.deepEqual(session.held(), []);
  const reads = () => host.sent.filter((m) => m.t === 'thread.read').length;
  const before = reads();
  session.tick();
  assert.equal(reads(), before, 'no reads while hidden');
  assert.equal(session.floorWorkspace().drafts.w1.text, 'keep me');
  session.setWorkspaceShown(true);
  assert.deepEqual(session.held(), ['w1']);
  assert.equal(reads(), before + 1, 'reading again at once');
});

test('a failed bootstrap is shown and retried without a second subscription', async (t) => {
  const host = new FakeHost();
  let fail = true;
  const boot = host.bootstrap;
  host.bootstrap = async () => {
    if (fail) throw new Error('No office storage');
    return boot();
  };
  host.boot = { offices: [{ id: 'o1', name: 'Office' }], active: 'o1', link: host.link, replay: [welcome('a', [worker('w1')])], seq: 0 };
  const session = new Session(host);
  t.after(() => session.dispose());
  await session.start();
  assert.equal(session.snapshot().bootError, 'No office storage');
  const listeners = (host as unknown as { msgs: Set<unknown> }).msgs;
  assert.equal(listeners.size, 0);
  fail = false;
  await session.retryStart();
  assert.equal(session.snapshot().bootError, undefined);
  assert.equal(session.ready(), true);
  assert.equal(listeners.size, 1);
});

test('Hire pictures: bounded, tied to their floor and socket, sent once and forgotten when not', async (t) => {
  const { host, session } = await started();
  t.after(() => session.dispose());
  const pics = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`.padEnd(16, '0'), name: `${i}.png`, preview: `content://${i}` }));
  let picking = session.attachHire();
  assert.equal(session.isPickingHire(), true);
  host.picks[0](pics('a', 12));
  await picking;
  assert.equal(session.snapshot().hire?.images.length, 10, 'at most ten');
  assert.deepEqual(host.forgotten, ['a10'.padEnd(16, '0'), 'a11'.padEnd(16, '0')]);
  session.removeHireImage('a0'.padEnd(16, '0'));
  assert.equal(session.snapshot().hire?.images.length, 9);
  const hiring = session.hire({ kind: 'agent', prompt: 'look', worktree: false });
  const spawn = host.requests[0].msg as Extract<ClientMsg, { t: 'worker.spawn' }>;
  assert.equal(spawn.t, 'worker.spawn');
  assert.equal(spawn.images?.length, 9);
  assert.equal(spawn.images?.[0], 'a1'.padEnd(16, '0'));
  host.requests[0].resolve({ ok: true, workerId: 'w9' });
  await hiring;
  assert.equal(session.snapshot().hire, undefined, 'sent once, then gone');
  host.forgotten = [];
  picking = session.attachHire();
  host.picks[1](pics('b', 1));
  await picking;
  const failing = session.hire({ kind: 'agent', prompt: '', worktree: false });
  host.requests[1].resolve({ ok: false, error: 'Every desk and bean bag on this floor is taken' });
  assert.equal((await failing).ok, false);
  assert.equal(session.snapshot().hire, undefined, 'not kept to be re-sent');
  assert.deepEqual(host.forgotten, ['b0'.padEnd(16, '0')]);
  host.forgotten = [];
  picking = session.attachHire();
  host.say(enter('b', []));
  host.picks[2](pics('c', 1));
  await picking;
  assert.equal(session.snapshot().hire, undefined, 'picked under another floor: not attached');
  assert.deepEqual(host.forgotten, ['c0'.padEnd(16, '0')]);
  host.forgotten = [];
  picking = session.attachHire();
  host.picks[3](pics('d', 1));
  await picking;
  host.say(enter('a', [worker('w1')]));
  assert.equal(session.snapshot().hire, undefined, 'a floor change drops them');
  assert.deepEqual(host.forgotten, ['d0'.padEnd(16, '0')]);
  host.forgotten = [];
  picking = session.attachHire();
  host.picks[4](pics('e', 1));
  await picking;
  session.discardHire();
  assert.deepEqual(host.forgotten, ['e0'.padEnd(16, '0')], 'cancel forgets them');
  host.forgotten = [];
  picking = session.attachHire();
  host.picks[5](pics('f', 1));
  await picking;
  host.setLink({ phase: 'offline', epoch: 1 });
  assert.equal(session.snapshot().hire, undefined, 'a disconnect drops them');
  assert.deepEqual(host.forgotten, [], 'nothing is sent while down');
  assert.equal(host.requests.length, 2, 'nothing was replayed');
});
