import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import headless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import type { IBuffer, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import { TerminalPathLinksAddon, terminalLogicalLine } from '../src/client/ui/terminal-path-links.js';
import { threadFileImageUrl, threadFilePreviewUrl } from '../src/client/ui/file-preview.js';
import { createFloorHttp, isFloorHttpPath } from '../src/server/server-runtime/floor-http.js';
import { openTerminalFile, REVEAL_ONLY_EXTENSIONS, revealOnly, TerminalPaths } from '../src/server/terminal-paths.js';
import { OFFICE_SHELL_ID } from '../src/shared/office-shell.js';
import { parseTerminalPathRefs, terminalPathRef } from '../src/shared/path-links.js';

async function fixture(t: TestContext) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-path-links-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = await realpath(temp);
  const checkout = path.join(root, 'checkout');
  const floor = path.join(root, 'floor');
  for (const dir of [checkout, floor, path.join(checkout, 'src'), path.join(checkout, 'tests')]) await mkdir(dir, { recursive: true });
  for (const file of ['src/server.ts', 'tests/tailnet-https.test.ts', 'src/duplicate.ts', 'tests/duplicate.ts', 'src/a b.ts']) await writeFile(path.join(checkout, file), `// ${file}\n`);
  await writeFile(path.join(floor, 'README.md'), 'floor\n');
  await writeFile(path.join(root, 'outside.txt'), 'outside\n');
  return { root, checkout, floor };
}

test('terminal candidates parse tool output, quotes, punctuation, locations and explicit machine paths', () => {
  const text = 'Create tests/tailnet-https.test.ts, Edit (src/server/server.ts:120:3). "src/a b.ts" `./foo.ts:9`; ../lib/bar.ts ~/notes.txt /tmp/test.txt foo.test.ts';
  const refs = parseTerminalPathRefs(text);
  assert.deepEqual(
    refs.map(({ path: file, line, column }) => ({ path: file, line, column })),
    [
      { path: 'tests/tailnet-https.test.ts', line: undefined, column: undefined },
      { path: 'src/server/server.ts', line: 120, column: 3 },
      { path: 'src/a b.ts', line: undefined, column: undefined },
      { path: './foo.ts', line: 9, column: undefined },
      { path: '../lib/bar.ts', line: undefined, column: undefined },
      { path: '~/notes.txt', line: undefined, column: undefined },
      { path: '/tmp/test.txt', line: undefined, column: undefined },
      { path: 'foo.test.ts', line: undefined, column: undefined },
    ],
  );
  for (const ref of refs) assert.equal(text.slice(ref.start, ref.end), ref.raw);
  assert.deepEqual(terminalPathRef('"src/a b.ts":12:4'), { path: 'src/a b.ts', line: 12, column: 4 });
  assert.deepEqual(terminalPathRef('src/server.ts:10-20'), { path: 'src/server.ts', line: 10, endLine: 20 });
  assert.deepEqual(terminalPathRef('src/server.ts#L10-L20'), { path: 'src/server.ts', line: 10, endLine: 20 });
  assert.deepEqual(terminalPathRef('file:///tmp/a%20b.ts:7'), { path: '/tmp/a b.ts', line: 7 });
  for (const value of ['hello', 'https://example.com/src/a.ts', 'file://other/tmp/a.ts', 'foo.ts:0', 'foo.ts:2:0', 'foo.ts:10-5', 'foo.ts:99999999999999999999', 'javascript:bad.ts', '@scope/pkg', '//host/file.ts'])
    assert.equal(terminalPathRef(value), null, value);
  assert.equal(parseTerminalPathRefs('https://github.com/a/b.ts mailto:me@test.ts').length, 0);
  assert.deepEqual(parseTerminalPathRefs('src/a.ts:12:3:const value = true')[0], { path: 'src/a.ts', line: 12, column: 3, raw: 'src/a.ts:12:3', start: 0, end: 13 });
  assert.deepEqual(
    parseTerminalPathRefs('at render (src/app/(auth)/[id]/page.tsx:42:5) and [guide](docs/guide/how-it-works.md#L10-L15). "src/a b.ts":12:4').map(({ path: file, line, column, endLine, raw }) => ({
      path: file,
      line,
      column,
      endLine,
      raw,
    })),
    [
      { path: 'src/app/(auth)/[id]/page.tsx', line: 42, column: 5, endLine: undefined, raw: 'src/app/(auth)/[id]/page.tsx:42:5' },
      { path: 'docs/guide/how-it-works.md', line: 10, column: undefined, endLine: 15, raw: 'docs/guide/how-it-works.md#L10-L15' },
      { path: 'src/a b.ts', line: 12, column: 4, endLine: undefined, raw: '"src/a b.ts":12:4' },
    ],
  );
});

