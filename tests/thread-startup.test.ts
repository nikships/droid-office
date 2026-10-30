import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { threadSnapshotError, threadStarting } from '../src/client/thread-startup.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const worker: WorkerInfo = {
  id: 'worker',
  kind: 'agent',
  deskId: 'desk-1',
  name: 'Nibble',
  color: '#ee6018',
  status: 'starting',
  acked: false,
  createdBy: 'owner',
  createdAt: 0,
  cols: 80,
  rows: 24,
  open: true,
};
const missing = 'The local conversation file is not available yet.';

test('worktree setup and CLI boot remain loading until the worker starts', () => {
  assert.equal(threadStarting(worker), true);
  assert.equal(threadStarting({ ...worker, sessionId: 'session' }), true);
  for (const status of ['idle', 'working', 'needs_input', 'done', 'exited', 'offline'] as const) assert.equal(threadStarting({ ...worker, status }), false);
  assert.equal(threadStarting({ ...worker, lost: { branch: 'here' } }), false);
  assert.equal(threadStarting({ ...worker, kind: 'shell' }), false);
  assert.equal(threadStarting({ ...worker, kind: 'cloud' }), false);
});

test('only the expected missing-file response during startup is retried without an error', () => {
  assert.equal(threadSnapshotError(worker, missing), '');
  assert.equal(threadSnapshotError(worker), '');
  for (const status of ['idle', 'working', 'exited', 'offline'] as const) assert.equal(threadSnapshotError({ ...worker, status }, missing), missing);
  assert.equal(threadSnapshotError({ ...worker, lost: { branch: 'here' } }, missing), missing);
  for (const error of ['Invalid conversation page.', 'The local conversation could not be read. Try again shortly.', 'The office did not return this conversation.']) assert.equal(threadSnapshotError(worker, error), error);
  assert.equal(threadSnapshotError({ ...worker, status: 'idle' }, missing, true), '');
  assert.equal(threadSnapshotError({ ...worker, status: 'working' }, missing, true), '');
  assert.equal(threadSnapshotError({ ...worker, status: 'exited' }, missing, true), missing);
  assert.equal(threadSnapshotError({ ...worker, lost: { branch: 'here' } }, missing, true), missing);
});

const status = browserStatus();
test('thread startup animates without premature reads, retries missing files and preserves real errors', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({ entryPoints: [fileURLToPath(new URL('../src/client/ui/worker-thread.ts', import.meta.url))], bundle: true, format: 'iife', globalName: 'ThreadUI', write: false, target: 'es2022' }).outputFiles[0].text;
  await page.setContent('<!doctype html><div id="modal-root"></div>');
  await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: bundle });
  // tsx preserves names on callbacks serialized by Playwright.
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate((worker) => {
    const w = window as any;
    w.worker = worker;
    w.sent = [];
    let clock = Date.now();
    Date.now = () => clock;
    w.tick = () => (clock += 1100);
    const net = {
      send(msg: any) {
        w.sent.push(msg);
        return true;
      },
      onMessage(fn: any) {
        w.receive = fn;
        return () => {};
      },
    };
    w.thread = w.ThreadUI.mountWorkerThread(net, { worker, question: document.createElement('div'), queueKey: 'startup-test', draft: '', onDraft() {}, send: async () => undefined, raw() {} });
    document.body.append(w.thread.element);
    w.thread.update(worker, true);
    w.thread.activate(true);
    w.reply = (error?: string) => {
      const request = w.sent.filter((msg: any) => msg.t === 'thread.read').at(-1).request;
      w.receive({ t: 'thread.snapshot', workerId: worker.id, request, sessionId: 'session', entries: [], hasMore: false, error });
    };
  }, worker);
  assert.match(await page.locator('.wt-empty').innerText(), /Starting worker/);
  assert.equal(await page.evaluate(() => (window as any).sent.some((msg: any) => msg.t === 'thread.read')), false);
  assert.equal(await page.locator('.wt-empty').getAttribute('aria-busy'), 'true');
  const animation = await page.locator('.wt-loading-spinner').evaluate((el) => getComputedStyle(el).animationName);
  assert.equal(animation, 'spin');
  await page.evaluate((missing) => {
    const w = window as any;
    // SessionStart publishes the session ID and idle status together.
    w.worker = { ...w.worker, sessionId: 'session', status: 'idle' };
    w.thread.update(w.worker, true);
    w.reply(missing);
  }, missing);
  assert.equal(await page.locator('.wt-empty.error').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).isVisible(), false);
  await page.evaluate(() => {
    const w = window as any;
    w.tick();
    w.thread.update(w.worker, true);
    w.reply();
  });
  assert.match(await page.locator('.wt-empty').innerText(), /Start a conversation/);
  assert.equal(await page.locator('.wt-loading-spinner').count(), 0);
  await page.evaluate(() => {
    const w = window as any;
    w.tick();
    w.thread.update(w.worker, true);
    w.reply('The local conversation could not be read. Try again shortly.');
  });
  assert.equal(await page.locator('.wt-empty.error').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).isVisible(), true);
  // A missing file after a successful read is a real error, even inside the grace period.
  await page.evaluate((missing) => {
    const w = window as any;
    w.tick();
    w.thread.update(w.worker, true);
    w.reply(missing);
  }, missing);
  assert.equal(await page.locator('.wt-empty.error').count(), 1);
  // A new boot gets its own grace period, which cannot hide a missing file indefinitely.
  await page.evaluate((missing) => {
    const w = window as any;
    w.worker = { ...w.worker, status: 'starting', sessionId: undefined };
    w.thread.update(w.worker, true);
    w.worker = { ...w.worker, status: 'idle', sessionId: 'next-session' };
    w.tick();
    w.thread.update(w.worker, true);
    w.reply(missing);
  }, missing);
  assert.equal(await page.locator('.wt-empty.error').count(), 0);
  await page.evaluate((missing) => {
    const w = window as any;
    for (let i = 0; i < 8; i++) w.tick();
    w.thread.update(w.worker, true);
    w.reply(missing);
  }, missing);
  assert.equal(await page.locator('.wt-empty.error').count(), 1);
  await page.evaluate(() => (window as any).thread.dispose());
  assert.deepEqual(errors, []);
});
