import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Building } from '../src/server/building.js';
import { startServer } from '../src/server/server.js';
import { FinderDispatch, finderAuthorized, finderPathAllowed, finderTargets, handleFinder, publishFinder } from '../src/server/finder.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-finder-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'state');
  const home = path.join(root, 'home');
  mkdirSync(dataDir);
  mkdirSync(home);
  const building = new Building(dataDir, path.join(root, 'workspace'));
  const homeDef = building.ensureHome(home)!;
  const repo = (name: string, gitFile = false) => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    if (gitFile) writeFileSync(path.join(dir, '.git'), 'gitdir: ../git-dir');
    else mkdirSync(path.join(dir, '.git'));
    return dir;
  };
  const calls: { floor: string; text: string; model?: string }[] = [];
  let failure: string | undefined;
  const options = {
    building,
    dataDir,
    officeUrl: () => 'http://127.0.0.1:4601/',
    models: async () => ({ models: [{ id: 'gpt-6.1-sol', label: 'GPT' }], defaultModel: 'gpt-6.1-sol' }),
    dispatch: (def: { id: string }, text: string, model?: string) => {
      calls.push({ floor: def.id, text, model });
      return failure ?? { leadId: 'abc123', model };
    },
    changed: () => {},
  };
  const finder = new FinderDispatch(options);
  return { root, home, homeDef, dataDir, building, repo, calls, options, finder, fail: (value?: string) => (failure = value) };
}

test('Finder canonicalizes files and symlinks and finds directory and worktree git roots', async (t) => {
  const f = fixture(t);
  const root = f.repo('project');
  const nested = path.join(root, 'src');
  mkdirSync(nested);
  const file = path.join(nested, 'auth.ts');
  writeFileSync(file, '');
  const alias = path.join(f.root, 'alias');
  symlinkSync(root, alias, 'dir');
  assert.deepEqual(await finderTargets([`${root}/`, file, path.join(alias, 'src/auth.ts')]), [{ repoRoot: root, paths: [root, file] }]);
  const worktree = f.repo('worktree', true);
  assert.equal((await finderTargets([worktree]))[0].repoRoot, worktree);
});

test('Finder registers outside the workspace in the one registry, reuses aliases, and persists names and choices', async (t) => {
  const f = fixture(t);
  const first = f.repo('one/repository');
  const second = f.repo('two/repository');
  const groups = await f.finder.resolve([first, second]);
  assert.equal(groups[0].floorName, 'repository');
  assert.equal(groups[1].floorName, 'repository — two');
  assert.equal(groups[0].isNewFloor, true);
  const again = await f.finder.resolve([first]);
  assert.equal(again[0].floorId, groups[0].floorId);
  assert.equal(again[0].isNewFloor, false);
  const alias = path.join(f.root, 'aliased');
  symlinkSync(first, alias, 'dir');
  assert.equal((await f.finder.resolve([alias]))[0].floorId, groups[0].floorId);
  const restored = new Building(f.dataDir, f.root);
  assert.equal(restored.list().length, 3);
  assert.equal(restored.list()[1].dir, first);
});

test('non-git selections all use the existing Home floor without adding a floor', async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, 'notes.txt');
  writeFileSync(file, 'note');
  const groups = await f.finder.resolve([file, f.home]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].floorId, f.homeDef.id);
  assert.equal(groups[0].repoRoot, null);
  assert.deepEqual(groups[0].paths, [file, f.home]);
  assert.equal(f.building.list().length, 1);
});

test('too many roots or malformed selections are refused before any floors are registered', async (t) => {
  const f = fixture(t);
  const roots = Array.from({ length: 6 }, (_, i) => f.repo(`repo-${i}`));
  await assert.rejects(f.finder.resolve(roots), /at most 5/);
  for (const paths of [[], null, ['relative'], [42], Array(101).fill(f.home), [path.join(f.root, 'gone')]]) await assert.rejects(f.finder.resolve(paths));
  assert.equal(f.building.list().length, 1);
});

test('system, library, trash, office data and symlinks into them are ineligible', async (t) => {
  const f = fixture(t);
  for (const blocked of ['/System/x', '/Library/x', '/Network/remote', '/', path.join(f.home, 'Library/x'), path.join(f.home, '.Trash/x'), path.join(f.root, '.droid-office/x'), '/Volumes/disk/Backups.backupdb/x']) {
    assert.equal(finderPathAllowed(blocked, f.home), false, blocked);
  }
  assert.equal(finderPathAllowed('/Users/someone/project'), true);
  const blocked = path.join(f.root, '.droid-office');
  mkdirSync(blocked);
  const alias = path.join(f.root, 'safe-looking');
  symlinkSync(blocked, alias, 'dir');
  await assert.rejects(f.finder.resolve([alias]), /not eligible/);
});

