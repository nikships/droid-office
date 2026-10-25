import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fromScreen, startSignIn, TIMED_OUT, UNRECOGNIZED } from '../src/server/setup/droid-signin.js';

/**
 * A droid that shows what droid 0.249.0 shows signed out (trimmed): the Login menu, then after Enter
 * the device code, and it runs `open` with the code filled in. It writes every byte it reads to
 * keys.txt. FAKE_MODE=other shows a screen the office doesn't know.
 */
const FAKE = `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const dir = process.env.FAKE_DIR;
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004h\\x1b]0;\\u26ec Droid\\x07\\x1b[?25l\\r\\n');
process.stdout.write('\\x1b[1m                 v0.249.0\\x1b[22m\\r\\n\\r\\n');
if (process.env.FAKE_MODE === 'other') {
  process.stdout.write('Do you trust the files in this folder?\\r\\n> Yes\\r\\n  No\\r\\n');
} else {
  process.stdout.write('Please login with your Factory account to continue.\\r\\n\\r\\n');
  process.stdout.write('\\x1b[36m> Login\\x1b[39m\\r\\n  Sign into a Factory Private deployment\\r\\n  Exit\\r\\n');
}
process.stdin.on('data', (d) => {
  fs.appendFileSync(dir + '/keys.txt', d);
  if (d.toString() !== '\\r' || process.env.FAKE_MODE === 'other') return;
  process.stdout.write('\\x1b[2J\\x1b[HIf the link does not open automatically, please visit https://auth.factory.ai/device and enter code\\r\\nQSMK-CDLX to complete authentication.\\r\\n');
  spawnSync('open', ['https://auth.factory.ai/device?user_code=QSMK-CDLX']);
  process.stdout.write('\\r\\nWaiting for authentication to complete...\\r\\n');
  if (process.env.FAKE_MODE === 'exit') process.exit(0);
});
process.on('SIGTERM', () => {
  fs.writeFileSync(dir + '/killed', 'TERM');
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

function fakeDroid(t: test.TestContext, mode = 'login') {
  const dir = mkdtempSync(path.join(tmpdir(), 'setup-signin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'fake.cjs'), FAKE);
  const droid = path.join(dir, 'droid');
  writeFileSync(droid, `#!/bin/sh\nexec '${process.execPath}' '${path.join(dir, 'fake.cjs')}'\n`);
  chmodSync(droid, 0o755);
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: dir, FAKE_DIR: dir, FAKE_MODE: mode };
  return {
    dir,
    droid,
    env,
    keys: () => (existsSync(path.join(dir, 'keys.txt')) ? readFileSync(path.join(dir, 'keys.txt'), 'utf8') : ''),
    killed: () => existsSync(path.join(dir, 'killed')),
  };
}

async function until(pred: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
}

test('the screen text gives the code and the page with the code filled in', () => {
  const screen = 'If the link does not open automatically, please visit https://auth.factory.ai/device and enter code\nTGVC-WFFD to complete authentication.\n\nWaiting for authentication to complete...';
  assert.deepEqual(fromScreen(screen), { code: 'TGVC-WFFD', url: 'https://auth.factory.ai/device?user_code=TGVC-WFFD' });
  assert.equal(fromScreen('Waiting for authentication to complete...'), null);
});

test('sign-in presses Enter once on Login, shows the code, and stops Droid once doctor says signed in', async (t) => {
  const f = fakeDroid(t);
  let signedIn = false;
  let polls = 0;
  const codes: [string, string][] = [];
  const s = startSignIn({
    droid: f.droid,
    env: f.env,
    tmpRoot: f.dir,
    pollMs: 50,
    signedIn: async () => {
      polls++;
      return signedIn;
    },
    onCode: (code, url) => codes.push([code, url]),
  });
  await until(() => codes.length > 0);
  assert.deepEqual(codes, [['QSMK-CDLX', 'https://auth.factory.ai/device?user_code=QSMK-CDLX']]);
  await until(() => polls >= 2);
  signedIn = true;
  assert.deepEqual(await s.done, { ok: true });
  await until(f.killed);
  assert.equal(f.keys(), '\r');
  assert.deepEqual(
    readdirSync(f.dir).filter((n) => n.startsWith('droid-office-signin-')),
    [],
  );
});

test('the open shim records the page instead of opening it', async (t) => {
  const f = fakeDroid(t);
  const s = startSignIn({ droid: f.droid, env: f.env, tmpRoot: f.dir, pollMs: 60_000, signedIn: async () => false, onCode: () => {} });
  await until(() => readdirSync(f.dir).some((n) => n.startsWith('droid-office-signin-') && existsSync(path.join(f.dir, n, 'opened.txt'))));
  const run = readdirSync(f.dir).find((n) => n.startsWith('droid-office-signin-'));
  assert.equal(readFileSync(path.join(f.dir, run!, 'opened.txt'), 'utf8'), 'https://auth.factory.ai/device?user_code=QSMK-CDLX\n');
  s.cancel();
  assert.deepEqual(await s.done, { ok: false, cancelled: true, error: 'Cancelled' });
  await until(f.killed);
  assert.equal(existsSync(path.join(f.dir, run!)), false);
});

test('cancel stops Droid', async (t) => {
  const f = fakeDroid(t);
  let code = '';
  const s = startSignIn({ droid: f.droid, env: f.env, tmpRoot: f.dir, signedIn: async () => false, onCode: (c) => (code = c) });
  await until(() => !!code);
  s.cancel();
  const r = await s.done;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.cancelled, true);
  await until(f.killed);
});

test('a sign-in nobody finishes times out', async (t) => {
  const f = fakeDroid(t);
  const s = startSignIn({ droid: f.droid, env: f.env, tmpRoot: f.dir, pollMs: 50, timeoutMs: 1500, signedIn: async () => false, onCode: () => {} });
  assert.deepEqual(await s.done, { ok: false, cancelled: false, error: TIMED_OUT });
  await until(f.killed);
  assert.equal(f.keys(), '\r');
});

test('a screen it does not recognize stops it without pressing anything', async (t) => {
  const f = fakeDroid(t, 'other');
  const s = startSignIn({ droid: f.droid, env: f.env, tmpRoot: f.dir, recognizeMs: 1500, signedIn: async () => false, onCode: () => {} });
  const r = await s.done;
  assert.deepEqual(r, { ok: false, cancelled: false, error: UNRECOGNIZED });
  assert.match(UNRECOGNIZED, /Run `droid` in a terminal/);
  await until(f.killed);
  assert.equal(f.keys(), '');
});

test('Droid exiting by itself counts as signed in only when doctor says so', async (t) => {
  const f = fakeDroid(t, 'exit');
  const s = startSignIn({ droid: f.droid, env: f.env, tmpRoot: f.dir, pollMs: 60_000, signedIn: async () => false, onCode: () => {} });
  const r = await s.done;
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /stopped before it finished/);

  const g = fakeDroid(t, 'exit');
  const ok = startSignIn({ droid: g.droid, env: g.env, tmpRoot: g.dir, pollMs: 60_000, signedIn: async () => existsSync(path.join(g.dir, 'keys.txt')), onCode: () => {} });
  assert.deepEqual(await ok.done, { ok: true });
});
