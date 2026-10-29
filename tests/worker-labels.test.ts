import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { WorkerLabels, type LabelWorker } from '../src/server/worker-labels.js';
import { labelEnvironment, LabelModelError, parseLabel, WorkerLabelModel, type LabelInput } from '../src/server/worker-label-model.js';
import { labelSettings, WorkerLabelPreferences } from '../src/server/worker-label-settings.js';
import { WORKER_LABEL_DEFAULTS, type WorkerLabelSettings } from '../src/shared/worker-labels.js';
import type { WorkerTask } from '../src/shared/protocol.js';

const task: WorkerTask = { name: 'Worker Conversation Labels', summary: 'Checking final updates', generated: true };

function rig(t: TestContext, manual = false, reading?: (source: { sessionId: string }) => Promise<void>) {
  let now = 1_000_000;
  let settings = { ...WORKER_LABEL_DEFAULTS };
  let workers: LabelWorker[] = [];
  const text = new Map<string, string>();
  const calls: { input: LabelInput; signal: AbortSignal; resolve: (task: WorkerTask) => void; reject: (error: Error) => void }[] = [];
  const applied: WorkerTask[] = [];
  let reads = 0;
  const idle: (() => void)[] = [];
  const service = new WorkerLabels({
    settings: () => settings,
    workers: () => workers,
    read: async (source) => {
      reads++;
      await reading?.(source);
      await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4)));
      return text.get(source.sessionId);
    },
    generate: (input, _settings, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ input, signal, resolve, reject });
        if (!manual) resolve({ ...task });
      }),
    now: () => now,
    changed: (state) => {
      if (!state.running) for (const done of idle.splice(0)) done();
    },
  });
  t.after(() => service.stop());
  return {
    service,
    calls,
    text,
    applied,
    reads: () => reads,
    advance: (ms: number) => {
      now += ms;
    },
    settings: (next: Partial<WorkerLabelSettings>) => {
      settings = { ...settings, ...next };
      service.settingsChanged();
    },
    workers: (next: LabelWorker[]) => {
      workers = next;
    },
    worker: (id = 'floor:worker', sessionId = 'session') => {
      const w: LabelWorker = {
        id,
        sessionId,
        cwd: '/project',
        epoch: 0,
        status: 'working',
        apply: (value) => {
          applied.push(value);
          w.task = value;
        },
      };
      workers.push(w);
      text.set(sessionId, 'user: Fix final updates\n\nassistant: Checking final updates');
      return w;
    },
    idle: () => (service.state().running ? new Promise<void>((resolve) => idle.push(resolve)) : Promise.resolve()),
  };
}

test('one global fair queue limits all floors to two calls and coalesces workers', async (t) => {
  const r = rig(t, true);
  r.worker('first:a', 'a');
  r.worker('second:b', 'b');
  r.worker('third:c', 'c');
  await r.service.tick();
  assert.equal(r.calls.length, 2);
  assert.equal(r.service.state().queued, 1);
  await r.service.tick();
  assert.equal(r.calls.length, 2, 'no duplicate calls while either worker is running');
  const done = r.idle();
  r.calls[0].resolve(task);
  r.calls[1].resolve(task);
  // A queued call starts as soon as a slot is free. Observe that event, not a wall-clock sleep.
  await new Promise<void>((resolve) => {
    const check = () => (r.calls.length === 3 ? resolve() : setImmediate(check));
    check();
  });
  r.calls[2].resolve(task);
  await done;
  assert.equal(r.applied.length, 3);
  assert.equal(r.service.state().queued, 0);
});

test('refreshes only changed visible text, respects 60 seconds, and sends only the generated previous subject', async (t) => {
  const r = rig(t);
  const worker = r.worker();
  worker.task = { name: 'Lead assigned title', summary: 'PRIVATE_OLD_SUMMARY' };
  await r.service.tick();
  await r.idle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].input.previousSubject, undefined, 'an arbitrary preview is not previous model output');
  r.advance(120_000);
  await r.service.tick();
  assert.equal(r.calls.length, 1, 'unchanged conversations do not incur a call');
  r.text.set(worker.sessionId, 'assistant: Checking the Settings UI');
  await r.service.tick();
  await r.idle();
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].input.previousSubject, task.name);
  assert.doesNotMatch(JSON.stringify(r.calls[1].input), /PRIVATE_OLD_SUMMARY|activity|tools/);
  r.text.set(worker.sessionId, 'assistant: Checking cancellation');
  r.advance(59_999);
  await r.service.tick();
  assert.equal(r.calls.length, 2);
  r.advance(1);
  await r.service.tick();
  await r.idle();
  assert.equal(r.calls.length, 3);
});

