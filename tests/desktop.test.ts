import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { linkAction } from '../src/desktop/links.ts';
import { logTail, probePort, startOffice } from '../src/desktop/office.ts';
import { officeRuntime } from '../src/desktop/runtime.ts';
import { DEFAULT_PORT, defaultOfficeDir, loadSettings, officeArgs, saveSettings, startedInProject } from '../src/desktop/settings.ts';
import { fencedPath, knownDirs, loginShellPath, mergePath } from '../src/desktop/shell-path.ts';
import { runAsNode } from '../src/server/workers.ts';

function tmp(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desktop-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

/** A port nothing listens on: one the OS just handed out and took back. */
async function freePort(): Promise<number> {
  const s = await listen(() => {});
  await s.close();
  return s.port;
}

test('the login shell PATH is read from between the markers, whatever the rc files print', () => {
  assert.equal(fencedPath('Last login: today\nwelcome!\n__DROID_OFFICE_PATH_BEGIN__/a:/b__DROID_OFFICE_PATH_END__\n'), '/a:/b');
  assert.equal(fencedPath('__DROID_OFFICE_PATH_BEGIN__/old__DROID_OFFICE_PATH_END__ __DROID_OFFICE_PATH_BEGIN__/new__DROID_OFFICE_PATH_END__'), '/new');
  assert.equal(fencedPath('no markers'), undefined);
  assert.equal(fencedPath('__DROID_OFFICE_PATH_BEGIN__/a:/b'), undefined);
  assert.equal(fencedPath('__DROID_OFFICE_PATH_BEGIN____DROID_OFFICE_PATH_END__'), undefined);
});

test('PATHs merge in order, each folder once', () => {
  assert.equal(mergePath('/a:/b', undefined, '/b:/c::/a', ''), '/a:/b:/c');
  assert.ok(knownDirs('/home/me').includes('/opt/homebrew/bin'));
  assert.ok(knownDirs('/home/me').includes('/home/me/.local/bin'));
});

test('a login shell answers with its PATH, and a missing shell with nothing', async () => {
  const got = await loginShellPath('/bin/sh');
  assert.ok(got?.split(':').includes('/bin'), `got ${got}`);
  assert.equal(await loginShellPath('/no/such/shell'), undefined);
});

test("the office's own pages stay in the app; other links open in the browser or nowhere", () => {
  const origin = 'http://localhost:4600';
  assert.equal(linkAction('http://localhost:4600/?floor=home', origin), 'app');
  assert.equal(linkAction('https://github.com/nikships/droid-office/pull/1', origin), 'browser');
  assert.equal(linkAction('http://localhost:3000/', origin), 'browser');
  assert.equal(linkAction('mailto:someone@example.com', origin), 'browser');
  assert.equal(linkAction('file:///etc/passwd', origin), 'ignore');
  assert.equal(linkAction('javascript:alert(1)', origin), 'ignore');
  assert.equal(linkAction('not a url', origin), 'ignore');
});

test('settings survive a round trip and ignore what makes no sense', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'nested', 'settings.json');
  assert.deepEqual(loadSettings(file), {});
  saveSettings(file, { officeDir: '/x/office', port: 4700 });
  assert.deepEqual(loadSettings(file), { officeDir: '/x/office', port: 4700 });
  writeFileSync(file, JSON.stringify({ officeDir: 3, port: 99999 }));
  assert.deepEqual(loadSettings(file), {});
  writeFileSync(file, '{not json');
  assert.deepEqual(loadSettings(file), {});
  assert.equal(DEFAULT_PORT, 4600);
  assert.equal(defaultOfficeDir('/home/me'), path.join('/home/me', 'droid-office'));
});

test('an office opens the same way on every launch: as its home, unless it was started in it as a project', (t) => {
  const home = tmp(t);
  const plain = path.join(home, 'plain');
  const project = path.join(home, 'project');
  const takenOff = path.join(home, 'taken-off');
  const office = defaultOfficeDir(home);
  for (const d of [plain, project, takenOff, office]) mkdirSync(path.join(d, '.droid-office'), { recursive: true });
  // What a --home office writes on its first start: its config and floors that aren't itself.
  writeFileSync(path.join(plain, '.droid-office', 'config.json'), '{}\n');
  writeFileSync(path.join(plain, '.droid-office', 'floors.json'), JSON.stringify([{ id: 'home', dir: home }]));
  writeFileSync(path.join(project, '.droid-office', 'floors.json'), JSON.stringify([{ id: 'project', dir: project }]));
  writeFileSync(path.join(takenOff, '.droid-office', 'local-floor.json'), JSON.stringify({ dir: takenOff }));
  writeFileSync(path.join(office, '.droid-office', 'floors.json'), JSON.stringify([{ id: 'droid-office', dir: office }]));

  assert.equal(startedInProject(plain), false);
  assert.equal(startedInProject(project), true);
  assert.equal(startedInProject(takenOff), true);
  assert.equal(startedInProject(path.join(home, 'missing')), false);
  assert.deepEqual(officeArgs(plain, 4600, home), ['--home', plain, '--port', '4600']);
  assert.deepEqual(officeArgs(project, 4601, home), [project, '--port', '4601']);
  assert.deepEqual(officeArgs(takenOff, 4600, home), [takenOff, '--port', '4600']);
  // ~/droid-office is what `droid-office` opens with no folder, even when it lists itself as a floor.
  assert.deepEqual(officeArgs(office, 4600, home), ['--home', office, '--port', '4600']);
});

