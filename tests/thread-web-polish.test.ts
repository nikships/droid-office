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
  const quote = page.locator('.wt-quote-btn');
  assert.equal(await quote.isHidden(), true);

  await input.fill('Thanks.');
  await selectText(page, '.wt-entry[data-entry="a1"] .md');
  assert.equal(await quote.isVisible(), true, 'a selection in a reply offers Quote');
  const placed = await page.evaluate(() => {
    const q = document.querySelector('.wt-quote-pill')!.getBoundingClientRect();
    const end = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    return q.top >= 0 && q.bottom <= innerHeight && (q.bottom <= end.top || q.top >= end.bottom);
  });
  assert.equal(placed, true, 'Add to chat sits above or below the selection, inside the viewport');
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
  const change = page.locator('.wt-tr[data-disclosure*="style.css"]');
  await change.locator('.wt-tr-trigger').click();
  await change.evaluate(async (el) => {
    await Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
  });
  await selectText(page, '.wt-tr[data-disclosure*="style.css"] tr.wt-diff-row.is-add .wt-diff-code');
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
