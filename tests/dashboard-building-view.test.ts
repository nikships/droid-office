import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();
test('all-workers directory filters, opens cross-floor workers, and keeps focus through live changes', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const bundle = buildSync({
    stdin: { contents: "export { createBuildingView } from './dashboard-building-view';", resolveDir: fileURLToPath(new URL('../src/client', import.meta.url)) },
    bundle: true,
    format: 'iife',
    globalName: 'BuildingUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent('<!doctype html><body class="dashboard"><div id="dashboard"></div></body>');
  await page.addStyleTag({ content: readFileSync(new URL('../src/client/style.css', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: 'window.__name = (fn) => fn;' });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const w = window as any;
    w.opened = [];
    w.hired = 0;
    w.back = 0;
    w.view = w.BuildingUI.createBuildingView({ open: (row: any) => w.opened.push([row.worker.id, row.floorId]), workspace: () => w.back++, hire: () => w.hired++ });
    document.querySelector('#dashboard')!.append(w.view.el);
    w.view.el.hidden = false;
    w.state = {
      live: true,
      canHire: true,
      floors: [
        { id: 'office', name: 'droid-office' },
        { id: 'tools', name: 'Tools' },
      ],
      rows: [
        {
          worker: { id: 'pixel', name: 'Pixel', kind: 'agent', color: '#a8d354', status: 'working', acked: false, task: { name: 'Document AWS Infrastructure' }, model: 'custom:droidproxy:gpt-6.1-sol' },
          kind: 'desk',
          floorId: 'office',
          floorName: 'droid-office',
          repo: 'nikships/droid-office',
          depth: 0,
        },
        {
          worker: {
            id: 'nibble',
            name: 'Nibble',
            kind: 'agent',
            color: '#4dbed4',
            status: 'needs_input',
            acked: false,
            lead: 'pixel',
            activity: 'Verifying DNS & networking',
            model: 'custom:droidproxy:gpt-6.1-sol',
            todos: { done: 3, total: 5, current: 'Write the tests' },
          },
          kind: 'desk',
          floorId: 'tools',
          floorName: 'Tools',
          repo: 'nikships/tools',
          leadName: 'Pixel',
          depth: 1,
        },
        { worker: { id: 'dot', name: 'Dot', kind: 'agent', color: '#d395ce', status: 'done', acked: false, title: 'Rerunning messaging collector' }, kind: 'desk', floorId: 'office', floorName: 'droid-office', depth: 0 },
        { worker: { id: 'widget', name: 'Widget', kind: 'agent', color: '#ce95ce', status: 'offline', acked: true, title: 'Reviewing logs & cost data' }, kind: 'desk', floorId: 'tools', floorName: 'Tools', depth: 0 },
        { worker: { id: 'bot', name: 'Remote bot', kind: 'agent', status: 'needs_input', remote: true }, kind: 'bot', floorId: '__mission__', floorName: 'Mission Control', depth: 0 },
      ],
    };
    w.paint = () => w.view.update(w.state);
    w.paint();
  });
  const rows = page.locator('.dash-building-worker');
  assert.equal(await rows.count(), 5);
  assert.match(await page.locator('.dash-building-result').innerText(), /5 of 5 workers · Live updates/);
  assert.match((await page.locator('[data-worker=nibble]').getAttribute('aria-label')) ?? '', /Tools, Needs you, subworker of Pixel/);
  assert.equal(await page.locator('[data-worker=nibble] .dash-row-todos').innerText(), '3/5');
  assert.equal(await page.locator('[data-worker=nibble]').evaluate((el) => el.classList.contains('is-subworker')), true);
  await page.getByRole('button', { name: 'Needs you, 1', exact: true }).click();
  assert.equal(await rows.count(), 1, 'external bot status is not an owner question');
  assert.equal(await rows.getAttribute('data-worker'), 'nibble');
  assert.equal(await rows.evaluate((el) => el.classList.contains('is-subworker')), false, 'a filtered-out lead leaves no orphan indent');
  await rows.click();
  assert.deepEqual(await page.evaluate(() => (window as any).opened), [['nibble', 'tools']]);
  await page.getByRole('button', { name: 'All workers, 5', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter workers by floor' }).selectOption('tools');
  assert.equal(await rows.count(), 2);
  await page.getByRole('searchbox', { name: 'Search all workers' }).fill('networking');
  assert.equal(await rows.count(), 1);
  await page.getByRole('searchbox').fill('no-such-worker');
  assert.equal(await page.getByText('No matching workers', { exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  assert.equal(await rows.count(), 5);
  assert.equal(await page.getByRole('searchbox').evaluate((el) => el === document.activeElement), true);
  await page.getByRole('searchbox').fill('Pixel');
  await page.getByRole('searchbox').press('Escape');
  assert.equal(await page.getByRole('searchbox').inputValue(), '');
  assert.equal(await rows.count(), 5);
  await page.locator('[data-worker=nibble]').focus();
  await page.evaluate(() => {
    const w = window as any;
    w.focusedRow = document.activeElement;
    w.state.rows[1].worker.activity = 'Waiting for the DNS answer';
    w.paint();
  });
  assert.equal(await page.evaluate(() => document.activeElement === (window as any).focusedRow), true);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('[data-worker=dot]').evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press('Home');
  assert.equal(await page.locator('[data-worker=pixel]').evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press('End');
  assert.equal(await page.locator('[data-worker=bot]').evaluate((el) => el === document.activeElement), true);
  for (const status of ['working', 'done', 'needs_input']) {
    await page.evaluate((status) => {
      const w = window as any;
      w.state.rows[4].worker.status = status;
      w.paint();
    }, status);
    assert.equal(await page.locator('[data-worker=bot] .dash-dot').getAttribute('data-status'), status, 'bot status-only ticks refresh the dot');
  }
  await page.evaluate(() => {
    const w = window as any;
    w.state.rows[0].worker.name = `<script>alert("unsafe")</script>${'Long name '.repeat(20)}`;
    w.state.rows[0].worker.worktree = { branch: `office/${'long-branch-'.repeat(30)}` };
    w.paint();
  });
  assert.equal(await page.locator('.dash-building script').count(), 0);
  for (const [width, height] of [
    [1440, 900],
    [1024, 700],
  ]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal overflow at ${width}`);
    assert.equal(await page.getByRole('button', { name: 'Hire Droid', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('combobox').isVisible(), true);
  }
  await page.evaluate(() => {
    const w = window as any;
    w.state.live = false;
    w.paint();
  });
  assert.equal(await rows.first().isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Hire Droid', exact: true }).isDisabled(), true);
  assert.match(await page.locator('.dash-building-result').innerText(), /Reconnecting, actions unavailable/);
  await page.getByRole('button', { name: 'Done, 1', exact: true }).click();
  assert.equal(await rows.count(), 1, 'the cached directory remains filterable offline');
  await page.evaluate(() => {
    const w = window as any;
    w.state.live = true;
    w.state.rows = w.state.rows.filter((r: any) => r.worker.id !== 'dot');
    w.paint();
  });
  assert.equal(await page.getByText('No matching workers', { exact: true }).isVisible(), true, 'departed workers leave the current filter');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('combobox').selectOption('tools');
  await page.evaluate(() => {
    const w = window as any;
    w.state.floors = w.state.floors.filter((f: any) => f.id !== 'tools');
    w.state.rows = [];
    w.paint();
  });
  assert.equal(await page.getByRole('combobox').inputValue(), '');
  assert.equal(await page.getByText('No workers in the building yet', { exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Hire Droid', exact: true }).last().click();
  assert.equal(await page.evaluate(() => (window as any).hired), 1);
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  assert.equal(await page.evaluate(() => (window as any).back), 1);
  await page.evaluate(() => {
    const w = window as any;
    w.state.mission = { orchestrator: { settings: { on: true }, blocked: 'Droid is not signed in', team: [] }, bots: [] };
    w.state.rows = [{ worker: { id: 'orchestrator', name: 'Orchestrator', kind: 'agent', status: 'idle' }, kind: 'orchestrator', floorId: '__mission__', floorName: 'Mission Control', depth: 0 }];
    w.paint();
  });
  assert.equal(await page.locator('[data-status=blocked]').innerText(), 'Blocked');
  assert.match(await rows.first().innerText(), /Droid is not signed in/);
  await page.evaluate(() => {
    const w = window as any;
    w.state.rows = ['first', 'second'].map((id) => ({ worker: { id, name: id, kind: 'agent', status: 'working' }, kind: 'desk', floorId: 'office', floorName: 'droid-office', depth: 0 }));
    w.paint();
  });
  await page.getByRole('button', { name: 'Working, 2', exact: true }).click();
  await page.locator('[data-worker=first]').focus();
  await page.evaluate(() => {
    const w = window as any;
    w.state.rows[0].worker.status = 'done';
    w.paint();
  });
  assert.equal(await page.locator('[data-worker=second]').evaluate((el) => el === document.activeElement), true, 'a filtered-out row hands focus to its nearest neighbor');
  await page.evaluate(() => {
    const w = window as any;
    w.state.rows[1].worker.status = 'done';
    w.paint();
  });
  assert.equal(await page.getByRole('searchbox').evaluate((el) => el === document.activeElement), true, 'the last result hands focus back to search');
  await page.getByRole('button', { name: 'All workers, 2', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    w.state.canHire = false;
    w.state.rows = [];
    w.paint();
  });
  assert.equal(await page.getByRole('button', { name: 'Hire Droid', exact: true }).count(), 2);
  for (const button of await page.getByRole('button', { name: 'Hire Droid', exact: true }).all()) assert.equal(await button.isDisabled(), true, 'Rooftop has no current floor to hire on');
  assert.equal(await page.getByText('Choose a project floor above to hire a Droid.', { exact: true }).isVisible(), true);
  assert.deepEqual(errors, []);
});
