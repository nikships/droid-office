import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { TerminalPaths } from '../src/server/terminal-paths.js';
import { createFloorHttp } from '../src/server/server-runtime/floor-http.js';

test('OSC 7 can choose a relative base, never another root or new permissions', async (t) => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'office-osc7-')));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = join(tmp, 'checkout'),
    cwd = join(root, 'sub dir'),
    outside = join(tmp, 'sibling');
  await mkdir(cwd, { recursive: true });
  await mkdir(outside);
  for (const dir of [root, cwd, outside]) await writeFile(join(dir, 'a.ts'), dir);
  await symlink(outside, join(root, 'elsewhere'), 'dir');
  await symlink(join(outside, 'a.ts'), join(cwd, 'link.ts'));
  const context = { cwd: root, root };
  const resolver = new TerminalPaths(
    async () => [],
    async () => undefined,
  );
  const hint = pathToFileURL(cwd).href;
  const original = await resolver.resolve(context, ['a.ts:3']);
  assert.equal((await resolver.resolve(context, ['a.ts:3'], { cwdHint: hint }))[0]?.path, join(cwd, 'a.ts'));
  for (const invalid of [
    hint.replace('file:///', 'file://another.example/'),
    hint.replace('file:', 'https:'),
    pathToFileURL(outside).href,
    `${hint}/../sub%20dir`,
    `${hint}/%2e%2e/sub%20dir`,
    hint.replace('/sub', '%2fsub'),
    `${hint}%5c`,
    `${hint}/a.ts`,
    pathToFileURL(join(root, 'elsewhere')).href,
    {},
  ])
    assert.deepEqual(await resolver.resolve(context, ['a.ts:3'], { cwdHint: invalid }), original, String(invalid));
  assert.deepEqual(await resolver.resolve(context, ['../../sibling/a.ts', 'link.ts'], { cwdHint: hint, allowOutside: true }), [null, null]);
  for (const allowOutside of [true, false]) {
    const paths = [join(outside, 'a.ts'), pathToFileURL(join(outside, 'a.ts')).href, join(root, 'a.ts')];
    assert.deepEqual(await resolver.resolve(context, paths, { cwdHint: hint, allowOutside }), await resolver.resolve(context, paths, { allowOutside }));
  }
  const opens: string[] = [];
  const floor = { def: { dir: root }, workers: { terminalContext: () => context } };
  const handler = createFloorHttp({
    floors: new Map([['f', floor]]),
    workerFloor: () => floor,
    openFile: async (file: string) => {
      opens.push(file);
      return { revealed: false };
    },
  } as never);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost'),
      guest = url.searchParams.has('guest');
    void handler(
      req,
      res,
      url.pathname,
      url,
      () => true,
      () => !guest,
      !guest,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const guest of [false, true]) {
    const query = new URLSearchParams({ floor: 'f', worker: 'w', ...(guest ? { guest: '1' } : {}) });
    const post = (url: string) => fetch(`${base}${url}?${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: ['a.ts:3'], cwdHint: hint }) });
    const expected = guest ? root : cwd;
    assert.equal((await (await post('/api/term/paths')).json()).paths[0].path, join(expected, 'a.ts'));
    if (process.platform === 'darwin' && !guest) {
      assert.equal((await post('/api/term/path/open')).status, 200);
      assert.deepEqual(opens, [join(cwd, 'a.ts')]);
    } else assert.equal((await post('/api/term/path/open')).status, 403);
    query.set('path', 'a.ts:3');
    query.set('cwdHint', hint);
    assert.equal((await (await fetch(`${base}/api/term/file?${query}`)).json()).text, expected);
  }
});
