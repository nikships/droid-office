import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { glBackend, gpuReport } from '../src/desktop/gpu.ts';
import { linkAction } from '../src/desktop/links.ts';
import { logTail, probePort, startOffice } from '../src/desktop/office.ts';
import { officeRuntime } from '../src/desktop/runtime.ts';
import { DEFAULT_PORT, defaultOfficeDir, isolatedPortOk, loadSettings, officeArgs, saveSettings, startedInProject } from '../src/desktop/settings.ts';
import { desktopEnv, fencedEnv, knownDirs, loginShellEnv, mergeEnv, mergePath } from '../src/desktop/shell-path.ts';
import { briefError, type UpdatePhase, updateBusy, updateView } from '../src/desktop/update-view.ts';
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

test('the login shell environment is read from between the markers, whatever the rc files print', () => {
  const B = '__DROID_OFFICE_ENV_BEGIN__';
  const E = '__DROID_OFFICE_ENV_END__';
  assert.deepEqual(fencedEnv(`Last login: today\nwelcome!\n${B}PATH=/a:/b\0NOTE=two\nlines\0EQ=a=b\0${E}\n`), { PATH: '/a:/b', NOTE: 'two\nlines', EQ: 'a=b' });
  assert.deepEqual(fencedEnv(`${B}OLD=1\0${E} ${B}NEW=2\0${E}`), { NEW: '2' });
  // Not a variable a shell could have exported: dropped.
  assert.deepEqual(fencedEnv(`${B}=x\0no-equals\0BAD-NAME=1\0OK=\0${E}`), { OK: '' });
  assert.equal(fencedEnv('no markers'), undefined);
  assert.equal(fencedEnv(`${B}PATH=/a:/b`), undefined);
  assert.equal(fencedEnv(`${B}${E}`), undefined);
});

test('PATHs merge in order, each folder once', () => {
  assert.equal(mergePath('/a:/b', undefined, '/b:/c::/a', ''), '/a:/b:/c');
  assert.ok(knownDirs('/home/me').includes('/opt/homebrew/bin'));
  assert.ok(knownDirs('/home/me').includes('/home/me/.local/bin'));
});

