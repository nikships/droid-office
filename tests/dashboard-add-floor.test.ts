import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { filterWorkspaceRepos, isTypedFloorPath, resolveFloorTarget, shortenFloorPath } from '../src/client/ui/add-floor.js';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';
import { MAX_FLOORS } from '../src/shared/floors.js';
import type { ClientMsg, RepoChoice, ServerMsg } from '../src/shared/protocol.js';

function gitRepo(dir: string, remote?: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'initial'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
  });
  if (remote) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
}

async function startFixtureOffice(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'companion-add-floor-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  // Stub external forge CLIs so floor arrival refreshes never hit the network or hang on auth.
  writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'glab'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prevPath ?? ''}`;

  const home = path.join(root, 'home');
  const workspace = path.join(home, 'Workspace');
  const extraWorkspace = path.join(home, 'OtherWork');
  const apiRepo = path.join(workspace, 'api');
  const webRepo = path.join(workspace, 'web');
  const outsideRepo = path.join(extraWorkspace, 'mobile');
  const plainDir = path.join(home, 'Documents', 'runbooks');
  mkdirSync(plainDir, { recursive: true });
  gitRepo(apiRepo, 'https://github.com/acme/api.git');
  gitRepo(webRepo, 'https://github.com/acme/web.git');
  gitRepo(outsideRepo, 'https://github.com/acme/mobile.git');
  writeFileSync(path.join(plainDir, 'notes.txt'), 'hello\n');
  symlinkSync(apiRepo, path.join(workspace, 'api-alias'));

  // Simulate a real Droid Office git worktree inside .droid-office/worktrees (contains a .git file).
  const worktreeDir = path.join(apiRepo, '.droid-office', 'worktrees', 'pixel-wt');
  mkdirSync(worktreeDir, { recursive: true });
  writeFileSync(path.join(worktreeDir, '.git'), `gitdir: ${path.join(apiRepo, '.git')}\n`);

  const missingAgent = path.join(root, 'no-droid-agent');
  const cfg = loadConfig(['--home', home, '--projects', workspace, apiRepo, '--weather', 'clear', '--host', '127.0.0.1', '--agent', missingAgent]);
  cfg.port = 0;
  cfg.homeFloor = home;
  cfg.remoteMcp = false;
  const server = await startServer(cfg);
  const port = (server.server.address() as AddressInfo).port;
  let stopped = false;
  t.after(async () => {
    process.env.PATH = prevPath;
    if (stopped) return;
    stopped = true;
    const closing = once(server.server, 'close');
    await server.shutdown();
    server.server.closeAllConnections();
    await closing;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, home, workspace, extraWorkspace, apiRepo, webRepo, outsideRepo, plainDir, worktreeDir, server, base: `http://127.0.0.1:${port}` };
}

