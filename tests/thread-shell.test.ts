import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { entryAt, entryTook, liveFrom } from '../src/client/ui/thread-live-view.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { presentThread } from '../src/shared/thread-presentation.js';
import { pickPhrase, relativeTime, statusMode, thoughtLabel } from '../src/shared/thread-status.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

test('Factory status copy falls back to worker state and formats times', () => {
  assert.equal(statusMode(undefined, 'working'), 'pondering');
  assert.equal(statusMode('responding', 'working'), 'responding');
  assert.equal(statusMode('pondering', 'needs_input'), 'waiting');
  assert.equal(statusMode('idle', 'working'), 'pondering');
  assert.equal(statusMode('idle', 'idle'), 'idle');
  assert.notEqual(
    pickPhrase(3, 1, () => 0),
    1,
  );
  assert.equal(pickPhrase(1, 0), 0);
  for (let previous = 0; previous < 3; previous++) {
    for (const random of [0, 0.5, 0.999999]) {
      const next = pickPhrase(3, previous, () => random);
      assert.notEqual(next, previous, 'even a repeated random value must terminate without repeating');
      assert.ok(next >= 0 && next < 3);
    }
  }
  assert.equal(thoughtLabel(25_000), 'Thought for 25s');
  assert.equal(thoughtLabel(undefined), 'Thought');
  const now = Date.UTC(2026, 0, 2, 12);
  assert.equal(relativeTime(now - 22 * 3_600_000, now), '22h ago');
  assert.equal(relativeTime(now - 30_000, now), 'now');
});

test('message times match Factory narrow formatting at past and future boundaries', () => {
  const now = Date.UTC(2026, 0, 2, 12);
  const cases = [
    [0, 'now', 'now'],
    [59_999, 'now', 'now'],
    [60_000, '1m ago', 'in 1m'],
    [60_001, '1m ago', 'in 1m'],
    [3_599_999, '59m ago', 'in 59m'],
    [3_600_000, '1h ago', 'in 1h'],
    [3_600_001, '1h ago', 'in 1h'],
    [86_399_999, '23h ago', 'in 23h'],
    [86_400_000, '1d ago', 'in 1d'],
    [86_400_001, '1d ago', 'in 1d'],
  ] as const;
  for (const [distance, past, future] of cases) {
    assert.equal(relativeTime(now - distance, now), past);
    assert.equal(relativeTime(now + distance, now), future);
  }
});

test('thread.live parsing replaces only newer views and reads settings and timings', () => {
  const msg = {
    t: 'thread.live',
    workerId: 'w1',
    sessionId: 's1',
    live: {
      rev: 2,
      at: 9000,
      status: 'responding',
      working: 'streaming_assistant_message',
      after: 'a1',
      stream: { kind: 'text', text: 'draft', since: 8000 },
      tools: [{ id: 'tool:1', name: 'Execute', startedAt: 7000, phase: 'running', output: 'ok' }],
      settings: { modelName: 'Opus 5.5', reasoningEffort: 'high', autonomyLevel: 'medium', interactionMode: 'spec' },
    },
  };
  const view = liveFrom(msg, 'w1', 's1', undefined, 10_000);
  assert.equal(view?.skew, 1000);
  assert.equal(view?.stream?.text, 'draft');
  assert.equal(view?.tools[0]?.id, 'tool:1');
  assert.equal(view?.settings?.modelName, 'Opus 5.5');
  assert.equal('autonomyLevel' in view!.settings!, false, 'companion settings ignore autonomy metadata');
  assert.equal(view?.side, undefined);
  assert.equal(liveFrom({ ...msg, live: { ...msg.live, rev: 3, side: { text: 'Q and A' } } }, 'w1', 's1', view, 11_000)?.side?.text, 'Q and A');
  assert.equal(liveFrom(msg, 'w1', 's1', view, 11_000), undefined);
  assert.equal(liveFrom({ ...msg, workerId: 'other' }, 'w1', 's1', undefined), undefined);
  assert.equal(liveFrom({ ...msg, sessionId: undefined }, 'w1', 's1', undefined), undefined, 'unbound live state cannot replace a known session');
  const entry = { id: 'a1', seq: 1, role: 'assistant', kind: 'text', text: 'done', at: 8000, tookMs: 2500 } as ThreadEntry;
  assert.equal(entryAt(entry), 8000);
  assert.equal(entryTook(entry), 2500);
});

