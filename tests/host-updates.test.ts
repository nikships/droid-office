import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { ChildProcess } from 'node:child_process';
import type { HostUpdateRequest } from '../src/shared/host-update.js';
import { UpdateController, type UpdateBackend } from '../src/desktop/update-controller.js';
import { serveHostUpdates, updateRequest } from '../src/desktop/update-ipc.js';
import { HostUpdates, hostUpdateCommand } from '../src/server/host-updates.js';
import { isHostUpdateState } from '../src/shared/host-update-state.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function rig(enabled = true) {
  const check = deferred<string | undefined>();
  const download = deferred<void>();
  const stopped = deferred<void>();
  const calls: string[] = [];
  const renders: { phase: string; open: boolean }[] = [];
  let preparing = () => {};
  const backend: UpdateBackend = {
    enabled,
    currentVersion: '0.1.0',
    check: () => {
      calls.push('check');
      return check.promise;
    },
    download: (_version, prepare) => {
      calls.push('download');
      preparing = prepare;
      return { promise: download.promise, cancel: () => calls.push('cancel') };
    },
    beforeInstall: () => {
      calls.push('stop');
      return stopped.promise;
    },
    quitAndInstall: () => {
      calls.push('quit');
    },
    render: (phase, open) => renders.push({ phase: phase.kind, open }),
    close: () => controller.closed(),
  };
  const controller = new UpdateController(backend);
  return { controller, backend, check, download, stopped, calls, renders, prepare: () => preparing() };
}

test('remote updates check without a native window and install only the confirmed offered version', async () => {
  const r = rig();
  assert.equal(r.controller.state.phase, 'idle');
  assert.throws(() => r.controller.remote({ action: 'install', version: '0.1.1' }), /offered update changed/);
  assert.equal(r.controller.remote({ action: 'check' }).phase, 'checking');
  r.controller.remote({ action: 'check' });
  assert.deepEqual(r.calls, ['check'], 'simultaneous clients share one check');
  r.check.resolve('0.1.1');
  await setImmediate();
  assert.equal(r.controller.state.canInstall, true);
  assert.throws(() => r.controller.remote({ action: 'install', version: '0.1.2' }), /offered update changed/);
  assert.equal(r.controller.remote({ action: 'install', version: '0.1.1' }).phase, 'downloading');
  assert.throws(() => r.controller.remote({ action: 'install', version: '0.1.1' }), /offered update changed/);
  r.controller.remote({ action: 'check' });
  r.controller.progress(50, 100);
  assert.equal(r.controller.state.progress, 0.5);
  assert.deepEqual(r.calls, ['check', 'download']);
  r.prepare();
  assert.equal(r.controller.state.phase, 'preparing');
  await setImmediate();
  assert.ok(!r.calls.includes('stop'), 'native signature verification must finish before stopping workers');
  r.download.resolve();
  await setImmediate();
  assert.equal(r.controller.state.phase, 'restarting');
  assert.deepEqual(r.calls, ['check', 'download', 'stop']);
  r.stopped.resolve();
  await setImmediate();
  assert.deepEqual(r.calls, ['check', 'download', 'stop', 'quit']);
  assert.ok(
    r.renders.every((render) => !render.open),
    'a remote flow never needs a native confirmation window',
  );
});

test('checkout hosts cannot update, failed checks are readable, and latest never enables install', async () => {
  const checkout = rig(false);
  assert.equal(checkout.controller.remote({ action: 'status' }).supported, false);
  assert.equal(checkout.controller.remote({ action: 'check' }).phase, 'unpackaged');
  assert.throws(() => checkout.controller.remote({ action: 'install', version: '0.1.1' }));
  assert.deepEqual(checkout.calls, []);
  const r = rig();
  r.controller.remote({ action: 'check' });
  r.check.reject(new Error('Network failed\nprivate response body'));
  await setImmediate();
  assert.equal(r.controller.state.detail, 'Network failed');
  assert.equal(r.controller.state.canInstall, false);
  const latest = rig();
  const checking = latest.controller.check(true);
  latest.check.resolve(undefined);
  await checking;
  assert.equal(latest.controller.state.phase, 'latest');
  assert.equal(latest.controller.state.canInstall, false);
  assert.equal(latest.renders.at(-1)?.open, true);
});

