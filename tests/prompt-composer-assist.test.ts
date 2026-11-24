import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();
const chromium = status.installed ? false : `Chromium is not installed in ${status.path}`;

async function mountPromptPage(t: TestContext) {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  const bundle = buildSync({
    entryPoints: [fileURLToPath(new URL('../src/client/ui/prompt.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'PromptUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;

  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8');
  await page.route('http://127.0.0.1:4699/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><head><style>${css}</style></head><body class="dashboard"><div id="toasts"></div><div id="modal-root"></div></body></html>`,
      });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto('http://127.0.0.1:4699/');
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });

  await page.evaluate(() => {
    const w = window as any;
    w.fetches = [];
    w.submitted = [];
    w.drafts = [];
    localStorage.setItem('droid-office.prompt-history', JSON.stringify(['earlier prompt one', 'earlier prompt two']));
    window.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      w.fetches.push(url);
      if (url.startsWith('/api/agents/droid/commands')) {
        return new Response(
          JSON.stringify({
            commands: [
              { name: 'full-send', description: 'Drive a change autonomously end-to-end through PR and merge', source: 'skill' },
              { name: 'full-stop', description: 'Drive a change through PR and stop ready to merge', source: 'skill' },
              { name: 'fix-pull-request', description: 'Fix merge conflicts and failing CI checks', source: 'command' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('/api/thread/files')) {
        return new Response(
          JSON.stringify({
            dirs: ['src/', 'src/client/', 'src/client/ui/', 'tests/'],
            files: ['AGENTS.md', 'package.json', 'src/client/style.css', 'src/client/ui/prompt.ts', 'src/client/ui/composer-assist.ts', 'tests/prompt-composer-assist.test.ts'],
            truncated: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  });

  return { page, errors };
}

test('hire dialog supports slash autocomplete, @file mentions, paste chips, Esc menu dismissal, and cloud toggle', { skip: chromium }, async (t) => {
  const { page, errors } = await mountPromptPage(t);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.evaluate(() => {
    const w = window as any;
    let cloud = false;
    const listeners: ((c: boolean) => void)[] = [];
    w.setCloud = (next: boolean) => {
      cloud = next;
      for (const fn of listeners) fn(cloud);
    };
    w.PromptUI.openPrompt({
      title: 'Hire Droid',
      subtitle: 'droid-office',
      submitLabel: 'Hire Droid',
      allowEmpty: true,
      floor: 'floor-1',
      imagesOption: true,
      recall: true,
      runsOn: {
        rows: [],
        choice: () => (cloud ? { computerId: 'c1', computerName: 'Cloud Box', cwd: '/repo' } : null),
        onChange: (fn: (c: boolean) => void) => listeners.push(fn),
      },
      onDraft: (text: string) => w.drafts.push(text),
      onSubmit: (text: string) => {
        w.submitted.push(text);
        return undefined;
      },
    });
  });

  const ta = page.locator('.prompt-box textarea');
  await ta.waitFor({ state: 'visible' });

  // Wait for preloaded floor slash commands and test `/full-` autocomplete.
  await ta.fill('/full-');
  await page.locator('.wt-slash').waitFor({ state: 'visible' });
  const slashItems = await page.locator('.wt-slash-item .wt-slash-name').allTextContents();
  assert.deepEqual(slashItems, ['/full-send', '/full-stop']);
  assert.equal(await page.evaluate(() => (window as any).fetches.some((u: string) => u === '/api/agents/droid/commands?floor=floor-1')), true);

  // ArrowDown moves selection inside the slash menu rather than recalling prompt history.
  await ta.press('ArrowDown');
  assert.equal(await page.locator('.wt-slash-item').nth(1).getAttribute('aria-selected'), 'true');
  assert.equal(await ta.inputValue(), '/full-');
  await ta.press('ArrowUp');
  assert.equal(await page.locator('.wt-slash-item').nth(0).getAttribute('aria-selected'), 'true');

  // Escape dismisses the slash menu WITHOUT closing the Hire Droid modal.
  await ta.press('Escape');
  await page.locator('.wt-slash').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.modal.prompt-box').isVisible(), true);

  // Typing again reopens slash menu; Enter on partial `/full-sen` completes `/full-send ` without submitting.
  await ta.fill('/full-sen');
  await page.locator('.wt-slash').waitFor({ state: 'visible' });
  await ta.press('Enter');
  assert.equal(await ta.inputValue(), '/full-send ');
  assert.equal(await page.evaluate(() => (window as any).submitted.length), 0);
  await page.locator('.wt-slash').waitFor({ state: 'hidden' });

  // Now type `@src/cl` to trigger `@` workspace file mentions on the floor.
  await ta.type('update @src/cl');
  await page.locator('.wt-mention').waitFor({ state: 'visible' });
  const mentionPaths = await page.locator('.wt-mention-path').allTextContents();
  assert.ok(mentionPaths.includes('src/client/'), `expected src/client/ in ${mentionPaths.join(', ')}`);
  assert.equal(await page.evaluate(() => (window as any).fetches.some((u: string) => u === '/api/thread/files?floor=floor-1')), true);

  // Picking folder `src/client/` inserts `@src/client/` and keeps narrowing inside that folder.
  await page.getByRole('option', { name: 'src/client/ Folder', exact: true }).click();
  assert.equal(await ta.inputValue(), '/full-send update @src/client/');
  await page.locator('.wt-mention').waitFor({ state: 'visible' });

  // Drill into `ui/pr` and pick `src/client/ui/prompt.ts` with Tab.
  await ta.type('ui/pr');
  await page.locator('.wt-mention-item', { hasText: 'src/client/ui/prompt.ts' }).waitFor({ state: 'visible' });
  await ta.press('Tab');
  assert.equal(await ta.inputValue(), '/full-send update @src/client/ui/prompt.ts ');
  await page.locator('.wt-mention').waitFor({ state: 'hidden' });

  // Switching Runs on to cloud disables slash & mention menus; switching back restores them.
  await ta.type('@AGENTS');
  await page.locator('.wt-mention').waitFor({ state: 'visible' });
  await page.evaluate(() => (window as any).setCloud(true));
  await page.locator('.wt-mention').waitFor({ state: 'hidden' });
  await page.evaluate(() => (window as any).setCloud(false));
  await page.locator('.wt-mention').waitFor({ state: 'visible' });
  await ta.press('Escape');
  await page.locator('.wt-mention').waitFor({ state: 'hidden' });

  // Blocked slash command `/quit` refuses instead of hiring a worker that immediately exits.
  await ta.fill('/quit');
  await ta.press('Enter');
  assert.equal(await page.locator('.prompt-box .note.bad').isVisible(), true);
  assert.equal(await page.evaluate(() => (window as any).submitted.length), 0);

  // Large paste collapses into a chip and expands back into the submitted prompt.
  const longText = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n');
  await ta.fill('/full-send check @src/client/ui/prompt.ts ');
  await page.evaluate((text) => {
    const el = document.querySelector<HTMLTextAreaElement>('.prompt-box textarea')!;
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, cancelable: true }));
  }, longText);
  await page.locator('.prompt-box .wt-paste-chip').waitFor({ state: 'visible' });

  // Check layout fits cleanly at 1024x700 too.
  await page.setViewportSize({ width: 1024, height: 700 });
  const overflow = await page.evaluate(() => {
    const modal = document.querySelector<HTMLElement>('.modal.prompt-box')!;
    const rect = modal.getBoundingClientRect();
    return rect.right > window.innerWidth + 1 || rect.bottom > window.innerHeight + 1;
  });
  assert.equal(overflow, false);

  // Pressing Enter submits with the expanded paste text and closes the modal.
  await ta.press('Enter');
  const submitted = await page.evaluate(() => (window as any).submitted as string[]);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0], `/full-send check @src/client/ui/prompt.ts ${longText}`);
  assert.equal(await page.locator('.modal.prompt-box').count(), 0);
  assert.deepEqual(errors, []);
});

test('hire dialog supports mid-prompt slash skills on same line, new line, and cursor edits without false positives', { skip: chromium }, async (t) => {
  const { page, errors } = await mountPromptPage(t);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.evaluate(() => {
    const w = window as any;
    w.PromptUI.openPrompt({
      title: 'Hire Droid',
      subtitle: 'droid-office',
      submitLabel: 'Hire Droid',
      allowEmpty: true,
      floor: 'floor-1',
      imagesOption: true,
      recall: true,
      onSubmit: (text: string) => {
        w.submitted.push(text);
        return undefined;
      },
    });
  });

  const ta = page.locator('.prompt-box textarea');
  await ta.waitFor({ state: 'visible' });

  // Wait for preloaded floor slash commands, then type text followed by a newline and `/`.
  await ta.fill('Fix the login bug in @src/client/ui/prompt.ts\n\n/');
  await page.locator('.wt-slash').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.wt-slash').getAttribute('aria-label'), 'Skills');
  // Mid-prompt menu shows ONLY skills (not built-ins like /compress or custom commands like /fix-pull-request).
  const midItems = await page.locator('.wt-slash-item .wt-slash-name').allTextContents();
  assert.deepEqual(midItems, ['/full-send', '/full-stop']);

  // Pressing Enter on partial `/full-s` completes in place while preserving the prompt text before it.
  await ta.type('full-s');
  await ta.press('ArrowDown');
  assert.equal(await page.locator('.wt-slash-item').nth(1).getAttribute('aria-selected'), 'true');
  await ta.press('Enter');
  assert.equal(await ta.inputValue(), 'Fix the login bug in @src/client/ui/prompt.ts\n\n/full-stop ');
  assert.equal(await page.evaluate(() => (window as any).submitted.length), 0);
  await page.locator('.wt-slash').waitFor({ state: 'hidden' });

  // Chaining a second skill inline after a space works and Tab completes in place.
  await ta.type('/full-sen');
  await page.locator('.wt-slash').waitFor({ state: 'visible' });
  await ta.press('Tab');
  assert.equal(await ta.inputValue(), 'Fix the login bug in @src/client/ui/prompt.ts\n\n/full-stop /full-send ');
  await page.locator('.wt-slash').waitFor({ state: 'hidden' });

  // URLs, file paths, comments, JSX, and mid-word slashes never trigger the slash menu.
  for (const sample of ['Check https://example.com/full', 'Edit src/client/ui/prompt.ts', 'Inspect /etc/hosts', 'Fix UI/UX', 'Add //comment', 'Render <Tag />']) {
    await ta.fill(sample);
    assert.equal(await page.locator('.wt-slash').isVisible(), false, `slash menu should stay hidden for ${sample}`);
  }

  // Leading non-skill slash command suppresses mid-prompt skills; leading skill allows them.
  await ta.fill('/model /full');
  assert.equal(await page.locator('.wt-slash').isVisible(), false);
  await ta.fill('/fix-pull-request /full');
  assert.equal(await page.locator('.wt-slash').isVisible(), false);
  await ta.fill('/full-send and /full-st');
  await page.locator('.wt-slash').waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('.wt-slash-item .wt-slash-name').allTextContents(), ['/full-stop']);

  // Editing an earlier slash token in the middle of text preserves text after it without double spaces.
  await ta.fill('Check /full please');
  await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>('.prompt-box textarea')!;
    el.focus();
    el.setSelectionRange(11, 11);
    el.click();
  });
  await page.locator('.wt-slash').waitFor({ state: 'visible' });
  await ta.press('Escape');
  await page.locator('.wt-slash').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.modal.prompt-box').isVisible(), true);

  // Typing a char reopens, Enter replaces only `/full` and leaves ` please` intact.
  await ta.type('-s');
  await page.locator('.wt-slash').waitFor({ state: 'visible' });
  await ta.press('Enter');
  assert.equal(await ta.inputValue(), 'Check /full-send please');
  await page.locator('.wt-slash').waitFor({ state: 'hidden' });

  // Caret inside a longer token whose prefix matches an exact skill name completes on Enter rather than submitting.
  await ta.fill('Please /full-sendish now');
  await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>('.prompt-box textarea')!;
    el.focus();
    el.setSelectionRange(17, 17);
    el.dispatchEvent(new Event('selectionchange'));
  });
  await page.locator('.wt-slash').waitFor({ state: 'visible' });
  await ta.press('Enter');
  assert.equal(await ta.inputValue(), 'Please /full-send now');
  assert.equal(await page.evaluate(() => (window as any).submitted.length), 0);
  await page.locator('.wt-slash').waitFor({ state: 'hidden' });

  // Moving the caret away via selectionchange closes the slash menu, and Shift+ArrowUp selects text instead of cycling.
  await ta.fill('Line one\n/full-');
  await page.locator('.wt-slash').waitFor({ state: 'visible' });
  await ta.press('Shift+ArrowUp');
  await page.locator('.wt-slash').waitFor({ state: 'hidden' });
  const hasSelection = await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>('.prompt-box textarea')!;
    return el.selectionStart !== el.selectionEnd;
  });
  assert.equal(hasSelection, true);

  await ta.fill('Line one /full-');
  await page.locator('.wt-slash').waitFor({ state: 'visible' });
  await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>('.prompt-box textarea')!;
    el.focus();
    el.setSelectionRange(0, 0);
    el.dispatchEvent(new Event('selectionchange'));
  });
  await page.locator('.wt-slash').waitFor({ state: 'hidden' });

  // Moving the caret straight into a different slash token and pressing Tab before selectionchange fires syncs the menu to the live token.
  await ta.fill('One /full-sen\nTwo /full-st');
  await page.locator('.wt-slash-item', { hasText: '/full-stop' }).waitFor({ state: 'visible' });
  await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>('.prompt-box textarea')!;
    el.focus();
    el.setSelectionRange(13, 13);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  });
  assert.equal(await ta.inputValue(), 'One /full-send \nTwo /full-st');

  // Moving from outside a slash token (menu hidden) into `/full-sen` and pressing Enter before selectionchange fires completes rather than submitting.
  await ta.fill('One /full-sen\nTwo end');
  await page.locator('.wt-slash').waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>('.prompt-box textarea')!;
    el.focus();
    el.setSelectionRange(13, 13);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  assert.equal(await ta.inputValue(), 'One /full-send \nTwo end');
  assert.equal(await page.evaluate(() => (window as any).submitted.length), 0);

  // Unresolved leading `/tmp` stays plain text and still allows inline skills later in the prompt.
  await ta.fill('/tmp is where logs are; /full-');
  await page.locator('.wt-slash').waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('.wt-slash-item .wt-slash-name').allTextContents(), ['/full-send', '/full-stop']);

  // Existing @file completion still honors Control+Enter and Shift+Tab.
  await ta.fill('Check @pack');
  await page.locator('.wt-mention').waitFor({ state: 'visible' });
  await ta.press('Control+Enter');
  assert.equal(await ta.inputValue(), 'Check @package.json ');
  await page.locator('.wt-mention').waitFor({ state: 'hidden' });

  // Typing an exact skill name at the end and pressing Enter submits immediately.
  await ta.fill('Ship this fix\n\n/full-send');
  await page.locator('.wt-slash').waitFor({ state: 'visible' });
  await ta.press('Enter');
  const submitted = await page.evaluate(() => (window as any).submitted as string[]);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0], 'Ship this fix\n\n/full-send');
  assert.equal(await page.locator('.modal.prompt-box').count(), 0);
  assert.deepEqual(errors, []);
});