test('terminal soft wraps preserve path and cell ranges after emoji and CJK', async (t) => {
  const term = new headless.Terminal({ cols: 24, rows: 8, allowProposedApi: true });
  term.loadAddon(new unicode11.Unicode11Addon());
  term.unicode.activeVersion = '11';
  t.after(() => term.dispose());
  await new Promise<void>((resolve) => term.write('好 😀 Create tests/tailnet-https.test.ts:120:3\r\n', resolve));
  const first = terminalLogicalLine(term.buffer.active as IBuffer, 1, term.cols);
  const second = terminalLogicalLine(term.buffer.active as IBuffer, 2, term.cols);
  assert.equal(first.text, '好 😀 Create tests/tailnet-https.test.ts:120:3');
  assert.equal(second.text, first.text);
  const [ref] = parseTerminalPathRefs(first.text);
  assert.equal(ref.path, 'tests/tailnet-https.test.ts');
  assert.deepEqual(first.cells[ref.start], { x: 14, y: 1 });
  assert.equal(first.cells[ref.end - 1].y, 2);
});

test('terminal resolution prefers worktree, falls back to floor, uses live cwd and unique tracked basenames', async (t) => {
  const { root, checkout, floor } = await fixture(t);
  let scans = 0;
  const resolver = new TerminalPaths(
    async () => {
      scans++;
      return ['src/server.ts', 'src/duplicate.ts', 'tests/duplicate.ts'];
    },
    async () => path.join(checkout, 'src'),
    root,
  );
  const paths = await resolver.resolve(
    { cwd: checkout, root: floor, pid: 1 },
    ['tests/tailnet-https.test.ts:120:3', 'server.ts', 'duplicate.ts', 'README.md', './server.ts', '../tests/tailnet-https.test.ts', 'missing.ts', '../../outside.txt', `${root}/outside.txt`, '~/outside.txt'],
    { allowOutside: true },
  );
  assert.deepEqual(paths[0], { path: path.join(checkout, 'tests/tailnet-https.test.ts'), displayPath: 'tests/tailnet-https.test.ts', line: 120, column: 3 });
  assert.equal(paths[1]?.path, path.join(checkout, 'src/server.ts'));
  assert.equal(paths[2]?.path, path.join(checkout, 'src/duplicate.ts')); // exact file in live cwd wins
  assert.equal(paths[3]?.path, path.join(floor, 'README.md'));
  assert.equal(paths[4]?.path, path.join(checkout, 'src/server.ts'));
  assert.equal(paths[5]?.path, path.join(checkout, 'tests/tailnet-https.test.ts'));
  assert.equal(paths[6], null);
  assert.equal(paths[7], null);
  assert.equal(paths[8]?.path, path.join(root, 'outside.txt'));
  assert.equal(paths[9]?.path, path.join(root, 'outside.txt'));
  assert.deepEqual(await resolver.resolve({ cwd: checkout, root: floor, pid: 1 }, [`${root}/outside.txt`, '~/outside.txt', `${checkout}/src/server.ts`]), [
    null,
    null,
    { path: path.join(checkout, 'src/server.ts'), displayPath: 'src/server.ts' },
  ]);
  const noLive = new TerminalPaths(
    async () => {
      scans++;
      return ['src/server.ts', 'src/duplicate.ts', 'tests/duplicate.ts'];
    },
    async () => root,
  );
  const unique = await noLive.resolve({ cwd: checkout, root: floor }, ['server.ts', 'duplicate.ts', 'outside.txt', 'b/src/server.ts', 'a/missing.ts']);
  assert.equal(unique[0]?.path, path.join(checkout, 'src/server.ts'));
  assert.equal(unique[1], null);
  assert.equal(unique[2], null);
  assert.equal(unique[3]?.path, path.join(checkout, 'src/server.ts'));
  assert.equal(unique[4], null);
  const before = scans;
  await noLive.resolve({ cwd: checkout, root: floor }, ['server.ts', 'missing.ts']);
  assert.equal(scans, before);
});

