import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { presentThread } from '../src/shared/thread-presentation.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

const status = browserStatus();
const chromium = status.installed ? false : `Chromium is not installed in ${status.path}`;

const baseWorker: WorkerInfo = {
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

async function mountV3Thread(t: TestContext, mounted: WorkerInfo = baseWorker, floor = 'floor-1') {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  const bundle = buildSync({
    entryPoints: [fileURLToPath(new URL('../src/client/ui/worker-thread.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'ThreadUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;

  await page.setContent('<!doctype html><div id="toasts"></div><div id="modal-root"></div>');
  await page.addStyleTag({
    content: `${readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8')}\nbody { display: flex; height: 100dvh; } .worker-thread { width: 100%; min-width: 0; }`,
  });
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });

  await page.evaluate(
    ({ worker, floor }) => {
      const w = window as any;
      w.worker = worker;
      w.sent = [];
      w.actions = [];
      w.fetches = [];
      w.openedWorkers = [];
      w.openedChanges = [];
      w.sentToBoard = [];
      w.team = [];
      w.filesPayload = {
        files: ['package.json', 'src/client/style.css', 'src/client/ui/worker-thread.ts'],
        dirs: ['src/', 'src/client/', 'src/client/ui/'],
        truncated: false,
      };
      w.filePreviewPayload = {
        path: 'src/client/style.css',
        content: Array.from({ length: 40 }, (_, idx) => `.rule-${idx + 1} { color: #eee; }`).join('\n'),
        truncated: false,
        size: 1024,
      };

      let clock = 100_000;
      Date.now = () => clock;
      w.advance = (ms: number) => {
        clock += ms;
      };

      let intervalFn: (() => void) | undefined;
      const realSetInterval = window.setInterval.bind(window);
      window.setInterval = ((fn: TimerHandler, ms?: number) => {
        if (ms === 1000 && typeof fn === 'function') intervalFn = fn as () => void;
        return realSetInterval(fn, ms);
      }) as typeof window.setInterval;
      w.runIntervalTick = (ms = 1000) => {
        clock += ms;
        intervalFn?.();
      };

      window.fetch = async (input: any) => {
        const url = String(input);
        w.fetches.push(url);
        if (url.includes('/api/thread/files')) {
          const parsed = new URL(url, 'http://localhost');
          const q = parsed.searchParams.get('q') ?? '';
          const payload = typeof w.filesHandler === 'function' ? w.filesHandler(q) : w.filesPayload;
          return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/api/thread/file')) {
          const parsed = new URL(url, 'http://localhost');
          const reqPath = parsed.searchParams.get('path') ?? '';
          return new Response(JSON.stringify({ ...w.filePreviewPayload, path: reqPath }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/api/agents/droid/commands')) {
          return new Response(JSON.stringify({ commands: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
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
        worker,
        question: w.question,
        queueKey: 'v3-web-test',
        draft: '',
        onDraft(txt: string) {
          w.draft = txt;
        },
        send: async (msg: any) => {
          w.actions.push(msg);
          return undefined;
        },
        raw() {
          w.openedRaw = true;
        },
        team: () => w.team,
        openWorker: (id: string) => w.openedWorkers.push(id),
        openChanges: (id: string) => w.openedChanges.push(id),
        sendToWhiteboard: (id: string, path: string) => w.sentToBoard.push([id, path]),
        floor,
      });

      document.body.append(w.thread.element);
      w.receive({
        t: 'welcome',
        floors: [{ id: floor, name: 'droid-office', dir: '/Users/nik/repos/droid-office', forge: 'github' }],
      });
      w.thread.update(worker, true);
      w.thread.activate(true);
    },
    { worker: mounted, floor },
  );

  return { page, errors };
}

test('worker-thread subscribes via thread.watch, consumes push snapshots immediately, reconciles every 15s, and cleans up watches', { skip: chromium }, async (t) => {
  const { page, errors } = await mountV3Thread(t);

  // Initial mount sends thread.watch { on: true } and one immediate thread.read
  const initialMsgs = await page.evaluate(() => (window as any).sent);
  assert.deepEqual(
    initialMsgs.filter((m: any) => m.t === 'thread.watch'),
    [{ t: 'thread.watch', workerId: 'worker-1', on: true }],
  );
  assert.equal(initialMsgs.filter((m: any) => m.t === 'thread.read').length, 1);

  // While unreceived, interval retries at 1500ms (so +1000ms while pending or < 1500ms does not spam)
  const pushedEntries: ThreadEntry[] = [{ id: 'm1', seq: 1, role: 'assistant', kind: 'text', text: 'Pushed live reply!' }];
  await page.evaluate(
    ({ entries, rows }) => {
      const w = window as any;
      // Push arrives while initial thread.read is still pending -> clears pending and renders immediately!
      w.receive({
        t: 'thread.snapshot',
        workerId: 'worker-1',
        request: 'push',
        push: true,
        sessionId: 'session-1',
        entries,
        hasMore: false,
        presentation: { version: 1, rows },
      });
    },
    { entries: pushedEntries, rows: presentThread(pushedEntries, true) },
  );
  assert.match(await page.locator('.wt-entry.assistant').innerText(), /Pushed live reply!/);

  // Tick 14 seconds of 1s timer + worker status updates -> zero thread.read polls!
  const readsBefore = await page.evaluate(() => (window as any).sent.filter((m: any) => m.t === 'thread.read').length);
  await page.evaluate(() => {
    const w = window as any;
    for (let i = 0; i < 14; i++) {
      w.runIntervalTick(1000);
      w.thread.update({ ...w.worker, activity: `step ${i}` }, true);
    }
  });
  const readsAt14s = await page.evaluate(() => (window as any).sent.filter((m: any) => m.t === 'thread.read').length);
  assert.equal(readsAt14s, readsBefore, 'no 1s polling during push-driven streaming');

  // At 15s, low-frequency fallback reconciliation fires one thread.read
  await page.evaluate(() => (window as any).runIntervalTick(1000));
  const readsAt15s = await page.evaluate(() => (window as any).sent.filter((m: any) => m.t === 'thread.read').length);
  assert.equal(readsAt15s, readsBefore + 1);

  // Hiding document unwatches; restoring visibility re-watches and reads
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.deepEqual(await page.evaluate(() => (window as any).sent.filter((m: any) => m.t === 'thread.watch').at(-1)), {
    t: 'thread.watch',
    workerId: 'worker-1',
    on: false,
  });

  await page.evaluate(() => {
    const w = window as any;
    w.sent.length = 0;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.deepEqual(await page.evaluate(() => (window as any).sent.filter((m: any) => m.t === 'thread.watch')), [{ t: 'thread.watch', workerId: 'worker-1', on: true }]);

  // Deactivating and disposing send thread.watch { on: false } without duplicates
  await page.evaluate(() => {
    const w = window as any;
    w.sent.length = 0;
    w.thread.activate(false);
  });
  assert.deepEqual(await page.evaluate(() => (window as any).sent.filter((m: any) => m.t === 'thread.watch')), [{ t: 'thread.watch', workerId: 'worker-1', on: false }]);

  await page.evaluate(() => {
    const w = window as any;
    w.thread.activate(true);
    w.sent.length = 0;
    w.thread.dispose();
  });
  assert.deepEqual(await page.evaluate(() => (window as any).sent.filter((m: any) => m.t === 'thread.watch')), [{ t: 'thread.watch', workerId: 'worker-1', on: false }]);
  assert.deepEqual(errors, []);
});

test('renders V3 1-level exploration disclosures and top-level File Change, Command, and Delegation cards with user toggle persistence', { skip: chromium }, async (t) => {
  const { page, errors } = await mountV3Thread(t);

  const bigOld = Array.from({ length: 95 }, (_, i) => `const line${i + 1} = ${i};`).join('\n');
  const bigNew = Array.from({ length: 95 }, (_, i) => `const line${i + 1} = ${i + 100};`).join('\n');

  const entries: ThreadEntry[] = [
    { id: 'u1', seq: 1, role: 'user', kind: 'text', text: 'Refactor **styles** and run tests\n`src/client/style.css`' },
    { id: 'r1', seq: 2, role: 'assistant', kind: 'tool', name: 'Read', input: JSON.stringify({ file_path: 'src/a.ts' }), output: 'content a' },
    { id: 'th1', seq: 3, role: 'assistant', kind: 'thinking', text: 'Inspecting callers before editing' },
    { id: 's1', seq: 4, role: 'assistant', kind: 'tool', name: 'Grep', input: JSON.stringify({ pattern: 'foo' }), output: 'src/a.ts:1' },
    {
      id: 'edit-1',
      seq: 5,
      role: 'assistant',
      kind: 'tool',
      name: 'Edit',
      input: JSON.stringify({
        file_path: '/Users/nik/repos/droid-office/.droid-office/worktrees/pixel-1662/src/client/style.css',
        old_str: '.btn {\n  color: #999;\n}\n',
        new_str: '.btn {\n  color: #eee;\n}\n',
      }),
      output: 'Edited style.css',
    },
    {
      id: 'edit-gen',
      seq: 6,
      role: 'assistant',
      kind: 'tool',
      name: 'Edit',
      input: JSON.stringify({
        file_path: 'package-lock.json',
        old_str: '"version": "1.0.0"',
        new_str: '"version": "1.0.1"',
      }),
      output: 'Edited package-lock.json',
    },
    {
      id: 'edit-big',
      seq: 7,
      role: 'assistant',
      kind: 'tool',
      name: 'Edit',
      input: JSON.stringify({
        file_path: 'src/big.ts',
        old_str: bigOld,
        new_str: bigNew,
      }),
      output: 'Edited big.ts',
    },
    {
      id: 'cmd-ok',
      seq: 8,
      role: 'assistant',
      kind: 'tool',
      name: 'Execute',
      input: JSON.stringify({ command: 'npm run lint', summary: 'Run Oxlint and Biome' }),
      output: '0 warnings, 0 errors',
    },
    {
      id: 'cmd-fail',
      seq: 9,
      role: 'assistant',
      kind: 'tool',
      name: 'Execute',
      input: JSON.stringify({ command: 'npm test', summary: 'Run test suite' }),
      output: 'FAIL tests/app.test.ts',
      error: true,
    },
    {
      id: 'del-1',
      seq: 10,
      role: 'assistant',
      kind: 'tool',
      name: 'droid-office___team_hire',
      input: JSON.stringify({ title: 'Android Thread Parity', subagent_type: 'worker', branch: 'thread-v3-android', prompt: 'Implement Compose parity' }),
      output: 'Hired Byte (45c311aadfc4). Worktree: /tmp/wt on thread-v3-android.',
    },
  ];

  await page.evaluate(
    ({ entries, rows }) => {
      const w = window as any;
      w.team = [
        {
          id: '45c311aadfc4',
          kind: 'agent',
          deskId: 'd2',
          name: 'Byte',
          color: '#3ccf91',
          status: 'working',
          sessionId: 'session-byte',
          acked: false,
          createdBy: 'worker-1',
          createdAt: 1001,
          cols: 80,
          rows: 24,
          open: false,
          lead: 'worker-1',
        },
      ];
      w.receive({
        t: 'thread.snapshot',
        workerId: 'worker-1',
        request: 'push',
        push: true,
        sessionId: 'session-1',
        entries,
        hasMore: false,
        presentation: { version: 1, rows },
      });
    },
    {
      entries,
      // style.css as it is now, with the edited rule at line 30: its diff carries that file's lines.
      rows: presentThread(entries, false, { fileText: (p) => (p.endsWith('/style.css') ? `${Array.from({ length: 29 }, (_, i) => `.rule-${i + 1} {}`).join('\n')}\n.btn {\n  color: #eee;\n}\n` : undefined) }),
    },
  );

  // User message rendered with threadUserMarkdown
  assert.equal(await page.locator('.wt-user-md strong').textContent(), 'styles');
  assert.equal(await page.locator('.wt-user-md code').textContent(), 'src/client/style.css');

  // 1-level compact exploration disclosure (no nested .wt-run!)
  assert.equal(await page.locator('.wt-run').count(), 0);
  const explore = page.locator('details.wt-explore');
  assert.equal(await explore.count(), 1);
  assert.equal(await explore.evaluate((el) => (el as HTMLDetailsElement).open), false);
  assert.match(await explore.locator('> summary').innerText(), /Read a file · Searched the code/);

  // Normal file change card is open by default; generated lockfile is collapsed by default
  const styleCard = page.locator('details.wt-change-file[data-disclosure*="style.css"]');
  const lockCard = page.locator('details.wt-change-file[data-disclosure*="package-lock.json"]');
  assert.equal(await styleCard.evaluate((el) => (el as HTMLDetailsElement).open), true);
  assert.equal(await lockCard.evaluate((el) => (el as HTMLDetailsElement).open), false);
  assert.equal(await styleCard.locator('.wt-diff-add').textContent(), '+1');
  assert.equal(await styleCard.locator('.wt-diff-del').textContent(), '-1');
  assert.ok((await styleCard.locator('.wt-diff-word-del').count()) >= 1);
  assert.ok((await styleCard.locator('.wt-diff-word-add').count()) >= 1);

  // Clicking file path header opens openFilePreviewModal WITHOUT collapsing details.wt-change-file!
  await styleCard.locator('button.wt-change-path').click();
  const previewModal = page.locator('.modal.wt-file-modal');
  await previewModal.locator('.wt-file-lines').waitFor();
  assert.equal(await styleCard.evaluate((el) => (el as HTMLDetailsElement).open), true);
  assert.equal(await previewModal.locator('.wt-file-line.is-target').getAttribute('data-line'), '30');
  assert.deepEqual(await styleCard.locator('.wt-diff-num.is-new').allTextContents(), ['30', '', '31', '32']);
  await page.keyboard.press('Escape');
  assert.equal(await previewModal.count(), 0);

  // 80-line diff clamping + Show full diff toggle. A diff this big starts closed.
  const bigCard = page.locator('details.wt-change-file[data-disclosure*="src/big.ts"]');
  assert.equal(await bigCard.evaluate((el) => (el as HTMLDetailsElement).open), false);
  await bigCard.locator('> summary').click();
  assert.equal(await bigCard.locator('.wt-diff-row').count(), 80);
  // Its file isn't readable here, so it has no gutter rather than numbers counted from 1.
  assert.equal(await bigCard.locator('table.wt-diff-table.is-unnumbered').count(), 1);
  assert.equal(await bigCard.locator('.wt-diff-num').first().isVisible(), false);
  const moreBtn = bigCard.locator('.wt-diff-more');
  assert.match((await moreBtn.textContent()) ?? '', /Show full diff \(111 more lines\)/);
  await moreBtn.click();
  assert.equal(await bigCard.locator('.wt-diff-row').count(), 191);
  assert.equal(await moreBtn.textContent(), 'Show less');

  // Command cards: succeeded command closed by default, failed command auto-opened!
  const okCmd = page.locator('details.wt-command[data-disclosure="cmd-ok"]');
  const failCmd = page.locator('details.wt-command[data-disclosure="cmd-fail"]');
  assert.equal(await okCmd.evaluate((el) => (el as HTMLDetailsElement).open), false);
  assert.equal(await failCmd.evaluate((el) => (el as HTMLDetailsElement).open), true);
  assert.match(await okCmd.locator('.wt-cmd-line').innerText(), /\$\s*npm run lint/);
  // Clicking Copy on closed command card does NOT toggle it open
  await okCmd.locator('.wt-cmd-copy').click();
  assert.equal(await okCmd.evaluate((el) => (el as HTMLDetailsElement).open), false);

  // User manually closes styleCard and failCmd -> preserved across re-render when new message arrives!
  await styleCard.locator('> summary').click();
  await failCmd.locator('> summary').click();
  // The thread records a toggle when its (asynchronous) toggle event arrives; the rows below re-render the cards.
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('details.wt-change-file[data-disclosure*="style.css"], details.wt-command[data-disclosure="cmd-fail"]')].every((el) => el.dataset.expectedOpen === 'false'));
  assert.equal(await styleCard.evaluate((el) => (el as HTMLDetailsElement).open), false);
  assert.equal(await failCmd.evaluate((el) => (el as HTMLDetailsElement).open), false);

  const updatedEntries: ThreadEntry[] = [...entries, { id: 'm-after', seq: 11, role: 'assistant', kind: 'text', text: 'Fixed the failure.' }];
  await page.evaluate(
    ({ entries, rows }) => {
      (window as any).receive({
        t: 'thread.snapshot',
        workerId: 'worker-1',
        request: 'push',
        push: true,
        sessionId: 'session-1',
        entries,
        hasMore: false,
        presentation: { version: 1, rows },
      });
    },
    { entries: updatedEntries, rows: presentThread(updatedEntries, false) },
  );
  assert.equal(await styleCard.evaluate((el) => (el as HTMLDetailsElement).open), false, 'user-collapsed file change stays collapsed');
  assert.equal(await failCmd.evaluate((el) => (el as HTMLDetailsElement).open), false, 'user-collapsed failed command stays collapsed');

  // Delegation card Open thread button routes to child workerId
  const delegateCard = page.locator('.wt-delegate-card');
  assert.equal(await delegateCard.locator('.wt-delegate-agent').textContent(), 'Byte');
  assert.equal(await delegateCard.locator('.wt-delegate-branch').textContent(), 'thread-v3-android');
  await delegateCard.locator('.wt-delegate-open').click();
  assert.deepEqual(await page.evaluate(() => (window as any).openedWorkers), ['45c311aadfc4']);

  await page.evaluate(() => (window as any).thread.dispose());
  assert.deepEqual(errors, []);
});

test('renders rich Markdown replies, sticky collapsible Plan Bar, @file workspace autocomplete, and responsive viewports without overflow', { skip: chromium }, async (t) => {
  const { page, errors } = await mountV3Thread(t);

  const richAssistant = [
    'Updated `src/client/style.css:15` with latency $O(\\log n)$:',
    '',
    '<json-render>{"root":"m","elements":{"m":{"type":"Metric","props":{"label":"Coverage","value":"92%","trend":"up"},"children":[]}}}</json-render>',
    '',
    '```ts',
    'export const ready: boolean = true;',
    '```',
  ].join('\n');

  const entries: ThreadEntry[] = [
    { id: 'u1', seq: 1, role: 'user', kind: 'text', text: 'Build V3 UI' },
    {
      id: 'todo-1',
      seq: 2,
      role: 'assistant',
      kind: 'tool',
      name: 'TodoWrite',
      input: JSON.stringify({
        todos: '1. [completed] Wire push watch\n2. [in_progress] Style inline diffs\n3. [pending] Run tests',
      }),
      output: 'TODO List Updated',
    },
    { id: 'a1', seq: 3, role: 'assistant', kind: 'text', text: richAssistant },
  ];

  await page.evaluate(
    ({ entries, rows }) => {
      (window as any).receive({
        t: 'thread.snapshot',
        workerId: 'worker-1',
        request: 'push',
        push: true,
        sessionId: 'session-1',
        entries,
        hasMore: false,
        presentation: { version: 1, rows },
      });
    },
    { entries, rows: presentThread(entries, true) },
  );

  // Rich Markdown checks: <json-render>, MathML, code block, clickable workspace path:line
  assert.equal(await page.locator('.jr-metric-value').textContent(), '92%');
  assert.equal(await page.locator('.wt-math-inline math').count(), 1);
  assert.equal(await page.locator('.wt-code-block .wt-code-lang').textContent(), 'TypeScript');
  await page.locator('.wt-md .wt-file-link').first().click();
  await page.locator('.modal.wt-file-modal .wt-file-lines').waitFor();
  assert.equal(await page.locator('.modal.wt-file-modal .wt-file-line.is-target').getAttribute('data-line'), '15');
  await page.keyboard.press('Escape');

  // Sticky Plan Bar checks: visible, shows count + active step, expands/collapses, hides once stale
  const planBar = page.locator('.wt-plan-bar');
  assert.equal(await planBar.isVisible(), true);
  assert.equal(await planBar.locator('.wt-plan-count').textContent(), '1/3 completed');
  assert.equal(await planBar.locator('.wt-plan-current').textContent(), 'Style inline diffs');
  await planBar.locator('.wt-plan-head').click();
  assert.equal(await planBar.locator('.wt-plan-step').count(), 3);
  assert.equal(await planBar.locator('.wt-plan-step.is-done .wt-plan-glyph').textContent(), '✓');
  assert.equal(await planBar.locator('.wt-plan-step.is-active .wt-plan-glyph').textContent(), '●');
  assert.equal(await planBar.locator('.wt-plan-step.is-pending .wt-plan-glyph').textContent(), '○');

  // @file composer autocomplete: type @, navigate with arrows, drill down into src/client/, pick file
  const input = page.locator('textarea.wt-input');
  await input.focus();
  await input.fill('Inspect @');
  await page.locator('.wt-mention-item').first().waitFor();
  // First item for bare @ is src/
  assert.equal(await page.locator('.wt-mention-item[aria-selected="true"] .wt-mention-path').textContent(), 'src/');
  await input.press('Tab');
  assert.equal(await input.inputValue(), 'Inspect @src/');
  // Menu stays open narrowed to src/client/
  assert.equal(await page.locator('.wt-mention-item[aria-selected="true"] .wt-mention-path').textContent(), 'src/client/');
  await input.press('Enter');
  assert.equal(await input.inputValue(), 'Inspect @src/client/');
  // ArrowDown to src/client/style.css and press Enter to insert file + trailing space
  await input.press('ArrowDown');
  assert.equal(await page.locator('.wt-mention-item[aria-selected="true"] .wt-mention-path').textContent(), 'src/client/style.css');
  await input.press('Enter');
  assert.equal(await input.inputValue(), 'Inspect @src/client/style.css ');
  assert.equal(await page.locator('.wt-mention').isVisible(), false);

  // Cached base files list reused within 10s without refetching; truncated workspace triggers ?q=
  const fileFetchesBefore = await page.evaluate(() => (window as any).fetches.filter((u: string) => u.includes('/api/thread/files')).length);
  assert.equal(fileFetchesBefore, 1);
  await input.fill('Also @pkg');
  assert.equal(await page.evaluate(() => (window as any).fetches.filter((u: string) => u.includes('/api/thread/files')).length), 1);
  await input.press('Escape');
  assert.equal(await page.locator('.wt-mention').isVisible(), false);

  await page.evaluate(() => {
    const w = window as any;
    w.advance(15_000);
    w.filesHandler = (q: string) => (q ? { files: ['src/client/ui/worker-thread.ts'], dirs: [], truncated: false } : { files: ['README.md'], dirs: ['src/'], truncated: true });
  });
  await input.fill('Check @worker-thread');
  await page.waitForFunction(() => (window as any).fetches.some((u: string) => u.includes('q=worker-thread')));
  assert.equal(await page.locator('.wt-mention-item .wt-mention-path').first().textContent(), 'src/client/ui/worker-thread.ts');
  await input.fill('');

  // Verify responsive viewports (1440x900, 1024x700, 360x740) and prefers-reduced-motion
  for (const [width, height] of [
    [1440, 900],
    [1024, 700],
    [360, 740],
  ]) {
    await page.setViewportSize({ width, height });
    const noOverflow = await page.locator('.worker-thread').evaluate((el) => el.scrollWidth <= el.clientWidth);
    assert.equal(noOverflow, true, `no horizontal overflow at ${width}x${height}`);
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await planBar.locator('.wt-plan-fill').evaluate((el) => getComputedStyle(el).transitionProperty), 'none');

  // Completing all steps and sending a new user turn marks plan stale -> hides plan bar
  const staleEntries: ThreadEntry[] = [
    ...entries,
    {
      id: 'todo-done',
      seq: 4,
      role: 'assistant',
      kind: 'tool',
      name: 'TodoWrite',
      input: JSON.stringify({
        todos: '1. [completed] Wire push watch\n2. [completed] Style inline diffs\n3. [completed] Run tests',
      }),
      output: 'TODO List Updated',
    },
    { id: 'u2', seq: 5, role: 'user', kind: 'text', text: 'Next unrelated question' },
  ];
  await page.evaluate(
    ({ entries, rows }) => {
      const w = window as any;
      w.worker = { ...w.worker, status: 'idle' };
      w.thread.update(w.worker, true);
      w.receive({
        t: 'thread.snapshot',
        workerId: 'worker-1',
        request: 'push',
        push: true,
        sessionId: 'session-1',
        entries,
        hasMore: false,
        presentation: { version: 1, rows },
      });
    },
    { entries: staleEntries, rows: presentThread(staleEntries, false) },
  );
  assert.equal(await planBar.isVisible(), false, 'stale completed plan hides cleanly');

  await page.evaluate(() => (window as any).thread.dispose());
  assert.deepEqual(errors, []);
});

test('folds a run of cards into one group, ends a finished turn with what it changed, and highlights commands', { skip: chromium }, async (t) => {
  const { page, errors } = await mountV3Thread(t);
  const edit = (id: string, seq: number, file: string, from: string, to: string): ThreadEntry => ({
    id,
    seq,
    role: 'assistant',
    kind: 'tool',
    name: 'Edit',
    input: JSON.stringify({ file_path: `/Users/nik/repos/droid-office/${file}`, old_str: from, new_str: to }),
    output: `Edited ${file}`,
  });
  const entries: ThreadEntry[] = [
    { id: 'u1', seq: 1, role: 'user', kind: 'text', text: 'Tidy the docs' },
    edit('e1', 2, 'docs/a.md', 'old a', 'new a'),
    edit('e2', 3, 'docs/b.md', 'old b', 'new b\nmore b'),
    { id: 'c1', seq: 4, role: 'assistant', kind: 'tool', name: 'Execute', input: JSON.stringify({ command: 'grep -rn "TODO" docs | wc -l' }), output: '0' },
    { id: 'm1', seq: 5, role: 'assistant', kind: 'text', text: 'Done.' },
    { id: 'u2', seq: 6, role: 'user', kind: 'text', text: 'And the guide' },
    edit('e3', 7, 'docs/c.md', 'old c', 'new c'),
  ];
  const push = (rows: unknown) =>
    page.evaluate(
      ({ entries, rows }) => {
        (window as any).receive({ t: 'thread.snapshot', workerId: 'worker-1', request: 'push', push: true, sessionId: 'session-1', entries, hasMore: false, presentation: { version: 1, rows } });
      },
      { entries, rows },
    );
  await push(presentThread(entries, false));

  // The earlier turn's three cards fold under one closed group that counts its files.
  const group = page.locator('details.wt-card-group[data-disclosure="group:tools:e1"]');
  assert.equal(await group.evaluate((el) => (el as HTMLDetailsElement).open), false);
  assert.match(await group.locator('> summary').innerText(), /Edited 2 files · Ran a command[\s\S]*2 files[\s\S]*\+3[\s\S]*-2/);
  assert.equal(await group.locator('.wt-group-body .wt-change-card').count(), 2);
  assert.equal(await group.locator('.wt-group-body .wt-command-card').count(), 1);
  await group.locator('> summary').click();
  // Diffs from before the latest turn start closed.
  assert.deepEqual(await group.locator('details.wt-change-file').evaluateAll((els) => els.map((el) => (el as HTMLDetailsElement).open)), [false, false]);

  // The command line is highlighted as shell.
  const cmd = page.locator('details.wt-command[data-disclosure="c1"] .wt-cmd-text');
  await page.waitForFunction(() => document.querySelector('details.wt-command[data-disclosure="c1"] .wt-cmd-text [class*="tok-"]'));
  assert.equal(await cmd.innerText(), 'grep -rn "TODO" docs | wc -l');

  // The earlier turn ends on its summary, under its last message; the latest turn's opens its small diff.
  const summary = page.locator('.wt-entry[data-entry="m1"] .wt-turn-changes');
  assert.match(await summary.locator('.wt-turn-head').innerText(), /Changed 2 files[\s\S]*\+3[\s\S]*-2/);
  assert.deepEqual(await summary.locator('.wt-turn-file .wt-change-path').allTextContents(), ['…/droid-office/docs/a.md', '…/droid-office/docs/b.md']);
  await summary.locator('.wt-turn-review').click();
  assert.deepEqual(await page.evaluate(() => (window as any).openedChanges), ['worker-1']);
  await summary.locator('button.wt-change-path', { hasText: 'docs/b.md' }).click();
  const preview = page.locator('.modal.wt-file-modal');
  await preview.locator('.wt-file-lines').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('details.wt-change-file[data-disclosure*="docs/c.md"]').evaluate((el) => (el as HTMLDetailsElement).open), true);
  assert.equal(await page.locator('.wt-turn-changes').count(), 2);

  // While the latest turn runs it has no summary yet.
  await push(presentThread(entries, true));
  assert.equal(await page.locator('.wt-turn-changes').count(), 1);

  await page.evaluate(() => (window as any).thread.dispose());
  assert.deepEqual(errors, []);
});

test('a created Markdown, HTML or picture file offers Preview and Send to Whiteboard', { skip: chromium }, async (t) => {
  const { page, errors } = await mountV3Thread(t);
  const create = (id: string, seq: number, file: string, content: string): ThreadEntry => ({
    id,
    seq,
    role: 'assistant',
    kind: 'tool',
    name: 'Create',
    input: JSON.stringify({ file_path: `/Users/nik/repos/droid-office/${file}`, content }),
    output: `Created ${file}`,
  });
  const entries: ThreadEntry[] = [
    { id: 'u1', seq: 1, role: 'user', kind: 'text', text: 'Write the report' },
    create('c1', 2, 'docs/report.md', '# Report\n\nAll good.\n'),
    create('c2', 3, 'src/report.ts', 'export const report = 1;\n'),
    create('c3', 4, 'docs/chart.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'),
  ];
  await page.evaluate(
    ({ entries, rows }) => {
      (window as any).receive({ t: 'thread.snapshot', workerId: 'worker-1', request: 'push', push: true, sessionId: 'session-1', entries, hasMore: false, presentation: { version: 1, rows } });
    },
    { entries, rows: presentThread(entries, false) },
  );

  // Only the Markdown and the picture are deliverables; the source file isn't.
  assert.equal(await page.locator('.wt-change-actions').count(), 2);
  const report = page.locator('.wt-change-deliverable', { has: page.locator('details[data-disclosure*="docs/report.md"]') });
  await report.locator('.wt-change-board').click();
  assert.deepEqual(await page.evaluate(() => (window as any).sentToBoard), [['worker-1', 'docs/report.md']]);
  await report.locator('.wt-change-preview').click();
  const preview = page.locator('.modal.wt-file-modal');
  await preview.locator('.wt-file-lines').waitFor();
  assert.equal(await preview.locator('.wt-file-modal-title').textContent(), 'docs/report.md');
  await page.keyboard.press('Escape');

  // A picture previews as itself, read as bytes from the workspace.
  await page.route('http://office.test/api/thread/file?**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  await page.evaluate(() => document.head.append(Object.assign(document.createElement('base'), { href: 'http://office.test/' })));
  await page
    .locator('.wt-change-deliverable', { has: page.locator('details[data-disclosure*="docs/chart.svg"]') })
    .locator('.wt-change-preview')
    .click();
  const src = await page.locator('.modal.wt-file-modal img.wt-file-image').getAttribute('src');
  assert.match(src ?? '', /\/api\/thread\/file\?.*path=docs%2Fchart\.svg.*raw=image/);
  await page.locator('.modal.wt-file-modal').getByText('4 × 4').waitFor();
  await page.keyboard.press('Escape');

  await page.evaluate(() => (window as any).thread.dispose());
  assert.deepEqual(errors, []);
});
