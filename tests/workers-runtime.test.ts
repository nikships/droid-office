import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { CTRL_ENTER } from '../src/shared/csi-enter.js';
import { Worktrees } from '../src/server/worktrees.js';
import { WorkerDelivery } from '../src/server/worker-runtime/delivery.js';
import { WorkerHooks, STOP_GRACE_MS } from '../src/server/worker-runtime/hooks.js';
import { WorkerHookSpool, HOOK_VERSION } from '../src/server/worker-runtime/hook-transport.js';
import { WorkerLaunchSettings } from '../src/server/worker-runtime/launch-settings.js';
import { WorkerStateStore } from '../src/server/worker-runtime/persistence.js';
import { midTurn, newWorker, type Worker } from '../src/server/worker-runtime/state.js';

function info(): WorkerInfo {
  return { id: 'worker', kind: 'agent', name: 'Pixel', deskId: 'desk-1', color: '#ff8a5b', status: 'working', sessionId: 'session', acked: true, createdBy: 'test', createdAt: 1, cols: 136, rows: 39, open: false };
}

function deliveryRig(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const worker = newWorker(info(), 'test-hook-token');
  const writes: string[] = [];
  const calls: string[] = [];
  let current = worker;
  let closing = false;
  let resumeError: string | undefined;
  worker.pty = { id: 'pty', pid: 1, write: (data) => writes.push(data), resize() {}, kill() {}, onData() {}, onExit() {} };
  const delivery = new WorkerDelivery({
    get: (id) => (id === current.info.id ? current : undefined),
    closing: () => closing,
    persist: () => calls.push('persist'),
    update: () => calls.push('update'),
    notePrompt: (_worker, text) => calls.push(`prompt:${text}`),
    resume: () => resumeError,
    drops: { adopt: () => [] },
  });
  return {
    worker,
    writes,
    calls,
    delivery,
    replace() {
      current = newWorker(info());
    },
    close() {
      closing = true;
    },
    failResume(error: string) {
      resumeError = error;
    },
  };
}

test('queue clearing cancels a bracketed paste before its delayed Ctrl+Enter submits', async (t) => {
  const { worker, writes, delivery } = deliveryRig(t);
  assert.equal(delivery.prompt(worker.info.id, 'first\nsecond', undefined, true), undefined);
  assert.equal(worker.queued, 1);
  assert.deepEqual(writes, ['\x1b[200~first\nsecond\x1b[201~']);
  assert.equal(delivery.queueState(worker.info.id)?.items[0].text, 'first\nsecond');
  const cleared = await delivery.clearQueue(worker.info.id);
  assert.equal(cleared.cleared.length, 1);
  assert.equal(cleared.remaining.count, 0);
  t.mock.timers.tick(120);
  assert.deepEqual(writes, ['\x1b[200~first\nsecond\x1b[201~', '\x15']);
  assert.equal(worker.inFlight.size, 0);
  assert.equal(worker.sentQueue.length, 0);
});

test('queued submissions are tracked only after the submit key, and a launch prompt is consumed once', (t) => {
  const { worker, writes, calls, delivery } = deliveryRig(t);
  delivery.prompt(worker.info.id, 'next', undefined, true);
  assert.equal(worker.sentQueue.length, 0);
  t.mock.timers.tick(120);
  assert.deepEqual(writes, ['\x1b[200~next\x1b[201~', CTRL_ENTER]);
  assert.equal(worker.sentQueue[0].text, 'next');
  worker.launchPrompt = { text: 'restart message', at: Date.now() };
  delivery.sendLaunchPrompt(worker);
  delivery.sendLaunchPrompt(worker);
  assert.equal(worker.launchPrompt, undefined);
  assert.equal(calls.filter((call) => call === 'persist').length, 1);
  t.mock.timers.tick(120);
  assert.deepEqual(writes.slice(2), ['\x1b[200~restart message\x1b[201~', '\r']);
});

