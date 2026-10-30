import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { threadSnapshotError, threadStarting } from '../src/client/thread-startup.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { presentThread } from '../src/shared/thread-presentation.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

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
const chromium = status.installed ? false : `Chromium is not installed in ${status.path}`;

/** A page with the Thread UI mounted on a stub connection: its replies, clock and reads under test control. */
async function mountThread(t: TestContext) {
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
    w.question = document.createElement('div');
    w.questionScrolls = 0;
    w.question.scrollIntoView = () => w.questionScrolls++;
    w.thread = w.ThreadUI.mountWorkerThread(net, { worker, question: w.question, queueKey: 'startup-test', draft: '', onDraft() {}, send: async () => undefined, raw() {}, team: () => w.team ?? [] });
    document.body.append(w.thread.element);
    w.thread.update(worker, true);
    w.thread.activate(true);
    w.reply = (error?: string) => {
      const request = w.sent.filter((msg: any) => msg.t === 'thread.read').at(-1).request;
      w.receive({ t: 'thread.snapshot', workerId: worker.id, request, sessionId: 'session', entries: [], hasMore: false, ...(error ? { error } : { presentation: { version: 1, rows: [] } }) });
    };
  }, worker);
  return { page, errors };
}
test('thread startup animates without premature reads, retries missing files and preserves real errors', { skip: chromium }, async (t) => {
  const { page, errors } = await mountThread(t);
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
test('a message the session rewrote in place repaints with its new text', { skip: chromium }, async (t) => {
  const { page, errors } = await mountThread(t);
  await page.evaluate(() => {
    const w = window as any;
    w.message = (text: string) => {
      const entries = [{ id: 'm1', seq: 1, role: 'assistant', kind: 'text', text }];
      w.worker = { ...w.worker, sessionId: 'session', status: 'idle' };
      w.tick();
      w.thread.update(w.worker, true);
      const request = w.sent.filter((msg: any) => msg.t === 'thread.read').at(-1).request;
      w.receive({
        t: 'thread.snapshot',
        workerId: w.worker.id,
        request,
        sessionId: 'session',
        entries,
        hasMore: false,
        presentation: { version: 1, rows: [{ kind: 'message', id: 'm1', from: 1, to: 1, role: 'assistant', startsTurn: true }] },
      });
    };
    w.message('First draft');
  });
  assert.match(await page.locator('.wt-entry').innerText(), /First draft/);
  // The session rewrote the same entry: same id and seq, new text, so the row must repaint.
  await page.evaluate(() => (window as any).message('Second draft'));
  assert.match(await page.locator('.wt-entry').innerText(), /Second draft/);
  await page.evaluate(() => (window as any).thread.dispose());
  assert.deepEqual(errors, []);
});

test('subagent input stays visible in its thread and its lead’s Team activity', { skip: chromium }, async (t) => {
  const { page, errors } = await mountThread(t);
  await page.evaluate(async () => {
    const w = window as any;
    w.worker = { ...w.worker, status: 'needs_input', sessionId: 'session', lead: 'pixel' };
    w.thread.update(w.worker, true);
    w.reply();
    await new Promise(requestAnimationFrame);
  });
  assert.doesNotMatch(await page.locator('.wt-notice').innerText(), /Waiting for its lead/);
  assert.ok(await page.evaluate(() => (window as any).questionScrolls > 0), 'subagent terminal questions still require the owner');
  await page.evaluate(async () => {
    const w = window as any;
    w.team = [{ ...w.worker, id: 'dot', name: 'Dot', lead: w.worker.id }];
    w.worker = { ...w.worker, status: 'working', lead: undefined };
    w.thread.update(w.worker, true);
    await new Promise(requestAnimationFrame);
  });
  await page.locator('.wt-team > summary').click();
  assert.equal(await page.locator('.wt-team-member .pill').textContent(), 'needs input');
  assert.equal(await page.locator('.wt-team-member .pill.needs_input').count(), 1);
  await page.evaluate(async () => {
    const w = window as any;
    w.worker = { ...w.worker, status: 'needs_input' };
    w.thread.update(w.worker, true);
    await new Promise(requestAnimationFrame);
  });
  assert.ok(await page.evaluate(() => (window as any).questionScrolls > 0), 'main-worker questions still receive attention');
  await page.evaluate(() => (window as any).thread.dispose());
  assert.deepEqual(errors, []);
});

test('thread work signal follows worker lifecycle without restarting or announcing on every poll', { skip: chromium }, async (t) => {
  const { page, errors } = await mountThread(t);
  const signal = page.locator('.wt-progress');
  const label = page.locator('.wt-progress-label');
  const tile = page.locator('.wt-progress-glyph > span').first();
  const animation = () => tile.evaluate((el) => getComputedStyle(el).animationName);
  assert.equal(await signal.isVisible(), true);
  assert.equal(await label.textContent(), 'Starting worker…');
  assert.equal(await animation(), 'wt-work-pulse');
  assert.equal(await page.locator('.wt-progress-glyph').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.locator('.wt-progress-status').getAttribute('aria-live'), 'polite');
  await page.evaluate(() => {
    const w = window as any;
    w.worker = { ...w.worker, sessionId: 'session', status: 'working' };
    w.thread.update(w.worker, true);
    w.reply();
    w.signal = document.querySelector('.wt-progress');
    w.animation = document.querySelector('.wt-progress-glyph > span')!.getAnimations()[0];
    w.mutations = [];
    w.observer = new MutationObserver((changes) => w.mutations.push(...changes));
    w.observer.observe(document.querySelector('.wt-progress-status'), { childList: true, characterData: true, subtree: true });
    w.tick();
    w.thread.update(w.worker, true);
    w.reply();
  });
  assert.equal(await label.textContent(), 'Working…', 'alive even before any message has been recorded');
  assert.equal(
    await page.evaluate(() => {
      const w = window as any;
      return w.signal === document.querySelector('.wt-progress') && w.animation === document.querySelector('.wt-progress-glyph > span')!.getAnimations()[0] && w.mutations.length === 0;
    }),
    true,
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await animation(), 'none');
  assert.equal(await signal.isVisible(), true);
  assert.equal(await label.textContent(), 'Working…');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await animation(), 'wt-work-pulse');
  await page.evaluate(() => {
    const w = window as any;
    w.worker.status = 'needs_input';
    w.thread.update(w.worker, true);
  });
  assert.equal(await label.textContent(), 'Waiting for you');
  assert.equal(await animation(), 'none');
  for (const status of ['idle', 'done', 'exited', 'offline']) {
    await page.evaluate((status) => {
      const w = window as any;
      w.worker.status = status;
      w.thread.update(w.worker, true);
    }, status);
    assert.equal(await signal.isVisible(), false, status);
    assert.equal(await animation(), 'none');
  }
  await page.evaluate(() => {
    const w = window as any;
    w.worker.status = 'working';
    w.thread.update(w.worker, false);
  });
  assert.equal(await signal.isVisible(), false, 'disconnect does not pretend work is live');
  await page.evaluate(() => {
    const w = window as any;
    w.tick();
    w.thread.update(w.worker, true);
    w.reply('The local conversation could not be read. Try again shortly.');
  });
  assert.equal(await signal.isVisible(), false, 'a read failure is not hidden behind activity');
  await page.evaluate(() => (window as any).tick());
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.evaluate(() => (window as any).reply());
  assert.equal(await signal.isVisible(), true);
  await page.evaluate(() => {
    const w = window as any;
    w.thread.update({ ...w.worker, lost: { branch: 'missing' } }, true);
  });
  assert.equal(await signal.isVisible(), false, 'lost worktree');
  await page.evaluate(() => {
    const w = window as any;
    w.thread.update(w.worker, true);
    w.thread.activate(false);
  });
  assert.equal(await signal.isVisible(), false, 'Raw TTY/inactive pane');
  await page.evaluate(() => (window as any).thread.activate(true));
  assert.equal(await signal.isVisible(), true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await signal.isVisible(), false, 'background page');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await signal.isVisible(), true);
  await page.evaluate(() => (window as any).thread.dispose());
  assert.equal(await signal.isVisible(), false);
  assert.equal(await animation(), 'none');
  assert.deepEqual(errors, []);
});