test('a queue slot opening during an async scan cannot requeue the now-running worker', async (t) => {
  let pause = false;
  let started!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const r = rig(t, true, async (source) => {
    if (source.sessionId === 'c' && pause) {
      started();
      await blocked;
    }
  });
  r.worker('first:a', 'a');
  r.worker('second:b', 'b');
  const third = r.worker('third:c', 'c');
  await r.service.tick();
  third.status = 'done';
  pause = true;
  const scan = r.service.tick();
  await reading;
  r.calls[0].resolve(task);
  await new Promise<void>((resolve) => {
    const check = () => (r.calls.length === 3 ? resolve() : setImmediate(check));
    check();
  });
  release();
  await scan;
  const queued = r.service.state().queued;
  if (queued) r.settings({ on: false });
  const done = r.idle();
  r.calls[1].resolve(task);
  r.calls[2].resolve(task);
  await done;
  assert.equal(queued, 0, 'the running worker must not leave a duplicate paid call queued');
  assert.equal(r.calls.length, 3);
});

test('a final update bypasses the interval and catches text flushed after the done hook', async (t) => {
  const r = rig(t);
  const worker = r.worker();
  await r.service.tick();
  await r.idle();
  worker.status = 'done';
  r.advance(2000);
  await r.service.tick();
  assert.equal(r.calls.length, 1, 'the status alone is not model input');
  r.advance(2000);
  r.text.set(worker.sessionId, 'assistant: Finished the worker labels and tests');
  await r.service.tick();
  await r.idle();
  assert.equal(r.calls.length, 2);
  r.advance(60_000);
  await r.service.tick();
  assert.equal(r.calls.length, 2, 'a completed unchanged worker stays quiet');
});

for (const change of ['clear', 'session', 'cwd', 'remove', 'settings', 'stop'] as const) {
  test(`drops a late result after ${change}`, async (t) => {
    const r = rig(t, true);
    const worker = r.worker();
    await r.service.tick();
    const done = r.idle();
    if (change === 'clear') worker.epoch++;
    if (change === 'session') worker.sessionId = 'new-session';
    if (change === 'cwd') worker.cwd = '/replacement';
    if (change === 'remove') r.workers([]);
    if (change === 'settings') r.settings({ on: false });
    const stopped = change === 'stop' ? r.service.stop() : undefined;
    r.calls[0].resolve(task);
    if (stopped) await stopped;
    else await done;
    assert.equal(r.applied.length, 0);
  });
}

test('a chatty worker still gets its snapshot label, with newer text eligible at the next interval', async (t) => {
  const r = rig(t, true);
  const worker = r.worker();
  await r.service.tick();
  r.text.set(worker.sessionId, 'assistant: A newer activity during inference');
  const done = r.idle();
  r.calls[0].resolve(task);
  await done;
  assert.equal(r.applied.length, 1);
  assert.equal(r.reads(), 1, 'publishing a valid snapshot does not reread the conversation');
  r.advance(60_000);
  await r.service.tick();
  assert.equal(r.calls.length, 2);
  assert.match(r.calls[1].input.text, /newer activity/);
  const updated = r.idle();
  r.calls[1].resolve(task);
  await updated;
});

test('failures keep the successful label, back off, and recover without a model fallback', async (t) => {
  const r = rig(t, true);
  const worker = r.worker();
  worker.task = { ...task };
  await r.service.tick();
  let done = r.idle();
  r.calls[0].reject(new LabelModelError('Connect a Factory API key.'));
  await done;
  assert.equal(r.service.state().error, 'Connect a Factory API key.');
  assert.deepEqual(worker.task, task);
  r.advance(59_999);
  await r.service.tick();
  assert.equal(r.calls.length, 1);
  r.advance(1);
  await r.service.tick();
  done = r.idle();
  r.calls[1].resolve(task);
  await done;
  assert.equal(r.service.state().error, undefined);
  assert.equal(r.applied.length, 1);
});

test('cancels removed jobs, aborts settings changes, and does nothing while disabled', async (t) => {
  const r = rig(t, true);
  r.worker();
  await r.service.tick();
  r.workers([]);
  await r.service.tick();
  assert.equal(r.calls[0].signal.aborted, true);
  r.settings({ on: false });
  r.calls[0].resolve(task);
  await r.idle();
  r.worker('new', 'new');
  await r.service.tick();
  assert.equal(r.calls.length, 1);
});

test('validates generated JSON and never converts object values into labels', () => {
  assert.deepEqual(parseLabel('```json\n{"name":"Worker Labels","summary":"Checking tests"}\n```'), { name: 'Worker Labels', summary: 'Checking tests', generated: true });
  assert.equal(parseLabel(JSON.stringify({ name: 'x'.repeat(100), summary: 'y'.repeat(300) })).name.length, 60);
  for (const value of ['not JSON', '{}', 'null', '{"name":{},"summary":"x"}', '{"name":"x","summary":[]}']) assert.throws(() => parseLabel(value), LabelModelError);
});