test('a port is free, held by the office, or held by something else', async (t) => {
  const office = await listen((_req, res) => res.end('<!doctype html><title>Droid Office</title>'));
  const other = await listen((_req, res) => res.end('<title>Something else</title>'));
  t.after(() => Promise.all([office.close(), other.close()]));
  assert.equal(await probePort(office.port), 'office');
  assert.equal(await probePort(other.port), 'other');
  assert.equal(await probePort(await freePort()), 'free');
});

/** Stands in for bin/droid-office.js: serves the office's title on --port and logs the signal that stops it. */
function fakeCli(dir: string, behaviour: 'serve' | 'fail'): string {
  const file = path.join(dir, `fake-cli-${behaviour}.mjs`);
  writeFileSync(
    file,
    behaviour === 'fail'
      ? `console.log('port taken'); process.exit(1);\n`
      : `import http from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
console.log('args ' + process.argv.slice(2).join(' ') + ' node-mode ' + process.env.ELECTRON_RUN_AS_NODE);
const server = http.createServer((_q, r) => r.end('<title>Droid Office</title>')).listen(port, '127.0.0.1');
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log('stopped by ' + sig); server.close(); process.exit(0); });
`,
  );
  return file;
}

test('the app starts the office, waits for its page, and stops it keeping or ending the workers', async (t) => {
  const dir = tmp(t);
  for (const [keep, signal] of [
    [true, 'SIGTERM'],
    [false, 'SIGINT'],
  ] as const) {
    const port = await freePort();
    const log = path.join(dir, `office-${signal}.log`);
    const office = await startOffice({ runtime: process.execPath, cli: fakeCli(dir, 'serve'), args: ['--home', dir, '--port', String(port)], port, env: process.env, log });
    assert.equal(office.url, `http://localhost:${port}/`);
    assert.equal(await probePort(port), 'office');
    await office.stop(keep);
    assert.equal(await office.exited, 0);
    await office.stop(keep);
    const out = readFileSync(log, 'utf8');
    assert.match(out, new RegExp(`args --home ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --port ${port} node-mode 1`));
    assert.match(out, new RegExp(`stopped by ${signal}`));
  }
});

test('an office that exits as it starts is reported with the end of its log', async (t) => {
  const dir = tmp(t);
  const port = await freePort();
  const log = path.join(dir, 'office.log');
  await assert.rejects(startOffice({ runtime: process.execPath, cli: fakeCli(dir, 'fail'), args: [], port, env: process.env, log }), /stopped as it started \(exit 1\)[\s\S]*port taken/);
  assert.equal(logTail(log), 'port taken');
  assert.equal(logTail(path.join(dir, 'missing.log')), '');
});

test('an office that never answers is given up on', async (t) => {
  const dir = tmp(t);
  const port = await freePort();
  const silent = path.join(dir, 'silent.mjs');
  writeFileSync(silent, 'setInterval(() => {}, 1000);\n');
  await assert.rejects(startOffice({ runtime: process.execPath, cli: silent, args: [], port, env: process.env, log: path.join(dir, 'office.log'), timeoutMs: 500 }), /didn't open on port/);
});

test('commands written for workers run Electron as Node only under the Mac app', () => {
  assert.deepEqual(runAsNode({ ...process.versions, electron: '44.5.1' }), { sh: 'ELECTRON_RUN_AS_NODE=1 ', cmd: 'set "ELECTRON_RUN_AS_NODE=1" & ' });
  const { electron: _, ...plainNode } = process.versions as NodeJS.ProcessVersions & { electron?: string };
  assert.deepEqual(runAsNode(plainNode as NodeJS.ProcessVersions), { sh: '', cmd: '' });
});

test('the Mac app runs its office on the helper binary, which has no Dock icon, and falls back to Electron itself', () => {
  const main = '/Applications/Droid Office.app/Contents/MacOS/Droid Office';
  const helper = '/Applications/Droid Office.app/Contents/Frameworks/Droid Office Helper.app/Contents/MacOS/Droid Office Helper';
  assert.equal(
    officeRuntime(main, 'darwin', (p) => p === helper),
    helper,
  );
  assert.equal(
    officeRuntime(main, 'darwin', () => false),
    main,
  );
  assert.equal(
    officeRuntime(main, 'win32', () => true),
    main,
  );
  assert.equal(
    officeRuntime('/usr/local/bin/node', 'darwin', () => true),
    '/usr/local/bin/node',
  );
});
