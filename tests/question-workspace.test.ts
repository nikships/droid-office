import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { readMenu, type Menu } from '../src/shared/asks.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

// Text transcribed from the owner's two question screenshots, including the terminal's cuts.
const question = 'What design direction should the web and Android companions follow?';
const options = [
  'Dense operations console: compact rows, dense hierarchy, strong keyboard support',
  'Conversation-first: agent sidebar and clean chat workspace',
  'Attention-first dashboard: summaries and prioritized action cards',
  'Propose a balanced design and show me mockups before implementation',
];
const single = readMenu([
  '  companions follow?',
  '',
  '  1. Dense operations console: compact rows,',
  '  2. Conversation-first: agent sidebar and clean chat',
  '  3. Attention-first dashboard: summaries and',
  '  4. Propose a balanced design and show me',
  '  Or type your own answer...',
  '',
  '  Space/Enter/1-9 Select',
])!;
const multiple = readMenu([
  '  What does managing agents simultaneously primarily mean to you?',
  '  1. [ ] Persistent roster with live status while working in one conversation',
  '  2. [x] Several conversations or terminals visible side by side on larger screens',
  '  3. [ ] Select multiple agents to send instructions, stop, resume, or dismiss',
  '  4. [ ] One attention inbox for questions, approvals, failures, and finished work',
  '  [ ] Or type your own answer...',
  '  Submit',
  '  Space/Enter/1-9 Toggle',
])!;
const entries: ThreadEntry[] = [
  { id: 'ask', seq: 1, role: 'assistant', kind: 'tool', name: 'AskUser', input: JSON.stringify({ questionnaire: `1. [question] ${question}\n[topic] Design direction\n${options.map((option) => `[option] ${option}`).join('\n')}` }) },
];
const status = browserStatus();