test('relative paths cannot escape allowed roots through traversal or symlinks', async (t) => {
  const { root, checkout, floor } = await fixture(t);
  await symlink(path.join(root, 'outside.txt'), path.join(checkout, 'src/escape.txt'));
  await symlink(root, path.join(checkout, 'external'));
  const resolver = new TerminalPaths(
    async () => [],
    async () => root,
  );
  const candidates = ['../outside.txt', 'src/escape.txt', 'external/outside.txt', './missing.ts', 'src/', `${checkout}/src/escape.txt`];
  // An absolute symlink out of the checkout is confined like any other outside path unless the caller allows it.
  assert.deepEqual(await resolver.resolve({ cwd: checkout, root: floor }, candidates), [null, null, null, null, null, null]);
  const owner = await resolver.resolve({ cwd: checkout, root: floor }, candidates, { allowOutside: true });
  assert.deepEqual(owner.slice(0, 5), [null, null, null, null, null]);
  assert.equal(owner[5]?.path, path.join(root, 'outside.txt'));
});

test('paired-device resolution never reaches home secrets outside the roots; the owner page still can', async (t) => {
  const { root, checkout, floor } = await fixture(t);
  const home = path.join(root, 'home');
  await mkdir(path.join(home, '.factory'), { recursive: true });
  await writeFile(path.join(home, '.factory/settings.json'), '{"apiKey":"secret"}');
  const resolver = new TerminalPaths(
    async () => [],
    async () => undefined,
    home,
  );
  const candidates = ['~/.factory/settings.json', path.join(home, '.factory/settings.json'), 'src/server.ts'];
  const device = await resolver.resolve({ cwd: checkout, root: floor }, candidates);
  assert.deepEqual(device.slice(0, 2), [null, null]);
  assert.equal(device[2]?.path, path.join(checkout, 'src/server.ts'));
  const owner = await resolver.resolve({ cwd: checkout, root: floor }, candidates, { allowOutside: true });
  assert.equal(owner[0]?.path, path.join(home, '.factory/settings.json'));
  assert.equal(owner[1]?.path, path.join(home, '.factory/settings.json'));
});

test('opening a terminal path reveals anything LaunchServices could execute and opens documents', async (t) => {
  const { root } = await fixture(t);
  const files: Record<string, number> = { 'run.command': 0o644, 'build.sh': 0o755, 'site.webloc': 0o644, 'Tool.JAR': 0o644, 'notes.ts': 0o644, 'README.md': 0o644 };
  for (const [name, mode] of Object.entries(files)) {
    await writeFile(path.join(root, name), 'x\n');
    await chmod(path.join(root, name), mode);
  }
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
  };
  for (const name of ['run.command', 'build.sh', 'site.webloc', 'Tool.JAR']) {
    const file = path.join(root, name);
    assert.deepEqual(await openTerminalFile(file, run), { revealed: true }, name);
    assert.deepEqual(calls.at(-1), ['-R', '--', file], name);
  }
  for (const name of ['notes.ts', 'README.md']) {
    const file = path.join(root, name);
    assert.deepEqual(await openTerminalFile(file, run), { revealed: false }, name);
    assert.deepEqual(calls.at(-1), ['--', file], name);
  }
  for (const ext of ['.command', '.tool', '.terminal', '.workflow', '.action', '.scpt', '.applescript', '.scptd', '.jar', '.pkg', '.mpkg', '.app', '.webloc', '.inetloc', '.fileloc']) assert.ok(REVEAL_ONLY_EXTENSIONS.has(ext), ext);
  // A file that vanished before the check is never handed to the default app.
  assert.equal(await revealOnly(path.join(root, 'gone.txt')), true);
});