test('isolated SDK environment overrides inherited Office markers without breaking Factory endpoints', () => {
  const env = labelEnvironment(
    { PATH: '/bin', NEBULA_ID: 'session', DROID_OFFICE_WORKER_ID: 'worker', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', FACTORY_API_BASE_URL: 'https://api.factory.ai', FACTORY_API_KEY: 'old' },
    '/scratch',
    'selected-key',
  );
  assert.equal(env.HOME, '/scratch');
  assert.equal(env.XDG_CONFIG_HOME, '/scratch/config');
  assert.equal(env.NEBULA_ID, '');
  assert.equal(env.DROID_OFFICE_WORKER_ID, '');
  assert.equal(env.ELECTRON_RUN_AS_NODE, '');
  assert.equal(env.NODE_OPTIONS, '');
  assert.equal(env.FACTORY_API_BASE_URL, 'https://api.factory.ai');
  assert.equal(env.FACTORY_API_KEY, 'selected-key');
});

test('settings use GLM low and 60 seconds, persist atomically, and preserve prior settings on failures', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-label-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefs = new WorkerLabelPreferences(root);
  assert.deepEqual(prefs.get(), WORKER_LABEL_DEFAULTS);
  const next = { ...WORKER_LABEL_DEFAULTS, intervalSeconds: 120 };
  assert.equal(prefs.set(next), undefined);
  assert.deepEqual(new WorkerLabelPreferences(root).get(), next);
  assert.equal((await stat(path.join(root, 'worker-labels.json'))).mode & 0o777, 0o600);
  for (const value of [null, {}, { ...next, intervalSeconds: 1 }, { ...next, intervalSeconds: 3601 }, { ...next, intervalSeconds: 60.5 }, { ...next, effort: 'bogus' }, { ...next, model: 'bad id' }, { ...next, on: 1 }])
    assert.equal(labelSettings(value), undefined);
  assert.ok(prefs.set({ ...next, intervalSeconds: 0 }));
  assert.deepEqual(prefs.get(), next);
  const file = path.join(root, 'worker-labels.json');
  await rm(file);
  await mkdir(file);
  assert.ok(prefs.set(WORKER_LABEL_DEFAULTS));
  assert.deepEqual(prefs.get(), next);
  await rm(file, { recursive: true });
  await writeFile(file, 'invalid JSON');
  assert.deepEqual(new WorkerLabelPreferences(root).get(), WORKER_LABEL_DEFAULTS);
});

test('SDK refuses missing Droid or Office key instead of falling back to the personal login', async () => {
  const controller = new AbortController();
  const absent = new WorkerLabelModel({ droid: () => null, key: () => undefined, system: () => '' });
  await assert.rejects(absent.generate({ text: 'assistant: Checking tests' }, WORKER_LABEL_DEFAULTS, controller.signal), /Install Droid/);
  const noKey = new WorkerLabelModel({ droid: () => '/bin/droid', key: () => undefined, system: () => '' });
  await assert.rejects(noKey.generate({ text: 'assistant: Checking tests' }, WORKER_LABEL_DEFAULTS, controller.signal), /Connect a Factory API key/);
});

test('a failed isolated process removes its temporary HOME and never copies profile configuration', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-label-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const observed = path.join(root, 'home');
  const droid = path.join(root, 'droid');
  await writeFile(droid, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(observed)}, process.env.HOME);\nprocess.exit(1);\n`, { mode: 0o700 });
  const model = new WorkerLabelModel({ droid: () => droid, key: () => 'ci-key', system: () => 'Labels only' });
  await assert.rejects(model.generate({ text: 'assistant: Checking cleanup' }, WORKER_LABEL_DEFAULTS, new AbortController().signal), LabelModelError);
  const home = await readFile(observed, 'utf8');
  assert.match(path.basename(home), /^office-worker-label-/);
  await assert.rejects(stat(home), { code: 'ENOENT' });
});

test('cancelling a running isolated process kills it and removes its temporary credential profile', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-label-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const observed = path.join(root, 'home');
  const droid = path.join(root, 'droid');
  await writeFile(droid, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(observed)}, process.env.HOME);\nprocess.stdin.resume();\n`, { mode: 0o700 });
  const model = new WorkerLabelModel({ droid: () => droid, key: () => 'ci-key', system: () => 'Labels only' });
  const controller = new AbortController();
  const work = model.generate({ text: 'assistant: Checking cancellation' }, WORKER_LABEL_DEFAULTS, controller.signal);
  const rejected = assert.rejects(work, LabelModelError);
  let home: string | undefined;
  while (!home) {
    home = await readFile(observed, 'utf8').catch(() => undefined);
    if (!home) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  controller.abort();
  await rejected;
  await assert.rejects(stat(home), { code: 'ENOENT' });
});

test('persisted visible-text digests skip unchanged labels after a scheduler reset', async (t) => {
  const r = rig(t);
  const worker = r.worker();
  await r.service.tick();
  await r.idle();
  assert.match(worker.task?.textHash ?? '', /^[a-f0-9]{64}$/);
  r.settings({ intervalSeconds: 120 });
  await r.service.tick();
  await r.idle();
  assert.equal(r.calls.length, 1);
});
