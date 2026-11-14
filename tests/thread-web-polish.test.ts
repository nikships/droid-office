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
    w.worker = mounted;
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

/** Drags the mouse from the first to the last character of `selector`'s text, as the owner selects it. */
async function selectText(page: Page, selector: string) {
  const [from, to] = await page.evaluate((selector) => {
    const el = document.querySelector(selector)!;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (node) => (node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    const first = walker.nextNode() as Text;
    let last = first;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text;
    const at = (node: Text, offset: number) => {
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      return range.getBoundingClientRect();
    };
    const a = at(first, 0);
    const b = at(last, last.length - 1);
    return [
      [a.left + 1, a.top + a.height / 2],
      [b.right, b.top + b.height / 2],
    ];
  }, selector);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 5 });
  await page.mouse.up();
  await page.evaluate(() => (window as any).frames());
}

test('selected reply or diff text is quoted into the draft at its cursor', { skip: chromium }, async (t) => {
  const { page, errors } = await mount(t);
  const entries: ThreadEntry[] = [
    { id: 'u1', seq: 1, role: 'user', kind: 'text', text: 'Tidy the button styles' },
    {
      id: 'edit-1',
      seq: 2,
      role: 'assistant',
      kind: 'tool',
      name: 'Edit',
      input: JSON.stringify({ file_path: 'src/client/style.css', old_str: '.btn {\n  color: #999;\n}\n', new_str: '.btn {\n  color: #eee;\n}\n' }),
      output: 'Edited style.css',
    },
    { id: 'a1', seq: 3, role: 'assistant', kind: 'text', text: 'I brightened the button text.\n\nIt now matches the **header** color.' },
  ];
  await push(page, entries);
  const input = page.locator('textarea.wt-input');
  const quote = page.locator('.wt-quote');
  assert.equal(await quote.isHidden(), true);

  await input.fill('Thanks.');
  await selectText(page, '.wt-entry[data-entry="a1"] .md');
  assert.equal(await quote.isVisible(), true, 'a selection in a reply offers Quote');
  const placed = await page.evaluate(() => {
    const q = document.querySelector('.wt-quote')!.getBoundingClientRect();
    const s = document.querySelector('.wt-scroll')!.getBoundingClientRect();
    const end = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    return q.top >= s.top && q.bottom <= s.bottom && q.top >= end.bottom - 1;
  });
  assert.equal(placed, true, 'Quote sits below the selection, inside the conversation');
  await quote.click();
  assert.equal(await input.inputValue(), 'Thanks.\n\n> I brightened the button text.\n>\n> It now matches the header color.\n\n');
  assert.equal(await page.evaluate(() => document.activeElement?.matches('textarea.wt-input')), true);
  assert.equal(await page.evaluate(() => (document.querySelector('textarea.wt-input') as HTMLTextAreaElement).selectionStart), (await input.inputValue()).length);
  assert.equal(await page.evaluate(() => window.getSelection()?.isCollapsed ?? true), true);
  assert.equal(await quote.isHidden(), true);
  assert.equal(await page.evaluate(() => (window as any).draft), await input.inputValue());

  // A diff line, quoted at the cursor in the middle of the draft.
  await input.fill('Before after');
  await page.evaluate(() => {
    const el = document.querySelector('textarea.wt-input') as HTMLTextAreaElement;
    el.setSelectionRange(6, 6);
    el.blur();
  });
  await selectText(page, '.wt-change-file tr.wt-diff-row.is-add .wt-diff-code');
  assert.equal(await quote.isVisible(), true, 'a selection in a diff offers Quote');
  await quote.click();
  assert.equal(await input.inputValue(), 'Before\n\n> color: #eee;\n\n after');

  // Text outside the conversation, or a composer that can't take a message, offers no Quote.
  await selectText(page, '.wt-compose-bar');
  assert.equal(await quote.isHidden(), true);
  await page.evaluate(() => {
    const w = window as any;
    w.thread.update({ ...w.worker, status: 'needs_input' }, true);
  });
  await selectText(page, '.wt-entry[data-entry="a1"] .md');
  assert.equal(await quote.isHidden(), true);

  await page.evaluate(() => (window as any).thread.dispose());
  assert.deepEqual(errors, []);
});

