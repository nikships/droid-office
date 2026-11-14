import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createFloorHttp, isFloorHttpPath } from '../src/server/server-runtime/floor-http.js';
import { isEnvSecretPath, ThreadWorkspace } from '../src/server/thread-workspace.js';
import { ORCHESTRATOR_ID } from '../src/shared/mission-control.js';

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('isEnvSecretPath blocks .env and .env.* secrets while allowing .env.example/.sample/.template', () => {
  for (const secret of ['.env', '.env.local', '.env.production', 'apps/api/.env.test', '.envrc']) {
    assert.equal(isEnvSecretPath(secret), true, secret);
  }
  for (const allowed of ['.env.example', '.env.sample', '.env.template', 'config/.env.example', 'src/env.ts', 'tests/env-example.test.ts']) {
    assert.equal(isEnvSecretPath(allowed), false, allowed);
  }
});

test('ThreadWorkspace.listFiles caches per root, derives folders, ranks fuzzy queries and falls back to bounded walk', async (t) => {
  const root = await tempDir(t, 'office-thread-ws-');
  await mkdir(path.join(root, 'src/shared'), { recursive: true });
  await mkdir(path.join(root, 'src/server'), { recursive: true });
  await mkdir(path.join(root, 'node_modules/pkg'), { recursive: true });
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });

  await writeFile(path.join(root, '.env'), 'SECRET=1\n');
  await writeFile(path.join(root, '.env.local'), 'SECRET=2\n');
  await writeFile(path.join(root, '.env.example'), 'PORT=4600\n');
  await writeFile(path.join(root, 'src/shared/thread-diff.ts'), 'export const x = 1;\n');
  await writeFile(path.join(root, 'src/server/thread-watch.ts'), 'export const y = 2;\n');
  await writeFile(path.join(root, 'node_modules/pkg/index.js'), 'ignored\n');
  await writeFile(path.join(root, 'dist/bundle.js'), 'ignored\n');
  await writeFile(path.join(root, '.git/config'), 'ignored\n');

  const outside = await tempDir(t, 'office-thread-outside-');
  await writeFile(path.join(outside, 'secret.txt'), 'outside\n');
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'src/escaped.txt'));

  // Non-git fallback walk (gitFiles returns undefined).
  let now = 1000;
  let gitCalls = 0;
  const fallbackWs = new ThreadWorkspace({
    now: () => now,
    gitFiles: async () => {
      gitCalls++;
      return undefined;
    },
  });

  const listed = await fallbackWs.listFiles(root);
  assert.equal('error' in listed, false);
  if ('error' in listed) return;
  assert.deepEqual(listed.files, ['.env.example', 'src/server/thread-watch.ts', 'src/shared/thread-diff.ts']);
  assert.deepEqual(listed.dirs, ['src/', 'src/server/', 'src/shared/']);
  assert.equal(listed.truncated, false);
  assert.equal(gitCalls, 1);

  // Within 5,000 ms cache window, repeat calls reuse cached scan.
  now += 2000;
  await fallbackWs.listFiles(root, 'tdiff');
  assert.equal(gitCalls, 1);

  const fuzzy = await fallbackWs.listFiles(root, 'sthreaddiff');
  assert.equal('error' in fuzzy, false);
  if (!('error' in fuzzy)) {
    assert.equal(fuzzy.files[0], 'src/shared/thread-diff.ts');
  }

  // Past 5,000 ms, cache refreshes; query results cap at 200.
  const manyGitWs = new ThreadWorkspace({
    now: () => now,
    gitFiles: async () => ['.env', '.env.production', '.env.sample', ...Array.from({ length: 260 }, (_, i) => `src/item-${i}.ts`)],
  });
  const capped = await manyGitWs.listFiles(root, 'item');
  assert.equal('error' in capped, false);
  if (!('error' in capped)) {
    assert.equal(capped.files.length, 200);
    assert.equal(capped.truncated, true);
  }
  const allGit = await manyGitWs.listFiles(root);
  if (!('error' in allGit)) {
    assert.equal(allGit.files.includes('.env'), false);
    assert.equal(allGit.files.includes('.env.production'), false);
    assert.equal(allGit.files.includes('.env.sample'), true);
  }
});

