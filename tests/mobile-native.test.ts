import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHost, NATIVE_EVENT, type NativeOfficeHost } from '../src/mobile/native.js';

function rig(over: Partial<NativeOfficeHost> = {}) {
  const calls: unknown[][] = [];
  let listener: ((payload: string) => void) | undefined;
  let listeners = 0;
  const module: NativeOfficeHost = {
    bootstrap: async () => JSON.stringify({ offices: [{ id: 'o1', name: 'Office' }], active: 'o1', link: { phase: 'connected', epoch: 2, seq: 7, office: 'o1' }, replay: [], seq: 9 }),
    send: (json) => (calls.push(['send', json]), true),
    request: async (json) => (calls.push(['request', json]), JSON.stringify({ ok: true, workerId: 'w1' })),
    hold: (id) => (calls.push(['hold', id]), id === 'bad' ? 0 : 5),
    release: (token) => void calls.push(['release', token]),
    http: async (json) => (calls.push(['http', json]), JSON.stringify({ status: 200, body: { ok: true } })),
    pickImages: async () => JSON.stringify([{ id: 'i1', name: 'a.jpg' }]),
    forgetImage: (floor, id) => void calls.push(['forget', floor, id]),
    layoutLoad: async () => '{"panes":1}',
    layoutSave: (office, json) => void calls.push(['layoutSave', office, json]),
    openPairing: () => void calls.push(['openPairing']),
    openOffices: () => void calls.push(['openOffices']),
    openSettings: () => void calls.push(['openSettings']),
    selectOffice: (id) => void calls.push(['selectOffice', id]),
    haptic: (kind) => void calls.push(['haptic', kind]),
    screen: (id) => (id === 'w1' ? '["row 1","row 2"]' : null),
    ...over,
  };
  const elements: { type: unknown; props: Record<string, unknown> }[] = [];
  const Terminal = () => null;
  const Management = () => null;
  const host = createHost({
    module,
    events: {
      addListener(name, l) {
        assert.equal(name, NATIVE_EVENT);
        listeners++;
        listener = l;
        return { remove() {} };
      },
    },
    views: { Terminal, Management },
    createElement: (type, props) => (elements.push({ type, props }), null as never),
  });
  return { host, calls, elements, emit: (e: unknown) => listener?.(typeof e === 'string' ? e : JSON.stringify(e)), listeners: () => listeners, Terminal, Management };
}

test('subscribes once, before bootstrap, and routes each event kind with its seq and epoch', async () => {
  const r = rig();
  const got: unknown[] = [];
  r.host.onMessage((msg, meta) => got.push(['message', msg.t, meta]));
  r.host.onLink((link) => got.push(['link', link.phase, link.epoch]));
  r.host.onOffices((o) => got.push(['offices', o.active]));
  r.host.onIncoming((i) => got.push(['incoming', i.kind]));
  const off = r.host.onScreen((id) => got.push(['screen', id]));
  const boot = await r.host.bootstrap();
  assert.equal(r.listeners(), 1);
  assert.equal(boot.seq, 9);
  r.emit({ k: 'link', link: { phase: 'connected', epoch: 3, seq: 10 } });
  r.emit({ k: 'message', seq: 11, epoch: 3, msg: { t: 'pong' } });
  r.emit({ k: 'offices', offices: { offices: [], active: 'o2' } });
  r.emit({ k: 'incoming', incoming: { kind: 'floor', office: 'o1', floor: 'f1' } });
  r.emit({ k: 'screen', workerId: 'w1' });
  off();
  r.emit({ k: 'screen', workerId: 'w1' });
  r.emit('not json');
  r.emit({ k: 'message', seq: 12, epoch: 3 });
  assert.deepEqual(got, [
    ['link', 'connected', 3],
    ['message', 'pong', { seq: 11, epoch: 3 }],
    ['offices', 'o2'],
    ['incoming', 'floor'],
    ['screen', 'w1'],
  ]);
});

