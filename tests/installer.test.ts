import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

const repo = fileURLToPath(new URL('..', import.meta.url));
const supported = process.platform === 'darwin' || process.platform === 'linux';

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'office-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'package');
  mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  mkdirSync(path.join(pkg, 'dist/server/server'), { recursive: true });
  const metadata = { name: 'droid-office', version: '0.1.2', type: 'module' };
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(metadata));
  writeFileSync(path.join(pkg, 'package-lock.json'), JSON.stringify({ ...metadata, lockfileVersion: 3, requires: true, packages: { '': metadata } }));
  copyFileSync(path.join(repo, 'bin/droid-office.js'), path.join(pkg, 'bin/droid-office.js'));
  writeFileSync(path.join(pkg, 'dist/server/server/cli.js'), "console.log('FIXTURE_CLI', ...process.argv.slice(2));\n");
  const tarball = path.join(root, 'release.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', root, 'package']);
  const installDir = path.join(root, 'install');
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    DROID_OFFICE_INSTALL_DIR: installDir,
    DROID_OFFICE_BIN_DIR: '',
    DROID_OFFICE_INSTALL_ONLY: '1',
    DROID_OFFICE_TARBALL: tarball,
    npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_userconfig: path.join(root, 'empty-npmrc'),
  };
  function install(overrides: NodeJS.ProcessEnv = {}, cwd = root) {
    const result = spawnSync('bash', [path.join(repo, 'install.sh')], {
      cwd,
      env: { ...env, ...overrides },
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result;
  }
  function oldRelease(tag = 'v0.1.1') {
    const dir = path.join(installDir, 'versions', tag);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.installed'), '');
    return dir;
  }
  return { root, installDir, env, install, oldRelease };
}

function tools(root: string) {
  const dir = path.join(root, 'tools');
  mkdirSync(dir);
  // GNU tar invokes gzip through PATH; macOS tar decompresses internally.
  for (const tool of ['node', 'npm', 'bash', 'uname', 'curl', 'tar', 'gzip', 'git', 'mkdir', 'mktemp', 'cp', 'touch', 'mv', 'rm', 'sed', 'cat', 'grep', 'chmod', 'ps', 'lsof']) {
    const result = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', tool], { encoding: 'utf8' });
    if (result.status === 0) symlinkSync(result.stdout.trim(), path.join(dir, tool));
  }
  return dir;
}

test('relative install roots produce a launcher that works from another directory', { skip: !supported }, (t) => {
  const f = fixture(t);
  const elsewhere = path.join(f.root, 'elsewhere');
  mkdirSync(elsewhere);
  f.install({ DROID_OFFICE_INSTALL_DIR: "./relative [install]'s", DROID_OFFICE_BIN_DIR: './relative bin' });
  const launcher = path.join(f.root, 'relative bin/droid-office');
  for (const cwd of [f.root, elsewhere]) {
    const result = spawnSync(launcher, ['argument with spaces'], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'FIXTURE_CLI argument with spaces');
  }
});

test('relative XDG roots and symlinked directories resolve before launching', { skip: !supported }, (t) => {
  const f = fixture(t);
  const real = path.join(f.root, "data [root]'s");
  mkdirSync(real);
  symlinkSync(real, path.join(f.root, 'linked-data'));
  f.install({ DROID_OFFICE_INSTALL_DIR: '', XDG_DATA_HOME: './linked-data', DROID_OFFICE_BIN_DIR: './bin' });
  const result = spawnSync(path.join(f.root, 'bin/droid-office'), [], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'FIXTURE_CLI');
  assert.ok(existsSync(path.join(real, 'droid-office/versions/v0.1.2/.installed')));
});

test('cleanup works without pgrep and defers when process inspection fails', { skip: !supported }, (t) => {
  const f = fixture(t);
  const previous = f.oldRelease();
  const toolDir = tools(f.root);
  assert.ok(!existsSync(path.join(toolDir, 'pgrep')));
  assert.ok(existsSync(path.join(toolDir, 'gzip')), 'GNU tar needs gzip on the restricted PATH');
  const ps = path.join(toolDir, 'ps');
  const realPs = execFileSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).trim();
  rmSync(ps);
  writeFileSync(ps, '#!/bin/sh\nexit 2\n', { mode: 0o755 });
  f.install({ PATH: toolDir });
  assert.ok(existsSync(previous), 'failed inspection defers cleanup');
  rmSync(ps);
  symlinkSync(realPs, ps);
  f.install({ PATH: toolDir });
  assert.ok(!existsSync(previous), 'unused release pruned without pgrep');
});