const status = browserStatus();
const chromium = status.installed ? false : `Chromium is not installed in ${status.path}`;
const worker: WorkerInfo = {
  id: 'worker-1',
  kind: 'agent',
  deskId: 'desk-1',
  name: 'Pixel',
  color: '#ee6018',
  status: 'working',
  sessionId: 'session-1',
  acked: false,
  createdBy: 'owner',
  createdAt: 1000,
  cols: 80,
  rows: 24,
  open: true,
};

async function mountShell(t: TestContext) {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bundle = buildSync({
    stdin: {
      contents: `export { mountWorkerThread } from './src/client/ui/worker-thread.ts'; export { store } from './src/client/state.ts';`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: 'ThreadUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  await page.setContent('<!doctype html><div id="toasts"></div><div id="modal-root"></div>');
  await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate((mounted) => {
    const w = window as any;
    w.worker = mounted;
    w.sent = [];
    w.actions = [];
    Date.now = () => 100_000;
    const net = {
      send(msg: any) {
        w.sent.push(msg);
        return true;
      },
      onMessage(fn: any) {
        w.receive = (msg: any) => {
          if (msg.t === 'models.hidden') w.ThreadUI.store.apply(msg);
          fn(msg);
        };
        return () => {};
      },
    };
    w.thread = w.ThreadUI.mountWorkerThread(net, {
      worker: mounted,
      question: document.createElement('div'),
      queueKey: 'shell-test',
      draft: '',
      onDraft() {},
      send: async (msg: any) => {
        w.actions.push(msg);
        if (w.holdSend)
          return new Promise((resolve, reject) => {
            w.finishSend = resolve;
            w.failSend = reject;
          });
        return undefined;
      },
      raw() {},
      floor: 'floor-1',
    });
    document.body.append(w.thread.element);
    w.receive({ t: 'welcome', floors: [{ id: 'floor-1', name: 'office', dir: '/tmp/office', forge: 'github' }] });
    w.thread.update(mounted, true);
    w.thread.activate(true);
  }, worker);
  return { page, errors };
}

test('Thread shell wires live output, search, rewind, prompt history and queue actions', { skip: chromium }, async (t) => {
  const { page, errors } = await mountShell(t);
  const entries = [
    { id: 'u1', seq: 1, role: 'user', kind: 'text', text: 'hello uniqueNeedle', at: 90_000 },
    { id: 'a1', seq: 2, role: 'assistant', kind: 'text', text: 'A recorded reply', at: 95_000 },
  ] as ThreadEntry[];
  await page.evaluate(
    ({ entries, rows }) => {
      const w = window as any;
      w.receive({ t: 'thread.snapshot', workerId: 'worker-1', request: 'push', push: true, sessionId: 'session-1', entries, hasMore: false, presentation: { version: 1, rows } });
      w.receive({
        t: 'thread.live',
        workerId: 'worker-1',
        sessionId: 'session-1',
        live: {
          rev: 1,
          at: 100_000,
          status: 'responding',
          working: 'streaming_assistant_message',
          after: 'a1',
          stream: { kind: 'text', text: 'streaming draft', since: 99_000 },
          tools: [{ name: 'Execute', startedAt: 98_000, phase: 'running', output: 'partial output' }],
          settings: { modelName: 'Opus 5.5', reasoningEffort: 'high', autonomyLevel: 'high', interactionMode: 'spec' },
        },
      });
    },
    { entries, rows: presentThread(entries, true) },
  );
  assert.equal(await page.locator('.wt-stream-copy').textContent(), 'streaming draft');
  assert.match(await page.locator('.wt-live-tool').innerText(), /partial output/);
  assert.match(await page.locator('.wt-model').innerText(), /Opus 5.5/);
  assert.equal(await page.locator('.wt-mode').isVisible(), true);
  assert.equal(await page.locator('.wt-autonomy, [aria-label*="autonomy" i], [title*="autonomy" i]').count(), 0, 'Thread exposes no autonomy display or control');

  await page.locator('.wt-scroll').press('Control+f');
  await page.locator('.wt-search-input').fill('uniqueNeedle');
  await page.waitForFunction(() => document.querySelector('.wt-search-count')?.textContent === '1 / 1 results');
  assert.equal(await page.evaluate(() => CSS.highlights.get('wt-search-current')?.size), 1);
  await page.locator('.wt-search-input').press('Escape');

  await page.evaluate(() => {
    const w = window as any;
    w.receive({ t: 'thread.live', workerId: 'worker-1', sessionId: 'session-1', live: { rev: 2, at: 100_000, status: 'idle', working: 'idle', after: 'a1', tools: [] } });
    w.thread.update({ ...w.worker, status: 'idle' }, true);
  });
  assert.equal(await page.locator('.wt-stream').isVisible(), false);
  await page.locator('[data-entry="u1"]').hover();
  await page.getByRole('button', { name: 'Rewind conversation to this message' }).click();
  await page.getByText('Restore all files', { exact: true }).click();
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  await page.waitForFunction(() => (window as any).actions.some((msg: any) => msg.t === 'worker.rewind'));
  assert.equal(await page.evaluate(() => (window as any).actions.find((msg: any) => msg.t === 'worker.rewind').restore), 'files');
  await page.evaluate(() => (window as any).receive({ t: 'worker.rewound', workerId: 'worker-1', entryId: 'u1', ok: true, text: 'hello uniqueNeedle' }));
  assert.equal(await page.locator('.wt-input').inputValue(), 'hello uniqueNeedle', 'the rewound prompt returns to the composer');
  await page.locator('.wt-input').fill('');

  // The successful rewind cleared the transcript; put the entries back for recent prompts and the queue.
  await page.evaluate(
    ({ entries, rows }) => {
      const w = window as any;
      const request = w.sent.filter((msg: any) => msg.t === 'thread.read').at(-1).request;
      w.receive({ t: 'thread.snapshot', workerId: 'worker-1', request, sessionId: 'session-1', entries, hasMore: false, presentation: { version: 1, rows } });
      w.thread.update({ ...w.worker, status: 'working' }, true);
    },
    { entries, rows: presentThread(entries, true) },
  );
  await page.locator('.wt-input').fill('half typed');
  await page.locator('.wt-input').press('ArrowUp');
  assert.equal(await page.locator('.wt-input').inputValue(), 'hello uniqueNeedle', 'Up recalls the last prompt in place');
  await page.locator('.wt-input').press('ArrowUp');
  assert.equal(await page.locator('.wt-input').inputValue(), 'hello uniqueNeedle', 'the oldest prompt stays put');
  await page.locator('.wt-input').press('ArrowDown');
  assert.equal(await page.locator('.wt-input').inputValue(), 'half typed', 'Down returns to the draft');
  await page.locator('.wt-input').fill('queue this follow-up');
  await page.locator('.wt-input').press('Control+Enter');
  assert.match(await page.locator('.wt-queued').innerText(), /Queued messages/);
  assert.match(await page.locator('.wt-queued').innerText(), /queue this follow-up/);
  await page.locator('[data-queued]').hover();
  await page.getByRole('button', { name: 'Send now', exact: true }).click();
  await page.waitForFunction(() => (window as any).actions.some((msg: any) => msg.t === 'worker.queue' && msg.action === 'promote'));
  assert.deepEqual(
    await page.evaluate(() => {
      const msg = (window as any).actions.findLast((action: any) => action.t === 'worker.queue');
      return { action: msg.action, index: msg.index, group: msg.group, text: msg.text };
    }),
    { action: 'promote', index: 1, group: 'queued', text: 'queue this follow-up' },
  );
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).thread.dispose());
});

test('rewind confirmation locks its exact choices until completion and recovers from a rejected send', { skip: chromium }, async (t) => {
  const { page, errors } = await mountShell(t);
  const entries = [{ id: 'u1', seq: 1, role: 'user', kind: 'text', text: 'Exact rewind target preview' }] as ThreadEntry[];
  await page.evaluate(
    ({ entries, rows }) => {
      const w = window as any;
      w.holdSend = true;
      w.thread.update({ ...w.worker, status: 'idle' }, true);
      w.receive({ t: 'thread.snapshot', workerId: 'worker-1', request: 'push', push: true, sessionId: 'session-1', entries, hasMore: false, presentation: { version: 1, rows } });
    },
    { entries, rows: presentThread(entries, false) },
  );
  await page.locator('[data-entry="u1"]').hover();
  await page.getByRole('button', { name: 'Rewind conversation to this message' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rewind Conversation' });
  assert.match(await dialog.innerText(), /Exact rewind target preview/);
  assert.doesNotMatch(await dialog.innerText(), /Changed files will not be reverted/);
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  assert.equal(await dialog.locator('input:not(:disabled), button:not(:disabled)').count(), 0);
  await page.keyboard.press('Escape');
  await page.locator('.backdrop').dispatchEvent('mousedown');
  assert.equal(await dialog.isVisible(), true);
  await page.evaluate(() => (window as any).failSend(new Error('Network disconnected')));
  await page.waitForFunction(() => document.querySelector('.wt-rewind-error')?.textContent === 'Network disconnected');
  assert.equal(await dialog.locator('input:disabled, button:disabled').count(), 0);
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  await page.evaluate(() => (window as any).finishSend(undefined));
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).thread.dispose());
});

test('the model chip changes the model and reasoning effort through worker.setting', { skip: chromium }, async (t) => {
  const { page, errors } = await mountShell(t);
  await page.evaluate(() => {
    const w = window as any;
    w.fetch = async () =>
      new Response(
        JSON.stringify({
          models: [
            { id: 'custom:droidproxy:opus-5-5', displayName: 'DroidProxy: Opus 5.5', custom: true },
            { id: 'opus-5-5', displayName: 'Opus 5.5', supportedReasoningEfforts: ['low', 'medium', 'high'] },
            { id: 'sonnet-5-5', displayName: 'Sonnet 5.5' },
          ],
        }),
      );
    w.receive({
      t: 'thread.live',
      workerId: 'worker-1',
      sessionId: 'session-1',
      live: { rev: 1, at: 100_000, status: 'idle', working: 'idle', tools: [], settings: { model: 'opus-5-5', modelName: 'Opus 5.5', reasoningEffort: 'high', autonomyLevel: 'low', interactionMode: 'auto' } },
    });
  });
  assert.equal(await page.locator('.wt-mode').isVisible(), false, 'Normal mode shows no mark');
  await page.locator('.wt-model').click();
  await page.getByRole('menuitemradio', { name: 'Sonnet 5.5' }).waitFor();
  assert.equal(await page.getByRole('menuitemradio', { name: 'High' }).getAttribute('aria-checked'), 'true');
  await page.getByRole('menuitemradio', { name: 'Medium' }).click();
  await page.locator('.wt-model').click();
  await page.getByRole('menuitemradio', { name: 'Sonnet 5.5' }).click();
  const settings = await page.evaluate(() => (window as any).actions.filter((msg: any) => msg.t === 'worker.setting').map((msg: any) => [msg.setting, msg.value]));
  assert.deepEqual(settings, [
    ['effort', 'medium'],
    ['model', 'sonnet-5-5'],
  ]);
  await page.locator('.wt-model').click();
  await page.evaluate(() => (window as any).receive({ t: 'models.hidden', ids: [], hideNative: true }));
  await page.getByRole('menuitemradio', { name: 'DroidProxy: Opus 5.5' }).waitFor();
  assert.equal(await page.getByRole('menuitemradio', { name: 'Sonnet 5.5' }).count(), 0);
  await page.evaluate(() => (window as any).receive({ t: 'models.hidden', ids: [], hideNative: false }));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.wt-settings-menu').isVisible(), false);
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).thread.dispose());
});

