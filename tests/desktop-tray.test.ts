import test from 'node:test';
import assert from 'node:assert/strict';
import { type OfficeStatus, parseStatus, type StatusWaiting, statusLines, switchLabel, listCut, type TrayItem, trayMenu, trayTitle, trayTooltip, type TrayView, WaitingWatch, waitingNotice, workerHash } from '../src/desktop/tray-model.ts';
import { officeStatus, STATUS_WAITING_MAX } from '../src/server/office-status.ts';
import { linkStep, parseWorkerLink } from '../src/client/worker-link.ts';

const ada: StatusWaiting = { id: 'w-ada', name: 'Ada', status: 'needs_input', floor: 'f-web', floorName: 'web-app', task: 'Fix Login Redirect', since: 100 };
const bob: StatusWaiting = { id: 'w-bob', name: 'Bob', status: 'done', floor: 'f-api', floorName: 'api', since: 50 };
const status: OfficeStatus = { workers: 4, working: 2, needsInput: 1, done: 1, phones: 1, browsers: 2, floors: 2, waiting: [ada, bob] };
const base = { ownWindows: 0, mode: 'office' as const, external: false, notify: true, version: '0.1.420' };
const running: TrayView = { state: 'running', status, ...base };

const labels = (v: TrayView) => trayMenu(v).flatMap((i) => ('label' in i ? [i.label] : []));
const item = (v: TrayView, label: string) => trayMenu(v).find((i): i is Extract<TrayItem, { enabled: boolean }> => 'enabled' in i && i.label === label);

test('the office names the workers waiting on you, questions first, and each phone once however many sockets it holds', () => {
  const floors = [
    {
      id: 'f-web',
      name: 'web-app',
      workers: [
        { id: 'a', name: 'Ada', kind: 'agent', status: 'working', acked: false, createdAt: 1 },
        { id: 'b', name: 'Bea', kind: 'agent', status: 'done', acked: false, waitingSince: 10, createdAt: 2, task: { name: '  Ship it ' } },
        { id: 'c', name: 'Cy', kind: 'agent', status: 'done', acked: true, waitingSince: 5, createdAt: 3 },
        { id: 'd', name: 'Di', kind: 'agent', status: 'needs_input', acked: false, waitingSince: 30, createdAt: 4 },
        { id: 'e', name: 'sh', kind: 'shell', status: 'done', acked: false, createdAt: 5 },
      ],
    },
    { id: 'f-api', name: 'api', workers: [{ id: 'f', name: 'Fay', kind: 'cloud', status: 'needs_input', acked: false, createdAt: 20 }] },
  ] as const;
  const connections = [{ device: 'p1', phone: true }, { device: 'p1', phone: true }, { device: 'p2', phone: true }, { device: 'b1', phone: false }, { phone: false }];
  assert.deepEqual(officeStatus(floors, connections), {
    workers: 6,
    working: 1,
    needsInput: 2,
    done: 1,
    phones: 2,
    browsers: 2,
    floors: 2,
    waiting: [
      { id: 'f', name: 'Fay', status: 'needs_input', floor: 'f-api', floorName: 'api', since: 20 },
      { id: 'd', name: 'Di', status: 'needs_input', floor: 'f-web', floorName: 'web-app', since: 30 },
      { id: 'b', name: 'Bea', status: 'done', floor: 'f-web', floorName: 'web-app', task: 'Ship it', since: 10 },
    ],
  });
  assert.deepEqual(officeStatus([], []), { workers: 0, working: 0, needsInput: 0, done: 0, phones: 0, browsers: 0, floors: 0, waiting: [] });
  const crowd = Array.from({ length: STATUS_WAITING_MAX + 5 }, (_, i) => ({ id: `w${i}`, name: `W${i}`, kind: 'agent' as const, status: 'needs_input' as const, acked: false, createdAt: i }));
  const many = officeStatus([{ id: 'f', name: 'f', workers: crowd }], []);
  assert.equal(many.needsInput, STATUS_WAITING_MAX + 5);
  assert.equal(many.waiting.length, STATUS_WAITING_MAX);
});

test('a status the office sends is read, an older office’s counts still are, and anything else is dropped', () => {
  assert.deepEqual(parseStatus({ ...status, extra: 'x' }), status);
  assert.deepEqual(parseStatus({ workers: 2, working: 1, needsInput: 1, phones: 0, browsers: 1 }), { workers: 2, working: 1, needsInput: 1, done: 0, phones: 0, browsers: 1, floors: 1, waiting: [] });
  for (const bad of [undefined, null, 'ok', {}, { ...status, phones: -1 }, { ...status, working: 1.5 }, { ...status, browsers: '2' }]) assert.equal(parseStatus(bad), undefined);
  const odd = parseStatus({
    ...status,
    waiting: [{ ...ada, name: `  Ada\n${'x'.repeat(100)}`, task: '' }, { ...bob, status: 'working' }, { ...bob, since: -1 }, { ...bob, id: '' }, 'w', null, { ...bob, name: 7 }],
  });
  assert.equal(odd?.waiting.length, 2);
  assert.equal(odd?.waiting[0]?.name.length, 60);
  assert.ok(odd?.waiting[0]?.name.startsWith('Ada x') && odd.waiting[0].name.endsWith('…'));
  assert.equal(odd?.waiting[0]?.task, undefined);
  assert.equal(odd?.waiting[1]?.name, 'A worker');
});

