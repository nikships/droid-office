import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Building, isCheckout, originRepo, type FloorDef } from '../src/server/building.js';
import { projectInfo } from '../src/server/floor.js';
import { NoBoard } from '../src/server/forge.js';
import { floorPipelines } from '../src/server/pipelines.js';
import { Worktrees } from '../src/server/worktrees.js';

/** A workspace folder with a checkout in it, a plain folder inside that checkout, and folders outside the workspace. */
function machine(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-plain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'office', '.droid-office');
  mkdirSync(dataDir, { recursive: true });
  const work = path.join(root, 'repos');
  const api = path.join(work, 'api');
  mkdirSync(api, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', api]);
  execFileSync('git', ['-C', api, 'remote', 'add', 'origin', 'git@github.com:acme/api.git']);
  const docs = path.join(api, 'docs');
  mkdirSync(docs);
  const notes = path.join(root, 'Documents', 'notes');
  mkdirSync(notes, { recursive: true });
  return { root, dataDir, work, api, docs, notes, building: new Building(dataDir, work) };
}

test('a plain folder anywhere on the machine becomes a floor with no repository, named after its folder', (t) => {
  const { building, notes, docs, dataDir } = machine(t);
  const r = building.add(notes, 'Sam');
  assert.equal(typeof r, 'object', String(r));
  assert.equal((r as FloorDef).dir, notes);
  assert.equal((r as FloorDef).name, 'notes');
  assert.equal((r as FloorDef).repo, undefined);
  // Inside a checkout, it's still a plain folder: the checkout's origin isn't its repository.
  const inner = building.add(docs, 'Sam');
  assert.equal(typeof inner, 'object', String(inner));
  assert.equal((inner as FloorDef).repo, undefined);
  assert.equal(originRepo(docs), undefined);
  assert.match(building.add(notes, 'Sam') as string, /already has a floor/);
  assert.deepEqual(
    new Building(dataDir, path.dirname(notes))
      .list()
      .map((d) => d.dir)
      .sort(),
    [docs, notes].sort(),
  );
});

test("a plain folder can't be a file, the top of the disk, or inside the office's data; a checkout still has to be in the workspace", (t) => {
  const { building, root, notes } = machine(t);
  const file = path.join(notes, 'todo.md');
  writeFileSync(file, '- milk\n');
  assert.match(building.add(file, 'Sam') as string, /isn't a folder/);
  assert.match(building.add('/', 'Sam') as string, /top of the disk/);
  const inData = path.join(root, 'proj', '.droid-office', 'worktrees', 'x');
  mkdirSync(inData, { recursive: true });
  assert.match(building.add(inData, 'Sam') as string, /office's own data/);
  const stray = path.join(root, 'elsewhere', 'stray');
  mkdirSync(stray, { recursive: true });
  execFileSync('git', ['init', '-q', stray]);
  assert.match(building.add(stray, 'Sam') as string, /isn't in the workspace folder/);
  assert.match(building.add('', 'Sam') as string, /browse to a folder/);
});

test('the folder browser lists the folders in a folder, hidden ones left out, and which are checkouts', async (t) => {
  const { building, work, api, root } = machine(t);
  mkdirSync(path.join(work, '.cache'));
  mkdirSync(path.join(work, 'Zeta'));
  mkdirSync(path.join(work, 'beta'));
  writeFileSync(path.join(work, 'README.md'), 'hi');
  symlinkSync(api, path.join(work, 'api-link'));
  const top = await building.folders();
  assert.equal(top.dir, work, 'it starts in the workspace folder');
  assert.equal(top.parent, root);
  assert.equal(top.git, false);
  assert.deepEqual(
    top.folders.map((f) => [f.name, f.git]),
    [
      ['api', true],
      ['api-link', true],
      ['beta', false],
      ['Zeta', false],
    ],
  );
  const inside = await building.folders(api);
  assert.equal(inside.git, true);
  assert.deepEqual(
    inside.folders.map((f) => f.name),
    ['docs'],
  );
  assert.match((await building.folders(path.join(work, 'missing'))).error ?? '', /can't be opened/);
  const relative = await building.folders('relative');
  assert.match(relative.error ?? '', /full path/);
  assert.equal(relative.dir, work, 'a path that goes nowhere leaves the browser on an absolute folder');
  assert.equal(inside.blocked, undefined);
  const stray = path.join(root, 'elsewhere', 'stray');
  mkdirSync(stray, { recursive: true });
  execFileSync('git', ['init', '-q', stray]);
  assert.match((await building.folders(stray)).blocked ?? '', /isn't in the workspace folder/, "a checkout outside the workspace can't be added");
  assert.equal((await building.folders(path.dirname(stray))).blocked, undefined, 'a plain folder outside it can');
  assert.equal((await building.folders('/')).parent, undefined);
});

test("git in a plain folder's floor stops at the folder instead of answering for the checkout around it", (t) => {
  const { api, docs } = machine(t);
  execFileSync('git', ['-C', api, 'commit', '-q', '--allow-empty', '-m', 'first'], { env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } });
  assert.equal(isCheckout(api), true);
  assert.equal(isCheckout(docs), false);
  assert.equal(new Worktrees(docs).currentBranch(), 'main', 'without the ceiling git finds the checkout around it');
  const plain = new Worktrees(docs, true);
  assert.equal(plain.currentBranch(), undefined);
  assert.equal(plain.commonDir(), undefined);
  const info = projectInfo(docs, 'docs', 'droid', [], 'github', true);
  assert.equal(info.branch, undefined);
  assert.equal(info.remote, undefined);
  assert.equal(projectInfo(api, 'api', 'droid', []).branch, 'main');
});

test("a plain folder's board and pipelines are empty and refuse what needs a repository, without running gh", async () => {
  const board = new NoBoard();
  await board.refresh();
  assert.deepEqual(board.issues.items, []);
  assert.deepEqual(board.pulls.items, []);
  assert.equal(board.issues.loading, false);
  assert.match((await board.merge()) ?? '', /plain folder/);
  assert.match((await board.close()) ?? '', /plain folder/);
  assert.match((await board.claim()) ?? '', /plain folder/);
  assert.match((await board.comment()).error ?? '', /plain folder/);
  assert.match((await board.setLabels()).error ?? '', /plain folder/);
  assert.deepEqual(await board.repoLabels(), []);
  assert.equal(await board.viewer(), '');
  assert.equal(await board.findOpenPull(), undefined);
  for (const call of [() => board.repoInfo(), () => board.pullDetail(), () => board.pullDiff(), () => board.issueDetail(), () => board.createPull()]) await assert.rejects(call(), /plain folder/);
  board.stop();

  const states: unknown[] = [];
  const pipelines = floorPipelines('/nowhere', 'github', undefined, { state: (s) => states.push(s), finished: () => assert.fail('no runs') }, true);
  await pipelines.refresh();
  assert.deepEqual(pipelines.state.runs, []);
  assert.deepEqual(pipelines.state.workflows, []);
  assert.equal(pipelines.state.error, undefined);
  assert.deepEqual((await pipelines.detail(1)).jobs, []);
  assert.match((await pipelines.run('ci.yml', 'main', {})) ?? '', /./);
});