test('answer workspace: full text, explicit selection, responsive scrolling and safe drafts', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const bundle = buildSync({ entryPoints: [fileURLToPath(new URL('../src/client/ui/question-workspace.ts', import.meta.url))], bundle: true, format: 'iife', globalName: 'QuestionUI', write: false, target: 'es2022' }).outputFiles[0].text;
  const css = readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8');
  async function pageFor(menu: Menu, width: number, height: number, full: ThreadEntry[] = []) {
    const context = await newIsolatedContext(browser, { viewport: { width, height } });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.setContent('<!doctype html><button id="opener">Answer questions</button><div id="modal-root"></div>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(
      ({ menu, full }) => {
        const w = window as any;
        w.replies = [];
        w.reviews = 0;
        w.draft = { text: '' };
        w.state = { menu, entries: full, enabled: true, sending: false, answered: false, current: true, connected: true };
        w.openAnswer = () => {
          document.getElementById('opener')!.focus();
          w.dialog = w.QuestionUI.openQuestionWorkspace({
            name: 'Pixel',
            state: w.state,
            draft: w.draft,
            onDraft() {},
            raw() {},
            async reply(value: unknown, menu: Menu) {
              w.replies.push({ value, menu });
            },
            review() {
              w.reviews++;
            },
            onClose() {
              w.closed = true;
            },
          });
        };
        w.openAnswer();
      },
      { menu, full },
    );
    return page;
  }
  for (const [width, height] of [
    [1440, 900],
    [1024, 700],
    [390, 844],
    [320, 700],
  ]) {
    const page = await pageFor(single, width, height, entries);
    assert.equal(await page.locator('.qw-question').textContent(), question);
    assert.deepEqual(await page.locator('.qw-choice-copy').allTextContents(), options);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await page.getByRole('button', { name: 'Show current question' }).isVisible(), false);
    assert.equal(
      await page
        .locator('.qw-choice-copy')
        .first()
        .evaluate((node) => getComputedStyle(node).textTransform),
      'none',
    );
    const choice = page.locator('input[type=radio]').first();
    await choice.check();
    assert.equal(await page.evaluate(() => (window as any).replies.length), 0, 'choosing is not submitting');
    await page.locator('.qw-text').scrollIntoViewIfNeeded();
    const footer = await page.locator('.question-workspace footer').boundingBox();
    assert.ok(footer && footer.y + footer.height <= height + 1, 'submit stays in the viewport while answers scroll');
    const meta = await page.locator('.qw-footer-meta').boundingBox();
    const back = await page.getByRole('button', { name: 'Back to thread' }).boundingBox();
    assert.ok(meta && back && (meta.y + meta.height <= back.y + 1 || meta.x + meta.width <= back.x + 1), 'footer metadata does not overlap the actions');
    await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).replies.map((reply: any) => reply.value)), [{ choice: 1 }]);
  }
  const capturedQuestion = "Install the Agent Insights plugin on entire.com for droid-office? It's free token-usage analytics across your agent sessions.";
  const capturedMenu = readMenu([
    '  Ask User',
    '',
    "  Install the Agent Insights plugin on entire.com for droid-office? It's free token-usage analytics",
    '  across your agent sessions.',
    '',
    '  1. Yes, install it',
    '  2. No, skip',
    '  Or type your own answer...',
    '',
    '  Space/Enter/1-9 Select',
  ])!;
  for (const [width, height] of [
    [1440, 900],
    [1024, 700],
  ]) {
    const captured = await pageFor(capturedMenu, width, height);
    assert.equal(await captured.locator('.qw-question').textContent(), capturedQuestion);
    assert.deepEqual(await captured.locator('.qw-choice-copy').allTextContents(), ['Yes, install it', 'No, skip']);
    await captured.locator('input[value="2"]').check();
    await captured.getByRole('button', { name: 'Submit answer', exact: true }).click();
    assert.deepEqual(await captured.evaluate(() => (window as any).replies[0].value), { choice: 2 });
    await captured.keyboard.press('Escape');
    assert.equal(await captured.locator('.question-workspace').count(), 0);
  }
  const page = await pageFor(multiple, 390, 844);
  assert.equal(await page.locator('input[value="2"]').isChecked(), true);
  await page.locator('input[value="1"]').check();
  await page.locator('input[value="4"]').check();
  await page.getByRole('textbox', { name: 'Your own answer' }).fill('Keep keyboard shortcuts');
  assert.equal(await page.evaluate(() => (window as any).replies.length), 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.question-workspace').count(), 0);
  assert.equal(await page.locator('#opener').evaluate((node) => document.activeElement === node), true);
  await page.evaluate(() => (window as any).openAnswer());
  assert.equal(await page.getByRole('textbox', { name: 'Your own answer' }).inputValue(), 'Keep keyboard shortcuts');
  for (const number of [1, 2, 4]) assert.equal(await page.locator(`input[value="${number}"]`).isChecked(), true);
  await page.evaluate(() => {
    const w = window as any;
    w.dialog.update({ ...w.state, enabled: false, connected: false });
  });
  assert.equal(await page.getByRole('button', { name: 'Submit answer', exact: true }).isDisabled(), true);
  assert.match((await page.locator('.qw-feedback').textContent()) ?? '', /Disconnected/);
  await page.evaluate(() => {
    const w = window as any;
    w.dialog.update({ ...w.state, enabled: false, current: false });
  });
  await page.getByRole('button', { name: 'Show current question' }).click();
  assert.equal(await page.evaluate(() => (window as any).reviews), 1);
  assert.equal(await page.evaluate(() => (window as any).replies.length), 0);
  await page.evaluate(() => {
    const w = window as any;
    w.dialog.update(w.state);
  });
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  const reply = await page.evaluate(() => (window as any).replies[0].value);
  assert.deepEqual(reply.choices.sort(), [1, 2, 4]);
  assert.equal(reply.text, 'Keep keyboard shortcuts');

  // A subsequent question in the same workspace must submit its own menu, not the first one.
  await page.evaluate(
    ({ single, entries }) => {
      const w = window as any;
      w.draft.text = '';
      w.draft.choices = undefined;
      w.state = { ...w.state, menu: single, entries };
      w.dialog.update(w.state);
    },
    { single, entries },
  );
  await page.locator('input[value="3"]').check();
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
  assert.equal(await page.evaluate(() => (window as any).replies.at(-1).menu.question), single.question);
  assert.deepEqual(await page.evaluate(() => (window as any).replies.at(-1).value), { choice: 3 });
});
