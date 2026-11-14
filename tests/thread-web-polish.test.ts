import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import type { Page } from 'playwright-core';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { presentThread } from '../src/shared/thread-presentation.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

const status = browserStatus();
const chromium = status.installed ? false : `Chromium is not installed in ${status.path}`;

const worker: WorkerInfo = {
  id: 'worker-1',
  kind: 'agent',
  deskId: 'desk-1',
  name: 'Pixel',
  color: '#ee6018',
  status: 'idle',
  sessionId: 'session-1',
  acked: false,
  createdBy: 'owner',
  createdAt: 1000,
  cols: 80,
  rows: 24,
  open: true,
};

let bundle: string | undefined;
async function mount(t: TestContext): Promise<{ page: Page; errors: string[] }> {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser, { viewport: { width: 1100, height: 800 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  bundle ??= buildSync({
    entryPoints: [fileURLToPath(new URL('../src/client/ui/worker-thread.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'ThreadUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  await page.setContent('<!doctype html><div id="toasts"></div><div id="modal-root"></div>');
  await page.addStyleTag({
    content: `${readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8')}\nbody { display: flex; height: 100dvh; margin: 0; } .worker-thread { width: 100%; min-width: 0; }`,
  });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate((mounted) => {
    const w = window as any;
    w.sent = [];
    w.actions = [];
    w.filesPayload = { files: ['package.json', 'src/client/style.css'], dirs: ['src/', 'src/client/'], truncated: false };
    window.fetch = async (input: any) => {
      const url = String(input);
      if (url.includes('/api/thread/files')) return new Response(JSON.stringify(w.filesPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/agents/droid/commands')) return new Response(JSON.stringify({ commands: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response('{}', { status: 404 });
    };
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
    w.question.hidden = true;
    w.thread = w.ThreadUI.mountWorkerThread(net, {
      worker: mounted,
      question: w.question,
      queueKey: 'polish-test',
      draft: '',
      onDraft(text: string) {
        w.draft = text;
      },
      send: async (msg: any) => {
        w.actions.push(msg);
        return undefined;
      },
      team: () => [],
      floor: 'floor-1',
    });
    document.body.append(w.thread.element);
    w.receive({ t: 'welcome', floors: [{ id: 'floor-1', name: 'droid-office', dir: '/Users/nik/repos/droid-office', forge: 'github' }] });
    w.thread.update(mounted, true);
    w.thread.activate(true);
    w.frames = async (n = 4) => {
      for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
    };
    w.gap = () => {
      const s = document.querySelector('.wt-scroll') as HTMLElement;
      return s.scrollHeight - s.scrollTop - s.clientHeight;
    };
  }, worker);
  return { page, errors };
}

async function push(page: Page, entries: ThreadEntry[], busy = false) {
  await page.evaluate(
    async ({ entries, rows }) => {
      const w = window as any;
      w.receive({ t: 'thread.snapshot', workerId: 'worker-1', request: 'push', push: true, sessionId: 'session-1', entries, hasMore: false, presentation: { version: 1, rows } });
      await w.frames();
    },
    { entries, rows: presentThread(entries, busy) },
  );
}

function longThread(turns: number): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  let seq = 1;
  for (let i = 0; i < turns; i++) {
    const long = i % 10 === 3;
    entries.push({ id: `u${i}`, seq: seq++, role: 'user', kind: 'text', text: long ? Array.from({ length: 40 }, (_, k) => `request ${i} line ${k}`).join('\n') : `Short request ${i}` });
    entries.push({
      id: `a${i}`,
      seq: seq++,
      role: 'assistant',
      kind: 'text',
      text: `Reply ${i} with marker needle-${i}-x.\n\n\`\`\`ts\nexport const v${i} = ${i};\n\`\`\`\n\n${'Paragraph text that wraps across lines. '.repeat(8)}`,
    });
  }
  return entries;
}

test('long threads skip off-screen rows yet keep following, anchoring, clamps, find and jumps working', { skip: chromium }, async (t) => {
  const { page, errors } = await mount(t);
  const entries = longThread(120);
  await push(page, entries);

  assert.equal(
    await page
      .locator('.wt-list > .wt-entry')
      .first()
      .evaluate((el) => getComputedStyle(el).contentVisibility),
    'auto',
  );
  assert.ok((await page.evaluate(() => (window as any).gap())) <= 1, 'opens at the very bottom');
  // Most rows are skipped: only the ones near the viewport render.
  const rendered = await page.evaluate(() => [...document.querySelectorAll('.wt-list > .wt-entry')].filter((el) => el.firstElementChild?.checkVisibility({ contentVisibilityAuto: true })).length);
  assert.ok(rendered > 0 && rendered < 60, `rendered ${rendered} of 240 rows`);

  // Clamps are measured for rows in view, and for an earlier row once it scrolls into view.
  const more = (id: string) => page.locator(`.wt-entry[data-entry="${id}"] .wt-message-more`);
  assert.equal(await more('u113').isVisible(), true, 'a long visible message offers Show all');
  assert.equal(await more('u119').isHidden(), true, 'a short visible message does not');
  await page.evaluate(async () => {
    document.querySelector('[data-entry="u13"]')!.scrollIntoView({ block: 'center' });
    await (window as any).frames();
  });
  assert.equal(await more('u13').isVisible(), true);
  const jumped = await page.locator('[data-entry="u13"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const s = document.querySelector('.wt-scroll')!.getBoundingClientRect();
    return r.bottom > s.top && r.top < s.bottom;
  });
  assert.equal(jumped, true, 'scrollIntoView lands on an entry that was skipped');
  await page.evaluate(async () => {
    document.querySelector('[data-entry="u12"]')!.scrollIntoView({ block: 'center' });
    await (window as any).frames();
  });
  assert.equal(await more('u12').isHidden(), true);

  // Scroll anchoring: while reading mid-thread, a streaming reply at the bottom does not move the view.
  const anchorTop = () => page.locator('[data-entry="a12"]').evaluate((el) => el.getBoundingClientRect().top);
  const before = await anchorTop();
  const grown = [...entries.slice(0, -1), { ...entries.at(-1)!, text: `${entries.at(-1)!.text}\n\n${'Streaming more text. '.repeat(200)}` }];
  await push(page, grown, true);
  assert.ok(Math.abs((await anchorTop()) - before) <= 1, 'the row being read stays put');
  assert.equal(await page.locator('.wt-latest').isVisible(), true);

  // Find in page searches text inside a skipped row (the browser's find bar then scrolls to it).
  const found = await page.evaluate(() => {
    const skippedBefore = !document.querySelector('[data-entry="a77"] .md')?.checkVisibility({ contentVisibilityAuto: true });
    const ok = (window as any).find('needle-77-x');
    return { skippedBefore, ok, row: window.getSelection()?.anchorNode?.parentElement?.closest('.wt-entry')?.getAttribute('data-entry') };
  });
  assert.deepEqual(found, { skippedBefore: true, ok: true, row: 'a77' });
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  // Jump to latest lands at the real bottom even though the rows in between held estimates.
  await page.locator('.wt-latest').click();
  await page.evaluate(() => (window as any).frames(6));
  assert.ok((await page.evaluate(() => (window as any).gap())) <= 1, 'jump to latest reaches the bottom');

  // A new message while following stays in view, and so does the sticky plan bar above the composer.
  const planned: ThreadEntry[] = [
    ...grown,
    { id: 'todo', seq: 9001, role: 'assistant', kind: 'tool', name: 'TodoWrite', input: JSON.stringify({ todos: '1. [completed] One\n2. [in_progress] Two' }), output: 'TODO List Updated' },
    { id: 'last', seq: 9002, role: 'assistant', kind: 'text', text: `Final reply.\n\n${'Closing line.\n'.repeat(30)}` },
  ];
  await push(page, planned, true);
  await page.evaluate(() => (window as any).frames(6));
  assert.ok((await page.evaluate(() => (window as any).gap())) <= 1, 'follows a new message');
  assert.equal(await page.locator('.wt-plan-bar').isVisible(), true);
  assert.equal(await page.locator('.wt-plan-count').textContent(), '1/2 completed');

  const gapAfterResizes = await page.evaluate(async () => {
    const w = window as any;
    for (let i = 0; i < 6; i++) {
      document.body.style.width = i % 2 ? '' : '640px';
      await w.frames(2);
    }
    document.body.style.width = '';
    await w.frames(4);
    return w.gap();
  });
  assert.ok(gapAfterResizes <= 1, 'resizing while following stays at the bottom');

  await page.evaluate(() => (window as any).thread.dispose());
  assert.deepEqual(errors, []);
});
