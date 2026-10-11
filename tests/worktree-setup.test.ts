import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_COPY, describeSetup, detectSetup, parsePatterns, parseSetupFile, resolveSetup } from '../src/shared/worktree-setup.js';
import { copiesFrom, inspectCheckout, readOverride, setupState, setupStep, writeOverride, writePlan, writeSetupScript } from '../src/server/worktree-setup.js';
import { setupFailedNote, setupLine } from '../src/server/workers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

/** A checkout with one commit, removed after the test. */
function checkout(t: { after(fn: () => void): void }, files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'droid-office-setup-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'README.md'), 'hi');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

test('the lockfiles at the root say what to install, one JavaScript package manager at most', () => {
  const has =
    (...files: string[]) =>
    (f: string) =>
      files.includes(f);
  assert.equal(detectSetup(has()), undefined);
  assert.deepEqual(detectSetup(has('package-lock.json')), { setup: 'npm ci', from: ['package-lock.json'] });
  assert.deepEqual(detectSetup(has('pnpm-lock.yaml', 'package-lock.json')), { setup: 'pnpm install --frozen-lockfile', from: ['pnpm-lock.yaml'] });
  assert.deepEqual(detectSetup(has('bun.lockb', 'uv.lock', 'Gemfile.lock')), { setup: 'bun install --frozen-lockfile && uv sync && bundle install', from: ['bun.lockb', 'uv.lock', 'Gemfile.lock'] });
});

test('the setup file is read leniently and refused with a reason when it is wrong', () => {
  assert.deepEqual(parseSetupFile('{"worktree":{"setup":" npm ci ","copy":["/.env"," ","# no","/.env"]}}'), { setup: 'npm ci', copy: ['/.env'] });
  assert.deepEqual(parseSetupFile('{"other":1}'), {});
  assert.match((parseSetupFile('{') as { error: string }).error, /isn't valid JSON/);
  assert.match((parseSetupFile('{"worktree":[]}') as { error: string }).error, /should be an object/);
  assert.match((parseSetupFile('{"worktree":{"setup":1}}') as { error: string }).error, /setup.*string/);
  assert.match((parseSetupFile('{"worktree":{"copy":"x"}}') as { error: string }).error, /copy.*list/);
  assert.deepEqual(parsePatterns('# comment\n/.env\n\n  /config/local.json  \r\n'), ['/.env', '/config/local.json']);
});

test("the floor's own setup wins, then the repository's, then the lockfiles and the .env files", () => {
  const detected = { setup: 'npm ci', from: ['package-lock.json'] };
  assert.deepEqual(resolveSetup({ detected }), { setup: 'npm ci', setupFrom: 'detected', detectedFrom: ['package-lock.json'], copy: [...DEFAULT_COPY], copyFrom: 'default' });
  assert.deepEqual(resolveSetup({ detected, repo: { setup: 'make setup' }, include: ['/.env.local'] }), { setup: 'make setup', setupFrom: 'repo', copy: ['/.env.local'], copyFrom: 'repo' });
  // An empty command in the repository's file means nothing runs, not the detected install.
  assert.deepEqual(resolveSetup({ detected, repo: { setup: '', copy: ['/a'] }, include: ['/b'] }), { setup: undefined, setupFrom: 'none', copy: ['/a', '/b'], copyFrom: 'repo' });
  assert.deepEqual(resolveSetup({ detected, repo: { setup: 'make' }, override: { setup: ' ', copy: [] } }), { setup: undefined, setupFrom: 'none', copy: [], copyFrom: 'office' });
  assert.deepEqual(resolveSetup({ override: { setup: 'yarn', copy: ['/x'] } }), { setup: 'yarn', setupFrom: 'office', copy: ['/x'], copyFrom: 'office' });
  assert.equal(describeSetup(resolveSetup({ detected })), 'runs `npm ci` (from package-lock.json) and copies `/.env`, `/.env.*` from the checkout');
  assert.equal(
    describeSetup(resolveSetup({ override: { setup: '', copy: [] } }), (c) => `"${c}"`),
    'runs no setup command and copies nothing',
  );
});

test("a floor's setup state reads the checkout and its own override, which can be put back", (t) => {
  const dir = checkout(t, { 'package-lock.json': '{}', '.droid-office.json': '{"worktree":{"setup":"npm ci && npm run gen"}}', '.worktreeinclude': '/.env.local\n' });
  const data = path.join(dir, '.droid-office');
  mkdirSync(data);
  const state = setupState('f1', dir, data, true);
  assert.equal(state.floor, 'f1');
  assert.deepEqual(state.repo, { setup: 'npm ci && npm run gen' });
  assert.deepEqual(state.include, ['/.env.local']);
  assert.deepEqual(state.detected, { setup: 'npm ci', from: ['package-lock.json'] });
  assert.deepEqual(state.resolved, { setup: 'npm ci && npm run gen', setupFrom: 'repo', copy: ['/.env.local'], copyFrom: 'repo' });
  writeOverride(data, { setup: 'pnpm i', copy: ['/.env'], by: 'Nik', at: 5 });
  assert.deepEqual(readOverride(data), { setup: 'pnpm i', copy: ['/.env'], by: 'Nik', at: 5 });
  assert.equal(setupState('f1', dir, data, true).resolved.setup, 'pnpm i');
  writeOverride(data, null);
  assert.equal(readOverride(data), undefined);
  writeFileSync(path.join(dir, '.droid-office.json'), '{ nope');
  const broken = setupState('f1', dir, data, true);
  assert.match(broken.repo!.error!, /isn't valid JSON/);
  // A file that can't be read counts as none: the lockfile's install, and .worktreeinclude still counts.
  assert.equal(broken.resolved.setup, 'npm ci');
  assert.deepEqual(broken.resolved.copy, ['/.env.local']);
  assert.deepEqual(inspectCheckout(path.join(dir, 'missing')), {});
});

test('a worktree with nothing to run or copy gets no setup step', (t) => {
  const dir = checkout(t);
  const data = path.join(dir, '.droid-office');
  mkdirSync(data);
  writeFileSync(path.join(data, 'workers.json'), '[]');
  assert.equal(setupStep(dir, dir, data), undefined);
  writeFileSync(path.join(dir, '.env'), 'A=1');
  assert.deepEqual(copiesFrom(dir, [...DEFAULT_COPY]), ['.env']);
  assert.deepEqual(setupStep(dir, dir, data, 'web'), { dir, root: dir, label: 'web', copy: [...DEFAULT_COPY] });
  writeOverride(data, { setup: 'make', copy: [] });
  assert.deepEqual(setupStep(dir, dir, data), { dir, root: dir, setup: 'make', from: 'set for this floor in Settings', copy: [] });
  assert.deepEqual(copiesFrom(path.join(dir, 'missing'), ['/x']), []);
});

test('the setup line runs the script with the office’s node, then the agent in its place', () => {
  const base = { node: '/n/node', script: "/d/it's.cjs", plan: '/d/p.json', args: ['--settings', 'a b'], asNode: { sh: 'ELECTRON_RUN_AS_NODE=1 ', cmd: 'set "ELECTRON_RUN_AS_NODE=1" & ' } };
  assert.equal(setupLine({ ...base, file: '/bin/droid', quoteFile: true, cmd: false }), `ELECTRON_RUN_AS_NODE=1 '/n/node' '/d/it'\\''s.cjs' '/d/p.json'; exec '/bin/droid' '--settings' 'a b'`);
  assert.equal(setupLine({ ...base, file: 'droid', quoteFile: false, cmd: false, asNode: { sh: '', cmd: '' } }), `'/n/node' '/d/it'\\''s.cjs' '/d/p.json'; exec droid '--settings' 'a b'`);
  assert.equal(setupLine({ ...base, file: 'C:\\droid.exe', quoteFile: true, cmd: true }), `set "ELECTRON_RUN_AS_NODE=1" & "/n/node" "/d/it's.cjs" "/d/p.json" & "C:\\droid.exe" "--settings" "a b"`);
  assert.match(setupFailedNote('`npm ci` (exit 1)'), /setting up your new worktree failed \(`npm ci` \(exit 1\)\), so its dependencies may be missing\. Run the setup again yourself if your task needs them\.$/);
  assert.match(setupFailedNote('`npm ci` (exit 1)', ' npm ERR! missing\n'), /The end of its output:\n\n```\nnpm ERR! missing\n```$/);
});

/** Runs the setup script on `steps` with a hook server listening, and returns what it printed and reported. */
async function runScript(t: { after(fn: () => void): void }, steps: unknown[]) {
  const data = realpathSync(mkdtempSync(path.join(tmpdir(), 'droid-office-setup-data-')));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const script = writeSetupScript(data);
  const plan = writePlan(data, 'w1', steps as never);
  const reports: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      assert.equal(url.pathname, '/hooks/droid');
      assert.equal(url.searchParams.get('worker'), 'w1');
      assert.equal(url.searchParams.get('event'), 'WorktreeSetup');
      assert.equal(req.headers.authorization, 'Bearer tok');
      reports.push(JSON.parse(body));
      res.end('{}');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const env = { ...process.env, DROID_OFFICE_HOOK_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, DROID_OFFICE_WORKER_ID: 'w1', DROID_OFFICE_HOOK_TOKEN: 'tok' };
  const child = spawn(process.execPath, [script, plan], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  const code = await new Promise<number | null>((done) => child.on('exit', done));
  return { code, out, reports, plan };
}

test('the setup script copies the untracked files asked for, runs the command there, and says how it went', async (t) => {
  const root = checkout(t, { '.gitignore': 'node_modules/\n.env*\n!.env.example\n', '.env.example': 'A=' });
  writeFileSync(path.join(root, '.env'), 'A=1');
  writeFileSync(path.join(root, '.env.local'), 'B=2');
  mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'dep', '.env'), 'nested');
  mkdirSync(path.join(root, '.droid-office'));
  writeFileSync(path.join(root, '.droid-office', '.env'), 'office');
  const wt = path.join(root, '.droid-office', 'worktrees', 'w1');
  git(root, 'worktree', 'add', '-q', '-b', 'office/w1', wt);
  // Already there in the worktree: never overwritten.
  writeFileSync(path.join(wt, '.env.local'), 'mine');
  const record = `require('fs').writeFileSync('ran.json', JSON.stringify({ root: process.env.DROID_OFFICE_ROOT_PATH, wt: process.env.DROID_OFFICE_WORKTREE_PATH, electron: process.env.ELECTRON_RUN_AS_NODE ?? null }))`;
  const { code, out, reports, plan } = await runScript(t, [{ dir: wt, root, setup: `"${process.execPath}" -e "${record}"`, from: 'from .droid-office.json', copy: [...DEFAULT_COPY] }]);
  assert.equal(code, 0);
  assert.equal(readFileSync(path.join(wt, '.env'), 'utf8'), 'A=1');
  assert.equal(readFileSync(path.join(wt, '.env.local'), 'utf8'), 'mine');
  assert.ok(!existsSync(path.join(wt, 'node_modules')), 'anchored patterns only match at the root');
  assert.deepEqual(JSON.parse(readFileSync(path.join(wt, 'ran.json'), 'utf8')), { root, wt, electron: null });
  assert.match(out, /Copied from the checkout: \.env\b/);
  assert.match(out, /Setting up this worktree:.*\(from \.droid-office\.json\)/);
  assert.match(out, /✓ Set up in/);
  assert.equal(reports.length, 2);
  assert.equal(reports[0].phase, 'start');
  assert.equal(reports[0].hook_event_name, 'WorktreeSetup');
  assert.equal((reports[0].commands as string[]).length, 1);
  assert.deepEqual(reports[1], { hook_event_name: 'WorktreeSetup', phase: 'done', failed: [] });
  assert.ok(!existsSync(plan), 'the plan is used once');
});

test('a failing setup is reported and the script still exits 0 so the agent starts', async (t) => {
  const root = checkout(t);
  const wt = path.join(root, 'wt');
  git(root, 'worktree', 'add', '-q', '-b', 'office/w2', wt);
  const command = `"${process.execPath}" -e "console.log('first'); console.error('\\x1b[31mno lockfile\\x1b[0m'); process.exit(3)"`;
  const { code, out, reports } = await runScript(t, [{ dir: wt, root, label: 'api', setup: command, copy: [] }]);
  assert.equal(code, 0);
  assert.match(out, /api/);
  assert.match(out, /no lockfile/);
  assert.match(out, /Setup failed with exit code 3/);
  // What it printed goes to the office too, without the colors.
  assert.deepEqual((reports[1].failed as unknown[])[0], { command, code: 3, label: 'api', output: 'first\nno lockfile' });
});