test('large pastes become removable chips that expand back into the sent message', { skip: chromium }, async (t) => {
  const { page, errors } = await mount(t);
  await push(page, [{ id: 'a1', seq: 1, role: 'assistant', kind: 'text', text: 'Send me the log.' }]);
  const input = page.locator('textarea.wt-input');
  const chips = page.locator('.wt-paste-chip');
  const log = Array.from({ length: 40 }, (_, i) => `12:00:${String(i).padStart(2, '0')} step ${i} ok`).join('\n');
  const paste = (text: string) =>
    input.evaluate((el, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      return el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);

  await input.fill('See ');
  assert.equal(await paste('just a short line'), true, 'a short paste is left to the browser');
  assert.equal(await chips.count(), 0);
  assert.equal(await paste(log), false);
  assert.equal(await input.inputValue(), 'See [Pasted text #1 · 40 lines]');
  assert.equal(await chips.count(), 1);
  assert.match(await chips.innerText(), /Pasted text #1\s*40 lines/);
  assert.equal(await page.evaluate(() => (window as any).draft), `See ${log}`, 'the saved draft keeps the pasted text');

  // @file mentions still complete around a chip.
  await input.press('End');
  await input.pressSequentially(' and @');
  await page.locator('.wt-mention-item').first().waitFor();
  await input.press('ArrowDown');
  await input.press('Enter');
  assert.equal(await input.inputValue(), 'See [Pasted text #1 · 40 lines] and @package.json ');
  assert.equal(await chips.count(), 1);

  // A second paste, removed with its ✕, takes its token out of the draft.
  assert.equal(await paste('z'.repeat(1500)), false);
  assert.equal(await chips.count(), 2);
  assert.match(await chips.nth(1).innerText(), /1,500 characters/);
  await page.locator('.wt-paste-x[aria-label="Remove pasted text #2"]').click();
  assert.equal(await chips.count(), 1);
  assert.equal(await input.inputValue(), 'See [Pasted text #1 · 40 lines] and @package.json ');

  // Sending expands the chip into the prompt, then clears the composer.
  await input.press('Enter');
  await page.waitForFunction(() => (window as any).actions.some((a: any) => a.t === 'worker.prompt'));
  const sent = await page.evaluate(() => (window as any).actions.find((a: any) => a.t === 'worker.prompt'));
  assert.equal(sent.prompt, `See ${log} and @package.json`);
  assert.equal(await input.inputValue(), '');
  assert.equal(await chips.count(), 0);
  assert.equal(await page.locator('.wt-pastes').isHidden(), true);

  // Expanding a chip puts its text back in the draft to edit; deleting a token drops its chip.
  assert.equal(await paste(log), false);
  await page.locator('.wt-paste-open').click();
  assert.equal(await input.inputValue(), log);
  assert.equal(await chips.count(), 0);
  await input.fill('');
  assert.equal(await paste(log), false);
  await input.fill('typed over it');
  assert.equal(await chips.count(), 0);

  // A message whose pastes run past the office's prompt limit is held back with the reason.
  await input.fill('');
  assert.equal(await paste('q'.repeat(25_000)), false);
  await input.press('Enter');
  assert.match(await page.locator('.wt-notice').innerText(), /25,000 characters, over the 20,000-character limit/);
  assert.equal(await page.evaluate(() => (window as any).actions.filter((a: any) => a.t === 'worker.prompt').length), 1);
  assert.equal(await chips.count(), 1);

  await page.evaluate(() => (window as any).thread.dispose());
  assert.deepEqual(errors, []);
});