test('terminal link provider batches and caches a logical line, exposes only existing files and requires modifier', async (t) => {
  const term = new headless.Terminal({ cols: 50, rows: 8, allowProposedApi: true });
  t.after(() => term.dispose());
  await new Promise<void>((resolve) => term.write('Edit src/server.ts:120:3 missing.ts\r\n', resolve));
  let provider: ILinkProvider | undefined;
  let disposed = false;
  const requests: { url: string; body: unknown }[] = [];
  let failNext = false;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as { paths: string[] };
    requests.push({ url, body });
    if (failNext) {
      failNext = false;
      return new Response('boom', { status: 503 });
    }
    return new Response(JSON.stringify(url.includes('/open?') ? { ok: true } : { paths: [{ path: '/checkout/src/server.ts', line: 120, column: 3 }, null].slice(0, body.paths.length), local: true }));
  });
  const addon = new TerminalPathLinksAddon({ floor: () => 'f1', workerId: 'w1' });
  addon.activate({
    buffer: term.buffer,
    cols: term.cols,
    registerLinkProvider: (value: ILinkProvider) => {
      provider = value;
      return {
        dispose: () => {
          disposed = true;
        },
      };
    },
  } as Terminal);
  const get = () => new Promise<ILink[] | undefined>((resolve) => provider!.provideLinks(1, resolve));
  failNext = true;
  assert.equal(await get(), undefined);
  const links = await get();
  assert.equal(links?.length, 1);
  assert.deepEqual(requests[0].body, { paths: ['src/server.ts:120:3', 'missing.ts'] });
  let syncCached: ILink[] | undefined;
  provider!.provideLinks(1, (resolved) => {
    syncCached = resolved;
  });
  assert.equal(syncCached?.length, 1);
  assert.equal(requests.length, 2);
  links![0].activate({ metaKey: false, ctrlKey: false } as MouseEvent, links![0].text);
  assert.equal(requests.length, 2);
  links![0].activate({ metaKey: true, preventDefault() {} } as MouseEvent, links![0].text);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].body, { paths: ['src/server.ts:120:3'] });
  addon.linkHandler.activate({ metaKey: false, ctrlKey: false } as MouseEvent, 'file:///checkout/src/server.ts', { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } });
  assert.equal(requests.length, 3);
  addon.linkHandler.activate({ metaKey: true, preventDefault() {} } as MouseEvent, 'file:///checkout/src/server.ts', { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 5);
  assert.deepEqual(requests[3].body, { paths: ['file:///checkout/src/server.ts'] });
  assert.deepEqual(requests[4].body, { paths: ['file:///checkout/src/server.ts'] });
  addon.dispose();
  assert.equal(disposed, true);
});