test('cleanup protects an office command path literally and leaves release symlinks alone', { skip: !supported }, async (t) => {
  const f = fixture(t);
  const previous = f.oldRelease('v0.1.1+[office]');
  const sibling = f.oldRelease('v0.1.1+o');
  const link = path.join(f.installDir, 'versions/v0.1.3');
  symlinkSync(previous, link);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', path.join(previous, 'bin/droid-office.js')], { stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await once(child, 'exit');
  });
  await once(child, 'spawn');
  f.install();
  assert.ok(existsSync(previous), 'release path with regex characters is protected');
  assert.ok(!existsSync(sibling), 'a similarly named unused release is not protected');
  assert.ok(existsSync(link), 'release symlinks are not traversed or removed');
});

test('a live host with an unreadable cwd defers cleanup, but an exited host does not', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = fixture(t);
  const previous = f.oldRelease();
  const toolDir = tools(f.root);
  for (const tool of ['ps', 'lsof']) rmSync(path.join(toolDir, tool));
  const ps = path.join(toolDir, 'ps');
  writeFileSync(ps, `#!/bin/sh\nprintf '%s\\n' '${process.pid} droid-office-ptys'\n`, { mode: 0o755 });
  writeFileSync(path.join(toolDir, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  f.install({ PATH: toolDir });
  assert.ok(existsSync(previous), 'cannot prove a live host release is unused');
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  writeFileSync(ps, `#!/bin/sh\nprintf '%s\\n' '${child.pid} droid-office-ptys'\n`, { mode: 0o755 });
  f.install({ PATH: toolDir });
  assert.ok(!existsSync(previous), 'a host that exited during inspection does not block cleanup');
});

test('an updated release preserves an orphaned real PTY host until it exits', { skip: !supported }, async (t) => {
  const f = fixture(t);
  const previous = f.oldRelease();
  writeFileSync(path.join(previous, 'package.json'), '{"type":"module"}\n');
  execFileSync(path.join(repo, 'node_modules/.bin/tsc'), ['-p', path.join(repo, 'tsconfig.server.json'), '--outDir', path.join(previous, 'dist/server')], {
    cwd: repo,
  });
  for (const name of ['@lydell/node-pty', `@lydell/node-pty-${process.platform}-${process.arch}`, '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11']) {
    cpSync(path.join(repo, 'node_modules', name), path.join(previous, 'node_modules', name), { recursive: true });
  }
  // Keep the socket below the Unix path length limit even when os.tmpdir() is deep.
  const socket = path.join(f.root, 'pty.sock');
  const info = path.join(f.root, 'host.json');
  writeFileSync(info, JSON.stringify({ token: 'isolated-fixture' }));
  const script = path.join(previous, 'dist/server/server/ptyhost.js');
  const child = spawn(process.execPath, [script, socket, info], { cwd: path.dirname(script), stdio: 'ignore' });
  let connection: net.Socket | undefined;
  t.after(async () => {
    connection?.destroy();
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await once(child, 'exit');
  });
  const messages: { t: string; id?: string; [key: string]: unknown }[] = [];
  async function waitFor(predicate: (m: (typeof messages)[number]) => boolean) {
    for (let i = 0; i < 200; i++) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('PTY response timeout');
  }
  async function connect() {
    connection = net.createConnection(socket);
    await once(connection, 'connect');
    connection.setEncoding('utf8');
    let buf = '';
    connection.on('data', (chunk) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        messages.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
    });
    connection.write('{"t":"hello","token":"isolated-fixture"}\n');
    await waitFor((m) => m.t === 'ready');
  }
  function requestSpawn(id: string) {
    connection!.write(
      `${JSON.stringify({
        t: 'spawn',
        id,
        opts: { file: '/bin/cat', args: [], cwd: f.root, env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }, cols: 80, rows: 24 },
      })}\n`,
    );
  }
  for (let i = 0; i < 200 && !existsSync(socket); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(existsSync(socket), 'host started');
  await connect();
  requestSpawn('before');
  assert.equal((await waitFor((m) => m.id === 'before')).t, 'spawned');
  const closed = once(connection!, 'close');
  connection!.destroy();
  await closed;
  const command = execFileSync('ps', ['-p', String(child.pid), '-o', 'args='], { encoding: 'utf8' });
  assert.match(command, /droid-office-ptys/);
  assert.ok(!command.includes(previous), 'process.title hides the release path');
  const unused = f.oldRelease('v0.1.0');
  f.install();
  await connect();
  connection!.write('{"t":"attach","id":"before"}\n');
  assert.equal((await waitFor((m) => m.id === 'before')).t, 'attached');
  requestSpawn('after');
  const result = await waitFor((m) => m.id === 'after');
  assert.equal(result.t, 'spawned', JSON.stringify(result));
  assert.ok(existsSync(previous), 'live host release retained');
  assert.ok(!existsSync(unused), 'unused release pruned');
  const exited = once(child, 'exit');
  connection!.write('{"t":"stop"}\n');
  await exited;
  connection!.destroy();
  f.install();
  assert.ok(!existsSync(previous), 'release pruned after host exits');
});