function connectSocket(t: TestContext, base: string, query: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?${query}`, { origin: base, headers });
  t.after(() => ws.terminate());
  const messages: ServerMsg[] = [];
  const listeners = new Set<() => void>();
  ws.on('message', (data) => {
    messages.push(JSON.parse(String(data)));
    for (const fn of listeners) fn();
  });
  function wait<T extends ServerMsg['t']>(type: T, predicate: (msg: Extract<ServerMsg, { t: T }>) => boolean = () => true): Promise<Extract<ServerMsg, { t: T }>> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = messages.find((m): m is Extract<ServerMsg, { t: T }> => m.t === type && predicate(m as Extract<ServerMsg, { t: T }>));
        if (!found) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(found);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 8000);
      listeners.add(check);
      check();
    });
  }
  const send = (msg: ClientMsg) => ws.send(JSON.stringify(msg));
  return { ws, messages, wait, send };
}

test('pure add-floor path and target helpers handle home shortening, search filtering and Enter disambiguation', () => {
  assert.equal(isTypedFloorPath('/Users/nik/repos/app'), true);
  assert.equal(isTypedFloorPath('  ~/Workspace/app '), true);
  assert.equal(isTypedFloorPath('~'), true);
  assert.equal(isTypedFloorPath('acme/app'), false);
  assert.equal(isTypedFloorPath(''), false);

  const floors = [{ dir: '/Users/nik', home: true }, { dir: '/Users/nik/Workspace/api' }];
  assert.equal(shortenFloorPath('/Users/nik/Workspace/web', '~/Workspace', floors), '~/Workspace/web');
  assert.equal(shortenFloorPath('/Users/nik', '~/Workspace', floors), '~');
  // Without a Home floor (--no-home), home can still be inferred from a ~/… projectsDir.
  assert.equal(shortenFloorPath('/Users/nik/Workspace/web', '~/Workspace', []), '~/Workspace/web');
  assert.equal(shortenFloorPath('/opt/shared/repo', '~/Workspace', floors), '/opt/shared/repo');

  const repos: RepoChoice[] = [
    { name: 'acme/api', dir: '/Users/nik/Workspace/api', repo: 'acme/api', forge: 'github' },
    { name: 'acme/web', dir: '/Users/nik/Workspace/web', repo: 'acme/web', forge: 'github' },
    { name: 'notes-git', dir: '/Users/nik/Workspace/notes-git' },
  ];
  assert.equal(filterWorkspaceRepos(repos, '~/workspace/web', '~/Workspace', floors).length, 1);
  assert.equal(filterWorkspaceRepos(repos, 'ACME', '~/Workspace', floors).length, 2);

  // Explicit row selection wins over filter text.
  assert.equal(resolveFloorTarget({ filter: 'acme', selected: '/Users/nik/Workspace/web', repos, floors }), '/Users/nik/Workspace/web');
  // Typed paths submit on button click and Enter alike.
  assert.equal(resolveFloorTarget({ filter: '~/Documents/notes', selected: null, repos, floors }), '~/Documents/notes');
  // Ambiguous search text does not enable button click, nor guess on Enter when multiple unadded repos match.
  const multiUnadded = [repos[1], repos[2]];
  assert.equal(resolveFloorTarget({ filter: 'Workspace', selected: null, repos: multiUnadded, floors, onEnter: true }), undefined);
  // A single unadded match resolves on Enter even when another matching repo is already a floor.
  assert.equal(resolveFloorTarget({ filter: 'acme', selected: null, repos, floors, onEnter: true }), '/Users/nik/Workspace/web');
  // Non-matching relative input submits on Enter so the server returns its validation message.
  assert.equal(resolveFloorTarget({ filter: 'relative/folder', selected: null, repos, floors, onEnter: true }), 'relative/folder');
});

test('paired web companion lists repos, browses folders, validates errors, and adds git & plain floors live across clients', async (t) => {
  const fx = await startFixtureOffice(t);

  // An invalid device token is rejected even on loopback.
  const rejected = new WebSocket(`${fx.base.replace('http:', 'ws:')}/ws?client=dashboard&d=forged-token`, { origin: fx.base });
  rejected.on('error', () => {});
  const closeEvent = await new Promise<number>((resolve) => {
    rejected.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    rejected.on('close', (code) => resolve(code));
  });
  rejected.terminate();
  assert.ok(closeEvent === 401 || closeEvent === 4401, `expected unauthorized close, got ${closeEvent}`);

  // Pair a browser companion via the real /api/mobile/pair endpoint.
  const pairRes = await fetch(`${fx.base}/api/mobile/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: fx.base },
    body: JSON.stringify({ device: 'Chrome on Mac', kind: 'browser' }),
  });
  assert.equal(pairRes.status, 200);
  const paired = (await pairRes.json()) as { token: string };

  const desktop = connectSocket(t, fx.base, 'name=Desktop');
  const companion = connectSocket(t, fx.base, `client=dashboard&d=${encodeURIComponent(paired.token)}`);
  await desktop.wait('welcome');
  const welcome = await companion.wait('welcome');
  assert.deepEqual(
    welcome.floors.map((f) => f.name),
    ['api', 'Home'],
  );

  // 1. Discover workspace checkouts.
  companion.send({ t: 'floor.repos', refresh: true });
  const reposMsg = await companion.wait('floor.repos');
  assert.equal(reposMsg.error, undefined);
  assert.ok(reposMsg.repos.some((r) => r.dir === fx.webRepo && r.name === 'acme/web' && r.forge === 'github'));

  // 2. Browse folders: git outside workspace and .droid-office worktrees report blocked reasons.
  companion.send({ t: 'floor.folders', request: 'outside', dir: fx.outsideRepo });
  const outsideFolder = await companion.wait('floor.folders', (m) => m.request === 'outside');
  assert.equal(outsideFolder.git, true);
  assert.match(outsideFolder.blocked ?? '', /isn't in the workspace folder/);

  companion.send({ t: 'floor.folders', request: 'worktree', dir: fx.worktreeDir });
  const wtFolder = await companion.wait('floor.folders', (m) => m.request === 'worktree');
  assert.match(wtFolder.blocked ?? '', /office's own data/);

  // 3. Validation errors return both floor.added.error and action.result(ok: false).
  const invalidCases: [string, RegExp][] = [
    [path.join(fx.workspace, 'does-not-exist'), /doesn't exist/],
    [path.join(fx.plainDir, 'notes.txt'), /isn't a folder/],
    [fx.apiRepo, /already has a floor/],
    [path.join(fx.workspace, 'api-alias'), /already has a floor/],
    [fx.outsideRepo, /isn't in the workspace folder/],
    [fx.worktreeDir, /office's own data/],
    ['relative/repo', /full path/],
  ];
  for (const [idx, [badDir, pattern]] of invalidCases.entries()) {
    companion.messages.length = 0;
    const reqId = `bad-${idx}`;
    companion.send({ t: 'floor.add', dir: badDir, requestId: reqId });
    const [added, receipt] = await Promise.all([companion.wait('floor.added', (m) => m.dir === badDir), companion.wait('action.result', (m) => m.requestId === reqId)]);
    assert.equal(added.floor, undefined);
    assert.match(added.error ?? '', pattern);
    assert.equal(receipt.ok, false);
    assert.match(receipt.error ?? '', pattern);
  }

  // 4. Add a git checkout floor: `floors` arrives BEFORE `floor.added` so switching has the floor in store.floors immediately.
  companion.messages.length = 0;
  desktop.messages.length = 0;
  companion.send({ t: 'floor.add', dir: fx.webRepo, requestId: 'add-web' });
  const addedWeb = await companion.wait('floor.added', (m) => m.dir === fx.webRepo);
  const webReceipt = await companion.wait('action.result', (m) => m.requestId === 'add-web');
  assert.equal(webReceipt.ok, true);
  assert.ok(addedWeb.floor, addedWeb.error);

  const floorsIdx = companion.messages.findIndex((m) => m.t === 'floors' && m.floors.some((f) => f.id === addedWeb.floor));
  const addedIdx = companion.messages.findIndex((m) => m.t === 'floor.added' && m.floor === addedWeb.floor);
  assert.ok(floorsIdx >= 0 && floorsIdx < addedIdx, 'updated floors list is broadcast before floor.added');

  const desktopFloors = await desktop.wait('floors', (m) => m.floors.some((f) => f.id === addedWeb.floor));
  assert.equal(desktopFloors.floors.find((f) => f.id === addedWeb.floor)?.dir, fx.webRepo);

  // Switch companion to the newly added git floor.
  companion.send({ t: 'floor.go', floor: addedWeb.floor });
  const enteredWeb = await companion.wait('floor.enter', (m) => m.floor === addedWeb.floor);
  assert.equal(enteredWeb.project?.branch, 'main');

  // 5. Add a plain non-git folder outside the workspace.
  companion.send({ t: 'floor.add', dir: fx.plainDir, requestId: 'add-plain' });
  const addedPlain = await companion.wait('floor.added', (m) => m.dir === fx.plainDir);
  assert.ok(addedPlain.floor, addedPlain.error);
  const withPlain = await desktop.wait('floors', (m) => m.floors.some((f) => f.id === addedPlain.floor));
  const plainInfo = withPlain.floors.find((f) => f.id === addedPlain.floor);
  assert.equal(plainInfo?.plain, true);
  assert.equal(plainInfo?.branch, undefined);

  // 6. Change workspace folder via floor.projectsDir with receipt validation, then add the repo there.
  companion.send({ t: 'floor.projectsDir', dir: path.join(fx.root, 'missing-workspace'), requestId: 'bad-ws' });
  const badWs = await companion.wait('action.result', (m) => m.requestId === 'bad-ws');
  assert.equal(badWs.ok, false);
  assert.match(badWs.error ?? '', /isn't a folder/);

  companion.send({ t: 'floor.projectsDir', dir: fx.extraWorkspace, requestId: 'good-ws' });
  assert.equal((await companion.wait('action.result', (m) => m.requestId === 'good-ws')).ok, true);
  await companion.wait('projectsDir', (m) => m.state.custom === true);

  companion.send({ t: 'floor.add', dir: fx.outsideRepo, requestId: 'add-mobile' });
  const addedMobile = await companion.wait('floor.added', (m) => m.dir === fx.outsideRepo);
  assert.ok(addedMobile.floor, addedMobile.error);

  // Saved in floors.json across restarts.
  const savedIds = (JSON.parse(readFileSync(path.join(fx.apiRepo, '.droid-office', 'floors.json'), 'utf8')) as { id: string }[]).map((f) => f.id);
  assert.ok(savedIds.includes(addedWeb.floor));
  assert.ok(savedIds.includes(addedPlain.floor));
  assert.ok(savedIds.includes(addedMobile.floor));
});

const chromium = browserStatus();

test('web companion UI drives the full Add floor flow live against the real server without a reload', { skip: chromium.installed ? false : `Chromium is not installed in ${chromium.path}` }, async (t) => {
  const fx = await startFixtureOffice(t);
  const browser = await launchBrowser();
  const context = await newIsolatedContext(browser);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  try {
    page.setDefaultTimeout(6000);
    await page.setViewportSize({ width: 1280, height: 800 });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(`${fx.base}/dashboard`);
    await page.locator('.dash-floor-chip.on').waitFor();
    // A wide window gives every floor a full tab, in building order, and needs no "+N more".
    assert.deepEqual(await page.locator('.dash-floor-chip:not([hidden]) .dash-floor-name').allInnerTexts(), ['api', 'Home']);
    assert.equal(await page.locator('.dash-quiet-bay').isHidden(), true, 'every floor has a tab, so no "+N more"');
    assert.equal(await page.locator('.dash-git-pill').textContent(), 'api/main');
    // The current floor's tab shows its number, name and status; its branch lives in the git pill and the tooltip.
    const currentTab = page.locator('.dash-floor-chip.on');
    assert.deepEqual(await currentTab.locator(':scope > span').allTextContents(), ['01', 'api', 'empty']);
    assert.match((await currentTab.getAttribute('title')) ?? '', / · ⎇ main · /);

    // Open the Add floor dialog from the top bar.
    await page.getByRole('button', { name: 'Add floor' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add floor' });
    await dialog.waitFor();
    await dialog.locator('.list-row.repo').first().waitFor();

    const input = dialog.getByRole('textbox', { name: 'Project or folder path' });
    const submit = dialog.getByRole('button', { name: 'Add floor' });

    // Error case 1: nonexistent path stays in the dialog and shows the server's error.
    const mainErr = dialog.locator('.add-status > .note.bad');
    await input.fill(path.join(fx.workspace, 'missing-checkout'));
    await submit.click();
    await mainErr.waitFor();
    assert.match(await mainErr.innerText(), /doesn't exist/);
    assert.equal(await dialog.isVisible(), true);

    // Error case 2: duplicate floor path explains that it already has a floor.
    await input.fill(fx.apiRepo);
    await submit.click();
    await page.waitForFunction(() => document.querySelector('.add-floor-modal .add-status > .note.bad')?.textContent?.includes('already has a floor'));

    // Change folder inline error + Escape cancels only the inline folder editor, keeping the dialog open.
    await dialog.getByRole('button', { name: 'Change folder' }).click();
    const wsInput = dialog.getByRole('textbox', { name: 'Workspace folder' });
    await wsInput.fill(path.join(fx.root, 'no-such-workspace'));
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.locator('.dir-pick .note.bad').waitFor();
    assert.match(await dialog.locator('.dir-pick .note.bad').innerText(), /isn't a folder/);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.locator('.dir-pick').isHidden(), true, 'first Escape closes inline folder editor');
    assert.equal(await dialog.isVisible(), true, 'Add floor dialog stays open');

    // Filter and keyboard-select an unadded git checkout (`web`), then add it.
    await input.fill('web');
    await input.press('ArrowDown');
    assert.equal(await dialog.locator('.list-row.repo.on').count(), 1);
    await submit.click();

    // Dialog closes and the new floor's tab becomes active without reload, beside the others that still fit.
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('.dash-floor-chip.on .dash-floor-name')?.textContent === 'web');
    assert.deepEqual(await page.locator('.dash-floor-chip:not([hidden]) .dash-floor-name').allInnerTexts(), ['api', 'Home', 'web']);
    assert.doesNotMatch((await page.locator('.dash-floor-chip.on').textContent()) ?? '', /main/, 'the newly current tab shows no branch either');
    assert.equal(await page.locator('.dash-side-title').innerText(), 'web');
    assert.equal(await page.locator('.dash-side-sub').innerText(), 'main');

    // Browse flow: add a plain folder (`runbooks`) via the stacked folder browser modal.
    await page.getByRole('button', { name: 'Add floor' }).click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Browse…' }).click();
    const browserDialog = page.getByRole('dialog', { name: 'Pick a folder' });
    await browserDialog.waitFor();
    const folderInput = browserDialog.getByRole('textbox', { name: 'Folder' });
    await folderInput.fill(fx.plainDir);
    await folderInput.press('Enter');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.folder-browser footer .btn.primary')?.disabled);
    await browserDialog.getByRole('button', { name: 'Add this folder' }).click();

    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('.dash-floor-chip.on .dash-floor-name')?.textContent === 'runbooks');
    assert.deepEqual(await page.locator('.dash-floor-chip:not([hidden]) .dash-floor-name').allInnerTexts(), ['api', 'Home', 'web', 'runbooks']);
    assert.equal(await page.locator('.dash-git-pill').textContent(), 'runbooks· plain');
    assert.match(await page.locator('.dash-side-sub').innerText(), /Not a git repository/);

    // ⌘ K opens the switcher even when every floor has a tab (no "+N more" button), listing all floors.
    await page.keyboard.press('Meta+k');
    const quietPop = page.getByRole('dialog', { name: 'Switch floor' });
    await quietPop.waitFor();
    assert.deepEqual(await quietPop.locator('.dash-quiet-repo').allInnerTexts(), ['api', 'Home', 'web', 'runbooks']);
    const quietSearch = quietPop.getByRole('searchbox', { name: 'Search floors' });
    await quietSearch.fill('runbooks');
    assert.deepEqual(await quietPop.locator('.dash-quiet-repo').allInnerTexts(), ['runbooks']);
    await page.keyboard.press('Escape');
    assert.equal(await quietPop.isVisible(), true, 'first Escape clears query');
    assert.deepEqual(await quietPop.locator('.dash-quiet-repo').allInnerTexts(), ['api', 'Home', 'web', 'runbooks']);
    await page.keyboard.press('Escape');
    assert.equal(await quietPop.isHidden(), true, 'second Escape closes switcher');

    // ⌘K opens the floor switcher from the workspace and Enter switches to the selected empty floor (`web`), then ⇧⌘1 jumps to floor 1 (`api`).
    await page.keyboard.press('Meta+k');
    await quietPop.waitFor();
    await quietSearch.fill('web');
    await quietSearch.press('Enter');
    await page.waitForFunction(() => document.querySelector('.dash-floor-chip.on .dash-floor-name')?.textContent === 'web');
    await page.keyboard.press('Shift+Meta+Digit1');
    await page.waitForFunction(() => document.querySelector('.dash-floor-chip.on .dash-floor-name')?.textContent === 'api');

    // Clicking an already-open floor row inside Add floor switches directly to that floor and closes the modal.
    await page.getByRole('button', { name: 'Add floor' }).click();
    await dialog.waitFor();
    await dialog.locator(`.list-row.repo[data-repo-dir="${fx.webRepo}"]`).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('.dash-floor-chip.on .dash-floor-name')?.textContent === 'web');

    assert.equal(MAX_FLOORS, 16);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
    await closeBrowser();
  }
});