test('failed registry persistence never creates a transient successful floor', async (t) => {
  const f = fixture(t);
  const repo = f.repo('cannot-save');
  mkdirSync(path.join(f.dataDir, 'floors.json.tmp'));
  await assert.rejects(f.finder.resolve([repo]), /Couldn't save/);
  assert.equal(f.building.list().length, 1);
});

test('dispatch is plain user text and quoted selected paths, reuses Team lead adapter, and produces thread links', async (t) => {
  const f = fixture(t);
  const repo = f.repo('project');
  const request = { paths: [repo], prompt: 'Investigate authentication', model: 'gpt-6.1-sol', requestId: 'request-00000000001' };
  const result = await f.finder.dispatch(request);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(f.calls, [{ floor: 'project', text: `Investigate authentication\n\n${JSON.stringify(repo)}`, model: 'gpt-6.1-sol' }]);
  assert.equal(result.dispatches[0].deepLink, 'droid-office://thread/abc123?floor=project');
  assert.equal(result.dispatches[0].threadUrl, 'http://127.0.0.1:4601/dashboard#worker=abc123&floor=project&view=thread');
  const again = new FinderDispatch(f.options);
  assert.equal((await again.resolve([repo]))[0].model, 'gpt-6.1-sol');
  assert.equal(JSON.parse(readFileSync(path.join(f.dataDir, 'finder.json'), 'utf8')).project, 'gpt-6.1-sol');
});

test('concurrent retries dispatch once and changed payloads cannot reuse a receipt', async (t) => {
  const f = fixture(t);
  const request = { paths: [f.repo('project')], prompt: 'Inspect', requestId: 'request-00000000002' };
  const [a, b] = await Promise.all([f.finder.dispatch(request), f.finder.dispatch(request)]);
  assert.deepEqual(a, b);
  assert.equal(f.calls.length, 1);
  assert.throws(() => f.finder.dispatch({ ...request, prompt: 'Different' }), /already used/);
});

test('partial failures report each floor and retries never send a successful task again', async (t) => {
  const f = fixture(t);
  const a = f.repo('a');
  const b = f.repo('b');
  f.options.dispatch = (def, text, model) => {
    f.calls.push({ floor: def.id, text, model });
    return def.id === 'a' ? { leadId: 'abc123' } : 'Team lead is busy';
  };
  const finder = new FinderDispatch(f.options);
  const request = { paths: [a, b], prompt: 'Inspect', requestId: 'request-00000000003' };
  const result = await finder.dispatch(request);
  assert.equal(result.dispatches.length, 1);
  assert.deepEqual(result.errors, [{ floorId: 'b', error: 'Team lead is busy' }]);
  assert.deepEqual(await finder.dispatch(request), result);
  assert.equal(f.calls.length, 2);
});

test('shutdown cancels in-flight resolution without registering floors or sending tasks', async (t) => {
  const f = fixture(t);
  const paths = [f.repo('project')];
  const resolving = f.finder.resolve(paths);
  f.finder.stop();
  await assert.rejects(resolving, /shutting down/);
  assert.throws(() => f.finder.dispatch({ paths, prompt: 'Inspect', requestId: 'request-00000000006' }), /shutting down/);
  assert.equal(f.building.list().length, 1);
  assert.equal(f.calls.length, 0);
});

test('invalid prompts, ids and unlisted models do not dispatch or create floors', async (t) => {
  const f = fixture(t);
  const request = { paths: [f.repo('project')], prompt: 'Inspect', requestId: 'request-00000000004' };
  for (const changes of [{ prompt: '' }, { prompt: 'a'.repeat(16001) }, { prompt: 'hello\x1b[201~' }, { prompt: '\x03' }, { requestId: 'short' }, { model: 1 }]) {
    assert.throws(() => f.finder.dispatch({ ...request, ...changes }));
  }
  await assert.rejects(f.finder.dispatch({ ...request, model: 'not-in-catalogue' }), /no longer available/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.building.list().length, 1);
});

test('Finder authentication requires the token, IPv4 loopback host and peer, and a non-browser request', () => {
  const token = 'a'.repeat(64);
  const request = (headers = {}, address = '127.0.0.1') => ({ headers: { host: '127.0.0.1:1234', 'x-droid-office-token': token, ...headers }, socket: { remoteAddress: address } }) as IncomingMessage;
  assert.equal(finderAuthorized(request(), token), true);
  assert.equal(finderAuthorized(request(), undefined), false);
  for (const headers of [{ host: 'evil.example' }, { origin: 'http://127.0.0.1:1234' }, { 'sec-fetch-site': 'cross-site' }, { 'x-droid-office-token': 'b'.repeat(64) }, { 'x-droid-office-token': '' }])
    assert.equal(finderAuthorized(request(headers), token), false);
  assert.equal(finderAuthorized(request({}, '192.168.1.1'), token), false);
  assert.equal(finderAuthorized(request({}, '::ffff:127.0.0.1'), token), false);
});

test('native bridge validation never propagates helper output or secret-bearing errors', async (t) => {
  const f = fixture(t);
  const bridge = path.join(f.root, 'bridge');
  const url = 'http://127.0.0.1:1234/';
  writeFileSync(bridge, `#!/bin/sh\nprintf '%s' '{"token":"${'a'.repeat(64)}","url":"${url}"}'\n`, { mode: 0o700 });
  assert.equal(await publishFinder(bridge, url), 'a'.repeat(64));
  await assert.rejects(publishFinder(bridge, 'http://127.0.0.1:9999/'), /signed shared Keychain/);
  writeFileSync(bridge, "#!/bin/sh\nprintf '%s' 'private material'\nexit 1\n", { mode: 0o700 });
  await assert.rejects(publishFinder(bridge, url), (err: Error) => !err.message.includes('private material'));
});

test('HTTP resolve and dispatch authenticate independently, reject malformed input and return receipts', async (t) => {
  const f = fixture(t);
  const token = 'b'.repeat(64);
  const server = http.createServer((req, res) => void handleFinder(req, res, new URL(req.url!, 'http://127.0.0.1').pathname, token, f.finder, f.options.models));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { 'x-droid-office-token': token, 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/finder/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/finder/status`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/finder/resolve`, { headers })).status, 405);
  assert.equal((await fetch(`${base}/api/finder/resolve`, { method: 'POST', headers, body: 'not-json' })).status, 400);
  assert.equal((await fetch(`${base}/api/finder/resolve`, { method: 'POST', headers: { 'x-droid-office-token': token }, body: '{}' })).status, 415);
  const repo = f.repo('project');
  const resolve = await fetch(`${base}/api/finder/resolve`, { method: 'POST', headers, body: JSON.stringify({ paths: [repo] }) });
  assert.equal(resolve.status, 200);
  assert.equal((await resolve.json()).groups[0].repoRoot, repo);
  const dispatch = await fetch(`${base}/api/finder/dispatch`, { method: 'POST', headers, body: JSON.stringify({ paths: [repo], prompt: 'Inspect', requestId: 'request-00000000005' }) });
  assert.equal(dispatch.status, 200);
  assert.equal((await dispatch.json()).dispatches.length, 1);
});

