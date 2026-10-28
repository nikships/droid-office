import assert from 'node:assert/strict';
import test from 'node:test';
import { Net, type NetTransport } from '../src/client/net.js';
import { bridgeTransport } from '../src/client/net-bridge.js';
import type { ClientMsg, ServerMsg, WorkerInfo } from '../src/shared/protocol.js';
import { terminalSizing } from '../src/client/terminal-sizing.js';
import { TEAM_THREAD_WORKERS, TeamThread, teamThreadBudget, threadReadInterval } from '../src/client/team-thread.js';

class FakeTransport implements NetTransport {
  sent: ClientMsg[] = [];
  connects = 0;
  closes = 0;
  open = false;
  private messages = new Set<(msg: ServerMsg) => void>();
  private statuses = new Set<(up: boolean) => void>();
  connect() {
    this.connects++;
  }
  close() {
    this.closes++;
    this.status(false);
  }
  send(msg: ClientMsg) {
    if (!this.open) return false;
    this.sent.push(msg);
    return true;
  }
  onMessage(fn: (msg: ServerMsg) => void) {
    this.messages.add(fn);
    return () => this.messages.delete(fn);
  }
  onStatus(fn: (up: boolean) => void) {
    this.statuses.add(fn);
    return () => this.statuses.delete(fn);
  }
  status(up: boolean) {
    this.open = up;
    for (const fn of this.statuses) fn(up);
  }
  deliver(msg: ServerMsg) {
    for (const fn of this.messages) fn(msg);
  }
  take() {
    return this.sent.splice(0).map((m) => ('workerId' in m ? `${m.t}:${m.workerId}` : m.t));
  }
}

const worker = (id: string) => ({ id }) as WorkerInfo;
const welcome = (floor: string, ids: string[]) => ({ t: 'welcome', floor, workers: ids.map(worker) }) as unknown as ServerMsg;
const enter = (floor: string, ids: string[]) => ({ t: 'floor.enter', floor, workers: ids.map(worker), arrival: { floor, via: 'requested' } }) as unknown as ServerMsg;

function rig() {
  const transport = new FakeTransport();
  let floor: string | null = null;
  const net = new Net(
    () => ({ name: 'Owner', color: '#fff' }) as never,
    () => null,
    { transport, floor: () => floor },
  );
  net.onMessage((msg) => {
    if (msg.t === 'welcome' || msg.t === 'floor.enter') floor = msg.floor;
  });
  return { net, transport };
}

function online() {
  const r = rig();
  r.transport.status(true);
  r.transport.deliver(welcome('a', ['w1', 'w2']));
  r.transport.take();
  return r;
}

test('an external transport carries the connection without a WebSocket, and connect/close go through it', () => {
  const { net, transport } = rig();
  void net.connect();
  assert.equal(transport.connects, 1);
  assert.equal(net.up, false);
  assert.equal(net.send({ t: 'worker.detach', workerId: 'w1' }), false, 'nothing is sent while down');
  transport.status(true);
  assert.equal(net.up, true);
  assert.equal(net.ready, false, 'up is not ready before the office says where this connection is');
  transport.deliver(welcome('a', []));
  assert.equal(net.ready, true);
  assert.equal(net.floor, 'a');
  net.close();
  assert.equal(transport.closes, 1);
  assert.equal(net.up, false);
  assert.equal(net.ready, false);
});

test('ready fires only after every message handler saw the welcome, and false fires on loss', () => {
  const { net, transport } = rig();
  const order: string[] = [];
  net.onMessage((msg) => order.push(`message:${msg.t}`));
  net.onReady((ready) => order.push(`ready:${ready}`));
  transport.status(true);
  transport.deliver(welcome('a', []));
  transport.status(false);
  assert.deepEqual(order, ['message:welcome', 'ready:true', 'ready:false']);
});