test('thread work signal stays beside the composer and uses only the latest live activity', { skip: chromium }, async (t) => {
  const { page, errors } = await mountThread(t);
  // Same recorded tool and message shapes as worker-thread/thread-presentation tests.
  const entries: ThreadEntry[] = [
    { id: 'message', seq: 0, role: 'assistant', kind: 'text', text: 'Checking the failing test.\n\n'.repeat(100) },
    { id: 'tool:call', seq: 1, role: 'assistant', kind: 'tool', name: 'Execute', input: JSON.stringify({ command: 'npm test', summary: 'Run focused tests' }) },
  ];
  await page.addStyleTag({ content: 'body { display: flex; height: 100dvh; } .worker-thread { width: 100%; min-width: 0; }' });
  await page.evaluate(
    ({ entries, rows }) => {
      const w = window as any;
      w.worker = { ...w.worker, sessionId: 'session', status: 'working' };
      w.snapshot = (entries: unknown[], rows: unknown[]) => {
        w.tick();
        w.thread.update(w.worker, true);
        const request = w.sent.filter((msg: any) => msg.t === 'thread.read').at(-1).request;
        w.receive({ t: 'thread.snapshot', workerId: w.worker.id, request, sessionId: 'session', entries, hasMore: false, presentation: { version: 1, rows } });
      };
      w.snapshot(entries, rows);
    },
    { entries, rows: presentThread(entries, true) },
  );
  assert.equal(await page.locator('.wt-progress-detail').textContent(), 'Run focused tests');
  for (const [width, height] of [
    [1440, 900],
    [1024, 700],
    [360, 740],
  ]) {
    await page.setViewportSize({ width, height });
    await page.locator('.wt-scroll').evaluate((el) => {
      el.scrollTop = 0;
    });
    const bounds = await page.locator('.wt-progress').boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= height, `visible at ${width}px while reading history`);
    assert.equal(await page.locator('.worker-thread').evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await page.locator('.wt-scroll .wt-progress').count(), 0);
  }
  await page.evaluate(({ entries, rows }) => (window as any).snapshot(entries, rows), { entries, rows: presentThread(entries, false) });
  assert.equal(await page.locator('.wt-progress-detail').isVisible(), false, 'completed activity is not current work');
  const reply: ThreadEntry = { id: 'reply', seq: 2, role: 'assistant', kind: 'text', text: 'The tests pass.' };
  const replied = [...entries, reply];
  await page.evaluate(({ entries, rows }) => (window as any).snapshot(entries, rows), { entries: replied, rows: presentThread(replied, true) });
  assert.equal(await page.locator('.wt-progress-detail').isVisible(), false, 'do not reach backwards past a newer reply for tool activity');
  assert.equal(await page.locator('.wt-progress-label').textContent(), 'Working…', 'a recorded reply is not proof the turn ended');
  await page.evaluate(() => {
    const w = window as any;
    w.thread.update({ ...w.worker, sessionId: 'next-session' }, true);
  });
  assert.equal(await page.locator('.wt-progress-detail').isVisible(), false, 'new session has no stale action');
  await page.evaluate(() => (window as any).thread.dispose());
  assert.deepEqual(errors, []);
});