test("the office gets the login shell's environment over the app's, with PATH merged and a UTF-8 locale", () => {
  const app = { PATH: '/usr/bin:/bin', HOME: '/home/me', XPC_SERVICE_NAME: 'app', EDITOR: 'nano' };
  const login = { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/home/me', JAVA_HOME: '/jdk', EDITOR: 'vim', PWD: '/tmp', OLDPWD: '/', SHLVL: '2', _: '/usr/bin/env' };
  const env = mergeEnv(app, login, '/home/me');
  assert.equal(env.JAVA_HOME, '/jdk');
  assert.equal(env.EDITOR, 'vim');
  assert.equal(env.XPC_SERVICE_NAME, 'app');
  for (const k of ['PWD', 'OLDPWD', 'SHLVL', '_']) assert.equal(env[k], undefined, k);
  assert.ok(env.PATH?.startsWith('/opt/homebrew/bin:/usr/bin:/bin:/home/me/.local/bin:'), env.PATH);
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(mergeEnv({ ...app, LC_ALL: 'de_DE.UTF-8' }, undefined, '/home/me').LANG, undefined);
  assert.equal(mergeEnv(app, { LANG: 'fr_FR.UTF-8' }, '/home/me').LANG, 'fr_FR.UTF-8');
  // No login shell to ask: the app's own, still with the usual folders.
  assert.ok(mergeEnv(app, undefined, '/home/me').PATH?.split(':').includes('/opt/homebrew/bin'));
});

test('a login shell answers with its environment, and a missing shell with nothing', async () => {
  const got = await loginShellEnv('/bin/sh');
  assert.ok(got?.PATH?.split(':').includes('/bin'), `got ${got?.PATH}`);
  assert.equal(await loginShellEnv('/no/such/shell'), undefined);
  const env = await desktopEnv({ SHELL: '/bin/sh', PATH: '/usr/bin:/bin', DROID_OFFICE_TEST_MARK: 'kept' });
  assert.equal(env.DROID_OFFICE_TEST_MARK, 'kept');
  assert.ok(env.PATH?.split(':').includes('/bin'));
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
  saveSettings(file, { officeDir: '/x/office', port: 4700, menuBarExplained: true });
  assert.deepEqual(loadSettings(file), { officeDir: '/x/office', port: 4700, menuBarExplained: true });
  writeFileSync(file, JSON.stringify({ officeDir: 3, port: 99999, menuBarExplained: 'yes' }));
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

test('the update window offers an update, then shows its download and the restart, in one flow', () => {
  const available = updateView({ kind: 'available', version: '0.2.5' }, '0.2.1');
  assert.equal(available.title, 'Droid Office 0.2.5 is available');
  assert.match(available.detail!, /You have 0\.2\.1/);
  assert.deepEqual(
    available.buttons.map((b) => [b.action, b.label, Boolean(b.primary)]),
    [
      ['later', 'Later', false],
      ['install', 'Install and Restart', true],
    ],
  );
  assert.equal(available.escape, 'later');
  assert.equal(available.progress, undefined);

  const starting = updateView({ kind: 'downloading', version: '0.2.5', transferred: 0, total: 0 }, '0.2.1');
  assert.equal(starting.progress, 0);
  assert.equal(starting.detail, 'Starting the download…');
  const halfway = updateView({ kind: 'downloading', version: '0.2.5', transferred: 49_200_000, total: 98_400_000 }, '0.2.1');
  assert.equal(halfway.progress, 0.5);
  assert.equal(halfway.detail, '49.2 MB of 98.4 MB (50%)');
  assert.deepEqual(halfway.buttons, [{ action: 'cancel', label: 'Cancel' }]);
  assert.equal(halfway.escape, 'cancel');
  assert.equal(updateView({ kind: 'downloading', version: '0.2.5', transferred: 120, total: 100 }, '0.2.1').progress, 1);

  for (const kind of ['preparing', 'restarting'] as const) {
    const view = updateView({ kind, version: '0.2.5' }, '0.2.1');
    assert.equal(view.progress, 'indeterminate', kind);
    assert.deepEqual(view.buttons, [], kind);
    assert.equal(view.escape, undefined, kind);
  }
});

test('a manual check says what it found in the same window', () => {
  const checking = updateView({ kind: 'checking' }, '0.2.1');
  assert.equal(checking.progress, 'indeterminate');
  assert.equal(checking.escape, 'close');
  assert.equal(updateView({ kind: 'latest' }, '0.2.1').detail, 'Droid Office 0.2.1 is the newest version.');
  assert.equal(updateView({ kind: 'unpackaged' }, '0.2.1').buttons[0]!.action, 'close');

  const checkFailed = updateView({ kind: 'error', during: 'check', message: 'offline' }, '0.2.1');
  assert.equal(checkFailed.title, "Couldn't check for updates");
  assert.equal(checkFailed.detail, 'offline');
  assert.deepEqual(
    checkFailed.buttons.map((b) => b.action),
    ['close', 'retry'],
  );
  assert.equal(updateView({ kind: 'error', during: 'download', version: '0.2.5', message: 'reset' }, '0.2.1').title, "Droid Office 0.2.5 didn't install");

  const busy: UpdatePhase[] = [{ kind: 'checking' }, { kind: 'downloading', version: '1', transferred: 0, total: 0 }, { kind: 'preparing', version: '1' }, { kind: 'restarting', version: '1' }];
  for (const phase of busy) assert.equal(updateBusy(phase), true, phase.kind);
  assert.equal(updateBusy({ kind: 'available', version: '1' }), false);
  assert.equal(updateBusy({ kind: 'latest' }), false);
});

test('update errors are cut to their first line for the window', () => {
  assert.equal(briefError('HttpError: 404\n"method: GET url: https://example.test"\nHeaders: {…}'), 'HttpError: 404');
  assert.equal(briefError('\n\n  net::ERR_INTERNET_DISCONNECTED  \n'), 'net::ERR_INTERNET_DISCONNECTED');
  assert.equal(briefError(''), 'Unknown error');
  const long = briefError('x'.repeat(500));
  assert.equal(long.length, 240);
  assert.ok(long.endsWith('…'));
});

// app.getGPUInfo('complete') and app.getGPUFeatureStatus() from Electron 44 on an M5 Pro, trimmed.
const GPU_INFO = {
  auxAttributes: {
    displayType: 'ANGLE_METAL',
    glImplementationParts: '(gl=egl-angle,angle=metal)',
    glRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Version 26.7.1 (Build 25G241))',
    glVersion: 'OpenGL ES 3.0 (ANGLE 2.1.28489 git hash: e71c7344f185)',
    inProcessGpu: false,
    maxMsaaSamples: '8',
    sandboxed: true,
    skiaBackendType: 'GraphiteDawnMetal',
  },
  gpuDevice: [
    {
      active: true,
      deviceId: 0,
      deviceString: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Version 26.7.1 (Build 25G241))',
      driverVendor: 'Apple',
      driverVersion: '26.7.1',
      gpuPreference: 0,
      vendorId: 4203,
      vendorString: 'Google Inc. (Apple)',
    },
  ],
  machineModelName: 'Mac',
};
const GPU_STATUS = { webgl: 'enabled', gpu_compositing: 'enabled', webgpu: 'enabled', skia_graphite: 'enabled_on' };

test('the GPU report says which GPU and which WebGL backend the app draws with', () => {
  assert.equal(
    gpuReport(GPU_INFO, GPU_STATUS, new Date('2026-10-13T12:00:00Z')),
    [
      'Droid Office GPU report, 2026-10-13T12:00:00.000Z',
      'GPU: ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Version 26.7.1 (Build 25G241))',
      'WebGL backend: ANGLE on Metal (gl=egl-angle,angle=metal), display ANGLE_METAL',
      'Compositor: Skia GraphiteDawnMetal',
      'GL: OpenGL ES 3.0 (ANGLE 2.1.28489 git hash: e71c7344f185)',
      'Driver: 26.7.1',
      'Max MSAA samples: 8',
      'GPU process: its own, sandboxed',
      'Machine: Mac',
      'Features:',
      '  gpu_compositing: enabled',
      '  skia_graphite: enabled_on',
      '  webgl: enabled',
      '  webgpu: enabled',
      '',
    ].join('\n'),
  );
});

test('the GPU report copes with what basic info and a missing GPU process leave out', () => {
  assert.equal(glBackend('(gl=none,angle=none)'), undefined);
  assert.equal(glBackend('(gl=egl-angle,angle=swiftshader)'), 'ANGLE on swiftshader');
  assert.equal(glBackend('(gl=desktop-gl)'), 'desktop-gl');
  assert.equal(glBackend(undefined), undefined);
  const report = gpuReport(null, {}, new Date(0));
  assert.match(report, /^GPU: unknown$/m);
  assert.match(report, /^WebGL backend: unknown$/m);
  assert.doesNotMatch(report, /Features:/);
});

test('a run with its own userData attaches only to a running office, never on the default port', () => {
  assert.equal(isolatedPortOk(4677, 'office'), true);
  assert.equal(isolatedPortOk(4677, 'free'), false);
  assert.equal(isolatedPortOk(4677, 'other'), false);
  assert.equal(isolatedPortOk(DEFAULT_PORT, 'office'), false);
});