test('terminal holds are reference counted: closing one view never detaches another', () => {
  const { net, transport } = online();
  const thread = net.acquireTerminal('w1');
  assert.deepEqual(transport.take(), ['worker.attach:w1']);
  assert.equal(thread.attached, true);
  const changes = net.acquireTerminal('w1');
  assert.deepEqual(transport.take(), [], 'a second hold reuses the attachment');
  const pane = net.acquireTerminal('w1', { snapshot: true });
  assert.deepEqual(transport.take(), ['worker.attach:w1'], 'a terminal view asks for its own snapshot');
  changes.release();
  changes.release();
  pane.release();
  assert.deepEqual(transport.take(), [], 'release is idempotent and the last holder keeps it');
  assert.equal(net.terminalHeld('w1'), true);
  // A view not yet migrated to holds closing with a raw detach must not cut the held stream.
  assert.equal(net.send({ t: 'worker.detach', workerId: 'w1' }), true);
  assert.deepEqual(transport.take(), []);
  thread.release();
  assert.deepEqual(transport.take(), ['worker.detach:w1']);
  assert.equal(net.terminalHeld('w1'), false);
  assert.equal(thread.attached, false);
});

test('a raw attach while a hold exists survives that hold, until the raw viewer detaches', () => {
  const { net, transport } = online();
  const hold = net.acquireTerminal('w1');
  assert.deepEqual(transport.take(), ['worker.attach:w1']);
  assert.equal(net.send({ t: 'worker.attach', workerId: 'w1' }), true);
  assert.deepEqual(transport.take(), ['worker.attach:w1'], 'the legacy viewer gets its own snapshot');
  hold.release();
  assert.deepEqual(transport.take(), [], 'the legacy viewer is still watching');
  net.send({ t: 'worker.detach', workerId: 'w1' });
  assert.deepEqual(transport.take(), ['worker.detach:w1']);
});

test('a raw attach by an unmigrated view keeps the stream after the last hold goes', () => {
  const { net, transport } = online();
  const hold = net.acquireTerminal('w1');
  net.send({ t: 'worker.attach', workerId: 'w2' });
  const other = net.acquireTerminal('w2');
  transport.take();
  other.release();
  assert.deepEqual(transport.take(), [], 'w2 was attached raw, so its raw owner detaches it');
  net.send({ t: 'worker.detach', workerId: 'w2' });
  assert.deepEqual(transport.take(), ['worker.detach:w2']);
  hold.release();
  assert.deepEqual(transport.take(), ['worker.detach:w1']);
});

test('holds reattach once after a reconnect, only for workers on the arrival floor, with no replay', () => {
  const { net, transport } = online();
  const a = net.acquireTerminal('w1');
  const b = net.acquireTerminal('gone');
  transport.take();
  const prompt = net.request({ t: 'worker.prompt', workerId: 'w1', prompt: 'hi' });
  transport.take();
  transport.status(false);
  assert.equal(a.attached, false);
  transport.status(true);
  assert.deepEqual(transport.take(), [], 'nothing is sent before the authoritative welcome');
  transport.deliver(welcome('a', ['w1', 'w2']));
  assert.deepEqual(transport.take(), ['worker.attach:w1'], 'reattached once; the prompt is not replayed; a missing worker is not attached');
  assert.equal(a.attached, true);
  assert.equal(b.attached, false);
  return prompt.then((result) => {
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /not replayed/);
  });
});

test('a view that re-sends its own attach on welcome is not attached twice', () => {
  const { net, transport } = online();
  const hold = net.acquireTerminal('w1');
  transport.take();
  net.onMessage((msg) => {
    if (msg.t === 'welcome') net.send({ t: 'worker.attach', workerId: 'w1' });
  });
  transport.status(false);
  transport.status(true);
  transport.deliver(welcome('a', ['w1']));
  assert.deepEqual(transport.take(), ['worker.attach:w1']);
  assert.equal(hold.attached, true);
});

test('floor.go makes the connection unready before it is sent, and arrival restores ready on the new floor', () => {
  const { net, transport } = online();
  const order: string[] = [];
  const hold = net.acquireTerminal('w1');
  transport.take();
  net.onReady((ready) => order.push(`ready:${ready}:${transport.sent.length}`));
  const stamp = net.stamp();
  assert.equal(net.current(stamp), true);
  assert.equal(net.send({ t: 'floor.go', floor: 'b' }), true);
  assert.deepEqual(order, ['ready:false:0'], 'old-floor views are told before floor.go is on the wire');
  assert.equal(net.ready, false);
  assert.equal(net.current(stamp), false, 'an upload started before the switch is stale');
  assert.equal(hold.attached, false);
  transport.deliver(enter('b', ['x']));
  assert.equal(net.ready, true);
  assert.equal(net.floor, 'b');
  assert.equal(net.current(stamp), false);
  assert.deepEqual(transport.take(), ['floor.go'], 'a hold for a worker not on this floor is not attached');
  transport.deliver(enter('a', ['w1']));
  assert.deepEqual(transport.take(), ['worker.attach:w1'], 'back on its floor, the held worker is attached again');
  hold.release();
});

