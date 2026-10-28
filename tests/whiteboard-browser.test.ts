import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  apparmorProfile,
  BrowserError,
  browserCommand,
  browserStatus,
  browsersPath,
  classifyInstallError,
  classifyLaunchError,
  closeBrowser,
  ensureBrowser,
  type InstallProgress,
  installDepsCommand,
  launchBrowser,
  newIsolatedContext,
  parseProgress,
  pinnedBrowser,
  revisionDir,
  warmBrowser,
} from '../src/server/whiteboard-browser.js';

/** Points the browsers folder at a fresh temporary one for the test. */
function emptyFolder(t: TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-browsers-'));
  const before = process.env.DROID_OFFICE_BROWSERS_PATH;
  process.env.DROID_OFFICE_BROWSERS_PATH = dir;
  t.after(() => {
    if (before === undefined) delete process.env.DROID_OFFICE_BROWSERS_PATH;
    else process.env.DROID_OFFICE_BROWSERS_PATH = before;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** What playwright-core leaves behind when a download finished. */
function fakeInstall(folder: string) {
  const dir = revisionDir(folder, pinnedBrowser().revision);
  mkdirSync(path.join(dir, 'chrome-headless-shell-test'), { recursive: true });
  writeFileSync(path.join(dir, 'INSTALLATION_COMPLETE'), '');
}

test('the browsers folder is one per-user cache folder per platform', () => {
  assert.equal(browsersPath({ platform: 'darwin', env: {}, home: '/Users/ann' }), '/Users/ann/Library/Caches/droid-office/browsers');
  assert.equal(browsersPath({ platform: 'linux', env: {}, home: '/home/ann' }), '/home/ann/.cache/droid-office/browsers');
  assert.equal(browsersPath({ platform: 'linux', env: { XDG_CACHE_HOME: '/var/cache/ann' }, home: '/home/ann' }), '/var/cache/ann/droid-office/browsers');
  assert.equal(browsersPath({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\ann\\AppData\\Local' }, home: 'C:\\Users\\ann' }), 'C:\\Users\\ann\\AppData\\Local\\droid-office\\browsers');
  assert.equal(browsersPath({ platform: 'win32', env: {}, home: 'C:\\Users\\ann' }), 'C:\\Users\\ann\\AppData\\Local\\droid-office\\browsers');
});

test('a relative XDG_CACHE_HOME is ignored and DROID_OFFICE_BROWSERS_PATH wins everywhere', () => {
  assert.equal(browsersPath({ platform: 'linux', env: { XDG_CACHE_HOME: 'cache' }, home: '/home/ann' }), '/home/ann/.cache/droid-office/browsers');
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    assert.equal(browsersPath({ platform, env: { DROID_OFFICE_BROWSERS_PATH: '/srv/browsers', XDG_CACHE_HOME: '/x', LOCALAPPDATA: 'C:\\x' }, home: '/home/ann' }), path.resolve('/srv/browsers'));
  }
  assert.equal(browsersPath({ platform: 'linux', env: { DROID_OFFICE_BROWSERS_PATH: '~/pw' }, home: '/home/ann' }), path.resolve('/home/ann/pw'));
  assert.equal(browsersPath({ platform: 'linux', env: { DROID_OFFICE_BROWSERS_PATH: '  ' }, home: '/home/ann' }), '/home/ann/.cache/droid-office/browsers');
});

test('the pinned browser is the headless shell revision playwright-core expects', () => {
  const pinned = pinnedBrowser();
  assert.match(pinned.revision, /^\d+$/);
  assert.match(pinned.version, /^\d+\.\d+\.\d+\.\d+$/);
  assert.equal(revisionDir('/b', pinned.revision), path.join('/b', `chromium_headless_shell-${pinned.revision}`));
});

test('status says not installed for an empty folder, installed once playwright-core finished a download', (t) => {
  const folder = emptyFolder(t);
  const empty = browserStatus();
  assert.equal(empty.installed, false);
  assert.equal(empty.path, folder);
  assert.equal(empty.executable, null);
  assert.equal(empty.revision, pinnedBrowser().revision);
  // A download that was cut off has the folder but not the marker written last.
  mkdirSync(revisionDir(folder, empty.revision), { recursive: true });
  assert.equal(browserStatus().installed, false);
  fakeInstall(folder);
  assert.equal(browserStatus().installed, true);
});

test('a browser that is not downloaded is explained with how to download it', () => {
  const failure = classifyLaunchError(
    [
      "browserType.launch: Executable doesn't exist at /home/ann/.cache/droid-office/browsers/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell",
      '╔═════════════════════════════════════════════════════════════════════════╗',
      '║ Looks like Playwright was just installed or updated.                    ║',
      '║ Please run the following command to download new browsers:              ║',
      '║     npx playwright install                                              ║',
      '╚═════════════════════════════════════════════════════════════════════════╝',
    ].join('\n'),
  );
  assert.equal(failure.kind, 'not-installed');
  assert.match(failure.fix, /droid-office browser install/);
});

test('missing Linux libraries name the install-deps command to run with admin rights', () => {
  const messages = [
    'browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n/home/ann/.cache/droid-office/browsers/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory',
    'browserType.launch: Host system is missing dependencies to run browsers.\nPlease install them with the following command:\n\n    sudo npx playwright install-deps',
  ];
  for (const message of messages) {
    const failure = classifyLaunchError(message, { platform: 'linux', depsCommand: 'sudo node cli.js install-deps chromium' });
    assert.equal(failure.kind, 'missing-libraries');
    assert.match(failure.fix, /sudo node cli\.js install-deps chromium/);
    assert.equal(failure.detail, message.trim());
  }
  assert.match(installDepsCommand('/usr/bin/node', '/opt/o/node_modules/playwright-core/cli.js'), /^sudo "\/usr\/bin\/node" "\/opt\/o\/node_modules\/playwright-core\/cli\.js" install-deps chromium$/);
});

test('a sandbox blocked by Ubuntu 23.10+ is explained with the AppArmor fix, never --no-sandbox', () => {
  const message =
    'browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n[1010/101010.101:FATAL:zygote_host_impl_linux.cc(132)] No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces with AppArmor, see https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md. Otherwise see https://chromium.googlesource.com/chromium/src/+/main/docs/linux/suid_sandbox_development.md for more information on developing with the (older) SUID sandbox. If you want to live dangerously and need an immediate workaround, you can try using --no-sandbox.';
  const failure = classifyLaunchError(message, { platform: 'linux' });
  assert.equal(failure.kind, 'sandbox-blocked');
  assert.match(failure.fix, /apparmor-profile \| sudo tee \/etc\/apparmor\.d\/droid-office-chromium/);
  assert.match(failure.fix, /apparmor_parser -r/);
  assert.doesNotMatch(`${failure.summary}\n${failure.fix}`, /use --no-sandbox|try using --no-sandbox/);
  assert.equal(classifyLaunchError('Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted', { platform: 'linux' }).kind, 'sandbox-blocked');
  assert.equal(classifyLaunchError('Running as root without --no-sandbox is not supported. See https://crbug.com/638180.', { platform: 'linux' }).kind, 'sandbox-root');
});

test('any other failure is shown verbatim', () => {
  const message = 'browserType.launch: spawn EACCES';
  const failure = classifyLaunchError(message);
  assert.equal(failure.kind, 'other');
  assert.equal(failure.fix, '');
  assert.equal(new BrowserError(failure).message, message);
});

test('a failed download is explained with a way to retry', () => {
  const failure = classifyInstallError('Error: getaddrinfo ENOTFOUND cdn.playwright.dev\n    at GetAddrInfoReqWrap.onlookup');
  assert.equal(failure.kind, 'download-failed');
  assert.match(failure.summary, /wasn't reachable/);
  assert.match(failure.fix, /droid-office browser install/);
  assert.match(failure.detail, /ENOTFOUND/);
  assert.equal(classifyInstallError('').kind, 'download-failed');
});

test('download progress is read from the command output', () => {
  assert.deepEqual(parseProgress('|■■■■■■■■■■■■■■                    |  40% of 99 MiB'), { phase: 'downloading', percent: 40, message: 'Downloading Chromium: 40% of 99 MiB' });
  assert.equal(parseProgress('|■■  | 40% of 1.4 MiB', 'FFmpeg')?.message, 'Downloading FFmpeg: 40% of 1.4 MiB');
  assert.equal(parseProgress('Downloading Chrome Headless Shell 156.0.8078.4 (playwright chromium-headless-shell v1248) from https://cdn.playwright.dev/x.zip')?.message, 'Downloading Chromium');
  assert.equal(parseProgress('Downloading FFmpeg (playwright ffmpeg v1013)\u001b[2m from https://x\u001b[22m')?.message, 'Downloading FFmpeg');
  assert.equal(parseProgress('Chrome Headless Shell 156 downloaded to /x'), null);
});

test('one download runs at a time and every caller sees its progress', async (t) => {
  const folder = emptyFolder(t);
  let runs = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const install = async (to: string, emit: (p: InstallProgress) => void) => {
    runs++;
    assert.equal(to, folder);
    emit({ phase: 'downloading', percent: 50, message: 'halfway' });
    await gate;
    fakeInstall(to);
  };
  const first: InstallProgress[] = [];
  const second: InstallProgress[] = [];
  const a = ensureBrowser({ install, onProgress: (p) => first.push(p) });
  assert.equal(browserStatus().installing, true);
  const b = ensureBrowser({ install, onProgress: (p) => second.push(p) });
  assert.equal(a, b, 'the second call joins the first');
  finish();
  const [x, y] = await Promise.all([a, b]);
  assert.equal(runs, 1);
  assert.equal(x.installed, true);
  assert.equal(y.installed, true);
  assert.equal(browserStatus().installing, false);
  assert.ok(first.some((p) => p.percent === 50));
  assert.ok(
    second.some((p) => p.percent === 50),
    'a late caller is caught up on the current progress',
  );
  assert.equal(first.at(-1)?.phase, 'done');
  // Installed: nothing runs again.
  await ensureBrowser({ install });
  assert.equal(runs, 1);
});

test('a failed download rejects with a BrowserError, is kept as the last error, and can be retried', async (t) => {
  const folder = emptyFolder(t);
  await assert.rejects(
    ensureBrowser({
      install: async () => {
        throw new Error('getaddrinfo ENOTFOUND cdn.playwright.dev');
      },
    }),
    (err: unknown) => err instanceof BrowserError && err.kind === 'download-failed',
  );
  const status = browserStatus();
  assert.equal(status.installed, false);
  assert.equal(status.installing, false);
  assert.equal(status.lastError?.kind, 'download-failed');
  await assert.rejects(ensureBrowser({ install: async () => {} }), (err: unknown) => err instanceof BrowserError && /incomplete/.test(err.detail), 'a download that leaves nothing behind is a failure');
  await ensureBrowser({ install: async (to) => fakeInstall(to) });
  assert.equal(browserStatus().installed, true);
  assert.equal(browserStatus().lastError, null, 'a success clears the last error');
  assert.equal(folder, browserStatus().path);
});

test('warmBrowser never throws, whatever the download does', async (t) => {
  emptyFolder(t);
  // The real download is only started when the browser is missing; here it is, so point it at a folder
  // that cannot be created and see that nothing escapes.
  process.env.DROID_OFFICE_BROWSERS_PATH = path.join(os.tmpdir(), 'office-browsers-missing', '\0nope');
  warmBrowser();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await ensureBrowser().catch(() => {});
  assert.equal(browserStatus().installing, false);
});

test('launching without the browser downloaded fails with how to download it, and the office carries on', async (t) => {
  emptyFolder(t);
  await assert.rejects(launchBrowser(), (err: unknown) => err instanceof BrowserError && err.kind === 'not-installed' && /droid-office browser install/.test(err.message));
  assert.equal(browserStatus().lastError?.kind, 'not-installed');
  // The failure isn't cached: the next launch asks again.
  await assert.rejects(launchBrowser(), BrowserError);
});

test('`droid-office browser` prints the folder, the status and the AppArmor profile', async (t) => {
  const folder = emptyFolder(t);
  let out = '';
  const write = (s: string) => {
    out += s;
  };
  assert.equal(await browserCommand(['path'], write), 0);
  assert.equal(out.trim(), folder);
  out = '';
  assert.equal(await browserCommand(['status', '--json'], write), 0);
  assert.equal(JSON.parse(out).installed, false);
  out = '';
  assert.equal(await browserCommand(['apparmor-profile'], write), 0);
  assert.match(out, /^abi <abi\/4\.0>,/m);
  assert.match(out, /userns,/);
  assert.equal(await browserCommand([], write), 2);
  assert.equal(await browserCommand(['--help'], write), 0);
});

test('the AppArmor profile covers any revision of the browser in the folder, and escapes the path', () => {
  const profile = apparmorProfile('/home/ann/.cache/droid-office/browsers');
  assert.match(profile, /profile droid-office-chromium-shell "\/home\/ann\/\.cache\/droid-office\/browsers\/chromium_headless_shell-\*\/\*\/chrome-headless-shell" flags=\(unconfined\) \{\n {2}userns,/);
  assert.match(profile, /profile droid-office-chromium "\/home\/ann\/\.cache\/droid-office\/browsers\/chromium-\*\/\*\/chrome" flags=\(unconfined\)/);
  const odd = apparmorProfile('/home/a"n/b*[x]/');
  assert.ok(odd.includes('"/home/a\\"n/b\\*\\[x\\]/chromium_headless_shell-*'), odd);
});

// The real thing. The browser is whatever this machine (or CI's step) downloaded into the shared folder.
const real = browserStatus();
const mustRun = Boolean(process.env.GITHUB_ACTIONS);
const skipReason = real.installed ? false : `Chromium isn't downloaded in ${real.path}; run "node bin/droid-office.js browser install" to run this test`;

test('a real launch runs headless Chromium with its sandbox on', { skip: skipReason, timeout: 90_000 }, async (t) => {
  await closeBrowser();
  t.after(closeBrowser);
  const browser = await launchBrowser();
  assert.equal(browser, await launchBrowser(), 'one browser process is reused');
  assert.match(browser.version(), /^\d+\./);
  const context = await newIsolatedContext(browser);
  const page = await context.newPage();
  assert.match(await page.evaluate(() => navigator.userAgent), /HeadlessChrome/);
  await context.close();

  if (process.platform !== 'win32') {
    // Inspect this browser, not unrelated clone checks using the same Chromium executable.
    const cdp = await browser.newBrowserCDPSession();
    try {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      const pid = processInfo.find((info) => info.type === 'browser')?.id;
      assert.ok(pid && Number.isInteger(pid) && pid > 0, 'the running browser reports its process');
      const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim();
      assert.ok(args.startsWith(browserStatus().executable as string), 'the process is the expected browser');
      assert.doesNotMatch(args, /(?:^|\s)--no-sandbox(?:\s|$)/);
    } finally {
      await cdp.detach();
    }
  }
});

test('a fresh context gets no permissions, no storage from another context, and no service workers', { skip: skipReason, timeout: 90_000 }, async (t) => {
  t.after(closeBrowser);
  const server = http.createServer((req, res) => {
    if (req.url === '/sw.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end('self.addEventListener("install", () => {});');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>t</title><p>hi</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const browser = await launchBrowser();

  const one = await newIsolatedContext(browser);
  const pageOne = await one.newPage();
  await pageOne.goto(url);
  await pageOne.evaluate(() => localStorage.setItem('secret', 'one'));
  const states = await pageOne.evaluate(async () => {
    const names = ['geolocation', 'camera', 'microphone', 'clipboard-read', 'notifications'] as const;
    const out: Record<string, string> = {};
    for (const name of names) {
      try {
        out[name] = (await navigator.permissions.query({ name: name as PermissionName })).state;
      } catch {
        out[name] = 'unsupported';
      }
    }
    return out;
  });
  for (const [name, state] of Object.entries(states)) assert.notEqual(state, 'granted', `${name} is ${state}`);

  const two = await newIsolatedContext(browser);
  const pageTwo = await two.newPage();
  await pageTwo.goto(url);
  assert.equal(await pageTwo.evaluate(() => localStorage.getItem('secret')), null, 'another context shares no storage');
  // Playwright lets register() resolve but never keeps the registration or runs the worker.
  const registrations = await pageTwo.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    return (await navigator.serviceWorker.getRegistrations()).length;
  });
  assert.equal(registrations, 0);
  assert.equal(two.serviceWorkers().length, 0);
  await one.close();
  await two.close();
});

test('CI has the browser the renderer tests need', { skip: !mustRun }, () => {
  assert.equal(real.installed, true, `the workflow's "Install Chromium" step should have put it in ${real.path}`);
});