test('bootstrap refuses an answer it cannot read', async () => {
  const r = rig({ bootstrap: async () => '{' });
  await assert.rejects(r.host.bootstrap(), /could not read/);
});

test('send, request and http cross as JSON; a failed or unreadable request is never retried', async () => {
  const r = rig();
  assert.equal(r.host.send({ t: 'ping' } as never), true);
  assert.deepEqual(await r.host.request({ t: 'worker.kill', workerId: 'w1' } as never), { ok: true, workerId: 'w1' });
  assert.deepEqual(await r.host.http({ method: 'GET', path: '/api/models' }), { status: 200, body: { ok: true } });
  assert.deepEqual(
    r.calls.map((c) => c[0]),
    ['send', 'request', 'http'],
  );
  assert.deepEqual(JSON.parse(r.calls[1][1] as string), { t: 'worker.kill', workerId: 'w1' });

  const thrown = rig({ request: async () => Promise.reject(new Error('The connection dropped')) });
  assert.deepEqual(await thrown.host.request({ t: 'ping' } as never), { ok: false, error: 'The connection dropped' });
  const garbled = rig({ request: async () => 'nope' });
  const res = await garbled.host.request({ t: 'ping' } as never);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /not replayed/);
  assert.equal(garbled.calls.filter((c) => c[0] === 'request').length, 0);
});

test('holdWorker releases its token exactly once, and a refused hold releases nothing', () => {
  const r = rig();
  const release = r.host.holdWorker('w1');
  release();
  release();
  const refused = r.host.holdWorker('bad');
  refused();
  assert.deepEqual(r.calls, [
    ['hold', 'w1'],
    ['release', 5],
    ['hold', 'bad'],
  ]);
});

test('pictures, layout, screens and native screens pass through', async () => {
  const r = rig();
  assert.deepEqual(await r.host.pickImages('f1', 4), [{ id: 'i1', name: 'a.jpg' }]);
  r.host.forgetImage('f1', 'i1');
  assert.deepEqual(await r.host.layout.load('o1'), { panes: 1 });
  r.host.layout.save('o1', { panes: 2 });
  r.host.openPairing();
  r.host.openOffices();
  r.host.openSettings();
  r.host.selectOffice('o2');
  r.host.haptic('tick');
  assert.deepEqual(r.host.screen('w1'), ['row 1', 'row 2']);
  assert.equal(r.host.screen('w2'), undefined);
  assert.deepEqual(r.calls, [['forget', 'f1', 'i1'], ['layoutSave', 'o1', '{"panes":2}'], ['openPairing'], ['openOffices'], ['openSettings'], ['selectOffice', 'o2'], ['haptic', 'tick']]);
  assert.deepEqual(await rig({ pickImages: async () => 'x' }).host.pickImages('f1', 1), []);
});

test('views hand native JSON props and only well-formed tool events back', () => {
  const r = rig();
  r.host.views.Terminal({ workerId: 'w1', active: true });
  r.host.views.Management({ tool: 'issues', floor: 'f1', params: { repo: 'a/b' }, onEvent: (e) => events.push(e) });
  const events: unknown[] = [];
  assert.equal(r.elements[0].type, r.Terminal);
  assert.deepEqual(r.elements[0].props, { workerId: 'w1', active: true, fit: 'phone', style: undefined });
  const mgmt = r.elements[1];
  assert.equal(mgmt.type, r.Management);
  assert.equal(mgmt.props.params, '{"repo":"a/b"}');
  const fire = mgmt.props.onToolEvent as (e: { nativeEvent: { data: string } }) => void;
  fire({ nativeEvent: { data: '{"kind":"switch-floor","floor":"f2"}' } });
  fire({ nativeEvent: { data: '{"floor":"f2"}' } });
  fire({ nativeEvent: { data: 'nope' } });
  assert.deepEqual(events, [{ kind: 'switch-floor', floor: 'f2' }]);
});