test('urgent promotion restores removed notices in their original order when resume fails', async (t) => {
  const { worker, delivery, failResume } = deliveryRig(t);
  worker.pty = undefined;
  worker.outbox.push('first notice', 'second notice');
  failResume('worktree is missing');
  const result = await delivery.promoteQueue(worker.info.id, { all: true, urgent: true });
  assert.match(result.error!, /worktree is missing/);
  assert.equal(result.stillPending, true);
  assert.deepEqual(worker.outbox, ['first notice', 'second notice']);
  assert.deepEqual(
    result.remaining.items.map((item) => item.text),
    worker.outbox,
  );
});

test('outbox delivery waits for typing and rejects callbacks from a replaced or closed manager', (t) => {
  const rig = deliveryRig(t);
  rig.worker.info.status = 'done';
  rig.worker.info.lastInputAt = Date.now();
  rig.worker.outbox.push('held while typing');
  rig.delivery.flushOutbox(rig.worker);
  assert.deepEqual(rig.writes, []);
  t.mock.timers.tick(4999);
  assert.deepEqual(rig.writes, []);
  rig.replace();
  t.mock.timers.tick(1);
  assert.deepEqual(rig.writes, []);
  assert.deepEqual(rig.worker.outbox, ['held while typing']);
  rig.close();
  rig.delivery.flushOutbox(rig.worker);
  assert.deepEqual(rig.writes, []);
});

function hookRig(t: TestContext) {
  const rig = deliveryRig(t);
  const { worker, calls } = rig;
  let current = worker;
  const hooks = new WorkerHooks({
    get: () => current,
    closing: () => false,
    persist: () => calls.push('persist'),
    update: () => calls.push('update'),
    setStatus: (w, status) => {
      w.info.status = status;
      calls.push(`status:${status}`);
    },
    setup: () => false,
    refreshModel: () => calls.push('model'),
    syncBranch: async () => {
      calls.push('branch');
    },
    tool: () => calls.push('tool'),
    notePrompt: (_w, text) => calls.push(`prompt:${text}`),
    beforeStop: () => {
      calls.push('beforeStop');
      return 'team news';
    },
    nextTurn: () => calls.push('nextTurn'),
    delivery: rig.delivery,
  });
  const send = (event: string, payload: Record<string, unknown> = {}, from: { version: number } | { at: number } = { version: HOOK_VERSION }) =>
    hooks.accept(worker, event, { hook_event_name: event, session_id: 'session', ...payload }, from);
  return {
    ...rig,
    hooks,
    send,
    replaceHookWorker() {
      current = newWorker(info());
    },
  };
}

test('SessionStart delivers its launch message before the hook update and save', (t) => {
  const { worker, calls, writes, send } = hookRig(t);
  worker.info.status = 'starting';
  worker.launchPrompt = { text: 'assigned task', at: Date.now() };
  assert.equal(send('SessionStart'), '');
  assert.deepEqual(calls, ['status:idle', 'persist', 'model', 'update', 'persist']);
  assert.deepEqual(writes, ['\x1b[200~assigned task\x1b[201~']);
  t.mock.timers.tick(120);
  assert.deepEqual(writes, ['\x1b[200~assigned task\x1b[201~', '\r']);
});

test('unknown sessions cannot consume notices and old or replayed hooks cannot carry replies', (t) => {
  const { worker, send } = hookRig(t);
  worker.outbox = ['pending notice'];
  assert.equal(send('PostToolUse', { session_id: 'stranger' }), undefined);
  assert.equal(send('PostToolUse', {}, { version: 0 }), '');
  assert.deepEqual(worker.outbox, ['pending notice']);
  assert.equal(send('PostToolUse', {}, { at: 9000 }), '');
  assert.deepEqual(worker.outbox, ['pending notice']);
  const reply = send('PostToolUse');
  assert.match(reply!, /pending notice/);
  assert.deepEqual(worker.outbox, []);
});