test('the office mounts Finder exclusively on its IPv4 loopback listener and shares the Home floor', async (t) => {
  const f = fixture(t);
  const bridge = path.join(f.root, 'keychain-protocol');
  const token = 'c'.repeat(64);
  writeFileSync(bridge, `#!/bin/sh\nprintf '{"token":"${token}","url":"%s"}' "$2"\n`, { mode: 0o700 });
  const office = await startServer({
    dir: f.home,
    dataDir: f.dataDir,
    projectsDir: f.root,
    homeFloor: f.home,
    host: '0.0.0.0',
    port: 0,
    agentCmd: process.execPath,
    agentArgs: [],
    trustProxy: false,
    weather: 'clear',
    finderBridge: bridge,
  });
  t.after(() => office.shutdown());
  const address = office.server.address() as { port: number };
  const headers = { 'x-droid-office-token': token, 'content-type': 'application/json' };
  const hook = `http://127.0.0.1:${office.hookPort}`;
  assert.equal((await fetch(`${hook}/api/finder/status`, { headers })).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/finder/status`, { headers })).status, 404);
  assert.equal((await fetch(`${hook}/api/finder/status`, { headers: { ...headers, origin: hook } })).status, 401);
  const response = await fetch(`${hook}/api/finder/resolve`, { method: 'POST', headers, body: JSON.stringify({ paths: [f.home] }) });
  assert.equal(response.status, 200);
  const resolved = await response.json();
  assert.equal(resolved.groups[0].floorId, f.homeDef.id);
  assert.equal(office.floors().length, 1);
});