test('rewind can restore only the files the owner picks', { skip: chromium }, async (t) => {
  const { page, errors } = await mountShell(t);
  const entries = [
    { id: 'u1', seq: 1, role: 'user', kind: 'text', text: 'Change two files' },
    { id: 'tool:1', seq: 2, role: 'assistant', kind: 'tool', name: 'Edit', input: JSON.stringify({ file_path: '/tmp/office/a.txt', old_str: 'a', new_str: 'b' }), output: 'ok' },
    { id: 'tool:2', seq: 3, role: 'assistant', kind: 'tool', name: 'Create', input: JSON.stringify({ file_path: '/tmp/office/c.txt', content: 'c' }), output: 'ok' },
  ] as ThreadEntry[];
  await page.evaluate(
    ({ entries, rows }) => {
      const w = window as any;
      w.thread.update({ ...w.worker, status: 'idle' }, true);
      w.receive({ t: 'thread.snapshot', workerId: 'worker-1', request: 'push', push: true, sessionId: 'session-1', entries, hasMore: false, presentation: { version: 1, rows } });
    },
    { entries, rows: presentThread(entries, false) },
  );
  await page.locator('[data-entry="u1"]').hover();
  await page.getByRole('button', { name: 'Rewind conversation to this message' }).click();
  await page.getByText('Choose files to restore...', { exact: true }).click();
  const files = page.getByRole('group', { name: 'Restore Files to Rewind Point' });
  assert.match(await files.innerText(), /office\/a\.txt\s*restore/);
  assert.match(await files.innerText(), /office\/c\.txt\s*delete/);
  await files.getByRole('checkbox').first().uncheck();
  await page.getByRole('button', { name: 'Rewind', exact: true }).click();
  await page.waitForFunction(() => (window as any).actions.some((msg: any) => msg.t === 'worker.rewind'));
  const sent = await page.evaluate(() => (window as any).actions.find((msg: any) => msg.t === 'worker.rewind'));
  assert.equal(sent.restore, 'choose');
  assert.deepEqual(sent.files, ['/tmp/office/c.txt']);
  await page.evaluate(() => (window as any).receive({ t: 'worker.rewound', workerId: 'worker-1', entryId: 'u1', ok: true, text: 'Change two files', note: 'Droid had no file changes to restore.' }));
  assert.match(
    await page
      .locator('.wt-send-hint, .wt-feedback')
      .allInnerTexts()
      .then((all) => all.join(' ')),
    /no file changes to restore/,
  );
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).thread.dispose());
});