test('a queued Stop advances the next turn instead of blocking for team news', (t) => {
  const { worker, calls, send } = hookRig(t);
  worker.queued = 1;
  worker.sentQueue.push({ id: 1, text: 'next task', group: 'queued', at: Date.now() });
  worker.outbox = ['notice for the next tool'];
  assert.equal(send('Stop'), '');
  assert.equal(worker.queued, 0);
  assert.equal(worker.stopAt, undefined);
  assert.deepEqual(worker.outbox, ['notice for the next tool']);
  assert.deepEqual(calls, ['nextTurn', 'model', 'update', 'persist']);
});

test('a cancel does not block Stop for notices and stale Stop callbacks cannot settle a replacement', (t) => {
  const { worker, calls, send, hooks, replaceHookWorker } = hookRig(t);
  worker.cancelAt = Date.now();
  worker.outbox = ['notice'];
  assert.equal(send('Stop'), '');
  assert.equal(calls.includes('beforeStop'), false);
  const stoppedAt = worker.stopAt!;
  assert.equal(midTurn(worker), false);
  replaceHookWorker();
  hooks.settleStop(worker, stoppedAt, stoppedAt + STOP_GRACE_MS);
  t.mock.timers.tick(STOP_GRACE_MS);
  assert.equal(worker.info.status, 'working');
  assert.deepEqual(worker.outbox, ['notice']);
});

test('subagent starts and stops do not replace the parent session or consume its launch prompt', (t) => {
  const { worker, send, calls } = hookRig(t);
  worker.launchPrompt = { text: 'parent task', at: Date.now() };
  send('SessionStart', { session_id: 'child', calling_session_id: 'session' });
  send('Stop', { session_id: 'child' });
  assert.equal(worker.info.sessionId, 'session');
  assert.equal(worker.launchPrompt?.text, 'parent task');
  assert.equal(worker.stopAt, undefined);
  assert.equal(calls.includes('beforeStop'), false);
  assert.equal(worker.subSessions.has('child'), true);
});

test('spool replay claims only the existing file, skips stale identities, and retains concurrent writes', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'worker-spool-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { worker } = deliveryRig(t);
  worker.hookAt = 100;
  const accepted: string[] = [];
  const spool = new WorkerHookSpool(root, {
    get: (id) => (id === worker.info.id ? worker : undefined),
    workers: () => [worker],
    accept: (_w, event) => {
      accepted.push(event);
      writeFileSync(spool.file(worker.info.id), 'concurrent hook\n');
      return '';
    },
  });
  mkdirSync(path.dirname(spool.file(worker.info.id)));
  const row = (event: string, at = 100, token = worker.hookToken) => JSON.stringify({ event, at, token, payload: {} });
  writeFileSync(spool.file(worker.info.id), [row('stale', 99), row('wrong-token', 100, 'old-token'), '{broken', row('first'), row('second', 101)].join('\n'));
  spool.replayAll();
  assert.deepEqual(accepted, ['first', 'second']);
  assert.equal(readFileSync(spool.file(worker.info.id), 'utf8'), 'concurrent hook\n');
  assert.equal(existsSync(`${spool.file(worker.info.id)}.replay`), false);
  writeFileSync(path.join(root, 'hook-spool', 'departed.jsonl'), '');
  writeFileSync(`${spool.file(worker.info.id)}.replay`, '');
  spool.prune();
  assert.equal(existsSync(spool.file(worker.info.id)), true);
  assert.equal(existsSync(`${spool.file(worker.info.id)}.replay`), false);
  assert.equal(existsSync(path.join(root, 'hook-spool', 'departed.jsonl')), false);
});

