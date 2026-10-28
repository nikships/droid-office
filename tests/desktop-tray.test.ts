import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus, statusLines, trayMenu, trayTooltip, type TrayView } from '../src/desktop/tray-model.ts';
import { officeStatus } from '../src/server/office-status.ts';

const status = { workers: 4, working: 2, needsInput: 1, phones: 1, browsers: 2 };

test('the office counts busy workers, and each phone once however many sockets it holds', () => {
  const workers = [{ status: 'working' }, { status: 'working' }, { status: 'needs_input' }, { status: 'idle' }, { status: 'starting' }] as const;
  const connections = [{ device: 'p1', phone: true }, { device: 'p1', phone: true }, { device: 'p2', phone: true }, { device: 'b1', phone: false }, { phone: false }];
  assert.deepEqual(officeStatus(workers, connections), { workers: 5, working: 2, needsInput: 1, phones: 2, browsers: 2 });
  assert.deepEqual(officeStatus([], []), { workers: 0, working: 0, needsInput: 0, phones: 0, browsers: 0 });
});

test('a status the office sends is read, and anything else is dropped', () => {
  assert.deepEqual(parseStatus({ ...status, extra: 'x' }), status);
  for (const bad of [undefined, null, 'ok', {}, { ...status, phones: -1 }, { ...status, working: 1.5 }, { ...status, browsers: '2' }]) assert.equal(parseStatus(bad), undefined);
});

test('the menu says what the office is doing, leaving out the app’s own window', () => {
  const running: TrayView = { state: 'running', status, ownWindow: false, external: false };
  assert.deepEqual(statusLines(running), ['2 working · 1 needs input', '1 phone · 2 browsers connected']);
  assert.deepEqual(statusLines({ ...running, ownWindow: true }), ['2 working · 1 needs input', '1 phone · 1 browser connected']);
  assert.deepEqual(statusLines({ ...running, status: { workers: 3, working: 0, needsInput: 2, phones: 0, browsers: 1 }, ownWindow: true }), ['2 need input', 'No phones or browsers connected']);
  assert.deepEqual(statusLines({ ...running, status: { workers: 1, working: 0, needsInput: 0, phones: 2, browsers: 0 } }), ['1 worker, none busy', '2 phones connected']);
  assert.deepEqual(statusLines({ ...running, status: { workers: 0, working: 0, needsInput: 0, phones: 0, browsers: 0 } }), ['No workers', 'No phones or browsers connected']);
  assert.deepEqual(statusLines({ state: 'running', ownWindow: false, external: true }), ['The office is running', 'Started outside the app']);
  assert.deepEqual(statusLines({ state: 'starting', ownWindow: false, external: false }), ['The office is starting…']);
  assert.deepEqual(statusLines({ state: 'stopped', ownWindow: false, external: false }), ['The office is stopped']);
  assert.equal(trayTooltip(running), 'Droid Office\n2 working · 1 needs input\n1 phone · 2 browsers connected');
});

test('the menu offers only what the office can do in its state', () => {
  const enabled = (v: TrayView) => Object.fromEntries(trayMenu(v).flatMap((i) => ('action' in i && i.action ? [[i.action, i.enabled]] : [])));
  const labels = (v: TrayView) => trayMenu(v).flatMap((i) => ('label' in i ? [i.label] : []));
  const running: TrayView = { state: 'running', status, ownWindow: false, external: false };
  assert.deepEqual(enabled(running), { open: true, browser: true, restart: true, updates: true, log: true, quit: true, quitStoppingWorkers: true });
  assert.deepEqual(labels(running).slice(2), ['Open Office', 'Open in Browser', 'Restart Office', 'Check for Updates…', 'Show Office Log', 'Quit Droid Office', 'Quit and Stop Workers…']);
  assert.deepEqual(trayMenu(running).slice(0, 2), [
    { label: '2 working · 1 needs input', enabled: false },
    { label: '1 phone · 2 browsers connected', enabled: false },
  ]);
  assert.deepEqual(enabled({ ...running, external: true }), { open: true, browser: true, restart: false, updates: true, log: true, quit: true, quitStoppingWorkers: false });
  const stopped: TrayView = { state: 'stopped', ownWindow: false, external: false };
  assert.deepEqual(enabled(stopped), { open: true, browser: false, restart: true, updates: true, log: true, quit: true, quitStoppingWorkers: false });
  assert.ok(labels(stopped).includes('Start Office'));
  assert.deepEqual(enabled({ state: 'starting', ownWindow: false, external: false }), { open: false, browser: false, restart: false, updates: true, log: true, quit: true, quitStoppingWorkers: false });
});
