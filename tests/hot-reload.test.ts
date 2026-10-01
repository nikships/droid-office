import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildClient, HotReload, sourceAppDir } from '../src/server/hot-reload.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.resolve('tests/.hot-reload-'));
  const put = (name: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  };
  put('package.json', JSON.stringify({ name: 'droid-office', type: 'module' }));
  put('vite.config.ts', 'export default { root: "src/client" };');
  put('src/client/index.html', '<html><head></head><body>source</body></html>');
  put('src/client/main.ts', 'export const value = 1;');
  put('src/shared/logic.ts', 'export const limit = 2;');
  put('src/server/main.ts', 'export const server = 3;');
  put('dist/public/index.html', 'original');
  put('dist/public/assets/original.js', 'original asset');
  const dataDir = path.join(dir, 'data');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, put, dataDir, publicDir: path.join(dir, 'dist/public') };
}

async function until(ok: () => boolean, message = 'reload state did not settle') {
  const deadline = Date.now() + 5000;
  while (!ok()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

async function office(t: TestContext, build?: (output: string, signal: AbortSignal) => Promise<void>) {
  const f = fixture(t);
  let builds = 0;
  const reload = new HotReload({
    appDir: f.dir,
    dataDir: f.dataDir,
    publicDir: f.publicDir,
    pollMs: 15,
    settleMs: 30,
    build: async (out, signal) => {
      builds++;
      if (build) return build(out, signal);
      mkdirSync(path.join(out, 'assets'));
      writeFileSync(path.join(out, 'index.html'), `build ${builds}`);
      writeFileSync(path.join(out, 'assets', `chunk-${builds}.js`), String(builds));
    },
  });
  t.after(() => reload.stop());
  await reload.start();
  return { ...f, reload, builds: () => builds };
}

test('reload resolves its own install from source and built paths, not cwd', (t) => {
  const f = fixture(t);
  assert.equal(sourceAppDir(pathToFileURL(path.join(f.dir, 'src/server/hot-reload.ts')).href), f.dir);
  assert.equal(sourceAppDir(pathToFileURL(path.join(f.dir, 'dist/server/server/hot-reload.js')).href), f.dir);
  assert.equal(sourceAppDir('file:///no-such-office/file.js'), undefined);
});

test('reload is off by default, unavailable in releases or without build tools, and refuses enabling', async (t) => {
  const f = fixture(t);
  const noTools = new HotReload({ appDir: f.dir, dataDir: f.dataDir, publicDir: f.publicDir });
  assert.equal(noTools.state().enabled, false);
  assert.equal(noTools.state().available, false);
  assert.match((await noTools.setEnabled(true))!, /dependencies/);
  assert.equal(noTools.rebuild(), 'Enable source hot reload first');
  const release = new HotReload({ dataDir: f.dataDir, publicDir: f.publicDir });
  assert.match((await release.setEnabled(true))!, /source checkout/);
  await release.start();
  await release.stop();
  assert.equal(await release.setEnabled(false), 'The office is shutting down');
});

test('successful builds publish atomically, retain old chunks, persist the setting, and clean up owned builds', async (t) => {
  const f = await office(t);
  assert.equal(f.reload.state().enabled, false);
  const before = f.reload.state().revision;
  assert.equal(await f.reload.setEnabled(true), undefined);
  await until(() => f.reload.state().revision !== before);
  const firstDir = f.reload.publicDir;
  assert.equal(readFileSync(path.join(firstDir, 'index.html'), 'utf8'), 'build 1');
  assert.equal(readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), 'original');
  assert.equal(JSON.parse(readFileSync(path.join(f.dataDir, 'hot-reload.json'), 'utf8')).enabled, true);
  const second = f.reload.state().revision;
  f.put('src/client/main.ts', 'export const value = 2;');
  await until(() => f.reload.state().revision !== second);
  assert.equal(readFileSync(f.reload.file('/assets/chunk-1.js')!, 'utf8'), '1');
  assert.equal(readFileSync(f.reload.file('/assets/original.js')!, 'utf8'), 'original asset');
  assert.equal(f.reload.file('/../package.json'), undefined);
  assert.equal(f.reload.file('/assets/../../package.json'), undefined);
  assert.equal(f.reload.file('/missing'), undefined);
  assert.equal(f.reload.file('/assets'), undefined);
  assert.equal(f.reload.state().restartRequired, false);
  assert.ok(f.reload.state().lastBuiltAt);
  const resumed = new HotReload({ appDir: f.dir, dataDir: f.dataDir, publicDir: f.publicDir, build: async () => {} });
  assert.equal(resumed.state().enabled, true);
  await f.reload.stop();
  assert.equal(existsSync(firstDir), false);
  assert.equal(existsSync(f.publicDir), true);
});

test('compiler failures keep the last good client, retry on edits, and allow a manual retry', async (t) => {
  let broken = false;
  const f = await office(t, async (out) => {
    if (broken) throw new Error('Type error in game logic');
    writeFileSync(path.join(out, 'index.html'), 'good');
  });
  await f.reload.setEnabled(true);
  await until(() => !!f.reload.state().lastBuiltAt);
  const good = f.reload.state().revision;
  const goodDir = f.reload.publicDir;
  broken = true;
  f.put('src/client/main.ts', 'broken');
  await until(() => f.reload.state().phase === 'error');
  assert.match(f.reload.state().error!, /Type error/);
  assert.equal(f.reload.state().revision, good);
  assert.equal(f.reload.publicDir, goodDir);
  const builds = f.builds();
  await delay(100);
  assert.equal(f.builds(), builds, 'do not repeatedly compile unchanged broken source');
  broken = false;
  assert.equal(f.reload.rebuild(), undefined);
  await until(() => f.reload.state().revision !== good);
  assert.equal(f.reload.state().error, undefined);
  const retry = f.reload.state().revision;
  broken = true;
  f.put('src/client/main.ts', 'broken again');
  await until(() => f.reload.state().phase === 'error');
  broken = false;
  f.put('src/client/main.ts', 'fixed');
  await until(() => f.reload.state().revision !== retry);
});

test('additions, deletions, atomic saves, public assets, shared code and build config are detected', async (t) => {
  const f = await office(t);
  await f.reload.setEnabled(true);
  await until(() => !!f.reload.state().lastBuiltAt);
  const changes = [
    () => f.put('src/client/new/fresh.ts', 'export const fresh = true;'),
    () => rmSync(path.join(f.dir, 'src/client/new'), { recursive: true }),
    () => {
      f.put('src/client/temp.ts', 'new atomic content');
      renameSync(path.join(f.dir, 'src/client/temp.ts'), path.join(f.dir, 'src/client/main.ts'));
    },
    () => f.put('src/client/public/props/desk.glb', 'new model'),
    () => f.put('vite.config.ts', 'export default { root: "src/client", build: {} };'),
    () => f.put('src/shared/logic.ts', 'export const limit = 4;'),
  ];
  for (const change of changes) {
    const before = f.reload.state().revision;
    change();
    await until(() => f.reload.state().revision !== before);
  }
  assert.equal(f.reload.state().restartRequired, true);
});

test('server-only changes flag a restart without rebuilding or restarting the server', async (t) => {
  const f = await office(t);
  await f.reload.setEnabled(true);
  await until(() => !!f.reload.state().lastBuiltAt);
  const before = f.reload.state().revision;
  const builds = f.builds();
  f.put('src/server/main.ts', 'server changed');
  await until(() => f.reload.state().restartRequired);
  assert.equal(f.reload.state().revision, before);
  assert.equal(f.builds(), builds);
});

test('edits during a slow build are serialized and the superseded build is never published', async (t) => {
  let release!: () => void;
  let calls = 0;
  let active = 0;
  const f = await office(t, async (out) => {
    assert.equal(++active, 1);
    if (++calls === 1) await new Promise<void>((resolve) => (release = resolve));
    writeFileSync(path.join(out, 'index.html'), String(calls));
    active--;
  });
  const before = f.reload.state().revision;
  await f.reload.setEnabled(true);
  await until(() => !!release);
  f.put('src/client/main.ts', 'newer source');
  await delay(80);
  assert.equal(f.builds(), 1);
  assert.equal(f.reload.publicDir, f.publicDir);
  release();
  await until(() => f.reload.state().revision !== before);
  assert.equal(readFileSync(path.join(f.reload.publicDir, 'index.html'), 'utf8'), '2');
  assert.equal(f.builds(), 2);
});

test('disabling mid-build aborts and prevents publication; re-enabling still works', async (t) => {
  let calls = 0;
  let entered = false;
  let aborted = false;
  const f = await office(t, async (out, signal) => {
    if (++calls === 1) {
      entered = true;
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
    }
    writeFileSync(path.join(out, 'index.html'), 'done');
  });
  const before = f.reload.state().revision;
  await f.reload.setEnabled(true);
  await until(() => entered);
  await f.reload.setEnabled(false);
  await until(() => aborted);
  await delay(50);
  assert.equal(f.reload.state().revision, before);
  assert.equal(f.reload.state().phase, 'idle');
  assert.equal(f.reload.publicDir, f.publicDir);
  f.put('src/client/main.ts', 'edited while off');
  await delay(60);
  assert.equal(f.builds(), 1);
  await f.reload.setEnabled(true);
  await until(() => f.reload.state().revision !== before);
});

test('concurrent settings changes are saved in request order', async (t) => {
  const f = await office(t);
  await Promise.all([f.reload.setEnabled(true), f.reload.setEnabled(false)]);
  assert.equal(f.reload.state().enabled, false);
  assert.equal(JSON.parse(readFileSync(path.join(f.dataDir, 'hot-reload.json'), 'utf8')).enabled, false);
});

test('incomplete output and unsavable settings are reported without changing the active client', async (t) => {
  const f = await office(t, async () => {});
  const before = f.reload.state().revision;
  await f.reload.setEnabled(true);
  await until(() => f.reload.state().phase === 'error');
  assert.match(f.reload.state().error!, /index.html/);
  assert.equal(f.reload.state().revision, before);
  const badDir = path.join(f.dir, 'not-a-directory');
  writeFileSync(badDir, 'file');
  const bad = new HotReload({ appDir: f.dir, dataDir: badDir, publicDir: f.publicDir, build: async () => {} });
  assert.match((await bad.setEnabled(true))!, /Could not save/);
  assert.equal(bad.state().enabled, false);
});

test('the real compiler and Vite build isolated output and reject invalid TypeScript', { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  symlinkSync(path.resolve('node_modules'), path.join(f.dir, 'node_modules'), 'junction');
  f.put('tsconfig.client.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', types: [], skipLibCheck: true }, include: ['src/client/**/*.ts'] }));
  f.put('src/client/index.html', '<html><body><script type="module" src="./main.ts"></script></body></html>');
  const out = path.join(f.dir, 'built');
  await buildClient(f.dir, out, new AbortController().signal);
  assert.ok(existsSync(path.join(out, 'index.html')));
  assert.equal(readFileSync(path.join(f.publicDir, 'index.html'), 'utf8'), 'original');
  f.put('src/client/main.ts', 'const value: number = "not a number";');
  await assert.rejects(buildClient(f.dir, path.join(f.dir, 'bad-build'), new AbortController().signal), /not assignable/);
  assert.equal(existsSync(path.join(f.dir, 'bad-build/index.html')), false);
});