test('ask dialog with prepended context treats slash suggestions as inline skills', { skip: chromium }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  const bundle = buildSync({
    entryPoints: [fileURLToPath(new URL('../src/client/ui/ask.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'AskUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8');
  await page.route('http://127.0.0.1:4698/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><head><style>${css}</style></head><body class="dashboard"><div id="toasts"></div><div id="modal-root"></div></body></html>`,
      });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  await page.goto('http://127.0.0.1:4698/');
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.evaluate(() => {
    const w = window as any;
    w.submitted = [];
    window.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('/api/agents/droid/commands')) {
        return new Response(
          JSON.stringify({
            commands: [
              { name: 'full-send', description: 'Drive a change end-to-end', source: 'skill' },
              { name: 'fix-pull-request', description: 'Custom command', source: 'command' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    w.AskUI.openAsk({
      title: 'Work on issue #42',
      context: 'Issue #42: Fix slash autocomplete',
      floor: 'floor-1',
      newDesk: 'Desk 1',
      workers: [],
      onSubmit: (text: string) => w.submitted.push(text),
    });
  });

  const ta = page.locator('#ask-prompt');
  await ta.waitFor({ state: 'visible' });
  await ta.fill('/model and then /full-');
  await page.locator('.wt-slash').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.wt-slash').getAttribute('aria-label'), 'Skills');
  assert.deepEqual(await page.locator('.wt-slash-item .wt-slash-name').allTextContents(), ['/full-send']);
  await ta.press('Enter');
  assert.equal(await ta.inputValue(), '/model and then /full-send ');
  assert.deepEqual(errors, []);
});