test('download/signature failures never quit and allow an explicit retry of the same version', async () => {
  const r = rig();
  r.controller.remote({ action: 'check' });
  r.check.resolve('0.1.1');
  await setImmediate();
  r.controller.remote({ action: 'install', version: '0.1.1' });
  r.download.reject(new Error('Signature mismatch'));
  await setImmediate();
  assert.equal(r.controller.state.phase, 'error');
  assert.equal(r.controller.state.canInstall, true);
  assert.equal(r.controller.state.detail, 'Signature mismatch');
  assert.deepEqual(r.calls, ['check', 'download']);
  const retry = deferred<void>();
  r.backend.download = () => ({ promise: retry.promise, cancel: () => {} });
  r.controller.remote({ action: 'install', version: '0.1.1' });
  retry.resolve();
  r.stopped.reject(new Error('Already stopped'));
  await setImmediate();
  assert.ok(r.calls.includes('quit'), 'a shutdown error retains the existing final quit fallback');
});

test('local cancellation drops stale checks and downloads but cannot interrupt native preparation', async () => {
  const r = rig();
  const checking = r.controller.check(true);
  r.controller.act('close');
  r.check.resolve('0.1.1');
  await checking;
  assert.equal(r.controller.state.phase, 'idle');
  await r.controller.check(true);
  r.controller.act('install');
  r.controller.act('cancel');
  assert.ok(r.calls.includes('cancel'));
  r.download.resolve();
  await setImmediate();
  assert.ok(!r.calls.includes('quit'));
  assert.equal(r.controller.state.phase, 'idle');
  const prepared = rig();
  prepared.controller.remote({ action: 'check' });
  prepared.check.resolve('0.1.1');
  await setImmediate();
  prepared.controller.remote({ action: 'install', version: '0.1.1' });
  prepared.prepare();
  prepared.controller.closed();
  prepared.download.resolve();
  prepared.stopped.resolve();
  await setImmediate();
  assert.equal(prepared.controller.state.phase, 'restarting');
  assert.ok(prepared.calls.includes('quit'));
});

test('background offers, Later, manual takeover and progress share the local flow', async () => {
  const r = rig();
  const background = r.controller.check(false);
  await r.controller.check(true);
  r.check.resolve('0.1.1');
  await background;
  assert.equal(r.renders.at(-1)?.open, true);
  r.controller.act('later');
  await r.controller.check(false);
  assert.equal(r.controller.state.phase, 'available', 'Later hides the local offer, not its availability to companions');
  assert.equal(r.renders.at(-1)?.open, false);
  r.controller.remote({ action: 'check' });
  await setImmediate();
  assert.equal(r.controller.state.phase, 'available', 'remote manual checks ignore Later');
  assert.equal(r.renders.at(-1)?.open, false);
  await r.controller.check(true);
  const count = r.calls.length;
  await r.controller.check(false);
  assert.equal(r.calls.length, count, 'background checks do not replace an open local offer');
  r.controller.act('install');
  r.controller.progress(200, 100);
  assert.equal(r.controller.state.progress, 1);
  r.download.reject(new Error('Interrupted'));
  await setImmediate();
  r.controller.act('retry');
  await setImmediate();
  assert.equal(r.calls.filter((call) => call === 'download').length, 2);
});

test('only fixed, bounded updater commands cross HTTP and private IPC', () => {
  for (const bad of [null, [], 3, {}, { action: 'status' }, { action: 'shell' }, { action: 'install' }, { action: 'install', version: '' }, { action: 'install', version: 'x'.repeat(101) }]) assert.equal(hostUpdateCommand(bad), undefined);
  assert.deepEqual(hostUpdateCommand({ action: 'check', url: '/not-used' }), { action: 'check' });
  assert.deepEqual(hostUpdateCommand({ action: 'install', version: '0.1.1' }), { action: 'install', version: '0.1.1' });
  for (const bad of [
    null,
    1,
    {},
    { t: 'host.update', id: 'x' },
    { t: 'host.update', id: 1, command: { action: 'status' } },
    { t: 'host.update', id: '', command: { action: 'status' } },
    { t: 'host.update', id: 'x'.repeat(101), command: { action: 'status' } },
    { t: 'host.update', id: 'x', command: { action: 'exec' } },
  ])
    assert.equal(updateRequest(bad), undefined);
  assert.ok(updateRequest({ t: 'host.update', id: 'x', command: { action: 'status' } }));
});