test('ThreadWorkspace.readPreview enforces realpath containment, .env* rejection, binary check and size caps', async (t) => {
  const root = await tempDir(t, 'office-thread-preview-');
  const outside = await tempDir(t, 'office-thread-preview-out-');
  await mkdir(path.join(root, 'src'), { recursive: true });

  await writeFile(path.join(root, 'src/hello.ts'), 'const a = 1;\nconst b = 2;\n');
  await writeFile(path.join(root, '.env'), 'API_KEY=topsecret\n');
  await writeFile(path.join(root, '.env.local'), 'API_KEY=local\n');
  await writeFile(path.join(root, '.env.template'), 'API_KEY=\n');
  await writeFile(path.join(outside, 'outside.txt'), 'secret outside\n');
  await symlink(path.join(outside, 'outside.txt'), path.join(root, 'src/escape-link.txt'));
  await symlink(path.join(root, '.env'), path.join(root, 'src/env-alias.txt'));
  await writeFile(path.join(root, 'src/icon.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));

  // ~600 KiB multi-byte UTF-8 file (between 512 KiB read cap and 2 MiB stat cap).
  const mediumLine = `const emoji = "🚀✨"; // ${'x'.repeat(80)}\n`;
  const mediumCount = 6500;
  await writeFile(path.join(root, 'src/medium.ts'), mediumLine.repeat(mediumCount));

  // > 2 MiB file.
  await writeFile(path.join(root, 'src/huge.log'), Buffer.alloc(2 * 1024 * 1024 + 64, 0x61));

  const ws = new ThreadWorkspace();

  const ok = await ws.readPreview(root, 'src/hello.ts');
  assert.deepEqual(ok, {
    path: 'src/hello.ts',
    text: 'const a = 1;\nconst b = 2;\n',
    totalLines: 2,
    truncated: false,
  });

  const tpl = await ws.readPreview(root, '.env.template');
  assert.equal('error' in tpl, false);

  for (const forbidden of ['.env', '.env.local', 'src/env-alias.txt', '../outside.txt', '/etc/passwd', 'src/escape-link.txt', '.git/HEAD', '.droid-office/state.json']) {
    const res = await ws.readPreview(root, forbidden);
    assert.ok('error' in res, forbidden);
    assert.equal(res.status, 403, forbidden);
  }

  const missing = await ws.readPreview(root, 'src/does-not-exist.ts');
  assert.ok('error' in missing && missing.status === 404);

  const dirRes = await ws.readPreview(root, 'src');
  assert.ok('error' in dirRes && dirRes.status === 404);

  const binary = await ws.readPreview(root, 'src/icon.bin');
  assert.ok('error' in binary);
  assert.equal(binary.status, 415);
  assert.equal(binary.binary, true);

  const tooBig = await ws.readPreview(root, 'src/huge.log');
  assert.ok('error' in tooBig && tooBig.status === 413);

  const truncated = await ws.readPreview(root, 'src/medium.ts');
  assert.equal('error' in truncated, false);
  if (!('error' in truncated)) {
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.totalLines, mediumCount);
    assert.ok(Buffer.byteLength(truncated.text, 'utf8') <= 512 * 1024);
    assert.equal(truncated.text.includes('\uFFFD'), false, 'UTF-8 boundary never splits a multi-byte character');
  }
});

test('floor-http serves /api/thread/files and /api/thread/file for local and orchestrator workers and 404s shells/cloud', async (t) => {
  const worktreeDir = await tempDir(t, 'office-http-wt-');
  const orchDir = await tempDir(t, 'office-http-orch-');
  await writeFile(path.join(worktreeDir, 'index.ts'), 'export const ready = true;\n');
  await writeFile(path.join(orchDir, 'notes.md'), '# Mission\n');

  assert.equal(isFloorHttpPath('/api/thread/files', 'GET'), true);
  assert.equal(isFloorHttpPath('/api/thread/file', 'GET'), true);
  assert.equal(isFloorHttpPath('/api/thread/file', 'POST'), false);

  const fakeFloor = {
    id: 'f1',
    workers: {
      agentFolder: (id: string) => (id === 'agent-1' ? worktreeDir : undefined),
    },
  };
  const floors = new Map([['f1', fakeFloor as never]]);
  const handler = createFloorHttp({
    floors,
    orchestrator: { cwd: orchDir } as never,
    workerFloor: (id: string) => (id === 'agent-1' ? (fakeFloor as never) : undefined),
    workerThreads: {} as never,
    factory: {} as never,
    setup: {} as never,
    whiteboardRequest: (() => {}) as never,
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handler(req, res, url.pathname, url, () => true);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const get = async (urlPath: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
    return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
  };

  // Cross-floor resolution (no floor param, resolved via workerFloor).
  const filesRes = await get('/api/thread/files?worker=agent-1');
  assert.equal(filesRes.status, 200);
  assert.equal(filesRes.cache, 'no-store');
  assert.ok(filesRes.body.files.includes('index.ts'));

  const fileRes = await get('/api/thread/file?floor=f1&worker=agent-1&path=index.ts');
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.cache, 'no-store');
  assert.equal(fileRes.body.text, 'export const ready = true;\n');

  // Orchestrator resolution.
  const orchRes = await get(`/api/thread/file?worker=${ORCHESTRATOR_ID}&path=notes.md`);
  assert.equal(orchRes.status, 200);
  assert.equal(orchRes.body.text, '# Mission\n');

  // Shells, cloud workers and unknown workers return 404.
  for (const unsupported of ['shell-1', 'cloud-1', 'unknown-1', '']) {
    const r = await get(`/api/thread/files?floor=f1&worker=${unsupported}`);
    assert.equal(r.status, 404, unsupported);
  }
});