test('the menu says what the office is doing, leaving out the app’s own window', () => {
  assert.deepEqual(statusLines(running), ['4 workers · 2 working · 1 needs input · 1 done', '1 phone · 2 browsers connected']);
  assert.deepEqual(statusLines({ ...running, ownWindows: 2 }), ['4 workers · 2 working · 1 needs input · 1 done', '1 phone connected']);
  assert.deepEqual(statusLines({ ...running, ownWindows: 1 }), ['4 workers · 2 working · 1 needs input · 1 done', '1 phone · 1 browser connected']);
  assert.deepEqual(statusLines({ ...running, status: { ...status, workers: 3, working: 0, needsInput: 2, done: 0, phones: 0, browsers: 1 }, ownWindows: 1 }), ['3 workers · 2 need input', 'No phones or browsers connected']);
  assert.deepEqual(statusLines({ ...running, status: { ...status, workers: 1, working: 0, needsInput: 0, done: 0, phones: 2, browsers: 0 } }), ['1 worker, none busy', '2 phones connected']);
  assert.deepEqual(statusLines({ ...running, status: { ...status, workers: 0, working: 0, needsInput: 0, done: 0, phones: 0, browsers: 0 } }), ['No workers', 'No phones or browsers connected']);
  assert.deepEqual(statusLines({ state: 'running', ...base, external: true }), ['The office is running', 'Started outside the app']);
  assert.deepEqual(statusLines({ state: 'starting', ...base }), ['The office is starting…']);
  assert.deepEqual(statusLines({ state: 'stopped', ...base }), ['The office is stopped']);
  assert.equal(trayTooltip(running), 'Droid Office\n4 workers · 2 working · 1 needs input · 1 done\n1 phone · 2 browsers connected');
});

test('beside the icon, the number of workers waiting on you, only while the office runs', () => {
  assert.equal(trayTitle(running), '2');
  assert.equal(trayTitle({ ...running, status: { ...status, needsInput: 0, done: 0, waiting: [] } }), '');
  assert.equal(trayTitle({ ...running, status: undefined }), '');
  assert.equal(trayTitle({ ...running, state: 'stopped' }), '');
});

test('the menu does not list waiting workers or offer the office log', () => {
  for (const view of [running, { ...running, status: { ...status, needsInput: 20, waiting: [] } }, { ...running, state: 'stopped' as const }]) {
    const menu = labels(view);
    assert.ok(!menu.includes('Waiting on You'));
    assert.ok(!menu.includes('Ada needs input'));
    assert.ok(!menu.includes('Bob is done'));
    assert.ok(!menu.some((label) => /workers? waiting…/.test(label)));
    assert.ok(!menu.includes('Show Office Log'));
  }
});

test('the menu offers only what the office can do in its state', () => {
  const enabled = (v: TrayView) => Object.fromEntries(trayMenu(v).flatMap((i) => ('action' in i && i.action ? [[i.action, i.enabled]] : [])));
  const all = { open: true, switch: true, restart: true, notify: true, updates: true, quit: true, quitStoppingWorkers: true };
  assert.deepEqual(enabled({ ...running, status: { ...status, needsInput: 0, done: 0, waiting: [] } }), all);
  const actions = labels(running);
  assert.deepEqual(actions.slice(actions.indexOf('Open 3D Office')), [
    'Open 3D Office',
    'Switch to Office Companion',
    'Restart Office',
    'Notify When Workers Wait on You',
    'Check for Updates…',
    'Quit Droid Office',
    'Quit and Stop Workers…',
  ]);
  assert.deepEqual(trayMenu(running).slice(0, 2), [
    { label: '4 workers · 2 working · 1 needs input · 1 done', enabled: false },
    { label: '1 phone · 2 browsers connected', enabled: false },
  ]);
  const companion: TrayView = { ...running, mode: 'companion' };
  const opens = labels(companion).indexOf('Open Office Companion');
  assert.deepEqual(labels(companion).slice(opens, opens + 2), ['Open Office Companion', 'Switch to 3D Office']);
  assert.equal(item(companion, 'Switch to 3D Office')?.action, 'switch');
  assert.equal(item(running, 'Check for Updates…')?.sublabel, 'Version 0.1.420');
  assert.equal(item(running, 'Notify When Workers Wait on You')?.checked, true);
  assert.equal(item({ ...running, notify: false }, 'Notify When Workers Wait on You')?.checked, false);
  assert.deepEqual(enabled({ ...running, status: undefined, external: true }), { ...all, restart: false, quitStoppingWorkers: false });
  const stopped: TrayView = { state: 'stopped', ...base };
  assert.deepEqual(enabled(stopped), { ...all, quitStoppingWorkers: false });
  assert.ok(labels(stopped).includes('Start Office'));
  assert.deepEqual(enabled({ state: 'starting', ...base }), { ...all, open: false, restart: false, quitStoppingWorkers: false });
});