test('slash commands: /copy opens the copy menu, mid-turn ones send and the side chat closes', { skip: chromium }, async (t) => {
  const { page, errors } = await mountShell(t);
  const entries = [
    { id: 'u1', seq: 1, role: 'user', kind: 'text', text: 'first prompt' },
    { id: 'a1', seq: 2, role: 'assistant', kind: 'text', text: 'first reply' },
  ] as ThreadEntry[];
  await page.evaluate(
    ({ entries, rows }) => {
      const w = window as any;
      w.receive({ t: 'thread.snapshot', workerId: 'worker-1', request: 'push', push: true, sessionId: 'session-1', entries, hasMore: false, presentation: { version: 1, rows } });
      w.thread.update({ ...w.worker, status: 'idle' }, true);
    },
    { entries, rows: presentThread(entries, false) },
  );
  await page.locator('.wt-input').fill('/copy');
  await page.locator('.wt-input').press('Enter');
  const copy = page.getByRole('dialog', { name: 'Copy' });
  for (const choice of ['Last assistant response', 'Last user prompt', 'Current session ID', 'Full conversation transcript', 'Select range']) assert.equal(await copy.getByRole('button', { name: choice }).count(), 1, choice);
  await copy.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await page.evaluate(() => (window as any).actions.some((msg: any) => msg.t === 'worker.prompt')), false, '/copy stays in the Thread');

  await page.evaluate(() => (window as any).thread.update({ ...(window as any).worker, status: 'working' }, true));
  await page.locator('.wt-input').fill('/new');
  await page.locator('.wt-input').press('Enter');
  assert.match(
    await page
      .locator('.wt-send-hint, .wt-feedback')
      .allInnerTexts()
      .then((all) => all.join(' ')),
    /\/new runs once Pixel finishes this turn/,
  );
  await page.locator('.wt-input').fill('/btw what is this repo?');
  await page.locator('.wt-input').press('Enter');
  await page.waitForFunction(() => (window as any).actions.some((msg: any) => msg.t === 'worker.prompt' && msg.prompt === '/btw what is this repo?'));

  await page.evaluate(() =>
    (window as any).receive({ t: 'thread.live', workerId: 'worker-1', sessionId: 'session-1', live: { rev: 5, at: 100_000, status: 'pondering', working: 'thinking', tools: [], side: { text: 'what is this repo?\n\nAn office.' } } }),
  );
  const side = page.getByRole('region', { name: 'Side chat' });
  assert.match(await side.innerText(), /An office\./);
  await page.locator('.wt-input').press('Escape');
  await page.waitForFunction(() => (window as any).actions.some((msg: any) => msg.t === 'worker.side'));
  assert.equal(await page.evaluate(() => (window as any).actions.some((msg: any) => msg.t === 'worker.interrupt')), false, 'Esc closes the side chat, not the turn');
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).thread.dispose());
});