test('launch settings read current policies each launch and remove an emptied system prompt', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'worker-settings-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let denyTask = true;
  let allowed: { matcher: string; reason: string } | undefined;
  let system: string | undefined = 'system brief';
  const settings = new WorkerLaunchSettings(root, {
    denyTask: () => denyTask,
    allowTools: () => allowed,
    systemPrompt: () => () => system,
    visitsOn: () => false,
    plain: true,
    trees: new Worktrees(root, true),
  });
  const worker = info();
  const initial = JSON.parse(readFileSync(settings.droidSettings(worker), 'utf8'));
  assert.equal(initial.hooks.PreToolUse[0].matcher, 'Task');
  denyTask = false;
  allowed = { matcher: 'Read', reason: 'read only' };
  worker.model = 'custom:test-model';
  worker.effort = 'high';
  const overlay = JSON.parse(readFileSync(settings.droidSettings(worker), 'utf8'));
  assert.deepEqual(overlay.sessionDefaultSettings, { model: 'custom:test-model', reasoningEffort: 'high' });
  assert.equal(overlay.hooks.PreToolUse[0].matcher, 'Read');
  assert.equal(
    overlay.hooks.PreToolUse.some((entry: { matcher?: string }) => entry.matcher === 'Task'),
    false,
  );
  assert.match(overlay.hooks.SessionStart[0].hooks[0].command, new RegExp(`v=${HOOK_VERSION}`));
  const prompt = settings.systemPromptFile(worker)!;
  assert.equal(readFileSync(prompt, 'utf8'), 'system brief\n');
  system = undefined;
  assert.equal(settings.systemPromptFile(worker), undefined);
  assert.equal(existsSync(prompt), false);
});

test('worker state recovery keeps terminal claims, pending forks, notices and retired seats', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'worker-state-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { worker } = deliveryRig(t);
  const context = { deskless: false, cols: 136, rows: 39, color: '#ff8a5b', buildingKnown: (id: string) => id === 'orchestrator', heldDesk: () => false };
  const state = new WorkerStateStore(root, context);
  worker.info.sessionId = undefined;
  worker.info.lead = 'orchestrator';
  worker.info.status = 'needs_input';
  worker.info.ask = { kind: 'permission', tool: 'Execute', command: 'npm test' };
  worker.pendingFork = { sessionId: 'source-session', prompt: 'fork task' };
  worker.launchPrompt = { text: 'first message', at: Date.now() };
  worker.outbox = ['unread notice'];
  state.save([worker], { closing: false, stopping: false, onShutdown: false });
  const file = path.join(root, 'workers.json');
  const retired = { id: 'retired', deskId: 'removed-seat', name: 'Never relaunch', retained: 'unchanged' };
  writeFileSync(file, JSON.stringify([...JSON.parse(readFileSync(file, 'utf8')), retired]));
  const restored = new WorkerStateStore(root, context);
  const workers = new Map<string, Worker>();
  restored.restore(workers);
  assert.equal(workers.size, 1);
  const recovered = workers.get(worker.info.id)!;
  assert.equal(recovered.info.status, 'offline');
  assert.equal(recovered.info.lead, 'orchestrator');
  assert.deepEqual(recovered.pendingFork, worker.pendingFork);
  assert.equal(recovered.saved!.ptyId, 'pty');
  assert.deepEqual(recovered.saved!.ask, worker.info.ask);
  assert.deepEqual(recovered.saved!.outbox, worker.outbox);
  assert.deepEqual(recovered.saved!.launchPrompt, worker.launchPrompt);
  assert.equal(recovered.interrupted, true);
  restored.save(workers.values(), { closing: false, stopping: false, onShutdown: false });
  assert.deepEqual(
    JSON.parse(readFileSync(file, 'utf8')).find((row: { id: string }) => row.id === retired.id),
    retired,
  );
});

test('a closed worker state store cannot overwrite successor state except for its explicit shutdown save', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'worker-state-close-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = new WorkerStateStore(root, { deskless: false, cols: 136, rows: 39, color: '#ff8a5b', buildingKnown: () => false, heldDesk: () => false });
  const worker = newWorker(info());
  const file = path.join(root, 'workers.json');
  writeFileSync(file, 'successor state');
  state.save([worker], { closing: true, stopping: false, onShutdown: false });
  assert.equal(readFileSync(file, 'utf8'), 'successor state');
  state.save([worker], { closing: true, stopping: true, onShutdown: true });
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].midTurn, false);
});