test('terminal HTTP resolves worker and boss shell paths, serves previews and refuses remote host opens', async (t) => {
  const { root, checkout, floor } = await fixture(t);
  const opened: string[][] = [];
  const fakeFloor = {
    def: { dir: floor },
    workers: { terminalContext: (id: string) => (id === 'w1' ? { cwd: checkout } : undefined) },
    shell: { terminalContext: () => ({ cwd: checkout }) },
  };
  const handler = createFloorHttp({
    floors: new Map([['f1', fakeFloor]]),
    workerFloor: (id: string) => (id === 'w1' ? fakeFloor : undefined),
    orchestrator: { workers: { terminalContext: () => ({ cwd: checkout }) } },
    workerThreads: {},
    factory: {},
    setup: {},
    whiteboardRequest() {},
    openFile: (file: string) =>
      openTerminalFile(file, async (args) => {
        opened.push(args);
      }),
  } as never);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handler(
      req,
      res,
      url.pathname,
      url,
      () => req.headers['x-deny'] !== 'true',
      () => req.headers['x-own-page'] === 'true',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const request = (route: string, worker = 'w1', paths: unknown = ['src/server.ts:120'], headers: Record<string, string> = {}) =>
    fetch(`${base}${route}?${new URLSearchParams({ floor: 'f1', worker })}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ paths }) });
  for (const route of ['/api/term/paths', '/api/term/path/open', '/api/term/file']) assert.ok(isFloorHttpPath(route, 'POST'));
  for (const worker of ['w1', OFFICE_SHELL_ID, 'orchestrator']) {
    const response = await request('/api/term/paths', worker);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { paths: [{ path: path.join(checkout, 'src/server.ts'), displayPath: 'src/server.ts', line: 120 }], local: false });
  }
  const ownLoopback = await request('/api/term/paths', 'w1', ['src/server.ts:120'], { 'x-own-page': 'true' });
  assert.equal((await ownLoopback.json()).local, process.platform === 'darwin');
  // A reverse proxy such as Tailscale Serve connects over loopback with a non-loopback Host header; it must stay remote.
  const proxied = await new Promise<{ status: number; body: { local: boolean } }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/term/paths?floor=f1&worker=w1', method: 'POST', headers: { 'content-type': 'application/json', host: 'office.tailnet.ts.net', 'x-own-page': 'true' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ paths: ['src/server.ts:120'] }));
  });
  assert.equal(proxied.status, 200);
  assert.equal(proxied.body.local, false);
  // Orchestrator resolves relative paths against its own cwd, never an unrelated ?floor= directory.
  assert.deepEqual((await (await request('/api/term/paths', 'orchestrator', ['README.md'])).json()).paths, [null]);
  assert.equal((await request('/api/term/paths', 'w1', [])).status, 400);
  assert.equal((await request('/api/term/path/open', 'w1', ['src/server.ts', 'README.md'], { 'x-own-page': 'true' })).status, 400);
  assert.equal((await request('/api/term/paths', 'missing')).status, 404);
  assert.equal((await request('/api/term/paths', 'w1', [123])).status, 400);
  assert.equal((await request('/api/term/paths', 'w1', Array(65).fill('src/a.ts'))).status, 400);
  assert.equal((await request('/api/term/path/open')).status, 403);
  assert.equal((await fetch(`${base}/api/term/paths`)).status, 405);
  assert.equal((await fetch(`${base}/api/term/paths?floor=f1&worker=w1`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-deny': 'true' }, body: '{"paths":["a.ts"]}' })).status, 403);
  assert.equal((await fetch(`${base}/api/term/paths?floor=f1&worker=w1`, { method: 'POST', body: 'invalid' })).status, 400);
  const query = new URLSearchParams({ floor: 'f1', worker: 'w1', path: 'src/server.ts:120' });
  const preview = await fetch(`${base}/api/term/file?${query}`);
  assert.equal(preview.status, 200);
  assert.match((await preview.json()).text, /server.ts/);
  assert.equal((await fetch(`${base}/api/term/file?${query}`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  query.set('path', '../../missing.ts');
  assert.equal((await fetch(`${base}/api/term/file?${query}`)).status, 404);
  await mkdir(path.join(checkout, '.ssh'));
  await writeFile(path.join(checkout, '.ssh/config'), 'private');
  query.set('path', '.ssh/config');
  assert.equal((await fetch(`${base}/api/term/file?${query}`)).status, 403);
  await writeFile(path.join(checkout, '.env.local'), 'SECRET=private');
  query.set('path', './.env.local');
  assert.equal((await fetch(`${base}/api/term/file?${query}`)).status, 403);
  await writeFile(path.join(checkout, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4h8AAAAASUVORK5CYII=', 'base64'));
  query.set('path', './pixel.png');
  query.set('raw', 'image');
  const image = await fetch(`${base}/api/term/file?${query}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  query.delete('raw');
  // Paired devices are confined to the terminal's roots: home secrets and other absolute paths are invisible.
  const outside = path.join(root, 'outside.txt');
  for (const candidate of ['~/.factory/settings.json', outside]) {
    assert.deepEqual((await (await request('/api/term/paths', 'w1', [candidate])).json()).paths, [null], candidate);
    query.set('path', candidate);
    assert.equal((await fetch(`${base}/api/term/file?${query}`)).status, 404, candidate);
  }
  // The owner's own loopback page keeps explicit paths anywhere; opening still goes through the reveal rule.
  const ownerOutside = await (await request('/api/term/paths', 'w1', [outside], { 'x-own-page': 'true' })).json();
  assert.equal(ownerOutside.paths[0]?.path, outside);
  if (process.platform === 'darwin') {
    await writeFile(path.join(root, 'run.command'), 'echo hi\n');
    const reveal = await request('/api/term/path/open', 'w1', [path.join(root, 'run.command')], { 'x-own-page': 'true' });
    assert.deepEqual(await reveal.json(), { ok: true, revealed: true });
    assert.deepEqual(opened.at(-1), ['-R', '--', path.join(root, 'run.command')]);
    const open = await request('/api/term/path/open', 'w1', [outside], { 'x-own-page': 'true' });
    assert.deepEqual(await open.json(), { ok: true });
    assert.deepEqual(opened.at(-1), ['--', outside]);
  }
  assert.match(threadFilePreviewUrl({ floor: 'f1', workerId: 'w1', path: 'src/a.ts', source: 'terminal' }), /^\/api\/term\/file\?/);
  assert.match(threadFileImageUrl({ floor: 'f1', workerId: 'w1', path: 'src/a.png', source: 'terminal' }), /^\/api\/term\/file\?/);
  assert.equal(new URL(threadFilePreviewUrl({ floor: 'f1', workerId: 'w1', path: '/absolute/a.ts', requestPath: './src/a.ts:12', source: 'terminal' }), base).searchParams.get('path'), './src/a.ts:12');
});