test('a transport that delivers the arrival while floor.go is being sent leaves the connection ready on the new floor', () => {
  const { net, transport } = online();
  const order: string[] = [];
  net.onReady((ready) => order.push(`ready:${ready}:${transport.sent.length}`));
  const hold = net.acquireTerminal('w1');
  transport.take();
  const send = transport.send.bind(transport);
  transport.send = (msg) => {
    const ok = send(msg);
    if (msg.t === 'floor.go') transport.deliver(enter(msg.floor, ['w1']));
    return ok;
  };
  assert.equal(net.send({ t: 'floor.go', floor: 'b' }), true);
  assert.deepEqual(order, ['ready:false:0', 'ready:true:2'], 'unready before the send reached the transport');
  assert.equal(net.ready, true);
  assert.equal(net.floor, 'b');
  assert.equal(hold.attached, true);
  assert.deepEqual(transport.take(), ['floor.go', 'worker.attach:w1']);
});

test('a floor.go the transport refuses leaves the connection ready where it was, without re-attaching', () => {
  const { net, transport } = online();
  const hold = net.acquireTerminal('w1');
  transport.take();
  const order: boolean[] = [];
  net.onReady((ready) => order.push(ready));
  const stamp = net.stamp();
  transport.send = () => false;
  assert.equal(net.send({ t: 'floor.go', floor: 'b' }), false);
  assert.deepEqual(order, [false, true]);
  assert.equal(net.ready, true);
  assert.equal(net.floor, 'a');
  assert.equal(net.current(stamp), false, 'views disposed for the attempt start a new epoch');
  assert.equal(hold.attached, true, 'the server never left the floor, so the attachment still stands');
  assert.deepEqual(transport.take(), []);
});

test('a floor.go to a socket that is already down sends nothing and changes nothing', () => {
  const { net, transport } = online();
  transport.status(false);
  const order: boolean[] = [];
  net.onReady((ready) => order.push(ready));
  assert.equal(net.send({ t: 'floor.go', floor: 'b' }), false);
  assert.deepEqual(order, []);
  assert.equal(net.ready, false);
});

test('floor.go to the current floor is sent without leaving ready, and a refused switch comes back ready', () => {
  const { net, transport } = online();
  const stamp = net.stamp();
  net.send({ t: 'floor.go', floor: 'a' });
  assert.equal(net.current(stamp), true);
  net.send({ t: 'floor.go', floor: 'missing' });
  assert.equal(net.ready, false);
  transport.deliver({ t: 'toast', text: 'Something unrelated went wrong', level: 'warn' } as ServerMsg);
  assert.equal(net.ready, false, 'an unrelated warning is not the refusal');
  transport.deliver({ t: 'toast', text: 'No such floor', level: 'warn' } as ServerMsg);
  assert.equal(net.ready, true);
  assert.equal(net.floor, 'a');
  assert.equal(net.current(stamp), false, 'work begun before the attempted switch is still stale');
});

test('connection lost fires on an actual loss and close, never on a floor switch', () => {
  const { net, transport } = online();
  let lost = 0;
  net.onConnectionLost(() => lost++);
  net.send({ t: 'floor.go', floor: 'b' });
  transport.deliver(enter('b', []));
  assert.equal(lost, 0);
  transport.status(false);
  assert.equal(lost, 1);
  transport.status(false);
  assert.equal(lost, 1, 'a second down report is not a second loss');
  transport.status(true);
  transport.deliver(welcome('b', []));
  net.close();
  assert.equal(lost, 2);
});