test('a notification goes out only for a wait that started since the last status', () => {
  const watch = new WaitingWatch();
  const at = (waiting: StatusWaiting[]) => ({ ...status, waiting });
  assert.deepEqual(watch.next(at([ada])), [], 'already waiting when the app first looked');
  assert.deepEqual(watch.next(undefined), [], 'no answer changes nothing');
  assert.deepEqual(watch.next(at([ada, bob])), [bob]);
  assert.deepEqual(watch.next(at([ada, bob])), []);
  const again = { ...ada, since: 500 };
  assert.deepEqual(watch.next(at([again])), [again], 'answered, worked, and asked again');
  watch.reset();
  assert.deepEqual(watch.next(at([again, bob])), [], 'a restarted office starts over');
  assert.deepEqual(waitingNotice(ada, 2), { title: 'Ada needs input', body: 'Fix Login Redirect\nweb-app floor' });
  assert.deepEqual(waitingNotice(bob, 1), { title: 'Bob is done', body: '' });
});

test("a wait that drops off the server's capped list is not new when it comes back", () => {
  const watch = new WaitingWatch();
  const cut = { ...status, needsInput: 2, done: 0, waiting: [ada] };
  assert.ok(listCut(cut));
  assert.ok(!listCut(status));
  watch.next({ ...status, waiting: [ada, bob] });
  assert.deepEqual(watch.next({ ...status, needsInput: 1, done: 1, waiting: [ada] }), [], 'bob is cut off, not gone');
  assert.deepEqual(watch.next({ ...status, waiting: [ada, bob] }), [], 'and back with the same wait');
  assert.deepEqual(watch.next({ ...status, needsInput: 1, done: 0, waiting: [ada] }), []);
  assert.deepEqual(watch.next({ ...status, waiting: [ada, bob] }), [bob], 'it really stopped waiting in between');
});

test('a worker link survives the trip to the page and takes you to its floor first', () => {
  const hash = workerHash({ worker: 'w ada&1', floor: 'f/web' });
  assert.equal(hash, '#worker=w+ada%261&floor=f%2Fweb');
  assert.deepEqual(parseWorkerLink(hash), { worker: 'w ada&1', floor: 'f/web' });
  assert.deepEqual(parseWorkerLink('#worker=abc'), { worker: 'abc' });
  const thread = workerHash({ worker: 'lead-1', floor: 'home', view: 'thread' });
  assert.equal(thread, '#worker=lead-1&floor=home&view=thread');
  assert.deepEqual(parseWorkerLink(thread), { worker: 'lead-1', floor: 'home', view: 'thread' });
  assert.deepEqual(parseWorkerLink('#worker=abc&floor=home&view=thread'), { worker: 'abc', floor: 'home', view: 'thread' });
  assert.deepEqual(parseWorkerLink('#worker=abc&view=unexpected'), { worker: 'abc' });
  for (const bad of ['', '#', '#floor=f', '#worker=', `#worker=${'x'.repeat(201)}`]) assert.equal(parseWorkerLink(bad), undefined, bad);
  const here = { floor: 'f-web', hasWorker: (id: string) => id === 'w-ada', hasFloor: (id: string) => id === 'f-web' || id === 'f-api' };
  assert.equal(linkStep({ worker: 'w-ada', floor: 'f-web' }, here), 'open');
  assert.equal(linkStep({ worker: 'w-bob', floor: 'f-api' }, here), 'go');
  assert.equal(linkStep({ worker: 'w-bob', floor: 'f-web' }, here), 'gone', 'sent home from this floor');
  assert.equal(linkStep({ worker: 'w-bob', floor: 'f-gone' }, here), 'gone', 'its floor left the building');
  assert.equal(linkStep({ worker: 'w-bob' }, here), 'gone');
});

test('one switch names the mode it goes to', () => {
  assert.equal(switchLabel('office'), 'Switch to Office Companion');
  assert.equal(switchLabel('companion'), 'Switch to 3D Office');
});