test('private IPC correlates simultaneous clients, refuses stale installs and cleans up on disconnect', async () => {
  const parent = Object.assign(new EventEmitter(), {
    connected: true,
    send: (value: unknown, callback: () => void) => {
      child.emit('message', value);
      callback();
    },
  });
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    send: (value: unknown, callback: (err: null) => void) => {
      parent.emit('message', value);
      callback(null);
    },
  });
  const r = rig();
  serveHostUpdates(parent as unknown as ChildProcess, (command) => r.controller.remote(command));
  const client = new HostUpdates(child as unknown as NodeJS.Process);
  try {
    const states = await Promise.all([client.request({ action: 'status' }), client.request({ action: 'check' })]);
    assert.deepEqual(
      states.map((s) => s.phase),
      ['idle', 'checking'],
    );
    await assert.rejects(client.request({ action: 'install', version: '0.1.1' }), /offered update changed/);
    parent.emit('message', { t: 'unrelated' });
    child.emit('message', { t: 'host.update.result', id: 'stale', state: {} });
    r.check.resolve('0.1.1');
    await setImmediate();
    assert.equal((await client.request({ action: 'status' })).version, '0.1.1');
    parent.connected = false;
    const pending = client.request({ action: 'status' });
    child.emit('disconnect');
    await assert.rejects(pending, /disconnected/);
  } finally {
    client.dispose();
  }
  assert.equal(child.listenerCount('message'), 0);
  await assert.rejects(client.request({ action: 'status' }), /disconnected/);
  client.dispose();
});

test('IPC timeout, send failure, missing status and unavailable hosts fail without replay', async () => {
  const absent = new HostUpdates(Object.assign(new EventEmitter(), { connected: false }) as unknown as NodeJS.Process);
  assert.equal((await absent.request({ action: 'status' })).supported, false);
  await assert.rejects(absent.request({ action: 'check' }), /packaged Mac app/);
  absent.dispose();
  const sent: HostUpdateRequest[] = [];
  const channel = Object.assign(new EventEmitter(), {
    connected: true,
    send: (value: HostUpdateRequest, callback: (err: Error | null) => void) => {
      sent.push(value);
      callback(null);
    },
  });
  const client = new HostUpdates(channel as unknown as NodeJS.Process, 20);
  await assert.rejects(client.request({ action: 'check' }), /did not answer/);
  assert.equal(sent.length, 1);
  const missing = client.request({ action: 'status' });
  channel.emit('message', { t: 'host.update.result', id: sent.at(-1)!.id });
  await assert.rejects(missing, /no status/);
  const malformed = client.request({ action: 'status' });
  channel.emit('message', { t: 'host.update.result', id: sent.at(-1)!.id, state: { canInstall: true } });
  await assert.rejects(malformed, /no status/);
  channel.send = (_value, callback) => callback(new Error('Pipe closed'));
  await assert.rejects(client.request({ action: 'check' }), /Pipe closed/);
  channel.send = () => {
    throw new Error('No channel');
  };
  await assert.rejects(client.request({ action: 'check' }), /No channel/);
  client.dispose();
});

test('update state validation rejects malformed or unsafe install controls', () => {
  const state = rig().controller.state;
  assert.ok(isHostUpdateState(state));
  assert.ok(isHostUpdateState({ ...state, progress: 0.5 }));
  for (const bad of [
    null,
    [],
    {},
    { ...state, title: null },
    { ...state, busy: 'no' },
    { ...state, detail: 2 },
    { ...state, progress: NaN },
    { ...state, progress: -1 },
    { ...state, progress: 2 },
    { ...state, canInstall: true },
    { ...state, canInstall: true, supported: false, version: '0.1.1' },
    { ...state, canInstall: true, busy: true, version: '0.1.1' },
  ])
    assert.equal(isHostUpdateState(bad), false);
  assert.ok(isHostUpdateState({ ...state, canInstall: true, version: '0.1.1' }));
});