test('requests keep receipts over an external transport', async () => {
  const { net, transport } = online();
  const pending = net.request({ t: 'worker.resume', workerId: 'w1' });
  const sent = transport.sent.at(-1) as Extract<ClientMsg, { t: 'worker.resume' }> & { requestId: string; requestFloor?: string };
  assert.equal(sent.requestFloor, 'a');
  transport.deliver({ t: 'action.result', requestId: sent.requestId, ok: true });
  assert.deepEqual(await pending, { t: 'action.result', requestId: sent.requestId, ok: true });
  transport.status(false);
  const refused = await net.request({ t: 'worker.resume', workerId: 'w1' });
  assert.equal(refused.error, 'Disconnected. Nothing was sent.');
});

test('only the active, laid-out pane sizes the shared PTY', () => {
  const base = { guest: false, active: true, laidOut: true, typing: false, adoptShared: false };
  assert.equal(terminalSizing(base), 'fit-send');
  assert.equal(terminalSizing({ ...base, laidOut: false }), 'none', 'a hidden or zero-size host never resizes');
  assert.equal(terminalSizing({ ...base, laidOut: false, typing: true }), 'none');
  assert.equal(terminalSizing({ ...base, active: false }), 'follow', 'a background pane mirrors the PTY size');
  assert.equal(terminalSizing({ ...base, active: false, typing: true }), 'follow');
  assert.equal(terminalSizing({ ...base, adoptShared: true }), 'follow', 'opening beside another window adopts its size');
  assert.equal(terminalSizing({ ...base, adoptShared: true, typing: true }), 'fit-send', 'typing reclaims it');
  assert.equal(terminalSizing({ ...base, guest: true, active: false }), 'fit-only');
});

test('thread polling stays inside the server reader cache with four panes', () => {
  assert.equal(threadReadInterval(true), 1000);
  assert.ok(threadReadInterval(false) > 1000);
  assert.equal(teamThreadBudget(1), TEAM_THREAD_WORKERS);
  assert.equal(teamThreadBudget(4), 3);
  assert.equal(teamThreadBudget(8), 0);
  for (let panes = 0; panes <= 4; panes++) assert.ok(panes + teamThreadBudget(panes) <= 7, 'one slot stays free for history paging');
  const team = new TeamThread();
  const children = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, lead: 'lead', kind: 'agent', createdAt: i, sessionId: `s${i}` }) as WorkerInfo);
  team.sync('scope', 'lead', children, teamThreadBudget(4));
  assert.equal(team.members.size, 3);
  assert.equal(team.total, 8);
});

test('the native bridge transport parses only well-formed envelopes and never sends while down', () => {
  const posted: unknown[] = [];
  let deliver: (event: { data: unknown }) => void = () => {};
  const transport = bridgeTransport({ postMessage: (data) => posted.push(JSON.parse(data)), addEventListener: (_type, fn) => (deliver = fn) });
  const net = new Net(
    () => ({ name: 'Owner', color: '#fff' }) as never,
    () => null,
    { transport },
  );
  const seen: string[] = [];
  net.onMessage((msg) => seen.push(msg.t));
  void net.connect();
  assert.deepEqual(posted, [{ kind: 'connect' }]);
  assert.equal(net.send({ t: 'worker.attach', workerId: 'w1' }), false);
  deliver({ data: JSON.stringify({ kind: 'message', msg: { t: 'toast', text: 'early', level: 'info' } }) });
  assert.deepEqual(seen, [], 'messages before native says up are dropped');
  deliver({ data: JSON.stringify({ kind: 'status', up: true }) });
  deliver({ data: 'not json' });
  deliver({ data: { kind: 'status', up: false } });
  deliver({ data: JSON.stringify({ kind: 'message', msg: { nope: 1 } }) });
  assert.equal(net.up, true, 'malformed and non-string envelopes are ignored');
  deliver({ data: JSON.stringify({ kind: 'message', msg: welcome('a', ['w1']) }) });
  assert.equal(net.ready, true);
  const hold = net.acquireTerminal('w1');
  assert.deepEqual(posted.at(-1), { kind: 'send', msg: { t: 'worker.attach', workerId: 'w1' } });
  deliver({ data: JSON.stringify({ kind: 'status', up: false }) });
  assert.equal(net.ready, false);
  assert.equal(hold.attached, false);
  net.close();
  assert.deepEqual(posted.at(-1), { kind: 'close' });
});
